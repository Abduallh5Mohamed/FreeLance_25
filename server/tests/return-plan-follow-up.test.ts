import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers/return-plan-fixture';
import { uid } from './helpers/lesson-package-fixture';
import { COURSE_A1, TENANT_A, OWNER_A } from './helpers/m2-course-lessons-harness';
const path = '/follow-up/enrollment-one';
function prepared() {
  const h = harness({ persistence: true });
  h.state.returnHeads.push({ id: uid(700), tenant_id: TENANT_A, course_id: COURSE_A1, enrollment_id: 'enrollment-one', version: 1, status: 'active' });
  h.state.returnRevisions.push({ plan_id: uid(700), version: 1, status: 'active', steps: JSON.stringify([{ lesson_id: uid(10), minutes: 15 }]) });
  return h;
}
test('fresh saved-plan follow-up uses independent catalog completion, not a synthetic started/finished flag', async () => {
  const h = prepared(), before = structuredClone(h.state.returnHeads), r = await h.request(path);
  assert.equal(r.status, 200); assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.body.plan.steps[0].completed, false); h.s.completed = true;
  assert.equal((await h.request(path)).body.plan.steps[0].completed, true);
  assert.deepEqual(h.state.returnHeads, before); assert.equal(h.state.audits, 0);
  assert.ok(h.s.sql.every(q => q.startsWith('SELECT ')));
  assert.ok(!JSON.stringify(r.body).includes('started_at')); assert.ok(!JSON.stringify(r.body).includes('finished_at'));
});
test('locked/missing lesson hides its identity and completion instead of leaking the saved step', async () => {
  const h = prepared(); h.s.proof = false; const r = await h.request(path);
  assert.equal(r.status, 200); assert.deepEqual(r.body.plan.steps, [{ position: 1, available: false }]);
});
test('withdrawal never falls back to a previous active revision; no plan is explicit null', async () => {
  const h = prepared(); h.state.returnHeads[0].status = 'withdrawn'; h.state.returnHeads[0].version = 2;
  h.state.returnRevisions.push({ plan_id: uid(700), version: 2, status: 'withdrawn', steps: '[]' });
  const r = await h.request(path); assert.equal(r.status, 200); assert.equal(r.body.plan.status, 'withdrawn'); assert.deepEqual(r.body.plan.steps, []);
  h.state.returnHeads.length = 0; assert.equal((await h.request(path)).body.plan, null);
});
for (const mode of ['schema', 'completion-schema', 'revoked', 'enrollment', 'unpublished', 'revision', 'duplicate', 'status']) test(`follow-up ${mode} failure returns no partial progress`, async () => {
  const h = prepared();
  if (mode === 'schema') h.s.persistence = false;
  if (mode === 'completion-schema') h.s.schema = false;
  if (mode === 'revoked') h.s.owner = false;
  if (mode === 'enrollment') h.s.enrolled = false;
  if (mode === 'unpublished') h.s.published = false;
  if (mode === 'revision') h.state.returnRevisions.length = 0;
  if (mode === 'duplicate') h.state.returnRevisions[0].steps = JSON.stringify([{ lesson_id: uid(10), minutes: null }, { lesson_id: uid(10), minutes: 5 }]);
  if (mode === 'status') h.state.returnRevisions[0].status = 'withdrawn';
  const r = await h.request(path); assert.ok([403, 404, 500, 503].includes(r.status)); assert.equal(r.body.plan, undefined); assert.equal(h.state.audits, 0);
});
for (const role of ['admin', 'staff', 'student']) test(`${role} cannot read follow-up, save or recover another teacher operation`, async () => {
  const h = prepared(), extra = { user: { id: OWNER_A, tenantId: TENANT_A, role } };
  assert.equal((await h.request(path, {}, extra)).status, 403);
  assert.equal((await h.request('/students', {}, extra)).status, 403);
  assert.equal((await h.request('/operations/' + uid(900), {}, extra)).status, 403);
  assert.ok(!h.s.sql.some(q => q.includes('FROM students') || q.includes('course_return_plan_operations')));
});
