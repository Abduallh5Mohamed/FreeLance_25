import test from 'node:test';
import assert from 'node:assert/strict';
import { lockAcademicTenant } from '../src/services/academic-lock-order';
import { proveGradingIdentity } from '../src/services/grading-authority';
import { proveTeachingIdentity } from '../src/services/teaching-authority';
test('common tenant lock is first for academic proofs; membership/user locks and no grant follow only when active scope exists', async () => {
  for (const kind of ['grading', 'teaching']) {
    const calls: string[] = [], actor = { id: 'teacher', tenantId: 'tenant', role: 'teacher', tokenVersion: 0 } as const;
    const query = async (sql: string, p: any[] = []) => { calls.push(sql); if (sql.includes('academic_tenant_id')) { assert.deepEqual(p, ['tenant']); return [{ academic_tenant_id: 'tenant' }]; } return [{ grading_user_id: 'teacher', teaching_user_id: 'teacher' }]; };
    if (kind === 'grading') await proveGradingIdentity({ query }, actor);
    else await proveTeachingIdentity({ execute: async (s: string, p?: any[]) => [await query(s, p), []] } as any, { user: actor, headers: {} } as any);
    assert.equal(calls.length, 2); assert.match(calls[0], /AS academic_tenant_id.*FOR UPDATE$/); assert.match(calls[1], /FROM users/);
  }
});
test('missing/foreign/corrupt tenant proof fails before touching user rows and never implies an academic grant', async () => {
  for (const rows of [[], [{ academic_tenant_id: 'foreign' }], [{ academic_tenant_id: 'tenant' }, { academic_tenant_id: 'tenant' }]]) {
    let queries = 0; const query = async () => { queries++; return rows; };
    assert.equal(await lockAcademicTenant({ query }, 'tenant'), false);
    await assert.rejects(() => proveGradingIdentity({ query }, { id: 'teacher', tenantId: 'tenant', role: 'teacher' }));
    assert.equal(queries, 2);
  }
});
