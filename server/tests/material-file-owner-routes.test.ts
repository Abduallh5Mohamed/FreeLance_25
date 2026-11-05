import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { createCourseLessonsRouter } from '../src/routes/course-lessons';
import { createIsolation, makeReq, runChain } from './helpers/m2-course-lessons-harness';
const require = createRequire(import.meta.url);
const express = require('../node_modules/express');
const id = (n:number)=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pdf=Buffer.from('%PDF-1.7\nfixture only\n%%EOF');
const columns=['id','material_id','tenant_id','course_id','object_key','object_version','sha256','size_bytes','mime_type','status',
  'scan_status','scanned_object_version','scanned_sha256','scan_engine','scan_policy_version','scanned_at','upload_request_id','uploaded_by','upload_status'];
function fixture(configured=true,scanner=true){
 const s={owner:true,course:true,unit:true,lesson:true,binding:true,schema:true,row:null as any,audits:[] as any[],put:0,read:0,scan:0,bodyRead:0,connections:0};
 let before:any,auditBefore=0;
 const getConnection=async()=>{s.connections++;return{
  beginTransaction:async()=>{before=s.row?{...s.row}:null;auditBefore=s.audits.length;},
  execute:async(sql:string,p:any[]=[]):Promise<[any,any]>=>{
   const n=sql.replace(/\s+/g,' ').trim();
   if(n.includes('FROM tenants t'))return[[{owner_user_id:s.owner?'owner':'foreign',tenant_status:'active',caller_active:1}],[]];
   if(n.includes('FROM courses c'))return[s.course?[{id:id(1),tenant_id:'tenant-a'}]:[],[]];
   if(n.includes('FROM course_units u'))return[s.unit?[{id:id(2)}]:[],[]];
   if(n.startsWith('SELECT l.id'))return[s.lesson?[{id:id(3)}]:[],[]];
   if(n.startsWith('SELECT b.material_id')){assert.deepEqual(p,[id(1),id(4),id(3)]);return[s.binding?[{material_id:id(5)}]:[],[]];}
   if(n.includes('information_schema'))return[s.schema?columns.map(column_name=>({column_name})):[],[]];
   if(n.startsWith('SELECT f.id'))return[s.row?[{...s.row}]:[],[]];
   if(n.startsWith('INSERT INTO course_material_files')){s.row={id:p[0],material_id:p[1],tenant_id:p[2],course_id:p[3],object_key:p[4],object_version:p[5],sha256:p[6],size_bytes:p[7],mime_type:p[8],status:'active',scan_status:'pending',upload_request_id:p[9],uploaded_by:p[10],upload_status:'reserved'};return[{affectedRows:1},[]];}
   if(n.startsWith('UPDATE course_material_files SET object_version')){s.row={...s.row,object_version:p[0],upload_status:'stored'};return[{affectedRows:1},[]];}
   if(n.startsWith('UPDATE course_material_files SET upload_status')){s.row={...s.row,upload_status:'complete',scan_status:p[0],scanned_object_version:p[1],scanned_sha256:p[2],scan_engine:p[3],scan_policy_version:p[4]};return[{affectedRows:1},[]];}
   if(n.startsWith("UPDATE course_material_files SET status='revoked'")){assert.deepEqual(p,[s.row.id,'tenant-a',id(1),id(5)]);s.row={...s.row,status:'revoked'};return[{affectedRows:1},[]];}
   if(n.startsWith('INSERT INTO audit_events')){s.audits.push(p);return[{affectedRows:1},[]];}
   throw Error('Unexpected SQL '+n);
  },commit:async()=>{},rollback:async()=>{s.row=before;s.audits.length=auditBefore;},release:()=>{},destroy:()=>{},
 };};
 let bytes:Buffer;
 const config={store:{putOnce:async(input:any)=>{s.put++;assert.ok(s.row,'reservation before put');bytes=Buffer.from(input.bytes);return{objectVersion:'immutable-v1 '};},
  read:async()=>{s.read++;return(async function*(){yield bytes;})();}},scanner:scanner?{engine:'test-scanner',policyVersion:'v1',scan:async(input:any)=>{s.scan++;return{verdict:'clean' as const,sha256:input.sha256,objectVersion:input.objectVersion};}}:undefined};
 const router=createCourseLessonsRouter({getConnection,materialFileIngestion:configured?config:undefined});
 const base=`/courses/${id(1)}/units/${id(2)}/lessons/${id(3)}/contents/${id(4)}/file`;
 const request=async(method='GET',headers:Record<string,string>={},body?:any,user:any={id:'owner',tenantId:'tenant-a'},query={},useGlobalParsers=false)=>{
  const req:any=Readable.from((async function*(){s.bodyRead++;yield pdf;})());
  Object.assign(req,makeReq({method,pathName:base,headers:method==='POST'?{'content-type':'application/pdf','content-length':String(pdf.length),'idempotency-key':id(9),...headers}:headers,body,query}));
  req.body=body;req.user=user;
  return runChain(useGlobalParsers?[express.json({limit:'50mb'}),express.urlencoded({extended:true,limit:'50mb'}),router]:[router],req);
 };
 return{s,request,getConnection,config};
}
test('real owner router accepts actual PDF stream after global JSON/urlencoded parsers skip it',async()=>{
 const h=fixture(),r=await h.request('POST',{},undefined,undefined,{},true);
 assert.equal(r.status,201);assert.equal(r.body.file.scan_status,'clean');assert.equal(h.s.bodyRead,1);assert.equal(h.s.put,1);assert.equal(h.s.scan,1);assert.equal(h.s.audits.length,3);
 assert.equal(r.headers['Cache-Control'],'no-store');assert.ok(!JSON.stringify(r.body).includes('catalog-materials'));
 const again=await h.request('POST');assert.equal(again.status,200);assert.equal(again.body.unchanged,true);assert.equal(h.s.put,1);
});
test('owner status reports pending scan and allows the original owner to explicitly resume the same request',async()=>{
 const h=fixture(true,false);assert.equal((await h.request('POST')).status,202);
 const status=await h.request();assert.equal(status.body.file.scan_status,'pending');assert.equal(status.body.file.upload_status,'stored');assert.equal(status.body.retry_request_id,id(9));
 assert.equal(status.body.capabilities.scan,false);assert.equal(h.s.scan,0);
});
test('owner DELETE revokes once, audits and does not read body or call provider',async()=>{
 const h=fixture();assert.equal((await h.request('POST')).status,201);
 const before=h.s.audits.length, read=h.s.read, put=h.s.put, scan=h.s.scan, bodies=h.s.bodyRead;
 const result=await h.request('DELETE');assert.equal(result.status,200);assert.equal(result.body.file.source_status,'revoked');assert.equal(result.body.unchanged,false);
 assert.equal(result.headers['Cache-Control'],'no-store');assert.equal(h.s.audits.length,before+1);assert.equal(h.s.bodyRead,bodies);
 assert.equal(h.s.read,read);assert.equal(h.s.put,put);assert.equal(h.s.scan,scan);
 assert.equal((await h.request()).body.retry_request_id,null);
 const again=await h.request('DELETE');assert.equal(again.body.unchanged,true);assert.equal(h.s.audits.length,before+1);
 assert.equal((await h.request('POST')).status,409);
});
test('owner DELETE is scoped and works when upload adapters are unconfigured',async()=>{
 const h=fixture();await h.request('POST');h.s.owner=false;assert.equal((await h.request('DELETE')).status,403);assert.equal(h.s.row.status,'active');
 h.s.owner=true;h.s.binding=false;assert.equal((await h.request('DELETE')).status,404);assert.equal(h.s.row.status,'active');
 const unconfigured=fixture(false);assert.equal((await unconfigured.request('DELETE')).status,404);
});
for(const gate of ['owner','course','unit','lesson','binding','schema'] as const)test(`owner file ${gate} refuses before body/provider work`,async()=>{
 const h=fixture();h.s[gate]=false;const r=await h.request('POST');assert.equal(r.status,gate==='owner'?403:gate==='schema'?503:404);
 assert.equal(h.s.bodyRead,0);assert.equal(h.s.put,0);assert.equal(h.s.row,null);assert.equal(r.headers['Cache-Control'],'no-store');
});
test('unconfigured default reports unavailable and never consumes the upload stream',async()=>{
 const h=fixture(false);const status=await h.request();assert.deepEqual(status.body.capabilities,{upload:false,scan:false});
 assert.equal((await h.request('POST')).status,503);assert.equal(h.s.bodyRead,0);assert.equal(h.s.put,0);
});
test('billing-only and client selectors never acquire file authority',async()=>{
 const h=fixture();assert.equal((await h.request('POST',{},undefined,{id:'owner',tenantId:'tenant-a',billingOnly:true})).status,403);
 assert.equal((await h.request('POST',{},undefined,undefined,{object_key:'foreign'})).status,400);
 assert.equal((await h.request('POST',{'x-tenant-id':'foreign'})).status,400);assert.equal(h.s.connections,0);assert.equal(h.s.bodyRead,0);
});
test('JSON clean verdict, arbitrary key body, invalid request id and oversized length are refused',async()=>{
 const h=fixture();assert.equal((await h.request('POST',{'content-type':'application/json'},{scan_status:'clean',object_key:'foreign'})).status,415);
 assert.equal((await h.request('POST',{'idempotency-key':'bad'})).status,400);
 assert.equal((await h.request('POST',{'content-length':String(11*1024*1024)})).status,413);assert.equal(h.s.put,0);assert.equal(h.s.bodyRead,0);
});
test('real tenant-self mount forwards optional config but keeps default provider adapters untouched',async()=>{
 const isolation=createIsolation();try{
  const {createTenantSelfRouter}=isolation.load('../../src/routes/tenant-self');const h=fixture();
  const router=createTenantSelfRouter({db:{getConnection:h.getConnection,query:async()=>{throw Error('unexpected');},queryOne:async()=>{throw Error('unexpected');},execute:async()=>{throw Error('unexpected');}},
   materialFileIngestion:h.config,authenticate:(_req:any,_res:any,next:any)=>next(),loadActiveTenantAuthority:async()=>({authority:'owner'}),
   uploadBuffer:async()=>{throw Error('provider');},deleteFile:async()=>{throw Error('provider');},getPrivateObjectUrl:async()=>{throw Error('provider');},executeRenewalIntent:async()=>{throw Error('provider');}});
  const req:any=makeReq({pathName:`/catalog/courses/${id(1)}/units/${id(2)}/lessons/${id(3)}/contents/${id(4)}/file`});req.user={id:'owner',tenantId:'tenant-a'};
  const result=await runChain([router],req);assert.equal(result.status,200);assert.equal(result.body.capabilities.upload,true);assert.deepEqual(isolation.sentinelCalls,[]);
 }finally{isolation.restore();}
});
