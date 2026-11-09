// Real authenticated HTTP + real isolated MySQL, synthetic data only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {connect}=require('./demo-db.cjs');
const id=()=>crypto.randomUUID();
async function main(){
 const {c,pub,database}=await connect();const results=[];const manifestPath=path.join(__dirname,'build43-grading-fixtures.json');
 try{
  const accounts=JSON.parse(fs.readFileSync(path.join(pub.privateDir,'accounts.json'),'utf8'));
  const instructor=accounts.find(a=>a.role==='instructor'),teacher=accounts.find(a=>a.role==='teacher');
  const [[scope]]=await c.execute('SELECT c.id AS course_id,c.tenant_id,s.id AS enrollment_id,s.user_id AS student_user_id FROM courses c JOIN students s ON s.tenant_id=c.tenant_id WHERE c.instructor_id=? LIMIT 1',[instructor.id]);assert.ok(scope);
  let fixtures=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):null;
  if(!fixtures){
   fixtures={database,verification:null,interactive:null};await c.beginTransaction();
   try{for(const key of ['verification','interactive']){
    const f={exam:id(),version:id(),question:id(),mcq:id(),attempt:id(),operation:id(),finalize:id()};fixtures[key]=f;
    await c.execute('INSERT INTO exams (id,title,course_id,total_marks,passing_marks,is_active,is_published) VALUES (?,?,?,10,5,1,1)',[f.exam,key==='interactive'?'تجربة التصحيح بالسؤال — جاهز للتجربة':'تحقق آلي محلي للتصحيح',scope.course_id]);
    await c.execute("INSERT INTO exam_versions (id,exam_id,tenant_id,version,status,total_points,passing_points,published_at,created_by) VALUES (?,?,?,1,'published',10,5,UTC_TIMESTAMP(),?)",[f.version,f.exam,scope.tenant_id,instructor.id]);
    await c.execute("INSERT INTO exam_version_questions (id,exam_version_id,tenant_id,position,question_type,question_text,points,explanation) VALUES (?,?,?,1,'essay',?,8,?)",[f.question,f.version,scope.tenant_id,'اشرح لماذا مجموع زوايا المثلث يساوي 180 درجة.','اقرأ استدلال الطالب. هذا شرح تجريبي للسؤال وليس معيار تصحيح رسميًا.']);
    await c.execute("INSERT INTO exam_version_questions (id,exam_version_id,tenant_id,position,question_type,question_text,points) VALUES (?,?,?,2,'single_choice',?,2)",[f.mcq,f.version,scope.tenant_id,'سؤال آلي تجريبي محسوب بدرجتين']);
    await c.execute("INSERT INTO exam_versioned_attempts (id,tenant_id,exam_id,exam_version_id,student_enrollment_id,student_user_id,status,started_at,deadline_at,submitted_at,auto_score,manual_required,version) VALUES (?,?,?,?,?,?,'pending_review',UTC_TIMESTAMP(),UTC_TIMESTAMP(),UTC_TIMESTAMP(),2,1,0)",[f.attempt,scope.tenant_id,f.exam,f.version,scope.enrollment_id,scope.student_user_id]);
    for(const [question,type,response,award,manual] of [[f.question,'essay','أرسم خطًا موازيًا لأحد أضلاع المثلث ثم أستخدم الزوايا المتبادلة على مستقيم.',null,1],[f.mcq,'single_choice',['A'],'2.00',0]])await c.execute('INSERT INTO exam_versioned_answers (id,tenant_id,attempt_id,exam_version_id,question_ref,question_type,response,awarded_points,manual_review) VALUES (?,?,?,?,?,?,?,?,?)',[id(),scope.tenant_id,f.attempt,f.version,question,type,JSON.stringify(response),award,manual]);
   }await c.commit();fs.writeFileSync(manifestPath,JSON.stringify(fixtures,null,2),{flag:'wx'});}catch(e){await c.rollback();throw e;}
  }assert.equal(fixtures.database,database);
  async function login(a){const r=await fetch('http://127.0.0.1:8081/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:a.phone,password:a.password}),signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);const b=await r.json();assert.ok(b.token);return b.token;}
  const token=await login(instructor),foreign=await login(teacher),student=await login(accounts.find(a=>a.role==='student'));
  const base='http://127.0.0.1:8081/api/tenants/me/catalog/grading';
  async function api(p,body,auth=token){const r=await fetch(base+p,{headers:{Authorization:'Bearer '+auth,...body?{'Content-Type':'application/json'}:{}},...body?{method:'POST',body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(20000)});const b=await r.json();if(auth===token)assert.equal(r.headers.get('cache-control'),'no-store');return{status:r.status,body:b};}
  const f=fixtures.verification;
  assert.equal((await api('/exams')).status,200);assert.equal((await api('/exams/'+f.exam+'/versions')).status,200);assert.equal((await api('/versions/'+f.version+'/questions')).status,200);
  const studentDenial=await api('/exams',null,student),foreignDenial=await api('/attempts/'+f.attempt+'/review',null,foreign);console.log(JSON.stringify({studentDenial:studentDenial.status,foreignDenial:foreignDenial.status}));assert.ok([403,409].includes(studentDenial.status));assert.equal(foreignDenial.status,404);results.push({check:'discovery and tenant/student denial',pass:true,studentStatus:studentDenial.status,foreignStatus:foreignDenial.status});
  const page=await api('/questions/'+fixtures.interactive.question+'/answers');assert.equal(page.status,200);assert.equal(page.body.answers.length,1);assert.equal(page.body.answers[0].revision,null);assert.ok(!/student_user_id|student_name|correct_answers/.test(JSON.stringify(page.body)));results.push({check:'interactive anonymous answer remains available',pass:true});
  // This verification fixture is intentionally separate from the user's demo.
  const first={operation_id:f.operation,expected_version:0,question_ref:f.question,points:'6.50',feedback:'Synthetic verification feedback'};
  const existing=await api('/operations/'+f.operation);
  if(existing.body.operation===null){
   const race=await Promise.all([api('/attempts/'+f.attempt+'/grade',first),api('/attempts/'+f.attempt+'/grade',{...first,operation_id:id(),points:'7.00'})]);
   assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);assert.equal(race[0].status,201);results.push({check:'real MySQL version CAS: one accepted, one conflict',pass:true});
  }
  const replay=await api('/attempts/'+f.attempt+'/grade',first);assert.equal(replay.status,200);assert.equal(replay.body.operation.awarded_points,'6.50');
  assert.equal((await api('/attempts/'+f.attempt+'/grade',{...first,points:'8.00'})).status,409);
  const recovered=await api('/operations/'+f.operation);assert.equal(recovered.body.operation.attempt_version,1);results.push({check:'durable receipt, matching replay and changed-payload refusal',pass:true});
  const finalReceipt=await api('/operations/'+f.finalize);
  if(!finalReceipt.body.operation){const review=await api('/attempts/'+f.attempt+'/review');assert.equal(review.status,200);assert.equal(review.body.complete,true);assert.equal(review.body.score,'8.50');const done=await api('/attempts/'+f.attempt+'/finalize',{operation_id:f.finalize,expected_version:review.body.version,review_token:review.body.review_token});assert.equal(done.status,201);assert.equal(done.body.operation.gradebook_linked,true);}
  const [[facts]]=await c.execute('SELECT a.status,a.version,a.score,(SELECT COUNT(*) FROM exam_manual_answer_revisions r WHERE r.attempt_id=a.id) AS revisions,(SELECT COUNT(*) FROM gradebook_scores g WHERE g.item_id=a.exam_id AND g.tenant_id=a.tenant_id) AS gradebook,(SELECT COUNT(*) FROM exam_manual_operations o WHERE o.attempt_id=a.id AND o.tenant_id=a.tenant_id) AS receipts FROM exam_versioned_attempts a WHERE a.id=?',[f.attempt]);
  assert.equal(facts.status,'graded');assert.equal(facts.version,2);assert.equal(facts.score,'8.50');assert.equal(facts.revisions,1);assert.equal(facts.gradebook,1);assert.equal(facts.receipts,2);results.push({check:'final score 8.50, single revision/projection and two receipts persisted',pass:true});
  const {verifyAuditChain}=require('../server/src/services/audit-log.ts');const chain=await verifyAuditChain({query:async(sql,p=[])=>{const [rows]=await c.execute(sql,p);return rows;}});assert.equal(chain.ok,true);results.push({check:'real sealed audit chain verifies',pass:true});
  const [plan]=await c.execute('EXPLAIN SELECT id FROM exam_versioned_attempts WHERE tenant_id=? AND exam_version_id=? AND status=? AND id>? ORDER BY id LIMIT 11',[scope.tenant_id,fixtures.interactive.version,'pending_review','']);assert.ok(plan.some(r=>r.key==='idx_manual_question_queue'));results.push({check:'queue index selected on small fixture (not load acceptance)',pass:true});
  const report={database,checked_at:new Date().toISOString(),results,interactive:{route:'/manual-grading',examTitle:'تجربة التصحيح بالسؤال — جاهز للتجربة',ownerRole:'instructor',anonymousAnswers:1},limits:'Synthetic local fixture only; no browser/load/provider acceptance'};
  fs.writeFileSync(path.join(__dirname,'build43-grading-live-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({database,checks:results,interactive:report.interactive}));
 }finally{await c.end();}
}
main().catch(e=>{console.log(JSON.stringify({error:e.code||e.name||'DEMO_GRADING_FAILED',assertion:e.operator||null,locations:String(e.stack).split('\n').filter(s=>s.includes('verify-demo-grading.cjs')).slice(0,2)}));process.exitCode=1;});
