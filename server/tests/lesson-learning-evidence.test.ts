import assert from 'node:assert/strict';
import test from 'node:test';
import { createLessonPreparationRouter } from '../src/routes/lesson-preparation';
import { parseLearningWindow, summarizeLearning, LEARNING_TABLES } from '../src/services/lesson-learning-evidence';
import { fixture,uid } from './helpers/lesson-package-fixture';
import { makeReq,runChain,COURSE_A1,UNIT_A1,LESSON_1,OWNER_A,TENANT_A } from './helpers/m2-course-lessons-harness';
const from='2026-11-01T00:00:00.000Z',to='2026-11-07T00:00:00.000Z';
const window={group_id:uid(70),from,to};
const path=`/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_1}/preparation`;
function harness(){
  const s={schema:true,group:true,questions:1,attempts:5,manual:false,wrongContext:false,missingAnswer:false,duplicate:false,tags:['fractions'],query:[] as string[],pending:1,otherGroup:1};
  const h=fixture({},deps=>createLessonPreparationRouter({getConnection:async()=>{
    const conn=await deps.getConnection();return{...conn,execute:async(sql:string,p:any[]=[])=>{
      const q=sql.replace(/\s+/g,' ').trim();s.query.push(q);assert.match(q,/^SELECT /);
      if(q.includes('information_schema.COLUMNS')&&q.endsWith('LIMIT 80'))return[s.schema?Object.entries(LEARNING_TABLES).flatMap(([table_name,cols])=>cols.map(column_name=>({table_name,column_name,data_type:['catalog_context','tags'].includes(column_name)?'json':'char'}))):[],[]];
      if(q.includes('information_schema.TABLES')&&q.endsWith('LIMIT 4'))return[Object.keys(LEARNING_TABLES).map(table_name=>({table_name,engine:'InnoDB'})),[]];
      if(q.startsWith('SELECT g.id,g.name,g.course_id')){assert.equal(p[0],COURSE_A1);return[s.group?[{id:uid(70),name:'Synthetic group',course_id:COURSE_A1,branch_scope:'tenant',branch_id:null}]:[],[]];}
      if(q.startsWith('SELECT q.id,q.position')){assert.deepEqual(p,[TENANT_A,uid(80)]);return[Array.from({length:s.questions},(_,i)=>({id:uid(200+i),position:i+1,question_type:s.manual?'essay':'single_choice',points:'1.00',question_text:'Frozen question <script>',source_version_id:uid(400+i),tag_version_id:uid(400+i),tags:JSON.stringify(s.tags)})),[]];}
      if(q.startsWith('SELECT a.id,a.student_enrollment_id')){
        assert.match(q,/INNER JOIN students/);assert.match(q,/s.group_id=\?/);assert.match(q,/a.status='graded'/);assert.match(q,/a.submitted_at>=\? AND a.submitted_at<\?/);assert.match(q,/JSON_EXTRACT\(a.catalog_context,'\$\.contentId'\)/);assert.match(q,/LIMIT 101$/);
        assert.deepEqual(p,[TENANT_A,uid(40),uid(80),uid(70),'2026-11-01 00:00:00','2026-11-07 00:00:00',COURSE_A1,LESSON_1,uid(140)]);
        const all=[...Array.from({length:s.attempts},(_,i)=>({n:i,status:'graded',group:uid(70)})),{n:800,status:'pending_review',group:uid(70)},{n:900,status:'graded',group:uid(71)}];
        return[all.filter(row=>row.status==='graded'&&row.group===p[3]).map(row=>({id:uid(500+row.n),student_enrollment_id:'enrollment-'+row.n,student_user_id:'student-'+row.n,catalog_context:{courseId:COURSE_A1,lessonId:s.wrongContext?uid(999):LESSON_1,contentId:uid(140),userId:'student-'+row.n,tenantId:TENANT_A,enrollmentId:'enrollment-'+row.n,examId:uid(40),versionId:uid(80),snapshotFingerprint:'a'.repeat(64)}})),[]];
      }
      if(q.startsWith('SELECT a.attempt_id,a.question_ref')){
        assert.deepEqual(p.slice(0,2),[TENANT_A,uid(80)]);assert.match(q,/q.question_type<>'essay'/);assert.match(q,/LIMIT 20001$/);
        const rows=s.manual?[]:Array.from({length:s.attempts*s.questions},(_,i)=>({attempt_id:uid(500+Math.floor(i/s.questions)),question_ref:uid(200+i%s.questions),question_type:'single_choice',is_correct:Math.floor(i/s.questions)>=2,manual_review:0}));
        if(s.missingAnswer)rows.pop();if(s.duplicate)rows.push(rows[0]);return[rows,[]];
      }
      return conn.execute(sql,p);
    }};
  }}));
  h.state.bindings[LESSON_1].activity.push({id:uid(140),kind:'quiz',source_id:uid(40),display_order:null});h.state.pin={content_id:uid(140),exam_id:uid(40),exam_version_id:uid(80)};
  const request=async(suffix='/learning',query:any=window,user:any={id:OWNER_A,tenantId:TENANT_A,role:'instructor'})=>{const req:any=makeReq({method:'GET',pathName:path+suffix,query,body:{}});req.user=user;const r=await runChain([h.router],req);await new Promise(resolve=>setImmediate(resolve));return r;};
  return{...h,s,request};
}
test('learning windows are exact, UTC, end-exclusive and at most 31 days',()=>{
  assert.ok(parseLearningWindow(window));for(const x of [{...window,to:from},{...window,to:'2026-12-10T00:00:00.000Z'},{...window,from:'2026-02-30T00:00:00.000Z'},{...window,student_id:'foreign'},{...window,group_id:'bad'},{...window,to:'2026-11-07T00:00:00+02:00'}])assert.equal(parseLearningWindow(x),null);
});
test('actual owner route ranks pinned tags from final automatic answers, excluding pending/other-group cohorts',async()=>{
  const h=harness(),r=await h.request();assert.equal(r.status,200);assert.equal(r.body.state,'available');assert.equal(r.body.graded_attempts,5);assert.equal(r.body.suggestions[0].tag,'fractions');assert.equal(r.body.suggestions[0].not_fully_correct,2);assert.equal(r.body.suggestions[0].responses,5);assert.equal(r.headers['Cache-Control'],'no-store');
  for(const field of ['student_user_id','student_enrollment_id','catalog_context','correct_answers','response','snapshotFingerprint'])assert.ok(!JSON.stringify(r.body).includes('"'+field+'"'));assert.equal(h.state.audits,0);
});
test('group discovery is private and course bounded with explicit pages',async()=>{
  const h=harness(),r=await h.request('/groups',{});assert.equal(r.status,200);assert.deepEqual(r.body.groups,[{id:uid(70),name:'Synthetic group'}]);assert.equal(r.body.next_cursor,null);
  assert.equal((await h.request('/groups',{group_id:uid(70)})).status,400);assert.equal((await h.request('/learning',window,{id:'other',tenantId:TENANT_A})).status,403);
});
for(const mode of ['no_quiz','no_pin','small','manual','unmapped'])test(`${mode} gives explicit insufficient evidence instead of a learning zero`,async()=>{
  const h=harness();if(mode==='no_quiz')h.state.bindings[LESSON_1].activity=[];if(mode==='no_pin')h.state.pin=null;if(mode==='small')h.s.attempts=4;if(mode==='manual')h.s.manual=true;if(mode==='unmapped')h.s.tags=[];
  const r=await h.request();assert.equal(r.status,200);assert.equal(r.body.state,'insufficient');assert.deepEqual(r.body.suggestions,[]);assert.equal(h.state.audits,0);
  if(mode==='no_quiz'||mode==='no_pin')assert.equal(r.body.graded_attempts,null);
});
for(const mode of ['schema','question_bound','attempt_bound','wrong_context','missing_answer','duplicate_answer','foreign_group','foreign_audience'])test(`${mode} refuses incomplete or mismatched evidence without partial results`,async()=>{
  const h=harness();if(mode==='schema')h.s.schema=false;if(mode==='question_bound')h.s.questions=201;if(mode==='attempt_bound')h.s.attempts=101;if(mode==='wrong_context')h.s.wrongContext=true;if(mode==='missing_answer')h.s.missingAnswer=true;if(mode==='duplicate_answer')h.s.duplicate=true;if(mode==='foreign_group')h.s.group=false;if(mode==='foreign_audience')h.state.quizGroups=[{id:uid(71),exam_id:uid(40),course_id:COURSE_A1,branch_scope:'tenant',branch_id:null}];
  const r=await h.request();assert.ok([403,404,500,503].includes(r.status));assert.equal(r.body.suggestions,undefined);assert.equal(h.state.audits,0);
});
test('summary thresholds, ranking, overlap and manual-answer rejection are deterministic',()=>{
  const questions=[{id:uid(1),position:1,type:'single_choice',tags:['b','a'],text:'first'},{id:uid(2),position:2,type:'single_choice',tags:['c'],text:'second'}];
  const attempts=Array.from({length:5},(_,i)=>uid(i+100));const answers=attempts.flatMap((attempt_id,i)=>questions.map(q=>({attempt_id,question_ref:q.id,question_type:q.type,is_correct:q.id===uid(2)?i>2:i>1,manual_review:0})));
  const r=summarizeLearning(questions,attempts,answers);assert.deepEqual(r.suggestions.map(s=>s.tag),['c','a']);assert.equal(r.suggestions[0].not_fully_correct,3);
  assert.throws(()=>summarizeLearning(questions,attempts,[...answers,{...answers[0],manual_review:1}]));assert.throws(()=>summarizeLearning(questions,attempts,answers.slice(1)));
});
