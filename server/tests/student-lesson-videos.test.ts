import assert from 'node:assert/strict';
import test from 'node:test';
import {listStudentLessonVideos,proveStudentCatalogVideo} from '../src/services/student-lesson-videos';
const id=(n:number)=>`f1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={userId:'student',tenantId:'tenant-a',enrollmentId:'enrollment'};
const principal={id:'student',role:'student',tenantId:'tenant-a',studentEnrollmentId:'enrollment',tokenVersion:0,identitySource:'users' as const};
const source=(n=1)=>({content_id:id(100+n),video_id:id(n),display_order:n-1,source_id:id(n),title:`Video ${n}`,status:'ready',is_encrypted:1,hls_key:'private-hls',original_key:'private-original',course_id:id(90),tenant_id:'tenant-a',legacy:false});
function fixture(){
 const s={active:true,suspended:false,tokenVersion:0,enrollment:true,course:true,lesson:true,released:true,prerequisite:true,schema:true,engine:'InnoDB',indexes:true,primary:true,
  groupRows:1,group:{id:id(80),course_id:id(90),tenant_id:'tenant-a',branch_id:null as string|null,branch_scope:'tenant',instructor_id:'teacher',resolved_branch_id:null as string|null,branch_tenant_id:'tenant-a',branch_status:'active',branch_version:1,member_user_id:'student',member_status:'active',member_role:'student',member_version:1},
  bindings:[source()],materials:[] as any[],calls:[] as string[]};
 const connection={execute:async(sql:string,p:any[]=[]):Promise<[any,any]>=>{
  const q=sql.replace(/\s+/g,' ').trim();s.calls.push(q);
  if(q.startsWith('SELECT id,is_active')){assert.deepEqual(p,['student']);return [[{id:'student',is_active:s.active?1:0,suspension_active:s.suspended?1:0,token_version:s.tokenVersion}],[]];}
  if(q.includes('FROM students s INNER JOIN tenants'))return [s.enrollment&&p[0]===scope.enrollmentId&&p[1]===scope.userId&&p[2]===scope.tenantId?[{enrollment_id:scope.enrollmentId,tenant_id:scope.tenantId}]:[],[]];
  if(q.startsWith('SELECT sc.id'))return [s.course&&p[0]===scope.enrollmentId&&p[1]===id(90)?[{student_course_id:'link'}]:[],[]];
  if(q.startsWith('SELECT c.id AS course_id'))return [s.course&&p[0]===id(90)&&p[1]===scope.tenantId?[{course_id:id(90),name:'Course'}]:[],[]];
  if(q.startsWith('SELECT l.id,l.prerequisite_lesson_id'))return [s.lesson&&p[1]===id(91)&&p[2]===id(90)?[{id:id(91),title:'Lesson',is_released:s.released?1:0,is_prerequisite_met:s.prerequisite?1:0}]:[],[]];
  if(q.includes('information_schema.COLUMNS'))return [s.schema?['id','lesson_id','video_id','display_order'].map(column_name=>({column_name})):[],[]];
  if(q.includes('information_schema.TABLES'))return [['course_lesson_videos','videos','course_lesson_contents','course_lessons','course_units','courses','tenants','users','audit_events','lectures','course_materials','students','student_courses','course_lesson_completions','groups','branches','branch_memberships'].map(table_name=>({table_name,engine:s.engine})),[]];
  if(q.includes("TABLE_NAME='videos'")&&q.includes('information_schema.STATISTICS'))return [s.primary?[{column_name:'id',seq_in_index:1}]:[],[]];
  if(q.includes('information_schema.STATISTICS'))return [s.indexes?['PRIMARY','uq_lesson_videos_source','uq_lesson_videos_order'].flatMap(index_name=>(index_name==='PRIMARY'?['id']:index_name==='uq_lesson_videos_source'?['lesson_id','video_id']:['lesson_id','display_order']).map((column_name,n)=>({index_name,column_name,seq_in_index:n+1,non_unique:0}))):[],[]];
  if(q.startsWith('SELECT g.id,g.course_id')){assert.deepEqual(p,['student','enrollment','student','tenant-a',id(90),'tenant-a']);assert.ok(q.endsWith('LIMIT 2'));return [Array.from({length:s.groupRows},()=>({...s.group})),[]];}
  if(q.startsWith('SELECT b.id AS content_id,b.video_id')){
   assert.ok(q.includes("v.status='ready' AND v.lecture_id IS NULL AND v.material_id IS NULL"));assert.ok(q.includes('NOT EXISTS (SELECT 1 FROM lectures'));assert.ok(q.includes('NOT EXISTS (SELECT 1 FROM course_materials'));assert.ok(q.endsWith('LIMIT 21'));assert.deepEqual(p,[id(90),'tenant-a',id(91)]);
   return [s.bindings.slice(0,21).map(row=>({...row,source_id:row.course_id===id(90)&&row.tenant_id==='tenant-a'&&row.status==='ready'&&!row.legacy?row.source_id:null})),[]];
  }
  if(q.startsWith('SELECT id,display_order'))return [s.materials,[]];
  throw Error('Unexpected SQL '+q);
 }};
 return {s,connection,read:()=>listStudentLessonVideos(connection as any,scope,id(90),id(91),principal),proof:(content=id(101),actor:any=principal)=>proveStudentCatalogVideo(connection as any,scope,id(90),id(91),content,actor)};
}
test('student video metadata is fixed, locator-free and explicitly requires a session; selected proof remains server-private',async()=>{
 const h=fixture(),result=await h.read();assert.equal(result.status,200);assert.deepEqual(result.body,{lesson_id:id(91),videos:[{content_id:id(101),title:'Video 1',display_order:0,playback_status:'session_required'}]});
 assert.ok(!JSON.stringify(result.body).includes('private-'));assert.ok(!JSON.stringify(result.body).includes('video_id'));assert.equal(result.commit,false);
 const proof=await h.proof();assert.equal(proof.ok,true);if(proof.ok){assert.equal(proof.video.video_id,id(1));assert.deepEqual(proof.scope,scope);assert.ok(!JSON.stringify(proof).includes('private-'));}
 assert.ok(!h.s.calls.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q)));assert.ok(!h.s.calls.some(q=>q.includes('FROM lectures WHERE')||q.includes('FROM video_sessions')));
});
for(const gate of ['active','suspended','tokenVersion','enrollment','course','lesson','released','prerequisite','schema','engine','indexes','primary'] as const)test(`student video ${gate} proof fails closed`,async()=>{
 const h=fixture();if(gate==='suspended')h.s.suspended=true;else if(gate==='tokenVersion')h.s.tokenVersion=1;else if(gate==='engine')h.s.engine='MyISAM';else h.s[gate]=false;
 const result=await h.proof();assert.equal(result.ok,false);assert.ok([404,409,503].includes(result.status));assert.ok(!('video'in result));
});
for(const denial of ['no-group','duplicate-group','foreign-course','foreign-tenant','unclassified','missing-branch','foreign-branch','inactive-branch','revoked-member','wrong-member','version'] as const)test(`student video ${denial} audience is denied`,async()=>{
 const h=fixture();let actor:any=principal;
 if(denial==='no-group')h.s.groupRows=0;else if(denial==='duplicate-group')h.s.groupRows=2;else if(denial==='foreign-course')h.s.group.course_id=id(99);else if(denial==='foreign-tenant')h.s.group.tenant_id='other';else if(denial==='unclassified')h.s.group.branch_scope='unassigned';
 else{Object.assign(h.s.group,{branch_scope:'branch',branch_id:id(81),resolved_branch_id:id(81)});actor={...principal,branchId:id(81),branchMembershipVersion:1};
  if(denial==='missing-branch')h.s.group.resolved_branch_id=null;if(denial==='foreign-branch')h.s.group.branch_tenant_id='other';if(denial==='inactive-branch')h.s.group.branch_status='archived';if(denial==='revoked-member')h.s.group.member_status='revoked';if(denial==='wrong-member')h.s.group.member_user_id='foreign';if(denial==='version')h.s.group.member_version=2;
 }
 assert.equal((await h.proof(id(101),actor)).ok,false);assert.ok(!h.s.calls.some(q=>q.startsWith('SELECT b.id AS content_id')));
});
test('student video branch member is accepted only through the existing live resource policy',async()=>{
 const h=fixture();Object.assign(h.s.group,{branch_scope:'branch',branch_id:id(81),resolved_branch_id:id(81)});assert.equal((await h.proof(id(101),{...principal,branchId:id(81),branchMembershipVersion:1})).ok,true);
});
for(const cause of ['course','tenant','legacy','not-ready','not-encrypted','missing-hls','original-hls'] as const)test(`student video source ${cause} is withheld`,async()=>{
 const h=fixture(),row=h.s.bindings[0];if(cause==='course')row.course_id=id(99);if(cause==='tenant')row.tenant_id='other';if(cause==='legacy')row.legacy=true;if(cause==='not-ready')row.status='processing';if(cause==='not-encrypted')row.is_encrypted=0;if(cause==='missing-hls')row.hls_key='';if(cause==='original-hls')row.hls_key=row.original_key;
 assert.deepEqual((await h.read()).body,{lesson_id:id(91),videos:[]});assert.equal((await h.proof()).ok,false);
});
test('fresh proof observes reference deletion, source withdrawal and enrollment revocation without a cached grant',async()=>{
 const h=fixture();assert.equal((await h.proof()).ok,true);h.s.bindings=[];assert.equal((await h.proof()).ok,false);h.s.bindings=[source()];h.s.bindings[0].tenant_id='foreign';assert.equal((await h.proof()).ok,false);h.s.bindings=[source()];h.s.enrollment=false;assert.equal((await h.proof()).ok,false);
});
test('proof rejects caller scope mismatch and foreign reference selectors before returning any source id',async()=>{
 const h=fixture();for(const actor of [{...principal,role:'admin'},{...principal,tenantId:'other'},{...principal,studentEnrollmentId:'other'},{...principal,id:'foreign'}])assert.equal((await h.proof(id(101),actor)).ok,false);
 assert.equal(h.s.calls.length,0);assert.equal((await h.proof('bad')).ok,false);assert.equal(h.s.calls.length,0);assert.equal((await h.proof(id(199))).ok,false);
});
test('bounded video proof is batched at twenty, rejects overflow/shared positions and corrupt metadata',async()=>{
 const h=fixture();await h.read();const one=h.s.calls.length;h.s.calls=[];h.s.bindings=Array.from({length:20},(_,n)=>source(n+1));assert.equal((await h.read()).body.videos.length,20);assert.equal(h.s.calls.length,one);
 h.s.bindings.push(source(21));assert.equal((await h.proof()).ok,false);h.s.bindings=[source()];h.s.materials=[{id:id(300),display_order:0}];assert.equal((await h.proof()).ok,false);
 h.s.materials=[];h.s.bindings[0].title=42 as any;assert.equal((await h.proof()).ok,false);
});
