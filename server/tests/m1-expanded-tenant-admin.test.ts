import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import { createRequireAdminPermission } from '../src/security/admin-permissions';
import type { PrincipalRepository } from '../src/security/principal-repository';

// The tenant routers transitively load ../services/minio, whose module body
// constructs a client and refuses to load without credentials. Dummy,
// non-secret values are set BEFORE the routers are dynamically imported in the
// `before` hook below; the client is never connected and no real env key or
// secret is read.
process.env.MINIO_ACCESS_KEY ??= 'test-access-key';
process.env.MINIO_SECRET_KEY ??= 'test-secret-key';

let createTenantSelfRouter: typeof import('../src/routes/tenant-self')['createTenantSelfRouter'];
let createPlatformTenantsRouter: typeof import('../src/routes/platform-tenants')['createPlatformTenantsRouter'];

/**
 * M1 expanded tenant-admin boundary regressions (behavioral, hermetic).
 *
 * Drives the PRODUCTION platform tenants router (createPlatformTenantsRouter,
 * mounted at /api/admin/platform) and the PRODUCTION tenant self-service router
 * (createTenantSelfRouter, mounted at /api/tenants/me) through injected seams:
 * a fixture-backed SQL adapter, the REAL authentication middleware
 * (createAuthenticateToken over an injected principal repository), the REAL
 * platform-capability guard (createRequireAdminPermission over an injected
 * lookup), the REAL server-owned tenant-authority lookup contract, and
 * fixture-backed stand-ins for the MinIO and billing service helpers the
 * routers consume. No database, network, Docker, provider or live app startup
 * is contacted.
 *
 * Authority model under test (deny by default):
 *  - a platform route is reachable only through a server-verified platform
 *    capability (active super_admin or the required admin permission key);
 *    a bare authenticated principal, including a tenant owner, is denied and a
 *    permission-lookup failure denies with 503 instead of failing open;
 *  - the tenant self-service router resolves its tenant from the tenant the
 *    authentication middleware SELECTED from the token selector against the
 *    caller's active memberships, and only the server-owned authority contract
 *    (verified owner row, or active membership role_key owner/instructor in an
 *    active tenant by an active user) grants access. An arbitrary LIMIT 1
 *    membership, a non-teaching membership, an unselected workspace and a
 *    forged/absent tenant never resolve.
 *
 * Evidence classes used below, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, response
 *    bodies, whether any data-access call was reached);
 *  - decision-boundary (SQL text + params of the executed query): the tenant
 *    scope is applied by the WHERE clause and by the injected authority
 *    lookup, so hermetically the suite asserts the exact SQL/bindings and the
 *    exact (userId, tenantId) authority probes the real handler executed. Live
 *    row-level filtering remains the Docker integration suite's
 *    responsibility (NOT RUN here).
 *
 * Test limits (explicit):
 *  - The multipart POST /api/tenants/me/topups handler is NOT exercised here:
 *    driving multer's parser without an HTTP layer is not meaningful
 *    hermetically, so the top-up submission path stays a live limit.
 *  - The routers are invoked as middleware with fake req/res objects (no
 *    supertest in the repo), matching the established M1 boundary pattern.
 *  - Importing the route factories transitively loads ../db (dotenv.config is
 *    a no-op: no .env exists) and ../services/minio (constructs a client, no
 *    connection). The test itself imports no dotenv/DB/network module and no
 *    production query ever reaches a pool.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
before(async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    ({ createTenantSelfRouter } = await import('../src/routes/tenant-self'));
    ({ createPlatformTenantsRouter } = await import('../src/routes/platform-tenants'));
});
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const STAFF_MEMBER = 'staff-member';
const INSTRUCTOR_MEMBER = 'instructor-member';
const ADMIN_READ = 'admin-read';
const ADMIN_FIN = 'admin-fin';
const ADMIN_PAYREAD = 'admin-payread';
const PLAIN = 'plain-user';

interface IdentityRow { is_active: number; token_version: number; suspension_active: number }

interface State {
    users: Record<string, IdentityRow>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, string[]>;
    tenantOwner: Record<string, string>;
    membershipRole: Record<string, string>;
    tenantRows: Array<{ id: string; business_name: string; status: string; legacy_compat: number; owner_user_id: string }>;
    adminPermissions: Record<string, string[]>;
    plans: Array<Record<string, unknown>>;
    tenantList: Array<Record<string, unknown>>;
    paymentList: Array<Record<string, unknown>>;
    topups: Array<Record<string, unknown>>;
    pendingSubscriptions: Array<{ id: string; tenant_id: string }>;
    verifyPayments: Array<Record<string, unknown>>;
    selfSubscription: Array<Record<string, unknown>>;
    selfBillingSubscription: Array<Record<string, unknown>>;
    wallets: Record<string, { balance: string; updated_at: string | null }>;
    renewableSubscriptions: Array<Record<string, unknown>>;
    pendingIntents: Array<{ id: string; tenant_id: string }>;
    cancellableIntents: Array<{ id: string; instructor_id: string; status: string }>;
}

const activeIdentity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });

function makeState(): State {
    return {
        users: {
            [OWNER_A]: activeIdentity(), [OWNER_B]: activeIdentity(), [STAFF_MEMBER]: activeIdentity(),
            [INSTRUCTOR_MEMBER]: activeIdentity(), [ADMIN_READ]: activeIdentity(), [ADMIN_FIN]: activeIdentity(),
            [ADMIN_PAYREAD]: activeIdentity(), [PLAIN]: activeIdentity(),
        },
        instructorAccounts: {
            [OWNER_A]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            [OWNER_B]: { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
        memberships: {
            [OWNER_A]: [TENANT_A],
            [OWNER_B]: [TENANT_B],
            [STAFF_MEMBER]: [TENANT_A],
            [INSTRUCTOR_MEMBER]: [TENANT_A],
        },
        tenantOwner: { [TENANT_A]: OWNER_A, [TENANT_B]: OWNER_B },
        membershipRole: {
            [`${OWNER_A}@${TENANT_A}`]: 'owner',
            [`${INSTRUCTOR_MEMBER}@${TENANT_A}`]: 'instructor',
            [`${STAFF_MEMBER}@${TENANT_A}`]: 'staff',
            [`${OWNER_B}@${TENANT_B}`]: 'owner',
        },
        tenantRows: [
            { id: TENANT_A, business_name: 'Alpha Academy', status: 'active', legacy_compat: 0, owner_user_id: OWNER_A },
            { id: TENANT_B, business_name: 'Beta Academy', status: 'active', legacy_compat: 0, owner_user_id: OWNER_B },
        ],
        adminPermissions: {
            [ADMIN_READ]: ['instructor.read', 'subscription.read'],
            [ADMIN_FIN]: ['instructor.read', 'subscription.read', 'subscription.create', 'finance.read', 'platform_payment.verify', 'platform_payment.read'],
            [ADMIN_PAYREAD]: ['platform_payment.read'],
            [PLAIN]: [],
        },
        plans: [{ id: 'plan-1', code: 'basic', name: 'Basic', duration_months: 1, duration_days: 0, price: '300.00', currency: 'EGP', is_active: 1 }],
        tenantList: [{
            id: TENANT_A, business_name: 'Alpha Academy', subject_type: 'company', status: 'active', legacy_compat: 0,
            owner_user_id: OWNER_A, owner_name: 'Owner A', owner_phone: '0100', subscription_id: 'sub-a',
            subscription_status: 'active', agreed_price: '300.00', period_ends_at: null, grace_until: null,
        }],
        paymentList: [{
            id: 'pay-1', subscription_id: 'sub-a', amount: '300.00', method: 'instapay', reference_number: 'REF-1',
            status: 'verified', submitted_by: OWNER_A, created_at: null, tenant_id: TENANT_A, business_name: 'Alpha Academy',
        }],
        topups: [{
            id: 'topup-1', tenant_id: TENANT_A, instructor_id: OWNER_A, purpose_code: 'other', amount: '100.00',
            currency: 'EGP', method: 'instapay', reference_number: 'REF-T1', paid_at: null, notes: 'n', status: 'submitted',
            rejection_reason: null, reviewed_at: null, created_at: null, proof_object_key: 'proofs/topup-1.pdf',
            business_name: 'Alpha Academy', instructor_name: 'Owner A', instructor_phone: '0100', reviewer_name: null,
        }],
        pendingSubscriptions: [],
        verifyPayments: [],
        selfSubscription: [{
            tenant_id: TENANT_A, business_name: 'Alpha Academy', tenant_status: 'active', legacy_compat: 0,
            subscription_id: 'sub-a', subscription_status: 'active', agreed_price: '300.00', discount_amount: '0.00',
            currency: 'EGP', starts_at: null, period_ends_at: null, grace_until: null, plan_name: 'Basic',
            duration_months: 1, duration_days: 0, days_remaining: 10, grace_seconds_remaining: 0,
        }],
        selfBillingSubscription: [{
            id: 'sub-a', tenant_id: TENANT_A, status: 'active', plan_id: 'plan-1', agreed_price: '300.00', discount_amount: '0.00',
            currency: 'EGP', starts_at: null, period_ends_at: null, grace_until: null, plan_name: 'Basic',
            duration_months: 1, duration_days: 0, period_seconds_remaining: 100, grace_seconds_remaining: 0,
        }],
        wallets: { [OWNER_A]: { balance: '500.00', updated_at: null } },
        renewableSubscriptions: [{ id: 'sub-a', tenant_id: TENANT_A, plan_id: 'plan-1', agreed_price: '300.00', discount_amount: '0.00', status: 'active' }],
        pendingIntents: [],
        cancellableIntents: [
            { id: 'intent-1', tenant_id: TENANT_A, instructor_id: OWNER_A, status: 'pending' },
            { id: 'intent-foreign', tenant_id: TENANT_B, instructor_id: OWNER_A, status: 'pending' },
        ],
    };
}

interface Call { sql: string; params: any[] }

/** Fixture SQL dispatcher: returns a rows array for SELECT, a header for writes. */
function makeDispatch(state: State) {
    return (sql: string, params: any[]): any => {
        const n = sql.replace(/\s+/g, ' ').trim();

        // ---- platform tenants router ----
        if (n.includes('FROM platform_plans ORDER BY duration_months')) return state.plans.map(p => ({ ...p }));
        if (n.includes('FROM tenants t INNER JOIN users u ON u.id=t.owner_user_id')) return state.tenantList.map(r => ({ ...r }));
        if (n.includes('FROM platform_payment_attempts p INNER JOIN tenant_subscriptions s ON s.id=p.subscription_id INNER JOIN tenants t')) return state.paymentList.map(r => ({ ...r }));
        if (n.includes('FROM instructor_topup_requests r INNER JOIN tenants t') && n.includes('WHERE r.id=? FOR UPDATE')) {
            const row = state.topups.find(t => t.id === params[0]);
            return row ? [{ ...row, tenant_status: 'active' }] : [];
        }
        if (n.includes('SELECT proof_object_key FROM instructor_topup_requests WHERE id=?')) {
            if (n.includes('AND tenant_id=?')) {
                const row = state.topups.find(t => t.id === params[0] && t.tenant_id === params[1] && t.instructor_id === params[2]);
                return row ? [{ proof_object_key: row.proof_object_key }] : [];
            }
            // Platform router opens a proof by id under an admin capability (no tenant scope).
            const row = state.topups.find(t => t.id === params[0]);
            return row ? [{ proof_object_key: row.proof_object_key }] : [];
        }
        if (n.includes('SELECT id,status,legacy_compat FROM tenants WHERE id=? FOR UPDATE')) {
            const row = state.tenantRows.find(t => t.id === params[0]);
            return row ? [{ ...row }] : [];
        }
        if (n.includes("SELECT id FROM tenant_subscriptions WHERE tenant_id=? AND status='pending'")) {
            return state.pendingSubscriptions.filter(s => s.tenant_id === params[0]).map(s => ({ id: s.id }));
        }
        if (n.includes('SELECT id,price FROM platform_plans WHERE id=? AND is_active=1')) {
            const plan = state.plans.find(p => p.id === params[0] && p.is_active === 1);
            return plan ? [{ id: plan.id, price: plan.price }] : [];
        }
        if (n.includes('FROM platform_payment_attempts p') && n.includes('INNER JOIN platform_plans pl') && n.includes('WHERE p.id=? FOR UPDATE')) {
            const row = state.verifyPayments.find(p => p.id === params[0]);
            return row ? [{ ...row }] : [];
        }
        if (n.includes('SELECT DATE_FORMAT(MAX(period_ends_at)')) return [{ previous_end: null, now_utc: '2026-10-16 00:00:00' }];
        if (n.includes('SELECT instructor_id FROM instructor_topup_requests WHERE id=? AND status=')) {
            const row = state.topups.find(t => t.id === params[0] && t.status === 'submitted');
            return row ? [{ instructor_id: row.instructor_id }] : [];
        }

        // ---- tenant self router ----
        if (n.includes('SELECT t.id,t.business_name,t.status,t.legacy_compat,t.owner_user_id FROM tenants t WHERE t.id=?')) {
            const row = state.tenantRows.find(t => t.id === params[0]);
            return row ? [{ ...row }] : [];
        }
        if (n.includes('SELECT t.id AS tenant_id') && n.includes('FROM tenants t LEFT JOIN tenant_subscriptions s')) {
            const row = state.selfSubscription.find(s => s.tenant_id === params[0]);
            return row ? [{ ...row }] : [];
        }
        if (n.includes('FROM tenant_subscriptions s INNER JOIN platform_plans p ON p.id=s.plan_id WHERE s.tenant_id=?')) {
            const row = state.selfBillingSubscription.find(s => s.tenant_id === params[0]);
            return row ? [{ ...row }] : [];
        }
        if (n.includes('SELECT balance,updated_at FROM instructor_wallets WHERE instructor_id=?')) {
            const wallet = state.wallets[params[0]];
            return wallet ? [{ ...wallet }] : [];
        }
        if (n.includes('FROM tenant_renewal_intents i INNER JOIN platform_plans p') && n.includes("status='pending'")) return [];
        if (n.includes('FROM instructor_topup_requests WHERE tenant_id=? ORDER BY created_at DESC')) {
            return state.topups.filter(t => t.tenant_id === params[0]).map(t => ({ ...t }));
        }
        if (n.includes("SELECT id FROM tenant_renewal_intents WHERE tenant_id=? AND status='pending' FOR UPDATE")) {
            return state.pendingIntents.filter(i => i.tenant_id === params[0]).map(i => ({ id: i.id }));
        }
        if (n.includes('SELECT id,plan_id,agreed_price,discount_amount,status FROM tenant_subscriptions')) {
            const row = state.renewableSubscriptions.find(s => s.tenant_id === params[0]);
            return row ? [{ ...row }] : [];
        }
        if (n.includes('SELECT balance FROM instructor_wallets WHERE instructor_id=? FOR UPDATE')) {
            return [{ balance: state.wallets[params[0]]?.balance ?? '0.00' }];
        }

        // ---- writes ----
        if (n.startsWith('UPDATE ') || n.startsWith('INSERT ') || n.startsWith('DELETE ')) {
            if (n.includes("UPDATE tenant_renewal_intents SET status='cancelled'")) {
                const row = state.cancellableIntents.find(i => i.id === params[0] && i.tenant_id === params[1] && i.instructor_id === params[2] && i.status === 'pending');
                if (!row) return { affectedRows: 0 };
                row.status = 'cancelled';
                return { affectedRows: 1 };
            }
            return { affectedRows: 1 };
        }

        throw new Error(`Unhandled SQL in hermetic fixture: ${n}`);
    };
}

interface Harness {
    tenantSelf: Router;
    platform: Router;
    calls: Call[];
    authorityCalls: Array<{ userId: string; tenantId: string }>;
}

function buildHarness(state: State, opts: { adminLookupFails?: boolean } = {}): Harness {
    const calls: Call[] = [];
    const authorityCalls: Array<{ userId: string; tenantId: string }> = [];
    const dispatch = makeDispatch(state);

    const record = (sql: string, params: any[]) => { calls.push({ sql, params }); };

    const db = {
        query: async (sql: string, params?: any[]) => { record(sql, params ?? []); return dispatch(sql, params ?? []) as any[]; },
        queryOne: async (sql: string, params?: any[]) => { const rows = await db.query(sql, params); return rows.length ? rows[0] : null; },
        execute: async (sql: string, params?: any[]) => { record(sql, params ?? []); return dispatch(sql, params ?? []); },
        getConnection: async () => ({
            beginTransaction: async () => { /* no-op */ },
            execute: async (sql: string, params?: any[]) => { record(sql, params ?? []); return [dispatch(sql, params ?? []), []] as [any, any]; },
            commit: async () => { /* no-op */ },
            rollback: async () => { /* no-op */ },
            release: () => { /* no-op */ },
        }),
    };

    const repository: PrincipalRepository = {
        findUsersIdentity: async (id) => state.users[id] ?? null,
        findStaffIdentity: async () => null,
        findInstructorAccount: async (id) => state.instructorAccounts[id] ?? null,
        findStudentEnrollments: async () => [],
        findActiveTenantMemberships: async (id) => (state.memberships[id] ?? []).map(tenant_id => ({ tenant_id })),
    };

    const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
        authorityCalls.push({ userId, tenantId });
        const tenantActive = state.tenantRows.find(t => t.id === tenantId)?.status === 'active';
        if (!tenantActive) return null;
        if (state.tenantOwner[tenantId] === userId) return { authority: 'owner' };
        const role = state.membershipRole[`${userId}@${tenantId}`];
        if (role && (role === 'owner' || role === 'instructor')) return { authority: role };
        return null;
    };

    const adminLookup = {
        isSuperAdmin: async () => false,
        getAdminPermissions: async (id: string) => {
            if (opts.adminLookupFails) throw new Error('admin permission store unavailable');
            return state.adminPermissions[id] ?? [];
        },
    };

    const authenticate = createAuthenticateToken(repository) as RequestHandler;

    const tenantSelf = createTenantSelfRouter({
        db,
        authenticate,
        loadActiveTenantAuthority,
        uploadBuffer: async () => { /* fixture */ },
        deleteFile: async () => { /* fixture */ },
        getPrivateObjectUrl: async (_bucket: string, objectKey: string) => `https://signed.example/${objectKey}`,
        executeRenewalIntent: async () => ({ status: 'executed' as const }),
    });

    const platform = createPlatformTenantsRouter({
        db,
        authenticate,
        requireAdminPermission: (permission: string) => createRequireAdminPermission(permission, adminLookup),
        getAdminPermissions: adminLookup.getAdminPermissions,
        isSuperAdmin: adminLookup.isSuperAdmin,
        postServiceCreditEntry: async () => ({ balance: '0.00', transactionId: 1 }),
        executeRenewalIntent: async () => ({ status: 'executed' as const }),
        getPrivateObjectUrl: async (_bucket: string, objectKey: string) => `https://signed.example/${objectKey}`,
    });

    return { tenantSelf, platform, calls, authorityCalls };
}

function sign(id: string, role: string, extra: Record<string, unknown> = {}): string {
    return jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m' });
}

interface ReqOptions { token?: string; body?: any; query?: any }

function makeReq(method: string, url: string, originalUrl: string, opts: ReqOptions = {}) {
    const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
    return {
        method,
        url,
        originalUrl,
        headers,
        query: opts.query ?? {},
        body: opts.body ?? {},
        params: {},
        header(name: string) { return headers[name.toLowerCase()]; },
    };
}

function invoke(router: Router, req: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const res: any = {
            statusCode: 200,
            status(code: number) { this.statusCode = code; return this; },
            setHeader() { return this; },
            json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
            send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
            end() { resolve({ status: this.statusCode, body: undefined }); },
        };
        const next = (err?: any) => { if (err) reject(err); else resolve({ status: 404, body: undefined }); };
        try { (router as unknown as (req: any, res: any, next: any) => void)(req, res, next); }
        catch (error) { reject(error); }
    });
}

const findCall = (calls: Call[], fragment: string) => calls.find(c => c.sql.replace(/\s+/g, ' ').includes(fragment));

// ===========================================================================
// Tenant self-service boundary (/api/tenants/me)
// ===========================================================================

test('tenant self-service: owner reads subscription inside the SELECTED tenant (allow, decision-boundary)', async () => {
    const state = makeState();
    const { tenantSelf, calls, authorityCalls } = buildHarness(state);
    const res = await invoke(tenantSelf, makeReq('GET', '/subscription', '/api/tenants/me/subscription', { token: sign(OWNER_A, 'instructor') }));

    assert.equal(res.status, 200);
    assert.equal(res.body.tenant_id, TENANT_A);
    assert.deepEqual(authorityCalls, [{ userId: OWNER_A, tenantId: TENANT_A }], 'authority must be probed for the server-selected tenant only');
    const scoped = findCall(calls, 'FROM tenants t LEFT JOIN tenant_subscriptions s');
    assert.ok(scoped, 'subscription read must run after authority resolution');
    assert.deepEqual(scoped!.params, [TENANT_A], 'the subscription query must bind the selected tenant id, never an arbitrary membership');
});

test('tenant self-service: non-teaching member cannot read the tenant subscription (deny before data access)', async () => {
    const state = makeState();
    const { tenantSelf, calls, authorityCalls } = buildHarness(state);
    const res = await invoke(tenantSelf, makeReq('GET', '/subscription', '/api/tenants/me/subscription', { token: sign(STAFF_MEMBER, 'teacher') }));

    assert.equal(res.status, 404);
    assert.deepEqual(authorityCalls, [{ userId: STAFF_MEMBER, tenantId: TENANT_A }]);
    assert.equal(findCall(calls, 'FROM tenants t LEFT JOIN tenant_subscriptions s'), undefined, 'no subscription data may be read without teaching authority');
    assert.equal(findCall(calls, 'FROM tenants t WHERE t.id=?'), undefined, 'no tenant row may be read without teaching authority');
});

test('tenant self-service: authenticated principal with no selected workspace is denied without any authority probe', async () => {
    const state = makeState();
    const { tenantSelf, calls, authorityCalls } = buildHarness(state);
    const res = await invoke(tenantSelf, makeReq('GET', '/subscription', '/api/tenants/me/subscription', { token: sign(PLAIN, 'teacher') }));

    assert.equal(res.status, 404);
    assert.deepEqual(authorityCalls, [], 'deny-by-default must short-circuit before any authority or data lookup');
    assert.equal(calls.length, 0, 'no SQL may run for a principal without a selected workspace');
});

test('tenant self-service: billing center is owner/teaching scoped (allow owner, deny non-teaching member)', async () => {
    const allowState = makeState();
    const allow = buildHarness(allowState);
    const allowed = await invoke(allow.tenantSelf, makeReq('GET', '/billing', '/api/tenants/me/billing', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.tenant.id, TENANT_A);
    assert.equal(allowed.body.subscription.id, 'sub-a');
    assert.deepEqual(findCall(allow.calls, 'FROM instructor_topup_requests WHERE tenant_id=? ORDER BY created_at DESC')!.params, [TENANT_A]);

    const denyState = makeState();
    const deny = buildHarness(denyState);
    const denied = await invoke(deny.tenantSelf, makeReq('GET', '/billing', '/api/tenants/me/billing', { token: sign(STAFF_MEMBER, 'teacher') }));
    assert.equal(denied.status, 404);
    assert.equal(findCall(deny.calls, 'FROM tenant_subscriptions s INNER JOIN platform_plans p'), undefined, 'no billing rows may be read without teaching authority');
});

test('tenant self-service: top-up proof URL is owner-of-record scoped', async () => {
    const state = makeState();
    const { tenantSelf } = buildHarness(state);
    const own = await invoke(tenantSelf, makeReq('GET', '/topups/topup-1/proof-url', '/api/tenants/me/topups/topup-1/proof-url', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(own.status, 200);
    assert.match(own.body.url, /proofs\/topup-1\.pdf$/);

    const other = await invoke(tenantSelf, makeReq('GET', '/topups/topup-1/proof-url', '/api/tenants/me/topups/topup-1/proof-url', { token: sign(OWNER_B, 'instructor') }));
    assert.equal(other.status, 404, 'a different owner must not read another instructor top-up proof');
});

test('tenant self-service: manual renewal requires confirmation, teaching authority and sufficient balance', async () => {
    const state = makeState();
    const { tenantSelf } = buildHarness(state);

    const unconfirmed = await invoke(tenantSelf, makeReq('POST', '/renewal-intents/manual', '/api/tenants/me/renewal-intents/manual', { token: sign(OWNER_A, 'instructor'), body: {} }));
    assert.equal(unconfirmed.status, 400);

    const nonTeaching = await invoke(tenantSelf, makeReq('POST', '/renewal-intents/manual', '/api/tenants/me/renewal-intents/manual', { token: sign(STAFF_MEMBER, 'teacher'), body: { confirmed: true } }));
    assert.equal(nonTeaching.status, 403);

    state.wallets[OWNER_A] = { balance: '10.00', updated_at: null };
    const insufficient = await invoke(tenantSelf, makeReq('POST', '/renewal-intents/manual', '/api/tenants/me/renewal-intents/manual', { token: sign(OWNER_A, 'instructor'), body: { confirmed: true } }));
    assert.equal(insufficient.status, 409);
    assert.equal(insufficient.body.required, 300);

    state.wallets[OWNER_A] = { balance: '500.00', updated_at: null };
    const executed = await invoke(tenantSelf, makeReq('POST', '/renewal-intents/manual', '/api/tenants/me/renewal-intents/manual', { token: sign(OWNER_A, 'instructor'), body: { confirmed: true } }));
    assert.equal(executed.status, 201);
    assert.equal(executed.body.status, 'executed');
});

test('tenant self-service: renewal intent cancel is owner scoped and pending-only', async () => {
    const state = makeState();
    const { tenantSelf } = buildHarness(state);

    const cancelled = await invoke(tenantSelf, makeReq('POST', '/renewal-intents/intent-1/cancel', '/api/tenants/me/renewal-intents/intent-1/cancel', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');

    const notPending = await invoke(tenantSelf, makeReq('POST', '/renewal-intents/intent-1/cancel', '/api/tenants/me/renewal-intents/intent-1/cancel', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(notPending.status, 409, 'an already-cancelled intent cannot transition again');
});

test('tenant self-service: renewal intent cancel requires the SELECTED active tenant authority (no selection / revoked selection denied before any write)', async () => {
    // No selected workspace: authenticated principal with no membership scope.
    const noneState = makeState();
    const none = buildHarness(noneState);
    const res = await invoke(none.tenantSelf, makeReq('POST', '/renewal-intents/intent-1/cancel', '/api/tenants/me/renewal-intents/intent-1/cancel', { token: sign(PLAIN, 'teacher') }));
    assert.equal(res.status, 403, 'a principal with no selected workspace must be denied without touching the row');
    assert.deepEqual(none.authorityCalls, [], 'deny-by-default must short-circuit before any authority probe when there is no selected tenant');
    assert.equal(none.calls.some(c => c.sql.includes("UPDATE tenant_renewal_intents SET status='cancelled'")), false, 'no mutation SQL may run without a selected workspace');
    assert.equal(noneState.cancellableIntents.find(i => i.id === 'intent-1')!.status, 'pending', 'the intent must remain untouched');

    // Revoked selection: the selected tenant no longer grants management authority.
    const revokedState = makeState();
    delete revokedState.tenantOwner[TENANT_A];
    delete revokedState.membershipRole[`${OWNER_A}@${TENANT_A}`];
    const revoked = buildHarness(revokedState);
    const revRes = await invoke(revoked.tenantSelf, makeReq('POST', '/renewal-intents/intent-1/cancel', '/api/tenants/me/renewal-intents/intent-1/cancel', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(revRes.status, 403, 'a revoked/former manager must be denied');
    assert.deepEqual(revoked.authorityCalls, [{ userId: OWNER_A, tenantId: TENANT_A }], 'the selected tenant must be probed once and found lacking');
    assert.equal(revoked.calls.some(c => c.sql.includes("UPDATE tenant_renewal_intents SET status='cancelled'")), false, 'no mutation SQL may run without management authority');
    assert.equal(revokedState.cancellableIntents.find(i => i.id === 'intent-1')!.status, 'pending', 'the intent must remain untouched');
});

test('tenant self-service: renewal intent cancel is scoped to the SELECTED tenant (own selected allows, same-user foreign intent denied)', async () => {
    // Own selected intent: intent id, selected tenant and original creator all match -> allow.
    const ownState = makeState();
    const own = buildHarness(ownState);
    const allowed = await invoke(own.tenantSelf, makeReq('POST', '/renewal-intents/intent-1/cancel', '/api/tenants/me/renewal-intents/intent-1/cancel', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.status, 'cancelled');
    const cancelCall = own.calls.find(c => c.sql.includes("UPDATE tenant_renewal_intents SET status='cancelled'"));
    assert.ok(cancelCall, 'the cancel mutation must run for the selected workspace');
    assert.deepEqual(cancelCall!.params, ['intent-1', TENANT_A, OWNER_A], 'the cancel must bind the selected tenant id, the intent id and the original creator');
    assert.equal(ownState.cancellableIntents.find(i => i.id === 'intent-1')!.status, 'cancelled', 'the selected intent must transition');

    // Same user, different tenant: instructor_id matches but the intent belongs to another workspace -> denied.
    const foreignState = makeState();
    const foreign = buildHarness(foreignState);
    const denied = await invoke(foreign.tenantSelf, makeReq('POST', '/renewal-intents/intent-foreign/cancel', '/api/tenants/me/renewal-intents/intent-foreign/cancel', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(denied.status, 409, 'a foreign intent must never be cancelled through a different selected workspace');
    assert.equal(foreignState.cancellableIntents.find(i => i.id === 'intent-foreign')!.status, 'pending', 'the foreign intent must remain untouched');
});

test('tenant self-service: top-up proof URL is scoped to the SELECTED tenant (own selected allows, other workspace denied)', async () => {
    const state = makeState();
    const { tenantSelf, calls } = buildHarness(state);

    const own = await invoke(tenantSelf, makeReq('GET', '/topups/topup-1/proof-url', '/api/tenants/me/topups/topup-1/proof-url', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(own.status, 200);
    assert.match(own.body.url, /proofs\/topup-1\.pdf$/);
    const proofCall = findCall(calls, 'SELECT proof_object_key FROM instructor_topup_requests');
    assert.ok(proofCall, 'a proof lookup must run for the selected workspace');
    assert.deepEqual(proofCall!.params, ['topup-1', TENANT_A, OWNER_A], 'the proof lookup must bind the selected tenant id, the intent id and the instructor');

    const other = await invoke(tenantSelf, makeReq('GET', '/topups/topup-1/proof-url', '/api/tenants/me/topups/topup-1/proof-url', { token: sign(OWNER_B, 'instructor') }));
    assert.equal(other.status, 404, 'a different selected workspace must not read another tenant top-up proof');
});

// ===========================================================================
// Platform tenants boundary (/api/admin/platform)
// ===========================================================================

test('platform capability guard: allow with the key, deny a bare authenticated principal, fail closed on lookup error', async () => {
    const state = makeState();
    const harness = buildHarness(state);

    const allowed = await invoke(harness.platform, makeReq('GET', '/plans', '/api/admin/platform/plans', { token: sign(ADMIN_READ, 'admin') }));
    assert.equal(allowed.status, 200);
    assert.ok(Array.isArray(allowed.body));

    const denied = await invoke(harness.platform, makeReq('GET', '/plans', '/api/admin/platform/plans', { token: sign(PLAIN, 'admin') }));
    assert.equal(denied.status, 403, 'a JWT role label without a verified platform capability must be denied');

    const ownerDenied = await invoke(harness.platform, makeReq('GET', '/plans', '/api/admin/platform/plans', { token: sign(OWNER_A, 'instructor') }));
    assert.equal(ownerDenied.status, 403, 'a tenant owner is not a platform operator');

    const failing = buildHarness(makeState(), { adminLookupFails: true });
    const unavailable = await invoke(failing.platform, makeReq('GET', '/plans', '/api/admin/platform/plans', { token: sign(ADMIN_READ, 'admin') }));
    assert.equal(unavailable.status, 503, 'a permission-lookup failure must deny with 503, never fail open');
});

test('platform plans: private price projection is gated by finance-read capability', async () => {
    const reader = buildHarness(makeState());
    const redacted = await invoke(reader.platform, makeReq('GET', '/plans', '/api/admin/platform/plans', { token: sign(ADMIN_READ, 'admin') }));
    assert.equal(redacted.status, 200);
    assert.equal(redacted.body[0].price, undefined, 'subscription.read alone must not expose plan price');

    const finance = buildHarness(makeState());
    const visible = await invoke(finance.platform, makeReq('GET', '/plans', '/api/admin/platform/plans', { token: sign(ADMIN_FIN, 'admin') }));
    assert.equal(visible.status, 200);
    assert.equal(visible.body[0].price, '300.00');
});

test('platform tenant list: agreed_price projection is gated by finance-read capability', async () => {
    const reader = buildHarness(makeState());
    const redacted = await invoke(reader.platform, makeReq('GET', '/tenants', '/api/admin/platform/tenants', { token: sign(ADMIN_READ, 'admin') }));
    assert.equal(redacted.status, 200);
    assert.equal(redacted.body.data[0].agreed_price, undefined, 'instructor.read alone must not expose agreed_price');

    const finance = buildHarness(makeState());
    const visible = await invoke(finance.platform, makeReq('GET', '/tenants', '/api/admin/platform/tenants', { token: sign(ADMIN_FIN, 'admin') }));
    assert.equal(visible.status, 200);
    assert.equal(visible.body.data[0].agreed_price, '300.00');
});

test('platform renewal: ineligible tenant states are rejected and an active tenant is accepted', async () => {
    const allow = buildHarness(makeState());
    const created = await invoke(allow.platform, makeReq('POST', '/tenants/tenant-a/renewals', '/api/admin/platform/tenants/tenant-a/renewals', { token: sign(ADMIN_FIN, 'admin'), body: { plan_id: 'plan-1' } }));
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'pending');

    for (const [status, legacy] of [['archived', 0], ['pending', 0], ['active', 1]] as Array<[string, number]>) {
        const state = makeState();
        state.tenantRows[0] = { ...state.tenantRows[0], status, legacy_compat: legacy };
        const harness = buildHarness(state);
        const res = await invoke(harness.platform, makeReq('POST', '/tenants/tenant-a/renewals', '/api/admin/platform/tenants/tenant-a/renewals', { token: sign(ADMIN_FIN, 'admin'), body: { plan_id: 'plan-1' } }));
        assert.equal(res.status, 409, `tenant state ${status}/legacy=${legacy} must not accept a renewal`);
    }
});

test('platform payment verify: segregation of duties, archived tenant and underpayment are rejected; a valid verify succeeds', async () => {
    const makePayment = (overrides: Record<string, unknown>) => ({
        id: 'pay-1', amount: '300.00', status: 'submitted', submitted_by: OWNER_A, subscription_id: 'sub-a',
        tenant_id: TENANT_A, agreed_price: '300.00', discount_amount: '0.00', subscription_status: 'pending',
        duration_months: 1, duration_days: 0, owner_user_id: OWNER_A, tenant_status: 'active', ...overrides,
    });

    const selfVerifyState = makeState();
    selfVerifyState.verifyPayments = [makePayment({ submitted_by: ADMIN_FIN })];
    const selfVerify = buildHarness(selfVerifyState);
    const selfRes = await invoke(selfVerify.platform, makeReq('POST', '/payments/pay-1/verify', '/api/admin/platform/payments/pay-1/verify', { token: sign(ADMIN_FIN, 'admin') }));
    assert.equal(selfRes.status, 403, 'the submitting administrator must not verify their own payment');

    const archivedState = makeState();
    archivedState.verifyPayments = [makePayment({ tenant_status: 'archived' })];
    const archived = buildHarness(archivedState);
    const archivedRes = await invoke(archived.platform, makeReq('POST', '/payments/pay-1/verify', '/api/admin/platform/payments/pay-1/verify', { token: sign(ADMIN_FIN, 'admin') }));
    assert.equal(archivedRes.status, 409);

    const underpaidState = makeState();
    underpaidState.verifyPayments = [makePayment({ amount: '100.00' })];
    const underpaid = buildHarness(underpaidState);
    const underpaidRes = await invoke(underpaid.platform, makeReq('POST', '/payments/pay-1/verify', '/api/admin/platform/payments/pay-1/verify', { token: sign(ADMIN_FIN, 'admin') }));
    assert.equal(underpaidRes.status, 409);

    const validState = makeState();
    validState.verifyPayments = [makePayment({})];
    const valid = buildHarness(validState);
    const validRes = await invoke(valid.platform, makeReq('POST', '/payments/pay-1/verify', '/api/admin/platform/payments/pay-1/verify', { token: sign(ADMIN_FIN, 'admin') }));
    assert.equal(validRes.status, 200);
    assert.equal(validRes.body.status, 'active');
    assert.equal(validRes.body.login_enabled, false, 'a renewal verify must not toggle onboarding login state');
});

test('platform top-up proof URL: read key alone is insufficient, verify capability is required', async () => {
    const readOnly = buildHarness(makeState());
    const denied = await invoke(readOnly.platform, makeReq('GET', '/topups/topup-1/proof-url', '/api/admin/platform/topups/topup-1/proof-url', { token: sign(ADMIN_PAYREAD, 'admin') }));
    assert.equal(denied.status, 403, 'platform_payment.read must not open private payment proofs');

    const verifier = buildHarness(makeState());
    const allowed = await invoke(verifier.platform, makeReq('GET', '/topups/topup-1/proof-url', '/api/admin/platform/topups/topup-1/proof-url', { token: sign(ADMIN_FIN, 'admin') }));
    assert.equal(allowed.status, 200);
    assert.match(allowed.body.url, /proofs\/topup-1\.pdf$/);
});

test('platform top-up reject: reason validation and pending-only transition', async () => {
    const state = makeState();
    const { platform } = buildHarness(state);

    const tooShort = await invoke(platform, makeReq('POST', '/topups/topup-1/reject', '/api/admin/platform/topups/topup-1/reject', { token: sign(ADMIN_FIN, 'admin'), body: { reason: 'no' } }));
    assert.equal(tooShort.status, 400);

    const rejected = await invoke(platform, makeReq('POST', '/topups/topup-1/reject', '/api/admin/platform/topups/topup-1/reject', { token: sign(ADMIN_FIN, 'admin'), body: { reason: 'proof does not match the transfer' } }));
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'rejected');

    state.topups[0] = { ...state.topups[0], status: 'verified' };
    const alreadyProcessed = await invoke(platform, makeReq('POST', '/topups/topup-1/reject', '/api/admin/platform/topups/topup-1/reject', { token: sign(ADMIN_FIN, 'admin'), body: { reason: 'second attempt on a processed request' } }));
    assert.equal(alreadyProcessed.status, 409, 'a processed top-up must not transition again');
});
