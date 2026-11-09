import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
import { createFamilySummaryRouter } from '../src/routes/family-summary';
import { createParentViewsRouter } from '../src/routes/parent-views';
import { createParentLinksRouter } from '../src/routes/parent-links';
import type { AuthRequest } from '../src/middleware/auth';
import { createParentViewVerifier, createSqlParentLinksStore, signParentViewToken } from '../src/services/parent-links';
import type { FamilySummary } from '../src/services/family-summary';
import { invokeRoute } from './helpers/m2-harness';

const now = new Date('2026-11-07T10:00:00.000Z');
const secret = 'family-test-only-secret-with-more-than-32-bytes';
const claims = { jti: 'token-one', link_id: 'link-one', tenant_id: 'tenant-one', student_enrollment_id: 'child-one',
    parent_user_id: 'parent-one', iat: now.getTime(), exp: now.getTime() + 900000 };
const token = signParentViewToken(secret, claims);
const columns: Record<string, string[]> = {
    students: ['id','name','tenant_id','user_id','group_id','is_active','approval_status','enrollment_status','enrollment_start_date','enrollment_end_date'],
    users: ['id','is_active','suspended_until'], tenants: ['id','status'], groups: ['id','name','course_id','branch_scope','branch_id'],
    courses: ['id','name','tenant_id','is_active'], branches: ['id','tenant_id','status'], student_courses: ['student_id','course_id','status'],
    schedule_sessions: ['id','tenant_id','group_id','audience','title','starts_at','ends_at','status'],
    attendance_records: ['session_id','tenant_id','student_id','state'],
};
const recent = (state: string | null = 'present', id = 'session-one') => ({ id, title: 'Past lesson', starts_at: '2026-11-05T09:00:00.000Z', ends_at: '2026-11-05T10:00:00.000Z', state });
const future = () => ({ id: 'session-two', title: 'Next lesson', starts_at: '2026-11-09T09:00:00.000Z', ends_at: '2026-11-09T10:00:00.000Z' });
function fixture() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const state = { revoked: false, secret: secret as string | undefined, noChild: false, noGroup: false, childReads: 0,
        changed: false, dropColumn: false, dropIndex: false, fail: false, revokeAfterRead: false,
        recent: [recent()] as Array<ReturnType<typeof recent>>, future: [future()] };
    const verifier = createParentViewVerifier({ getSecret: () => state.secret, now: () => now,
        store: createSqlParentLinksStore({
            query: async () => { throw Error('unexpected list'); }, execute: async () => { throw Error('unexpected write'); },
            queryOne: async <T>(sql: string) => {
                if (sql.includes('FROM parent_view_tokens')) return { ...claims, issued_at: now, expires_at: new Date(claims.exp), revoked_at: null, revoked_reason: null } as T;
                if (sql.includes('FROM parent_links')) return { id: claims.link_id, ...claims, status: state.revoked ? 'revoked' : 'active', revoked_at: null, version: 0 } as T;
                throw Error('unexpected token query');
            },
        }) });
    const db = { query: async <T>(sql: string, params: unknown[] = []) => {
        calls.push({ sql, params }); assert.match(sql.trim(), /^SELECT /i); assert.doesNotMatch(sql, /SELECT\s+\*|gradebook|answer|parent_phone|guardian_phone/i);
        if (state.fail) throw Error('private driver failure');
        if (sql.includes('information_schema.COLUMNS')) return Object.entries(columns).flatMap(([t, names]) => names.filter(n => !state.dropColumn || n !== 'ends_at').map(n => ({ table_name: t, column_name: n }))) as T[];
        if (sql.includes('information_schema.STATISTICS')) return (state.dropIndex ? [] : [
            ...['tenant_id','group_id','starts_at'].map((column_name,i)=>({table_name:'schedule_sessions',index_name:'idx_schedule_sessions_tenant_group',column_name,seq:i+1,non_unique:1})),
            ...['session_id','student_id'].map((column_name,i)=>({table_name:'attendance_records',index_name:'uq_attendance_student_session',column_name,seq:i+1,non_unique:0})),
        ]) as T[];
        if (sql.includes('FROM students s INNER JOIN tenants')) {
            state.childReads++;
            assert.deepEqual(params, [claims.parent_user_id, claims.tenant_id, claims.student_enrollment_id]);
            if (state.noChild) return [];
            return [{ name: 'Child', user_id: 'student-user', group_id: state.noGroup ? null : state.changed && state.childReads > 1 ? 'changed' : 'group-one',
                group_name: state.noGroup ? null : 'Group', course_id: state.noGroup ? null : 'course-one', course_name: state.noGroup ? null : 'Math',
                branch_scope: 'tenant', branch_id: null }] as T[];
        }
        if (sql.includes('FROM schedule_sessions ss')) {
            if (sql.includes('LEFT JOIN attendance_records')) return state.recent as T[];
            if (state.revokeAfterRead) state.revoked = true;
            return state.future as T[];
        }
        throw Error('unexpected SQL');
    } };
    const router = createFamilySummaryRouter({ db, verifier, now: () => now });
    const request = (viewToken: string | null = token, query: Record<string, string> = {}) => invokeRoute(router, { method: 'GET', url: '/', token: viewToken, query });
    return { state, calls, router, db, verifier, request };
}

test('family journey returns bounded current-group evidence, separate attendance states and one honest action', async () => {
    const h = fixture(); h.state.recent = ['present','absent','late','excused',null].map((s,i) => recent(s, 'past-' + i));
    const response = await h.request(); assert.equal(response.statusCode, 200);
    const summary = response.body as FamilySummary;
    assert.deepEqual(summary.attendance.counts, { present: 1, absent: 1, late: 1, excused: 1, unmarked: 1 });
    assert.equal(summary.next_action, 'check_attendance'); assert.equal(summary.agenda[0].title, 'Next lesson');
    assert.deepEqual(summary.grades, { status: 'unavailable', reason: 'publication_contract_required' });
    assert.equal(summary.window.from, '2026-10-31T10:00:00.000Z'); assert.equal(summary.window.to, '2026-11-14T10:00:00.000Z');
    assert.equal(response.headers?.['cache-control'], 'no-store'); assert.equal(response.headers?.vary, 'Authorization');
    assert.doesNotMatch(JSON.stringify(summary), /parent-one|tenant-one|child-one|student-user|token-one|link-one/);
});
test('mounted parent composition exposes the new endpoint before legacy authentication without double dispatch', async () => {
    const h = fixture(), app = Router();
    app.use('/api/parent', createParentViewsRouter({ verifier: h.verifier, familyDb: h.db, now: () => now, store: {} as never }));
    const r = await invokeRoute(app, { method: 'GET', url: '/api/parent/family-summary', token });
    assert.equal(r.statusCode, 200); assert.equal(h.state.childReads, 2);
});
test('real scoped verifier rejects standard bearer, revoked relationship, expiry and absent secret before private reads', async () => {
    for (const kind of ['missing','standard','tampered','revoked','expired','secret']) {
        const h = fixture(); let bearer: string | null = token;
        if (kind === 'missing') bearer = null; if (kind === 'standard') bearer = 'ordinary-login-token';
        if (kind === 'tampered') bearer += 'x'; if (kind === 'revoked') h.state.revoked = true;
        if (kind === 'expired') bearer = signParentViewToken(secret, { ...claims, exp: now.getTime() });
        if (kind === 'secret') h.state.secret = undefined;
        const r = await h.request(bearer); assert.equal(r.statusCode, kind === 'secret' ? 503 : 401, kind);
        assert.equal(h.calls.length, 0); assert.equal(r.headers?.['cache-control'], 'no-store');
    }
});
test('selectors cannot choose a child or date and every denial is private no-store', async () => {
    for (const query of [{ child: 'foreign' }, { tenant_id: 'foreign' }, { from: '2020-01-01' }]) {
        const h = fixture(), r = await h.request(token, query); assert.equal(r.statusCode, 400); assert.equal(h.calls.length, 0);
    }
    const h = fixture(), wrapper = Router();
    wrapper.use((req, _res, next) => { req.headers['x-tenant-id'] = 'foreign'; next(); }); wrapper.use(h.router);
    assert.equal((await invokeRoute(wrapper, { method: 'GET', url: '/', token })).statusCode, 400);
});
test('a signed token for a different parent, enrollment or tenant cannot use the original verified relationship', async () => {
    for (const field of ['tenant_id','student_enrollment_id','parent_user_id'] as const) {
        const h = fixture(), foreign = signParentViewToken(secret, { ...claims, [field]: 'foreign' });
        const r = await h.request(foreign); assert.equal(r.statusCode, 401); assert.equal(h.calls.length, 0);
    }
});
test('revocation while reading, changed current group and inactive enrollment discard the complete response', async () => {
    for (const kind of ['revoke','group','inactive']) {
        const h = fixture(); if (kind === 'revoke') h.state.revokeAfterRead = true;
        if (kind === 'group') h.state.changed = true; if (kind === 'inactive') h.state.noChild = true;
        const r = await h.request(); assert.equal(r.statusCode, kind === 'revoke' ? 401 : 404);
        assert.doesNotMatch(JSON.stringify(r.body), /Child|Group|Next lesson/);
    }
});
test('missing current group is unknown attendance rather than a claim of zero absence', async () => {
    const h = fixture(); h.state.noGroup = true; const r = await h.request(), s = r.body as FamilySummary;
    assert.equal(r.statusCode, 200); assert.equal(s.scope, 'no_current_group'); assert.equal(s.next_action, 'contact_teacher');
    assert.equal(s.child.course, null); assert.equal(h.calls.some(c => c.sql.includes('FROM schedule_sessions')), false);
});
test('unmarked, excused, future-only and empty sources choose distinct non-punitive actions', async () => {
    for (const [rows, upcoming, action] of [
        [[recent(null)], [], 'confirm_unmarked'], [[recent('excused')], [future()], 'prepare_next_session'], [[], [], 'no_action'],
    ] as const) {
        const h = fixture(); h.state.recent = [...rows]; h.state.future = [...upcoming];
        assert.equal(((await h.request()).body as FamilySummary).next_action, action);
    }
});
test('overflow, duplicate source, malformed dates/state, missing schema and SQL failures fail closed without payload leakage', async () => {
    const cases = [
        (h: ReturnType<typeof fixture>) => { h.state.recent = Array.from({length:101}, (_,i) => recent('present', String(i))); },
        (h: ReturnType<typeof fixture>) => { h.state.future = Array.from({length:101}, () => future()); },
        (h: ReturnType<typeof fixture>) => { h.state.recent.push(recent()); },
        (h: ReturnType<typeof fixture>) => { h.state.recent[0].state = 'unknown'; },
        (h: ReturnType<typeof fixture>) => { h.state.recent[0].starts_at = '2026-11-05 09:00:00'; },
        (h: ReturnType<typeof fixture>) => { h.state.recent[0].ends_at = '2026-11-08T10:00:00.000Z'; },
        (h: ReturnType<typeof fixture>) => { h.state.dropColumn = true; },
        (h: ReturnType<typeof fixture>) => { h.state.dropIndex = true; },
        (h: ReturnType<typeof fixture>) => { h.state.fail = true; },
    ];
    for (const setup of cases) { const h = fixture(); setup(h); const r = await h.request(); assert.equal(r.statusCode, 503); assert.deepEqual(r.body, {code:'FAMILY_SUMMARY_UNAVAILABLE'}); }
});
test('SQL derives enrollment and audience authority from live scoped rows and bounds both time windows', async () => {
    const h = fixture(); await h.request(); const child = h.calls.find(c => c.sql.includes('FROM students s INNER'))!;
    for (const predicate of ['t.status=\'active\'','su.is_active=1','pu.is_active=1','su.suspended_until','pu.suspended_until',"sc.status='active'",'c.tenant_id=s.tenant_id',"b.status='active'",'s.enrollment_end_date>UTC_TIMESTAMP()']) assert.ok(child.sql.includes(predicate), predicate);
    const sessions = h.calls.filter(c => c.sql.includes('FROM schedule_sessions'));
    assert.equal(sessions.length, 2);
    for (const c of sessions) {
        for (const predicate of ['ss.tenant_id=?','ss.group_id=?',"ss.audience='group'","ss.status='scheduled'",'ss.starts_at>=?','ss.starts_at<?','LIMIT 101','ss.starts_at>=s.enrollment_start_date','ss.ends_at<=s.enrollment_end_date']) assert.ok(c.sql.includes(predicate), predicate);
        assert.ok(c.params.includes(claims.tenant_id)); assert.ok(c.params.includes(claims.student_enrollment_id));
    }
    assert.ok(sessions[0].sql.includes('a.tenant_id=ss.tenant_id AND a.student_id=?'));
});
test('parent link discovery/session issuance refuses staff identity namespace, billing-only and impersonation before DB access', async () => {
    for (const kind of ['staff','billing','impersonation']) {
        const noDb = async (): Promise<never> => { throw Error('must not touch DB'); };
        const router = createParentLinksRouter({ db: { query: noDb, queryOne: noDb, execute: noDb },
            authenticate: (req, _res, next) => {
                (req as AuthRequest).user = { id: 'parent-one', role: 'student', identitySource: kind === 'staff' ? 'staff' : 'users', billingOnly: kind === 'billing' } as AuthRequest['user'];
                if (kind === 'impersonation') req.headers['x-impersonation'] = 'opaque-context'; next();
            }, loadActiveTenantAuthority: noDb, getOtpService: () => null, getSecret: () => secret });
        for (const [method,url] of [['GET','/'],['POST','/link-one/session'],['POST','/request']]) {
            const r = await invokeRoute(router, { method,url,token:'ordinary-login-token' });
            assert.equal(r.statusCode,403);assert.equal(r.headers?.['cache-control'],'no-store');
        }
    }
});
