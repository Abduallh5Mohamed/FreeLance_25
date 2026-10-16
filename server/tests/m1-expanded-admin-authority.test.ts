import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler } from 'express';
import { AuthRequest, createAuthenticateToken } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import {
    AdminPermissionLookup,
    createRequireAdminPermission,
} from '../src/security/admin-permissions';
import {
    AdminMembersRouterDeps,
    createAdminMembersRouter,
} from '../src/routes/admin-members';
import {
    AdminApprovalsRouterDeps,
    createAdminApprovalsRouter,
} from '../src/routes/admin-approvals';
import {
    AdminWorkItemsRouterDeps,
    createAdminWorkItemsRouter,
} from '../src/routes/admin-work-items';

/**
 * M1 expanded admin-authority regression suite (behavioral, hermetic).
 *
 * Drives the three production admin routers (`createAdminMembersRouter`,
 * `createAdminApprovalsRouter`, `createAdminWorkItemsRouter`) through their
 * injected seams: a fixture-backed SQL adapter, the REAL authentication
 * middleware (`createAuthenticateToken`) over an injected principal
 * repository, and the REAL permission guard
 * (`createRequireAdminPermission`) over an injected `AdminPermissionLookup`.
 * No database, network, Docker, or real service is contacted; the MySQL pool
 * in src/db.ts is never created because no production query runs (the module
 * is only imported for types and its lazy loaders are never invoked).
 *
 * Authority under test: verified platform permission / server-verified Super
 * Admin instead of JWT role labels; the caller's principal id (never a
 * client-supplied actor id); user-controlled target ids (team / assignee /
 * role) verified server-side; and duplicate approval transitions failing
 * closed with 409.
 *
 * Evidence classes, labeled per test:
 *  - behavioral: the real handler's own JS decision (status codes, denied
 *    side effects such as absent INSERT/UPDATE/DELETE, rows returned);
 *  - decision-boundary (SQL text + params of the executed statement): the
 *    visibility/scoping of the list + single-item routes is applied by MySQL
 *    WHERE clauses, so hermetically we assert the exact SQL and bindings the
 *    real handler executed. Live row-level filtering remains an integration
 *    suite's responsibility (NOT RUN here).
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const INSTRUCTOR_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INSTRUCTOR_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface UserRow {
    id: string; name: string; email: string | null; phone: string | null;
    is_active: number; role: string; password_hash?: string;
}
interface StaffRow {
    id: string; name: string; email: string | null; phone: string | null;
    password_hash: string; is_active: number;
}
interface WorkItemRow {
    id: string; type: string; title: string; priority: string; status: string;
    tenant_id: string | null; resource_type: string | null; resource_id: string | null;
    created_by: string; assigned_admin_id: string | null; assigned_team_id: string | null;
    due_at: string | null; created_at: string; updated_at: string;
}
interface WorkItemEventRow {
    id: string; work_item_id: string; actor_user_id: string; event_type: string;
    body?: string | null; old_value?: string | null; new_value?: string | null; created_at: string;
}
interface ApprovalRow {
    id: string; action_key: string; resource_type: string; resource_id: string;
    requested_value: string; reason: string; status: string; requested_by: string;
    decided_by?: string | null; created_at: string; decided_at?: string | null;
}

interface Fixtures {
    users: Record<string, UserRow>;
    adminUserRoles: Record<string, string[]>;
    adminRolePermissions: Record<string, string[]>;
    adminRoles: Record<string, string>;
    teams: Record<string, { id: string; code: string }>;
    teamMemberships: Array<{ team_id: string; user_id: string }>;
    staff: Record<string, StaffRow>;
    workItems: Record<string, WorkItemRow>;
    workItemEvents: WorkItemEventRow[];
    approvals: Record<string, ApprovalRow>;
    wallets: Record<string, string>;
    auditEvents: Array<Record<string, unknown>>;
}

const adminUser = (id: string, name: string, phone: string): UserRow =>
    ({ id, name, email: `${id}@example.test`, phone, is_active: 1, role: 'admin' });

const makeFixtures = (): Fixtures => ({
    users: {
        root: adminUser('root', 'Root', '0100000000'),
        lead: adminUser('lead', 'Lead', '0100000001'),
        ops: adminUser('ops', 'Ops', '0100000002'),
        biller: adminUser('biller', 'Biller', '0100000003'),
        requester: adminUser('requester', 'Requester', '0100000004'),
        creator: adminUser('creator', 'Creator', '0100000005'),
        nobody: adminUser('nobody', 'Nobody', '0100000006'),
        peer: adminUser('peer', 'Peer', '0100000007'),
        target1: { id: 'target1', name: 'Target One', email: 'target1@example.test', phone: '0100000008', is_active: 1, role: 'staff' },
        // Staff promotion fixtures
        'staff-conflict': { id: 'staff-conflict', name: 'Conflicting Identity', email: 'sc@example.test', phone: '0100000031', is_active: 1, role: 'instructor' },
        [INSTRUCTOR_1]: { id: INSTRUCTOR_1, name: 'Instructor One', email: 'i1@example.test', phone: '0100000011', is_active: 1, role: 'instructor' },
        [INSTRUCTOR_2]: { id: INSTRUCTOR_2, name: 'Instructor Two', email: 'i2@example.test', phone: '0100000012', is_active: 1, role: 'instructor' },
    },
    adminUserRoles: {
        root: ['super_admin'],
        lead: ['management'],
        ops: ['operations'],
        biller: ['billing'],
        requester: ['analyst'],
        creator: ['creator'],
        peer: ['operations'],
        target1: ['analyst'],
    },
    adminRolePermissions: {
        super_admin: ['admin_roles.manage', 'task.read', 'task.create', 'task.assign', 'approval.read', 'approval.approve', 'service_credit.adjust'],
        management: ['admin_roles.manage', 'task.read', 'task.create', 'task.assign'],
        operations: ['task.read', 'task.create', 'task.assign'],
        billing: ['approval.read', 'approval.approve', 'service_credit.adjust'],
        analyst: ['service_credit.adjust', 'task.read'],
        creator: ['task.read', 'task.create'],
    },
    adminRoles: {
        super_admin: 'Super Admin', management: 'Management', operations: 'Operations',
        billing: 'Billing', analyst: 'Analyst',
    },
    teams: {
        'team-ops': { id: 'team-ops', code: 'operations' },
        'team-sec': { id: 'team-sec', code: 'security' },
    },
    teamMemberships: [
        { team_id: 'team-ops', user_id: 'ops' },
        { team_id: 'team-ops', user_id: 'lead' },
        { team_id: 'team-sec', user_id: 'peer' },
    ],
    staff: {
        'staff-1': { id: 'staff-1', name: 'Staff One', email: 'staff1@example.test', phone: '0100000021', password_hash: 'stored-hash', is_active: 1 },
        'staff-inactive': { id: 'staff-inactive', name: 'Staff Off', email: 'staff2@example.test', phone: '0100000022', password_hash: 'stored-hash', is_active: 0 },
        'staff-conflict': { id: 'staff-conflict', name: 'Conflicting Identity', email: 'sc@example.test', phone: '0100000031', password_hash: 'stored-hash', is_active: 1 },
    },
    workItems: {
        'wi-own': { id: 'wi-own', type: 'support_case', title: 'Own item', priority: 'normal', status: 'open', tenant_id: null, resource_type: null, resource_id: null, created_by: 'ops', assigned_admin_id: null, assigned_team_id: null, due_at: null, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' },
        'wi-team': { id: 'wi-team', type: 'support_case', title: 'Team item', priority: 'normal', status: 'open', tenant_id: null, resource_type: null, resource_id: null, created_by: 'root', assigned_admin_id: null, assigned_team_id: 'team-ops', due_at: null, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' },
        'wi-other': { id: 'wi-other', type: 'support_case', title: 'Other team item', priority: 'normal', status: 'open', tenant_id: null, resource_type: null, resource_id: null, created_by: 'root', assigned_admin_id: null, assigned_team_id: 'team-sec', due_at: null, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' },
        'wi-assigned': { id: 'wi-assigned', type: 'support_case', title: 'Assigned item', priority: 'normal', status: 'in_progress', tenant_id: null, resource_type: null, resource_id: null, created_by: 'root', assigned_admin_id: 'ops', assigned_team_id: null, due_at: null, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' },
    },
    workItemEvents: [],
    approvals: {
        'ap-credit': { id: 'ap-credit', action_key: 'service_credit.credit', resource_type: 'instructor', resource_id: INSTRUCTOR_1, requested_value: JSON.stringify({ amount: '50.00' }), reason: 'top up', status: 'pending', requested_by: 'requester', created_at: '2026-01-01 00:00:00' },
        'ap-debit': { id: 'ap-debit', action_key: 'service_credit.debit', resource_type: 'instructor', resource_id: INSTRUCTOR_2, requested_value: JSON.stringify({ amount: '100.00' }), reason: 'debit request', status: 'pending', requested_by: 'requester', created_at: '2026-01-01 00:00:00' },
        'ap-self': { id: 'ap-self', action_key: 'service_credit.credit', resource_type: 'instructor', resource_id: INSTRUCTOR_1, requested_value: JSON.stringify({ amount: '10.00' }), reason: 'self request', status: 'pending', requested_by: 'biller', created_at: '2026-01-01 00:00:00' },
        'ap-root': { id: 'ap-root', action_key: 'service_credit.credit', resource_type: 'instructor', resource_id: INSTRUCTOR_1, requested_value: JSON.stringify({ amount: '10.00' }), reason: 'root request', status: 'pending', requested_by: 'root', created_at: '2026-01-01 00:00:00' },
        'ap-decided': { id: 'ap-decided', action_key: 'service_credit.credit', resource_type: 'instructor', resource_id: INSTRUCTOR_1, requested_value: JSON.stringify({ amount: '5.00' }), reason: 'done', status: 'approved', requested_by: 'requester', created_at: '2026-01-01 00:00:00' },
        'ap-unsupported': { id: 'ap-unsupported', action_key: 'other', resource_type: 'instructor', resource_id: INSTRUCTOR_1, requested_value: JSON.stringify({ amount: '1.00' }), reason: 'bad action', status: 'pending', requested_by: 'requester', created_at: '2026-01-01 00:00:00' },
    },
    wallets: { [INSTRUCTOR_1]: '0.00', [INSTRUCTOR_2]: '10.00' },
    auditEvents: [],
});

// ---------------------------------------------------------------------------
// Injected authority lookups (mirror the production SQL semantics)
// ---------------------------------------------------------------------------

const isSuperAdminFixture = (f: Fixtures) => async (userId: string): Promise<boolean> => {
    const user = f.users[userId];
    if (!user || user.is_active !== 1) return false;
    return (f.adminUserRoles[userId] ?? []).includes('super_admin');
};

const permissionsFixture = (f: Fixtures) => async (userId: string): Promise<string[]> => {
    const user = f.users[userId];
    if (!user || user.is_active !== 1) return [];
    const permissions = new Set<string>();
    for (const role of f.adminUserRoles[userId] ?? []) {
        for (const permission of f.adminRolePermissions[role] ?? []) permissions.add(permission);
    }
    return [...permissions];
};

const makeLookup = (f: Fixtures): AdminPermissionLookup => ({
    isSuperAdmin: isSuperAdminFixture(f),
    getAdminPermissions: permissionsFixture(f),
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => {
        const user = f.users[id];
        return user ? { is_active: user.is_active, token_version: 0, suspension_active: 0 } : null;
    },
    findStaffIdentity: async () => null,
    findInstructorAccount: async () => null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async () => [],
});

// ---------------------------------------------------------------------------
// Fixture SQL adapter: answers the exact query shapes the routers issue.
// ---------------------------------------------------------------------------

interface ExecutedStatement { sql: string; params: unknown[] }

const makeDb = (f: Fixtures, executed: ExecutedStatement[], throwOnSql?: (sql: string) => boolean) => {
    const isTeamMember = (teamId: string | null, userId: unknown): boolean =>
        teamId != null && f.teamMemberships.some((m) => m.team_id === teamId && m.user_id === userId);

    const respond = (sql: string, params: unknown[]): unknown[] => {
        if (throwOnSql?.(sql)) throw new Error('simulated database failure');

        // ---- service-credit (runs on the injected transaction connection) ----
        if (sql.includes('FROM users WHERE id') && (sql.includes('AND role = ?') || sql.includes('AND role=?'))) {
            const user = f.users[String(params[0])];
            return user && user.role === params[1] ? [{ id: user.id }] : [];
        }
        if (sql.includes('INSERT IGNORE INTO instructor_wallets')) {
            const id = String(params[0]);
            if (f.wallets[id] === undefined) f.wallets[id] = '0.00';
            return [];
        }
        if (sql.includes('SELECT balance FROM instructor_wallets WHERE instructor_id = ? FOR UPDATE')) {
            return [{ balance: f.wallets[String(params[0])] ?? '0.00' }];
        }
        if (sql.includes('UPDATE instructor_wallets SET balance = balance')) {
            const [amount, id] = params as [string, string];
            const current = Number(f.wallets[id] ?? '0');
            f.wallets[id] = (sql.includes('balance + ?') ? current + Number(amount) : current - Number(amount)).toFixed(2);
            return [];
        }
        if (sql.includes('SELECT balance FROM instructor_wallets WHERE instructor_id = ?')) {
            return [{ balance: f.wallets[String(params[0])] ?? '0.00' }];
        }
        if (sql.includes('INSERT INTO instructor_wallet_transactions')) return [];

        // ---- admin members ----
        if (sql.includes('GROUP_CONCAT')) {
            return Object.keys(f.adminUserRoles)
                .filter((id) => (f.adminUserRoles[id] ?? []).length && f.users[id])
                .map((id) => ({
                    id, name: f.users[id].name, email: f.users[id].email, phone: f.users[id].phone,
                    is_active: f.users[id].is_active, roles: [...f.adminUserRoles[id]].sort().join(','),
                }));
        }
        if (sql.includes('SELECT code,name FROM admin_roles')) {
            return Object.entries(f.adminRoles).map(([code, name]) => ({ code, name }));
        }
        if (sql.includes('SELECT code FROM admin_roles WHERE code=?')) {
            const code = String(params[0]);
            return f.adminRoles[code] ? [{ code }] : [];
        }
        if (sql.includes('SELECT role_code FROM admin_user_roles WHERE user_id=?')) {
            return (f.adminUserRoles[String(params[0])] ?? []).map((role_code) => ({ role_code }));
        }
        if (sql.includes('SELECT user_id FROM admin_user_roles WHERE user_id=?')) {
            const id = String(params[0]);
            return (f.adminUserRoles[id] ?? []).length ? [{ user_id: id }] : [];
        }
        if (sql.includes('SELECT u.id,u.is_active FROM users u WHERE u.id=?')) {
            const user = f.users[String(params[0])];
            if (!user || !(f.adminUserRoles[user.id] ?? []).length) return [];
            return [{ id: user.id, is_active: user.is_active }];
        }
        if (sql.includes('SELECT id,role FROM users WHERE id=?')) {
            const user = f.users[String(params[0])];
            return user ? [{ id: user.id, role: user.role }] : [];
        }
        if (sql.includes('SELECT id FROM users WHERE phone=? OR')) {
            const [phone, email] = params as [string, string | null];
            const hit = Object.values(f.users).find((u) => u.phone === phone || (email != null && u.email === email));
            return hit ? [{ id: hit.id }] : [];
        }
        if (sql.includes('SELECT id FROM users WHERE (phone IS NOT NULL')) {
            const [phone, email] = params as [string | null, string | null];
            const hit = Object.values(f.users).find((u) => (phone != null && u.phone === phone) || (email != null && u.email === email));
            return hit ? [{ id: hit.id }] : [];
        }
        if (sql.includes('FROM staff WHERE id=?')) {
            const staff = f.staff[String(params[0])];
            return staff ? [{ ...staff }] : [];
        }

        // ---- admin work items ----
        if (sql.includes('SELECT w.id,w.created_by,w.assigned_admin_id')) {
            const [id, isManagement, userId] = params as [string, number, string];
            const item = f.workItems[id];
            if (!item) return [];
            const visible = isManagement === 1 || item.created_by === userId
                || item.assigned_admin_id === userId || isTeamMember(item.assigned_team_id, userId);
            return visible ? [{ id: item.id, created_by: item.created_by, assigned_admin_id: item.assigned_admin_id, assigned_team_id: item.assigned_team_id, status: item.status }] : [];
        }
        if (sql.includes('FROM admin_work_items w') && sql.includes('ORDER BY w.created_at DESC')) {
            const [isManagement, userId, , , status] = params as [number, string, string, string, string | null];
            return Object.values(f.workItems).filter((item) =>
                (isManagement === 1 || item.created_by === userId
                    || item.assigned_admin_id === userId || isTeamMember(item.assigned_team_id, userId))
                && (status == null || item.status === status));
        }
        if (sql.includes('SELECT * FROM admin_work_items WHERE id=?')) {
            const item = f.workItems[String(params[0])];
            return item ? [{ ...item }] : [];
        }
        if (sql.includes('FROM admin_work_item_events WHERE work_item_id=?')) {
            return f.workItemEvents.filter((e) => e.work_item_id === params[0]).map((e) => ({ ...e }));
        }
        if (sql.includes('SELECT id FROM admin_teams WHERE id=?')) {
            const id = String(params[0]);
            return f.teams[id] ? [{ id }] : [];
        }
        if (sql.includes('SELECT team_id FROM admin_team_memberships WHERE team_id=? AND user_id=?')) {
            const [teamId, userId] = params as [string, string];
            return isTeamMember(teamId, userId) ? [{ team_id: teamId }] : [];
        }
        if (sql.includes('FROM admin_team_memberships mine')) {
            const [mineId, targetId, teamId] = params as [string, string, string | null];
            const shared = f.teamMemberships
                .filter((m) => m.user_id === mineId)
                .find((m) => f.teamMemberships.some((t) => t.user_id === targetId && t.team_id === m.team_id && (teamId == null || t.team_id === teamId)));
            return shared ? [{ team_id: shared.team_id }] : [];
        }

        // ---- admin approvals ----
        if (sql.includes('FROM admin_approval_requests a WHERE a.status=?')) {
            const status = params[0];
            return Object.values(f.approvals).filter((a) => a.status === status).map((a) => ({ ...a }));
        }
        if (sql.includes('FROM admin_approval_requests WHERE id=? FOR UPDATE')) {
            const approval = f.approvals[String(params[0])];
            if (!approval) return [];
            if (sql.includes('requested_value')) return [{ ...approval }];
            return [{ id: approval.id, status: approval.status, requested_by: approval.requested_by }];
        }

        // ---- mutations ----
        if (sql.includes('INSERT INTO admin_work_items')) {
            const [id, type, title, description, priority, created_by, assignedTeamId, tenant_id, resource_type, resource_id, due_at] =
                params as [string, string, string, string | null, string, string, string | null, string | null, string | null, string | null, string | null];
            f.workItems[id] = {
                id, type, title, priority, status: 'open', tenant_id, resource_type, resource_id,
                created_by, assigned_admin_id: null, assigned_team_id: assignedTeamId, due_at,
                created_at: '2026-01-02 00:00:00', updated_at: '2026-01-02 00:00:00',
            };
            return [];
        }
        if (sql.includes('INSERT INTO admin_work_item_events')) {
            const [id, work_item_id, actor_user_id, event_type] = params as [string, string, string, string];
            f.workItemEvents.push({ id, work_item_id, actor_user_id, event_type, body: (params[4] as string) ?? null, created_at: '2026-01-02 00:00:00' });
            return [];
        }
        if (sql.includes('UPDATE admin_work_items SET assigned_team_id=?')) {
            const [teamId, adminId, id] = params as [string | null, string | null, string];
            const item = f.workItems[id];
            if (item) { item.assigned_team_id = teamId; item.assigned_admin_id = adminId; }
            return [];
        }
        if (sql.includes('INSERT INTO admin_approval_requests')) {
            const [id, action_key, resource_type, resource_id, requested_value, reason, requested_by] =
                params as [string, string, string, string, string, string, string];
            f.approvals[id] = { id, action_key, resource_type, resource_id, requested_value, reason, status: 'pending', requested_by, decided_by: null, created_at: '2026-01-02 00:00:00', decided_at: null };
            return [];
        }
        if (sql.includes("UPDATE admin_approval_requests SET status='approved'")) {
            const [decided_by, id] = params as [string, string];
            const approval = f.approvals[id];
            if (approval) { approval.status = 'approved'; approval.decided_by = decided_by; }
            return [];
        }
        if (sql.includes("UPDATE admin_approval_requests SET status='rejected'")) {
            const [decided_by, , id] = params as [string, string, string];
            const approval = f.approvals[id];
            if (approval) { approval.status = 'rejected'; approval.decided_by = decided_by; }
            return [];
        }
        if (sql.includes('INSERT INTO users')) {
            const [id, name, email, phone, password_hash] = params as [string, string, string | null, string | null, string];
            f.users[id] = { id, name, email, phone, is_active: 1, role: 'staff', password_hash };
            return [];
        }
        if (sql.includes('INTO admin_user_roles')) {
            const [userId, roleCode] = params as [string, string, string];
            f.adminUserRoles[userId] = [...(f.adminUserRoles[userId] ?? []), roleCode];
            return [];
        }
        if (sql.includes('DELETE FROM admin_team_memberships')) {
            const userId = String(params[0]);
            f.teamMemberships = f.teamMemberships.filter((m) => m.user_id !== userId);
            return [];
        }
        if (sql.includes('DELETE FROM admin_user_roles')) {
            f.adminUserRoles[String(params[0])] = [];
            return [];
        }
        if (sql.includes('INTO admin_team_memberships')) {
            const [userId, teamCode] = params as [string, string];
            const team = Object.values(f.teams).find((t) => t.code === teamCode);
            if (team && !f.teamMemberships.some((m) => m.team_id === team.id && m.user_id === userId)) {
                f.teamMemberships.push({ team_id: team.id, user_id: userId });
            }
            return [];
        }
        if (sql.includes('UPDATE users SET is_active=?')) {
            const [active, id] = params as [number, string];
            if (f.users[id]) f.users[id].is_active = Number(active);
            return [];
        }
        if (sql.includes('UPDATE users SET password_hash=?')) {
            const [hash, id] = params as [string, string];
            if (f.users[id]) f.users[id].password_hash = hash;
            return [];
        }
        if (sql.includes('INTO audit_events')) {
            f.auditEvents.push({ params });
            return [];
        }
        return [];
    };

    const connection = {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        execute: async (sql: string, params: unknown[] = []) => {
            executed.push({ sql, params });
            return [respond(sql, params), []] as [unknown[], unknown[]];
        },
    };
    const query = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return respond(sql, params) as T[];
    };
    const queryOne = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        const rows = respond(sql, params);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    };
    const execute = async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        respond(sql, params);
        return { affectedRows: 1, insertId: 0 } as never;
    };
    return { query, queryOne, execute, getConnection: async () => connection as never };
};

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

interface HarnessOptions { fixtures?: Fixtures; throwOnSql?: (sql: string) => boolean }

const makeMembersHarness = (options: HarnessOptions = {}) => {
    const fixtures = options.fixtures ?? makeFixtures();
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed, options.throwOnSql);
    const lookup = makeLookup(fixtures);
    const deps: AdminMembersRouterDeps = {
        db: db as unknown as AdminMembersRouterDeps['db'],
        authenticate: createAuthenticateToken(makeRepository(fixtures)) as RequestHandler,
        manageRoles: createRequireAdminPermission('admin_roles.manage', lookup) as RequestHandler,
        isSuperAdmin: isSuperAdminFixture(fixtures),
        hashPassword: async (password) => `hashed:${password}`,
    };
    return { router: createAdminMembersRouter(deps), executed, fixtures };
};

const makeApprovalsHarness = (options: HarnessOptions = {}) => {
    const fixtures = options.fixtures ?? makeFixtures();
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed, options.throwOnSql);
    const lookup = makeLookup(fixtures);
    const deps: AdminApprovalsRouterDeps = {
        db: db as unknown as AdminApprovalsRouterDeps['db'],
        authenticate: createAuthenticateToken(makeRepository(fixtures)) as RequestHandler,
        approvalRead: createRequireAdminPermission('approval.read', lookup) as RequestHandler,
        creditAdjust: createRequireAdminPermission('service_credit.adjust', lookup) as RequestHandler,
        approvalApprove: createRequireAdminPermission('approval.approve', lookup) as RequestHandler,
        isSuperAdmin: isSuperAdminFixture(fixtures),
    };
    return { router: createAdminApprovalsRouter(deps), executed, fixtures };
};

const makeWorkItemsHarness = (options: HarnessOptions = {}) => {
    const fixtures = options.fixtures ?? makeFixtures();
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed, options.throwOnSql);
    const lookup = makeLookup(fixtures);
    const deps: AdminWorkItemsRouterDeps = {
        db: db as unknown as AdminWorkItemsRouterDeps['db'],
        authenticate: createAuthenticateToken(makeRepository(fixtures)) as RequestHandler,
        taskRead: createRequireAdminPermission('task.read', lookup) as RequestHandler,
        taskCreate: createRequireAdminPermission('task.create', lookup) as RequestHandler,
        taskAssign: createRequireAdminPermission('task.assign', lookup) as RequestHandler,
        getAdminPermissions: permissionsFixture(fixtures),
    };
    return { router: createAdminWorkItemsRouter(deps), executed, fixtures };
};

// ---------------------------------------------------------------------------
// Route invocation
// ---------------------------------------------------------------------------

interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
    query?: Record<string, string>;
}

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const invokeRoute = async (
    router: ReturnType<typeof createAdminMembersRouter>,
    request: RouteRequest,
): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (id: string): string => jwt.sign({ id, role: 'admin', tv: 0 }, TEST_SECRET);

const ROOT = tokenFor('root');
const LEAD = tokenFor('lead');
const OPS = tokenFor('ops');
const BILLER = tokenFor('biller');
const CREATOR = tokenFor('creator');
const NOBODY = tokenFor('nobody');

const assertNoWrite = (executed: ExecutedStatement[]) => {
    for (const statement of executed) {
        // `SELECT ... FOR UPDATE` is a read lock, not a mutation; strip it so
        // the assertion flags only real INSERT/UPDATE/DELETE statements.
        const sql = statement.sql.replace(/FOR\s+UPDATE/gi, '');
        assert.ok(!/\bINSERT\b/i.test(sql), `unexpected INSERT: ${statement.sql}`);
        assert.ok(!/\bUPDATE\b/i.test(sql), `unexpected UPDATE: ${statement.sql}`);
        assert.ok(!/\bDELETE\b/i.test(sql), `unexpected DELETE: ${statement.sql}`);
    }
};

// ===========================================================================
// admin-members.ts
// ===========================================================================

test('members: anonymous is denied 401 before any data access', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/roles' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('members: authenticated non-admin without admin_roles.manage is denied 403', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/roles', token: NOBODY });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('members: verified manage-permission holder (non-super) lists roles', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/roles', token: LEAD });
    assert.equal(response.statusCode, 200);
    assert.ok(executed.some((e) => e.sql.includes('SELECT code,name FROM admin_roles')));
});

test('members: non-super admin cannot create an admin account (403, no write)', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: LEAD,
        body: { name: 'New Admin', phone: '0109999999', password: 'password123', role_code: 'analyst' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Super Admin only');
    assertNoWrite(executed);
});

test('members: super admin create with unknown role is 400', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: ROOT,
        body: { name: 'New Admin', phone: '0109999999', password: 'password123', role_code: 'ghost_role' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('members: super admin create with duplicate phone is 409', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: ROOT,
        body: { name: 'New Admin', phone: '0100000002', password: 'password123', role_code: 'analyst' },
    });
    assert.equal(response.statusCode, 409);
    assertNoWrite(executed);
});

test('members: super admin create with a weak password is 400', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: ROOT,
        body: { name: 'New Admin', phone: '0109999999', password: 'short', role_code: 'analyst' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('members: super admin creates an account; password is hashed and audited', async () => {
    const { router, executed, fixtures } = makeMembersHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: ROOT,
        body: { name: 'New Admin', phone: '0109999999', email: 'new@example.test', password: 'password123', role_code: 'analyst' },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO users'));
    assert.ok(insert, 'user INSERT executed');
    assert.equal(insert!.params[4], 'hashed:password123');
    assert.notEqual(insert!.params[4], 'password123');
    assert.ok(executed.some((e) => e.sql.includes('INTO admin_user_roles')));
    assert.ok(executed.some((e) => e.sql.includes('INTO audit_events')));
    const createdId = (response.body as { id: string }).id;
    assert.deepEqual(fixtures.adminUserRoles[createdId], ['analyst']);
});

test('members: non-super cannot patch an admin account (403, no write)', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/target1', token: LEAD, body: { is_active: false } });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('members: super admin self-disable is rejected 409 (lockout guard)', async () => {
    const { router } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/root', token: ROOT, body: { is_active: false } });
    assert.equal(response.statusCode, 409);
});

test('members: patch of an unknown admin target is 404', async () => {
    const { router } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/ghost', token: ROOT, body: { is_active: false } });
    assert.equal(response.statusCode, 404);
});

test('members: super admin deactivates a target admin (update + audit)', async () => {
    const { router, executed, fixtures } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/target1', token: ROOT, body: { is_active: false, reason: 'offboarding' } });
    assert.equal(response.statusCode, 200);
    assert.ok(executed.some((e) => e.sql.includes('UPDATE users SET is_active=?')));
    assert.ok(executed.some((e) => e.sql.includes('INTO audit_events')));
    assert.equal(fixtures.users['target1'].is_active, 0);
});

test('members: staff promotion by a non-super admin is denied 403 with no write (M1 authority fix)', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/staff/staff-1/roles', token: LEAD, body: { role_code: 'analyst' } });
    assert.equal(response.statusCode, 403);
    assert.equal((response.body as { error?: string }).error, 'Super Admin only');
    assertNoWrite(executed);
});

test('members: staff promotion with an unknown role is 400', async () => {
    const { router, executed } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/staff/staff-1/roles', token: ROOT, body: { role_code: 'ghost' } });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('members: staff promotion of an inactive staff member is 404', async () => {
    const { router } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/staff/staff-inactive/roles', token: ROOT, body: { role_code: 'analyst' } });
    assert.equal(response.statusCode, 404);
});

test('members: staff promotion with a conflicting user identity is 409', async () => {
    const { router } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/staff/staff-conflict/roles', token: ROOT, body: { role_code: 'analyst' } });
    assert.equal(response.statusCode, 409);
});

test('members: super admin promotes a staff identity (users row + admin role + audit)', async () => {
    const { router, executed, fixtures } = makeMembersHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/staff/staff-1/roles', token: ROOT, body: { role_code: 'analyst' } });
    assert.equal(response.statusCode, 201);
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO users')));
    assert.ok(executed.some((e) => e.sql.includes('INTO admin_user_roles')));
    assert.ok(executed.some((e) => e.sql.includes('INTO audit_events')));
    assert.deepEqual(fixtures.adminUserRoles['staff-1'], ['analyst']);
});

test('members: database failure surfaces 500 without leaking internals', async () => {
    const { router } = makeMembersHarness({ throwOnSql: (sql) => sql.includes('SELECT code,name FROM admin_roles') });
    const response = await invokeRoute(router, { method: 'GET', url: '/roles', token: ROOT });
    assert.equal(response.statusCode, 500);
    assert.equal((response.body as { error?: string }).error, 'Failed to load admin roles');
});

// ===========================================================================
// admin-approvals.ts
// ===========================================================================

test('approvals: anonymous is denied 401', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('approvals: caller without approval.read is denied 403', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: OPS });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('approvals: read-permission holder lists only pending rows and binds the status', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: BILLER });
    assert.equal(response.statusCode, 200);
    const ids = (response.body as Array<{ id: string }>).map((row) => row.id);
    assert.ok(ids.includes('ap-credit'));
    assert.ok(!ids.includes('ap-decided'));
    const listQuery = executed.find((e) => e.sql.includes('FROM admin_approval_requests a WHERE a.status=?'));
    assert.ok(listQuery);
    assert.equal(listQuery!.params[0], 'pending');
});

test('approvals: status filter is honored server-side', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: BILLER, query: { status: 'approved' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual((response.body as Array<{ id: string }>).map((r) => r.id), ['ap-decided']);
    const listQuery = executed.find((e) => e.sql.includes('FROM admin_approval_requests a WHERE a.status=?'));
    assert.equal(listQuery!.params[0], 'approved');
});

test('approvals: requesting an adjustment without service_credit.adjust is 403', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: OPS,
        body: { action_key: 'service_credit.credit', instructor_id: INSTRUCTOR_1, amount: '25.00', reason: 'top up' },
    });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('approvals: valid request creates a pending row and an audit event', async () => {
    const { router, executed, fixtures } = makeApprovalsHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: BILLER,
        body: { action_key: 'service_credit.credit', instructor_id: INSTRUCTOR_1, amount: '25.00', reason: 'top up' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal((response.body as { status: string }).status, 'pending');
    const insert = executed.find((e) => e.sql.includes('INSERT INTO admin_approval_requests'));
    assert.ok(insert);
    assert.equal(insert!.params[3], INSTRUCTOR_1);
    assert.ok(executed.some((e) => e.sql.includes('INTO audit_events')));
    const newId = (response.body as { id: string }).id;
    assert.equal(fixtures.approvals[newId].requested_by, 'biller');
});

test('approvals: a non-positive amount is rejected 400', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: BILLER,
        body: { action_key: 'service_credit.credit', instructor_id: INSTRUCTOR_1, amount: '0', reason: 'top up' },
    });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('approvals: a non-instructor target is 404', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: BILLER,
        body: { action_key: 'service_credit.credit', instructor_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', amount: '5.00', reason: 'top up' },
    });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('approvals: deciding without approval.approve is denied 403', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-credit/approve', token: OPS });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('approvals: approving an already-decided request is 409 (duplicate transition)', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-decided/approve', token: BILLER });
    assert.equal(response.statusCode, 409);
    assertNoWrite(executed);
});

test('approvals: approving a missing request is 404', async () => {
    const { router } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-missing/approve', token: BILLER });
    assert.equal(response.statusCode, 404);
});

test('approvals: the requester cannot approve their own request (403)', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-self/approve', token: BILLER });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('approvals: a server-verified super admin may approve their own request', async () => {
    const { router, fixtures } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-root/approve', token: ROOT });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { status: string }).status, 'approved');
    assert.equal(fixtures.approvals['ap-root'].status, 'approved');
});

test('approvals: approving a credit applies the balance, flips status and audits', async () => {
    const { router, executed, fixtures } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-credit/approve', token: BILLER });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { status: string }).status, 'approved');
    assert.equal((response.body as { new_balance: string }).new_balance, '50.00');
    assert.ok(executed.some((e) => e.sql.includes("UPDATE admin_approval_requests SET status='approved'")));
    assert.ok(executed.some((e) => e.sql.includes('UPDATE instructor_wallets SET balance = balance')));
    assert.ok(executed.some((e) => e.sql.includes('INTO instructor_wallet_transactions')));
    assert.ok(executed.some((e) => e.sql.includes('INTO audit_events')));
    assert.equal(fixtures.approvals['ap-credit'].status, 'approved');
    assert.equal(fixtures.wallets[INSTRUCTOR_1], '50.00');
});

test('approvals: a debit beyond the balance is 409 and the row stays pending', async () => {
    const { router, fixtures } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-debit/approve', token: BILLER });
    assert.equal(response.statusCode, 409);
    assert.equal(fixtures.approvals['ap-debit'].status, 'pending');
});

test('approvals: an unsupported stored action is 400', async () => {
    const { router } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-unsupported/approve', token: BILLER });
    assert.equal(response.statusCode, 400);
});

test('approvals: rejecting without a reason is 400', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-credit/reject', token: BILLER, body: {} });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('approvals: rejecting a pending request marks it rejected and audits', async () => {
    const { router, executed, fixtures } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-credit/reject', token: BILLER, body: { reason: 'not needed' } });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { status: string }).status, 'rejected');
    assert.ok(executed.some((e) => e.sql.includes("UPDATE admin_approval_requests SET status='rejected'")));
    assert.ok(executed.some((e) => e.sql.includes('INTO audit_events')));
    assert.equal(fixtures.approvals['ap-credit'].status, 'rejected');
});

test('approvals: rejecting an already-decided request is 409', async () => {
    const { router, executed } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-decided/reject', token: BILLER, body: { reason: 'nope' } });
    assert.equal(response.statusCode, 409);
    assertNoWrite(executed);
});

test('approvals: a requester cannot reject their own request (403)', async () => {
    const { router } = makeApprovalsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/ap-self/reject', token: BILLER, body: { reason: 'self reject' } });
    assert.equal(response.statusCode, 403);
});

// ===========================================================================
// admin-work-items.ts
// ===========================================================================

test('work items: anonymous is denied 401', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('work items: caller without task.read is denied 403', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: NOBODY });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('work items: member list binds the non-management flag and scopes to own/assigned/shared', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: OPS });
    assert.equal(response.statusCode, 200);
    const ids = ((response.body as { data: Array<{ id: string }> }).data).map((row) => row.id).sort();
    assert.deepEqual(ids, ['wi-assigned', 'wi-own', 'wi-team']);
    const listQuery = executed.find((e) => e.sql.includes('ORDER BY w.created_at DESC'));
    assert.ok(listQuery);
    assert.equal(listQuery!.params[0], 0);
    assert.equal(listQuery!.params[1], 'ops');
});

test('work items: management-holder list binds the management flag and sees all items', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: LEAD });
    assert.equal(response.statusCode, 200);
    const ids = ((response.body as { data: Array<{ id: string }> }).data).map((row) => row.id).sort();
    assert.deepEqual(ids, ['wi-assigned', 'wi-other', 'wi-own', 'wi-team']);
    const listQuery = executed.find((e) => e.sql.includes('ORDER BY w.created_at DESC'));
    assert.equal(listQuery!.params[0], 1);
});

test('work items: create without task.create is denied 403', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: NOBODY, body: { type: 'support_case', title: 'New item' } });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('work items: a valid create inserts the item and a created event', async () => {
    const { router, executed, fixtures } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: OPS, body: { type: 'support_case', title: 'New item' } });
    assert.equal(response.statusCode, 201);
    const newId = (response.body as { id: string }).id;
    assert.ok(fixtures.workItems[newId]);
    assert.equal(fixtures.workItems[newId].created_by, 'ops');
    assert.ok(fixtures.workItemEvents.some((e) => e.work_item_id === newId && e.event_type === 'created'));
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO admin_work_items')));
});

test('work items: create with an invalid title is 400', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: OPS, body: { type: 'support_case', title: 'x' } });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('work items: create with a team but without task.assign is 403', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: CREATOR, body: { type: 'support_case', title: 'Team item', assigned_team_id: 'team-ops' } });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('work items: create with an unknown team is 400 (user-controlled target verified)', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: OPS, body: { type: 'support_case', title: 'Team item', assigned_team_id: 'ghost-team' } });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error, 'Assigned team not found');
    assertNoWrite(executed);
});

test('work items: create with a team the caller belongs to succeeds', async () => {
    const { router, fixtures } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: OPS, body: { type: 'support_case', title: 'Team item', assigned_team_id: 'team-ops' } });
    assert.equal(response.statusCode, 201);
    const newId = (response.body as { id: string }).id;
    assert.equal(fixtures.workItems[newId].assigned_team_id, 'team-ops');
});

test('work items: create with a foreign team and no management is 403', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/', token: OPS, body: { type: 'support_case', title: 'Team item', assigned_team_id: 'team-sec' } });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('work items: an invisible item read is 404', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/wi-other', token: OPS });
    assert.equal(response.statusCode, 404);
    assert.ok(!executed.some((e) => e.sql.includes('SELECT * FROM admin_work_items')));
});

test('work items: the creator reads its own item with its events', async () => {
    const { router } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/wi-own', token: OPS });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { item: { id: string } }).item.id, 'wi-own');
    assert.ok(Array.isArray((response.body as { events: unknown[] }).events));
});

test('work items: management reads an item it does not own', async () => {
    const { router } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'GET', url: '/wi-other', token: LEAD });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { item: { id: string } }).item.id, 'wi-other');
});

test('work items: commenting on an invisible item is 404 with no write', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/wi-other/comments', token: OPS, body: { body: 'hi' } });
    assert.equal(response.statusCode, 404);
    assertNoWrite(executed);
});

test('work items: commenting on a visible item is 201', async () => {
    const { router, fixtures } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'POST', url: '/wi-own/comments', token: OPS, body: { body: 'hello' } });
    assert.equal(response.statusCode, 201);
    assert.ok(fixtures.workItemEvents.some((e) => e.work_item_id === 'wi-own' && e.event_type === 'internal_comment'));
});

test('work items: assign without task.assign is denied 403', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/wi-own/assign', token: NOBODY, body: { assigned_team_id: 'team-ops', reason: 'handoff' } });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('work items: assign with an unknown team is 400 (user-controlled target verified)', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/wi-own/assign', token: LEAD, body: { assigned_team_id: 'ghost-team', reason: 'handoff' } });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error, 'Assigned team not found');
    assertNoWrite(executed);
});

test('work items: assign to a non-admin assignee is 400', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/wi-own/assign', token: LEAD, body: { assigned_admin_id: INSTRUCTOR_1, reason: 'handoff' } });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('work items: cross-team handoff by a non-management member is 403', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/wi-own/assign', token: OPS, body: { assigned_team_id: 'team-sec', reason: 'handoff' } });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('work items: assignee outside the caller team is 403 for a non-management member', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/wi-own/assign', token: OPS, body: { assigned_admin_id: 'peer', reason: 'handoff' } });
    assert.equal(response.statusCode, 403);
    assertNoWrite(executed);
});

test('work items: management can hand an item off cross-team', async () => {
    const { router, executed, fixtures } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/wi-own/assign', token: LEAD, body: { assigned_team_id: 'team-sec', assigned_admin_id: 'peer', reason: 'handoff' } });
    assert.equal(response.statusCode, 200);
    assert.equal(fixtures.workItems['wi-own'].assigned_team_id, 'team-sec');
    assert.equal(fixtures.workItems['wi-own'].assigned_admin_id, 'peer');
    assert.ok(executed.some((e) => e.sql.includes('UPDATE admin_work_items SET assigned_team_id=?')));
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO admin_work_item_events')));
});

test('work items: assign without a reason is 400', async () => {
    const { router, executed } = makeWorkItemsHarness();
    const response = await invokeRoute(router, { method: 'PATCH', url: '/wi-own/assign', token: LEAD, body: { assigned_team_id: 'team-ops' } });
    assert.equal(response.statusCode, 400);
    assertNoWrite(executed);
});

test('work items: database failure on the list surfaces 500', async () => {
    const { router } = makeWorkItemsHarness({ throwOnSql: (sql) => sql.includes('ORDER BY w.created_at DESC') });
    const response = await invokeRoute(router, { method: 'GET', url: '/', token: OPS });
    assert.equal(response.statusCode, 500);
    assert.equal((response.body as { error?: string }).error, 'Failed to load work items');
});
