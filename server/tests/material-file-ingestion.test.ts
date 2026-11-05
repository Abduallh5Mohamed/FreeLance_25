import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { collectMaterialPdf, createMaterialFileIngestionService, type MaterialFileIngestionConfig } from '../src/services/material-file-ingestion';
import { createMaterialFileDeliveryService } from '../src/services/material-file-delivery';
const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pdf = Buffer.from('%PDF-1.7\nsynthetic owner upload\n%%EOF');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const columns = ['id','material_id','tenant_id','course_id','object_key','object_version','sha256','size_bytes','mime_type','status',
  'scan_status','scanned_object_version','scanned_sha256','scan_engine','scan_policy_version','scanned_at','upload_request_id','uploaded_by','upload_status'];
function fixture(scanner = true, configured = true) {
  const scope = { actorId:'owner',tenantId:'tenant-a',courseId:id(2),materialId:id(3) };
  const s = { row:null as any, audits:[] as any[], events:[] as string[], commits:0, rollbacks:0, releases:0, destroys:0,
    auditAttempts:0, failAuditAt:0, failCommitAt:0, failRollback:false, failBegin:false, schema:true, authorized:true, verdict:'clean',
    putCalls:0, readCalls:0, scanCalls:0, badRead:false, badVerdict:false, uniqueConflict:false, snapshotRows:[] as any[] };
  const objects = new Map<string,{bytes:Buffer; sha256:string;version:string}>();
  const getConnection = async () => {
    let before:any, auditCount = 0;
    return {
      beginTransaction:async()=>{if(s.failBegin)throw Error('begin');before=s.row?{...s.row}:null;auditCount=s.audits.length;s.events.push('begin');},
      execute:async(sql:string,p:any[]=[]):Promise<[any,any]>=>{
        const n=sql.replace(/\s+/g,' ').trim();
        if(n.includes('information_schema'))return[s.schema?columns.map(column_name=>({column_name})):[],[]];
        if(n.startsWith('SELECT f.id'))return[s.row?[{...s.row}]:[],[]];
        if(n.startsWith('INSERT INTO course_material_files')){
          if(s.uniqueConflict)throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});
          s.row={id:p[0],material_id:p[1],tenant_id:p[2],course_id:p[3],object_key:p[4],object_version:p[5],sha256:p[6],size_bytes:p[7],mime_type:p[8],
            upload_request_id:p[9],uploaded_by:p[10],status:'active',scan_status:'pending',upload_status:'reserved'};s.events.push('reserve');return[{affectedRows:1},[]];
        }
        if(n.startsWith('UPDATE course_material_files SET object_version')){s.row={...s.row,object_version:p[0],upload_status:'stored'};s.events.push('stored');return[{affectedRows:1},[]];}
        if(n.startsWith('UPDATE course_material_files SET upload_status')){
          s.row={...s.row,upload_status:'complete',scan_status:p[0],scanned_object_version:p[1],scanned_sha256:p[2],scan_engine:p[3],scan_policy_version:p[4],scanned_at_epoch:1000,now_epoch:1001};s.events.push('scan-write');return[{affectedRows:1},[]];
        }
        if(n.startsWith("UPDATE course_material_files SET status='revoked'")){s.row={...s.row,status:'revoked'};s.events.push('revoke-write');return[{affectedRows:1},[]];}
        if(n.startsWith('INSERT INTO audit_events')){s.auditAttempts++;if(s.auditAttempts===s.failAuditAt)throw Error('audit failed');s.audits.push(p);return[{affectedRows:1},[]];}
        throw Error('Unexpected SQL '+n);
      },
      commit:async()=>{s.commits++;s.events.push('commit');if(s.commits===s.failCommitAt)throw Error('ack lost');},
      rollback:async()=>{s.rollbacks++;s.events.push('rollback');if(s.failRollback)throw Error('rollback');s.row=before;s.audits.length=auditCount;},
      release:()=>{s.releases++;},destroy:()=>{s.destroys++;},
    };
  };
  const config:MaterialFileIngestionConfig={timeoutMs:1000,store:{
    putOnce:async input=>{s.putCalls++;s.events.push('put');assert.ok(s.row&&s.commits>=1,'durable reservation precedes object write');assert.equal(s.row.object_key,input.objectKey);
      const existing=objects.get(input.objectKey);if(existing&&existing.sha256!==input.sha256)throw Error('immutable conflict');
      if(!existing)objects.set(input.objectKey,{bytes:Buffer.from(input.bytes),sha256:input.sha256,version:'raw-version '});return{objectVersion:'raw-version '};},
    read:async input=>{s.readCalls++;const object=objects.get(input.objectKey)!;assert.equal(input.objectVersion,object.version);
      return(async function*(){yield s.badRead?Buffer.from('%PDF-corrupt'):object.bytes;})();},
  },scanner:scanner?{engine:'fixture-scanner',policyVersion:'v1',scan:async input=>{s.scanCalls++;s.events.push('scan');assert.equal(digest(input.bytes),input.sha256);
    return{verdict:s.verdict as any,sha256:s.badVerdict?'0'.repeat(64):input.sha256,objectVersion:input.objectVersion};}}:undefined};
  const authorize=async()=>s.authorized?scope:{status:403,body:{error:'Forbidden'}};
  const service=createMaterialFileIngestionService({getConnection,config:configured?config:undefined});
  const input={authorize,requestId:id(9),readPayload:async()=>Buffer.from(pdf)};
  return{s,scope,objects,config,authorize,service,input,getConnection};
}
test('owner revocation is audited once and prevents upload resume without object deletion',async()=>{
  const h=fixture();assert.equal((await h.service.upload(h.input)).status,201);
  const original=h.s.row.id, puts=h.s.putCalls, scans=h.s.scanCalls, audits=h.s.audits.length;
  const first=await h.service.revoke(h.authorize);assert.equal(first.status,200);assert.equal(first.body.file.source_status,'revoked');assert.equal(first.body.unchanged,false);
  assert.equal(h.s.row.id,original);assert.equal(h.objects.size,1);assert.equal(h.s.audits.length,audits+1);
  assert.match(h.s.audits.at(-1)[3],/revoke/);assert.equal(JSON.parse(h.s.audits.at(-1)[6]).source_status,'active');assert.equal(JSON.parse(h.s.audits.at(-1)[7]).source_status,'revoked');
  const again=await h.service.revoke(h.authorize);assert.equal(again.body.unchanged,true);assert.equal(h.s.audits.length,audits+1);
  assert.equal((await h.service.upload(h.input)).status,409);assert.equal(h.s.putCalls,puts);assert.equal(h.s.scanCalls,scans);
});
test('revoke requires source, current authority and schema; audit failure rolls back',async()=>{
  const h=fixture(false,false);assert.equal((await h.service.revoke(h.authorize)).status,404);
  const ready=fixture();await ready.service.upload(ready.input);
  const withoutAdapters=createMaterialFileIngestionService({getConnection:ready.getConnection});
  assert.equal((await withoutAdapters.status(ready.authorize)).body.capabilities.upload,false);
  ready.s.authorized=false;assert.equal((await ready.service.revoke(ready.authorize)).status,403);assert.equal(ready.s.row.status,'active');
  ready.s.authorized=true;ready.s.schema=false;assert.equal((await ready.service.revoke(ready.authorize)).status,503);assert.equal(ready.s.row.status,'active');
  ready.s.schema=true;ready.s.failAuditAt=ready.s.auditAttempts+1;assert.equal((await ready.service.revoke(ready.authorize)).status,503);assert.equal(ready.s.row.status,'active');
  ready.s.failAuditAt=0;assert.equal((await withoutAdapters.revoke(ready.authorize)).status,200);
});
test('unknown revocation commit is reported as uncertain and destroys its connection',async()=>{
  const h=fixture();await h.service.upload(h.input);h.s.failCommitAt=h.s.commits+1;
  const result=await h.service.revoke(h.authorize);
  assert.equal(result.status,503);assert.equal(result.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.s.destroys,1);
});
test('reserved → stored → clean is server-generated, version-bound and atomically audited',async()=>{
  const h=fixture(),r=await h.service.upload(h.input);assert.equal(r.status,201);assert.equal(r.body.file.scan_status,'clean');assert.equal(r.body.file.upload_status,'complete');
  assert.deepEqual(Object.keys(r.body.file).sort(),['file_id','material_id','size_bytes','upload_status','scan_status','source_status'].sort());
  assert.equal(h.s.commits,3);assert.equal(h.s.audits.length,3);assert.equal(h.objects.size,1);assert.equal(h.s.scanCalls,1);
  assert.equal(h.s.row.object_version.toString(),'raw-version ');assert.equal(h.s.row.scanned_object_version.toString(),'raw-version ');
  assert.ok(!JSON.stringify(r.body).includes('catalog-materials'));assert.ok(!JSON.stringify(r.body).includes(digest(pdf)));
  assert.ok(h.s.audits.every(row=>!JSON.stringify(row).includes('catalog-materials')&&!JSON.stringify(row).includes('%PDF-')&&!JSON.stringify(row).includes(digest(pdf))));
});
test('same key and payload is a truthful no-op; another key or changed bytes never overwrite source',async()=>{
  const h=fixture();await h.service.upload(h.input);const puts=h.s.putCalls,audits=h.s.audits.length;
  const repeat=await h.service.upload(h.input);assert.equal(repeat.status,200);assert.equal(repeat.body.unchanged,true);assert.equal(h.s.putCalls,puts);assert.equal(h.s.audits.length,audits);
  assert.equal((await h.service.upload({...h.input,requestId:id(10)})).status,409);
  assert.equal((await h.service.upload({...h.input,readPayload:async()=>Buffer.from('%PDF-changed')})).status,409);assert.equal(h.objects.size,1);assert.equal(h.s.putCalls,puts);
});
test('absent scanner stays pending; same request resumes after trusted scanner is configured',async()=>{
  const h=fixture(false);const first=await h.service.upload(h.input);assert.equal(first.status,202);assert.equal(h.s.row.scan_status,'pending');assert.equal(h.s.row.upload_status,'stored');
  h.config.scanner={engine:'fixture-scanner',policyVersion:'v1',scan:async input=>({verdict:'clean',sha256:input.sha256,objectVersion:input.objectVersion})};
  assert.equal((await h.service.upload(h.input)).status,200);assert.equal(h.s.row.scan_status,'clean');assert.equal(h.s.putCalls,1);
});
for(const kind of ['failed','bad-proof','exception','infected'])test(`scanner ${kind} cannot invent clean`,async()=>{
  const h=fixture();h.s.verdict=kind==='infected'?'infected':kind==='failed'?'failed':'clean';h.s.badVerdict=kind==='bad-proof';
  if(kind==='exception')h.config.scanner!.scan=async()=>{throw Error('scanner private payload');};
  const r=await h.service.upload(h.input);assert.equal(r.status,kind==='infected'?422:202);assert.notEqual(h.s.row.scan_status,'clean');
  if(kind==='infected'){assert.equal(h.s.row.scan_status,'rejected');const calls=h.s.scanCalls;assert.equal((await h.service.upload(h.input)).status,422);assert.equal(h.s.scanCalls,calls);}
});
for(const gate of ['schema','authority','unconfigured'])test(`${gate} refusal occurs before reading body or external I/O`,async()=>{
  const h=fixture(true,gate!=='unconfigured');if(gate==='schema')h.s.schema=false;if(gate==='authority')h.s.authorized=false;let bodies=0;
  const r=await h.service.upload({...h.input,readPayload:async()=>{bodies++;return pdf;}});assert.equal(r.status,gate==='authority'?403:503);assert.equal(bodies,0);assert.equal(h.s.putCalls,0);assert.equal(h.s.row,null);
});
test('status is explicit, private and no mutation; unconfigured source is not fabricated as ready',async()=>{
  const h=fixture(true,false),r=await h.service.status(h.authorize);assert.deepEqual(r.body,{file:null,capabilities:{upload:false,scan:false},retry_request_id:null});assert.equal(h.s.commits,0);assert.equal(h.s.row,null);
});
for(const stage of [1,2,3])test(`audit failure at stage ${stage} rolls back that transition and keeps a recovery root`,async()=>{
  const h=fixture();h.s.failAuditAt=stage;const r=await h.service.upload(h.input);assert.equal(r.status,503);
  assert.equal(h.s.audits.length,stage-1);
  if(stage===1){assert.equal(h.s.row,null);assert.equal(h.s.putCalls,0);}else{assert.ok(h.s.row);assert.equal(h.objects.size,1);assert.notEqual(h.s.row.scan_status,'clean');}
  h.s.failAuditAt=0;assert.ok([200,201].includes((await h.service.upload(h.input)).status));assert.equal(h.objects.size,1);
});
for(const stage of [1,2,3])test(`lost commit acknowledgement at stage ${stage} stops later external work; retry reconciles`,async()=>{
  const h=fixture();h.s.failCommitAt=stage;const r=await h.service.upload(h.input);assert.equal(r.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.s.destroys,1);
  assert.equal(h.s.putCalls,stage===1?0:1);assert.equal(h.s.scanCalls,stage===3?1:0);
  h.s.failCommitAt=0;assert.equal((await h.service.upload(h.input)).status,200);assert.equal(h.objects.size,1);
});
test('bad stored bytes never become stored/clean; durable reservation retains exact recovery key',async()=>{
  const h=fixture();h.s.badRead=true;const r=await h.service.upload(h.input);assert.equal(r.status,503);assert.equal(h.s.row.upload_status,'reserved');assert.equal(h.s.scanCalls,0);assert.equal(h.objects.size,1);
  h.s.badRead=false;assert.equal((await h.service.upload(h.input)).status,200);assert.equal(h.objects.size,1);
});
test('ownership loss during object write or scan cannot publish a clean source',async()=>{
  for(const phase of ['put','scan']){const h=fixture();const put=h.config.store.putOnce;
    if(phase==='put')h.config.store.putOnce=async input=>{const result=await put(input);h.s.authorized=false;return result;};
    else h.config.scanner!.scan=async input=>{h.s.authorized=false;return{verdict:'clean',sha256:input.sha256,objectVersion:input.objectVersion};};
    assert.equal((await h.service.upload(h.input)).status,403);assert.notEqual(h.s.row.scan_status,'clean');assert.equal(h.objects.size,1);
  }
});
test('provider timeout leaves durable reserved row; no clean claim and cancellation is forwarded',async()=>{
  const h=fixture();h.config.timeoutMs=10;let signal:AbortSignal|undefined;
  h.config.store.putOnce=async input=>{signal=input.signal;return new Promise(()=>{});};
  assert.equal((await h.service.upload(h.input)).status,503);assert.equal(signal?.aborted,true);assert.equal(h.s.row.upload_status,'reserved');assert.equal(h.s.scanCalls,0);
});
test('two service admissions bound body buffering; a third request is rejected before its body',async()=>{
  const h=fixture();let release!:(value:Buffer)=>void;const body=new Promise<Buffer>(resolve=>{release=resolve;});let reads=0;
  const first=h.service.upload({...h.input,readPayload:async()=>{reads++;return body;}}),second=h.service.upload({...h.input,readPayload:async()=>{reads++;return body;}});
  const third=await h.service.upload({...h.input,readPayload:async()=>{reads++;return pdf;}});assert.equal(third.body.code,'MATERIAL_FILE_UPLOAD_BUSY');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,2);release(pdf);await Promise.all([first,second]);
});
test('invalid PDF/body/key is refused before reservation or provider call',async()=>{
  const h=fixture();assert.equal((await h.service.upload({...h.input,requestId:'bad'})).status,400);
  assert.equal((await h.service.upload({...h.input,readPayload:async()=>Buffer.from('not pdf')})).status,415);
  assert.equal((await h.service.upload({...h.input,readPayload:async()=>Buffer.concat([pdf,Buffer.alloc(10*1024*1024)])})).status,413);assert.equal(h.s.row,null);assert.equal(h.s.putCalls,0);
});
test('bounded collector copies reused chunks, refuses overflow and honors cancellation',async()=>{
  const controller=new AbortController();const actual=await collectMaterialPdf((async function*(){const buffer=Buffer.from(pdf);yield buffer;buffer.fill(0);})(),controller.signal);assert.deepEqual(actual,pdf);
  await assert.rejects(()=>collectMaterialPdf((async function*(){yield Buffer.concat([pdf,Buffer.alloc(10*1024*1024)]);})(),controller.signal));
  controller.abort();await assert.rejects(()=>collectMaterialPdf((async function*(){yield pdf;})(),controller.signal));
});
test('the actual ingestion source/scan record is accepted by the existing verified delivery service',async()=>{
  const h=fixture();assert.equal((await h.service.upload(h.input)).status,201);
  const delivery=createMaterialFileDeliveryService({getConnection:h.getConnection,config:{reader:h.config.store,trustedScanner:{engine:'fixture-scanner',policyVersion:'v1'}}});
  const result=await delivery({tenantId:h.scope.tenantId,courseId:h.scope.courseId,lessonId:id(6),contentId:id(7),
    authorize:async()=>({status:200,body:{contents:[{content_id:id(7),material_type:'pdf'}]},commit:false})});
  assert.equal(result.ok,true);if(result.ok){assert.deepEqual(result.bytes,pdf);result.release();}
  const reads=h.s.readCalls;assert.equal((await h.service.revoke(h.authorize)).status,200);
  const after=await delivery({tenantId:h.scope.tenantId,courseId:h.scope.courseId,lessonId:id(6),contentId:id(7),
    authorize:async()=>({status:200,body:{contents:[{content_id:id(7),material_type:'pdf'}]},commit:false})});
  assert.equal(after.ok,false);assert.equal(h.s.readCalls,reads);
});
test('a concurrent infected result is terminal and a later clean result cannot revive it',async()=>{
  const h=fixture();let resolveClean!:(x:any)=>void;let started!:(value?:unknown)=>void;
  const waiting=new Promise(resolve=>{started=resolve;}),clean=new Promise<any>(resolve=>{resolveClean=resolve;});let scans=0;
  h.config.scanner!.scan=async input=>{scans++;if(scans===1){started();return clean;}return{verdict:'infected',sha256:input.sha256,objectVersion:input.objectVersion};};
  const first=h.service.upload(h.input);await waiting;
  const second=await h.service.upload(h.input);assert.equal(second.status,422);
  resolveClean({verdict:'clean',sha256:digest(pdf),objectVersion:'raw-version '});assert.equal((await first).status,422);assert.equal(h.s.row.scan_status,'rejected');
});
test('revocation during a scanner request blocks its later clean promotion',async()=>{
  const h=fixture();let started!:(value?:unknown)=>void, finish!:(value:any)=>void;
  const scanning=new Promise(resolve=>{started=resolve;}), verdict=new Promise<any>(resolve=>{finish=resolve;});
  h.config.scanner!.scan=async()=>{started();return verdict;};
  const uploading=h.service.upload(h.input);await scanning;
  assert.equal((await h.service.revoke(h.authorize)).status,200);
  finish({verdict:'clean',sha256:digest(pdf),objectVersion:'raw-version '});
  assert.equal((await uploading).status,409);assert.equal(h.s.row.status,'revoked');assert.equal(h.s.row.scan_status,'pending');
});
