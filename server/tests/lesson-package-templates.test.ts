import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { makeReq, runChain, COURSE_A1, UNIT_A1, LESSON_1, LESSON_2, OWNER_A, TENANT_A, withSilencedErrors } from './helpers/m2-course-lessons-harness';
import { createLessonPackageTemplatesRouter } from '../src/routes/lesson-package-templates';

const MATERIAL = 'b9000000-0000-4000-8000-000000000001';
const OPERATION = 'b9000000-0000-4000-8000-000000000090';

const TEMPLATE_COLUMNS = ['id', 'tenant_id', 'course_id', 'name', 'status', 'head_revision', 'created_by', 'created_at', 'updated_at', 'archived_at'];
const REVISION_COLUMNS = ['id', 'template_id', 'tenant_id', 'course_id', 'revision_number', 'source_lesson_id', 'created_by', 'reference_count', 'media_count', 'content_hash', 'created_at'];
const REFERENCE_COLUMNS = ['id', 'revision_id', 'kind', 'source_id', 'display_order'];
const OPERATION_COLUMNS = ['tenant_id', 'operation_id', 'actor_user_id', 'course_id', 'lesson_id', 'template_id', 'revision_number', 'timing_mode', 'release_at_epoch', 'request_hash', 'created_count', 'existing_count'];

const COLUMNS: Record<string, string[]> = {
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

// Physical metadata is derived from the unapplied DDL, independently of service specs.
const ddlColumns:any[]=[];
for(const file of ['20261106_10_lesson_package_templates.sql','20261106_11_lesson_template_operations.sql']) {
 const ddl=readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8');
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
const uid = (n: number) => `b9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture(options: { schema?: boolean } = {}) {
  const state = {
    schema: options.schema !== false,
    columnOverride: null as null | ((row:any)=>any), indexes:true, foreignKeys:true, engine:'InnoDB', available:true, quizGroups:[] as any[], title:'Synthetic material', failSQL: '', loseCommit:false, events:[] as string[], libraryOperations:[] as any[],
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
      {table_name:'lesson_package_template_revisions',column_name:'template_id',referenced_table:'lesson_package_templates',referenced_column:'id',delete_rule:'RESTRICT'},
      {table_name:'lesson_package_template_references',column_name:'revision_id',referenced_table:'lesson_package_template_revisions',referenced_column:'id',delete_rule:'RESTRICT'},
      { column_name: 'lesson_id', referenced_table: 'course_lessons', referenced_column: 'id', delete_rule: 'CASCADE', table_name:'course_lesson_announcements' },
      { column_name: 'announcement_id', referenced_table: 'group_announcements', referenced_column: 'id', delete_rule: 'CASCADE', table_name:'course_lesson_announcements' },
    ].filter(row=>(state.foreignKeys || row.table_name==='course_lesson_announcements') && (!n.includes("k.TABLE_NAME='course_lesson_announcements'")||row.table_name==='course_lesson_announcements')), []];
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
    beginTransaction:async()=>{const prior=tail;tail=new Promise<void>(resolve=>{unlock=resolve;});await prior;state.events.push('begin');snapshot=structuredClone({templates:state.templates,revisions:state.revisions,references:state.references,operations:state.operations,libraryOperations:state.libraryOperations,bindings:state.bindings,release:state.release,audits:state.audits});},
    commit:async()=>{state.events.push('commit');snapshot=null;if(state.loseCommit){state.loseCommit=false;throw Error('Synthetic lost commit ACK');}},
    rollback:async()=>{state.events.push('rollback');if(snapshot)Object.assign(state,snapshot);snapshot=null;},
    release:()=>{state.events.push('release');unlock?.();},destroy:()=>{state.events.push('destroy');unlock?.();},
   };
  };
  const router = createLessonPackageTemplatesRouter({ getConnection }) as any;
  return { state, router };
}

const owner = () => ({ id: OWNER_A, tenantId: TENANT_A, role: 'instructor' });

function request(router: any, method: string, pathName: string, body: any = {}, extra: any = {}) {
  if ((method === 'POST' && (pathName.endsWith('/lesson-templates') || pathName.endsWith('/revisions')) || method === 'PATCH') && !Object.hasOwn(body,'operation_id')) body={...body,operation_id:randomUUID()};
  const req: any = makeReq({ method, pathName, body, query: extra.query ?? {}, headers: extra.headers, token: null });
  req.user = extra.user ?? owner();
  req.params = req.params ?? {};
  return runChain([router as RequestHandler], req);
}

async function createTemplate(router: any, name = 'First template') {
  return request(router, 'POST', `/courses/${COURSE_A1}/lesson-templates`, {
    name, source_lesson_id: LESSON_1, selections: [{ kind: 'material', source_id: MATERIAL }],
  });
}

test('lesson template routes require the verified owner and reject selector authority', async () => {
  const h = fixture();
  const foreign = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {}, { user: { id: 'instructor-not-owner', tenantId: TENANT_A } });
  assert.equal(foreign.status, 403);
  const billing = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {}, { user: { ...owner(), billingOnly: true } });
  assert.equal(billing.status, 403);
  const selector = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {}, { user: owner(), headers: { 'x-tenant-id': TENANT_A } });
  assert.equal(selector.status, 400);
});

test('create, list, revise and archive keep immutable revisions inside the same course', async () => {
  const h = fixture();
  const created = await createTemplate(h.router);
  assert.equal(created.status, 201);
  const templateId = created.body.template.id;
  assert.equal(created.body.template.head_revision, 1);

  const listed = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {});
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.templates.map((row: any) => row.id), [templateId]);

  const duplicate = await createTemplate(h.router);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'TEMPLATE_NAME_EXISTS');

  const revised = await request(h.router, 'POST', `/courses/${COURSE_A1}/lesson-templates/${templateId}/revisions`, {
    source_lesson_id: LESSON_1, selections: [{ kind: 'material', source_id: MATERIAL }], expected_revision: 1,
  });
  assert.equal(revised.status, 201);
  assert.equal(revised.body.revision.revision_number, 2);

  const revisions = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates/${templateId}/revisions`, {});
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.body.revisions.map((row: any) => row.revision_number), [1, 2]);

  const archived = await request(h.router, 'PATCH', `/courses/${COURSE_A1}/lesson-templates/${templateId}`, { status: 'archived' });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.template.status, 'archived');

  const after = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates`, {});
  assert.equal(after.body.templates.length, 0);
  const applyArchived = await request(h.router, 'POST', `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-review`, {
    template_id: templateId, revision_number: 2, timing: { mode: 'keep' },
  });
  assert.equal(applyArchived.status, 409);
  assert.equal(applyArchived.body.code, 'TEMPLATE_ARCHIVED');
});

test('review/apply is explicit, timing changes only the destination, and replay does not duplicate references', async () => {
  const h = fixture();
  const created = await createTemplate(h.router);
  const templateId = created.body.template.id;
  const reviewPath = `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-review`;
  const applyPath = `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-apply`;

  const review = await request(h.router, 'POST', reviewPath, { template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' } });
  assert.equal(review.status, 200);
  assert.equal(review.body.can_apply, true);
  assert.equal(review.body.items[0].outcome, 'add');
  assert.equal(review.body.items[0].audience, 'course');
  assert.equal(review.body.timing.current_release_at, null);
  assert.equal(review.body.timing.proposed_release_at, '2026-12-01T10:00:00.000Z');

  const wrongToken = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' },
    review_token: 'f'.repeat(64), operation_id: OPERATION,
  });
  assert.equal(wrongToken.status, 409);
  assert.equal(wrongToken.body.code, 'TEMPLATE_REVIEW_CHANGED');

  const applied = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' },
    review_token: review.body.review_token, operation_id: OPERATION,
  });
  assert.equal(applied.status, 201);
  assert.deepEqual({ created: applied.body.created, existing: applied.body.existing, replayed: applied.body.replayed }, { created: 1, existing: 0, replayed: false });
  assert.equal(h.state.release.get(LESSON_2), Math.floor(Date.parse('2026-12-01T10:00:00Z') / 1000));
  assert.equal(h.state.release.get(LESSON_1), 1_700_000_000);
  assert.equal(h.state.bindings[LESSON_2].material.length, 1);
  assert.equal(h.state.audits, 2);

  const replay = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'set', release_at: '2026-12-01T10:00:00Z' },
    review_token: review.body.review_token, operation_id: OPERATION,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(h.state.bindings[LESSON_2].material.length, 1);

  const reusedIdentity = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'clear', release_at: null },
    review_token: review.body.review_token, operation_id: OPERATION,
  });
  assert.equal(reusedIdentity.status, 409);
  assert.equal(reusedIdentity.body.code, 'TEMPLATE_OPERATION_CONFLICT');
  assert.equal(h.state.bindings[LESSON_2].material.length, 1);

  const status = await request(h.router, 'GET', `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-operations/${OPERATION}`, {});
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.operation.created, 1);

  const cleared = await request(h.router, 'POST', reviewPath, { template_id: templateId, revision_number: 1, timing: { mode: 'clear', release_at: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.items[0].outcome, 'present');
  const clearApply = await request(h.router, 'POST', applyPath, {
    template_id: templateId, revision_number: 1, timing: { mode: 'clear', release_at: null },
    review_token: cleared.body.review_token, operation_id: uid(91),
  });
  assert.equal(clearApply.status, 201);
  assert.equal(clearApply.body.created, 0);
  assert.equal(clearApply.body.existing, 1);
  assert.equal(h.state.release.get(LESSON_2), null);
});

test('templates from another course or tenant are not addressable', async () => {
  const h = fixture();
  const created = await createTemplate(h.router);
  const templateId = created.body.template.id;
  const review = await request(h.router, 'POST', `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-review`, {
    template_id: templateId, revision_number: 1, timing: { mode: 'keep' },
  });
  assert.equal(review.status, 200);
  h.state.templates[0].tenant_id = 'tenant-b';
  const foreign = await request(h.router, 'GET', `/courses/${COURSE_A1}/lesson-templates/${templateId}/revisions`, {});
  assert.equal(foreign.status, 404);
});

test('schema absence fails closed instead of creating partial template writes', async () => {
  const h = fixture({ schema: false });
  const response = await withSilencedErrors(() => createTemplate(h.router));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'LESSON_TEMPLATES_UNAVAILABLE');
  assert.equal(h.state.templates.length, 0);
  assert.equal(h.state.audits, 0);
});

const libraryPath = `/courses/${COURSE_A1}/lesson-templates`;
const applicationPath = `/courses/${COURSE_A1}/units/${UNIT_A1}/lessons/${LESSON_2}/lesson-template-`;
const createBody = (operation_id = OPERATION) => ({ name:'Recoverable',source_lesson_id:LESSON_1,selections:[{kind:'material',source_id:MATERIAL}],operation_id });
async function prepared(h: ReturnType<typeof fixture>, timing:any={mode:'set',release_at:'2026-12-01T10:00:00Z'}) {
  const created=await createTemplate(h.router); assert.equal(created.status,201);
  const body={template_id:created.body.template.id,revision_number:1,timing};
  const review=await request(h.router,'POST',applicationPath+'review',body); assert.equal(review.status,200);
  return {...body,review_token:review.body.review_token,operation_id:OPERATION};
}

for(const kind of ['create','revise','archive'] as const) {
  test(`${kind}: lost commit ACK preserves one durable operation; GET recovers and exact replay adds no write`,async()=>{
    const h=fixture();let path=libraryPath,method='POST',body:any=createBody();
    if(kind!=='create') {
      const first=await createTemplate(h.router);assert.equal(first.status,201);path+='/'+first.body.template.id;
      if(kind==='revise'){path+='/revisions';body={source_lesson_id:LESSON_1,selections:createBody().selections,expected_revision:1,operation_id:OPERATION};}
      else {method='PATCH';body={status:'archived',operation_id:OPERATION};}
    }
    h.state.loseCommit=true;
    const response=await withSilencedErrors(()=>request(h.router,method,path,body));
    assert.equal(response.status,500);assert.equal(response.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.state.events.at(-1),'destroy');
    const before=structuredClone({templates:h.state.templates,revisions:h.state.revisions,audits:h.state.audits});
    const status=await request(h.router,'GET',libraryPath+'/operations/'+OPERATION);
    assert.equal(status.status,200);assert.equal(status.body.operation.operation_kind,kind);assert.equal(status.body.operation.operation_id,OPERATION);
    const replay=await request(h.router,method,path,body);assert.equal(replay.status,200);
    assert.deepEqual({templates:h.state.templates,revisions:h.state.revisions,audits:h.state.audits},before);
    assert.equal(h.state.libraryOperations.filter(row=>row.operation_id===OPERATION).length,1);
    h.state.libraryOperations.find(row=>row.operation_id===OPERATION).actor_user_id='another-owner';
    assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION)).status,409);
  });
}
test('library operation is payload/kind bound and concurrent identical creates commit once',async()=>{
  const h=fixture(),body=createBody();
  const responses=await Promise.all([request(h.router,'POST',libraryPath,body),request(h.router,'POST',libraryPath,body)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);assert.equal(h.state.audits,1);assert.equal(h.state.templates.length,1);
  assert.equal((await request(h.router,'POST',libraryPath,{...body,name:'Changed'})).status,409);
  assert.notEqual((await request(h.router,'PATCH',libraryPath+'/'+h.state.templates[0].id,{status:'archived',operation_id:OPERATION})).status,200);
  assert.equal(h.state.templates[0].status,'active');
});
test('already archived receipt is committed without another audit',async()=>{
  const h=fixture();const c=await createTemplate(h.router);const path=libraryPath+'/'+c.body.template.id;
  await request(h.router,'PATCH',path,{status:'archived'});
  const r=await request(h.router,'PATCH',path,{status:'archived',operation_id:OPERATION});assert.equal(r.body.unchanged,true);
  assert.equal(h.state.audits,2);assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION)).body.operation.unchanged,true);
});
for(const failure of ['INSERT INTO lesson_package_template_revisions','INSERT INTO audit_events','INSERT INTO lesson_template_library_operations']) {
  test(`create failure at ${failure} restores template, version, references, audit and receipt`,async()=>{
    const h=fixture();h.state.failSQL=failure;
    const r=await withSilencedErrors(()=>createTemplate(h.router));assert.equal(r.status,500);
    for(const rows of [h.state.templates,h.state.revisions,h.state.references,h.state.libraryOperations])assert.equal(rows.length,0);
    assert.equal(h.state.audits,0);assert.ok(h.state.events.includes('rollback'));
  });
}
for(const failure of ['INSERT INTO course_lesson_contents','UPDATE course_lessons SET release_at','INSERT INTO audit_events','INSERT INTO lesson_template_operations']) {
  test(`apply failure at ${failure} restores every reference, timing, audit and receipt`,async()=>{
    const h=fixture(),body=await prepared(h);const before=structuredClone({bindings:h.state.bindings,release:h.state.release,audits:h.state.audits});h.state.failSQL=failure;
    const r=await withSilencedErrors(()=>request(h.router,'POST',applicationPath+'apply',body));assert.equal(r.status,500);
    assert.deepEqual({bindings:h.state.bindings,release:h.state.release,audits:h.state.audits},before);assert.equal(h.state.operations.length,0);assert.ok(h.state.events.includes('rollback'));
  });
}
test('apply lost commit recovers exact destination/version/timing; replay is single mutation',async()=>{
  const h=fixture(),body=await prepared(h);h.state.loseCommit=true;
  const r=await withSilencedErrors(()=>request(h.router,'POST',applicationPath+'apply',body));assert.equal(r.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.state.events.at(-1),'destroy');
  const status=await request(h.router,'GET',applicationPath+'operations/'+OPERATION);assert.equal(status.body.operation.context.template_id,body.template_id);assert.equal(status.body.operation.context.lesson_id,LESSON_2);
  assert.equal((await request(h.router,'POST',applicationPath+'apply',body)).status,200);assert.equal(h.state.operations.length,1);assert.equal(h.state.audits,2);
});
for(const corrupt of [
  (h:any)=>h.state.references[0].display_order=null,
  (h:any)=>h.state.references[0].display_order=1.5,
  (h:any)=>h.state.references[0].display_order=-1,
  (h:any)=>h.state.references[0].display_order=2147483648,
  (h:any)=>h.state.references[0].display_order='0',
  (h:any)=>h.state.references[0].kind='homework',
  (h:any)=>h.state.references.push({...h.state.references[0],source_id:uid(99)}),
  (h:any)=>h.state.revisions[0].reference_count=2,
  (h:any)=>h.state.revisions[0].media_count=0,
  (h:any)=>h.state.revisions[0].content_hash='0'.repeat(64),
  (h:any)=>h.state.revisions[0].id='invalid',
]) test('corrupt saved snapshot is rejected before mutation',async()=>{
  const h=fixture(),body=await prepared(h);corrupt(h);
  const r=await withSilencedErrors(()=>request(h.router,'POST',applicationPath+'apply',body));assert.equal(r.status,500);assert.equal(h.state.operations.length,0);assert.equal(h.state.bindings[LESSON_2].material.length,0);assert.equal(h.state.audits,1);
});
for(const override of [
  (row:any)=>({...row,data_type:'varchar',max_length:1,is_nullable:'YES'}),
  (row:any)=>row.column_name==='name'?{...row,max_length:1}:row,
  (row:any)=>row.column_name==='content_hash'?{...row,collation_name:'utf8mb4_general_ci'}:row,
  (row:any)=>row.column_name==='display_order'?{...row,is_nullable:'NO'}:row,
  (row:any)=>row.column_name==='kind'?{...row,column_type:"enum('material')"}:row,
])test('incompatible physical template column contract fails closed',async()=>{
  const h=fixture();h.state.columnOverride=override;assert.equal((await createTemplate(h.router)).status,503);assert.equal(h.state.templates.length,0);
});
for(const option of ['indexes','foreignKeys','engine'] as const)test(`missing ${option} fails closed`,async()=>{
  const h=fixture();if(option==='engine')h.state.engine='MyISAM';else h.state[option]=false;
  assert.equal((await createTemplate(h.router)).status,503);assert.equal(h.state.templates.length,0);
});
test('all five kinds preserve their audience and positions; no pin/publication/history is copied',async()=>{
  const h=fixture(),source=h.state.bindings[LESSON_1];source.video.push({id:uid(120),source_id:uid(20),display_order:1});
  source.activity.push({id:uid(130),kind:'homework',source_id:uid(30),display_order:null},{id:uid(140),kind:'quiz',source_id:uid(40),display_order:null});
  source.announcement.push({id:uid(150),source_id:uid(50),display_order:null});
  const selections=[{kind:'material',source_id:MATERIAL},...['video','homework','quiz','announcement'].map((kind,i)=>({kind,source_id:uid((i+2)*10)}))];
  const c=await request(h.router,'POST',libraryPath,{...createBody(),selections});assert.equal(c.status,201);assert.equal(c.body.revision.reference_count,5);
  const body={template_id:c.body.template.id,revision_number:1,timing:{mode:'keep'}};
  const review=await request(h.router,'POST',applicationPath+'review',body);assert.equal(review.status,200);assert.equal(review.body.can_apply,true);assert.equal(review.body.items.find((r:any)=>r.kind==='announcement').audience,'restricted');
  const applied=await request(h.router,'POST',applicationPath+'apply',{...body,review_token:review.body.review_token,operation_id:uid(91)});assert.equal(applied.status,201);assert.equal(applied.body.created,5);assert.equal(h.state.bindings[LESSON_2].video[0].display_order,1);assert.equal(h.state.audits,2);
});
test('changed source facts or destination positions invalidate review without partial effects',async()=>{
  for(const change of ['title','destination']) {
    const h=fixture(),body=await prepared(h);
    if(change==='title')h.state.title='Changed';else h.state.bindings[LESSON_2].material.push({id:uid(88),source_id:uid(89),display_order:0});
    const r=await request(h.router,'POST',applicationPath+'apply',body);assert.equal(r.status,409);assert.equal(h.state.operations.length,0);assert.equal(h.state.audits,1);
  }
});

for(const kind of ['revise','archive'])for(const failure of ['INSERT INTO audit_events','INSERT INTO lesson_template_library_operations'])test(`${kind} rolls back head/status and version rows on ${failure}`,async()=>{
  const h=fixture(),c=await createTemplate(h.router),templateId=c.body.template.id;
  const before=structuredClone({templates:h.state.templates,revisions:h.state.revisions,references:h.state.references,libraryOperations:h.state.libraryOperations,audits:h.state.audits});
  h.state.failSQL=failure;
  const r=await withSilencedErrors(()=>request(h.router,kind==='revise'?'POST':'PATCH',libraryPath+'/'+templateId+(kind==='revise'?'/revisions':''),kind==='revise'?{source_lesson_id:LESSON_1,selections:createBody().selections,expected_revision:1}:{status:'archived'}));
  assert.equal(r.status,500);assert.deepEqual({templates:h.state.templates,revisions:h.state.revisions,references:h.state.references,libraryOperations:h.state.libraryOperations,audits:h.state.audits},before);
});
test('competing revisions use the expected head; one version advances with no stale audit or receipt',async()=>{
  const h=fixture(),c=await createTemplate(h.router),path=libraryPath+'/'+c.body.template.id+'/revisions';
  const body={source_lesson_id:LESSON_1,selections:createBody().selections,expected_revision:1};
  const results=await Promise.all([request(h.router,'POST',path,body),request(h.router,'POST',path,body)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(h.state.templates[0].head_revision,2);assert.equal(h.state.revisions.length,2);assert.equal(h.state.audits,2);assert.equal(h.state.libraryOperations.length,2);
});
test('timing and audience changes make the review stale; no mutation or receipt is produced',async()=>{
  for(const kind of ['timing','audience']) {
    const h=fixture();
    if(kind==='timing') {const body=await prepared(h);h.state.release.set(LESSON_2,1800000000);const r=await request(h.router,'POST',applicationPath+'apply',body);assert.equal(r.status,409);assert.equal(h.state.release.get(LESSON_2),1800000000);}
    else {
      h.state.bindings[LESSON_1].activity.push({id:uid(140),kind:'quiz',source_id:uid(40),display_order:null});
      const c=await request(h.router,'POST',libraryPath,{...createBody(),selections:[{kind:'quiz',source_id:uid(40)}]});assert.equal(c.status,201);
      const body={template_id:c.body.template.id,revision_number:1,timing:{mode:'keep'}};
      const review=await request(h.router,'POST',applicationPath+'review',body);assert.equal(review.status,200);
      h.state.quizGroups=[{id:uid(70),exam_id:uid(40),course_id:COURSE_A1,branch_scope:'tenant',branch_id:null}];
      const r=await request(h.router,'POST',applicationPath+'apply',{...body,review_token:review.body.review_token,operation_id:OPERATION});assert.equal(r.status,409);assert.equal(h.state.bindings[LESSON_2].activity.length,0);
    }
    assert.equal(h.state.operations.length,0);assert.equal(h.state.audits,1);assert.equal(h.state.bindings[LESSON_2].material.length,0);
  }
});
for(const kind of ['position','capacity','singleton','unavailable'])test(`template final-state ${kind} conflict has no partial effects`,async()=>{
  const h=fixture();let selected:any=createBody().selections;
  if(kind==='singleton'){h.state.bindings[LESSON_1].activity.push({id:uid(140),kind:'quiz',source_id:uid(40),display_order:null});selected=[{kind:'quiz',source_id:uid(40)}];}
  const c=await request(h.router,'POST',libraryPath,{...createBody(),selections:selected});assert.equal(c.status,201);
  if(kind==='position')h.state.bindings[LESSON_2].material.push({id:uid(110),source_id:uid(100),display_order:0});
  if(kind==='capacity')h.state.bindings[LESSON_2].material=Array.from({length:20},(_,i)=>({id:uid(i+110),source_id:uid(i+210),display_order:i+1}));
  if(kind==='singleton')h.state.bindings[LESSON_2].activity.push({id:uid(141),kind:'quiz',source_id:uid(41),display_order:null});
  if(kind==='unavailable')h.state.available=false;
  const before=structuredClone({bindings:h.state.bindings,release:h.state.release});const body={template_id:c.body.template.id,revision_number:1,timing:{mode:'clear',release_at:null}};
  const review=await request(h.router,'POST',applicationPath+'review',body);assert.equal(review.status,200);assert.equal(review.body.can_apply,false);
  const r=await request(h.router,'POST',applicationPath+'apply',{...body,review_token:review.body.review_token,operation_id:uid(91)});assert.equal(r.status,409);assert.deepEqual({bindings:h.state.bindings,release:h.state.release},before);assert.equal(h.state.operations.length,0);assert.equal(h.state.audits,1);
});
test('receipt lookup remains private and malformed operation inputs never write',async()=>{
  const h=fixture();
  assert.equal((await request(h.router,'POST',libraryPath,{...createBody(),operation_id:null})).status,400);
  const c=await createTemplate(h.router);assert.equal(c.status,201);
  assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION,{}, {user:{...owner(),tenantId:'foreign'}})).status,403);
  assert.equal((await request(h.router,'GET',`/courses/${uid(999)}/lesson-templates/operations/${OPERATION}`)).status,404);
  assert.equal((await request(h.router,'GET',libraryPath+'/operations/'+OPERATION)).body.operation,null);
  assert.equal(h.state.audits,1);assert.equal(h.state.templates.length,1);
});
