import assert from 'node:assert/strict';
import test from 'node:test';
import { Router } from 'express';
import type { AuthRequest } from '../src/middleware/auth';
import { createCenterOperationsRouter } from '../src/routes/center-operations';
import { invokeRoute } from './helpers/m2-harness';
const id = (n: number) => `b5800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const s = { owner: true, revoke: false, reads: 0, released: 0, connections: 0, fail: false,
    actor: { id: 'owner', tenantId: 'tenant', role: 'instructor' } as AuthRequest['user'], headers: {} as Record<string, string>,
    groups: [{ id: id(1), name: 'Group', is_active: 1, course_name: 'Course', course_active: 1, branch_scope: 'tenant', branch_id: null, branch_name: null, branch_status: null }] as any[],
    members: [{ user_id: 'owner', role_key: 'owner' }, { user_id: 'teacher', role_key: 'instructor' }, { user_id: 'member', role_key: 'staff' }] };
  const c = { execute: async (sql: string, p: unknown[] = []) => {
    assert.match(sql.trim(), /^SELECT /); assert.doesNotMatch(sql, /SELECT\s+\*|phone|email|password|FOR UPDATE/i);
    if (s.fail) throw Error('private SQL error');
    if (sql.startsWith('SELECT t.id')) { s.reads++; assert.deepEqual(p, ['tenant', 'owner',0]); return [s.owner && !(s.revoke && s.reads > 1) ? [{ id: 'tenant' }] : [], []]; }
    if (sql.startsWith('SELECT g.id')) { assert.deepEqual(p[0], 'tenant'); assert.match(sql, /c.tenant_id=\?/); assert.match(sql, /b.tenant_id=c.tenant_id/); assert.match(sql, /LIMIT 26/); return [s.groups, []]; }
    if (sql.startsWith('SELECT m.user_id')) { assert.deepEqual(p, ['tenant']); assert.match(sql, /m.status='active'/); assert.match(sql, /u.is_active=1/); return [s.members, []]; }
    throw Error('Unexpected query');
  }, release: () => { s.released++; }, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, destroy: () => {} };
  const router = Router(); router.use((req, _res, next) => { (req as AuthRequest).user = s.actor; Object.assign(req.headers, s.headers); next(); });
  router.use('/catalog', createCenterOperationsRouter({ getConnection: async () => { s.connections++; return c; } }));
  return { s, call: (query: any = {}, headers: Record<string, string> = {}) => { s.headers = headers; return invokeRoute(router, { method: 'GET', url: '/catalog/operations', query }); } };
}
test('owner operations derives group scope and bounded membership counts without identity/contact details or granting authority', async () => {
  const h = fixture(), r = await h.call(), b = r.body as any;
  assert.equal(r.statusCode, 200); assert.deepEqual(b.team, { active_memberships: 3, teaching_memberships: 2, other_memberships: 1 });
  assert.equal(b.groups[0].branch_scope, 'tenant'); assert.equal(b.next_cursor, null);
  assert.doesNotMatch(JSON.stringify(b), /user_id|role_key|staff|tenant_id|phone|password/);
  assert.equal(r.headers?.['cache-control'], 'no-store'); assert.equal(h.s.released, 1); assert.equal(h.s.reads, 2);
});
test('identity namespace, billing, foreign owner and selectors fail closed before returning source facts', async () => {
  for (const kind of ['staff', 'billing', 'foreign', 'header', 'query']) {
    const h = fixture(); if (kind === 'staff') (h.s.actor as any).identitySource = 'staff'; if (kind === 'billing') (h.s.actor as any).billingOnly = true; if (kind === 'foreign') h.s.owner = false;
    const r = await h.call(kind === 'query' ? { tenant_id: 'other' } : {}, kind === 'header' ? { 'x-tenant-id': 'other' } : {});
    assert.equal(r.statusCode, ['query', 'header'].includes(kind) ? 400 : 403); assert.equal((r.body as any).groups, undefined);
    if (kind !== 'foreign') assert.equal(h.s.connections, 0);
  }
});
test('missing branch authority hides branch name; owner revocation after collection discards the whole response', async () => {
  const h = fixture(); h.s.groups[0] = { ...h.s.groups[0], branch_scope: 'branch', branch_id: id(2), branch_name: 'Other', branch_status: 'suspended' };
  const b = (await h.call()).body as any; assert.equal(b.groups[0].branch_scope, 'unavailable'); assert.equal(b.groups[0].branch_name, null);
  const lost = fixture(); lost.s.revoke = true; assert.equal((await lost.call()).statusCode, 403);
});
test('keyset pages are bounded and malformed/overflow source facts are unavailable, never partial success', async () => {
  const h = fixture(); h.s.groups = Array.from({ length: 26 }, (_, n) => ({ ...h.s.groups[0], id: id(n + 1) }));
  const b = (await h.call()).body as any; assert.equal(b.groups.length, 25); assert.equal(b.next_cursor, id(25));
  for (const kind of ['duplicate', 'overflow', 'badflag', 'outage']) {
    const x = fixture(); if (kind === 'duplicate') x.s.members.push(x.s.members[0]); if (kind === 'overflow') x.s.members = Array.from({ length: 501 }, (_, n) => ({ user_id: String(n), role_key: 'owner' }));
    if (kind === 'badflag') x.s.groups[0].is_active = 'unknown'; if (kind === 'outage') x.s.fail = true;
    const r = await x.call(); assert.equal(r.statusCode, 503); assert.deepEqual(r.body, { code: 'CENTER_OPERATIONS_UNAVAILABLE' }); assert.equal(x.s.released, 1);
  }
});
