import assert from 'node:assert/strict';
import test from 'node:test';
import { Writable, Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createMinioMaterialFileStore } from '../src/services/material-minio-store';
import { createClamAvMaterialScanner } from '../src/services/material-clamav-scanner';
import { createMaterialPdfRuntime } from '../src/services/material-pdf-runtime';
const pdf=Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF'),sha=createHash('sha256').update(pdf).digest('hex');
const key='catalog-materials/tenant-a/a1000000-0000-4000-8000-000000000001/a1000000-0000-4000-8000-000000000002/a1000000-0000-4000-8000-000000000003.pdf';
function storage(){
 const s={calls:[] as any[],bytes:null as Buffer|null,public:false,noPolicy404:false,versioning:true,version:'version-1 ',badVersion:false,fail:0,hold:false};
 const wire:any={request:(options:any,callback:any)=>{
  const chunks:Buffer[]=[];s.calls.push(options);
  const request:any=new Writable({autoDestroy:false,write(chunk,_enc,done){chunks.push(Buffer.from(chunk));done();},final(done){done();queueMicrotask(()=>{
   if(options.signal.aborted){request.destroy(Error('aborted'));return;}
   if(s.hold)return;
   const response:any=Readable.from((async function*(){yield typeof body==='string'?Buffer.from(body):body;})());
   let body:Buffer|string='';response.statusCode=200;response.headers={};
   if(s.fail){response.statusCode=s.fail;body='<Error><Code>InternalError</Code></Error>';}
   else if(options.path.includes('policy')){body=s.public?JSON.stringify({Statement:[{Effect:'Allow',Principal:'*'}]}):'';if(s.noPolicy404){response.statusCode=404;body='<Error><Code>NoSuchBucketPolicy</Code><Message>none</Message></Error>';}}
   else if(options.path.includes('versioning'))body=`<VersioningConfiguration><Status>${s.versioning?'Enabled':'Suspended'}</Status></VersioningConfiguration>`;
   else if(options.method==='PUT'){
    const h=Object.fromEntries(Object.entries(options.headers).map(([k,v])=>[k.toLowerCase(),v]));assert.equal(h['if-none-match'],'*');
    if(s.bytes){response.statusCode=412;body='<Error><Code>PreconditionFailed</Code><Message>exists</Message><Resource>/private</Resource><RequestId>fixture</RequestId></Error>';}
    else{s.bytes=Buffer.concat(chunks);response.headers={'x-amz-version-id':s.version,etag:'"etag"'};}
   }else if(options.method==='HEAD'){
    response.headers={'x-amz-version-id':s.version,etag:'"etag"','content-length':String(s.bytes?.length),'content-type':'application/pdf','x-amz-meta-sha256':sha,'last-modified':'Thu, 05 Nov 2026 00:00:00 GMT'};
   }else{assert.ok(options.path.includes('versionId='));body=s.bytes!;response.headers={'x-amz-version-id':s.badVersion?'wrong':s.version};}
   callback(response);
  });}});
  request.setTimeout=()=>request;options.signal.addEventListener('abort',()=>request.destroy(Error('aborted')),{once:true});return request;
 }};
 const store=createMinioMaterialFileStore({endPoint:'fixture.invalid',port:9000,useSSL:false,accessKey:'synthetic-access',secretKey:'synthetic-secret-not-real',region:'us-east-1',bucket:'private-materials'},wire);
 return{s,store};
}
test('real MinIO SDK wire uses conditional PUT, exact version read and private/versioning probes',async()=>{
 const h=storage();assert.equal(h.s.calls.length,0);const controller=new AbortController();
 const first=await h.store.putOnce({objectKey:key,bytes:pdf,sha256:sha,signal:controller.signal});assert.equal(first.objectVersion,'minio-version:version-1 ');
 const retry=await h.store.putOnce({objectKey:key,bytes:pdf,sha256:sha,signal:controller.signal});assert.equal(retry.objectVersion,first.objectVersion);
 const read=await h.store.read({objectKey:key,objectVersion:first.objectVersion,signal:controller.signal});const chunks:Buffer[]=[];for await(const c of read)chunks.push(Buffer.from(c));assert.deepEqual(Buffer.concat(chunks),pdf);
 assert.ok(h.s.calls.every(c=>c.signal===controller.signal));assert.equal(h.s.calls.filter(c=>c.method==='PUT').length,2);
});
for(const reason of ['public','versioning','wrong-version','invalid-key','transient'])test(`MinIO ${reason} fails closed without unsafe retry`,async()=>{
 const h=storage(),signal=new AbortController().signal;
 if(reason==='public')h.s.public=true;if(reason==='versioning')h.s.versioning=false;if(reason==='transient')h.s.fail=503;
 if(reason==='wrong-version'){await h.store.putOnce({objectKey:key,bytes:pdf,sha256:sha,signal});h.s.badVersion=true;await assert.rejects(()=>h.store.read({objectKey:key,objectVersion:'minio-version:version-1 ',signal}));return;}
 await assert.rejects(()=>h.store.putOnce({objectKey:reason==='invalid-key'?'../../foreign':key,bytes:pdf,sha256:sha,signal}));
 if(reason==='transient')assert.equal(h.s.calls.length,1);
 assert.ok(h.s.calls.every(c=>c.method!=='PUT'));
});
test('MinIO cancellation reaches the actual SDK request transport',async()=>{
 const h=storage(),controller=new AbortController();h.s.hold=true;
 const pending=h.store.putOnce({objectKey:key,bytes:pdf,sha256:sha,signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(()=>pending);assert.equal(h.s.bytes,null);
});
function scanner(){
 const s={mode:'clean',calls:[] as any[],kills:0,children:[] as any[]};
 const start:any=(file:string,args:string[],options:any)=>{
  s.calls.push({file,args,options});const child:any=new EventEmitter();child.pid=123;child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{s.kills++;queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;};
  const chunks:Buffer[]=[];child.stdin=new Writable({write(c,_e,cb){chunks.push(Buffer.from(c));cb();},final(cb){cb();setImmediate(()=>{
   if(s.mode==='hold')return;
   assert.deepEqual(Buffer.concat(chunks),pdf);
   if(s.mode==='flood')child.stdout.write(Buffer.alloc(32769,65));
   else child.stdout.write(s.mode==='empty'?'':s.mode==='infected'?'stdin: Fixture FOUND\n':'stdin: OK\n');
   if(s.mode==='stderr')child.stderr.write('private scanner warning');
   child.emit('close',s.mode==='infected'?1:s.mode==='error'?2:0,null);
  });}});s.children.push(child);return child;
 };
 const adapter=createClamAvMaterialScanner({executable:path.resolve('tmp/scanner/clamscan.exe'),databaseDirectory:path.resolve('tmp/scanner/db'),tempDirectory:path.resolve('tmp/scanner/private-temp'),policyVersion:'v1',maxDatabaseAgeDays:2,timeoutMs:50},start);
 return{s,adapter};
}
test('scanner runs exact bounded stdin without shell/visible window or inherited secrets',async()=>{
 const h=scanner();assert.equal(h.s.calls.length,0);const r=await h.adapter.scan({bytes:pdf,sha256:sha,objectVersion:'raw ',signal:new AbortController().signal});assert.equal(r.verdict,'clean');assert.equal(r.objectVersion,'raw ');
 const call=h.s.calls[0];assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.ok(call.args.includes('--alert-exceeds-max=yes'));assert.ok(call.args.includes('--alert-encrypted=yes'));assert.ok(call.args.includes('--fail-if-cvd-older-than=2'));assert.equal(call.args.at(-1),'-');assert.equal(call.options.env.MINIO_SECRET_KEY,undefined);
});
for(const mode of ['infected','empty','stderr','error','flood'])test(`scanner ${mode} never reports clean`,async()=>{
 const h=scanner();h.s.mode=mode;const r=await h.adapter.scan({bytes:pdf,sha256:sha,objectVersion:'raw',signal:new AbortController().signal});assert.equal(r.verdict,mode==='infected'?'infected':'failed');
});
test('scanner timeout and caller cancellation kill only the owned child',async()=>{
 for(const cancel of [false,true]){const h=scanner();h.s.mode='hold';const controller=new AbortController();const p=h.adapter.scan({bytes:pdf,sha256:sha,objectVersion:'raw',signal:controller.signal});if(cancel)controller.abort();assert.equal((await p).verdict,'failed');assert.equal(h.s.kills,1);}
});
test('real SDK NoSuchBucketPolicy is accepted only with enabled versioning',async()=>{
 const h=storage();h.s.noPolicy404=true;const r=await h.store.putOnce({objectKey:key,bytes:pdf,sha256:sha,signal:new AbortController().signal});assert.equal(r.objectVersion,'minio-version:version-1 ');
});
test('runtime assembly keeps upload/read scanner policy identical and never activates providers',()=>{
 const store=storage().store,scannerAdapter=scanner().adapter;
 const pending=createMaterialPdfRuntime({store});assert.equal(pending.delivery,undefined);assert.equal(pending.ingestion.store,store);
 const active=createMaterialPdfRuntime({store,scanner:scannerAdapter});assert.equal(active.delivery?.reader,store);assert.deepEqual(active.delivery?.trustedScanner,{engine:scannerAdapter.engine,policyVersion:scannerAdapter.policyVersion});
});
test('runtime assembly refuses coerced or absent scanner identities',()=>{
 const store=storage().store;assert.throws(()=>createMaterialPdfRuntime({store,scanner:{scan:async()=>({verdict:'clean'}),engine:undefined,policyVersion:undefined} as any}));
});
