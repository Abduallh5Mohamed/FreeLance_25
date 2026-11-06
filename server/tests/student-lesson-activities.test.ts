import assert from 'node:assert/strict';
import test from 'node:test';
import { listStudentLessonActivities, readStudentLessonActivity, proveStudentCatalogActivity } from '../src/services/student-lesson-activities';
import { createStudentCourseAccessRouter } from '../src/routes/student-course-access';
import { makeReq, runChain } from './helpers/m2-course-lessons-harness';
import {id,scope,principal,fixture} from './helpers/student-activity-fixture';

test('published catalog activity metadata is a fixed private projection; the selected proof stays server-private', async () => {
  const h = fixture(), result = await h.list(); assert.equal(result.status, 200);
  assert.deepEqual(result.body, { lesson_id: id(2), activities: [{ content_id: id(3), kind: 'homework', title: 'واجب منشور', launch_status: 'submission_required' }, { content_id: id(5), kind: 'quiz', title: 'كويز منشور', launch_status: 'attempt_required' }] });
  assert.ok(!JSON.stringify(result.body).includes('source_id')); assert.ok(!JSON.stringify(result.body).includes('تعليمات')); assert.equal(result.commit, false);
  const proof = await h.proof(); assert.equal(proof.ok, true); if (proof.ok) assert.equal(proof.activity.source_id, id(4));
});
test('fresh detail returns only bounded homework instructions and exact database deadline, with no quiz questions', async () => {
  const h = fixture(); const result = await h.detail(); assert.equal(result.status, 200); assert.equal((result.body as any).activity.deadline_at, '1970-01-01T00:00:00.000Z'); assert.equal((result.body as any).activity.instructions, h.s.instructions);
  const quiz = await h.detail(id(5)); assert.equal(quiz.status, 200); assert.equal((quiz.body as any).activity.instructions, null); assert.equal((quiz.body as any).activity.deadline_at, null);
  assert.ok(!h.s.calls.some(q => /exam_questions|exam_attempts|exam_results|assignment_submissions/.test(q)));
});
for (const gate of ['active', 'suspended', 'version', 'enrolled', 'course', 'lesson', 'released', 'prerequisite', 'schema', 'indexes', 'engine', 'groupCount'] as const) test(`activity ${gate} proof fails closed`, async () => {
  const h = fixture(); if (gate === 'suspended') h.s.suspended = true; else if (gate === 'version') h.s.version = 1; else if (gate === 'engine') h.s.engine = 'MyISAM'; else if (gate === 'groupCount') h.s.groupCount = 0; else (h.s as any)[gate] = false;
  assert.ok([404, 409, 503].includes((await h.detail()).status));
});
test('scope mismatch and teacher/admin labels do not become a student or owner bypass', async () => {
  const h = fixture();
  for (const actor of [{ ...principal, role: 'admin' }, { ...principal, identitySource: 'staff' }, { ...principal, tenantId: 'foreign' }, { ...principal, studentEnrollmentId: 'foreign' }]) assert.equal((await listStudentLessonActivities(h.connection, scope, id(1), id(2), actor)).status, 404);
  assert.equal(h.s.calls.length, 0);
});
test('draft, archived, closed, inactive and foreign sources disclose no title or detail', async () => {
  const h = fixture(); h.s.assignments[0].status = 'draft'; h.s.exams[0].is_published = 0;
  assert.deepEqual((await h.list()).body, { lesson_id: id(2), activities: [] }); assert.equal((await h.detail()).status, 404);
  h.s.assignments[0].status = 'published'; h.s.assignments[0].tenant_id = 'foreign'; assert.equal((await h.detail()).status, 404);
  h.s.assignments[0].tenant_id = 'tenant'; h.s.assignments[0].archived_at = 'archived'; assert.equal((await h.detail()).status, 404);
});
test('homework audience is the original assignment policy plus the exact catalog group', async () => {
  const h = fixture(); const group = { id: id(8), course_id: id(1), branch_scope: 'tenant', branch_id: null };
  h.s.audiences = [group]; h.s.assignments[0].group_id = id(8); assert.equal((await h.detail()).status, 200);
  group.id = id(9); h.s.assignments[0].group_id = id(9); assert.equal((await h.detail()).status, 404);
});
test('quiz groups must include the actual enrollment group and conflicting branches never widen access', async () => {
  const h = fixture(); h.s.audiences = [{ id: id(8), exam_id: id(6), course_id: id(1), branch_scope: 'tenant', branch_id: null }]; assert.equal((await h.detail(id(5))).status, 200);
  h.s.audiences[0].id = id(9); assert.equal((await h.detail(id(5))).status, 404);
  h.s.audiences[0].id = id(8); h.s.audiences.push({ id: id(10), exam_id: id(6), course_id: id(1), branch_scope: 'branch', branch_id: id(11), resolved_branch_id: id(11), branch_tenant_id: 'tenant', branch_status: 'active' });
  assert.equal((await h.detail(id(5))).status, 404);
});
test('branch membership expiry and scoped membership-version changes revoke the next detail read', async () => {
  const h = fixture(); h.s.group.branch_scope = 'branch'; h.s.group.branch_id = id(11); h.s.group.resolved_branch_id = id(11);
  const actor = { ...principal, branchId: id(11), branchMembershipVersion: 1 };
  assert.equal((await listStudentLessonActivities(h.connection, scope, id(1), id(2), actor)).status, 200);
  h.s.group.member_version = 2; assert.equal((await listStudentLessonActivities(h.connection, scope, id(1), id(2), actor)).status, 404);
  h.s.group.member_version = 1; h.s.group.member_status = 'revoked'; assert.equal((await h.detail()).status, 404);
});
test('reference deletion, source withdrawal and group changes are freshly observed after a successful read', async () => {
  const h = fixture(); assert.equal((await h.detail()).status, 200); h.s.bindings.shift(); assert.equal((await h.detail()).status, 404);
  h.s.exams[0].is_active = 0; assert.deepEqual((await h.list()).body, { lesson_id: id(2), activities: [] });
});
for (const malformed of ['instructions', 'deadline', 'detailSchema', 'bindings']) test(`invalid ${malformed} does not become student content`, async () => {
  const h = fixture(); if (malformed === 'instructions') h.s.instructions = 'x'.repeat(20001); else if (malformed === 'deadline') h.s.deadline = ' '; else if (malformed === 'detailSchema') h.s.detailSchema = false; else h.s.bindings.push({ ...h.s.bindings[0] });
  assert.equal((await h.detail()).status, 503);
});
test('actual student routes are no-store, read-only and reject private selectors before acquiring a connection', async () => {
  const h = fixture(); const list = await h.request(); assert.equal(list.status, 200); assert.equal(list.headers['Cache-Control'], 'no-store');
  const detail = await h.request('/' + id(3)); assert.equal(detail.status, 200); assert.deepEqual(h.s.events, ['begin', 'rollback', 'release', 'begin', 'rollback', 'release']);
  const before = h.s.acquired; assert.equal((await h.request('', { tenant_id: 'foreign' })).status, 400); assert.equal((await h.request('/bad')).status, 404); assert.equal((await h.request('', {}, { ...principal, role: 'instructor' })).status, 403); assert.equal(h.s.acquired, before);
});
