import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeachingChoices, parseTeachingPage } from '../features/catalog/teaching-workspace';
import { canAccessRoute } from '../auth/access-control';
const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('strict teaching pages reject extra fields, duplicate/out-of-order IDs and invented cursors', () => {
  const good = { items: [{ id: id(1), name: 'Math' }], next_cursor: null };
  assert.deepEqual(parseTeachingPage(good), good);
  assert.ok(parseTeachingPage({ items: [{ id: id(1), unit_id: id(2), title: 'Lesson' }], next_cursor: null }, true));
  for (const raw of [{ ...good, student_id: id(5) }, { items: [{ ...good.items[0], phone: 'private' }], next_cursor: null }, { ...good, next_cursor: id(1) }, { items: [good.items[0], good.items[0]], next_cursor: null }, { items: [{ id: id(3), name: 'a' }, { id: id(2), name: 'b' }], next_cursor: null }]) assert.throws(() => parseTeachingPage(raw));
  assert.throws(() => parseTeachingPage(good, false, id(2)));
});
test('discovery erases stale data and fences ignored cancellation, session changes and disposal', async () => {
  let principal = 'A', invalidate = () => {}, resolve: any;
  const reads: Array<(value: any) => void> = [], states: any[] = [];
  const c = createTeachingChoices({ read: async () => await new Promise<any>(r => { reads.push(r); resolve = r; }), readPrincipal: () => principal, subscribeSession: fn => { invalidate = fn; return () => {}; } });
  c.subscribe(s => states.push(s)); const first = c.load(), second = c.load();
  reads[0]({ items: [{ id: id(1), name: 'Stale' }], next_cursor: null }); await first;
  assert.equal(states.at(-1).phase, 'loading');
  resolve({ items: [{ id: id(2), name: 'Current' }], next_cursor: null }); await second;
  assert.equal(states.at(-1).page.items[0].name, 'Current');
  const third = c.load(); assert.equal(states.at(-1).page, null); principal = 'B'; invalidate(); resolve({ items: [], next_cursor: null }); await third;
  assert.equal(states.at(-1).phase, 'session-ended'); assert.equal(states.at(-1).page, null);
  const count = states.length; c.dispose(); await c.load(); assert.equal(states.length, count);
});
test('failed choices never retain a previously successful course/lesson page', async () => {
  let fail = false, state: any;
  const c = createTeachingChoices({ read: async () => { if (fail) throw Error('offline'); return { items: [id(1)], next_cursor: null }; }, readPrincipal: () => 'A', subscribeSession: () => () => {} });
  c.subscribe(s => { state = s; }); await c.load(); assert.ok(state.page); fail = true; await c.load(); assert.equal(state.phase, 'error'); assert.equal(state.page, null); c.dispose();
});
test('workspace route belongs to teaching accounts, never business administration or operational staff', () => {
  for (const role of ['teacher', 'instructor']) assert.equal(canAccessRoute({ role }, '/teacher-workspace'), true);
  for (const profile of [{ role: 'admin' }, { role: 'staff' }, { role: 'student' }, { role: 'teacher', admin_member: true }, { role: 'instructor', billing_only: true }]) assert.equal(canAccessRoute(profile, '/teacher-workspace'), false);
});
test('whole-request deadline releases loading even when a choices transport ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let state: any;
  const c = createTeachingChoices({ read: async () => await new Promise<never>(() => {}), readPrincipal: () => 'A', subscribeSession: () => () => {} });
  c.subscribe(s => { state = s; }); const pending = c.load();
  t.mock.timers.tick(25001); await pending; assert.equal(state.phase, 'error'); assert.equal(state.page, null); c.dispose();
});
