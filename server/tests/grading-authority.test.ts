import test from 'node:test';
import assert from 'node:assert/strict';
import { proveGradingIdentity, proveGradingCourse, proveGradingAttempt } from '../src/services/grading-authority';
const actor = { id: 'teacher', tenantId: 'tenant', role: 'instructor', identitySource: 'users', tokenVersion: 4 } as const;
test('business admin, operational staff and billing identities cannot enter marking even with selected tenant', async () => {
    for (const a of [{ ...actor, role: 'admin' }, { ...actor, role: 'staff' }, { ...actor, billingOnly: true }, { ...actor, identitySource: 'staff' }])
        await assert.rejects(() => proveGradingIdentity({ query: async () => { throw Error('Must not query'); } }, a));
});
test('live teaching membership and current session are required; ownership is not a course grant', async () => {
    let identity = true, assigned = false;
    const calls: Array<{
        s: string;
        p: any[];
    }> = [];
    const db = { query: async (s: string, p: any[] = []) => { calls.push({ s, p }); return s.includes('academic_tenant_id') ? [{ academic_tenant_id: 'tenant' }] : s.includes('grading_user_id') ? (identity ? [{ grading_user_id: 'teacher' }] : []) : assigned ? [{ grading_course_id: 'course' }] : []; } };
    assert.equal(await proveGradingIdentity(db, actor), 'tenant');
    await assert.rejects(() => proveGradingCourse(db, actor, 'course'));
    await assert.rejects(() => proveGradingAttempt(db, actor, 'attempt'));
    assigned = true;
    await proveGradingCourse(db, actor, 'course');
    await proveGradingAttempt(db, actor, 'attempt');
    identity = false;
    await assert.rejects(() => proveGradingIdentity(db, actor));
    assert.match(calls[0].s, /AS academic_tenant_id/);
    assert.match(calls[1].s, /u\.token_version=\?/);
    assert.match(calls[1].s, /u\.center_account=0/);
    assert.deepEqual(calls[1].p, ['tenant', 'teacher', 4]);
    for (const call of calls.filter(c => c.s.includes('grading_course_id'))) {
        assert.match(call.s, /c\.instructor_id=\?/);
        assert.match(call.s, /FOR UPDATE/);
        assert.equal(call.p[2], 'teacher');
        assert.doesNotMatch(call.s, /owner_user_id/);
    }
});
