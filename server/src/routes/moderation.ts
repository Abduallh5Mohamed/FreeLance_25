/**
 * M7 O4 — content moderation queue routes.
 *
 * Audience + permission model (deny-by-default):
 *  - Every path requires authentication.
 *  - A verified platform moderator (server-owned `moderation.manage` permission
 *    or super admin — never a JWT role claim) may read and act across tenants.
 *  - A verified tenant moderator (server-owned active owner/instructor
 *    authority inside the caller's own tenant) may only read and act on cases
 *    of that tenant. The tenant filter is forced to the server-derived tenant;
 *    a cross-tenant case id is answered with 404 so cases cannot be enumerated.
 *  - Reviewers must be verified moderators for the case tenant; assignment to an
 *    unknown reviewer is rejected.
 *  - Reports are read through an injected source; their `open` status is NOT
 *    changed by a decision (closing mapping held pending an explicit contract);
 *    lesson-discussions content is reached through an injected gateway. Only a
 *    bounded, non-PII evidence snapshot (ids + content hash) is stored.
 *  - A decision (and an appeal decision) is refused to the report's reporter
 *    and to the reported content's author.
 *  - An appeal may be filed exactly once, by the report's reporter or the target
 *    author, and is resolved only by a reviewer different from the original
 *    decider, from the appellant and from the target author. Decision history
 *    is append-only.
 *  - Every mutation is audited (actor, reason, before/after) in the same
 *    transaction, so a failed audit aborts the write. The tenant owner is
 *    notified through an injected, PII-free hook (best-effort).
 *
 * This module exports `createModerationRouter(deps)` and a production
 * default-wired router instance at the bottom.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { SealedAuditRecordInput, recordSealedAuditEvent } from '../services/audit-log';
import {
    DecisionKind,
    ModerationCaseRow,
    ModerationCaseStatus,
    ModerationContentGateway,
    ModerationDataAccess,
    ModerationDecision,
    ModerationIdFactory,
    ModerationReport,
    ModerationReportSource,
    ModerationStore,
    ModerationTargetType,
    ModerationOwnerNotifier,
    CASE_STATUSES,
    MODERATION_TARGET_TYPES,
    clampListLimit,
    contentActionForDecision,
    createSqlModerationStore,
    defaultModerationIdFactory,
    hashContent,
    noopModerationOwnerNotifier,
    normalizeModerationId,
    projectAppeal,
    projectCase,
    projectHistory,
    validateAppealInput,
    validateAssignInput,
    validateCaseOpenInput,
    validateDecisionInput,
} from '../services/moderation';
import { createSqlLessonDiscussionsStore } from '../services/lesson-discussions';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

export interface ModerationDeps {
    /** Raw connection used for the default store and, with `transaction`, audit. */
    db?: ModerationDataAccess;
    /** Injected store (tests); defaults to the SQL store over `db`. */
    store?: ModerationStore;
    authenticate: RequestHandler;
    /** Read-only source of M6 P6 reports. */
    reports: ModerationReportSource;
    /** Injected seam to snapshot evidence and apply content actions. */
    content: ModerationContentGateway;
    /** Verified platform-moderator check (server-owned rows only). */
    isPlatformModerator: (userId: string) => Promise<boolean>;
    /** Verified active tenant authority for the caller inside one tenant. */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /** PII-free tenant-owner notification hook (best-effort). */
    notifyTenantOwner: ModerationOwnerNotifier;
    /** Sealed audit writer; runs with the transaction data access. */
    recordAudit: (tx: ModerationDataAccess, input: SealedAuditRecordInput) => Promise<void>;
    now?: () => Date;
    idFactory?: ModerationIdFactory;
    /** Optional atomic seam; production supplies a pooled transaction. */
    transaction?: <T>(fn: (tx: ModerationDataAccess) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

const EMPTY_DB: ModerationDataAccess = {
    query: async () => [],
    queryOne: async () => null,
    execute: async () => ({ affectedRows: 0 }),
};

type ModeratorRole = 'platform_moderator' | 'tenant_owner' | 'tenant_moderator';

interface ModeratorScope {
    platform: boolean;
    tenantId: string | null;
    role: ModeratorRole;
    userId: string;
}

/** Actor role label persisted in the immutable history (bounded, non-secret). */
const actorRole = (scope: ModeratorScope): string => scope.role;

class ConcurrentModerationError extends Error {}

const isDuplicateError = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

export function createModerationRouter(deps: ModerationDeps): Router {
    const router = Router();
    const now = deps.now ?? ((): Date => new Date());
    const idFactory = deps.idFactory ?? defaultModerationIdFactory;
    const notify = deps.notifyTenantOwner ?? noopModerationOwnerNotifier;
    const dataAccess = deps.db ?? EMPTY_DB;
    if (!deps.store && !deps.db) throw new Error('moderation router requires a store or db');
    if (deps.transaction && !deps.db) throw new Error('moderation transaction requires db');
    const baseStore: ModerationStore = deps.store ?? createSqlModerationStore(dataAccess);

    const runAtomic = <T>(fn: (store: ModerationStore, tx: ModerationDataAccess) => Promise<T>): Promise<T> => {
        if (deps.transaction) {
            return deps.transaction((tx) => fn(createSqlModerationStore(tx), tx));
        }
        return fn(baseStore, dataAccess);
    };

    const bestEffortNotify = async (fn: () => Promise<void>): Promise<void> => {
        try {
            await fn();
        } catch (error) {
            // A notification failure never fails the accepted mutation, and the
            // error name is never logged with any content.
            console.error('Moderation notification error:', error instanceof Error ? error.name : 'unknown');
        }
    };

    router.use(deps.authenticate);

    /* --------------------------------------------------------------------- */
    /* Scope resolution                                                       */
    /* --------------------------------------------------------------------- */
    const resolveScope = async (req: AuthRequest, res: Response): Promise<ModeratorScope | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (await deps.isPlatformModerator(user.id)) {
            return { platform: true, tenantId: null, role: 'platform_moderator', userId: user.id };
        }
        const tenantId = user.tenantId;
        if (tenantId) {
            const authority = await deps.loadActiveTenantAuthority(user.id, tenantId);
            if (authority && STAFF_AUTHORITIES.has(authority.authority)) {
                return {
                    platform: false,
                    tenantId,
                    role: authority.authority === 'owner' ? 'tenant_owner' : 'tenant_moderator',
                    userId: user.id,
                };
            }
        }
        res.status(403).json({ error: 'Moderator access required' });
        return null;
    };

    const canModerateTenant = (scope: ModeratorScope, tenantId: string): boolean =>
        scope.platform || scope.tenantId === tenantId;

    const canAccessCase = (scope: ModeratorScope, row: ModerationCaseRow): boolean =>
        canModerateTenant(scope, row.tenant_id);

    const isReviewerCandidate = async (userId: string, tenantId: string): Promise<boolean> => {
        if (await deps.isPlatformModerator(userId)) return true;
        const authority = await deps.loadActiveTenantAuthority(userId, tenantId);
        return Boolean(authority && STAFF_AUTHORITIES.has(authority.authority));
    };

    /** Load a case the caller may see, or answer 404 (never enumerate). */
    const requireCase = async (
        scope: ModeratorScope,
        rawId: unknown,
        res: Response,
    ): Promise<ModerationCaseRow | null> => {
        const caseId = normalizeModerationId(rawId);
        if (!caseId) {
            res.status(404).json({ error: 'Moderation case not found' });
            return null;
        }
        const row = await baseStore.findCaseById(caseId);
        if (!row || !canAccessCase(scope, row)) {
            res.status(404).json({ error: 'Moderation case not found' });
            return null;
        }
        return row;
    };

    const parseEnumFilter = <T extends string>(
        raw: unknown,
        allowed: readonly T[],
        label: string,
        res: Response,
    ): T | null | undefined => {
        if (raw === undefined || raw === null || raw === '') return null;
        if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
        res.status(400).json({ error: `Invalid ${label}` });
        return undefined;
    };

    const auditDecision = (
        tx: ModerationDataAccess,
        scope: ModeratorScope,
        row: ModerationCaseRow,
        input: {
            action: string;
            kind: DecisionKind;
            decision: ModerationDecision;
            reason: string;
            previous: ModerationDecision | null;
            status: ModerationCaseStatus;
        },
    ): Promise<void> =>
        deps.recordAudit(tx, {
            actorUserId: scope.userId,
            tenantId: row.tenant_id,
            action: input.action,
            resourceType: 'moderation_case',
            resourceId: row.id,
            oldValue: { decision: input.previous, status: row.status },
            newValue: { decision: input.decision, status: input.status, kind: input.kind },
            reason: input.reason,
        });

    /* --------------------------------------------------------------------- */
    /* GET /cases — queue listing                                             */
    /* --------------------------------------------------------------------- */
    router.get('/cases', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const query = req.query as Record<string, unknown>;
            const status = parseEnumFilter(query['status'], CASE_STATUSES, 'status', res);
            if (status === undefined) return;
            const targetType = parseEnumFilter<ModerationTargetType>(query['target_type'], MODERATION_TARGET_TYPES, 'target_type', res);
            if (targetType === undefined) return;
            const limit = clampListLimit(query['limit']);
            if (limit === null) return res.status(400).json({ error: 'Invalid limit' });

            let assignedReviewerUserId: string | null = null;
            if (query['assigned_to'] !== undefined && query['assigned_to'] !== '') {
                assignedReviewerUserId = normalizeModerationId(query['assigned_to']);
                if (!assignedReviewerUserId) return res.status(400).json({ error: 'Invalid assigned_to filter' });
            }

            let tenantId: string | null = scope.platform ? null : scope.tenantId;
            if (scope.platform && query['tenant_id'] !== undefined && query['tenant_id'] !== '') {
                tenantId = normalizeModerationId(query['tenant_id']);
                if (!tenantId) return res.status(400).json({ error: 'Invalid tenant_id filter' });
            }

            const rows = await baseStore.listCases({
                tenantId,
                status: status ?? null,
                targetType: targetType ?? null,
                assignedReviewerUserId,
                limit,
            });
            res.json(rows.map(projectCase));
        } catch (error) {
            console.error('List moderation cases error:', error);
            res.status(500).json({ error: 'Failed to load moderation queue' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /cases/:id — detail with history + appeal                          */
    /* --------------------------------------------------------------------- */
    router.get('/cases/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const row = await requireCase(scope, req.params.id, res);
            if (!row) return;
            const [history, appeal] = await Promise.all([
                baseStore.listHistory(row.id),
                baseStore.findAppealByCaseId(row.id),
            ]);
            res.json({
                case: projectCase(row),
                history: history.map(projectHistory),
                appeal: appeal ? projectAppeal(appeal) : null,
            });
        } catch (error) {
            console.error('Load moderation case error:', error);
            res.status(500).json({ error: 'Failed to load moderation case' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /cases — promote a report into the moderation queue               */
    /* --------------------------------------------------------------------- */
    router.post('/cases', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const validated = validateCaseOpenInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const { reportId } = validated.value;

            const report: ModerationReport | null = await deps.reports.findReportById(reportId);
            if (!report || !canModerateTenant(scope, report.tenant_id)) {
                return res.status(404).json({ error: 'Report not found' });
            }
            const evidence = await deps.content.snapshotEvidence(report.tenant_id, report.target_type, report.target_id);
            if (!evidence) return res.status(404).json({ error: 'Report target not found' });

            const existing = await baseStore.findCaseByReportId(reportId);
            if (existing) return res.status(409).json({ error: 'A case already exists for this report' });

            const id = idFactory();
            const snapshot = {
                ...evidence,
                content_hash: evidence.content_hash ?? null,
            };
            const row: ModerationCaseRow = {
                id,
                tenant_id: report.tenant_id,
                report_id: report.id,
                target_type: report.target_type,
                target_id: report.target_id,
                reporter_user_id: report.reporter_user_id,
                report_reason: report.reason,
                target_author_user_id: evidence.author_user_id ?? null,
                evidence_snapshot: snapshot,
                status: 'open',
                assigned_reviewer_user_id: null,
                assigned_at: null,
                decision: null,
                decision_reason: null,
                decided_by_user_id: null,
                decided_at: null,
                version: 0,
            };
            await runAtomic(async (store, tx) => {
                await store.insertCase(row);
                await deps.recordAudit(tx, {
                    actorUserId: scope.userId,
                    tenantId: report.tenant_id,
                    action: 'moderation.case_opened',
                    resourceType: 'moderation_case',
                    resourceId: id,
                    newValue: {
                        report_id: report.id,
                        target_type: report.target_type,
                        target_id: report.target_id,
                        content_hash: snapshot.content_hash,
                    },
                    reason: 'Report promoted to the moderation queue',
                });
            });
            res.status(201).json(projectCase({ ...row, created_at: now() }));
        } catch (error) {
            if (isDuplicateError(error)) return res.status(409).json({ error: 'A case already exists for this report' });
            console.error('Open moderation case error:', error);
            res.status(500).json({ error: 'Failed to open moderation case' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /cases/:id/assign                                                 */
    /* --------------------------------------------------------------------- */
    router.post('/cases/:id/assign', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const validated = validateAssignInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const row = await requireCase(scope, req.params.id, res);
            if (!row) return;
            if (row.status !== 'open' && row.status !== 'in_review') {
                return res.status(409).json({ error: 'Case is not assignable in its current state' });
            }
            if (!scope.platform && row.status === 'in_review' && row.assigned_reviewer_user_id !== scope.userId) {
                return res.status(403).json({ error: 'Only the assigned reviewer may reassign this case' });
            }
            const reviewerUserId = validated.value.reviewerUserId ?? scope.userId;
            if (reviewerUserId === row.reporter_user_id
                || (row.target_author_user_id && reviewerUserId === row.target_author_user_id)) {
                const selfConflict = reviewerUserId === scope.userId;
                return res.status(selfConflict ? 403 : 400).json({
                    error: 'A reporter or content author cannot be the reviewer of this case',
                });
            }
            if (!(await isReviewerCandidate(reviewerUserId, row.tenant_id))) {
                return res.status(400).json({ error: 'reviewer_user_id is not a moderator of this tenant' });
            }
            const at = now();
            const previous = row.assigned_reviewer_user_id;
            await runAtomic(async (store, tx) => {
                const affected = await store.assignCase(
                    row.id, row.tenant_id, reviewerUserId, at, previous ?? null,
                );
                if (affected === 0) throw new ConcurrentModerationError();
                await deps.recordAudit(tx, {
                    actorUserId: scope.userId,
                    tenantId: row.tenant_id,
                    action: 'moderation.case_assigned',
                    resourceType: 'moderation_case',
                    resourceId: row.id,
                    oldValue: { assigned_reviewer_user_id: previous },
                    newValue: { assigned_reviewer_user_id: reviewerUserId },
                    reason: 'Reviewer assigned',
                });
            });
            res.json(projectCase({
                ...row,
                status: 'in_review',
                assigned_reviewer_user_id: reviewerUserId,
                assigned_at: at,
            }));
        } catch (error) {
            if (error instanceof ConcurrentModerationError || isDuplicateError(error)) {
                return res.status(409).json({ error: 'Moderation case changed concurrently' });
            }
            console.error('Assign moderation case error:', error);
            res.status(500).json({ error: 'Failed to assign moderation case' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /cases/:id/decision                                               */
    /* --------------------------------------------------------------------- */
    router.post('/cases/:id/decision', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const validated = validateDecisionInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const { decision, reason } = validated.value;
            const row = await requireCase(scope, req.params.id, res);
            if (!row) return;
            if (row.status !== 'open' && row.status !== 'in_review') {
                return res.status(409).json({ error: 'Case has already been decided' });
            }
            if (row.assigned_reviewer_user_id && !scope.platform && row.assigned_reviewer_user_id !== scope.userId) {
                return res.status(403).json({ error: 'Only the assigned reviewer may decide this case' });
            }
            if (row.reporter_user_id === scope.userId) {
                return res.status(403).json({ error: 'A reviewer cannot decide a case they reported' });
            }
            if (row.target_author_user_id && row.target_author_user_id === scope.userId) {
                return res.status(403).json({ error: 'A reviewer cannot decide a case about their own content' });
            }
            await applyDecision(scope, row, decision, reason, 'decision');
            res.json(projectCase({
                ...row,
                status: 'decided',
                decision,
                decision_reason: reason,
                decided_by_user_id: scope.userId,
                decided_at: now(),
            }));
        } catch (error) {
            if (error instanceof ConcurrentModerationError || isDuplicateError(error)) {
                return res.status(409).json({ error: 'Moderation case changed concurrently' });
            }
            console.error('Record moderation decision error:', error);
            res.status(500).json({ error: 'Failed to record moderation decision' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /cases/:id/appeal — exactly one appeal per case                   */
    /* --------------------------------------------------------------------- */
    /**
     * Filing an appeal is a *party* right, not a moderator right: the report's
     * reporter or the target content's author may appeal a decided case even
     * without moderator scope. A moderator who is neither party may still see
     * the case but cannot appeal it (403); a non-party non-moderator gets 404
     * so cases cannot be enumerated.
     */
    router.post('/cases/:id/appeal', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            const validated = validateAppealInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });

            const caseId = normalizeModerationId(req.params.id);
            const row = caseId ? await baseStore.findCaseById(caseId) : null;
            if (!row) return res.status(404).json({ error: 'Moderation case not found' });

            const isReporter = row.reporter_user_id === user.id;
            const isTargetAuthor = Boolean(row.target_author_user_id) && row.target_author_user_id === user.id;
            const isModerator = await isReviewerCandidate(user.id, row.tenant_id);
            if (!isReporter && !isTargetAuthor) {
                if (!isModerator) return res.status(404).json({ error: 'Moderation case not found' });
                return res.status(403).json({ error: 'Only the reporter or the content author may appeal' });
            }
            if (row.status !== 'decided') {
                return res.status(409).json({ error: 'Only a decided case can be appealed' });
            }
            if (await baseStore.findAppealByCaseId(row.id)) {
                return res.status(409).json({ error: 'This case has already been appealed' });
            }
            const at = now();
            const appealId = idFactory();
            await runAtomic(async (store, tx) => {
                const inserted = await store.insertAppeal({
                    id: appealId,
                    case_id: row.id,
                    tenant_id: row.tenant_id,
                    appellant_user_id: user.id,
                    reason: validated.value.reason,
                    status: 'pending',
                    reviewed_by_user_id: null,
                    reviewed_at: null,
                });
                if (inserted === 0) throw new ConcurrentModerationError();
                const affected = await store.setStatus(row.id, row.tenant_id, 'appealed', at);
                if (affected === 0) throw new ConcurrentModerationError();
                await deps.recordAudit(tx, {
                    actorUserId: user.id,
                    tenantId: row.tenant_id,
                    action: 'moderation.appeal_filed',
                    resourceType: 'moderation_case',
                    resourceId: row.id,
                    oldValue: { status: row.status, decision: row.decision },
                    newValue: { status: 'appealed' },
                    reason: validated.value.reason,
                });
            });
            await bestEffortNotify(() => notify({
                case_id: row.id,
                tenant_id: row.tenant_id,
                status: 'appealed',
                kind: 'appeal_decision',
                decision: row.decision ?? 'dismiss',
                actor_user_id: user.id,
            }));
            res.status(201).json({ id: appealId, case_id: row.id, status: 'pending' });
        } catch (error) {
            if (error instanceof ConcurrentModerationError || isDuplicateError(error)) {
                return res.status(409).json({ error: 'This case has already been appealed' });
            }
            console.error('File moderation appeal error:', error);
            res.status(500).json({ error: 'Failed to file moderation appeal' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /cases/:id/appeal-decision — a different reviewer resolves it     */
    /* --------------------------------------------------------------------- */
    router.post('/cases/:id/appeal-decision', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveScope(req, res);
            if (!scope) return;
            const validated = validateDecisionInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const { decision, reason } = validated.value;
            const row = await requireCase(scope, req.params.id, res);
            if (!row) return;
            if (row.status !== 'appealed') {
                return res.status(409).json({ error: 'Case has no pending appeal' });
            }
            const appeal = await baseStore.findAppealByCaseId(row.id);
            if (!appeal) return res.status(409).json({ error: 'Case has no pending appeal' });
            if (row.decided_by_user_id === scope.userId) {
                return res.status(403).json({ error: 'The original reviewer cannot review the appeal' });
            }
            if (row.reporter_user_id === scope.userId) {
                return res.status(403).json({ error: 'A reviewer cannot review an appeal about a case they reported' });
            }
            if (appeal.appellant_user_id === scope.userId) {
                return res.status(403).json({ error: 'An appellant cannot review their own appeal' });
            }
            if (row.target_author_user_id && row.target_author_user_id === scope.userId) {
                return res.status(403).json({ error: 'A reviewer cannot review an appeal about their own content' });
            }
            await applyDecision(scope, row, decision, reason, 'appeal_decision', appeal.appellant_user_id);
            res.json({
                case: projectCase({
                    ...row,
                    status: 'closed',
                    decision,
                    decision_reason: reason,
                    decided_by_user_id: scope.userId,
                    decided_at: now(),
                }),
                appeal: { id: appeal.id, status: 'resolved' },
            });
        } catch (error) {
            if (error instanceof ConcurrentModerationError || isDuplicateError(error)) {
                return res.status(409).json({ error: 'Moderation case changed concurrently' });
            }
            console.error('Resolve moderation appeal error:', error);
            res.status(500).json({ error: 'Failed to resolve moderation appeal' });
        }
    });

    return router;

    /* --------------------------------------------------------------------- */
    /* Shared mutation: apply content action, append history, update case      */
    /* --------------------------------------------------------------------- */
    async function applyDecision(
        scope: ModeratorScope,
        row: ModerationCaseRow,
        decision: ModerationDecision,
        reason: string,
        kind: DecisionKind,
        appellantUserId?: string,
    ): Promise<void> {
        const action = contentActionForDecision(decision);
        const at = now();
        await runAtomic(async (store, tx) => {
            if (action !== 'none') {
                const affected = await deps.content.applyAction({
                    tenantId: row.tenant_id,
                    targetType: row.target_type,
                    targetId: row.target_id,
                    action,
                    reason,
                    actorUserId: scope.userId,
                    now: at,
                    db: tx,
                });
                if (affected === 0) throw new ConcurrentModerationError();
            }
            const nextStatus: ModerationCaseStatus = kind === 'appeal_decision' ? 'closed' : 'decided';
            const updated = await store.recordDecision(
                row.id, row.tenant_id, decision, reason, scope.userId, at, nextStatus,
            );
            if (updated === 0) throw new ConcurrentModerationError();
            const revision = (await store.maxRevision(row.id)) + 1;
            const appended = await store.appendHistory({
                id: idFactory(),
                case_id: row.id,
                tenant_id: row.tenant_id,
                revision_no: revision,
                kind,
                decision,
                reason,
                actor_user_id: scope.userId,
                actor_role: actorRole(scope),
            });
            if (appended === 0) throw new ConcurrentModerationError();
            if (kind === 'appeal_decision') {
                if (appellantUserId === undefined) throw new ConcurrentModerationError();
                const resolved = await store.resolveAppeal(row.id, scope.userId, at);
                if (resolved === 0) throw new ConcurrentModerationError();
            }
            await auditDecision(tx, scope, row, {
                action: kind === 'appeal_decision' ? 'moderation.appeal_decided' : 'moderation.decision_recorded',
                kind,
                decision,
                reason,
                previous: row.decision,
                status: nextStatus,
            });
        });
        await bestEffortNotify(() => notify({
            case_id: row.id,
            tenant_id: row.tenant_id,
            status: kind === 'appeal_decision' ? 'closed' : 'decided',
            kind,
            decision,
            actor_user_id: scope.userId,
        }));
    }
}

/* Production wiring: real pool, real auth, real report source, real content
   gateway, real platform/tenant moderator checks and the real sealed audit
   writer. */

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: ModerationDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never) as Promise<T[]>;
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never) as Promise<T | null>;
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const productionTransaction = async <T>(fn: (tx: ModerationDataAccess) => Promise<T>): Promise<T> => {
    const { withTransaction } = await loadDb();
    return withTransaction((connection) => fn({
        query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> => {
            const [rows] = await connection.query(sql, params as never);
            return rows as unknown as R[];
        },
        queryOne: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R | null> => {
            const [rows] = await connection.query(sql, params as never);
            return (rows as unknown as R[])[0] ?? null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            const [result] = await connection.execute(sql, params as never);
            const header = result as { insertId?: number; affectedRows?: number };
            return { insertId: header.insertId ?? 0, affectedRows: header.affectedRows ?? 0 };
        },
    }));
};

/**
 * Production content gateway: snapshots the discussion target (bounded, hashed)
 * through the real lesson-discussions store and applies moderation actions
 * through the same store. Evidence reads are tenant-bound so a target from a
 * different tenant never resolves.
 */
const productionContent: ModerationContentGateway = createModerationContentGateway(productionDb);

/**
 * Builds the content gateway over a given data access so tests can exercise the
 * exact production SQL. Every evidence read is bound to the report tenant: a
 * target id from another tenant never resolves.
 */
export function createModerationContentGateway(defaultDb: ModerationDataAccess): ModerationContentGateway {
    return {
        snapshotEvidence: async (tenantId, targetType, targetId) => {
            if (targetType === 'thread') {
                const row = await defaultDb.queryOne<{ id: string; lecture_id: string; author_user_id: string; status: string; body: string }>(
                    'SELECT id, lecture_id, author_user_id, status, body FROM lesson_discussion_threads WHERE id = ? AND tenant_id = ? LIMIT 1',
                    [targetId, tenantId],
                );
                if (!row) return null;
                return {
                    target_type: 'thread',
                    target_id: row.id,
                    lecture_id: row.lecture_id,
                    author_user_id: row.author_user_id,
                    status: row.status,
                    content_hash: hashContent(row.body),
                };
            }
            const reply = await defaultDb.queryOne<{ id: string; author_user_id: string; status: string; body: string; thread_id: string }>(
                'SELECT id, author_user_id, status, body, thread_id FROM lesson_discussion_replies WHERE id = ? AND tenant_id = ? LIMIT 1',
                [targetId, tenantId],
            );
            if (!reply) return null;
            const thread = await defaultDb.queryOne<{ lecture_id: string }>(
                'SELECT lecture_id FROM lesson_discussion_threads WHERE id = ? AND tenant_id = ? LIMIT 1',
                [reply.thread_id, tenantId],
            );
            return {
                target_type: 'reply',
                target_id: reply.id,
                lecture_id: thread?.lecture_id ?? null,
                author_user_id: reply.author_user_id,
                status: reply.status,
                content_hash: hashContent(reply.body),
            };
        },
        applyAction: async ({ tenantId, targetType, targetId, action, reason, actorUserId, now, db }) => {
            const store = createSqlLessonDiscussionsStore(db ?? defaultDb);
            if (action === 'none') return 1;
            if (targetType === 'thread') {
                if (action === 'hide') return store.setThreadStatus(tenantId, targetId, 'hidden', reason, actorUserId, now);
                if (action === 'restore') return store.setThreadStatus(tenantId, targetId, 'open', null, actorUserId, now);
                return store.softDeleteThread(tenantId, targetId, actorUserId, now, new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000));
            }
            if (action === 'hide') return store.setReplyStatus(tenantId, targetId, 'hidden', reason, actorUserId, now);
            if (action === 'restore') return store.setReplyStatus(tenantId, targetId, 'visible', null, actorUserId, now);
            return store.softDeleteReply(tenantId, targetId, actorUserId, now, new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000));
        },
    };
}

const MODERATION_PERMISSION_KEY = 'moderation.manage';

const TENANT_AUTHORITY_SQL = `
    SELECT 'owner' AS authority
    FROM tenants t
    WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
    UNION ALL
    SELECT m.role_key AS authority
    FROM tenant_memberships m
    INNER JOIN tenants t ON t.id = m.tenant_id
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
      AND t.status = 'active' AND u.is_active = 1
      AND m.role_key IN ('owner','instructor')
    LIMIT 1
`;

const REPORT_SQL = `
    SELECT id, tenant_id, target_type, target_id, reporter_user_id, reason
    FROM lesson_discussion_reports WHERE id = ? LIMIT 1
`;

export default createModerationRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    reports: {
        findReportById: async (reportId) => {
            const row = await productionDb.queryOne<ModerationReport>(REPORT_SQL, [reportId]);
            if (!row) return null;
            if (!(MODERATION_TARGET_TYPES as readonly string[]).includes(row.target_type)) return null;
            return row;
        },
    },
    content: productionContent,
    isPlatformModerator: (userId) => hasVerifiedPlatformPermission(MODERATION_PERMISSION_KEY, userId),
    loadActiveTenantAuthority: async (userId, tenantId) =>
        productionDb.queryOne<{ authority: string }>(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]),
    notifyTenantOwner: noopModerationOwnerNotifier,
    recordAudit: async (tx, input) => recordSealedAuditEvent(tx, input),
    transaction: productionTransaction,
});
