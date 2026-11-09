import test from 'node:test';
import assert from 'node:assert/strict';
import {Router} from 'express';
import type {AuthRequest} from '../src/middleware/auth';
import {createQuestionGradingRouter} from '../src/routes/question-grading';
import {invokeRoute} from './helpers/m2-harness';
const id=(n:number)=>`b4200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=id(1),tenant=id(2),exam=id(3),versionId=id(4),question=id(5),objective=id(6),attempt=id(7),course=id(8);
const payload=(op=20,expected=0)=>({operation_id:id(op),expected_version:expected,question_ref:question,points:'4.25',feedback:'private feedback'});
function fixture(){
 const data={attempt:{id:attempt,tenant_id:tenant,exam_id:exam,exam_version_id:versionId,student_enrollment_id:id(9),student_user_id:id(10),status:'pending_review',submitted_at:'2026-11-07T10:00:00Z',auto_score:'2.00',score:null as string|null,manual_required:1,passing_points:'5.00',version:0,total_points:'7.00'},revisions:[] as any[],operations:[] as any[],audit:[] as any[],grades:[] as any[],head:{head_seq:0,head_entry_hash:null as string|null,head_row_id:null as string|null}};
 const s={owner:true,foreign:false,schema:true,engine:true,primary:true,queueIndex:true,failRevision:false,failAudit:false,failReceipt:false,failGradebook:false,lostCommit:false,commits:0,rollbacks:0,destroyed:0,released:0,
  user:{id:actor,tenantId:tenant,role:'instructor',identitySource:'users',tokenVersion:0} as AuthRequest['user'],calls:[] as Array<{sql:string;p:any[]}>};
 let chain=Promise.resolve();
 const getConnection=async()=>{let before:any,unlock:()=>void=()=>{};return{
  beginTransaction:async()=>{const previous=chain;chain=new Promise<void>(resolve=>unlock=resolve);await previous;before=structuredClone(data);},
  execute:async(sql:string,p:any[]=[])=>{const q=sql.replace(/\s+/g,' ').trim();s.calls.push({sql:q,p});
   if(q.startsWith('SELECT id AS academic_tenant_id'))return[p[0]===tenant?[{academic_tenant_id:tenant}]:[],[]];
   if(q.startsWith('SELECT u.id AS grading_user_id'))return[s.owner&&p[0]===tenant&&p[1]===actor&&p[2]===0?[{grading_user_id:actor}]:[],[]];
   if(q.startsWith('SELECT c.id AS grading_course_id'))return[s.owner&&!s.foreign?[{grading_course_id:course}]:[],[]];
   if(q.includes('information_schema.TABLES'))return[s.schema?['exam_versioned_attempts','exam_versioned_answers','exam_versions','exam_version_questions','exam_manual_answer_revisions','exam_manual_operations','audit_events','audit_chain_head'].map(table_name=>({table_name,engine:s.engine?'InnoDB':'MyISAM'})):[],[]];
   if(q.includes('information_schema.COLUMNS'))return[['tenant_id','operation_id','actor_user_id','attempt_id','request_hash','result','created_at'].map(column_name=>({column_name,data_type:column_name==='result'?'json':'varchar'})),[]];
   if(q.includes("INDEX_NAME='idx_manual_question_queue'"))return[s.queueIndex?['tenant_id','exam_version_id','status','id'].map((column_name,i)=>({column_name,seq:i+1})):[],[]];
   if(q.includes('information_schema.STATISTICS')&&q.includes('NON_UNIQUE=0'))return[[...['attempt_id','question_ref','revision'].map((column_name,i)=>({table_name:'exam_manual_answer_revisions',index_name:'revision_unique',column_name,seq:i+1})),...['attempt_id','question_ref'].map((column_name,i)=>({table_name:'exam_versioned_answers',index_name:'answer_unique',column_name,seq:i+1}))],[]];
   if(q.includes('information_schema.STATISTICS'))return[s.primary?['tenant_id','operation_id'].map((column_name,i)=>({column_name,seq:i+1})):[],[]];
   if(q.startsWith('SELECT actor_user_id,attempt_id'))return[data.operations.filter(r=>r.tenant_id===p[0]&&r.operation_id===p[1]),[]];
   if(q.startsWith('SELECT e.id,e.title'))return[[{id:exam,label:'Exam'}],[]];
   if(q.startsWith('SELECT v.id,CONCAT'))return[p[0]===exam?[{id:versionId,label:'Version 1'}]:[],[]];
   if(q.startsWith('SELECT q.id,LEFT'))return[p[0]===versionId?[{id:question,label:'Explain the proof'}]:[],[]];
   if(q.startsWith('SELECT q.id,q.exam_version_id'))return[p[0]===question&&!s.foreign?[{id:question,version_id:versionId,text:'Explain the proof',points:'5.00',explanation:'Pinned explanation'}]:[],[]];
   if(q.startsWith('SELECT a.id AS attempt_id')){const r=data.revisions.at(-1);return[data.attempt.status==='pending_review'&&(!p[3]||attempt>p[3])?[{attempt_id:attempt,version:data.attempt.version,response:JSON.stringify('private student answer'),revision:r?.revision??null,awarded_hundredths:r?.awarded_hundredths??null,feedback:r?.feedback??null}]:[],[]];}
   if(q.startsWith('SELECT a.id,a.exam_version_id'))return[p[0]===attempt&&!s.foreign?[{...data.attempt}]:[],[]];
   if(q.startsWith('SELECT id FROM exam_'))return[q.includes('manual_answer_revisions')?data.revisions.map((r,i)=>({id:id(200+i)})):q.includes('version_questions')?[{id:question},{id:objective}]:[{id:id(11)},{id:id(12)}],[]];
   if(q.startsWith('SELECT a.id, a.tenant_id'))return[p[0]===attempt&&p[1]===tenant?[structuredClone(data.attempt)]:[],[]];
   if(q.startsWith('SELECT id AS ref'))return[[{ref:question,position:1,question_type:'essay',points:'5.00'},{ref:objective,position:2,question_type:'single_choice',points:'2.00'}],[]];
   if(q.startsWith('SELECT question_ref, question_type, response'))return[[{question_ref:question,question_type:'essay',response:'private student answer',awarded_points:null,is_correct:null,manual_review:1},{question_ref:objective,question_type:'single_choice',response:'A',awarded_points:'2.00',is_correct:1,manual_review:0}],[]];
   if(q.startsWith('SELECT r.question_ref'))return[data.revisions.length?[structuredClone(data.revisions.at(-1))]:[],[]];
   if(q.startsWith('SELECT question_ref, revision'))return[[...structuredClone(data.revisions)].reverse(),[]];
   if(q.startsWith('UPDATE exam_versioned_attempts SET version')){if(data.attempt.version!==p[3]||data.attempt.status!==p[2])return[{affectedRows:0},[]];data.attempt.version++;return[{affectedRows:1},[]];}
   if(q.startsWith('INSERT INTO exam_manual_answer_revisions')){if(s.failRevision)throw Error('revision failed');data.revisions.push({question_ref:p[3],revision:p[4],awarded_hundredths:p[5],reviewer_user_id:p[6],feedback:p[7],created_at:p[8]});return[{affectedRows:1},[]];}
   if(q.startsWith('SELECT status, version'))return[[{status:data.attempt.status,version:data.attempt.version}],[]];
   if(q.startsWith("UPDATE exam_versioned_attempts SET status = 'graded'")){if(data.attempt.version!==p[7]||data.attempt.status!==p[6])return[{affectedRows:0},[]];data.attempt.status='graded';data.attempt.score=p[0];data.attempt.version++;return[{affectedRows:1},[]];}
   if(q.startsWith('SELECT e.course_id'))return[[{course_id:course}],[]];
   if(q.startsWith('SELECT s.id FROM students'))return[[{id:id(9)}],[]];
   if(q.startsWith('SELECT id, score, max_score'))return[data.grades.filter(r=>r.id===p[0]),[]];
   if(q.startsWith('INSERT INTO gradebook_scores')){if(s.failGradebook)throw Error('gradebook failed');data.grades.push({id:p[0],score:p[5],max_score:p[6]});return[{affectedRows:1},[]];}
   if(q.startsWith('SELECT head_seq'))return[[{...data.head}],[]];
   if(q.startsWith('UPDATE audit_chain_head')){data.head={head_seq:p[0],head_entry_hash:p[1],head_row_id:p[2]};return[{affectedRows:1},[]];}
   if(q.startsWith('INSERT INTO audit_events')){if(s.failAudit)throw Error('audit failed');data.audit.push(p);return[{affectedRows:1},[]];}
   if(q.startsWith('INSERT INTO exam_manual_operations')){if(s.failReceipt)throw Error('receipt failed');data.operations.push(Object.fromEntries(['tenant_id','operation_id','actor_user_id','attempt_id','request_hash','result'].map((k,i)=>[k,p[i]])));return[{affectedRows:1},[]];}
   throw Error('Unexpected SQL: '+q);
  },commit:async()=>{s.commits++;if(s.lostCommit)throw Error('lost ACK');unlock();},rollback:async()=>{s.rollbacks++;Object.assign(data,before);},release:()=>{s.released++;unlock();},destroy:()=>{s.destroyed++;unlock();}};};
 const router=Router();router.use((req,_res,next)=>{(req as AuthRequest).user=s.user;next();});router.use('/api/tenants/me/catalog',createQuestionGradingRouter({getConnection,now:()=>new Date('2026-11-07T12:00:00.000Z')}));
 const request=(path:string,method='GET',body?:unknown,query:Record<string,string>={})=>invokeRoute(router,{method,url:'/api/tenants/me/catalog/grading'+path,body,query});
 const grade=(body:any=payload())=>request('/attempts/'+attempt+'/grade','POST',body);
 return{s,data,request,grade};
}
test('owner workbench selects only published pinned essay facts and hides student identity/key metadata',async()=>{
 const h=fixture();for(const path of ['/exams','/exams/'+exam+'/versions','/versions/'+versionId+'/questions'])assert.equal((await h.request(path)).statusCode,200);
 const r=await h.request('/questions/'+question+'/answers');assert.equal(r.statusCode,200);const b=r.body as any;assert.equal(b.question.explanation,'Pinned explanation');assert.equal(b.answers[0].response,'private student answer');assert.equal(b.answers[0].awarded_points,null);
 assert.doesNotMatch(JSON.stringify(b),/student_user_id|student_enrollment_id|correct_answers|reviewer_user_id/);assert.equal(r.headers?.['cache-control'],'no-store');assert.equal(h.s.commits,0);
});
test('answer write uses existing grade planner/store and seals revision/audit/receipt atomically',async()=>{
 const h=fixture(),r=await h.grade();assert.equal(r.statusCode,201);assert.equal(h.data.attempt.version,1);assert.equal(h.data.attempt.status,'pending_review');assert.equal(h.data.revisions[0].awarded_hundredths,425);assert.equal(h.data.audit.length,1);assert.equal(h.data.head.head_seq,1);assert.equal(h.data.operations.length,1);
 assert.equal((r.body as any).operation.awarded_points,'4.25');assert.doesNotMatch(JSON.stringify(h.data.audit),/private student answer|private feedback/);assert.doesNotMatch(JSON.stringify(h.data.operations),/private feedback|private student answer/);
});
test('same key replay is canonical and historical after a later revision; changed payload refuses without another write',async()=>{
 const h=fixture();await h.grade();await h.grade({...payload(21,1),points:'3.00'});const replay=await h.grade({feedback:' private feedback ',points:'4.25',question_ref:question,expected_version:0,operation_id:id(20)});assert.equal(replay.statusCode,200);assert.equal((replay.body as any).operation.revision,1);assert.equal(h.data.revisions.length,2);
 assert.equal((await h.grade({...payload(),points:'1.00'})).statusCode,409);assert.equal(h.data.audit.length,2);
});
test('concurrent decisions for one displayed attempt version allow one write and no silent overwrite',async()=>{
 const h=fixture(),results=await Promise.all([h.grade(payload(20)),h.grade(payload(21))]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,409]);assert.equal(h.data.revisions.length,1);assert.equal(h.data.audit.length,1);
});
test('revision, sealed audit and receipt failures roll the version/history/chain back together',async()=>{
 for(const field of ['failRevision','failAudit','failReceipt'] as const){const h=fixture();h.s[field]=true;const r=await h.grade();assert.equal(r.statusCode,503);assert.equal(h.data.attempt.version,0);assert.equal(h.data.revisions.length,0);assert.equal(h.data.audit.length,0);assert.equal(h.data.operations.length,0);assert.equal(h.data.head.head_seq,0);}
});
test('lost commit acknowledgement never rolls back and recovers durable outcome by GET',async()=>{
 const h=fixture();h.s.lostCommit=true;const r=await h.grade();assert.equal(r.statusCode,503);assert.equal((r.body as any).code,'PERSISTENCE_UNCERTAIN');assert.equal(h.s.rollbacks,0);assert.equal(h.s.destroyed,1);assert.equal(h.data.operations.length,1);
 h.s.lostCommit=false;const recovered=await h.request('/operations/'+id(20));assert.equal(recovered.statusCode,200);assert.equal((recovered.body as any).operation.revision,1);assert.equal(h.data.audit.length,1);
});
test('incomplete finalization is refused; previewed complete total uses existing finalizer and gradebook writer once',async()=>{
 const h=fixture();let preview=(await h.request('/attempts/'+attempt+'/review')).body as any;assert.equal(preview.complete,false);assert.equal(preview.score,null);
 await h.grade();preview=(await h.request('/attempts/'+attempt+'/review')).body as any;assert.equal(preview.score,'6.25');assert.equal(preview.version,1);
 const input={operation_id:id(30),expected_version:preview.version,review_token:preview.review_token};const done=await h.request('/attempts/'+attempt+'/finalize','POST',input);assert.equal(done.statusCode,201);assert.equal(h.data.attempt.status,'graded');assert.equal(h.data.attempt.score,'6.25');assert.equal(h.data.grades.length,1);assert.equal(h.data.audit.length,2);
 assert.equal((await h.request('/attempts/'+attempt+'/finalize','POST',input)).statusCode,200);assert.equal(h.data.grades.length,1);assert.equal((await h.grade(payload(22,2))).statusCode,409);
});
test('finalization rechecks preview version/token and rolls back on a failed gradebook projection',async()=>{
 const h=fixture();await h.grade();const preview=(await h.request('/attempts/'+attempt+'/review')).body as any;await h.grade({...payload(21,1),points:'3.00'});
 assert.equal((await h.request('/attempts/'+attempt+'/finalize','POST',{operation_id:id(30),expected_version:preview.version,review_token:preview.review_token})).statusCode,409);
 const fresh=(await h.request('/attempts/'+attempt+'/review')).body as any;h.s.failGradebook=true;assert.equal((await h.request('/attempts/'+attempt+'/finalize','POST',{operation_id:id(31),expected_version:fresh.version,review_token:fresh.review_token})).statusCode,503);assert.equal(h.data.attempt.status,'pending_review');assert.equal(h.data.attempt.version,2);assert.equal(h.data.grades.length,0);assert.equal(h.data.audit.length,2);
});
test('role labels, old staff, missing owner/schema and foreign attempts do not grant grading authority',async()=>{
 for(const kind of ['owner','student','staff','schema','engine','primary','queueIndex','foreign']){const h=fixture();if(kind==='owner')h.s.owner=false;if(kind==='student')h.s.user={...h.s.user!,role:'student'};if(kind==='staff')h.s.user={...h.s.user!,identitySource:'staff'};if(kind==='schema')h.s.schema=false;if(kind==='engine')h.s.engine=false;if(kind==='primary')h.s.primary=false;if(kind==='queueIndex')h.s.queueIndex=false;if(kind==='foreign')h.s.foreign=true;
  const r=await h.grade();assert.ok([403,404,503].includes(r.statusCode!));assert.equal(h.data.revisions.length,0);assert.equal(h.data.operations.length,0);}
});
test('strict full amounts and exact operation bodies are rejected before any SQL',async()=>{
 for(const body of [{...payload(),points:'1abc'},{...payload(),points:'1.234'},{...payload(),points:'Infinity'},{...payload(),points:-1},{...payload(),tenant_id:tenant}]){const h=fixture();assert.equal((await h.grade(body)).statusCode,400);assert.equal(h.s.calls.length,0);}
 const h=fixture();assert.equal((await h.grade({...payload(),points:'5.01'})).statusCode,400);assert.equal(h.data.revisions.length,0);
});
