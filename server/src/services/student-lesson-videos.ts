import type {AuthRequest} from '../middleware/auth';
import type {StudentCourseAccessConnection} from '../routes/student-course-access';
import {proveStudentLesson,type StudentLessonScope} from './student-lesson-access';
import {lessonVideoSchema,lessonMaterialPositions} from './lesson-videos';
import {createSqlResourceScopeLoader,principalFromAuthUser,resolveResourceBranchAccess} from '../security/resource-branch';
import {ACTIVE_SUSPENSION_PREDICATE_SQL} from '../security/suspension-predicate';
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const yes=(value:unknown)=>value===1||value===true||value==='1';
const missing=()=>({ok:false as const,status:404,body:{error:'Lesson video not found'},commit:false as const});
const unavailable=()=>({ok:false as const,status:503,body:{error:'Lesson video proof unavailable',code:'CATALOG_VIDEO_UNAVAILABLE'},commit:false as const});
type Principal=NonNullable<AuthRequest['user']>;
interface VerifiedCatalogVideo {content_id:string;video_id:string;title:string;display_order:number}

/** Fresh request proof; no token, provider, locator, persistence or legacy fallback. */
async function authorizedVideos(connection:StudentCourseAccessConnection,scope:StudentLessonScope,courseId:string,lessonId:string,principal:Principal){
  if(principal.role!=='student'||principal.identitySource==='staff'||principal.id!==scope.userId||principal.tenantId!==scope.tenantId||principal.studentEnrollmentId!==scope.enrollmentId)return missing();
  const [users]=await connection.execute(`SELECT id,is_active,token_version,${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1`,[scope.userId]);
  const user=(users as any[])[0];
  if(!user||!yes(user.is_active)||Number(user.suspension_active)!==0||Number(user.token_version??0)!==Number(principal.tokenVersion??0)||!same(user.id,scope.userId))return missing();
  const lesson=await proveStudentLesson(connection,scope,courseId,lessonId);if(!lesson.ok)return lesson;
  if(await lessonVideoSchema(connection)!=='ready')return unavailable();
  const [tables]=await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('students','student_courses','course_lesson_completions','groups','branches','branch_memberships') LIMIT 6`);
  if(!['students','student_courses','course_lesson_completions','groups','branches','branch_memberships'].every(name=>(tables as any[]).some(row=>row.table_name===name&&row.engine==='InnoDB')))return unavailable();
  // The enrollment's actual group is an additional audience/branch guard.
  // We do not derive a video's branch by expanding all groups of its course.
  const [groups]=await connection.execute(`SELECT g.id,g.course_id,c.tenant_id,g.branch_id,g.branch_scope,g.instructor_id,
    br.id AS resolved_branch_id,br.tenant_id AS branch_tenant_id,br.status AS branch_status,br.version AS branch_version,
    bm.user_id AS member_user_id,bm.status AS member_status,bm.role AS member_role,bm.version AS member_version
    FROM students s INNER JOIN \`groups\` g ON g.id=s.group_id INNER JOIN courses c ON c.id=g.course_id
    LEFT JOIN branches br ON br.id=g.branch_id LEFT JOIN branch_memberships bm ON bm.branch_id=br.id AND bm.user_id=?
    WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND g.course_id=? AND c.tenant_id=? LIMIT 2`,[scope.userId,scope.enrollmentId,scope.userId,scope.tenantId,courseId,scope.tenantId]);
  if((groups as any[]).length!==1)return missing();
  const group=(groups as any[])[0];if(!uuid.test(String(group.id))||!same(group.course_id,courseId)||!same(group.tenant_id,scope.tenantId))return missing();
  const loader=createSqlResourceScopeLoader({queryOne:async<T>()=>({id:group.id,tenant_id:group.tenant_id,branch_id:group.branch_id,branch_scope:group.branch_scope,instructor_id:group.instructor_id}) as T,query:async<T>()=>[] as T[]});
  const branch=await resolveResourceBranchAccess({loadResourceScope:loader,
    findBranch:async id=>same(id,group.resolved_branch_id)?{id:group.resolved_branch_id,tenant_id:group.branch_tenant_id,status:group.branch_status,version:Number(group.branch_version)}:null,
    findMembership:async(id,userId)=>same(id,group.resolved_branch_id)&&same(userId,group.member_user_id)?{branch_id:group.resolved_branch_id,user_id:group.member_user_id,status:group.member_status,role:group.member_role,version:Number(group.member_version)}:null,
    isTenantOwner:async()=>false,hasPlatformCapability:async()=>false,
  },principalFromAuthUser(principal),{resourceType:'group',resourceId:group.id});
  if(branch.kind!=='allowed')return missing();
  const [rows]=await connection.execute(`SELECT b.id AS content_id,b.video_id,b.display_order,v.id AS source_id,v.title,v.status,v.is_encrypted,v.hls_key,v.original_key
    FROM course_lesson_videos b LEFT JOIN videos v ON v.id=b.video_id AND v.course_id=? AND v.tenant_id=?
      AND v.status='ready' AND v.lecture_id IS NULL AND v.material_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM lectures l WHERE l.video_url=CONCAT('video://',v.id))
      AND NOT EXISTS (SELECT 1 FROM course_materials m WHERE m.material_type='video' AND m.file_url=CONCAT('video://',v.id))
    WHERE b.lesson_id=? ORDER BY b.display_order,b.id LIMIT 21`,[courseId,scope.tenantId,lessonId]);
  const bindings=rows as any[],materials=await lessonMaterialPositions(connection,lessonId);
  if(bindings.length+materials.length>20||bindings.some(row=>typeof row.content_id!=='string'||!uuid.test(row.content_id)||typeof row.video_id!=='string'||!uuid.test(row.video_id)||!Number.isInteger(row.display_order)||row.display_order<0||row.display_order>2147483647)
    ||new Set(bindings.map(row=>row.content_id.toLowerCase())).size!==bindings.length||new Set(bindings.map(row=>row.video_id.toLowerCase())).size!==bindings.length
    ||new Set([...bindings,...materials].map(row=>row.display_order)).size!==bindings.length+materials.length)return unavailable();
  const videos:VerifiedCatalogVideo[]=[];
  for(const row of bindings){
    if(!row.source_id)continue;
    if(!same(row.video_id,row.source_id)||typeof row.title!=='string'||row.title.length>255||row.status!=='ready')return unavailable();
    // Processing alone is insufficient even for advertising a future candidate.
    if(!yes(row.is_encrypted)||typeof row.hls_key!=='string'||!row.hls_key||typeof row.original_key!=='string'||!row.original_key||row.hls_key===row.original_key)continue;
    videos.push({content_id:row.content_id,video_id:row.source_id,title:row.title,display_order:row.display_order});
  }
  return {ok:true as const,scope:{userId:String(user.id),tenantId:String(lesson.enrollment.tenant_id),enrollmentId:String(lesson.enrollment.enrollment_id)},courseId:String(lesson.course.course_id),lessonId:String(lesson.lesson.id),videos};
}
export async function listStudentLessonVideos(connection:StudentCourseAccessConnection,scope:StudentLessonScope,courseId:string,lessonId:string,principal:Principal){
  const proof=await authorizedVideos(connection,scope,courseId,lessonId,principal);if(!proof.ok)return proof;
  return {status:200,body:{lesson_id:proof.lessonId,videos:proof.videos.map(row=>({content_id:row.content_id,title:row.title,display_order:row.display_order,playback_status:'session_required' as const}))},commit:false as const};
}
/** Issuance/delivery call this afresh AND must prove their own session. */
export async function proveStudentCatalogVideo(connection:StudentCourseAccessConnection,scope:StudentLessonScope,courseId:string,lessonId:string,contentId:string,principal:Principal){
  if(!uuid.test(contentId))return missing();
  const proof=await authorizedVideos(connection,scope,courseId,lessonId,principal);if(!proof.ok)return proof;
  const video=proof.videos.find(row=>same(row.content_id,contentId));return video?{ok:true as const,scope:proof.scope,courseId:proof.courseId,lessonId:proof.lessonId,video}:missing();
}
