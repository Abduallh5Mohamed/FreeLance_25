/**
 * M7 O6 — ISOLATED LIVE MySQL validation of support impersonation.
 *
 * This suite is NOT part of `npm test` and is never picked up by the hermetic
 * runner (`tests/*.test.ts` only): it needs a real MySQL 8 instance and real
 * loopback HTTP. It refuses to run unless the target is the OWNED disposable
 * synthetic database on loopback (see `assertOwnedTarget`).
 *
 * What is validated on the real engine (not a fixture double):
 *  - the ACTUAL production wiring: `optionalAuth` over the real
 *    principal repository, `enforceImpersonationContext` (production verifier
 *    reading the live session row + live actor-permission lookup + real
 *    server-side effective-principal resolution) and the production
 *    impersonation management router with its real `requireAdminPermission`
 *    guards, sealed-audit transaction and `SELECT ... FOR UPDATE` start lock;
 *  - concurrent starts for the SAME target through real distinct connections:
 *    exactly one pending session, the loser refused;
 *  - an independent target starts successfully (no global mutex);
 *  - a failing sealed-audit sink rolls start, approve and revoke back;
 *  - approval persists the expiry instant it announced, and the context it
 *    minted serves immediately with no manual expiry repair;
 *  - withdrawing the starter actor's live `impersonation.start` permission
 *    denies the NEXT request while the users row, token version, target
 *    identity and session row all stay live;
 *  - target deactivation / membership revocation deny the next request;
 *  - signature / expiry / scope / tenant mismatches are refused;
 *  - the actor and the effective principal stay distinct;
 *  - guards run before business routes and the opaque parent path refuses a
 *    presented header;
 *  - the sealed audit chain verifies over the real rows.
 *
 * Secrets come from the private run env file (`M7_LIVE_ENV_FILE`) or the
 * process environment; no value is ever printed by this file.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';

// The private env file is optional: the runner may already export the values.
if (process.env.M7_LIVE_ENV_FILE) {
    dotenv.config({ path: process.env.M7_LIVE_ENV_FILE, override: false });
}

const DB = {
    host: process.env.M7_LIVE_DB_HOST ?? '',
    port: Number(process.env.M7_LIVE_DB_PORT ?? '0'),
    user: process.env.M7_LIVE_DB_USER ?? '',
    password: process.env.M7_LIVE_DB_PASSWORD ?? '',
    database: process.env.M7_LIVE_DB_NAME ?? '',
};
const ROOT_PASSWORD = process.env.M7_LIVE_DB_ROOT_PASSWORD ?? '';
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const IMPERSONATION_SECRET = process.env.IMPERSONATION_TOKEN_SECRET ?? '';

/**
 * Hard isolation guard: loopback host, owned high port, synthetic database
 * name, dedicated test secrets. Anything else is refused before a single
 * connection is opened.
 */
const assertOwnedTarget = (): void => {
    assert.equal(DB.host, '127.0.0.1', 'live validation refuses a non-loopback database host');
    assert.ok(DB.port >= 20000 && DB.port <= 65000, 'live validation requires the owned high port');
    assert.match(DB.database, /^imp_live_[a-z0-9_]+$/, 'live validation refuses a non-synthetic database name');
    assert.ok(DB.user.length > 0, 'live validation requires the owned database user');
    assert.ok(DB.password.length > 0, 'live validation requires the owned database password');
    assert.ok(JWT_SECRET.length >= 32, 'a dedicated test JWT secret (>= 32 chars) is required');
    assert.ok(IMPERSONATION_SECRET.length >= 32, 'a dedicated test impersonation secret (>= 32 chars) is required');
    assert.notEqual(IMPERSONATION_SECRET, JWT_SECRET, 'the impersonation secret must differ from the JWT secret');
};

const TENANT_A = 'a0000000-0000-4000-8000-00000000000a';
const TENANT_B = 'b0000000-0000-4000-8000-00000000000b';
const SUPPORT_A = 'c0000000-0000-4000-8000-000000000001';
const SUPPORT_B = 'c0000000-0000-4000-8000-000000000002';
const SUPPORT_C = 'c0000000-0000-4000-8000-000000000003';
const TARGET_1 = 'd0000000-0000-4000-8000-000000000001';
const TARGET_2 = 'd0000000-0000-4000-8000-000000000002';
const TARGET_3 = 'd0000000-0000-4000-8000-000000000003';
const OWNER_A = 'e0000000-0000-4000-8000-000000000001';
const OWNER_B = 'e0000000-0000-4000-8000-000000000002';

const tokenFor = (id: string, role: string, tenantId?: string) =>
    jwt.sign({ id, role, tv: 0, ...(tenantId ? { tenant_id: tenantId } : {}) }, JWT_SECRET, { expiresIn: '15m' });

const ADMIN_A = tokenFor(SUPPORT_A, 'admin');
const ADMIN_B = tokenFor(SUPPORT_B, 'admin');
const ADMIN_C = tokenFor(SUPPORT_C, 'admin');
const TEACHER_1 = tokenFor(TARGET_1, 'teacher', TENANT_A);

interface LiveModules {
    auth: typeof import('../../src/middleware/auth');
    context: typeof import('../../src/middleware/impersonation-context');
    routes: typeof import('../../src/routes/impersonation');
    services: typeof import('../../src/services/impersonation');
    auditLog: typeof import('../../src/services/audit-log');
    db: typeof import('../../src/db');
}

let modules: LiveModules;
let pool: mysql.Pool;
let rootPool: mysql.Pool;
let server: Server;
let baseUrl = '';
/** The expiry instant the approve route ANNOUNCED (UTC ISO), captured in test 4. */
let approvedExpiresAtIso = '';

interface ApiResponse {
    status: number;
    body: Record<string, unknown>;
}

const api = async (
    method: string,
    path: string,
    options: { token?: string; impersonation?: string; body?: unknown } = {},
): Promise<ApiResponse> => {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(options.impersonation !== undefined ? { 'x-impersonation': options.impersonation } : {}),
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
        body = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
        body = { raw: text };
    }
    return { status: response.status, body };
};

const startBody = (targetUserId: string, tenantId: string, scope: 'read' | 'write' = 'read') => ({
    target_user_id: targetUserId,
    tenant_id: tenantId,
    reason: 'isolated live validation of support impersonation',
    scope,
    duration_seconds: 600,
});

const activeSession = async (targetUserId: string) => {
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM impersonation_sessions WHERE target_user_id=? AND status IN ('pending_approval','active')",
        [targetUserId],
    );
    return rows;
};

const auditCount = async (action: string): Promise<number> => {
    const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM audit_events WHERE action=?',
        [action],
    );
    return Number(rows[0]?.total ?? 0);
};

const impersonationKey = () => Buffer.from(IMPERSONATION_SECRET, 'utf8');

before(async () => {
    assertOwnedTarget();

    // Point the ACTUAL application db module (lazily loaded by the production
    // middlewares/routes) at the owned synthetic database.
    process.env.DB_HOST = DB.host;
    process.env.DB_PORT = String(DB.port);
    process.env.DB_USER = DB.user;
    process.env.DB_PASSWORD = DB.password;
    process.env.DB_NAME = DB.database;
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.IMPERSONATION_TOKEN_SECRET = IMPERSONATION_SECRET;

    // The suite's own connections mirror `src/db.ts`, which pins the pool to
    // `timezone: '+02:00'`. The isolated instance is started with the same
    // `--default-time-zone`, so a TIMESTAMP read here and a TIMESTAMP read
    // through the application pool resolve to the same instant; a mismatched
    // offset would make every live `expires_at` look an hour old.
    pool = mysql.createPool({ ...DB, timezone: '+02:00', connectionLimit: 10, waitForConnections: true });
    rootPool = mysql.createPool({
        host: DB.host, port: DB.port, user: 'root', password: ROOT_PASSWORD,
        database: DB.database, timezone: '+02:00', connectionLimit: 2,
    });
    await pool.query('SELECT 1');
    await rootPool.query('SELECT 1');

    // Fresh synthetic fixture (own database only; no production rows exist).
    for (const table of [
        'impersonation_sessions', 'audit_events', 'audit_chain_head',
        'admin_role_permissions', 'admin_user_roles', 'tenant_memberships',
        'students', 'tenants', 'users', 'admin_roles',
    ]) {
        await pool.query(`DELETE FROM ${table}`);
    }

    await pool.query(
        `INSERT INTO users (id, email, phone, password_hash, name, role, is_active, token_version)
         VALUES (?,?,?,?,?,?,1,0)`,
        [SUPPORT_A, 'support-a@live.invalid', null, 'x', 'Live Support A', 'admin'],
    );
    await pool.query(
        `INSERT INTO users (id, email, phone, password_hash, name, role, is_active, token_version)
         VALUES (?,?,?,?,?,?,1,0)`,
        [SUPPORT_B, 'support-b@live.invalid', null, 'x', 'Live Support B', 'admin'],
    );
    await pool.query(
        `INSERT INTO users (id, email, phone, password_hash, name, role, is_active, token_version)
         VALUES (?,?,?,?,?,?,1,0)`,
        [SUPPORT_C, 'support-c@live.invalid', null, 'x', 'Live Support C', 'admin'],
    );
    for (const [id, name] of [[OWNER_A, 'Owner A'], [OWNER_B, 'Owner B'], [TARGET_1, 'Target One'], [TARGET_2, 'Target Two'], [TARGET_3, 'Target Three']] as const) {
        await pool.query(
            `INSERT INTO users (id, email, phone, password_hash, name, role, is_active, token_version)
             VALUES (?,?,?,?,?,?,1,0)`,
            [id, `${id}@live.invalid`, null, 'x', name, 'teacher'],
        );
    }
    await pool.query(
        `INSERT INTO tenants (id, owner_user_id, business_name, status, legacy_compat)
         VALUES (?,?,?,'active',0)`,
        [TENANT_A, OWNER_A, 'Live Tenant A'],
    );
    await pool.query(
        `INSERT INTO tenants (id, owner_user_id, business_name, status, legacy_compat)
         VALUES (?,?,?,'active',0)`,
        [TENANT_B, OWNER_B, 'Live Tenant B'],
    );
    for (const [userId, tenantId] of [
        [TARGET_1, TENANT_A], [TARGET_2, TENANT_B], [TARGET_3, TENANT_A],
        [OWNER_A, TENANT_A], [OWNER_B, TENANT_B],
    ] as const) {
        await pool.query(
            `INSERT INTO tenant_memberships (id, tenant_id, user_id, role_key, status)
             VALUES (?,?,?,?, 'active')`,
            [randomUUID(), tenantId, userId, 'member'],
        );
    }
    await pool.query(`INSERT INTO admin_roles (code, name) VALUES ('support_agent','Support Agent'), ('approver','Approver')`);
    await pool.query(`INSERT INTO admin_user_roles (user_id, role_code) VALUES (?, 'support_agent'), (?, 'approver'), (?, 'support_agent')`,
        [SUPPORT_A, SUPPORT_B, SUPPORT_C]);
    await pool.query(
        `INSERT INTO admin_role_permissions (role_code, permission_key) VALUES
         ('support_agent','impersonation.start'),
         ('support_agent','impersonation.read'),
         ('approver','impersonation.approve'),
         ('approver','impersonation.manage')`,
    );

    // Import the REAL application modules after the env points at the owned DB.
    modules = {
        auth: await import('../../src/middleware/auth'),
        context: await import('../../src/middleware/impersonation-context'),
        routes: await import('../../src/routes/impersonation'),
        services: await import('../../src/services/impersonation'),
        auditLog: await import('../../src/services/audit-log'),
        db: await import('../../src/db'),
    };

    // Production mount order (index.ts): opaque parent path with its explicit
    // rejection, shared guard chain, impersonation enforcement, management
    // router, then business routers.
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/parent', modules.context.rejectImpersonationHeader);
    app.use('/api/parent', (req, res) => { res.json({ ok: true, surface: 'parent' }); });
    app.use('/api', modules.auth.optionalAuth);
    app.use(modules.context.enforceImpersonationContext);
    app.use('/api/platform/impersonation', modules.routes.default);

    const business = express.Router();
    business.get('/students', (req: import('express').Request, res) => {
        const request = req as import('../../src/middleware/auth').AuthRequest;
        res.json({
            ok: true,
            impersonated: Boolean(request.impersonation),
            actorUserId: request.impersonation?.actorUserId ?? null,
            targetUserId: request.impersonation?.targetUserId ?? null,
            scope: request.impersonation?.scope ?? null,
            banner: request.impersonation?.banner ?? null,
            principalId: request.user?.id ?? null,
            principalRole: request.user?.role ?? null,
            principalTenant: request.user?.tenantId ?? null,
        });
    });
    business.get('/audit-logs', (req, res) => { res.json({ ok: true }); });
    business.post('/students', (req, res) => { res.json({ ok: true, mutating: true }); });
    app.use('/api', business);

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object', 'the loopback listener must expose an address');
    baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // The fixture rows are PRESERVED for review (no cleanup of the owned DB).
    if (pool) await pool.end();
    if (rootPool) await rootPool.end();
    if (modules?.db) await modules.db.closePool();
});

// ---------------------------------------------------------------------------
// Live wiring, real connections, real rows
// ---------------------------------------------------------------------------

test('the live target is the owned synthetic database served by real distinct connections', async () => {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT DATABASE() AS db, VERSION() AS version');
    assert.equal(rows[0].db, DB.database);
    assert.match(rows[0].version, /^8\.0\./);

    // Two simultaneously held pool connections are genuinely distinct
    // server sessions (the concurrency evidence is not one shared mirror).
    const first = await pool.getConnection();
    const second = await pool.getConnection();
    try {
        const [a] = await first.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
        const [b] = await second.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
        assert.notEqual(a[0].id, b[0].id, 'the pool must expose distinct MySQL connections');
    } finally {
        first.release();
        second.release();
    }

    const [users] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM users');
    assert.equal(Number(users[0].total), 8, 'the synthetic fixture is seeded');

    // Real auth through the actual shared guard: an ordinary request.
    const ordinary = await api('GET', '/api/students', { token: TEACHER_1 });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body.impersonated, false);
    assert.equal(ordinary.body.principalId, TARGET_1);
    assert.equal(ordinary.body.principalRole, 'teacher');
});

test('concurrent starts for the same target open exactly one session on real MySQL', async () => {
    const body = startBody(TARGET_1, TENANT_A);
    const [first, second] = await Promise.all([
        api('POST', '/api/platform/impersonation/start', { token: ADMIN_A, body }),
        api('POST', '/api/platform/impersonation/start', { token: ADMIN_A, body }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409], 'exactly one start may win; the loser must be refused');

    const rows = await activeSession(TARGET_1);
    assert.equal(rows.length, 1, 'exactly one live session row may exist for the target');
    assert.equal(rows[0].status, 'pending_approval');
    assert.equal(await auditCount('impersonation.session_requested'), 1, 'exactly one requested audit row may exist');
});

test('a start for a different target succeeds independently', async () => {
    const response = await api('POST', '/api/platform/impersonation/start', {
        token: ADMIN_A, body: startBody(TARGET_2, TENANT_B),
    });
    assert.equal(response.status, 201);
    assert.equal((await activeSession(TARGET_2)).length, 1);
    assert.equal(await auditCount('impersonation.session_requested'), 2);
});

test('approval by a second admin activates the session and mints a bound context', async () => {
    const [pending] = await activeSession(TARGET_1);
    const sessionId = String(pending.id);
    const approved = await api('POST', `/api/platform/impersonation/${sessionId}/approve`, { token: ADMIN_B });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'active');
    assert.equal(typeof approved.body.impersonation_token, 'string');
    approvedExpiresAtIso = String(approved.body.expires_at);
    assert.ok(approvedExpiresAtIso.endsWith('Z'), 'the route announces the expiry as a UTC instant');

    const token = String(approved.body.impersonation_token);
    const parsed = modules.services.parseImpersonationToken(token);
    assert.ok(parsed, 'the issued context must parse');
    assert.equal(parsed.actorUserId, SUPPORT_A);
    assert.equal(parsed.targetUserId, TARGET_1);
    assert.equal(parsed.tenantId, TENANT_A);

    assert.equal(await auditCount('impersonation.session_approved'), 1);

    // The minted context carries the actor/target/tenant binding and a valid
    // signature. Whether the LIVE row it names is immediately usable is
    // asserted by the next test.
});

/**
 * The approved expiry must be the instant the route announced, on both sides of
 * the driver: the column stores that instant in the pool's offset, the read
 * path resolves it back to the same instant, and the context serves at once.
 *
 * This is the correct-behaviour replacement for the defect-characterization
 * test written before `transitionToActive` stopped pre-formatting `expires_at`
 * as a UTC wall clock. The hermetic regression for the write convention lives
 * in `server/tests/m7-impersonation-expiry.test.ts`.
 */
test('the approved expiry is the announced instant and serves the context immediately', async () => {
    const [active] = await activeSession(TARGET_1);
    const persisted = active.expires_at instanceof Date
        ? active.expires_at
        : new Date(String(active.expires_at));
    const announced = new Date(approvedExpiresAtIso);

    // Whole-second storage is the only tolerated difference.
    assert.ok(
        Math.abs(persisted.getTime() - announced.getTime()) <= 1000,
        `the persisted expiry must be the announced instant (persisted ${persisted.toISOString()}, announced ${announced.toISOString()})`,
    );
    assert.ok(
        persisted.getTime() > Date.now(),
        'a freshly approved session must not be expired yet',
    );

    // The literal in the column is the announced instant expressed in the
    // pool's offset — not its UTC spelling. `CAST(... AS CHAR)` bypasses the
    // driver's timezone handling, so this is exactly what was stored.
    const [rawRows] = await pool.query<RowDataPacket[]>(
        'SELECT CAST(expires_at AS CHAR) AS raw FROM impersonation_sessions WHERE id=?',
        [active.id],
    );
    const storedWallClock = new Date(`${String(rawRows[0].raw).replace(' ', 'T')}+02:00`);
    assert.ok(
        Math.abs(storedWallClock.getTime() - announced.getTime()) <= 1000,
        `the column must hold the announced instant in the pool offset (stored ${String(rawRows[0].raw)} -> ${storedWallClock.toISOString()})`,
    );

    // The production verifier accepts the context approval minted, and the
    // live surface serves it without any manual expiry repair.
    const token = modules.services.signImpersonationToken(
        active as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        false, impersonationKey(), Date.now(),
    );
    const verdict = await modules.services.createImpersonationVerifier({
        store: modules.services.createSqlImpersonationStore({
            query: async (sql, params) => (await pool.query(sql, params))[0] as never,
            queryOne: async (sql, params) => (((await pool.query(sql, params))[0] as Array<Record<string, unknown>>)[0] ?? null) as never,
            execute: async (sql, params) => {
                const [result] = await pool.execute(sql, params);
                const header = result as { insertId?: number, affectedRows?: number };
                return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
            },
        }),
        tokenKey: () => impersonationKey(),
        now: () => new Date(),
    })(token);
    assert.equal(verdict.ok, true, `the freshly approved context must verify: ${JSON.stringify(verdict)}`);

    const served = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(served.status, 200, `the approved context must serve at once: ${JSON.stringify(served.body)}`);
    assert.equal(served.body.impersonated, true);
    assert.equal(served.body.targetUserId, TARGET_1);
});

test('a failing sealed-audit sink rolls start, approve and revoke back', async () => {
    // REAL failure injection on the real engine: the sealed sink table is
    // taken away from the application while the transaction runs, so the
    // append leaf cannot INSERT. (A table-level REVOKE is not expressible
    // here because the owned app user holds database-level grants.)
    await rootPool.query('RENAME TABLE audit_events TO audit_events_unavailable');
    try {
        // Start: no phantom pending row.
        const start = await api('POST', '/api/platform/impersonation/start', {
            token: ADMIN_C, body: startBody(TARGET_3, TENANT_A),
        });
        assert.equal(start.status, 500, 'the start must fail when its audit cannot be sealed');
        assert.equal((await activeSession(TARGET_3)).length, 0, 'the failed start must leave no session row');

        // Approve: the pending row stays pending.
        const [pending] = await activeSession(TARGET_2);
        const approve = await api('POST', `/api/platform/impersonation/${String(pending.id)}/approve`, { token: ADMIN_B });
        assert.equal(approve.status, 500, 'the approval must fail when its audit cannot be sealed');
        const [stillPending] = await pool.query<RowDataPacket[]>(
            'SELECT status FROM impersonation_sessions WHERE id=?', [pending.id],
        );
        assert.equal(stillPending[0].status, 'pending_approval', 'the failed approval must not activate the row');

        // Revoke: the active row stays active.
        const [active] = await activeSession(TARGET_1);
        const revoke = await api('POST', `/api/platform/impersonation/${String(active.id)}/revoke`, { token: ADMIN_B });
        assert.equal(revoke.status, 500, 'the revoke must fail when its audit cannot be sealed');
        const [stillActive] = await pool.query<RowDataPacket[]>(
            'SELECT status FROM impersonation_sessions WHERE id=?', [active.id],
        );
        assert.equal(stillActive[0].status, 'active', 'the failed revoke must not revoke the row');
    } finally {
        await rootPool.query('RENAME TABLE audit_events_unavailable TO audit_events');
    }

    // Restored sink: the same start now succeeds and is audited.
    const restored = await api('POST', '/api/platform/impersonation/start', {
        token: ADMIN_C, body: startBody(TARGET_3, TENANT_A),
    });
    assert.equal(restored.status, 201);
    assert.equal((await activeSession(TARGET_3)).length, 1);
    assert.equal(await auditCount('impersonation.session_requested'), 3, 'only the successful start is sealed');
});

// ---------------------------------------------------------------------------
// Live revocation paths
// ---------------------------------------------------------------------------

test('withdrawing the actor live platform permission denies the very next request', async () => {
    const [active] = await activeSession(TARGET_1);
    const token = modules.services.signImpersonationToken(
        active as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        false, impersonationKey(), Date.now(),
    );

    const before = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(before.status, 200, `the verified context must serve: ${JSON.stringify(before.body)}`);
    assert.equal(before.body.impersonated, true);

    // Remove the verified platform permission while every row stays live.
    await pool.query("DELETE FROM admin_role_permissions WHERE role_code='support_agent' AND permission_key='impersonation.start'");
    const [identity] = await pool.query<RowDataPacket[]>(
        'SELECT is_active, token_version FROM users WHERE id=?', [SUPPORT_A],
    );
    assert.equal(Number(identity[0].is_active), 1, 'the actor user row stays active');
    assert.equal(Number(identity[0].token_version), 0, 'the actor token version stays unchanged');
    const [sessionRow] = await pool.query<RowDataPacket[]>(
        'SELECT status FROM impersonation_sessions WHERE id=?', [active.id],
    );
    assert.equal(sessionRow[0].status, 'active', 'the session row stays active');

    const denied = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'IMPERSONATION_DENIED');
    assert.equal(denied.body.reason, 'actor_permission_revoked');

    // Restoring the permission revives the context (live recheck, not a
    // one-shot invalidation).
    await pool.query("INSERT INTO admin_role_permissions (role_code, permission_key) VALUES ('support_agent','impersonation.start')");
    const revived = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(revived.status, 200);
});

test('target deactivation and membership revocation deny the next request', async () => {
    const [active] = await activeSession(TARGET_1);
    const token = modules.services.signImpersonationToken(
        active as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        false, impersonationKey(), Date.now(),
    );

    await pool.query('UPDATE users SET is_active=0 WHERE id=?', [TARGET_1]);
    const deactivated = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(deactivated.status, 403, `a deactivated target must be refused: ${JSON.stringify(deactivated.body)}`);
    assert.equal(deactivated.body.reason, 'target_identity_unavailable');
    await pool.query('UPDATE users SET is_active=1 WHERE id=?', [TARGET_1]);

    await pool.query('DELETE FROM tenant_memberships WHERE user_id=? AND tenant_id=?', [TARGET_1, TENANT_A]);
    const revoked = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(revoked.status, 403, `a revoked membership must be refused: ${JSON.stringify(revoked.body)}`);
    assert.equal(revoked.body.reason, 'tenant_mismatch');
    await pool.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role_key, status) VALUES (?,?,?,?, 'active')`,
        [randomUUID(), TENANT_A, TARGET_1, 'member'],
    );
});

test('signature, expiry, scope and tenant mismatches are refused on real rows', async () => {
    const [active] = await activeSession(TARGET_1);
    const sessionId = String(active.id);
    const sign = (row: Record<string, unknown>, write: boolean) => modules.services.signImpersonationToken(
        row as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        write, impersonationKey(), Date.now(),
    );

    // Forged signature: a different key.
    const forged = modules.services.signImpersonationToken(
        active as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        false, Buffer.alloc(32, 7), Date.now(),
    );
    const forgedResponse = await api('GET', '/api/students', { token: ADMIN_A, impersonation: forged });
    assert.equal(forgedResponse.status, 403);
    assert.equal(forgedResponse.body.reason, 'signature');

    // Expired live row.
    await pool.query('UPDATE impersonation_sessions SET expires_at = (NOW() - INTERVAL 5 MINUTE) WHERE id=?', [sessionId]);
    const expired = await api('GET', '/api/students', { token: ADMIN_A, impersonation: sign(active, false) });
    assert.equal(expired.status, 403);
    assert.equal(expired.body.reason, 'expired');
    await pool.query('UPDATE impersonation_sessions SET expires_at = (NOW() + INTERVAL 10 MINUTE) WHERE id=?', [sessionId]);

    // Signed scope disagrees with the live row.
    await pool.query("UPDATE impersonation_sessions SET scope='write' WHERE id=?", [sessionId]);
    const [writeRow] = await pool.query<RowDataPacket[]>('SELECT * FROM impersonation_sessions WHERE id=?', [sessionId]);
    const scopeMismatch = await api('GET', '/api/students', { token: ADMIN_A, impersonation: sign(writeRow[0], false) });
    assert.equal(scopeMismatch.status, 403);
    assert.equal(scopeMismatch.body.reason, 'row_mismatch');
    await pool.query("UPDATE impersonation_sessions SET scope='read' WHERE id=?", [sessionId]);

    // Session tenant the target is not an active member of.
    await pool.query('UPDATE impersonation_sessions SET tenant_id=? WHERE id=?', [TENANT_B, sessionId]);
    const [movedRow] = await pool.query<RowDataPacket[]>('SELECT * FROM impersonation_sessions WHERE id=?', [sessionId]);
    const tenantMismatch = await api('GET', '/api/students', { token: ADMIN_A, impersonation: sign(movedRow[0], false) });
    assert.equal(tenantMismatch.status, 403);
    assert.equal(tenantMismatch.body.reason, 'tenant_mismatch');
    await pool.query('UPDATE impersonation_sessions SET tenant_id=? WHERE id=?', [TENANT_A, sessionId]);

    // The restored row serves again (positive control).
    const restored = await api('GET', '/api/students', { token: ADMIN_A, impersonation: sign(active, false) });
    assert.equal(restored.status, 200, `the restored row must serve again: ${JSON.stringify(restored.body)}`);
});

test('a verified context keeps the actor distinct from the effective principal', async () => {
    const [active] = await activeSession(TARGET_1);
    const token = modules.services.signImpersonationToken(
        active as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        false, impersonationKey(), Date.now(),
    );
    const response = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(response.status, 200, `the verified context must serve: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.actorUserId, SUPPORT_A);
    assert.equal(response.body.targetUserId, TARGET_1);
    assert.equal(response.body.principalId, TARGET_1);
    assert.equal(response.body.principalRole, 'teacher');
    assert.equal(response.body.principalTenant, TENANT_A);
    assert.deepEqual(response.body.banner, {
        impersonated: true,
        sessionId: active.id,
        tenantId: TENANT_A,
        scope: 'read',
    });
});

test('the enforcement keeps the read allowlist, mutation deny, management deny and parent reject', async () => {
    const [active] = await activeSession(TARGET_1);
    const token = modules.services.signImpersonationToken(
        active as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        false, impersonationKey(), Date.now(),
    );

    const auditLogs = await api('GET', '/api/audit-logs', { token: ADMIN_A, impersonation: token });
    assert.equal(auditLogs.status, 403, `a denied path must be refused: ${JSON.stringify(auditLogs.body)}`);
    assert.equal(auditLogs.body.reason, 'path_denied');

    const mutation = await api('POST', '/api/students', { token: ADMIN_A, impersonation: token, body: {} });
    assert.equal(mutation.status, 403);
    assert.equal(mutation.body.protection, 'read_only');

    const management = await api('POST', '/api/platform/impersonation/start', {
        token: ADMIN_A, impersonation: token, body: startBody(TARGET_2, TENANT_B),
    });
    assert.equal(management.status, 403);
    assert.equal(management.body.reason, 'management_namespace');

    const parent = await api('GET', '/api/parent/children', { token: ADMIN_A, impersonation: token });
    assert.equal(parent.status, 403);
    assert.equal(parent.body.reason, 'parent_path');

    // Ordinary requests stay untouched (no header, no context).
    const ordinary = await api('GET', '/api/students', { token: TEACHER_1 });
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body.impersonated, false);
});

test('revocation stops the context on the very next request', async () => {
    const [active] = await activeSession(TARGET_1);
    const token = modules.services.signImpersonationToken(
        active as unknown as import('../../src/services/impersonation').ImpersonationSessionRow,
        false, impersonationKey(), Date.now(),
    );
    const revoke = await api('POST', `/api/platform/impersonation/${String(active.id)}/revoke`, { token: ADMIN_B });
    assert.equal(revoke.status, 200);

    const denied = await api('GET', '/api/students', { token: ADMIN_A, impersonation: token });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'IMPERSONATION_INVALID');
    assert.equal(denied.body.reason, 'not_active');
    assert.equal(await auditCount('impersonation.session_revoked'), 1);
});

test('the sealed audit chain verifies over the real synthetic rows', async () => {
    const verification = await modules.auditLog.verifyAuditChain({
        query: async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params as never))[0] as T[],
    });
    assert.equal(verification.ok, true, `chain must verify: ${JSON.stringify(verification.firstFailure)}`);
    const [sealed] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM audit_events WHERE entry_hash IS NOT NULL');
    assert.ok(Number(sealed[0].total) >= 5, 'the chain must contain the sealed session lifecycle rows');
});

// ---------------------------------------------------------------------------
// Static production-order assertion (the live app above mirrors this order)
// ---------------------------------------------------------------------------

test('index.ts mounts the enforcement after the shared guard and before every business router', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/index.ts', import.meta.url)), 'utf8');
    const guard = source.indexOf("app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary)");
    const enforcement = source.indexOf('app.use(enforceImpersonationContext)');
    assert.ok(guard > 0, 'the shared guard chain must exist');
    assert.ok(enforcement > guard, 'the enforcement must follow the shared guard chain');
    assert.equal(source.split('app.use(enforceImpersonationContext)').length - 1, 1, 'the enforcement mounts exactly once');
    for (const mount of [
        "app.use('/api/parent-links', parentLinksRoutes)",
        "app.use('/api/notification-consent', notificationConsentRoutes)",
        "app.use('/api/lesson-discussions', lessonDiscussionsRoutes)",
        "app.use('/api/search', searchRoutes)",
        "app.use('/api/tenant-exports', tenantExportRoutes)",
        "app.use('/api/platform/mfa', platformMfaRoutes)",
        "app.use('/api/platform/impersonation', impersonationRoutes)",
    ]) {
        const at = source.indexOf(mount);
        assert.ok(at > 0, `${mount} must exist`);
        assert.ok(at > enforcement, `${mount} must mount AFTER the enforcement`);
    }
    const parentReject = source.indexOf("app.use('/api/parent', (req: Request, res: Response, next: NextFunction) => rejectImpersonationHeader(req, res, next))");
    const parentViews = source.indexOf("app.use('/api/parent', parentViewsRoutes)");
    assert.ok(parentReject > 0 && parentViews > 0 && parentReject < parentViews, 'the parent path must reject a header before its views router');
});
