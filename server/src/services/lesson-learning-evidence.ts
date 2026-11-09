import type { CourseLessonConnection } from '../routes/course-lessons';
import { manageLessonQuizVersion } from './lesson-quiz-versions';
import { readLessonPackageBindings } from './lesson-package-reuse';
import { readLessonActivitySources } from './lesson-activities';
import { parseCatalogExamContext } from './catalog-exam-access';
import { normalizeTags } from './question-bank';
import { toHundredths } from './exam-grading';
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
function fail(): never { throw Error('Invalid learning evidence'); }
const result = (status: number, body: any) => ({ status, body });
export function parseLearningWindow(query: any): { groupId: string; from: string; to: string } | null {
  if (!query || Object.keys(query).sort().join(',') !== 'from,group_id,to' || !uuid(query.group_id)) return null;
  const valid = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
  if (!valid(query.from) || !valid(query.to) || Date.parse(query.from) >= Date.parse(query.to) || Date.parse(query.to) - Date.parse(query.from) > 31 * 86400000) return null;
  return { groupId: query.group_id.toLowerCase(), from: query.from, to: query.to };
}
export const LEARNING_TABLES: Record<string, string[]> = {
  exam_versioned_attempts: ['id','tenant_id','exam_id','exam_version_id','student_enrollment_id','student_user_id','status','submitted_at','catalog_context'],
  exam_version_questions: ['id','tenant_id','exam_version_id','position','question_type','question_text','points','source_version_id','question_id','question_version'],
  exam_versioned_answers: ['tenant_id','attempt_id','exam_version_id','question_ref','question_type','is_correct','manual_review'],
  question_bank_versions: ['id','tenant_id','question_id','version','tags'],
};
async function schema(connection: CourseLessonConnection) {
  const tables = Object.keys(LEARNING_TABLES);
  const [columns] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?,?) LIMIT 80`,tables);
  if (!tables.every(table=>LEARNING_TABLES[table].every(name=>(columns as any[]).some(row=>row.table_name===table&&row.column_name===name)))) return false;
  if (!['catalog_context','tags'].every(name=>(columns as any[]).some(row=>row.column_name===name&&row.data_type==='json'))) return false;
  const [engines] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?,?) LIMIT 4`,tables);
  return tables.every(table=>(engines as any[]).some(row=>row.table_name===table&&row.engine==='InnoDB'));
}
const GROUP_PROJECTION = `SELECT g.id,g.name,g.course_id,g.branch_scope,g.branch_id,b.id AS resolved_branch_id,b.tenant_id AS branch_tenant_id,b.status AS branch_status FROM \`groups\` g LEFT JOIN branches b ON b.id=g.branch_id WHERE g.course_id=?`;
function validGroup(row: any, courseId: string, tenantId: string) {
  if (!uuid(row.id) || !same(row.course_id,courseId) || typeof row.name!=='string'||!row.name.trim()||row.name.length>255) return false;
  return row.branch_scope==='tenant'&&row.branch_id===null || row.branch_scope==='branch'&&uuid(row.branch_id)&&row.branch_id===row.resolved_branch_id&&row.branch_tenant_id===tenantId&&row.branch_status==='active';
}
/** Caller already holds current owner/course/exact lesson authority. */
export async function listPreparationGroups(connection: CourseLessonConnection, courseId:string, tenantId:string, cursor:string) {
  const [rows] = await connection.execute(GROUP_PROJECTION+' AND g.id>? ORDER BY g.id LIMIT 26',[courseId,cursor]);
  if ((rows as any[]).length>26 || !(rows as any[]).every(row=>validGroup(row,courseId,tenantId)) || new Set((rows as any[]).map(row=>row.id.toLowerCase())).size!==(rows as any[]).length) return result(503,{code:'LEARNING_EVIDENCE_UNAVAILABLE'});
  const page=(rows as any[]).slice(0,25);
  return result(200,{groups:page.map(row=>({id:row.id,name:row.name})),next_cursor:(rows as any[]).length>25?page[24].id:null});
}
export interface LearningQuestion { id:string;position:number;type:string;tags:string[];text:string }
/** Pure automatic-answer evidence; no raw answers/student identifiers returned. */
export function summarizeLearning(questions:LearningQuestion[], attempts:string[], answers:any[]) {
  if(questions.length>200||attempts.length>100||answers.length>20000||new Set(attempts).size!==attempts.length) fail();
  const auto=questions.filter(q=>q.type!=='essay'), expected=new Set(attempts), refs=new Map(auto.map(q=>[q.id,q])), seen=new Set<string>();
  const counts=new Map(auto.map(q=>[q.id,{responses:0,not_correct:0}]));
  for(const row of answers) {
    const q=refs.get(row.question_ref);
    if(!q||!expected.has(row.attempt_id)||q.type!==row.question_type||![0,1,false,true].includes(row.is_correct)||![0,false].includes(row.manual_review)||seen.has(row.attempt_id+'/'+row.question_ref))fail();
    seen.add(row.attempt_id+'/'+row.question_ref);const c=counts.get(q.id)!;c.responses++;if(!row.is_correct)c.not_correct++;
  }
  if(seen.size!==auto.length*attempts.length)fail();
  const tags=new Map<string,{responses:number;not_correct:number;questions:LearningQuestion[]}>();
  for(const q of auto)for(const tag of q.tags){const c=counts.get(q.id)!;const t=tags.get(tag)??{responses:0,not_correct:0,questions:[]};t.responses+=c.responses;t.not_correct+=c.not_correct;t.questions.push(q);tags.set(tag,t);}
  const candidates=[...tags.entries()].filter(([,x])=>attempts.length>=5&&x.responses>0&&x.not_correct*100>=x.responses*40)
    .sort((a,b)=>b[1].not_correct*a[1].responses-a[1].not_correct*b[1].responses||b[1].not_correct-a[1].not_correct||a[0].localeCompare(b[0])).slice(0,2);
  return { state:attempts.length<5||!auto.some(q=>q.tags.length)?'insufficient':'available', graded_attempts:attempts.length, automatic_questions:auto.length,
    unmapped_questions:auto.filter(q=>!q.tags.length).length, excluded_manual_questions:questions.length-auto.length,
    suggestions:candidates.map(([tag,x])=>({tag,responses:x.responses,not_fully_correct:x.not_correct,question_count:x.questions.length,
      evidence:x.questions.slice().sort((a,b)=>a.position-b.position).slice(0,5).map(q=>({question_ref:q.id,position:q.position,text:q.text,...counts.get(q.id)!}))})) };
}
export async function readLessonLearning(connection:CourseLessonConnection,input:{userId:string;tenantId:string;courseId:string;lessonId:string;window:NonNullable<ReturnType<typeof parseLearningWindow>>}) {
  const {userId,tenantId,courseId,lessonId,window}=input;
  const [groups]=await connection.execute(GROUP_PROJECTION+' AND g.id=? LIMIT 2',[courseId,window.groupId]);
  if((groups as any[]).length!==1||!validGroup((groups as any[])[0],courseId,tenantId))return result(404,{error:'Group not found'});
  const quiz=(await readLessonPackageBindings(connection,lessonId)).find(row=>row.kind==='quiz');
  const context={course_id:courseId.toLowerCase(),lesson_id:lessonId.toLowerCase(),group_id:window.groupId,from:window.from,to:window.to};
  const base={context,checked_at:new Date().toISOString(),group_name:(groups as any[])[0].name,rule_version:'automatic-tags-v1'};
  const empty=(reason:string)=>result(200,{...base,reason,state:'insufficient',graded_attempts:null,automatic_questions:null,unmapped_questions:null,excluded_manual_questions:null,suggestions:[]});
  if(!quiz)return empty('no_quiz');
  const source=await readLessonActivitySources(connection,'quiz',courseId,tenantId,{ids:[quiz.source_id]},true);
  if(!source.items.length||source.groups.length&&!source.groups.some(g=>same(g.id,window.groupId)))return result(403,{error:'Quiz audience unavailable'});
  const version=await manageLessonQuizVersion(connection,{userId,tenantId,courseId,lessonId,contentId:quiz.id,operation:'read'});
  if(version.status!==200)return result(503,{code:'LEARNING_EVIDENCE_UNAVAILABLE'});
  if(version.body.pin?.status!=='published')return empty('no_published_version');
  if(!await schema(connection))return result(503,{code:'LEARNING_EVIDENCE_UNAVAILABLE'});
  const versionId=version.body.pin.exam_version_id;
  const [loaded]=await connection.execute(`SELECT q.id,q.position,q.question_type,q.points,LEFT(q.question_text,1000) AS question_text,q.source_version_id,v.id AS tag_version_id,v.tags FROM exam_version_questions q LEFT JOIN question_bank_versions v ON v.id=q.source_version_id AND v.tenant_id=q.tenant_id AND v.question_id=q.question_id AND v.version=q.question_version WHERE q.tenant_id=? AND q.exam_version_id=? ORDER BY q.position,q.id LIMIT 201`,[tenantId,versionId]);
  if(!(loaded as any[]).length||(loaded as any[]).length>200)return result(503,{code:'LEARNING_EVIDENCE_INCOMPLETE'});
  const questions:LearningQuestion[]=(loaded as any[]).map(row=>{
    if(!uuid(row.id)||!Number.isInteger(row.position)||row.position<1||row.position>200||!['single_choice','multiple_choice','true_false','essay'].includes(row.question_type)||toHundredths(row.points)===null||Number(row.points)<=0||typeof row.question_text!=='string'||!row.question_text.trim()||row.question_text.length>1000) return fail();
    let tags:string[]=[];
    if(row.tag_version_id!==null){if(!uuid(row.source_version_id)||!same(row.tag_version_id,row.source_version_id))return fail();const parsed=normalizeTags(typeof row.tags==='string'?JSON.parse(row.tags):row.tags);if(parsed===null)return fail();tags=parsed;}
    return{id:row.id,position:row.position,type:row.question_type,text:row.question_text,tags};
  });
  if(new Set(questions.map(q=>q.id)).size!==questions.length||new Set(questions.map(q=>q.position)).size!==questions.length)fail();
  const [attemptRows]=await connection.execute(`SELECT a.id,a.student_enrollment_id,a.student_user_id,a.catalog_context FROM exam_versioned_attempts a INNER JOIN students s ON s.id=a.student_enrollment_id AND s.tenant_id=a.tenant_id AND s.user_id=a.student_user_id WHERE a.tenant_id=? AND a.exam_id=? AND a.exam_version_id=? AND s.group_id=? AND a.status='graded' AND a.submitted_at>=? AND a.submitted_at<? AND JSON_UNQUOTE(JSON_EXTRACT(a.catalog_context,'$.courseId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(a.catalog_context,'$.lessonId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(a.catalog_context,'$.contentId'))=? ORDER BY a.id LIMIT 101`,[tenantId,quiz.source_id,versionId,window.groupId,window.from.slice(0,19).replace('T',' '),window.to.slice(0,19).replace('T',' '),courseId,lessonId,quiz.id]);
  if((attemptRows as any[]).length>100)return result(503,{code:'LEARNING_EVIDENCE_INCOMPLETE'});
  const attempts=(attemptRows as any[]).map(row=>{const c=parseCatalogExamContext(row.catalog_context);if(!uuid(row.id)||c.tenantId!==tenantId||c.userId!==row.student_user_id||c.enrollmentId!==row.student_enrollment_id||!same(c.courseId,courseId)||!same(c.lessonId,lessonId)||!same(c.contentId,quiz.id)||!same(c.examId,quiz.source_id)||!same(c.versionId,versionId))return fail();return row.id;});
  const [answers]=attempts.length?await connection.execute(`SELECT a.attempt_id,a.question_ref,a.question_type,a.is_correct,a.manual_review FROM exam_versioned_answers a INNER JOIN exam_version_questions q ON q.id=a.question_ref AND q.exam_version_id=a.exam_version_id AND q.tenant_id=a.tenant_id WHERE a.tenant_id=? AND a.exam_version_id=? AND a.attempt_id IN (${attempts.map(()=>'?').join(',')}) AND q.question_type<>'essay' ORDER BY a.attempt_id,a.question_ref LIMIT 20001`,[tenantId,versionId,...attempts]):[[],[]];
  return result(200,{...base,reason:null,...summarizeLearning(questions,attempts,answers as any[])});
}
