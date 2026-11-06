import type {AuthRequest} from '../middleware/auth';
import type {StudentCourseAccessConnection} from '../routes/student-course-access';
import type {StudentLessonScope} from './student-lesson-access';
import {proveStudentLessonAudience} from './student-lesson-audience';
import {lessonVideoSchema,lessonMaterialPositions} from './lesson-videos';
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const yes=(value:unknown)=>value===1||value===true||value==='1';
const missing=()=>({ok:false as const,status:404,body:{error:'Lesson video not found'},commit:false as const});
const unavailable=()=>({ok:false as const,status:503,body:{error:'Lesson video proof unavailable',code:'CATALOG_VIDEO_UNAVAILABLE'},commit:false as const});
type Principal=NonNullable<AuthRequest['user']>;
interface VerifiedCatalogVideo {content_id:string;video_id:string;title:string;display_order:number}

/** Fresh request proof; no token, provider, locator, persistence or legacy fallback. */
async function authorizedVideos(connection:StudentCourseAccessConnection,scope:StudentLessonScope,courseId:string,lessonId:string,principal:Principal){
  const audience=await proveStudentLessonAudience(connection,scope,courseId,lessonId,principal,{missingError:'Lesson video not found',unavailableCode:'CATALOG_VIDEO_UNAVAILABLE'});
  if(!audience.ok)return audience;
  const {user,lessonProof:lesson}=audience;
  if(await lessonVideoSchema(connection)!=='ready')return unavailable();
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
