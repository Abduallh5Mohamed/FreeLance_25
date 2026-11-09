import test from 'node:test';
import assert from 'node:assert/strict';
import { listGradingAssignments, proveGradingAssignment } from '../src/services/grading-delegation';
const id = (n: number) => `00000001-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { id: 'grader', tenantId: 'tenant', role: 'teacher', tokenVersion: 3 } as const;
function fixture() {
  const s = { identity: true, schema: true, count: 26, denied: '', responsible: true, label: true, order: true, queries: [] as Array<{ sql: string; p: any[] }> };
  const db: any = { query: async (sql: string, p: any[] = []) => {
    s.queries.push({ sql, p });
    if (sql.includes('AS academic_tenant_id')) { assert.deepEqual(p, ['tenant']); return [{ academic_tenant_id: 'tenant' }]; }
    if (sql.includes('AS grading_user_id')) { assert.deepEqual(p, ['tenant', 'grader', 3]); assert.match(sql, /FOR UPDATE$/); return s.identity ? [{ grading_user_id: 'grader' }] : []; }
    if (sql.includes('information_schema.TABLES')) return s.schema ? p.map(name => ({ name, engine: 'InnoDB' })) : [];
    if (sql.includes('information_schema.COLUMNS')) return [{ name: 'exam_rubric_awards', col: 'marks', kind: 'json' }, { name: 'exam_grading_control_operations', col: 'result', kind: 'json' }, { name: 'exam_grading_assignments', col: 'responsible_user_id', kind: 'varchar' }];
    if (sql.includes('information_schema.STATISTICS')) return ([['exam_grading_assignments', ['id']], ['exam_grading_assignments', ['tenant_id', 'question_ref']], ['exam_rubric_awards', ['tenant_id', 'attempt_id', 'question_ref', 'revision']], ['exam_grading_control_operations', ['tenant_id', 'operation_id']]] as const).flatMap(([name, keys], n) => keys.map((col, i) => ({ name, ix: 'key' + n, col, seq: i + 1 })));
    if (sql.startsWith('SELECT id FROM exam_grading_assignments')) { assert.deepEqual(p, ['tenant', 'grader', '']); const list = Array.from({ length: s.count }, (_, i) => ({ id: id(i + 1) })); return s.order ? list : list.reverse(); }
    if (sql.startsWith('SELECT a.id,a.question_ref')) { assert.deepEqual(p.slice(1), ['tenant', 'grader']); assert.match(sql, /a.responsible_user_id=c.instructor_id/); assert.match(sql, /a.assignee_user_id=\?/); assert.match(sql, /FOR UPDATE$/); return p[0] === s.denied ? [] : [{ id: p[0], question_ref: id(80), version: 2, rubric_id: id(81), exam_version_id: id(82), points: '8.00', criteria: [{ key: 'method', label: 'Method', max_points: '8.00' }], total_points: '8.00', instructor_id: 'responsible' }]; }
    if (sql.startsWith('SELECT 1 AS ok FROM users')) { assert.deepEqual(p, ['responsible']); assert.match(sql, /suspended_until/); return s.responsible ? [{ ok: 1 }] : []; }
    if (sql.startsWith('SELECT LEFT(question_text')) { assert.deepEqual(p, [id(80), 'tenant']); return s.label ? [{ label: 'Bound question label' }] : []; }
    throw Error('Unexpected query');
  }, execute: async () => { throw Error('Read only'); } };
  return { s, db };
}
test('25-item page proves actor/schema once while re-proving every assignment and responsible teacher', async () => {
  const h = fixture(), page = await listGradingAssignments(h.db, actor);
  assert.equal(page.assignments.length, 25); assert.equal(page.next_cursor, id(25));
  assert.equal(h.s.queries.length, 81); assert.equal(h.s.queries.filter(q => q.sql.includes('information_schema.')).length, 3);
  assert.equal(h.s.queries.filter(q => q.sql.includes('AS grading_user_id')).length, 1);
  assert.equal(h.s.queries.filter(q => q.sql.startsWith('SELECT a.id,a.question_ref')).length, 25);
  assert.equal(h.s.queries.filter(q => q.sql.startsWith('SELECT 1 AS ok FROM users')).length, 25);
});
test('withdrawn or no-longer-responsible resources are omitted without replacing raw candidate pagination', async () => {
  const h = fixture(); h.s.denied = id(1); const page = await listGradingAssignments(h.db, actor); assert.equal(page.assignments.length, 24); assert.equal(page.next_cursor, id(25));
  h.s.responsible = false; assert.deepEqual((await listGradingAssignments(h.db, actor)).assignments, []);
});
test('request-local reuse never caches identity or schema across requests, nor bypasses standalone grading proof', async () => {
  const h = fixture(); await listGradingAssignments(h.db, actor); h.s.identity = false;
  await assert.rejects(() => listGradingAssignments(h.db, actor)); await assert.rejects(() => proveGradingAssignment(h.db, actor, id(1)));
  const ready = fixture(); await listGradingAssignments(ready.db, actor); ready.s.schema = false; await assert.rejects(() => listGradingAssignments(ready.db, actor));
});
for (const failure of ['label', 'overflow', 'order']) test(`assignment page ${failure} corruption fails wholly instead of returning a partial success`, async () => {
  const h = fixture(); if (failure === 'label') h.s.label = false; if (failure === 'overflow') h.s.count = 27; if (failure === 'order') h.s.order = false;
  await assert.rejects(() => listGradingAssignments(h.db, actor));
});
