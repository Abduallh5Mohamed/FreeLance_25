import assert from 'node:assert/strict';
import {createCourseReturnPlanRouter,parseReturnInput} from '../../src/routes/course-return-plan';
import {fixture,uid} from './lesson-package-fixture';
import {makeReq,runChain,COURSE_A1,OWNER_A,TENANT_A} from './m2-course-lessons-harness';
import {readFileSync} from 'node:fs';
export const base=`/courses/${COURSE_A1}/return-plan`,from='2026-11-01T00:00:00.000Z',to='2026-11-07T00:00:00.000Z';
export const input=()=>({enrollment_id:'enrollment-one',from,to,steps:[] as {lesson_id:string;minutes:number|null}[]});
const tables={attendance_records:['id','tenant_id','session_id','student_id','state'],schedule_sessions:['id','tenant_id','group_id','audience','title','starts_at','ends_at','status'],course_lesson_completions:['id','student_enrollment_id','lesson_id','completed_at']};
const ddl=readFileSync(new URL('../../migrations/20261107_01_course_return_plans.sql',import.meta.url),'utf8'),storageColumns:any[]=[];
for(const t of ddl.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\) ENGINE=/g))for(const line of t[2].split('\n')){const m=/^\s+(\w+) (CHAR|VARCHAR|INT|DATETIME|TIMESTAMP|JSON|ENUM)(\([^)]*\))? NOT NULL/.exec(line);if(m)storageColumns.push({table_name:t[1],column_name:m[1],data_type:m[2].toLowerCase(),column_type:(m[2]+(m[3]??'')).toLowerCase(),is_nullable:'NO',max_length:['CHAR','VARCHAR'].includes(m[2])?Number(m[3]?.slice(1,-1)):null,collation_name:['CHAR','VARCHAR'].includes(m[2])?'utf8mb4_bin':null});}
const storageIndexes=[['course_return_plans','ix_return_plan_student',['tenant_id','enrollment_id','status','id']],['course_return_plans','PRIMARY',['id']],['course_return_plans','uq_return_plan_scope',['tenant_id','course_id','enrollment_id']],['course_return_plan_revisions','PRIMARY',['plan_id','version']],['course_return_plan_operations','PRIMARY',['tenant_id','operation_id']]] as const;
export function harness(options:{persistence?:boolean}={},routerFactory=createCourseReturnPlanRouter){
 const s={persistence:!!options.persistence,badStorage:false,storageIndexes:true,storageKeys:true,fail:'',studentActive:true,enrolled:true,published:true,schema:true,owner:true,proof:true,attendanceState:'excused',sessions:1,lessons:4,completed:false,locked:false,students:1,sql:[] as string[],cleanupFail:false,disposed:[] as string[]};
 const h=fixture({},deps=>routerFactory({getConnection:async()=>{const conn=await deps.getConnection();return{...conn,execute:async(sql:string,p:any[]=[])=>{
  const q=sql.replace(/\s+/g,' ').trim();s.sql.push(q);assert.match(q,s.persistence?/^(SELECT|INSERT|UPDATE) /:/^SELECT /);if(s.fail&&q.startsWith(s.fail))throw Error('Synthetic return-plan failure');
  if(p[0]==='course_return_plans'&&q.includes('information_schema.COLUMNS'))return[s.persistence?storageColumns.map(r=>s.badStorage?{...r,data_type:'varchar',max_length:1,is_nullable:'YES'}:r):[],[]];
  if(p[0]==='course_return_plans'&&q.includes('information_schema.TABLES'))return[['course_return_plans','course_return_plan_revisions','course_return_plan_operations'].map(table_name=>({table_name,engine:'InnoDB'})),[]];
  if(p[0]==='course_return_plans'&&q.includes('information_schema.STATISTICS'))return[s.storageIndexes?storageIndexes.flatMap(([table_name,index_name,columns])=>columns.map((column_name,i)=>({table_name,index_name,column_name,seq_in_index:i+1,non_unique:index_name==='ix_return_plan_student'?1:0}))):[],[]];
  if(q.includes('information_schema.KEY_COLUMN_USAGE')&&q.includes("k.TABLE_NAME='course_return_plan_revisions'"))return[s.storageKeys?[{column_name:'plan_id',referenced_table:'course_return_plans',referenced_column:'id',delete_rule:'RESTRICT'}]:[],[]];
  if(q.startsWith('SELECT id,version,status FROM course_return_plans'))return[h.state.returnHeads.filter(r=>r.tenant_id===p[0]&&r.course_id===p[1]&&r.enrollment_id===p[2]),[]];
  if(q.startsWith('SELECT actor_user_id,course_id,enrollment_id,request_hash'))return[h.state.returnOperations.filter(r=>r.tenant_id===p[0]&&r.operation_id===p[1]),[]];
  if(q.startsWith('INSERT INTO course_return_plans')){h.state.returnHeads.push(Object.fromEntries(['id','tenant_id','course_id','enrollment_id','version','status'].map((key,i)=>[key,p[i]])));return[{affectedRows:1},[]];}
  if(q.startsWith('UPDATE course_return_plans SET')){const r=h.state.returnHeads.find(r=>r.id===p[2]&&r.tenant_id===p[3]&&r.course_id===p[4]&&r.enrollment_id===p[5]&&r.version===p[6]);if(!r)return[{affectedRows:0},[]];r.version=p[0];r.status=p[1];return[{affectedRows:1},[]];}
  if(q.startsWith('INSERT INTO course_return_plan_revisions')){h.state.returnRevisions.push(Object.fromEntries(['plan_id','version','actor_user_id','from_at','to_at','steps','status'].map((key,i)=>[key,p[i]])));return[{affectedRows:1},[]];}
  if(q.startsWith('INSERT INTO course_return_plan_operations')){h.state.returnOperations.push(Object.fromEntries(['tenant_id','operation_id','actor_user_id','course_id','enrollment_id','request_hash','plan_id','version','status'].map((key,i)=>[key,p[i]])));return[{affectedRows:1},[]];}
  if(q.startsWith('SELECT DATE_FORMAT(from_at'))return[h.state.returnRevisions.filter(r=>r.plan_id===p[0]&&r.version===p[1]).map(r=>({from_at:r.from_at.replace(' ','T')+'.000Z',to_at:r.to_at.replace(' ','T')+'.000Z'})),[]];
  if(q.startsWith('SELECT id,course_id,version,status FROM course_return_plans'))return[h.state.returnHeads.filter(r=>r.tenant_id===p[0]&&r.enrollment_id===p[1]&&r.status==='active'&&r.id>p[2]).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,6),[]];
  if(q.startsWith('SELECT status,steps FROM course_return_plan_revisions'))return[h.state.returnRevisions.filter(r=>r.plan_id===p[0]&&r.version===p[1]),[]];
  if(q.startsWith('SELECT id,is_active,token_version,'))return[[{id:'student-one',is_active:s.studentActive?1:0,token_version:0,suspension_active:0}],[]];
  if(q.startsWith('SELECT g.id,g.course_id,c.tenant_id,'))return[[{id:uid(70),course_id:COURSE_A1,tenant_id:TENANT_A,branch_scope:'tenant',branch_id:null,instructor_id:null}],[]];
  if(q.includes('information_schema.TABLES')&&q.includes("'students','student_courses','course_lesson_completions'"))return[['students','student_courses','course_lesson_completions','groups','branches','branch_memberships'].map(table_name=>({table_name,engine:'InnoDB'})),[]];
  if(q.startsWith('SELECT EXISTS(SELECT 1 FROM course_lesson_completions'))return[[{completed:s.completed?1:0}],[]];
  if(!s.owner&&q.startsWith('SELECT u.id AS teaching_user_id'))return[[],[]];
  if(q.startsWith('SELECT s.id AS enrollment_id,s.user_id,u.name')){
   assert.deepEqual(p.slice(0,2),[TENANT_A,COURSE_A1]);assert.match(q,/sc.status='active'/);assert.match(q,/s.approval_status='approved'/);assert.match(q,/u.suspended_until/);
   if(!s.enrolled)return[[],[]];return[Array.from({length:s.students},(_,i)=>({enrollment_id:i?'enrollment-'+i:'enrollment-one',user_id:'student-one',name:'Synthetic student',group_id:uid(70),branch_scope:'tenant',branch_id:null})),[]];
  }
  if(q.startsWith('SELECT s.id AS enrollment_id,s.tenant_id')){assert.deepEqual(p,['enrollment-one','student-one',TENANT_A]);return[s.enrolled?[{enrollment_id:'enrollment-one',tenant_id:TENANT_A}]:[],[]];}
  if(q.startsWith('SELECT sc.id AS student_course_id'))return[s.enrolled?[{student_course_id:uid(80)}]:[],[]];
  if(q.startsWith('SELECT c.id AS course_id,c.name')){assert.match(q,/publication_state='published'/);return[s.published?[{course_id:COURSE_A1,name:'Synthetic course'}]:[],[]];}
  if(q.includes('information_schema.COLUMNS')&&q.includes("'attendance_records'"))return[s.schema?Object.entries(tables).flatMap(([table_name,cols])=>cols.map(column_name=>({table_name,column_name}))):[],[]];
  if(q.includes('information_schema.TABLES')&&q.endsWith('LIMIT 3'))return[Object.keys(tables).map(table_name=>({table_name,engine:'InnoDB'})),[]];
  if(q.startsWith('SELECT ss.id AS session_id')){
   assert.deepEqual(p,['enrollment-one',TENANT_A,uid(70),'2026-11-01 00:00:00','2026-11-07 00:00:00']);assert.match(q,/ss.status='scheduled'/);assert.match(q,/ss.ends_at<=UTC_TIMESTAMP\(\)/);assert.match(q,/a.tenant_id=ss.tenant_id/);assert.match(q,/ss.audience='group'/);
   return[Array.from({length:s.sessions},(_,i)=>({session_id:uid(100+i),title:'Group session',starts_at:'2026-11-02T10:00:00.000Z',record_id:s.attendanceState==='unrecorded'?null:uid(300+i),state:s.attendanceState==='unrecorded'?null:s.attendanceState})),[]];
  }
  if(q.startsWith('SELECT l.id AS lesson_id,l.title,u.id AS unit_id')){
   assert.deepEqual(p,['enrollment-one','enrollment-one',COURSE_A1]);assert.match(q,/course_lesson_completions/);assert.doesNotMatch(q,/\bFROM lesson_completions\b/);assert.match(q,/UNIX_TIMESTAMP\(\)/);
   return[Array.from({length:s.lessons},(_,i)=>({lesson_id:uid(10+i),unit_id:uid(50),title:'Lesson '+i,is_released:s.locked?0:1,prerequisite_met:1,completed:s.completed?1:0})),[]];
  }
  if(q.startsWith('SELECT l.id,l.prerequisite_lesson_id,l.title'))return[[{id:p[1],prerequisite_lesson_id:null,title:'Lesson',is_released:s.proof?1:0,is_prerequisite_met:1}],[]];
  return conn.execute(sql,p);
 },commit:async()=>{if(!s.persistence)throw Error('Return draft must never commit');await conn.commit();},rollback:async()=>{await conn.rollback();if(s.cleanupFail)throw Error('cleanup');},release:()=>{s.disposed.push('release');conn.release();},destroy:()=>{s.disposed.push('destroy');conn.destroy();}};}}));
 const request=async(suffix='/preview',body:any=input(),extra:any={})=>{const get=suffix.startsWith('/students')||suffix.startsWith('/operations/')||suffix.startsWith('/follow-up/');const req:any=makeReq({method:get?'GET':'POST',pathName:base+suffix,body:get?{}:body,query:extra.query??{},headers:extra.headers??{}});req.user=extra.user??{id:OWNER_A,tenantId:TENANT_A,role:'instructor'};const r=await runChain([h.router],req);await new Promise(resolve=>setImmediate(resolve));return r;};
 return{...h,s,request};
}
