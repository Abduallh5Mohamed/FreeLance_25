import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseLessonsRouter } from '../src/routes/course-lessons';
import { makeReq, runChain, squash, withSilencedErrors } from './helpers/m2-course-lessons-harness';
const id = (n: number) => `b4000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const course=id(1),unit=id(2),lesson=id(3),content=id(4),exam=id(5),version=id(6);
function fixture() {
  const s = { owner:true,course:true,unit:true,lesson:true,activity:true,kind:'quiz',source:true,schema:true,engine:'InnoDB',indexes:true,fks:true,failAudit:false,failInsert:false,failCommit:false,acquired:0,
    pins:[] as any[],audits:[] as any[],calls:[] as string[],events:[] as string[],
    versions:[{id:version,version:1,exam_id:exam,tenant_id:'tenant',status:'published',published_at:'synthetic',correct_answers:'private-answer'}] as any[] };
  let chain=Promise.resolve();
  const getConnection=async()=>{
    s.acquired++;let before:any,unlock=()=>{};
    return {
      beginTransaction:async()=>{const previous=chain;chain=new Promise(resolve=>{unlock=resolve;});await previous;before=structuredClone({pins:s.pins,audits:s.audits});s.events.push('begin');},
      execute:async(sql:string,p:any[]=[]):Promise<[any,any]>=>{
        const q=squash(sql);s.calls.push(q);
        if(q.includes('FROM tenants t JOIN users'))return [[{owner_user_id:s.owner?'owner':'foreign',tenant_status:'active',caller_active:1}],[]];
        if(q.includes('FROM courses c'))return [s.course&&p[0]===course&&p[1]==='tenant'?[{id:course,tenant_id:'tenant'}]:[],[]];
        if(q.includes('FROM course_units u'))return [s.unit&&p[0]===unit&&p[1]===course?[{id:unit}]:[],[]];
        if(q.startsWith('SELECT l.id FROM course_lessons'))return [s.lesson&&p[0]===lesson&&p[1]===unit?[{id:lesson}]:[],[]];
        if(q.includes('information_schema.COLUMNS')){
          const tables=q.includes("'course_lesson_quiz_versions'")?{course_lesson_quiz_versions:['content_id','exam_id','exam_version_id'],exam_versions:['id','exam_id','tenant_id','version','status','published_at']}:{course_lesson_activities:['id','lesson_id','kind','assignment_id','exam_id'],assignments:['id','tenant_id','course_id','title','status','archived_at','group_id','branch_id','branch_scope'],exams:['id','course_id','title','is_active','is_published'],exam_groups:['exam_id','group_id']};
          return [s.schema?Object.entries(tables).flatMap(([table_name,columns])=>columns.map(column_name=>({table_name,column_name}))):[],[]];
        }
        if(q.includes('information_schema.TABLES'))return [['course_lesson_quiz_versions','exam_versions','course_lesson_activities','assignments','exams','exam_groups','course_lessons','course_units','courses','tenants','users','audit_events','groups','branches'].map(table_name=>({table_name,engine:s.engine})),[]];
        if(q.includes('information_schema.STATISTICS')){
          const quiz=q.includes("'course_lesson_quiz_versions'");
          const rows=quiz?[{table_name:'course_lesson_quiz_versions',index_name:'PRIMARY',column_name:'content_id',seq_in_index:1,non_unique:0},{table_name:'exam_versions',index_name:'PRIMARY',column_name:'id',seq_in_index:1,non_unique:0},...['exam_id','version'].map((column_name,i)=>({table_name:'exam_versions',index_name:'uq_exam_version',column_name,seq_in_index:i+1,non_unique:0}))]
            :['course_lesson_activities','assignments','exams'].flatMap(table_name=>[{table_name,index_name:'PRIMARY',column_name:'id',seq_in_index:1,non_unique:0},...(table_name==='course_lesson_activities'?['lesson_id','kind'].map((column_name,i)=>({table_name,index_name:'uq_lesson_activity_kind',column_name,seq_in_index:i+1,non_unique:0})):[])]);
          return [s.indexes?rows:[],[]];
        }
        if(q.includes('information_schema.KEY_COLUMN_USAGE'))return [s.fks?[['content_id','course_lesson_activities','CASCADE'],['exam_id','exams','RESTRICT'],['exam_version_id','exam_versions','RESTRICT']].map(([column_name,referenced_table,delete_rule])=>({column_name,referenced_table,referenced_column:'id',delete_rule})):[],[]];
        if(q.startsWith('SELECT id,exam_id FROM course_lesson_activities')){assert.deepEqual(p,[content,lesson]);return [s.activity&&s.kind==='quiz'?[{id:content,exam_id:exam}]:[],[]];}
        if(q.startsWith('SELECT content_id,exam_id'))return [s.pins.filter(row=>row.content_id===p[0]),[]];
        if(q.startsWith('SELECT s.id,s.title'))return [s.source&&p[0]==='tenant'&&p[1]===course&&p[2]===exam?[{id:exam,title:'Quiz',is_published:1}]:[],[]];
        if(q.includes('FROM exam_groups eg LEFT JOIN'))return [[],[]];
        if(q.startsWith('SELECT id,version FROM exam_versions')){
          assert.ok(q.includes("status='published' AND published_at IS NOT NULL"));const page=q.includes('id>?');
          return [s.versions.filter(row=>row.exam_id===p[page?0:1]&&row.tenant_id===p[page?1:2]&&row.status==='published'&&row.published_at!==null&&(page?row.id>p[2]:row.id.toLowerCase()===String(p[0]).toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,page?26:1),[]];
        }
        if(q.startsWith('INSERT INTO course_lesson_quiz_versions')){if(s.failInsert)throw Error('insert');s.pins.push({content_id:p[0],exam_id:p[1],exam_version_id:p[2]});return [{affectedRows:1},[]];}
        if(q.startsWith('DELETE FROM course_lesson_quiz_versions')){const before=s.pins.length;s.pins=s.pins.filter(row=>!(row.content_id===p[0]&&row.exam_id===p[1]&&row.exam_version_id===p[2]));return [{affectedRows:before-s.pins.length},[]];}
        if(q.startsWith('INSERT INTO audit_events')){if(s.failAudit)throw Error('audit');s.audits.push(p);return [{affectedRows:1},[]];}
        throw Error('Unexpected synthetic SQL '+q);
      },
      commit:async()=>{s.events.push('commit');if(s.failCommit)throw Error('lost ack');},rollback:async()=>{s.events.push('rollback');Object.assign(s,before);},release:()=>{s.events.push('release');unlock();},destroy:()=>{s.events.push('destroy');unlock();},
    };
  };
  const router=createCourseLessonsRouter({getConnection});
  const request=(method='GET',suffix='/version',body:any={},query:any={},user:any={id:'owner',tenantId:'tenant'})=>{const req:any=makeReq({method,pathName:`/courses/${course}/units/${unit}/lessons/${lesson}/activities/quiz/${content}${suffix}`,body,query});req.user=user;return runChain([router],req);};
  return {s,request};
}
test('owner explicitly pins a published header; reads are fixed and no source, questions, attempts or grades are mutated',async()=>{
  const {s,request}=fixture();assert.deepEqual((await request()).body,{pin:null});
  const sources=await request('GET','/available-versions');assert.deepEqual(sources.body,{versions:[{exam_version_id:version,version_number:1}],next_cursor:null});assert.equal(sources.headers['Cache-Control'],'no-store');
  const pin=await request('POST','/version',{exam_version_id:version});assert.equal(pin.status,201);assert.deepEqual(pin.body.pin,{content_id:content,exam_version_id:version,version_number:1,status:'published'});
  assert.equal((await request('POST','/version',{exam_version_id:version})).body.unchanged,true);assert.equal(s.audits.length,1);assert.ok(!JSON.stringify((await request()).body).includes('private-answer'));
  assert.ok(!s.calls.some(q=>/^(INSERT|UPDATE|DELETE).*(exam_versioned_attempts|exam_version_questions|exam_grading|student_courses)/i.test(q)));
});
for(const gate of ['owner','course','unit','lesson','activity'] as const)test(`pin parent ${gate} is current and server-derived`,async()=>{
  const {s,request}=fixture();s[gate]=false;assert.equal((await request('POST','/version',{exam_version_id:version})).status,gate==='owner'?403:404);assert.equal(s.pins.length,0);
});
for(const gate of ['schema','indexes','fks','engine'] as const)test(`pin actual ${gate} fails closed`,async()=>{
  const {s,request}=fixture();if(gate==='engine')s.engine='MyISAM';else s[gate]=false;assert.equal((await request('POST','/version',{exam_version_id:version})).status,503);assert.equal(s.audits.length,0);
});
test('exact bodies, billing-only state and selectors deny before connection acquisition',async()=>{
  const {s,request}=fixture();for(const body of [{exam_version_id:version,tenant_id:'foreign'},{exam_version_id:'bad'},null,[]])assert.equal((await request('POST','/version',body)).status,400);
  assert.equal((await request('GET','/available-versions',{}, {exam_id:exam})).status,400);assert.equal((await request('GET','/version',{}, {},{id:'owner',tenantId:'tenant',billingOnly:true})).status,403);assert.equal(s.acquired,0);
});
for(const cause of ['foreignTenant','foreignExam','draft','archived','unpublishedTime','homework'] as const)test(`version ${cause} is never eligible for a quiz pin`,async()=>{
  const {s,request}=fixture();if(cause==='foreignTenant')s.versions[0].tenant_id='foreign';if(cause==='foreignExam')s.versions[0].exam_id=id(99);if(cause==='draft'||cause==='archived')s.versions[0].status=cause;if(cause==='unpublishedTime')s.versions[0].published_at=null;if(cause==='homework')s.kind='homework';
  assert.equal((await request('POST','/version',{exam_version_id:version})).status,404);assert.equal(s.pins.length,0);
});
test('versions page 25+1 and never select the newest or an arbitrary header automatically',async()=>{
  const {s,request}=fixture();for(let n=10;n<40;n++)s.versions.push({...s.versions[0],id:id(n),version:n});
  const page=await request('GET','/available-versions');assert.equal(page.body.versions.length,25);assert.equal(page.body.next_cursor,page.body.versions[24].exam_version_id);assert.equal(s.pins.length,0);
  const next=await request('GET','/available-versions',{}, {cursor:page.body.next_cursor});assert.equal(next.body.versions.length,6);assert.equal(next.body.next_cursor,null);
});
test('new publication or withdrawal never replaces a pin; stale unpin cannot remove a different pinned version',async()=>{
  const {s,request}=fixture();await request('POST','/version',{exam_version_id:version});s.versions.push({...s.versions[0],id:id(8),version:2});
  assert.equal((await request('POST','/version',{exam_version_id:id(8)})).status,409);s.versions[0].status='archived';assert.deepEqual((await request()).body.pin,{content_id:content,exam_version_id:version,version_number:null,status:'unavailable'});
  assert.equal((await request('DELETE','/version/'+version)).body.detached,true);await request('POST','/version',{exam_version_id:id(8)});assert.equal((await request('DELETE','/version/'+version)).status,409);assert.equal(s.pins[0].exam_version_id,id(8));
});
test('a withdrawn source hides the ordinal but its pinned selection can still be explicitly removed',async()=>{
  const {s,request}=fixture();await request('POST','/version',{exam_version_id:version});s.source=false;assert.equal((await request()).body.pin.status,'unavailable');assert.equal((await request('GET','/available-versions')).status,404);
  assert.equal((await request('DELETE','/version/'+version)).body.detached,true);assert.equal(s.versions.length,1);
});
test('concurrent duplicate pin creates one binding and one audit',async()=>{
  const {s,request}=fixture();const replies=await Promise.all([request('POST','/version',{exam_version_id:version}),request('POST','/version',{exam_version_id:version})]);assert.deepEqual(replies.map(row=>row.status),[201,200]);assert.equal(s.pins.length,1);assert.equal(s.audits.length,1);
});
for(const failure of ['failInsert','failAudit'] as const)test(`${failure} rolls back pin and audit`,async()=>withSilencedErrors(async()=>{
  const {s,request}=fixture();s[failure]=true;assert.equal((await request('POST','/version',{exam_version_id:version})).status,500);assert.equal(s.pins.length,0);assert.equal(s.audits.length,0);
}));
test('unpin audit failure restores selection; uncertain commit destroys connection and permits read-only reconciliation',async()=>withSilencedErrors(async()=>{
  const {s,request}=fixture();await request('POST','/version',{exam_version_id:version});s.failAudit=true;assert.equal((await request('DELETE','/version/'+version)).status,500);assert.equal(s.pins.length,1);assert.equal(s.audits.length,1);
  const h=fixture();h.s.failCommit=true;const reply=await h.request('POST','/version',{exam_version_id:version});assert.equal(reply.body.code,'PERSISTENCE_UNCERTAIN');assert.deepEqual(h.s.events,['begin','commit','destroy']);h.s.failCommit=false;assert.equal((await h.request()).body.pin.exam_version_id,version);assert.equal(h.s.audits.length,1);
}));
