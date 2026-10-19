import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    MAX_LIST_LIMIT,
    hashContent,
} from '../src/services/moderation';
import type {
    ModerationAppealRow,
    ModerationCaseRow,
    ModerationContentGateway,
    ModerationDecision,
    ModerationHistoryRow,
    ModerationReport,
    ModerationStore,
} from '../src/services/moderation';
import { createModerationRouter } from '../src/routes/moderation';
import type { SealedAuditRecordInput } from '../src/services/audit-log';
import { TEST_SECRET, invokeRoute, makeRepository, tokenFor } from './helpers/m2-harness';

/**
 * M7 O4 content-moderation route contract.
 *
 * The REAL router is driven through injected seams: the REAL auth middleware
 * over an injected principal repository, an in-memory ModerationStore, a
 * scripted report source, a scripted content gateway, an injected clock/id
 * factory and an in-memory audit sink. No database, network or Docker.
 *
 * Every handler is covered with allow + deny + cross-tenant + validation +
 * failure cases, and the audit trail is asserted for each mutation.
 */

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const PLATFORM = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
const OWNER_A = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const STAFF_A = tokenFor({ id: 'staff-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const REPORTER_A = tokenFor({ id: 'reporter-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const AUTHOR_A = tokenFor({ id: 'author-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const OWNER_B = tokenFor({ id: 'owner-b', role: 'instructor', tv: 0, tenant_id: 'tenant-b' });

const USERS: Record<string, { is_active: number; token_version: number; suspension_active: number; role?: string }> = {
    'admin-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
    'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'staff-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'reporter-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'author-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    'owner-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
};

const authRepository = () => makeRepository(USERS, {
    instructorAccounts: {
        'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'staff-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'reporter-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'author-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'owner-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    memberships: {
        'owner-a': [{ tenant_id: 'tenant-a' }],
        'instructor-a': [{ tenant_id: 'tenant-a' }],
        'staff-a': [{ tenant_id: 'tenant-a' }],
        'reporter-a': [{ tenant_id: 'tenant-a' }],
        'author-a': [{ tenant_id: 'tenant-a' }],
        'owner-b': [{ tenant_id: 'tenant-b' }],
    },
});

const AUTHORITY: Record<string, { authority: string } | null> = {
    'owner-a:tenant-a': { authority: 'owner' },
    'instructor-a:tenant-a': { authority: 'instructor' },
    'owner-b:tenant-b': { authority: 'owner' },
};

/* -------------------------------------------------------------------------- */
/* In-memory store                                                            */
/* -------------------------------------------------------------------------- */

interface StoreHarness {
    store: ModerationStore;
    cases: Map<string, ModerationCaseRow>;
    byReport: Map<string, string>;
    history: ModerationHistoryRow[];
    appeals: Map<string, ModerationAppealRow>;
    /** Method names that return 0 affected rows exactly once (concurrency). */
    failOnce: Set<string>;
}

const clone = <T>(row: T): T => ({ ...(row as object) }) as T;

const memoryStore = (): StoreHarness => {
    const cases = new Map<string, ModerationCaseRow>();
    const byReport = new Map<string, string>();
    const history: ModerationHistoryRow[] = [];
    const appeals = new Map<string, ModerationAppealRow>();
    const failOnce = new Set<string>();
    const consume = (method: string): boolean => {
        if (!failOnce.has(method)) return false;
        failOnce.delete(method);
        return true;
    };
    const store: ModerationStore = {
        insertCase: async (row) => {
            if (byReport.has(row.report_id)) {
                const error = new Error('duplicate case for report') as Error & { code?: string };
                error.code = 'ER_DUP_ENTRY';
                throw error;
            }
            cases.set(row.id, clone(row));
            byReport.set(row.report_id, row.id);
        },
        findCaseById: async (caseId) => {
            const row = cases.get(caseId);
            return row ? clone(row) : null;
        },
        findCaseByReportId: async (reportId) => {
            const id = byReport.get(reportId);
            const row = id ? cases.get(id) : undefined;
            return row ? clone(row) : null;
        },
        listCases: async (filter) => Array.from(cases.values())
            .filter((row) => filter.tenantId === null || row.tenant_id === filter.tenantId)
            .filter((row) => filter.status === null || row.status === filter.status)
            .filter((row) => filter.targetType === null || row.target_type === filter.targetType)
            .filter((row) => filter.assignedReviewerUserId === null
                || row.assigned_reviewer_user_id === filter.assignedReviewerUserId)
            .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
            .slice(0, filter.limit)
            .map(clone),
        maxRevision: async (caseId) => history
            .filter((row) => row.case_id === caseId)
            .reduce((max, row) => Math.max(max, Number(row.revision_no)), 0),
        appendHistory: async (row) => {
            if (consume('appendHistory')) return 0;
            const duplicate = history.some((existing) => existing.case_id === row.case_id
                && existing.revision_no === row.revision_no);
            if (duplicate) return 0;
            history.push(clone(row));
            return 1;
        },
        listHistory: async (caseId) => history
            .filter((row) => row.case_id === caseId)
            .sort((a, b) => a.revision_no - b.revision_no)
            .map(clone),
        findAppealByCaseId: async (caseId) => {
            const row = appeals.get(caseId);
            return row ? clone(row) : null;
        },
        insertAppeal: async (row) => {
            if (consume('insertAppeal')) return 0;
            if (appeals.has(row.case_id)) return 0;
            appeals.set(row.case_id, clone(row));
            return 1;
        },
        resolveAppeal: async (caseId, reviewerUserId, at) => {
            if (consume('resolveAppeal')) return 0;
            const row = appeals.get(caseId);
            if (!row || row.status !== 'pending') return 0;
            appeals.set(caseId, { ...row, status: 'resolved', reviewed_by_user_id: reviewerUserId, reviewed_at: at });
            return 1;
        },
        assignCase: async (caseId, tenantId, reviewerUserId, at) => {
            if (consume('assignCase')) return 0;
            const row = cases.get(caseId);
            if (!row || row.tenant_id !== tenantId || (row.status !== 'open' && row.status !== 'in_review')) return 0;
            cases.set(caseId, {
                ...row,
                status: 'in_review',
                assigned_reviewer_user_id: reviewerUserId,
                assigned_at: at,
                version: row.version + 1,
            });
            return 1;
        },
        setStatus: async (caseId, tenantId, status, _at) => {
            if (consume('setStatus')) return 0;
            const row = cases.get(caseId);
            if (!row || row.tenant_id !== tenantId) return 0;
            cases.set(caseId, { ...row, status, version: row.version + 1 });
            return 1;
        },
        recordDecision: async (caseId, tenantId, decision, reason, actorUserId, at, status) => {
            if (consume('recordDecision')) return 0;
            const row = cases.get(caseId);
            if (!row || row.tenant_id !== tenantId) return 0;
            cases.set(caseId, {
                ...row,
                decision,
                decision_reason: reason,
                decided_by_user_id: actorUserId,
                decided_at: at,
                status,
                version: row.version + 1,
            });
            return 1;
        },
    };
    return { store, cases, byReport, history, appeals, failOnce };
};

/* -------------------------------------------------------------------------- */
/* Router harness                                                             */
/* -------------------------------------------------------------------------- */

interface ContentSpy {
    snapshots: Array<{ targetType: string; targetId: string }>;
    actions: Array<{ targetId: string; action: string; reason: string; actorUserId: string }>;
    affected: number;
}

interface Fixture {
    reports?: Record<string, ModerationReport>;
    snapshotNull?: boolean;
    actionAffected?: number;
    seed?: ModerationCaseRow[];
    seedAppeals?: ModerationAppealRow[];
    notifyError?: boolean;
}

const BASE_TIME = new Date('2026-10-19T10:00:00.000Z');
const THREAD_BODY = 'the raw secret message body';

const report = (id: string, tenantId: string, reporter: string, targetId: string): ModerationReport => ({
    id,
    tenant_id: tenantId,
    target_type: 'thread',
    target_id: targetId,
    reporter_user_id: reporter,
    reason: 'spam report',
});

const seedCase = (overrides: Partial<ModerationCaseRow> = {}): ModerationCaseRow => ({
    id: 'case-open',
    tenant_id: 'tenant-a',
    report_id: 'report-open',
    target_type: 'thread',
    target_id: 'thread-a',
    reporter_user_id: 'reporter-a',
    report_reason: 'spam report',
    target_author_user_id: 'author-a',
    evidence_snapshot: { target_type: 'thread', target_id: 'thread-a', content_hash: hashContent(THREAD_BODY) },
    status: 'open',
    assigned_reviewer_user_id: null,
    assigned_at: null,
    decision: null,
    decision_reason: null,
    decided_by_user_id: null,
    decided_at: null,
    version: 0,
    created_at: BASE_TIME,
    ...overrides,
});

const buildHarness = (fixture: Fixture = {}) => {
    const memory = memoryStore();
    const auditRecords: SealedAuditRecordInput[] = [];
    const notifications: string[] = [];
    const content: ContentSpy = { snapshots: [], actions: [], affected: fixture.actionAffected ?? 1 };
    let counter = 0;
    const idFactory = (): string => `id-${++counter}`;

    for (const row of fixture.seed ?? []) {
        memory.cases.set(row.id, row);
        memory.byReport.set(row.report_id, row.id);
    }
    for (const appeal of fixture.seedAppeals ?? []) {
        memory.appeals.set(appeal.case_id, appeal);
    }

    const gateway: ModerationContentGateway = {
        snapshotEvidence: async (targetType, targetId) => {
            content.snapshots.push({ targetType, targetId });
            if (fixture.snapshotNull) return null;
            return {
                target_type: targetType,
                target_id: targetId,
                lecture_id: 'lecture-a',
                author_user_id: 'author-a',
                status: 'open',
                content_hash: hashContent(THREAD_BODY),
            };
        },
        applyAction: async ({ targetId, action, reason, actorUserId }) => {
            content.actions.push({ targetId, action, reason, actorUserId });
            return content.affected;
        },
    };

    const router: Router = createModerationRouter({
        store: memory.store,
        authenticate: createAuthenticateToken(authRepository()),
        reports: {
            findReportById: async (id) => fixture.reports?.[id] ?? null,
        },
        content: gateway,
        isPlatformModerator: async (userId) => userId === 'admin-a',
        loadActiveTenantAuthority: async (userId, tenantId) => AUTHORITY[`${userId}:${tenantId}`] ?? null,
        notifyTenantOwner: async (event) => {
            if (fixture.notifyError) throw new Error('notifier down');
            notifications.push(event.case_id);
        },
        recordAudit: async (_tx, input) => {
            auditRecords.push(input);
        },
        now: () => BASE_TIME,
        idFactory,
    });

    return { router, memory, content, auditRecords, notifications };
};

const request = async (
    router: Router,
    req: { method: string; url: string; token?: string; body?: unknown; query?: Record<string, string> },
): Promise<{ statusCode?: number; body?: unknown }> =>
    invokeRoute(router, req as never) as Promise<{ statusCode?: number; body?: unknown }>;

const decisionBody = (decision: ModerationDecision, reason = 'policy violation'): { decision: string; reason: string } =>
    ({ decision, reason });

/* -------------------------------------------------------------------------- */
/* GET /cases                                                                  */
/* -------------------------------------------------------------------------- */

test('GET /cases: a platform moderator lists the whole queue and may pin a tenant', async () => {
    const h = buildHarness({
        seed: [
            seedCase({ id: 'case-a', tenant_id: 'tenant-a', report_id: 'r-a', created_at: BASE_TIME }),
            seedCase({ id: 'case-b', tenant_id: 'tenant-b', report_id: 'r-b', created_at: new Date(BASE_TIME.getTime() + 1000) }),
        ],
    });
    const all = await request(h.router, { method: 'GET', url: '/cases', token: PLATFORM });
    assert.equal(all.statusCode, 200);
    assert.equal((all.body as unknown[]).length, 2);

    const pinned = await request(h.router, { method: 'GET', url: '/cases', token: PLATFORM, query: { tenant_id: 'tenant-b' } });
    assert.equal(pinned.statusCode, 200);
    assert.deepEqual((pinned.body as Array<{ tenant_id: string }>).map((row) => row.tenant_id), ['tenant-b']);
});

test('GET /cases: a tenant owner is pinned to their own tenant regardless of the tenant_id filter', async () => {
    const h = buildHarness({
        seed: [
            seedCase({ id: 'case-a', tenant_id: 'tenant-a', report_id: 'r-a' }),
            seedCase({ id: 'case-b', tenant_id: 'tenant-b', report_id: 'r-b' }),
        ],
    });
    const res = await request(h.router, { method: 'GET', url: '/cases', token: OWNER_A, query: { tenant_id: 'tenant-b' } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as Array<{ tenant_id: string }>).map((row) => row.tenant_id), ['tenant-a']);
});

test('GET /cases: validation and denial', async () => {
    const h = buildHarness({ seed: [seedCase()] });
    assert.equal((await request(h.router, { method: 'GET', url: '/cases', token: PLATFORM, query: { status: 'bogus' } })).statusCode, 400);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases', token: PLATFORM, query: { limit: '0' } })).statusCode, 400);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases', token: PLATFORM, query: { limit: `${MAX_LIST_LIMIT + 1}x` } })).statusCode, 400);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases', token: PLATFORM, query: { tenant_id: 'bad id' } })).statusCode, 400);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases', token: STAFF_A })).statusCode, 403);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases' })).statusCode, 401);
});

/* -------------------------------------------------------------------------- */
/* GET /cases/:id                                                              */
/* -------------------------------------------------------------------------- */

test('GET /cases/:id: returns case, append-only history and appeal for an authorised moderator', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a', status: 'appealed' })] });
    h.memory.history.push({
        id: 'h-1', case_id: 'case-a', tenant_id: 'tenant-a', revision_no: 1, kind: 'decision',
        decision: 'hide_content', reason: 'spam', actor_user_id: 'instructor-a', actor_role: 'tenant_moderator',
    });
    const res = await request(h.router, { method: 'GET', url: '/cases/case-a', token: OWNER_A });
    assert.equal(res.statusCode, 200);
    const body = res.body as { case: { id: string }; history: unknown[]; appeal: unknown };
    assert.equal(body.case.id, 'case-a');
    assert.equal(body.history.length, 1);
    assert.equal(body.appeal, null);
});

test('GET /cases/:id: cross-tenant and unknown ids are 404, non-moderators are 403', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-b', tenant_id: 'tenant-b' })] });
    assert.equal((await request(h.router, { method: 'GET', url: '/cases/case-b', token: OWNER_A })).statusCode, 404);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases/nope', token: OWNER_A })).statusCode, 404);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases/nope', token: STAFF_A })).statusCode, 403);
    assert.equal((await request(h.router, { method: 'GET', url: '/cases/case-b', token: OWNER_B })).statusCode, 200);
});

/* -------------------------------------------------------------------------- */
/* POST /cases                                                                 */
/* -------------------------------------------------------------------------- */

test('POST /cases: a moderator promotes a report; evidence is a bounded hash and the mutation is audited', async () => {
    const h = buildHarness({ reports: { 'report-a': report('report-a', 'tenant-a', 'reporter-a', 'thread-a') } });
    const res = await request(h.router, { method: 'POST', url: '/cases', token: OWNER_A, body: { report_id: 'report-a' } });
    assert.equal(res.statusCode, 201);
    const body = res.body as { id: string; status: string; evidence: { content_hash: string } };
    assert.equal(body.status, 'open');
    assert.equal(body.evidence.content_hash, hashContent(THREAD_BODY));
    assert.equal(h.content.snapshots.length, 1);

    const stored = h.memory.cases.get(body.id);
    assert.ok(stored);
    assert.ok(!JSON.stringify(stored.evidence_snapshot).includes(THREAD_BODY), 'raw body must never be stored');
    assert.equal(h.auditRecords.length, 1);
    assert.equal(h.auditRecords[0].action, 'moderation.case_opened');
    assert.equal(h.auditRecords[0].actorUserId, 'owner-a');
    assert.equal((h.auditRecords[0].newValue as { content_hash: string }).content_hash, hashContent(THREAD_BODY));
});

test('POST /cases: platform moderator may open a case for any tenant', async () => {
    const h = buildHarness({ reports: { 'report-b': report('report-b', 'tenant-b', 'owner-b', 'thread-b') } });
    const res = await request(h.router, { method: 'POST', url: '/cases', token: PLATFORM, body: { report_id: 'report-b' } });
    assert.equal(res.statusCode, 201);
});

test('POST /cases: cross-tenant, unknown report, missing target, duplicate, validation and denial', async () => {
    const base = { reports: { 'report-b': report('report-b', 'tenant-b', 'owner-b', 'thread-b') } };
    // cross-tenant tenant-a moderator vs tenant-b report
    assert.equal((await request(buildHarness(base).router, { method: 'POST', url: '/cases', token: OWNER_A, body: { report_id: 'report-b' } })).statusCode, 404);
    // unknown report
    assert.equal((await request(buildHarness(base).router, { method: 'POST', url: '/cases', token: OWNER_B, body: { report_id: 'ghost' } })).statusCode, 404);
    // evidence cannot be proven
    assert.equal((await request(buildHarness({ ...base, snapshotNull: true }).router, { method: 'POST', url: '/cases', token: OWNER_B, body: { report_id: 'report-b' } })).statusCode, 404);
    // validation
    assert.equal((await request(buildHarness(base).router, { method: 'POST', url: '/cases', token: OWNER_B, body: {} })).statusCode, 400);
    // duplicate case for the same report
    const dup = buildHarness({ ...base, seed: [seedCase({ id: 'case-b', tenant_id: 'tenant-b', report_id: 'report-b' })] });
    assert.equal((await request(dup.router, { method: 'POST', url: '/cases', token: OWNER_B, body: { report_id: 'report-b' } })).statusCode, 409);
    // denial
    assert.equal((await request(buildHarness(base).router, { method: 'POST', url: '/cases', token: STAFF_A, body: { report_id: 'report-b' } })).statusCode, 403);
    assert.equal((await request(buildHarness(base).router, { method: 'POST', url: '/cases', body: { report_id: 'report-b' } })).statusCode, 401);
});

/* -------------------------------------------------------------------------- */
/* POST /cases/:id/assign                                                      */
/* -------------------------------------------------------------------------- */

test('POST /cases/:id/assign: assigns a verified reviewer and audits it', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a' })] });
    const res = await request(h.router, {
        method: 'POST', url: '/cases/case-a/assign', token: OWNER_A, body: { reviewer_user_id: 'instructor-a' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.body as { status: string; assigned_reviewer_user_id: string };
    assert.equal(body.status, 'in_review');
    assert.equal(body.assigned_reviewer_user_id, 'instructor-a');
    assert.equal(h.auditRecords.at(-1)?.action, 'moderation.case_assigned');
});

test('POST /cases/:id/assign: an empty reviewer means self-assign', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a' })] });
    const res = await request(h.router, { method: 'POST', url: '/cases/case-a/assign', token: OWNER_A, body: {} });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { assigned_reviewer_user_id: string }).assigned_reviewer_user_id, 'owner-a');
});

test('POST /cases/:id/assign: rejects an unknown reviewer, decided cases, non-moderators and cross-tenant', async () => {
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a' })] }).router, {
        method: 'POST', url: '/cases/case-a/assign', token: OWNER_A, body: { reviewer_user_id: 'staff-a' },
    })).statusCode, 400);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided' })] }).router, {
        method: 'POST', url: '/cases/case-a/assign', token: OWNER_A, body: {},
    })).statusCode, 409);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a' })] }).router, {
        method: 'POST', url: '/cases/case-a/assign', token: STAFF_A, body: {},
    })).statusCode, 403);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-b', tenant_id: 'tenant-b' })] }).router, {
        method: 'POST', url: '/cases/case-b/assign', token: OWNER_A, body: {},
    })).statusCode, 404);
});

test('POST /cases/:id/assign: a concurrent assignment is a 409, not a silent overwrite', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a' })] });
    h.memory.failOnce.add('assignCase');
    const res = await request(h.router, { method: 'POST', url: '/cases/case-a/assign', token: OWNER_A, body: {} });
    assert.equal(res.statusCode, 409);
});

/* -------------------------------------------------------------------------- */
/* POST /cases/:id/decision                                                    */
/* -------------------------------------------------------------------------- */

test('POST /cases/:id/decision: applies the content action, appends immutable history and audits', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a' })] });
    const res = await request(h.router, {
        method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: decisionBody('hide_content'),
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as { status: string }).status, 'decided');
    assert.deepEqual(h.content.actions, [{ targetId: 'thread-a', action: 'hide', reason: 'policy violation', actorUserId: 'owner-a' }]);
    assert.equal(h.memory.history.length, 1);
    assert.equal(h.memory.history[0].revision_no, 1);
    assert.equal(h.memory.history[0].decision, 'hide_content');
    assert.equal(h.auditRecords.at(-1)?.action, 'moderation.decision_recorded');
});

test('POST /cases/:id/decision: a dismiss decision touches no content', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a' })] });
    const res = await request(h.router, { method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: decisionBody('dismiss') });
    assert.equal(res.statusCode, 200);
    assert.equal(h.content.actions.length, 0);
});

test('POST /cases/:id/decision: the reporter cannot decide their own report', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a', reporter_user_id: 'owner-a' })] });
    const res = await request(h.router, { method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: decisionBody('hide_content') });
    assert.equal(res.statusCode, 403);
    assert.equal(h.content.actions.length, 0);
});

test('POST /cases/:id/decision: validation, already-decided, cross-tenant and non-moderator', async () => {
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a' })] }).router, {
        method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: decisionBody('hide_content', 'x'),
    })).statusCode, 400);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a' })] }).router, {
        method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: { decision: 'explode', reason: 'policy' },
    })).statusCode, 400);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided' })] }).router, {
        method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: decisionBody('dismiss'),
    })).statusCode, 409);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-b', tenant_id: 'tenant-b' })] }).router, {
        method: 'POST', url: '/cases/case-b/decision', token: OWNER_A, body: decisionBody('dismiss'),
    })).statusCode, 404);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a' })] }).router, {
        method: 'POST', url: '/cases/case-a/decision', token: STAFF_A, body: decisionBody('dismiss'),
    })).statusCode, 403);
});

test('POST /cases/:id/decision: a missing target and a concurrent update both surface as 409', async () => {
    const missing = buildHarness({ seed: [seedCase({ id: 'case-a' })], actionAffected: 0 });
    assert.equal((await request(missing.router, {
        method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: decisionBody('remove_content'),
    })).statusCode, 409);

    const concurrent = buildHarness({ seed: [seedCase({ id: 'case-a' })] });
    concurrent.memory.failOnce.add('recordDecision');
    assert.equal((await request(concurrent.router, {
        method: 'POST', url: '/cases/case-a/decision', token: OWNER_A, body: decisionBody('hide_content'),
    })).statusCode, 409);
});

/* -------------------------------------------------------------------------- */
/* POST /cases/:id/appeal                                                      */
/* -------------------------------------------------------------------------- */

test('POST /cases/:id/appeal: a reporter appeals a decided case once; audited and notified', async () => {
    const h = buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided', decision: 'hide_content' })] });
    const res = await request(h.router, { method: 'POST', url: '/cases/case-a/appeal', token: REPORTER_A, body: { reason: 'I disagree' } });
    assert.equal(res.statusCode, 201);
    assert.equal((res.body as { status: string }).status, 'pending');
    assert.equal(h.memory.cases.get('case-a')?.status, 'appealed');
    assert.equal(h.auditRecords.at(-1)?.action, 'moderation.appeal_filed');
    assert.deepEqual(h.notifications, ['case-a']);

    const second = await request(h.router, { method: 'POST', url: '/cases/case-a/appeal', token: REPORTER_A, body: { reason: 'again' } });
    assert.equal(second.statusCode, 409);
});

test('POST /cases/:id/appeal: the content author may appeal, but a non-party moderator cannot', async () => {
    const author = buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided', target_author_user_id: 'author-a' })] });
    assert.equal((await request(author.router, { method: 'POST', url: '/cases/case-a/appeal', token: AUTHOR_A, body: { reason: 'unfair' } })).statusCode, 201);

    const nonParty = buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided' })] });
    assert.equal((await request(nonParty.router, { method: 'POST', url: '/cases/case-a/appeal', token: INSTRUCTOR_A, body: { reason: 'peer appeal' } })).statusCode, 403);
});

test('POST /cases/:id/appeal: only a decided case, with a reason, and never cross-tenant', async () => {
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a', status: 'open' })] }).router, {
        method: 'POST', url: '/cases/case-a/appeal', token: REPORTER_A, body: { reason: 'too early' },
    })).statusCode, 409);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided' })] }).router, {
        method: 'POST', url: '/cases/case-a/appeal', token: REPORTER_A, body: {},
    })).statusCode, 400);
    // a tenant-a moderator probing a tenant-b case they are not a party to cannot even see it
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-b', tenant_id: 'tenant-b', reporter_user_id: 'reporter-b', target_author_user_id: 'author-b' })] }).router, {
        method: 'POST', url: '/cases/case-b/appeal', token: OWNER_A, body: { reason: 'cross tenant?' },
    })).statusCode, 404);
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided' })] }).router, {
        method: 'POST', url: '/cases/case-a/appeal', body: { reason: 'anonymous' },
    })).statusCode, 401);
});

/* -------------------------------------------------------------------------- */
/* POST /cases/:id/appeal-decision                                             */
/* -------------------------------------------------------------------------- */

const appealedCase = (overrides: Partial<ModerationCaseRow> = {}): ModerationCaseRow => seedCase({
    id: 'case-a',
    status: 'appealed',
    decision: 'hide_content',
    decision_reason: 'policy violation',
    decided_by_user_id: 'instructor-a',
    decided_at: BASE_TIME,
    ...overrides,
});

const pendingAppeal = (overrides: Partial<ModerationAppealRow> = {}): ModerationAppealRow => ({
    id: 'appeal-a',
    case_id: 'case-a',
    tenant_id: 'tenant-a',
    appellant_user_id: 'reporter-a',
    reason: 'I disagree',
    status: 'pending',
    reviewed_by_user_id: null,
    reviewed_at: null,
    ...overrides,
});

test('POST /cases/:id/appeal-decision: a different reviewer resolves the appeal and closes the case', async () => {
    const h = buildHarness({ seed: [appealedCase()], seedAppeals: [pendingAppeal()] });
    const res = await request(h.router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: OWNER_A, body: decisionBody('restore_content', 'appeal upheld'),
    });
    assert.equal(res.statusCode, 200);
    const body = res.body as { case: { status: string }; appeal: { status: string } };
    assert.equal(body.case.status, 'closed');
    assert.equal(body.appeal.status, 'resolved');
    assert.equal(h.memory.appeals.get('case-a')?.reviewed_by_user_id, 'owner-a');
    assert.equal(h.memory.history.at(-1)?.kind, 'appeal_decision');
    assert.equal(h.auditRecords.at(-1)?.action, 'moderation.appeal_decided');
});

test('POST /cases/:id/appeal-decision: the original reviewer and the appellant are refused', async () => {
    const original = buildHarness({ seed: [appealedCase()], seedAppeals: [pendingAppeal()] });
    assert.equal((await request(original.router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: INSTRUCTOR_A, body: decisionBody('dismiss', 'uphold'),
    })).statusCode, 403);

    const appellant = buildHarness({
        seed: [appealedCase()],
        seedAppeals: [pendingAppeal({ appellant_user_id: 'owner-a' })],
    });
    assert.equal((await request(appellant.router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: OWNER_A, body: decisionBody('dismiss', 'uphold'),
    })).statusCode, 403);
});

test('POST /cases/:id/appeal-decision: no pending appeal, validation, cross-tenant and non-moderator', async () => {
    assert.equal((await request(buildHarness({ seed: [seedCase({ id: 'case-a', status: 'decided' })] }).router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: OWNER_A, body: decisionBody('dismiss', 'x y'),
    })).statusCode, 409);
    assert.equal((await request(buildHarness({ seed: [appealedCase()], seedAppeals: [pendingAppeal()] }).router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: OWNER_A, body: { decision: 'dismiss' },
    })).statusCode, 400);
    assert.equal((await request(buildHarness({ seed: [appealedCase({ tenant_id: 'tenant-b' })], seedAppeals: [pendingAppeal({ tenant_id: 'tenant-b' })] }).router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: OWNER_A, body: decisionBody('dismiss', 'cross tenant'),
    })).statusCode, 404);
    assert.equal((await request(buildHarness({ seed: [appealedCase()], seedAppeals: [pendingAppeal()] }).router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: STAFF_A, body: decisionBody('dismiss', 'nope'),
    })).statusCode, 403);
});

test('POST /cases/:id/appeal-decision: a notification failure never fails the accepted resolution', async () => {
    const h = buildHarness({ seed: [appealedCase()], seedAppeals: [pendingAppeal()], notifyError: true });
    const res = await request(h.router, {
        method: 'POST', url: '/cases/case-a/appeal-decision', token: OWNER_A, body: decisionBody('dismiss', 'upheld'),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(h.memory.cases.get('case-a')?.status, 'closed');
});
