import { createHash, randomUUID } from 'crypto';
import type { CourseLessonConnection } from '../routes/course-lessons';
import {
  insertLessonPackageReference,
  lessonPackageReferenceSchema,
  packageKinds,
  planLessonPackageFinalState,
  readLessonPackageBindings,
  readLessonPackageSource,
  validatePackageBindings,
  type PackageBinding,
  type PackageSelection,
} from './lesson-package-reuse';
import { recordAudit, snapshotRow } from '../security/audit';
import {
  parseTiming,
  renderReleaseInstant,
  timingEpoch,
  timingReview,
  type TimingInput,
} from './lesson-package-timing';

const uuid = (x: unknown): x is string =>
  typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const result = (status: number, body: any, commit = false) => ({ status, body, commit });
const unavailable = () => result(503, { error: 'Lesson package templates schema unavailable', code: 'LESSON_TEMPLATES_UNAVAILABLE' });
const exact = (x: any, fields: string[]) =>
  x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === fields.slice().sort().join(',');

export type TemplateOperation = 'list' | 'create' | 'revise' | 'revisions' | 'archive';
export type TemplateApplyOperation = 'review' | 'apply' | 'status';

export interface TemplateCreateBody {
  name: string;
  source_lesson_id: string;
  selections: PackageSelection[];
  operation_id: string;
}
export interface TemplateRevisionBody {
  source_lesson_id: string;
  selections: PackageSelection[];
  expected_revision: number;
  operation_id: string;
}
export interface TemplateApplicationBody {
  template_id: string;
  revision_number: number;
  timing: TimingInput;
  review_token?: string;
  operation_id?: string;
}

function parseSelections(raw: unknown): PackageSelection[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 23) return null;
  const selections: PackageSelection[] = [];
  for (const row of raw) {
    if (!exact(row, ['kind', 'source_id']) || !packageKinds.includes(row.kind) || !uuid(row.source_id)) return null;
    selections.push({ kind: row.kind, source_id: row.source_id.toLowerCase() });
  }
  if (
    new Set(selections.map(row => `${row.kind}/${row.source_id}`)).size !== selections.length ||
    selections.filter(row => ['material', 'video'].includes(row.kind)).length > 20 ||
    ['homework', 'quiz', 'announcement'].some(kind => selections.filter(row => row.kind === kind).length > 1)
  ) return null;
  selections.sort((a, b) => packageKinds.indexOf(a.kind) - packageKinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
  return selections;
}

export function parseTemplateCreateBody(body: any): TemplateCreateBody | null {
  if (!exact(body, ['name', 'source_lesson_id', 'selections', 'operation_id']) || typeof body.name !== 'string' || !uuid(body.source_lesson_id) || !uuid(body.operation_id)) return null;
  const name = body.name.trim();
  if (name.length < 1 || name.length > 120) return null;
  const selections = parseSelections(body.selections);
  return selections ? { name, source_lesson_id: body.source_lesson_id.toLowerCase(), selections, operation_id: body.operation_id.toLowerCase() } : null;
}

export function parseTemplateRevisionBody(body: any): TemplateRevisionBody | null {
  if (!exact(body, ['source_lesson_id', 'selections', 'expected_revision', 'operation_id'])
    || !uuid(body.source_lesson_id) || !uuid(body.operation_id) || !Number.isInteger(body.expected_revision) || body.expected_revision < 1) return null;
  const selections = parseSelections(body.selections);
  return selections ? { source_lesson_id: body.source_lesson_id.toLowerCase(), selections, expected_revision: body.expected_revision, operation_id: body.operation_id.toLowerCase() } : null;
}

export function parseTemplateArchiveBody(body: any): { status: 'archived'; operation_id: string } | null {
  return exact(body, ['status', 'operation_id']) && body.status === 'archived' && uuid(body.operation_id)
    ? { status: 'archived', operation_id: body.operation_id.toLowerCase() } : null;
}

export function parseTemplateApplicationBody(body: any, apply: boolean): TemplateApplicationBody | null {
  if (!exact(body, ['template_id', 'revision_number', 'timing', ...(apply ? ['review_token', 'operation_id'] : [])])
    || !uuid(body.template_id) || !Number.isInteger(body.revision_number) || body.revision_number < 1) return null;
  const timing = parseTiming(body.timing);
  if (!timing) return null;
  if (apply && (!uuid(body.operation_id) || typeof body.review_token !== 'string' || !/^[a-f\d]{64}$/.test(body.review_token))) return null;
  return {
    template_id: body.template_id.toLowerCase(), revision_number: body.revision_number, timing,
    ...(apply ? { review_token: body.review_token as string, operation_id: body.operation_id.toLowerCase() } : {}),
  };
}

const encodeCursor = (value: string) =>
  Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeCursor = (raw: string): string | null => {
  if (raw.length === 0 || raw.length > 128 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
};
export function parseTemplateLimit(raw: unknown): number | null {
  if (raw === undefined) return 25;
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= 50 ? value : null;
}

interface ColumnSpec {
  type: string;
  nullable: boolean;
  length?: number;
  collation?: string;
  typeDetail?: string;
}
const BINARY = 'utf8mb4_bin';
const column = (type: string, nullable: boolean, extra: Partial<ColumnSpec> = {}): ColumnSpec => ({ type, nullable, ...extra });
const idColumn = () => column('char', false, { length: 36, collation: BINARY });
const tenantColumn = () => column('varchar', false, { length: 64, collation: BINARY });

/**
 * Exact physical contract for the new tables. Names-only checks are not
 * sufficient: nullable VARCHAR(1) identity columns, incorrect lengths,
 * non-binary collations, missing FKs or non-InnoDB tables must all fail closed.
 */
const templateSchemaSpec: Record<string, Record<string, ColumnSpec>> = {
  lesson_package_templates: {
    id: idColumn(),
    tenant_id: tenantColumn(),
    course_id: idColumn(),
    name: column('varchar', false, { length: 120, collation: BINARY }),
    status: column('enum', false, { typeDetail: "enum('active','archived')" }),
    head_revision: column('int', false),
    created_by: column('varchar', false, { length: 64, collation: BINARY }),
    created_at: column('timestamp', false),
    updated_at: column('timestamp', false),
    archived_at: column('timestamp', true),
  },
  lesson_package_template_revisions: {
    id: idColumn(),
    template_id: idColumn(),
    tenant_id: tenantColumn(),
    course_id: idColumn(),
    revision_number: column('int', false),
    source_lesson_id: idColumn(),
    created_by: column('varchar', false, { length: 64, collation: BINARY }),
    reference_count: column('int', false),
    media_count: column('int', false),
    content_hash: column('char', false, { length: 64, collation: BINARY }),
    created_at: column('timestamp', false),
  },
  lesson_package_template_references: {
    id: idColumn(),
    revision_id: idColumn(),
    kind: column('enum', false, { typeDetail: "enum('material','video','homework','quiz','announcement')" }),
    source_id: idColumn(),
    display_order: column('int', true),
  },
  lesson_template_operations: {
    tenant_id: tenantColumn(),
    operation_id: idColumn(),
    actor_user_id: column('varchar', false, { length: 64, collation: BINARY }),
    course_id: idColumn(),
    lesson_id: idColumn(),
    template_id: idColumn(),
    revision_number: column('int', false),
    timing_mode: column('enum', false, { typeDetail: "enum('keep','set','clear')" }),
    release_at_epoch: column('int', true),
    request_hash: column('char', false, { length: 64, collation: BINARY }),
    created_count: column('int', false),
    existing_count: column('int', false),
    created_at: column('timestamp', false),
  },
  lesson_template_library_operations: {
    tenant_id: tenantColumn(),
    operation_id: idColumn(),
    actor_user_id: column('varchar', false, { length: 64, collation: BINARY }),
    course_id: idColumn(),
    operation_kind: column('enum', false, { typeDetail: "enum('create','revise','archive')" }),
    template_id: column('char', true, { length: 36, collation: BINARY }),
    request_hash: column('char', false, { length: 64, collation: BINARY }),
    result_template_id: idColumn(),
    result_name: column('varchar', false, { length: 120, collation: BINARY }),
    result_status: column('enum', false, { typeDetail: "enum('active','archived')" }),
    result_head_revision: column('int', false),
    result_revision_number: column('int', true),
    result_reference_count: column('int', true),
    result_media_count: column('int', true),
    result_unchanged: column('tinyint', false),
    created_at: column('timestamp', false),
  },
};
const templateIndexSpec: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['lesson_package_templates', 'PRIMARY', ['id']],
  ['lesson_package_templates', 'uq_lesson_template_name', ['tenant_id', 'course_id', 'name']],
  ['lesson_package_template_revisions', 'PRIMARY', ['id']],
  ['lesson_package_template_revisions', 'uq_template_revision_number', ['template_id', 'revision_number']],
  ['lesson_package_template_references', 'PRIMARY', ['id']],
  ['lesson_package_template_references', 'uq_template_reference', ['revision_id', 'kind', 'source_id']],
  ['lesson_template_operations', 'PRIMARY', ['tenant_id', 'operation_id']],
  ['lesson_template_library_operations', 'PRIMARY', ['tenant_id', 'operation_id']],
];
const templateForeignKeySpec: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['lesson_package_template_revisions', 'template_id', 'lesson_package_templates', 'id', 'RESTRICT'],
  ['lesson_package_template_references', 'revision_id', 'lesson_package_template_revisions', 'id', 'RESTRICT'],
];
const normalizeType = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toLowerCase();

export async function lessonTemplateSchema(connection: CourseLessonConnection): Promise<boolean> {
  const tables = Object.keys(templateSchemaSpec);
  const placeholders = tables.map(() => '?').join(',');
  const [columns] = await connection.execute(
    `SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type,COLUMN_TYPE AS column_type,CHARACTER_MAXIMUM_LENGTH AS max_length,IS_NULLABLE AS is_nullable,COLLATION_NAME AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${placeholders}) LIMIT 400`,
    tables,
  );
  for (const table of tables) {
    for (const [name, spec] of Object.entries(templateSchemaSpec[table])) {
      const row = (columns as any[]).find(candidate => candidate.table_name === table && candidate.column_name === name);
      if (!row) return false;
      if (String(row.data_type).toLowerCase() !== spec.type) return false;
      if (row.is_nullable !== (spec.nullable ? 'YES' : 'NO')) return false;
      if (spec.length !== undefined && Number(row.max_length) !== spec.length) return false;
      if (spec.collation !== undefined && String(row.collation_name ?? '').toLowerCase() !== spec.collation) return false;
      if (spec.typeDetail !== undefined && normalizeType(row.column_type) !== normalizeType(spec.typeDetail)) return false;
    }
  }
  const [engines] = await connection.execute(
    `SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${placeholders}) LIMIT 8`,
    tables,
  );
  if (!tables.every(table => (engines as any[]).some(row => row.table_name === table && row.engine === 'InnoDB'))) return false;
  const [indexes] = await connection.execute(
    `SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${placeholders}) AND INDEX_NAME IN ('PRIMARY','uq_lesson_template_name','uq_template_revision_number','uq_template_reference') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 32`,
    tables,
  );
  for (const [table, index, cols] of templateIndexSpec) {
    const rows = (indexes as any[]).filter(row => row.table_name === table && row.index_name === index);
    if (rows.length !== cols.length || !cols.every((col, i) => rows[i].column_name === col && Number(rows[i].seq_in_index) === i + 1 && Number(rows[i].non_unique) === 0)) return false;
  }
  const [foreignKeys] = await connection.execute(
    `SELECT k.TABLE_NAME AS table_name,k.COLUMN_NAME AS column_name,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME IN (${placeholders}) AND k.REFERENCED_TABLE_NAME IS NOT NULL LIMIT 16`,
    tables,
  );
  for (const [table, columnName, referencedTable, referencedColumn, deleteRule] of templateForeignKeySpec) {
    if (!(foreignKeys as any[]).some(row => row.table_name === table && row.column_name === columnName
      && row.referenced_table === referencedTable && row.referenced_column === referencedColumn
      && String(row.delete_rule).toUpperCase() === deleteRule)) return false;
  }
  return lessonPackageReferenceSchema(connection);
}

const templateDto = (row: any) => ({
  id: String(row.id),
  name: String(row.name),
  status: String(row.status),
  head_revision: Number(row.head_revision),
});

async function verifySourceLesson(connection: CourseLessonConnection, lessonId: string, courseId: string) {
  const [lessons] = await connection.execute(
    'SELECT l.id,l.unit_id,l.status,u.status AS unit_status FROM course_lessons l INNER JOIN course_units u ON u.id=l.unit_id WHERE l.id=? AND u.course_id=? LIMIT 2 FOR UPDATE',
    [lessonId, courseId],
  );
  const rows = lessons as any[];
  if (rows.length !== 1 || !same(rows[0].id, lessonId)) return null;
  return rows[0].status === 'active' && rows[0].unit_status === 'active' ? rows[0] : null;
}

async function resolveSelections(connection: CourseLessonConnection, sourceLessonId: string, selections: PackageSelection[], courseId: string, tenantId: string) {
  const bindings = await readLessonPackageBindings(connection, sourceLessonId);
  const chosen: PackageBinding[] = [];
  for (const selection of selections) {
    const binding = bindings.find(row => row.kind === selection.kind && same(row.source_id, selection.source_id));
    const value = binding ? await readLessonPackageSource(connection, binding, courseId, tenantId) : null;
    if (!binding || !value) return null;
    chosen.push(binding);
  }
  chosen.sort((a, b) => packageKinds.indexOf(a.kind) - packageKinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
  return chosen;
}

async function insertRevision(connection: CourseLessonConnection, input: {
  templateId: string; tenantId: string; courseId: string; revisionNumber: number;
  sourceLessonId: string; userId: string; chosen: PackageBinding[];
}) {
  const revisionId = randomUUID();
  const mediaCount = input.chosen.filter(row => row.display_order !== null).length;
  const contentHash = hash(input.chosen.map(row => ({ kind: row.kind, source_id: row.source_id, display_order: row.display_order })));
  const [inserted] = await connection.execute(
    'INSERT INTO lesson_package_template_revisions (id,template_id,tenant_id,course_id,revision_number,source_lesson_id,created_by,reference_count,media_count,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [revisionId, input.templateId, input.tenantId, input.courseId, input.revisionNumber, input.sourceLessonId, input.userId, input.chosen.length, mediaCount, contentHash],
  );
  if (Number((inserted as any).affectedRows) !== 1) throw Error('Template revision write not confirmed');
  for (const row of input.chosen) {
    const [reference] = await connection.execute(
      'INSERT INTO lesson_package_template_references (id,revision_id,kind,source_id,display_order) VALUES (?,?,?,?,?)',
      [randomUUID(), revisionId, row.kind, row.source_id, row.display_order],
    );
    if (Number((reference as any).affectedRows) !== 1) throw Error('Template reference write not confirmed');
  }
  return { revision_id: revisionId, reference_count: input.chosen.length, media_count: mediaCount };
}

const libraryOperationKinds = ['create', 'revise', 'archive'] as const;
type LibraryOperationKind = typeof libraryOperationKinds[number];

export function libraryRequestHash(operation: LibraryOperationKind, courseId: string, templateId: string | undefined, body: any): string {
  const base = { kind: operation, courseId: courseId.toLowerCase() };
  if (operation === 'create')
    return hash({ ...base, name: body.name, source_lesson_id: body.source_lesson_id, selections: body.selections });
  if (operation === 'revise')
    return hash({ ...base, templateId: String(templateId).toLowerCase(), expected_revision: body.expected_revision,
      source_lesson_id: body.source_lesson_id, selections: body.selections });
  return hash({ ...base, templateId: String(templateId).toLowerCase(), status: 'archived' });
}

function libraryReceiptResponse(receipt: any, operation: LibraryOperationKind) {
  const template = {
    id: String(receipt.result_template_id), name: String(receipt.result_name),
    status: String(receipt.result_status) as 'active' | 'archived', head_revision: Number(receipt.result_head_revision),
  };
  if (operation === 'archive') return { template, unchanged: Number(receipt.result_unchanged) === 1 };
  const revision = {
    revision_number: Number(receipt.result_revision_number), reference_count: Number(receipt.result_reference_count),
    media_count: Number(receipt.result_media_count),
  };
  if (operation === 'create') return { template, revision };
  return { template_id: template.id, template, revision };
}

function assertLibraryReceipt(receipt: any, operation: LibraryOperationKind) {
  const integer = (value: unknown, min: number, max: number) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
  if (!libraryOperationKinds.includes(receipt.operation_kind) || receipt.operation_kind !== operation
    || typeof receipt.request_hash !== 'string' || !/^[a-f\d]{64}$/.test(receipt.request_hash)
    || !uuid(receipt.result_template_id) || typeof receipt.result_name !== 'string' || !receipt.result_name.trim() || receipt.result_name.length > 120
    || !['active', 'archived'].includes(receipt.result_status) || !integer(receipt.result_head_revision, 1, 2147483647))
    throw Error('Invalid lesson template library receipt');
  if (operation === 'archive') {
    if (receipt.result_revision_number !== null || receipt.result_reference_count !== null || receipt.result_media_count !== null
      || receipt.result_status !== 'archived' || !uuid(receipt.template_id) || !same(receipt.template_id, receipt.result_template_id)
      || ![0, 1].includes(Number(receipt.result_unchanged))) throw Error('Invalid lesson template archive receipt');
    return;
  }
  if (!integer(receipt.result_revision_number, 1, 2147483647) || !integer(receipt.result_reference_count, 1, 23)
    || !integer(receipt.result_media_count, 0, 20) || Number(receipt.result_media_count) > Number(receipt.result_reference_count)
    || Number(receipt.result_revision_number) !== Number(receipt.result_head_revision) || receipt.result_status !== 'active' || Number(receipt.result_unchanged) !== 0)
    throw Error('Invalid lesson template revision receipt');
  if (operation === 'revise' && (!uuid(receipt.template_id) || !same(receipt.template_id, receipt.result_template_id))
    || operation === 'create' && (receipt.template_id !== null || Number(receipt.result_head_revision) !== 1)) throw Error('Invalid lesson template revision receipt');
}

async function insertLibraryReceipt(connection: CourseLessonConnection, input: {
  tenantId: string; operationId: string; userId: string; courseId: string; operation: LibraryOperationKind;
  templateId: string | null; requestHash: string;
  result: { template: { id: string; name: string; status: string; head_revision: number }; revision?: { revision_number: number; reference_count: number; media_count: number }; unchanged?: boolean };
}) {
  const [inserted] = await connection.execute(
    `INSERT INTO lesson_template_library_operations (tenant_id,operation_id,actor_user_id,course_id,operation_kind,template_id,request_hash,result_template_id,result_name,result_status,result_head_revision,result_revision_number,result_reference_count,result_media_count,result_unchanged) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.tenantId, input.operationId, input.userId, input.courseId, input.operation, input.templateId,
      input.requestHash, input.result.template.id, input.result.template.name, input.result.template.status,
      input.result.template.head_revision, input.result.revision?.revision_number ?? null,
      input.result.revision?.reference_count ?? null, input.result.revision?.media_count ?? null,
      input.result.unchanged ? 1 : 0],
  );
  if (Number((inserted as any).affectedRows) !== 1) throw Error('Template library receipt write not confirmed');
}

export async function manageLessonTemplates(connection: CourseLessonConnection, input: {
  userId: string; tenantId: string; courseId: string; operation: TemplateOperation;
  templateId?: string; body?: TemplateCreateBody | TemplateRevisionBody | { status: 'archived'; operation_id: string };
  cursor?: string | null; limit?: number;
}) {
  if (!await lessonTemplateSchema(connection)) return unavailable();
  const { userId, tenantId, courseId, operation } = input;

  let libraryOperation: LibraryOperationKind | null = null;
  let libraryOperationId = '';
  let libraryRequestHashValue = '';
  if (operation === 'create' || operation === 'revise' || operation === 'archive') {
    libraryOperation = operation;
    const body = input.body as any;
    libraryOperationId = typeof body?.operation_id === 'string' ? body.operation_id : '';
    if (!uuid(libraryOperationId)) return result(400, { error: 'Invalid lesson template operation id' });
    libraryRequestHashValue = libraryRequestHash(operation, courseId, input.templateId, body);
    const [loaded] = await connection.execute(
      'SELECT actor_user_id,course_id,operation_kind,template_id,request_hash,result_template_id,result_name,result_status,result_head_revision,result_revision_number,result_reference_count,result_media_count,result_unchanged FROM lesson_template_library_operations WHERE tenant_id=? AND operation_id=? LIMIT 1 FOR UPDATE',
      [tenantId, libraryOperationId],
    );
    const receipt = (loaded as any[])[0];
    if (receipt) {
      if (receipt.operation_kind !== operation) return result(409, { error: 'Operation identity already used', code: 'TEMPLATE_OPERATION_CONFLICT' });
      assertLibraryReceipt(receipt, operation);
      if (receipt.actor_user_id !== userId || !same(receipt.course_id, courseId)
        || receipt.request_hash !== libraryRequestHashValue
        || (operation !== 'create' && !same(receipt.template_id ?? '', input.templateId ?? '')))
        return result(409, { error: 'Operation identity already used', code: 'TEMPLATE_OPERATION_CONFLICT' });
      return result(200, libraryReceiptResponse(receipt, operation));
    }
  }

  if (operation === 'list') {
    const cursorRaw = input.cursor ?? null;
    const cursor = cursorRaw === null || cursorRaw === '' ? '' : decodeCursor(cursorRaw);
    if (cursor === null || cursor !== '' && !uuid(cursor)) return result(400, { error: 'Invalid template list cursor' });
    const limit = input.limit ?? 25;
    const [rows] = await connection.execute(
      `SELECT id,name,status,head_revision FROM lesson_package_templates WHERE tenant_id=? AND course_id=? AND status='active' AND id>? ORDER BY id ASC LIMIT ?`,
      [tenantId, courseId, cursor, limit + 1],
    );
    const page = rows as any[];
    const hasMore = page.length > limit;
    const visible = hasMore ? page.slice(0, limit) : page;
    return result(200, {
      templates: visible.map(templateDto),
      next_cursor: hasMore && visible.length ? encodeCursor(String(visible[visible.length - 1].id)) : null,
    });
  }

  if (operation === 'revisions') {
    if (!uuid(input.templateId)) return result(400, { error: 'Invalid lesson template id' });
    const [templates] = await connection.execute(
      'SELECT id,status,head_revision FROM lesson_package_templates WHERE id=? AND tenant_id=? AND course_id=? LIMIT 1',
      [input.templateId, tenantId, courseId],
    );
    if (!(templates as any[])[0]) return result(404, { error: 'Lesson template not found' });
    const cursorRaw = input.cursor ?? null;
    const decoded = cursorRaw === null || cursorRaw === '' ? '0' : decodeCursor(cursorRaw);
    if (decoded === null || !/^\d{1,9}$/.test(decoded)) return result(400, { error: 'Invalid revision list cursor' });
    const after = Number(decoded);
    const limit = input.limit ?? 25;
    const [rows] = await connection.execute(
      'SELECT revision_number,source_lesson_id,reference_count,media_count FROM lesson_package_template_revisions WHERE template_id=? AND tenant_id=? AND course_id=? AND revision_number>? ORDER BY revision_number ASC LIMIT ?',
      [input.templateId, tenantId, courseId, after, limit + 1],
    );
    const page = rows as any[];
    const hasMore = page.length > limit;
    const visible = hasMore ? page.slice(0, limit) : page;
    return result(200, {
      revisions: visible.map(row => ({
        revision_number: Number(row.revision_number),
        source_lesson_id: String(row.source_lesson_id),
        reference_count: Number(row.reference_count),
        media_count: Number(row.media_count),
      })),
      next_cursor: hasMore && visible.length ? encodeCursor(String(visible[visible.length - 1].revision_number)) : null,
    });
  }

  if (operation === 'create') {
    const body = input.body as TemplateCreateBody;
    if (!body) return result(400, { error: 'Invalid lesson template payload' });
    if (!await verifySourceLesson(connection, body.source_lesson_id, courseId))
      return result(409, { error: 'Template source lesson must be active', code: 'TEMPLATE_SOURCE_INACTIVE' });
    const chosen = await resolveSelections(connection, body.source_lesson_id, body.selections, courseId, tenantId);
    if (!chosen) return result(409, { error: 'Template source reference is unavailable', code: 'TEMPLATE_SOURCE_UNAVAILABLE' });
    const [duplicate] = await connection.execute(
      'SELECT id FROM lesson_package_templates WHERE tenant_id=? AND course_id=? AND name=? LIMIT 1 FOR UPDATE',
      [tenantId, courseId, body.name],
    );
    if ((duplicate as any[])[0]) return result(409, { error: 'A lesson template with this name already exists', code: 'TEMPLATE_NAME_EXISTS' });
    const templateId = randomUUID();
    const [inserted] = await connection.execute(
      "INSERT INTO lesson_package_templates (id,tenant_id,course_id,name,status,head_revision,created_by) VALUES (?,?,?,?,'active',1,?)",
      [templateId, tenantId, courseId, body.name, userId],
    );
    if (Number((inserted as any).affectedRows) !== 1) throw Error('Template write not confirmed');
    const revision = await insertRevision(connection, {
      templateId, tenantId, courseId, revisionNumber: 1, sourceLessonId: body.source_lesson_id, userId, chosen,
    });
    await recordAudit(async (sql, params) => {
      const [audit] = await connection.execute(sql, params);
      if (Number(audit.affectedRows) !== 1) throw Error('Template audit not confirmed');
      return audit as { affectedRows: number };
    }, {
      actorUserId: userId, tenantId, action: 'course_lesson_template.created', resourceType: 'lesson_package_template', resourceId: templateId,
      newValue: snapshotRow({ name: body.name, source_lesson_id: body.source_lesson_id, revision_number: 1, reference_count: revision.reference_count, media_count: revision.media_count }),
    });
    await insertLibraryReceipt(connection, {
      tenantId, operationId: libraryOperationId, userId, courseId, operation: 'create', templateId: null,
      requestHash: libraryRequestHashValue,
      result: {
        template: { id: templateId, name: body.name, status: 'active', head_revision: 1 },
        revision: { revision_number: 1, reference_count: revision.reference_count, media_count: revision.media_count },
      },
    });
    return result(201, {
      template: { id: templateId, name: body.name, status: 'active', head_revision: 1 },
      revision: { revision_number: 1, reference_count: revision.reference_count, media_count: revision.media_count },
    }, true);
  }

  if (operation === 'revise') {
    const body = input.body as TemplateRevisionBody;
    if (!body || !uuid(input.templateId)) return result(400, { error: 'Invalid lesson template revision payload' });
    const [templates] = await connection.execute(
      'SELECT id,name,status,head_revision FROM lesson_package_templates WHERE id=? AND tenant_id=? AND course_id=? LIMIT 1 FOR UPDATE',
      [input.templateId, tenantId, courseId],
    );
    const current = (templates as any[])[0];
    if (!current) return result(404, { error: 'Lesson template not found' });
    if (current.status !== 'active') return result(409, { error: 'Archived lesson template cannot be revised', code: 'TEMPLATE_ARCHIVED' });
    if (Number(current.head_revision) !== body.expected_revision)
      return result(409, { error: 'Lesson template revision changed; refresh before saving', code: 'TEMPLATE_REVISION_CONFLICT' });
    if (!await verifySourceLesson(connection, body.source_lesson_id, courseId))
      return result(409, { error: 'Template source lesson must be active', code: 'TEMPLATE_SOURCE_INACTIVE' });
    const chosen = await resolveSelections(connection, body.source_lesson_id, body.selections, courseId, tenantId);
    if (!chosen) return result(409, { error: 'Template source reference is unavailable', code: 'TEMPLATE_SOURCE_UNAVAILABLE' });
    const nextRevision = Number(current.head_revision) + 1;
    const [advanced] = await connection.execute(
      'UPDATE lesson_package_templates SET head_revision=? WHERE id=? AND tenant_id=? AND course_id=? AND head_revision=? AND status=\'active\'',
      [nextRevision, input.templateId, tenantId, courseId, body.expected_revision],
    );
    if (Number((advanced as any).affectedRows) !== 1)
      return result(409, { error: 'Lesson template revision changed; refresh before saving', code: 'TEMPLATE_REVISION_CONFLICT' });
    const revision = await insertRevision(connection, {
      templateId: input.templateId, tenantId, courseId, revisionNumber: nextRevision,
      sourceLessonId: body.source_lesson_id, userId, chosen,
    });
    await recordAudit(async (sql, params) => {
      const [audit] = await connection.execute(sql, params);
      if (Number(audit.affectedRows) !== 1) throw Error('Template revision audit not confirmed');
      return audit as { affectedRows: number };
    }, {
      actorUserId: userId, tenantId, action: 'course_lesson_template.revised', resourceType: 'lesson_package_template', resourceId: input.templateId,
      oldValue: snapshotRow({ head_revision: Number(current.head_revision) }),
      newValue: snapshotRow({ head_revision: nextRevision, source_lesson_id: body.source_lesson_id, revision_number: nextRevision, reference_count: revision.reference_count, media_count: revision.media_count }),
    });
    await insertLibraryReceipt(connection, {
      tenantId, operationId: libraryOperationId, userId, courseId, operation: 'revise', templateId: input.templateId,
      requestHash: libraryRequestHashValue,
      result: {
        template: { id: input.templateId, name: String(current.name ?? ''), status: 'active', head_revision: nextRevision },
        revision: { revision_number: nextRevision, reference_count: revision.reference_count, media_count: revision.media_count },
      },
    });
    return result(201, {
      template_id: input.templateId,
      template: { id: input.templateId, name: String(current.name), status: 'active', head_revision: nextRevision },
      revision: { revision_number: nextRevision, reference_count: revision.reference_count, media_count: revision.media_count },
    }, true);
  }

  // archive
  if (!uuid(input.templateId)) return result(400, { error: 'Invalid lesson template id' });
  const [templates] = await connection.execute(
    'SELECT id,name,status,head_revision FROM lesson_package_templates WHERE id=? AND tenant_id=? AND course_id=? LIMIT 1 FOR UPDATE',
    [input.templateId, tenantId, courseId],
  );
  const current = (templates as any[])[0];
  if (!current) return result(404, { error: 'Lesson template not found' });
  if (current.status === 'archived') {
    const archived = { ...templateDto(current), status: 'archived' as const };
    await insertLibraryReceipt(connection, {
      tenantId, operationId: libraryOperationId, userId, courseId, operation: 'archive', templateId: input.templateId,
      requestHash: libraryRequestHashValue, result: { template: archived, unchanged: true },
    });
    return result(200, { template: archived, unchanged: true }, true);
  }
  const [updated] = await connection.execute(
    "UPDATE lesson_package_templates SET status='archived',archived_at=CURRENT_TIMESTAMP WHERE id=? AND tenant_id=? AND course_id=? AND status='active'",
    [input.templateId, tenantId, courseId],
  );
  if (Number((updated as any).affectedRows) !== 1) return result(409, { error: 'Lesson template changed; refresh before archiving', code: 'TEMPLATE_CHANGED' });
  await recordAudit(async (sql, params) => {
    const [audit] = await connection.execute(sql, params);
    if (Number(audit.affectedRows) !== 1) throw Error('Template archive audit not confirmed');
    return audit as { affectedRows: number };
  }, {
    actorUserId: userId, tenantId, action: 'course_lesson_template.archived', resourceType: 'lesson_package_template', resourceId: input.templateId,
    newValue: snapshotRow({ status: 'archived', head_revision: Number(current.head_revision) }),
  });
  const archived = { ...templateDto(current), status: 'archived' as const };
  await insertLibraryReceipt(connection, {
    tenantId, operationId: libraryOperationId, userId, courseId, operation: 'archive', templateId: input.templateId,
    requestHash: libraryRequestHashValue, result: { template: archived, unchanged: false },
  });
  return result(200, { template: archived, unchanged: false }, true);
}

/** Read-only recovery of a durable library operation, bound to the same owner/course. */
export async function readLessonTemplateLibraryOperation(connection: CourseLessonConnection, input: {
  userId: string; tenantId: string; courseId: string; operationId: string;
}) {
  if (!await lessonTemplateSchema(connection)) return unavailable();
  const [loaded] = await connection.execute(
    'SELECT actor_user_id,course_id,operation_kind,template_id,request_hash,result_template_id,result_name,result_status,result_head_revision,result_revision_number,result_reference_count,result_media_count,result_unchanged FROM lesson_template_library_operations WHERE tenant_id=? AND operation_id=? LIMIT 1',
    [input.tenantId, input.operationId],
  );
  const receipt = (loaded as any[])[0];
  if (!receipt) return result(200, { operation: null });
  assertLibraryReceipt(receipt, receipt.operation_kind);
  if (receipt.actor_user_id !== input.userId || !same(receipt.course_id, input.courseId))
    return result(409, { error: 'Operation identity already used', code: 'TEMPLATE_OPERATION_CONFLICT' });
  return result(200, { operation: { operation_id: input.operationId, operation_kind: receipt.operation_kind, ...libraryReceiptResponse(receipt, receipt.operation_kind) } });
}

interface StoredReference {
  kind: PackageBinding['kind'];
  source_id: string;
  display_order: number | null;
}

export async function manageLessonTemplateApplication(connection: CourseLessonConnection, input: {
  userId: string; tenantId: string; courseId: string; unitId: string; lessonId: string;
  operation: TemplateApplyOperation; body?: TemplateApplicationBody; operationId?: string;
}) {
  if (!await lessonTemplateSchema(connection)) return unavailable();
  const { userId, tenantId, courseId, unitId, lessonId, operation } = input;
  const body = input.body;
  const operationId = operation === 'status' ? input.operationId : body?.operation_id;
  const requestHash = body
    ? hash({
        courseId: courseId.toLowerCase(), unitId: unitId.toLowerCase(), lessonId: lessonId.toLowerCase(),
        template_id: body.template_id, revision_number: body.revision_number,
        timing: { mode: body.timing.mode, release_at: body.timing.release_at },
        review_token: body.review_token,
      })
    : null;

  if (operationId) {
    const [loaded] = await connection.execute(
      'SELECT actor_user_id,course_id,lesson_id,template_id,revision_number,timing_mode,release_at_epoch,request_hash,created_count,existing_count FROM lesson_template_operations WHERE tenant_id=? AND operation_id=? LIMIT 1 FOR UPDATE',
      [tenantId, operationId],
    );
    const receipt = (loaded as any[])[0];
    if (receipt) {
      if (receipt.actor_user_id !== userId || !same(receipt.course_id, courseId) || !same(receipt.lesson_id, lessonId)
        || !same(receipt.template_id, body?.template_id ?? receipt.template_id)
        || Number(receipt.revision_number) !== (body?.revision_number ?? Number(receipt.revision_number))
        || operation === 'apply' && receipt.request_hash !== requestHash)
        return result(409, { error: 'Operation identity already used', code: 'TEMPLATE_OPERATION_CONFLICT' });
      if (typeof receipt.request_hash !== 'string' || !/^[a-f\d]{64}$/.test(receipt.request_hash)
        || !uuid(receipt.template_id) || !Number.isInteger(receipt.revision_number) || receipt.revision_number < 1
        || !['keep', 'set', 'clear'].includes(receipt.timing_mode)
        || receipt.timing_mode === 'clear' && receipt.release_at_epoch !== null
        || receipt.timing_mode === 'set' && receipt.release_at_epoch === null
        || receipt.release_at_epoch !== null && (!Number.isInteger(Number(receipt.release_at_epoch)) || Number(receipt.release_at_epoch) < 0)
        || ![receipt.created_count, receipt.existing_count].every(n => Number.isInteger(Number(n)) && Number(n) >= 0 && Number(n) <= 23)
        || Number(receipt.created_count) + Number(receipt.existing_count) < 1 || Number(receipt.created_count) + Number(receipt.existing_count) > 23)
        throw Error('Invalid template operation receipt');
      const release = renderReleaseInstant(receipt.release_at_epoch === null ? null : Number(receipt.release_at_epoch));
      if (release === undefined) throw Error('Invalid template receipt timing');
      const summary = {
        operation_id: operationId, created: Number(receipt.created_count), existing: Number(receipt.existing_count),
        context: {template_id:receipt.template_id,revision_number:Number(receipt.revision_number),lesson_id:lessonId},
        timing: { mode: receipt.timing_mode, release_at: release },
      };
      return result(200, operation === 'status' ? { operation: summary } : { ...summary, replayed: true });
    }
    if (operation === 'status') return result(200, { operation: null });
  }

  if (!body) return result(400, { error: 'Invalid lesson template application request' });

  const [templates] = await connection.execute(
    'SELECT id,status,head_revision FROM lesson_package_templates WHERE id=? AND tenant_id=? AND course_id=? LIMIT 1 FOR UPDATE',
    [body.template_id, tenantId, courseId],
  );
  const template = (templates as any[])[0];
  if (!template) return result(404, { error: 'Lesson template not found' });
  if (template.status !== 'active') return result(409, { error: 'Archived lesson template cannot be applied', code: 'TEMPLATE_ARCHIVED' });

  const [revisions] = await connection.execute(
    'SELECT id,source_lesson_id,reference_count,media_count,content_hash FROM lesson_package_template_revisions WHERE template_id=? AND tenant_id=? AND course_id=? AND revision_number=? LIMIT 1 FOR UPDATE',
    [body.template_id, tenantId, courseId, body.revision_number],
  );
  const revision = (revisions as any[])[0];
  if (!revision) return result(404, { error: 'Lesson template revision not found', code: 'TEMPLATE_REVISION_NOT_FOUND' });

  const [references] = await connection.execute(
    'SELECT kind,source_id,display_order FROM lesson_package_template_references WHERE revision_id=? ORDER BY kind,display_order,id LIMIT 24',
    [revision.id],
  );
  const stored = (references as any[]).map(row => ({kind:row.kind,source_id:row.source_id,display_order:row.display_order})) as StoredReference[];
  const desired = stored.map(row=>({...row,id:row.source_id}));
  validatePackageBindings(desired,'saved template');
  stored.sort((a,b)=>packageKinds.indexOf(a.kind)-packageKinds.indexOf(b.kind)||a.source_id.localeCompare(b.source_id));
  if(!uuid(revision.id)||!uuid(revision.source_lesson_id)||stored.length!==revision.reference_count
    ||stored.filter(row=>row.display_order!==null).length!==revision.media_count||hash(stored)!==revision.content_hash)throw Error('Corrupt lesson template revision');

  const [destinations] = await connection.execute(
    'SELECT l.id,l.status,u.status AS unit_status,UNIX_TIMESTAMP(l.release_at) AS release_at_epoch FROM course_lessons l INNER JOIN course_units u ON u.id=l.unit_id WHERE l.id=? AND l.unit_id=? LIMIT 2 FOR UPDATE',
    [lessonId, unitId],
  );
  const destination = (destinations as any[])[0];
  if (!destination) return result(404, { error: 'Destination lesson not found' });
  if (destination.status !== 'active' || destination.unit_status !== 'active')
    return result(409, { error: 'Destination lesson must be active', code: 'TEMPLATE_DESTINATION_INACTIVE' });
  const currentEpoch = destination.release_at_epoch === null
    ? null
    : Number(destination.release_at_epoch);
  if (currentEpoch !== null && (!Number.isInteger(currentEpoch) || currentEpoch < 0)) throw Error('Invalid destination release instant');

  const {planned,items,facts,projected,to,canApply} = await planLessonPackageFinalState(connection,{courseId,tenantId,lessonId,desired});
  const timing=timingReview(body.timing,currentEpoch);
  const context={template_id:body.template_id,revision_number:body.revision_number,lesson_id:lessonId};
  const token = hash({
    userId, tenantId, courseId: courseId.toLowerCase(), lessonId: lessonId.toLowerCase(),
    templateId: body.template_id, revisionNumber: body.revision_number, stored, destination, to, facts, items, timing,
  });

  if (operation === 'review')
    return result(200, { review_token: token, can_apply: canApply, items, projected_media_count: projected, timing, context });

  if (body.review_token !== token) return result(409, { error: 'Lesson template review changed; review again', code: 'TEMPLATE_REVIEW_CHANGED' });
  if (!canApply) return result(409, { error: 'Lesson template references conflict', code: 'TEMPLATE_APPLY_CONFLICT' });

  let created = 0;
  for (const entry of planned) {
    if (entry.existing) continue;
    await insertLessonPackageReference(connection, lessonId, entry.binding);
    created++;
  }
  const existing = planned.length - created;

  const effectiveEpoch = timingEpoch(body.timing, currentEpoch);
  if (effectiveEpoch !== currentEpoch) {
    const [updated] = effectiveEpoch === null
      ? await connection.execute('UPDATE course_lessons SET release_at=NULL WHERE id=? AND unit_id=?', [lessonId, unitId])
      : await connection.execute('UPDATE course_lessons SET release_at=FROM_UNIXTIME(?) WHERE id=? AND unit_id=?', [effectiveEpoch, lessonId, unitId]);
    if (Number((updated as any).affectedRows) !== 1) throw Error('Template timing write not confirmed');
  }

  await recordAudit(async (sql, params) => {
    const [audit] = await connection.execute(sql, params);
    if (Number(audit.affectedRows) !== 1) throw Error('Template apply audit not confirmed');
    return audit as { affectedRows: number };
  }, {
    actorUserId: userId, tenantId, action: 'course_lesson_template.applied', resourceType: 'course_lesson', resourceId: lessonId,
    newValue: snapshotRow({
      operation_id: operationId, template_id: body.template_id, revision_number: body.revision_number,
      references: stored, timing: { mode: body.timing.mode, from: timing.current_release_at, to: timing.proposed_release_at },
      created, existing,
    }),
  });

  const [receipt] = await connection.execute(
    'INSERT INTO lesson_template_operations (tenant_id,operation_id,actor_user_id,course_id,lesson_id,template_id,revision_number,timing_mode,release_at_epoch,request_hash,created_count,existing_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [tenantId, operationId, userId, courseId, lessonId, body.template_id, body.revision_number, body.timing.mode, effectiveEpoch, requestHash, created, existing],
  );
  if (Number((receipt as any).affectedRows) !== 1) throw Error('Template operation receipt write not confirmed');
  return result(201, {
    operation_id: operationId, created, existing, replayed: false,
    context: {template_id:body.template_id,revision_number:body.revision_number,lesson_id:lessonId},
    timing: { mode: body.timing.mode, release_at: timing.proposed_release_at },
  }, true);
}
