import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../lib/api-http';
import { createCenterOperations, initialOperations, parseCenterOperations } from '../features/tenant/center-operations';
const id = (n: number) => `b5800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const raw = () => ({ checked_at: '2026-11-08T12:00:00.000Z', groups: [{ id: id(1), name: 'Group', active: true, course_name: 'Course', course_active: true, branch_scope: 'tenant', branch_name: null }], next_cursor: null, team: { active_memberships: 2, teaching_memberships: 1, other_memberships: 1 } });
test('operations adapter rejects leaked fields, invalid branch proof, inconsistent counts and forged paging', () => {
  assert.equal(parseCenterOperations(raw(), null).groups.length, 1);
  for (const change of [{ tenant_id: 'private' }, { team: { ...raw().team, teaching_memberships: 5 } }, { next_cursor: id(1) }, { groups: [{ ...raw().groups[0], phone: 'private' }] }, { groups: [{ ...raw().groups[0], branch_name: 'Not authorized' }] }])
    assert.throws(() => parseCenterOperations({ ...raw(), ...change }, null));
  assert.throws(() => parseCenterOperations(raw(), id(2)));
});
function fixture() {
  let principal = 'A', event = () => {}, state = initialOperations();
  const deps = { read: async (_after: string | null, _signal: AbortSignal) => parseCenterOperations(raw(), null), readPrincipal: () => principal, subscribeSession: (fn: () => void) => { event = fn; return () => {}; } };
  const c = createCenterOperations(deps); c.subscribe(s => state = s);
  return { c, deps, state: () => state, replace: () => { principal = 'B'; }, event: () => event() };
}
test('owner denial and failed refresh discard previous counts/groups instead of reporting stale readiness', async () => {
  const h = fixture(); await h.c.first(); assert.equal(h.state().phase, 'ready');
  h.deps.read = async () => { throw new ApiRequestError('Not owner', 403); }; await h.c.refresh();
  assert.equal(h.state().phase, 'denied'); assert.equal(h.state().data, null);
  h.deps.read = async () => { throw Error('Unavailable'); }; await h.c.first(); assert.equal(h.state().phase, 'error'); h.c.dispose();
});
test('request generation and deadline fence late pages and clear all old private summaries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = fixture(); let done!: (x: ReturnType<typeof parseCenterOperations>) => void;
  h.deps.read = () => new Promise(r => { done = r; }); const work = h.c.first(); t.mock.timers.tick(25000);
  assert.equal(h.state().phase, 'error'); done(parseCenterOperations(raw(), null)); await work; assert.equal(h.state().data, null); h.c.dispose();
});
test('principal and session replacement remove owner data and forbid another lifetime read', async () => {
  for (const kind of ['principal', 'event']) { const h = fixture(); await h.c.first(); if (kind === 'principal') { h.replace(); await h.c.refresh(); } else h.event();
    assert.equal(h.state().phase, 'session-ended'); assert.equal(h.state().data, null); await h.c.first(); assert.equal(h.state().data, null); h.c.dispose(); }
});
