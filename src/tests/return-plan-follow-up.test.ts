import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReturnFollowUp } from '../features/catalog/return-plan-follow-up';
const course = 'a1000000-0000-4000-8000-000000000001', lesson = 'a1000000-0000-4000-8000-000000000002';
const good = () => ({ context: { course_id: course, enrollment_id: 'student' }, checked_at: '2026-11-09T00:00:00.000Z', plan: { id: lesson, version: 2, status: 'active', steps: [{ position: 1, available: true, lesson_id: lesson, title: 'Lesson', minutes: null, completed: false }] } });
test('follow-up strictly binds context and hides unavailable step identity', () => {
  assert.ok(parseReturnFollowUp(good(), course, 'student'));
  const hidden: any = good(); hidden.plan.steps = [{ position: 1, available: false }]; assert.ok(parseReturnFollowUp(hidden, course, 'student'));
  hidden.plan.steps[0].lesson_id = lesson; assert.throws(() => parseReturnFollowUp(hidden, course, 'student'));
  assert.throws(() => parseReturnFollowUp(good(), course, 'another'));
});
test('invalid progress/status/versions, stale context and extra academic claims are rejected', () => {
  const mutations = [
    (r: any) => { r.plan.steps[0].completed = 1; }, (r: any) => { r.plan.steps[0].position = 2; },
    (r: any) => { r.plan.version = 0; }, (r: any) => { r.plan.status = 'withdrawn'; },
    (r: any) => { r.plan.steps.push(r.plan.steps[0]); }, (r: any) => { r.plan.finished = true; },
    (r: any) => { r.checked_at = 'yesterday'; }, (r: any) => { r.plan.steps[0].minutes = 1.5; },
  ];
  for (const change of mutations) { const raw = good(); change(raw); assert.throws(() => parseReturnFollowUp(raw, course, 'student')); }
  assert.ok(parseReturnFollowUp({ ...good(), plan: null }, course, 'student'));
  assert.ok(parseReturnFollowUp({ ...good(), plan: { id: lesson, version: 3, status: 'withdrawn', steps: [] } }, course, 'student'));
});
