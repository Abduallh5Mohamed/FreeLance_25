import {Router} from 'express';
import type {AuthRequest} from '../middleware/auth';
import type {CourseLessonConnection} from './course-lessons';
import {savedReturnSchema,planHeader,storedPlanSteps} from '../services/saved-return-plans';
import {verifyStudentEnrollment,resolveStudentCourse} from '../services/student-lesson-access';
import {proveStudentLessonAudience} from '../services/student-lesson-audience';
import {ACTIVE_SUSPENSION_PREDICATE_SQL} from '../security/suspension-predicate';
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const flag=(x:unknown)=>{if(![true,false,1,0,'1','0'].includes(x as any))throw Error('Invalid student plan flag');return x===true||x===1||x==='1';};
export function createStudentReturnPlansRouter(deps:{getConnection():Promise<CourseLessonConnection>}){
 const router=Router();router.get('/my-return-plans',async(req:AuthRequest,res)=>{
  res.set('Cache-Control','no-store');const p=req.user;
  if(!p||p.role!=='student'||p.identitySource==='staff'||p.billingOnly)return res.status(403).json({error:'Student access required'});
  if(!p.tenantId||!p.studentEnrollmentId)return res.status(409).json({code:'STUDENT_SPACE_REQUIRED'});
  if(Object.keys(req.query??{}).some(k=>k!=='cursor')||req.query?.cursor!==undefined&&!uuid(req.query.cursor)||['x-tenant-id','x-student-id','x-enrollment-id','x-instructor-id'].some(k=>req.headers[k]!==undefined)
    ||req.body!=null&&(typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length))return res.status(400).json({error:'Invalid plan selectors'});
  let c:CourseLessonConnection|null=null,started=false,discard=false;
  try{
   c=await deps.getConnection();await c.beginTransaction();started=true;
   const [users]=await c.execute(`SELECT id,is_active,token_version,${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1`,[p.id]);
   const user=(users as any[])[0];if(!user||user.id!==p.id||!flag(user.is_active)||flag(user.suspension_active)||Number(user.token_version??0)!==Number(p.tokenVersion??0)
    ||!await verifyStudentEnrollment(c,p.id,p.studentEnrollmentId,p.tenantId))return res.status(404).json({error:'Workspace not found'});
   if(!await savedReturnSchema(c))return res.status(503).json({code:'RETURN_PLAN_STORAGE_UNAVAILABLE'});
   const [loaded]=await c.execute("SELECT id,course_id,version,status FROM course_return_plans WHERE tenant_id=? AND enrollment_id=? AND status='active' AND id>? ORDER BY id LIMIT 6",[p.tenantId,p.studentEnrollmentId,req.query?.cursor??'']);
   const all=loaded as any[];if(all.length>6||new Set(all.map(row=>String(row.id).toLowerCase())).size!==all.length)throw Error('Invalid plans page');
   const plans=[];
   for(const row of all.slice(0,5)){
    const head=planHeader(row);if(head.status!=='active'||!uuid(row.course_id))throw Error('Invalid student plan');
    const course=await resolveStudentCourse(c,p.studentEnrollmentId,row.course_id,p.tenantId);if(!course)continue;
    if(typeof course.name!=='string'||!course.name.trim()||course.name.length>255)throw Error('Invalid plan course');
    const [revisions]=await c.execute('SELECT status,steps FROM course_return_plan_revisions WHERE plan_id=? AND version=? LIMIT 2',[head.id,head.version]);
    if((revisions as any[]).length!==1||(revisions as any[])[0].status!==head.status)throw Error('Missing plan revision');
    const saved=storedPlanSteps((revisions as any[])[0].steps,head.status),steps=[];
    for(const [i,step] of saved.entries()){
     const proof=await proveStudentLessonAudience(c,{userId:p.id,tenantId:p.tenantId,enrollmentId:p.studentEnrollmentId},row.course_id,step.lesson_id,p);
     if(!proof.ok){if(proof.status===503)return res.status(503).json({code:'RETURN_PLAN_UNAVAILABLE'});steps.push({position:i+1,available:false});continue;}
     const title=proof.lessonProof.lesson.title;if(typeof title!=='string'||!title.trim()||title.length>255)throw Error('Invalid plan lesson');
     const [completed]=await c.execute('SELECT EXISTS(SELECT 1 FROM course_lesson_completions WHERE student_enrollment_id=? AND lesson_id=?) AS completed',[p.studentEnrollmentId,step.lesson_id]);
     if((completed as any[]).length!==1)throw Error('Invalid progress');
     steps.push({position:i+1,available:true,lesson_id:step.lesson_id,title,minutes:step.minutes,completed:flag((completed as any[])[0].completed)});
    }
    plans.push({id:head.id,version:head.version,course_id:row.course_id,course_name:course.name,steps});
   }
   return res.json({plans,next_cursor:all.length>5?all[4].id:null,checked_at:new Date().toISOString()});
  }catch{discard=true;return res.status(503).json({code:'RETURN_PLAN_UNAVAILABLE'});}
  finally{if(c){if(started)try{await c.rollback();}catch{discard=true;}try{if(discard)c.destroy();else c.release();}catch{}}}
 });return router;
}
