/**
 * M7 O4 — content moderation domain policy.
 *
 * Pure, deterministic and clock-injected: this module validates/normalizes
 * input, owns the queue/decision/appeal state helpers, defines the injectable
 * report-source, content-gateway and owner-notification contracts, and the
 * persistence contract for the moderation queue. It never reads the request and
 * never resolves authorization: the route composes it with the verified
 * moderator scope and re-checks tenant isolation on every request.
 *
 * Security notes:
 *  - A case stores only a bounded evidence snapshot: ids, target status and a
 *    content hash. It never stores the raw thread/reply body, so no message
 *    content lands in the queue, audit or logs.
 *  - `contentActionForDecision` is the single mapping from a review decision to
 *    the content-side action an injected gateway applies.
 *  - Reviewer permission is never decided here; the route verifies tenant
 *    authority / platform permission from server rows (deny-by-default).
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

import { createHash, randomUUID } from 'crypto';


export const MAX_ID_LENGTH = 64;
export const MAX_REASON_LENGTH = 500;
export const MIN_DECISION_REASON_LENGTH = 3;
export const MAX_ACTOR_ROLE_LENGTH = 32;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_HISTORY_ROWS = 500;

export const MODERATION_TARGET_TYPES = ['thread', 'reply'] as const;
export type ModerationTargetType = (typeof MODERATION_TARGET_TYPES)[number];

export const MODERATION_DECISIONS = ['dismiss', 'hide_content', 'remove_content', 'restore_content'] as const;
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number];

export const CONTENT_ACTIONS = ['none', 'hide', 'delete', 'restore'] as const;
export type ContentAction = (typeof CONTENT_ACTIONS)[number];

export const CASE_STATUSES = ['open', 'in_review', 'decided', 'appealed', 'closed'] as const;
export type ModerationCaseStatus = (typeof CASE_STATUSES)[number];

export const DECISION_KINDS = ['decision', 'appeal_decision'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Bounded opaque id (case/report/target/user). Returns null when malformed. */
export function normalizeModerationId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ID_LENGTH || !ID_PATTERN.test(trimmed)) return null;
    return trimmed;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function isTargetType(value: unknown): value is ModerationTargetType {
    return typeof value === 'string' && (MODERATION_TARGET_TYPES as readonly string[]).includes(value);
}

function isDecision(value: unknown): value is ModerationDecision {
    return typeof value === 'string' && (MODERATION_DECISIONS as readonly string[]).includes(value);
}

export function isCaseStatus(value: unknown): value is ModerationCaseStatus {
    return typeof value === 'string' && (CASE_STATUSES as readonly string[]).includes(value);
}

/** The single decision → content-action mapping. */
export function contentActionForDecision(decision: ModerationDecision): ContentAction {
    switch (decision) {
        case 'hide_content':
            return 'hide';
        case 'remove_content':
            return 'delete';
        case 'restore_content':
            return 'restore';
        default:
            return 'none';
    }
}

/** Bounded page size for queue listings; null when the value is malformed. */
export function clampListLimit(raw: unknown): number | null {
    if (raw === undefined || raw === '') return DEFAULT_LIST_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return Math.min(parsed, MAX_LIST_LIMIT);
}

/** SHA-256 of message content, so evidence can be proven without storing it. */
export function hashContent(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = typeof value === 'string' ? value : String(value);
    if (!text) return null;
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                 */
/* ------------------------------------------------------------------------- */

export interface ValidatedCaseOpen {
    reportId: string;
}
export interface ValidatedAssignment {
    /** null means "assign to me". */
    reviewerUserId: string | null;
}
export interface ValidatedDecision {
    decision: ModerationDecision;
    reason: string;
}
export interface ValidatedAppeal {
    reason: string;
}

const normalizeReason = (raw: unknown, required: boolean): ValidationResult<string | null> => {
    if (raw === undefined || raw === null) {
        return required ? { ok: false, error: 'reason is required' } : { ok: true, value: null };
    }
    if (typeof raw !== 'string') return { ok: false, error: 'reason must be a string' };
    const reason = raw.trim();
    if (!reason) return required ? { ok: false, error: 'reason is required' } : { ok: true, value: null };
    if (reason.length > MAX_REASON_LENGTH) return { ok: false, error: `reason must be at most ${MAX_REASON_LENGTH} characters` };
    return { ok: true, value: reason };
};

export function validateCaseOpenInput(body: unknown): ValidationResult<ValidatedCaseOpen> {
    const record = isRecord(body) ? body : {};
    const reportId = normalizeModerationId(record['report_id']);
    if (!reportId) return { ok: false, error: 'A valid report_id is required' };
    return { ok: true, value: { reportId } };
}

export function validateAssignInput(body: unknown): ValidationResult<ValidatedAssignment> {
    const record = isRecord(body) ? body : {};
    if (record['reviewer_user_id'] === undefined || record['reviewer_user_id'] === null || record['reviewer_user_id'] === '') {
        return { ok: true, value: { reviewerUserId: null } };
    }
    const reviewerUserId = normalizeModerationId(record['reviewer_user_id']);
    if (!reviewerUserId) return { ok: false, error: 'reviewer_user_id must be a valid id' };
    return { ok: true, value: { reviewerUserId } };
}

export function validateDecisionInput(body: unknown): ValidationResult<ValidatedDecision> {
    const record = isRecord(body) ? body : {};
    if (!isDecision(record['decision'])) {
        return { ok: false, error: `decision must be one of ${MODERATION_DECISIONS.join(', ')}` };
    }
    const reason = normalizeReason(record['reason'], true);
    if (!reason.ok || reason.value === null) return { ok: false, error: reason.ok ? 'reason is required' : reason.error };
    if (reason.value.length < MIN_DECISION_REASON_LENGTH) {
        return { ok: false, error: `reason must be at least ${MIN_DECISION_REASON_LENGTH} characters` };
    }
    return { ok: true, value: { decision: record['decision'], reason: reason.value } };
}

export function validateAppealInput(body: unknown): ValidationResult<ValidatedAppeal> {
    const record = isRecord(body) ? body : {};
    const reason = normalizeReason(record['reason'], true);
    if (!reason.ok || reason.value === null) return { ok: false, error: reason.ok ? 'reason is required' : reason.error };
    return { ok: true, value: { reason: reason.value } };
}

/* ------------------------------------------------------------------------- */
/* Injectable seams                                                           */
/* ------------------------------------------------------------------------- */

/** The source report (owned by M6 P6; read, never mutated here). */
export interface ModerationReport {
    id: string;
    tenant_id: string;
    target_type: ModerationTargetType;
    target_id: string;
    reporter_user_id: string;
    reason: string;
}

export interface ModerationReportSource {
    findReportById(reportId: string): Promise<ModerationReport | null>;
}

/** Bounded, non-PII evidence for a report target. */
export interface EvidenceSnapshot {
    target_type: ModerationTargetType;
    target_id: string;
    lecture_id: string | null;
    author_user_id: string | null;
    status: string | null;
    content_hash: string | null;
}

export interface ApplyContentActionInput {
    tenantId: string;
    targetType: ModerationTargetType;
    targetId: string;
    action: ContentAction;
    reason: string;
    actorUserId: string;
    now: Date;
    /**
     * The data access of the surrounding decision transaction. A gateway that
     * writes to the database MUST use it so that a failed history/audit write
     * rolls the content change back with the case update.
     */
    db?: ModerationDataAccess;
}

/**
 * The content-side seam. `snapshotEvidence` returns null when the target cannot
 * be proven in server rows (the route then denies without opening a case).
 * `applyAction` returns the number of affected content rows (0 = nothing to
 * change).
 */
export interface ModerationContentGateway {
    snapshotEvidence(tenantId: string, targetType: ModerationTargetType, targetId: string): Promise<EvidenceSnapshot | null>;
    applyAction(input: ApplyContentActionInput): Promise<number>;
}

/** PII-free owner notification: ids, decision and actor only. */
export interface ModerationOwnerNotification {
    case_id: string;
    tenant_id: string;
    status: ModerationCaseStatus;
    kind: DecisionKind;
    decision: ModerationDecision;
    actor_user_id: string;
}

export type ModerationOwnerNotifier = (event: ModerationOwnerNotification) => Promise<void>;

export const noopModerationOwnerNotifier: ModerationOwnerNotifier = async () => undefined;

/* ------------------------------------------------------------------------- */
/* Persistence contract                                                       */
/* ------------------------------------------------------------------------- */

export interface ModerationCaseRow {
    id: string;
    tenant_id: string;
    report_id: string;
    target_type: ModerationTargetType;
    target_id: string;
    reporter_user_id: string;
    report_reason: string;
    target_author_user_id: string | null;
    evidence_snapshot: unknown;
    status: ModerationCaseStatus;
    assigned_reviewer_user_id: string | null;
    assigned_at: string | Date | null;
    decision: ModerationDecision | null;
    decision_reason: string | null;
    decided_by_user_id: string | null;
    decided_at: string | Date | null;
    version: number;
    created_at?: string | Date;
}

export interface ModerationHistoryRow {
    id: string;
    case_id: string;
    tenant_id: string;
    revision_no: number;
    kind: DecisionKind;
    decision: ModerationDecision;
    reason: string;
    actor_user_id: string;
    actor_role: string;
    created_at?: string | Date;
}

export interface ModerationAppealRow {
    id: string;
    case_id: string;
    tenant_id: string;
    appellant_user_id: string;
    reason: string;
    status: 'pending' | 'resolved';
    reviewed_by_user_id: string | null;
    reviewed_at: string | Date | null;
    created_at?: string | Date;
}

export interface ModerationCaseFilter {
    tenantId: string | null;
    status: ModerationCaseStatus | null;
    targetType: ModerationTargetType | null;
    assignedReviewerUserId: string | null;
    limit: number;
}

export interface ModerationStore {
    insertCase(row: ModerationCaseRow): Promise<void>;
    findCaseById(caseId: string): Promise<ModerationCaseRow | null>;
    findCaseByReportId(reportId: string): Promise<ModerationCaseRow | null>;
    listCases(filter: ModerationCaseFilter): Promise<ModerationCaseRow[]>;
    maxRevision(caseId: string): Promise<number>;
    /** Appends one immutable history row; returns affected rows (0 on a duplicate revision). */
    appendHistory(row: ModerationHistoryRow): Promise<number>;
    listHistory(caseId: string): Promise<ModerationHistoryRow[]>;
    findAppealByCaseId(caseId: string): Promise<ModerationAppealRow | null>;
    /** Inserts the single appeal; returns affected rows (0 when one already exists). */
    insertAppeal(row: ModerationAppealRow): Promise<number>;
    resolveAppeal(caseId: string, reviewerUserId: string, at: Date): Promise<number>;
    /**
     * Assigns the reviewer only while the case still has the reviewer the caller
     * read (`expectedReviewerUserId`, null = unassigned); 0 on a lost race.
     */
    assignCase(
        caseId: string,
        tenantId: string,
        reviewerUserId: string,
        at: Date,
        expectedReviewerUserId: string | null,
    ): Promise<number>;
    setStatus(caseId: string, tenantId: string, status: ModerationCaseStatus, at: Date): Promise<number>;
    recordDecision(
        caseId: string,
        tenantId: string,
        decision: ModerationDecision,
        reason: string,
        actorUserId: string,
        at: Date,
        status: ModerationCaseStatus,
    ): Promise<number>;
}

export interface ModerationDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

const CASE_COLUMNS = `id, tenant_id, report_id, target_type, target_id, reporter_user_id, report_reason,
    target_author_user_id, evidence_snapshot, status, assigned_reviewer_user_id, assigned_at,
    decision, decision_reason, decided_by_user_id, decided_at, version, created_at`;
const HISTORY_COLUMNS = `id, case_id, tenant_id, revision_no, kind, decision, reason, actor_user_id, actor_role, created_at`;
const APPEAL_COLUMNS = `id, case_id, tenant_id, appellant_user_id, reason, status, reviewed_by_user_id, reviewed_at, created_at`;

export function createSqlModerationStore(db: ModerationDataAccess): ModerationStore {
    return {
        insertCase: async (row) => {
            await db.execute(
                `INSERT INTO moderation_cases
                    (id, tenant_id, report_id, target_type, target_id, reporter_user_id, report_reason,
                     target_author_user_id, evidence_snapshot, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
                [
                    row.id, row.tenant_id, row.report_id, row.target_type, row.target_id,
                    row.reporter_user_id, row.report_reason, row.target_author_user_id,
                    row.evidence_snapshot === null || row.evidence_snapshot === undefined
                        ? null
                        : JSON.stringify(row.evidence_snapshot),
                ],
            );
        },
        findCaseById: async (caseId) => db.queryOne<ModerationCaseRow>(
            `SELECT ${CASE_COLUMNS} FROM moderation_cases WHERE id = ? LIMIT 1`, [caseId],
        ),
        findCaseByReportId: async (reportId) => db.queryOne<ModerationCaseRow>(
            `SELECT ${CASE_COLUMNS} FROM moderation_cases WHERE report_id = ? LIMIT 1`, [reportId],
        ),
        listCases: async (filter) => {
            const conditions: string[] = [];
            const params: unknown[] = [];
            if (filter.tenantId !== null) { conditions.push('tenant_id = ?'); params.push(filter.tenantId); }
            if (filter.status !== null) { conditions.push('status = ?'); params.push(filter.status); }
            if (filter.targetType !== null) { conditions.push('target_type = ?'); params.push(filter.targetType); }
            if (filter.assignedReviewerUserId !== null) {
                conditions.push('assigned_reviewer_user_id = ?');
                params.push(filter.assignedReviewerUserId);
            }
            const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
            return db.query<ModerationCaseRow>(
                `SELECT ${CASE_COLUMNS} FROM moderation_cases${where}
                 ORDER BY created_at ASC LIMIT ${Math.min(Math.max(filter.limit, 1), MAX_LIST_LIMIT)}`,
                params,
            );
        },
        maxRevision: async (caseId) => {
            const rows = await db.query<{ max_revision: number }>(
                'SELECT COALESCE(MAX(revision_no), 0) AS max_revision FROM moderation_decision_history WHERE case_id = ?',
                [caseId],
            );
            return Number(rows[0]?.max_revision ?? 0);
        },
        appendHistory: async (row) => {
            const result = await db.execute(
                `INSERT INTO moderation_decision_history
                    (id, case_id, tenant_id, revision_no, kind, decision, reason, actor_user_id, actor_role)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    row.id, row.case_id, row.tenant_id, row.revision_no, row.kind,
                    row.decision, row.reason, row.actor_user_id, row.actor_role,
                ],
            );
            return Number(result.affectedRows ?? 0);
        },
        listHistory: async (caseId) => db.query<ModerationHistoryRow>(
            `SELECT ${HISTORY_COLUMNS} FROM moderation_decision_history
             WHERE case_id = ? ORDER BY revision_no ASC LIMIT ${MAX_HISTORY_ROWS}`,
            [caseId],
        ),
        findAppealByCaseId: async (caseId) => db.queryOne<ModerationAppealRow>(
            `SELECT ${APPEAL_COLUMNS} FROM moderation_appeals WHERE case_id = ? LIMIT 1`, [caseId],
        ),
        insertAppeal: async (row) => {
            const result = await db.execute(
                `INSERT INTO moderation_appeals
                    (id, case_id, tenant_id, appellant_user_id, reason, status)
                 VALUES (?, ?, ?, ?, ?, 'pending')`,
                [row.id, row.case_id, row.tenant_id, row.appellant_user_id, row.reason],
            );
            return Number(result.affectedRows ?? 0);
        },
        resolveAppeal: async (caseId, reviewerUserId, at) => {
            const result = await db.execute(
                `UPDATE moderation_appeals
                 SET status = 'resolved', reviewed_by_user_id = ?, reviewed_at = ?
                 WHERE case_id = ? AND status = 'pending'`,
                [reviewerUserId, at, caseId],
            );
            return Number(result.affectedRows ?? 0);
        },
        assignCase: async (caseId, tenantId, reviewerUserId, at, expectedReviewerUserId) => {
            const result = await db.execute(
                `UPDATE moderation_cases
                 SET assigned_reviewer_user_id = ?, assigned_at = ?, status = 'in_review',
                     version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND tenant_id = ? AND status IN ('open','in_review')
                   AND assigned_reviewer_user_id <=> ?`,
                [reviewerUserId, at, caseId, tenantId, expectedReviewerUserId],
            );
            return Number(result.affectedRows ?? 0);
        },
        setStatus: async (caseId, tenantId, status, at) => {
            const result = await db.execute(
                `UPDATE moderation_cases
                 SET status = ?, version = version + 1, updated_at = ?
                 WHERE id = ? AND tenant_id = ?${status === 'appealed' ? " AND status = 'decided'" : ''}`,
                [status, at, caseId, tenantId],
            );
            return Number(result.affectedRows ?? 0);
        },
        recordDecision: async (caseId, tenantId, decision, reason, actorUserId, at, status) => {
            const result = await db.execute(
                `UPDATE moderation_cases
                 SET decision = ?, decision_reason = ?, decided_by_user_id = ?, decided_at = ?,
                     status = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND tenant_id = ?
                   AND status ${status === 'closed' ? "= 'appealed'" : "IN ('open','in_review')"}`,
                [decision, reason, actorUserId, at, status, caseId, tenantId],
            );
            return Number(result.affectedRows ?? 0);
        },
    };
}

/* ------------------------------------------------------------------------- */
/* Projections (never leak raw content; evidence is parsed defensively)        */
/* ------------------------------------------------------------------------- */

const toIso = (value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date
        ? value
        : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function parseEvidence(raw: unknown): EvidenceSnapshot | null {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!isRecord(value)) return null;
    if (!isTargetType(value['target_type'])) return null;
    const targetId = normalizeModerationId(value['target_id']);
    if (!targetId) return null;
    const optionalId = (key: string): string | null => normalizeModerationId(value[key]);
    const status = typeof value['status'] === 'string' ? value['status'].slice(0, 40) : null;
    const contentHash = typeof value['content_hash'] === 'string' && /^[a-f0-9]{64}$/.test(value['content_hash'])
        ? value['content_hash']
        : null;
    return {
        target_type: value['target_type'],
        target_id: targetId,
        lecture_id: optionalId('lecture_id'),
        author_user_id: optionalId('author_user_id'),
        status,
        content_hash: contentHash,
    };
}

export function projectCase(row: ModerationCaseRow): Record<string, unknown> {
    return {
        id: row.id,
        tenant_id: row.tenant_id,
        report_id: row.report_id,
        target_type: row.target_type,
        target_id: row.target_id,
        reporter_user_id: row.reporter_user_id,
        report_reason: row.report_reason,
        target_author_user_id: row.target_author_user_id ?? null,
        evidence: parseEvidence(row.evidence_snapshot),
        status: row.status,
        assigned_reviewer_user_id: row.assigned_reviewer_user_id ?? null,
        assigned_at: toIso(row.assigned_at),
        decision: row.decision ?? null,
        decision_reason: row.decision_reason ?? null,
        decided_by_user_id: row.decided_by_user_id ?? null,
        decided_at: toIso(row.decided_at),
        created_at: toIso(row.created_at),
    };
}

export function projectHistory(row: ModerationHistoryRow): Record<string, unknown> {
    return {
        id: row.id,
        revision_no: Number(row.revision_no ?? 0),
        kind: row.kind,
        decision: row.decision,
        reason: row.reason,
        actor_user_id: row.actor_user_id,
        actor_role: row.actor_role,
        created_at: toIso(row.created_at),
    };
}

export function projectAppeal(row: ModerationAppealRow): Record<string, unknown> {
    return {
        id: row.id,
        appellant_user_id: row.appellant_user_id,
        reason: row.reason,
        status: row.status,
        reviewed_by_user_id: row.reviewed_by_user_id ?? null,
        reviewed_at: toIso(row.reviewed_at),
        created_at: toIso(row.created_at),
    };
}

/** The single id source, so tests can make mutations deterministic. */
export type ModerationIdFactory = () => string;
export const defaultModerationIdFactory: ModerationIdFactory = () => randomUUID();
