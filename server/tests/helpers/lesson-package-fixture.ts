import { readFileSync } from 'node:fs';
import { COURSE_A1, UNIT_A1, LESSON_1, LESSON_2, OWNER_A, TENANT_A } from './m2-course-lessons-harness';
import { createLessonPackageTemplatesRouter } from '../../src/routes/lesson-package-templates';
export const MATERIAL = 'b9000000-0000-4000-8000-000000000001';
export const OPERATION = 'b9000000-0000-4000-8000-000000000090';

const TEMPLATE_COLUMNS = ['id', 'tenant_id', 'course_id', 'name', 'status', 'head_revision', 'created_by', 'created_at', 'updated_at', 'archived_at'];
const REVISION_COLUMNS = ['id', 'template_id', 'tenant_id', 'course_id', 'revision_number', 'source_lesson_id', 'created_by', 'reference_count', 'media_count', 'content_hash', 'created_at'];
const REFERENCE_COLUMNS = ['id', 'revision_id', 'kind', 'source_id', 'display_order'];
const OPERATION_COLUMNS = ['tenant_id', 'operation_id', 'actor_user_id', 'course_id', 'lesson_id', 'template_id', 'revision_number', 'timing_mode', 'release_at_epoch', 'request_hash', 'created_count', 'existing_count'];

const COLUMNS: Record<string, string[]> = {
  course_lesson_quiz_versions: ['content_id','exam_id','exam_version_id'],
  exam_versions: ['id','exam_id','tenant_id','version','status','published_at'],
  lesson_package_templates: TEMPLATE_COLUMNS,
  lesson_package_template_revisions: REVISION_COLUMNS,
  lesson_package_template_references: REFERENCE_COLUMNS,
  lesson_template_operations: OPERATION_COLUMNS,
  course_lesson_videos: ['id', 'lesson_id', 'video_id', 'display_order'],
  videos: ['id'],
  course_lesson_activities: ['id', 'lesson_id', 'kind', 'assignment_id', 'exam_id'],
  assignments: ['id', 'tenant_id', 'course_id', 'title', 'status', 'archived_at', 'group_id', 'branch_id', 'branch_scope'],
  exams: ['id', 'course_id', 'title', 'is_active', 'is_published'],
  exam_groups: ['exam_id', 'group_id'],
  course_lesson_announcements: ['id', 'lesson_id', 'announcement_id'],
  group_announcements: ['id', 'tenant_id', 'group_id', 'title', 'body', 'state'],
  groups: ['id', 'name', 'course_id', 'branch_id', 'branch_scope'],
  branches: ['id', 'tenant_id', 'status'],
  students: ['id', 'user_id', 'tenant_id', 'group_id', 'is_active', 'approval_status', 'enrollment_status', 'enrollment_start_date', 'enrollment_end_date'],
  users: ['id', 'is_active', 'suspended_until'],
  student_courses: ['student_id', 'course_id', 'status'],
  branch_memberships: ['branch_id', 'user_id', 'status', 'role'],
  course_materials: ['id', 'title', 'material_type', 'is_published'],
  courses: ['id', 'tenant_id', 'is_active'],
  course_units: ['id', 'course_id', 'display_order'],
  course_lessons: ['id', 'unit_id', 'status', 'release_at'],
  tenants: ['id', 'owner_user_id', 'status'],
  audit_events: ['id'],
  course_lesson_contents: ['id', 'lesson_id', 'material_id', 'display_order'],
  lectures: ['id'],
};

const INDEXES: Array<{ table_name: string; index_name: string; column_name: string; seq_in_index: number; non_unique: number }> = [];
const addIndex = (table: string, index: string, columns: string[]) => columns.forEach((column, i) => INDEXES.push({ table_name: table, index_name: index, column_name: column, seq_in_index: i + 1, non_unique: 0 }));
addIndex('lesson_package_templates', 'PRIMARY', ['id']);
addIndex('lesson_package_templates', 'uq_lesson_template_name', ['tenant_id', 'course_id', 'name']);
addIndex('lesson_package_template_revisions', 'PRIMARY', ['id']);
addIndex('lesson_package_template_revisions', 'uq_template_revision_number', ['template_id', 'revision_number']);
addIndex('lesson_package_template_references', 'PRIMARY', ['id']);
addIndex('lesson_package_template_references', 'uq_template_reference', ['revision_id', 'kind', 'source_id']);
addIndex('lesson_template_operations', 'PRIMARY', ['tenant_id', 'operation_id']);
addIndex('course_lesson_videos', 'PRIMARY', ['id']);
addIndex('course_lesson_videos', 'uq_lesson_videos_source', ['lesson_id', 'video_id']);
addIndex('course_lesson_videos', 'uq_lesson_videos_order', ['lesson_id', 'display_order']);
addIndex('course_lesson_activities', 'PRIMARY', ['id']);
addIndex('course_lesson_activities', 'uq_lesson_activity_kind', ['lesson_id', 'kind']);
addIndex('assignments', 'PRIMARY', ['id']);
addIndex('exams', 'PRIMARY', ['id']);
addIndex('videos', 'PRIMARY', ['id']);
addIndex('course_lesson_announcements', 'PRIMARY', ['id']);
addIndex('course_lesson_announcements', 'uq_lesson_announcement', ['lesson_id']);
addIndex('group_announcements', 'PRIMARY', ['id']);
addIndex('groups', 'PRIMARY', ['id']);
addIndex('students', 'PRIMARY', ['id']);
addIndex('course_lesson_quiz_versions','PRIMARY',['content_id']);
addIndex('exam_versions','PRIMARY',['id']);
addIndex('exam_versions','uq_exam_version',['exam_id','version']);

// Physical metadata is derived from the unapplied DDL, independently of service specs.
const ddlColumns:any[]=[];
for(const file of ['20261106_10_lesson_package_templates.sql','20261106_11_lesson_template_operations.sql']) {
 const ddl=readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8');
 for(const table of ddl.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\) ENGINE=/g)) {
  COLUMNS[table[1]]=[];
  for(const line of table[2].split('\n')) {
   const m=/^\s+(\w+) (CHAR|VARCHAR|INT|TINYINT|TIMESTAMP|ENUM)(\([^)]*\))? (NOT NULL|NULL)/i.exec(line);
   if(!m)continue;
   COLUMNS[table[1]].push(m[1]);
   ddlColumns.push({table_name:table[1],column_name:m[1],data_type:m[2].toLowerCase(),column_type:(m[2]+(m[3]??'')).toLowerCase(),max_length:['CHAR','VARCHAR'].includes(m[2])?Number(m[3]?.slice(1,-1)):null,is_nullable:m[4]==='NULL'?'YES':'NO',collation_name:['CHAR','VARCHAR','ENUM'].includes(m[2])?'utf8mb4_bin':null});
  }
 }
}
addIndex('lesson_template_library_operations','PRIMARY',['tenant_id','operation_id']);

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
export const uid = (n: number) => `b9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function fixture(options: { schema?: boolean } = {}, routerFactory = createLessonPackageTemplatesRouter) {
  const state = {
    schema: options.schema !== false,
    columnOverride: null as null | ((row:any)=>any), indexes:true, foreignKeys:true, engine:'InnoDB', available:true, pin:null as any, quizGroups:[] as any[], title:'Synthetic material', failSQL: '', loseCommit:false, events:[] as string[], libraryOperations:[] as any[],
    returnHeads:[] as any[],returnRevisions:[] as any[],returnOperations:[] as any[],
    templates: [] as any[], revisions: [] as any[], references: [] as any[], operations: [] as any[],
    bindings: {
      [LESSON_1]: { material: [{ id: uid(11), source_id: MATERIAL, display_order: 0 }], video: [] as any[], announcement: [] as any[], activity: [] as any[] },
      [LESSON_2]: { material: [] as any[], video: [] as any[], announcement: [] as any[], activity: [] as any[] },
    } as Record<string, { material: any[]; video: any[]; announcement: any[]; activity: any[] }>,
    release: new Map<string, number | null>([[LESSON_1, 1_700_000_000], [LESSON_2, null]]),
    audits: 0,
  };

  const insertBinding = (sql: string, params: any[]) => {
    const lessonId = String(params[1]);
    const store = state.bindings[lessonId];
    if (!store) return { affectedRows: 0 };
    if (sql.startsWith('INSERT INTO course_lesson_contents')) store.material.push({ id: params[0], source_id: params[2], display_order: params[3] });
    else if (sql.startsWith('INSERT INTO course_lesson_videos')) store.video.push({ id: params[0], source_id: params[2], display_order: params[3] });
    else if (sql.startsWith('INSERT INTO course_lesson_announcements')) store.announcement.push({ id: params[0], source_id: params[2], display_order: null });
    else store.activity.push({ id: params[0], kind: params[2], source_id: params[2] === 'homework' ? params[3] : params[4], display_order: null });
    return { affectedRows: 1 };
  };

  const execute = async (sql: string, params: any[] = []): Promise<[any[], any[]]> => {
    const n = squash(sql);
    if(state.failSQL && n.startsWith(state.failSQL)) throw Error('Synthetic failure');
    if (!state.schema) {
      if (n.includes('information_schema.COLUMNS')) return [[], []];
    }
    if (n.includes('information_schema.KEY_COLUMN_USAGE')) return [[
      {table_name:'course_lesson_quiz_versions',column_name:'content_id',referenced_table:'course_lesson_activities',referenced_column:'id',delete_rule:'CASCADE'},
      {table_name:'course_lesson_quiz_versions',column_name:'exam_id',referenced_table:'exams',referenced_column:'id',delete_rule:'RESTRICT'},
      {table_name:'course_lesson_quiz_versions',column_name:'exam_version_id',referenced_table:'exam_versions',referenced_column:'id',delete_rule:'RESTRICT'},
      {table_name:'lesson_package_template_revisions',column_name:'template_id',referenced_table:'lesson_package_templates',referenced_column:'id',delete_rule:'RESTRICT'},
      {table_name:'lesson_package_template_references',column_name:'revision_id',referenced_table:'lesson_package_template_revisions',referenced_column:'id',delete_rule:'RESTRICT'},
      { column_name: 'lesson_id', referenced_table: 'course_lessons', referenced_column: 'id', delete_rule: 'CASCADE', table_name:'course_lesson_announcements' },
      { column_name: 'announcement_id', referenced_table: 'group_announcements', referenced_column: 'id', delete_rule: 'CASCADE', table_name:'course_lesson_announcements' },
    ].filter(row=>(state.foreignKeys || row.table_name==='course_lesson_announcements') && (!n.includes("k.TABLE_NAME='course_lesson_announcements'")||row.table_name==='course_lesson_announcements') && (!n.includes("k.TABLE_NAME='course_lesson_quiz_versions'")||row.table_name==='course_lesson_quiz_versions')), []];
    if (n.includes('information_schema.COLUMNS')) {
      return [Object.entries(COLUMNS).flatMap(([table_name, columns]) => columns.map(column_name => ({
        ...(state.columnOverride?.(ddlColumns.find(row=>row.table_name===table_name&&row.column_name===column_name)??{table_name,column_name})??ddlColumns.find(row=>row.table_name===table_name&&row.column_name===column_name)??{table_name,column_name}),
      }))), []];
    }
    if (n.includes('information_schema.TABLES')) {
      return [Object.keys(COLUMNS).map(table_name => ({ table_name, engine: state.engine })), []];
    }
    if (n.includes('information_schema.STATISTICS')) {
      const table = /TABLE_NAME='([^']+)'/.exec(n)?.[1];
      const index = /INDEX_NAME='([^']+)'/.exec(n)?.[1];
      return [state.indexes ? INDEXES.filter(row => (!table || row.table_name === table) && (!index || row.index_name === index)) : [], []];
    }

    if (n.startsWith('SELECT id AS academic_tenant_id')) return [params[0] === TENANT_A ? [{ academic_tenant_id: TENANT_A }] : [], []];
    if (n.startsWith('SELECT u.id AS teaching_user_id')) {
      return [params[0] === TENANT_A && params[1] === OWNER_A && params[2] === 0 ? [{ teaching_user_id: OWNER_A }] : [], []];
    }
    if (n.startsWith('SELECT c.id AS teaching_course_id')) {
      return [String(params[0]).toLowerCase() === COURSE_A1 && params[1] === TENANT_A && params[2] === OWNER_A ? [{ teaching_course_id: COURSE_A1 }] : [], []];
    }
    if (n.startsWith('SELECT t.owner_user_id')) {
      return [params[0] === OWNER_A && params[1] === TENANT_A ? [{ owner_user_id: OWNER_A, tenant_status: 'active', caller_active: 1 }] : [], []];
    }
    if (n.startsWith('SELECT c.id,c.tenant_id FROM courses')) {
      return [params[0].toLowerCase() === COURSE_A1 && params[1] === TENANT_A ? [{ id: COURSE_A1, tenant_id: params[1] }] : [], []];
    }
    if (n.startsWith('SELECT u.id,u.course_id,u.display_order FROM course_units')) {
      return [params[0].toLowerCase() === UNIT_A1 && params[1] === COURSE_A1 ? [{ id: UNIT_A1, course_id: params[1], display_order: 0 }] : [], []];
    }
    if (n === 'SELECT l.id FROM course_lessons l WHERE l.id=? AND l.unit_id=? FOR UPDATE') {
      return [[LESSON_1, LESSON_2].includes(String(params[0]).toLowerCase()) ? [{ id: params[0] }] : [], []];
    }
    if (n.startsWith('SELECT l.id,l.unit_id,l.status,u.status AS unit_status FROM course_lessons l INNER JOIN')) {
      const lesson = String(params[0]).toLowerCase();
      return [lesson === LESSON_1 ? [{ id: LESSON_1, unit_id: UNIT_A1, status: 'active', unit_status: 'active' }] : [], []];
    }
    if (n.startsWith('SELECT l.id,l.unit_id,l.title,l.status,')) return [[LESSON_1,LESSON_2].includes(params[0]) && params[1]===UNIT_A1 && params[2]===COURSE_A1
      ? [{id:params[0],unit_id:UNIT_A1,title:'Synthetic lesson',status:'active',unit_status:'active',release_at_epoch:state.release.get(params[0])}]:[],[]];
    if (n.startsWith('SELECT l.id,l.status,u.status AS unit_status,UNIX_TIMESTAMP(l.release_at) AS release_at_epoch')) {
      const lesson = String(params[0]).toLowerCase();
      return [lesson === LESSON_2 ? [{ id: LESSON_2, status: 'active', unit_status: 'active', release_at_epoch: state.release.get(LESSON_2) }] : [], []];
    }

    if (n.startsWith('SELECT id,name,status,head_revision FROM lesson_package_templates WHERE tenant_id=? AND course_id=? AND status=')) {
      const rows = state.templates.filter(row => row.tenant_id === params[0] && row.course_id === params[1] && row.status === 'active' && row.id > params[2])
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(params[3]));
      return [rows.map(row => ({ id: row.id, name: row.name, status: row.status, head_revision: row.head_revision })), []];
    }
    if (n.startsWith('SELECT id FROM lesson_package_templates WHERE tenant_id=? AND course_id=? AND name=?')) {
      return [state.templates.filter(row => row.tenant_id === params[0] && row.course_id === params[1] && row.name === params[2]).map(row => ({ id: row.id })), []];
    }
    if (n.startsWith('SELECT id,status,head_revision FROM lesson_package_templates WHERE id=? AND tenant_id=? AND course_id=?')) {
      return [state.templates.filter(row => row.id === params[0] && row.tenant_id === params[1] && row.course_id === params[2])
        .map(row => ({ id: row.id, status: row.status, head_revision: row.head_revision })), []];
    }
    if (n.startsWith('SELECT id,name,status,head_revision FROM lesson_package_templates WHERE id=? AND tenant_id=? AND course_id=?')) {
      return [state.templates.filter(row => row.id === params[0] && row.tenant_id === params[1] && row.course_id === params[2])
        .map(row => ({ id: row.id, name: row.name, status: row.status, head_revision: row.head_revision })), []];
    }
    if (n.startsWith('SELECT revision_number,source_lesson_id,reference_count,media_count FROM lesson_package_template_revisions WHERE template_id=?')) {
      return [state.revisions.filter(row => row.template_id === params[0] && row.tenant_id === params[1] && row.course_id === params[2] && row.revision_number > Number(params[3]))
        .sort((a, b) => a.revision_number - b.revision_number).slice(0, Number(params[4])), []];
    }
    if (n.startsWith('SELECT id,source_lesson_id,reference_count,media_count,content_hash FROM lesson_package_template_revisions WHERE template_id=?')) {
      return [state.revisions.filter(row => row.template_id === params[0] && row.tenant_id === params[1] && row.course_id === params[2] && row.revision_number === Number(params[3]))
        .map(row => ({ id: row.id, source_lesson_id: row.source_lesson_id, reference_count: row.reference_count, media_count: row.media_count, content_hash: row.content_hash })), []];
    }
    if (n.startsWith('SELECT kind,source_id,display_order FROM lesson_package_template_references WHERE revision_id=?')) {
      return [state.references.filter(row => row.revision_id === params[0]).map(row => ({ kind: row.kind, source_id: row.source_id, display_order: row.display_order })), []];
    }

    if (n.startsWith('SELECT id,') && n.includes('FROM course_lesson_contents')) {
      const store = state.bindings[String(params[0])];
      return [store ? store.material.map(row => ({ id: row.id, source_id: row.source_id, display_order: row.display_order })) : [], []];
    }
    if (n.startsWith('SELECT id,') && n.includes('FROM course_lesson_videos')) {
      const store = state.bindings[String(params[0])];
      return [store ? store.video.map(row => ({ id: row.id, source_id: row.source_id, display_order: row.display_order })) : [], []];
    }
    if (n.startsWith('SELECT id,') && n.includes('FROM course_lesson_announcements')) {
      const store = state.bindings[String(params[0])];
      return [store ? store.announcement.map(row => ({ id: row.id, source_id: row.source_id, display_order: null })) : [], []];
    }
    if (n.startsWith('SELECT id,kind,assignment_id,exam_id FROM course_lesson_activities')) {
      const store = state.bindings[String(params[0])];
      return [store ? store.activity.map(row => ({ id: row.id, kind: row.kind, assignment_id: row.kind === 'homework' ? row.source_id : null, exam_id: row.kind === 'quiz' ? row.source_id : null })) : [], []];
    }
    if (n.startsWith('SELECT id,title,material_type,is_published FROM course_materials')) {
      return [state.available && String(params[0]).toLowerCase() === MATERIAL && params[1] === COURSE_A1
        ? [{ id: MATERIAL, title: state.title, material_type: 'pdf', is_published: 1 }] : [], []];
    }
    if(n.startsWith('SELECT v.id,v.title')) return [state.available && params[0]===uid(20)&&params[1]===COURSE_A1&&params[2]===TENANT_A?[{id:uid(20),title:'video'}]:[],[]];
    if(n.startsWith('SELECT id FROM lectures')||n.startsWith('SELECT id FROM course_materials'))return [[],[]];
    if(n.startsWith('SELECT s.id,s.title,')&&n.includes('FROM assignments'))return [[{id:uid(30),title:'homework',status:'published',group_id:null,branch_id:null,branch_scope:'tenant'}],[]];
    if(n.startsWith('SELECT s.id,s.title,')&&n.includes('FROM exams'))return [[{id:uid(40),title:'quiz',is_published:1}],[]];
    if(n.includes('FROM exam_groups eg'))return [state.quizGroups,[]];
    if(n.startsWith('SELECT id,exam_id FROM course_lesson_activities'))return [state.bindings[params[1]]?.activity.filter(row=>row.id===params[0]&&row.kind==='quiz').map(row=>({id:row.id,exam_id:row.source_id}))??[],[]];
    if(n.startsWith('SELECT content_id,exam_id,exam_version_id FROM course_lesson_quiz_versions'))return [state.pin?[state.pin]:[],[]];
    if(n.startsWith('SELECT id,version FROM exam_versions'))return [state.pin&&params[0]===state.pin.exam_version_id&&params[1]===state.pin.exam_id&&params[2]===TENANT_A?[{id:state.pin.exam_version_id,version:1}]:[],[]];
    if(n.includes('FROM group_announcements a'))return [[{id:uid(50),title:'notice',body:'reviewed notice',state:'draft',tenant_id:TENANT_A,group_id:uid(70),group_name:'group',course_id:COURSE_A1,branch_scope:'tenant',branch_id:null}],[]];

    if (n.startsWith('SELECT actor_user_id,course_id,lesson_id,template_id,revision_number,timing_mode,release_at_epoch,request_hash,created_count,existing_count FROM lesson_template_operations')) {
      return [state.operations.filter(row => row.tenant_id === params[0] && row.operation_id === params[1]), []];
    }

    if(n.startsWith('SELECT actor_user_id,course_id,operation_kind')) return [state.libraryOperations.filter(row=>row.tenant_id===params[0]&&row.operation_id===params[1]),[]];
    if(n.startsWith('INSERT INTO lesson_template_library_operations')) {
     const fields=['tenant_id','operation_id','actor_user_id','course_id','operation_kind','template_id','request_hash','result_template_id','result_name','result_status','result_head_revision','result_revision_number','result_reference_count','result_media_count','result_unchanged'];
     state.libraryOperations.push(Object.fromEntries(fields.map((field,i)=>[field,params[i]])));return [{affectedRows:1},[]];
    }
    if (n.startsWith('INSERT INTO lesson_package_templates')) {
      state.templates.push({ id: params[0], tenant_id: params[1], course_id: params[2], name: params[3], status: 'active', head_revision: 1 });
      return [{ affectedRows: 1 }];
    }
    if (n.startsWith('INSERT INTO lesson_package_template_revisions')) {
      state.revisions.push({ id: params[0], template_id: params[1], tenant_id: params[2], course_id: params[3], revision_number: Number(params[4]), source_lesson_id: params[5], reference_count: Number(params[7]), media_count: Number(params[8]), content_hash:params[9] });
      return [{ affectedRows: 1 }];
    }
    if (n.startsWith('INSERT INTO lesson_package_template_references')) {
      state.references.push({ id: params[0], revision_id: params[1], kind: params[2], source_id: params[3], display_order: params[4] });
      return [{ affectedRows: 1 }];
    }
    if (n.startsWith('INSERT INTO lesson_package_contents') || n.startsWith('INSERT INTO course_lesson_contents') || n.startsWith('INSERT INTO course_lesson_videos') || n.startsWith('INSERT INTO course_lesson_announcements') || n.startsWith('INSERT INTO course_lesson_activities')) {
      return [insertBinding(n, params), []];
    }
    if (n.startsWith('INSERT INTO lesson_template_operations')) {
      state.operations.push({
        tenant_id: params[0], operation_id: params[1], actor_user_id: params[2], course_id: params[3], lesson_id: params[4],
        template_id: params[5], revision_number: Number(params[6]), timing_mode: params[7], release_at_epoch: params[8],
        request_hash: params[9], created_count: Number(params[10]), existing_count: Number(params[11]),
      });
      return [{ affectedRows: 1 }];
    }
    if (n.startsWith('INSERT INTO audit_events')) {
      state.audits += 1;
      return [{ affectedRows: 1 }];
    }

    if (n.startsWith('UPDATE lesson_package_templates SET head_revision=?')) {
      const row = state.templates.find(row => row.id === params[1] && row.tenant_id === params[2] && row.course_id === params[3] && row.head_revision === Number(params[4]) && row.status === 'active');
      if (!row) return [{ affectedRows: 0 }];
      row.head_revision = Number(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (n.startsWith("UPDATE lesson_package_templates SET status='archived'")) {
      const row = state.templates.find(row => row.id === params[0] && row.tenant_id === params[1] && row.course_id === params[2] && row.status === 'active');
      if (!row) return [{ affectedRows: 0 }];
      row.status = 'archived';
      return [{ affectedRows: 1 }];
    }
    if (n === 'UPDATE course_lessons SET release_at=NULL WHERE id=? AND unit_id=?') {
      state.release.set(String(params[0]).toLowerCase(), null);
      return [{ affectedRows: 1 }];
    }
    if (n.startsWith('UPDATE course_lessons SET release_at=FROM_UNIXTIME(?)')) {
      state.release.set(String(params[1]).toLowerCase(), Number(params[0]));
      return [{ affectedRows: 1 }];
    }

    throw Error(`Unhandled SQL in template fixture: ${n}`);
  };

  // Serialize synthetic transactions; preserve committed rows on lost ACK.
  let tail=Promise.resolve();
  const getConnection=async()=>{
   let snapshot:any,unlock!:()=>void;
   return { execute,
    beginTransaction:async()=>{const prior=tail;tail=new Promise<void>(resolve=>{unlock=resolve;});await prior;state.events.push('begin');snapshot=structuredClone({returnHeads:state.returnHeads,returnRevisions:state.returnRevisions,returnOperations:state.returnOperations,templates:state.templates,revisions:state.revisions,references:state.references,operations:state.operations,libraryOperations:state.libraryOperations,bindings:state.bindings,release:state.release,audits:state.audits});},
    commit:async()=>{state.events.push('commit');snapshot=null;if(state.loseCommit){state.loseCommit=false;throw Error('Synthetic lost commit ACK');}},
    rollback:async()=>{state.events.push('rollback');if(snapshot)Object.assign(state,snapshot);snapshot=null;},
    release:()=>{state.events.push('release');unlock?.();},destroy:()=>{state.events.push('destroy');unlock?.();},
   };
  };
  const router = routerFactory({ getConnection }) as any;
  return { state, router };
}

