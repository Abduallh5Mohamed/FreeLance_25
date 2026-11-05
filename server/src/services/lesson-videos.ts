import type {CourseLessonConnection} from '../routes/course-lessons';
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const validVideoOrder=(value:unknown):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=2147483647;
export async function lessonVideoSchema(connection:CourseLessonConnection):Promise<'absent'|'ready'|'invalid'>{
  const [columns]=await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_lesson_videos' LIMIT 8`);
  if(!(columns as any[]).length)return 'absent';
  if(!['id','lesson_id','video_id','display_order'].every(name=>(columns as any[]).some(row=>row.column_name===name)))return 'invalid';
  const [tables]=await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('course_lesson_videos','videos','course_lesson_contents','course_lessons','course_units','courses','tenants','users','audit_events','lectures','course_materials') LIMIT 11`);
  if(!['course_lesson_videos','videos','course_lesson_contents','course_lessons','course_units','courses','tenants','users','audit_events','lectures','course_materials'].every(name=>(tables as any[]).some(row=>row.table_name===name&&row.engine==='InnoDB')))return 'invalid';
  const [videoPrimary]=await connection.execute(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='videos' AND INDEX_NAME='PRIMARY' LIMIT 2`);
  if((videoPrimary as any[]).length!==1||(videoPrimary as any[])[0].column_name!=='id'||Number((videoPrimary as any[])[0].seq_in_index)!==1)return 'invalid';
  const [indexes]=await connection.execute(`SELECT INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_lesson_videos' AND INDEX_NAME IN ('PRIMARY','uq_lesson_videos_source','uq_lesson_videos_order') ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 8`);
  for(const [name,expected] of [['PRIMARY',['id']],['uq_lesson_videos_source',['lesson_id','video_id']],['uq_lesson_videos_order',['lesson_id','display_order']]] as const){
    const rows=(indexes as any[]).filter(row=>row.index_name===name);
    if(rows.length!==expected.length||!expected.every((column,n)=>rows[n].column_name===column&&Number(rows[n].seq_in_index)===n+1&&Number(rows[n].non_unique)===0))return 'invalid';
  }
  return 'ready';
}
export async function lessonVideoPositions(connection:CourseLessonConnection,lessonId:string){
  const [rows]=await connection.execute('SELECT id,video_id,display_order FROM course_lesson_videos WHERE lesson_id=? ORDER BY display_order,id LIMIT 21',[lessonId]);
  const items=rows as Array<{id:string;video_id:string;display_order:number}>;
  if(items.length>20||items.some(row=>!uuid.test(row.id)||!uuid.test(row.video_id)||!validVideoOrder(row.display_order))||new Set(items.map(row=>row.display_order)).size!==items.length||new Set(items.map(row=>row.video_id.toLowerCase())).size!==items.length)throw Error('Invalid lesson video positions');
  return items;
}
export async function lessonMaterialPositions(connection:CourseLessonConnection,lessonId:string){
  const [rows]=await connection.execute('SELECT id,display_order FROM course_lesson_contents WHERE lesson_id=? ORDER BY display_order,id LIMIT 21',[lessonId]);
  const items=rows as Array<{id:string;display_order:number}>;
  if(items.length>20||items.some(row=>!uuid.test(row.id)||!validVideoOrder(row.display_order))||new Set(items.map(row=>row.display_order)).size!==items.length)throw Error('Invalid lesson material positions');
  return items;
}
export async function eligibleLessonVideo(connection:CourseLessonConnection,videoId:string,courseId:string,tenantId:string){
  const [rows]=await connection.execute(`SELECT v.id,v.title FROM videos v WHERE v.id=? AND v.course_id=? AND v.tenant_id=? AND v.status='ready' AND v.lecture_id IS NULL AND v.material_id IS NULL LIMIT 1 FOR UPDATE`,[videoId,courseId,tenantId]);
  const source=(rows as any[])[0];if(!source)return null;
  const [lectures]=await connection.execute("SELECT id FROM lectures WHERE video_url=CONCAT('video://',?) LIMIT 2 FOR UPDATE",[source.id]);
  const [materials]=await connection.execute("SELECT id FROM course_materials WHERE material_type='video' AND file_url=CONCAT('video://',?) LIMIT 2 FOR UPDATE",[source.id]);
  if((lectures as any[]).length||(materials as any[]).length)return null;
  if(!uuid.test(source.id)||typeof source.title!=='string'||source.title.length>255)throw Error('Invalid video source');
  return {video_id:String(source.id),title:source.title as string};
}
