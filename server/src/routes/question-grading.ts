import {Router} from 'express';
import {proveGradingAssignment,assignedRubricPoints,type GradingAssignmentScope} from '../services/grading-delegation';
import {createHash} from 'crypto';
import type {AuthRequest} from '../middleware/auth';
import type {CourseLessonConnection} from './course-lessons';
import {proveGradingIdentity,proveGradingAttempt,GradingAuthorityDenied} from '../services/grading-authority';
import {createBoundExamManualGradingSqlStore,type ExamGradingSqlConnection} from '../services/exam-manual-grading-sql';
import {planManualAnswerGrade,planAttemptFinalize,normalizeAttemptVersion,type ManualGradingAttemptBundle} from '../services/exam-manual-grading';
import {formatHundredths,toHundredths} from '../services/exam-grading';
import {recordSealedAuditEvent} from '../services/audit-log';

const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact=(x:unknown,keys:string[]):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const text=(x:unknown,max:number):x is string=>typeof x==='string'&&!!x.trim()&&x.length<=max;
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
class Refusal extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
function refuse(status:number,code:string):never{throw new Refusal(status,code);}
export interface GradingReceipt {operation_id:string;attempt_id:string;kind:'grade'|'finalize';attempt_version:number;question_ref:string|null;revision:number|null;awarded_points:string|null;score:string|null;gradebook_linked:boolean|null}
function receipt(raw:unknown):GradingReceipt{
    const r=typeof raw==='string'?JSON.parse(raw):raw;
    if(!exact(r,['operation_id','attempt_id','kind','attempt_version','question_ref','revision','awarded_points','score','gradebook_linked'])||!uuid(r.operation_id)||!uuid(r.attempt_id)
        ||!Number.isSafeInteger(r.attempt_version)||(r.attempt_version as number)<1||!['grade','finalize'].includes(r.kind as string))throw Error('Invalid grade receipt');
    if(r.kind==='grade'? !uuid(r.question_ref)||!Number.isInteger(r.revision)||(r.revision as number)<1||typeof r.awarded_points!=='string'||toHundredths(r.awarded_points)===null||r.score!==null||r.gradebook_linked!==null
        :r.question_ref!==null||r.revision!==null||r.awarded_points!==null||typeof r.score!=='string'||toHundredths(r.score)===null||typeof r.gradebook_linked!=='boolean')throw Error('Invalid grade receipt');
    return r as unknown as GradingReceipt;
}
const coreTables=['exam_versioned_attempts','exam_versioned_answers','exam_versions','exam_version_questions','exam_manual_answer_revisions','exam_manual_operations','audit_events','audit_chain_head'];
async function schema(c:ExamGradingSqlConnection){
    const tables=await c.query<{table_name:string;engine:string}>(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${coreTables.map(()=>'?').join(',')}) LIMIT 8`,coreTables);
    if(!coreTables.every(t=>tables.some(r=>r.table_name===t&&r.engine==='InnoDB')))refuse(503,'QUESTION_GRADING_UNAVAILABLE');
    const columns=await c.query<{column_name:string;data_type:string}>(`SELECT COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exam_manual_operations' LIMIT 10`);
    if(!['tenant_id','operation_id','actor_user_id','attempt_id','request_hash','result','created_at'].every(n=>columns.some(r=>r.column_name===n))||!columns.some(r=>r.column_name==='result'&&r.data_type==='json'))refuse(503,'QUESTION_GRADING_UNAVAILABLE');
    const index=await c.query<{column_name:string;seq:number}>(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exam_manual_operations' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX LIMIT 3`);
    if(index.length!==2||!['tenant_id','operation_id'].every((n,i)=>index[i].column_name===n&&Number(index[i].seq)===i+1))refuse(503,'QUESTION_GRADING_UNAVAILABLE');
    const queueIndex=await c.query<{column_name:string;seq:number}>(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exam_versioned_attempts' AND INDEX_NAME='idx_manual_question_queue' ORDER BY SEQ_IN_INDEX LIMIT 5`);
    if(queueIndex.length!==4||!['tenant_id','exam_version_id','status','id'].every((n,i)=>queueIndex[i].column_name===n&&Number(queueIndex[i].seq)===i+1))refuse(503,'QUESTION_GRADING_UNAVAILABLE');
    const unique=await c.query<{table_name:string;index_name:string;column_name:string;seq:number}>(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('exam_manual_answer_revisions','exam_versioned_answers') AND NON_UNIQUE=0 LIMIT 40`);
    for(const [table,names] of [['exam_manual_answer_revisions',['attempt_id','question_ref','revision']],['exam_versioned_answers',['attempt_id','question_ref']]] as const){
        if(!unique.some(first=>first.table_name===table&&Number(first.seq)===1&&(()=>{const rows=unique.filter(r=>r.table_name===table&&r.index_name===first.index_name).sort((a,b)=>Number(a.seq)-Number(b.seq));return rows.length===names.length&&names.every((n,i)=>rows[i].column_name===n&&Number(rows[i].seq)===i+1);})()))refuse(503,'QUESTION_GRADING_UNAVAILABLE');
    }
}
function wrap(c:CourseLessonConnection):ExamGradingSqlConnection{return{
    query:async<T>(sql:string,p:readonly unknown[]=[])=>{const [r]=await c.execute(sql,[...p]);if(!Array.isArray(r))throw Error('Invalid rows');return r as T[];},
    execute:async(sql,p=[])=>{const [r]=await c.execute(sql,[...p]);return r;},
};}
function finalPlan(bundle:ManualGradingAttemptBundle){return planAttemptFinalize({attemptStatus:bundle.attempt.status,autoScore:bundle.attempt.auto_score,questions:bundle.questions,answers:bundle.answers,latestRevisions:bundle.latestRevisions,passingPoints:bundle.attempt.passing_points});}
function reviewToken(bundle:ManualGradingAttemptBundle){const plan=finalPlan(bundle);return plan.ok?hash([bundle.attempt.id,bundle.attempt.version,plan.plan.score,bundle.latestRevisions.map(r=>[r.question_ref,r.revision,r.awarded_hundredths]).sort()]):null;}

export function createQuestionGradingRouter(deps:{getConnection():Promise<CourseLessonConnection>;now?:()=>Date;assignmentId?:string}){
 const router=Router(),base=deps.assignmentId?'':'/grading';
 const sqlNow=()=>(deps.now??(()=>new Date()))().toISOString().slice(0,19).replace('T',' ');
 const handle=async(req:AuthRequest,res:any)=>{
  res.set('Cache-Control','no-store');
  if(!req.user)return res.status(401).json({code:'SESSION_REQUIRED'});
  if(!['teacher','instructor'].includes(req.user.role)||req.user.identitySource==='staff'||req.user.billingOnly||req.impersonation||req.headers['x-impersonation']!==undefined)return res.status(403).json({code:'GRADING_TEACHER_REQUIRED'});
  const tenantId=req.user.tenantId,userId=req.user.id;if(!tenantId)return res.status(404).json({code:'GRADING_NOT_FOUND'});
  const writing=req.method==='POST',kind=req.url.split('?')[0].endsWith('/finalize')?'finalize':'grade',recovery=!!req.params.operationId;
  if(Object.values(req.params).filter(v=>v!==undefined).some(v=>!uuid(v))||Object.keys(req.query).some(k=>k!=='after')||req.query.after!==undefined&&!uuid(req.query.after)
      ||['x-tenant-id','x-instructor-id','x-student-id'].some(k=>req.headers[k]!==undefined)||writing&&Object.keys(req.query).length)return res.status(400).json({code:'GRADING_INPUT'});
  const body=req.body;
  if(deps.assignmentId&&(writing&&kind!=='grade'||!writing&&!recovery&&!req.params.questionRef))return res.status(404).json({code:'GRADING_ASSIGNMENT_ONLY'});
  const gradeKeys=deps.assignmentId?['operation_id','expected_version','question_ref','assignment_version','marks','feedback']:['operation_id','expected_version','question_ref','points','feedback'];
  if(writing&&(!exact(body,kind==='grade'?gradeKeys:['operation_id','expected_version','review_token'])||!uuid(body.operation_id)||!Number.isSafeInteger(body.expected_version)||(body.expected_version as number)<0
      ||kind==='grade'&&(!uuid(body.question_ref)||(deps.assignmentId? !Number.isSafeInteger(body.assignment_version)||!Array.isArray(body.marks)||body.marks.length>20 : typeof body.points!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(body.points)||toHundredths(body.points)===null)||body.feedback!==null&&(typeof body.feedback!=='string'||body.feedback.length>2000))
      ||kind==='finalize'&&(typeof body.review_token!=='string'||!/^[a-f\d]{64}$/.test(body.review_token))))return res.status(400).json({code:'GRADING_INPUT'});
  if(!writing&&body!=null&&(!exact(body,[])))return res.status(400).json({code:'GRADING_INPUT'});
  let connection:CourseLessonConnection|null=null,open=false,commitAttempted=false,discard=false;
  try{
   connection=await deps.getConnection();await connection.beginTransaction();open=true;const c=wrap(connection);
   await proveGradingIdentity(c,req.user);
   const assigned=deps.assignmentId?await proveGradingAssignment(c,req.user,deps.assignmentId):null;
   const responsibleId=assigned?.teacherId??userId;
   let marks:ReturnType<typeof assignedRubricPoints>|null=null;
   if(assigned){if(req.params.questionRef&&req.params.questionRef!==assigned.questionRef||writing&&body.question_ref!==assigned.questionRef)refuse(404,'GRADING_NOT_FOUND');if(writing){try{marks=assignedRubricPoints(assigned,body);}catch(e){if(e instanceof GradingAuthorityDenied)throw e;refuse(400,'GRADING_RUBRIC_INPUT');}body.points=marks!.points;}}
   await schema(c);
   const audit=async(input:Parameters<typeof recordSealedAuditEvent>[1])=>recordSealedAuditEvent({query:(sql,p)=>c.query(sql,p),queryOne:async<T>(sql:string,p?:unknown[]):Promise<T|null>=>(await c.query<T>(sql,p))[0]??null,execute:async(sql,p)=>{const r=await c.execute(sql,p);return{affectedRows:Number(r.affectedRows),insertId:r.insertId===undefined?undefined:Number(r.insertId)};}},input);
   const store=createBoundExamManualGradingSqlStore(c,{transaction:async fn=>fn(c),audit:async(_conn,input)=>audit(input)});
   const operationId=writing?String(body.operation_id).toLowerCase():req.params.operationId?.toLowerCase();
   const requestHash=writing?hash([...(assigned?[assigned.id,assigned.version,assigned.rubricId,marks?.marks]:[]),kind,req.params.attemptId.toLowerCase(),kind==='grade'?{question_ref:String(body.question_ref).toLowerCase(),expected_version:body.expected_version,points:formatHundredths(toHundredths(body.points)!),feedback:typeof body.feedback==='string'?body.feedback.trim()||null:null}:{expected_version:body.expected_version,review_token:body.review_token}]):null;
   if(operationId){
    const ops=await c.query<{actor_user_id:string;attempt_id:string;request_hash:string;result:unknown}>('SELECT actor_user_id,attempt_id,request_hash,result FROM exam_manual_operations WHERE tenant_id=? AND operation_id=? LIMIT 1',[tenantId,operationId]);
    if(ops.length){const op=ops[0];await proveGradingAttempt(c,{...req.user,id:responsibleId},op.attempt_id);if(op.actor_user_id!==userId)refuse(recovery?404:409,'GRADING_OPERATION_CONFLICT');if(writing&&(op.attempt_id.toLowerCase()!==req.params.attemptId.toLowerCase()||op.request_hash!==requestHash))refuse(409,'GRADING_OPERATION_CONFLICT');const r=receipt(op.result);if(assigned&&(r.kind!=='grade'||r.question_ref!==assigned.questionRef))refuse(404,'GRADING_NOT_FOUND');if(r.operation_id!==operationId||r.attempt_id!==op.attempt_id)throw Error('Mismatched receipt');return res.json({operation:r});}
    if(recovery)return res.json({operation:null});
   }
   const after=typeof req.query.after==='string'?req.query.after:'';
   if(!writing&&!req.params.attemptId){
    if(!req.params.examId&&!req.params.versionId&&!req.params.questionRef){
     const rows=await c.query<{id:string;label:string}>(`SELECT e.id,e.title AS label FROM exams e JOIN courses c ON c.id=e.course_id WHERE c.tenant_id=? AND c.is_active=1 AND c.instructor_id=? AND e.id>? ORDER BY e.id LIMIT 26`,[tenantId,responsibleId,after]);
     return res.json(picker(rows,25));
    }
    if(req.params.examId){
     const rows=await c.query<{id:string;label:string}>(`SELECT v.id,CONCAT('Version ',v.version) AS label FROM exam_versions v JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id WHERE v.exam_id=? AND v.tenant_id=? AND c.tenant_id=? AND c.is_active=1 AND c.instructor_id=? AND v.status='published' AND v.id>? ORDER BY v.id LIMIT 26`,[req.params.examId,tenantId,tenantId,responsibleId,after]);
     return res.json(picker(rows,25));
    }
    if(req.params.versionId){
     const rows=await c.query<{id:string;label:string}>(`SELECT q.id,LEFT(q.question_text,180) AS label FROM exam_version_questions q JOIN exam_versions v ON v.id=q.exam_version_id AND v.tenant_id=q.tenant_id JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id WHERE q.exam_version_id=? AND q.tenant_id=? AND c.tenant_id=? AND c.is_active=1 AND c.instructor_id=? AND v.status='published' AND q.question_type='essay' ORDER BY q.position,q.id LIMIT 101`,[req.params.versionId,tenantId,tenantId,responsibleId]);
     if(rows.length>100)refuse(503,'GRADING_READ_CAP');return res.json(picker(rows,100));
    }
    const questions=await c.query<{id:string;version_id:string;text:string;points:string;explanation:string|null}>(`SELECT q.id,q.exam_version_id AS version_id,q.question_text AS text,q.points,q.explanation FROM exam_version_questions q JOIN exam_versions v ON v.id=q.exam_version_id AND v.tenant_id=q.tenant_id JOIN exams e ON e.id=v.exam_id JOIN courses c ON c.id=e.course_id WHERE q.id=? AND q.tenant_id=? AND c.tenant_id=? AND c.is_active=1 AND c.instructor_id=? AND q.question_type='essay' AND v.status='published' LIMIT 1`,[req.params.questionRef,tenantId,tenantId,responsibleId]);
    if(questions.length!==1)refuse(404,'GRADING_NOT_FOUND');const q=questions[0],max=toHundredths(q.points);if(!text(q.text,20000)||max===null||q.explanation!==null&&(typeof q.explanation!=='string'||q.explanation.length>20000))throw Error('Invalid pinned question');
    const rows=await c.query<any>(`SELECT a.id AS attempt_id,a.version,LEFT(CAST(ans.response AS CHAR),20001) AS response,r.revision,r.awarded_hundredths,r.feedback FROM exam_versioned_attempts a JOIN exam_versioned_answers ans ON ans.attempt_id=a.id AND ans.tenant_id=a.tenant_id AND ans.question_ref=? AND ans.manual_review=1 AND ans.question_type='essay'
      LEFT JOIN exam_manual_answer_revisions r ON r.attempt_id=a.id AND r.tenant_id=a.tenant_id AND r.question_ref=ans.question_ref AND r.revision=(SELECT rr.revision FROM exam_manual_answer_revisions rr WHERE rr.attempt_id=a.id AND rr.question_ref=ans.question_ref AND rr.tenant_id=a.tenant_id ORDER BY rr.revision DESC LIMIT 1)
      WHERE a.tenant_id=? AND a.exam_version_id=? AND a.status='pending_review' AND a.id>? ORDER BY a.id LIMIT 11`,[q.id,tenantId,q.version_id,after]);
    if(rows.length>11)throw Error('Answer page cap');
    const all=rows.map(r=>{const version=normalizeAttemptVersion(r.version);let value:unknown;try{value=JSON.parse(r.response);}catch{throw Error('Invalid saved response');}const response=typeof value==='string'&&value.length<=20000?value:null;
     if(!uuid(r.attempt_id)||version===null||r.revision!==null&&(!Number.isInteger(Number(r.revision))||Number(r.revision)<1||!Number.isInteger(Number(r.awarded_hundredths))||Number(r.awarded_hundredths)<0||Number(r.awarded_hundredths)>max)||r.feedback!==null&&(typeof r.feedback!=='string'||r.feedback.length>2000))throw Error('Invalid grading row');
     return{attempt_id:r.attempt_id,version,response,unsupported:response===null,revision:r.revision===null?null:Number(r.revision),awarded_points:r.revision===null?null:formatHundredths(Number(r.awarded_hundredths)),feedback:r.feedback};});
    if(new Set(all.map(r=>r.attempt_id)).size!==all.length)throw Error('Duplicate answers');const answers=all.slice(0,10);
    return res.json({question:{id:q.id,version_id:q.version_id,text:q.text,points:formatHundredths(max),explanation:q.explanation},answers,next_cursor:rows.length>10?answers[9].attempt_id:null});
   }
   const parents=await c.query<{id:string;exam_version_id:string;status:string;version:number}>(`SELECT a.id,a.exam_version_id,a.status,a.version FROM exam_versioned_attempts a JOIN exam_versions v ON v.id=a.exam_version_id AND v.exam_id=a.exam_id AND v.tenant_id=a.tenant_id AND v.status='published' JOIN exams e ON e.id=a.exam_id JOIN courses c ON c.id=e.course_id WHERE a.id=? AND a.tenant_id=? AND c.tenant_id=? AND c.is_active=1 AND c.instructor_id=? LIMIT 1 FOR UPDATE`,[req.params.attemptId,tenantId,tenantId,responsibleId]);
   if(parents.length!==1)refuse(404,'GRADING_NOT_FOUND');const parent=parents[0];if(assigned&&parent.exam_version_id!==assigned.versionId)refuse(404,'GRADING_NOT_FOUND');
   // Bound the existing engine's bundle before asking it to read all pinned facts.
   for(const [table,column,cap] of [['exam_version_questions','exam_version_id',100],['exam_versioned_answers','attempt_id',100],['exam_manual_answer_revisions','attempt_id',1000]] as const){
    const rows=await c.query<{id:string}>(`SELECT id FROM ${table} WHERE tenant_id=? AND ${column}=? LIMIT ${cap+1}`,[tenantId,column==='exam_version_id'?parent.exam_version_id:parent.id]);if(rows.length>cap)refuse(503,'GRADING_READ_CAP');
   }
   const bundle=await store.loadAttemptForGrading({tenantId,attemptId:parent.id});if(!bundle||bundle.attempt.exam_version_id!==parent.exam_version_id)refuse(404,'GRADING_NOT_FOUND');
   const version=normalizeAttemptVersion(bundle.attempt.version);if(version===null||version>=2147483647)refuse(409,'GRADING_STATE_INVALID');
   if(!writing){const plan=finalPlan(bundle);return res.json({attempt_id:parent.id,version,status:bundle.attempt.status,complete:plan.ok,score:plan.ok?plan.plan.score:null,review_token:reviewToken(bundle)});}
   if(version!==body.expected_version||bundle.attempt.status!=='pending_review')refuse(409,'GRADING_STALE');
   let result:GradingReceipt;
   if(kind==='grade'){
    const question=bundle.questions.find(q=>q.ref.toLowerCase()===String(body.question_ref).toLowerCase()),answer=bundle.answers.find(a=>a.question_ref.toLowerCase()===String(body.question_ref).toLowerCase());
    if(!question||question.question_type!=='essay'||!answer||answer.question_type!=='essay')refuse(404,'GRADING_NOT_FOUND');
    const previous=bundle.latestRevisions.find(r=>r.question_ref===question.ref),planned=planManualAnswerGrade({attemptStatus:bundle.attempt.status,manualReview:answer.manual_review===1||answer.manual_review===true,question,existingMaxRevision:previous?.revision??0,points:body.points,feedback:body.feedback});
    if(!planned.ok)refuse(400,planned.error);const p=planned.plan;
    const applied=await store.appendAnswerGradeRevision({tenantId,attemptId:parent.id,questionRef:p.questionRef,revision:p.revision,awardedHundredths:p.awardedHundredths,reviewerUserId:userId,feedback:p.feedback,createdAt:sqlNow(),expectedAttemptStatus:'pending_review',expectedAttemptVersion:version});
    if(!applied.ok)refuse(409,applied.reason);
    if(assigned){const saved=await c.execute('INSERT INTO exam_rubric_awards(tenant_id,attempt_id,question_ref,revision,assignment_id,assignment_version,rubric_id,actor_user_id,marks) VALUES(?,?,?,?,?,?,?,?,?)',[tenantId,parent.id,p.questionRef,p.revision,assigned.id,assigned.version,assigned.rubricId,userId,JSON.stringify(marks!.marks)]);if(Number(saved.affectedRows)!==1)throw Error('Rubric award not confirmed');}
    result={operation_id:operationId!,attempt_id:parent.id,kind,attempt_version:applied.newAttemptVersion,question_ref:p.questionRef,revision:p.revision,awarded_points:formatHundredths(p.awardedHundredths),score:null,gradebook_linked:null};
    await store.writeAudit({actorUserId:userId,tenantId,action:'exam_manual_grade.answer',resourceType:'exam_attempt',resourceId:parent.id,oldValue:previous?{question_ref:p.questionRef,revision:previous.revision,awarded_hundredths:previous.awarded_hundredths}:null,newValue:{question_ref:p.questionRef,revision:p.revision,awarded_hundredths:p.awardedHundredths,attempt_version:applied.newAttemptVersion}});
   }else{
    const plan=finalPlan(bundle);if(!plan.ok)refuse(409,plan.error);if(body.review_token!==reviewToken(bundle))refuse(409,'GRADING_STALE');
    const applied=await store.finalizeAttempt({tenantId,attemptId:parent.id,expectedAttemptStatus:'pending_review',expectedVersion:version,scoreHundredths:plan.plan.scoreHundredths,passed:plan.plan.passed,reviewerUserId:userId,gradedAt:sqlNow()});
    if(!applied.ok)refuse(409,applied.reason);
    const projected=await store.recordGradebookScore!({tenantId,examId:bundle.attempt.exam_id,examVersionId:parent.exam_version_id,attemptId:parent.id,enrollmentId:bundle.attempt.student_enrollment_id,scoreHundredths:plan.plan.scoreHundredths,totalPoints:bundle.attempt.total_points,reviewerUserId:userId});
    result={operation_id:operationId!,attempt_id:parent.id,kind,attempt_version:applied.newAttemptVersion,question_ref:null,revision:null,awarded_points:null,score:plan.plan.score,gradebook_linked:projected.linked};
    await store.writeAudit({actorUserId:userId,tenantId,action:'exam_manual_grade.finalize',resourceType:'exam_attempt',resourceId:parent.id,oldValue:{status:'pending_review',version},newValue:{status:'graded',score_hundredths:plan.plan.scoreHundredths,attempt_version:applied.newAttemptVersion,gradebook_linked:projected.linked}});
   }
   await c.execute('INSERT INTO exam_manual_operations (tenant_id,operation_id,actor_user_id,attempt_id,request_hash,result) VALUES (?,?,?,?,?,?)',[tenantId,operationId,userId,parent.id,requestHash,JSON.stringify(result)]);
   commitAttempted=true;await connection.commit();open=false;return res.status(201).json({operation:result});
  }catch(error){if(commitAttempted){discard=true;open=false;return res.status(503).json({code:'PERSISTENCE_UNCERTAIN'});}if(error instanceof GradingAuthorityDenied)return res.status(error.status).json({code:error.message});if(error instanceof Refusal)return res.status(error.status).json({code:error.code});return res.status(503).json({code:writing?'PERSISTENCE_UNCERTAIN':'QUESTION_GRADING_UNAVAILABLE'});}
  finally{if(connection){if(open){try{await connection.rollback();}catch{discard=true;}}try{if(discard)connection.destroy();else connection.release();}catch{try{connection.destroy();}catch{}}}}
 };
 router.get([base+'/exams',base+'/exams/:examId/versions',base+'/versions/:versionId/questions',base+'/questions/:questionRef/answers',base+'/attempts/:attemptId/review',base+'/operations/:operationId'],handle);
 router.post([base+'/attempts/:attemptId/grade',base+'/attempts/:attemptId/finalize'],handle);
 return router;
}
function picker(rows:{id:string;label:string}[],limit:number){if(rows.some(r=>!uuid(r.id)||!text(r.label,255))||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('Invalid grading picker');return{items:rows.slice(0,limit).map(r=>({id:r.id,label:r.label})),next_cursor:rows.length>limit?rows[limit-1].id:null};}
