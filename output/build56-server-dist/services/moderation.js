"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultModerationIdFactory = exports.noopModerationOwnerNotifier = exports.DECISION_KINDS = exports.CASE_STATUSES = exports.CONTENT_ACTIONS = exports.MODERATION_DECISIONS = exports.MODERATION_TARGET_TYPES = exports.MAX_HISTORY_ROWS = exports.DEFAULT_LIST_LIMIT = exports.MAX_LIST_LIMIT = exports.MAX_ACTOR_ROLE_LENGTH = exports.MIN_DECISION_REASON_LENGTH = exports.MAX_REASON_LENGTH = exports.MAX_ID_LENGTH = void 0;
exports.normalizeModerationId = normalizeModerationId;
exports.isCaseStatus = isCaseStatus;
exports.contentActionForDecision = contentActionForDecision;
exports.clampListLimit = clampListLimit;
exports.hashContent = hashContent;
exports.validateCaseOpenInput = validateCaseOpenInput;
exports.validateAssignInput = validateAssignInput;
exports.validateDecisionInput = validateDecisionInput;
exports.validateAppealInput = validateAppealInput;
exports.createSqlModerationStore = createSqlModerationStore;
exports.parseEvidence = parseEvidence;
exports.projectCase = projectCase;
exports.projectHistory = projectHistory;
exports.projectAppeal = projectAppeal;
const crypto_1 = require("crypto");
exports.MAX_ID_LENGTH = 64;
exports.MAX_REASON_LENGTH = 500;
exports.MIN_DECISION_REASON_LENGTH = 3;
exports.MAX_ACTOR_ROLE_LENGTH = 32;
exports.MAX_LIST_LIMIT = 100;
exports.DEFAULT_LIST_LIMIT = 50;
exports.MAX_HISTORY_ROWS = 500;
exports.MODERATION_TARGET_TYPES = ['thread', 'reply'];
exports.MODERATION_DECISIONS = ['dismiss', 'hide_content', 'remove_content', 'restore_content'];
exports.CONTENT_ACTIONS = ['none', 'hide', 'delete', 'restore'];
exports.CASE_STATUSES = ['open', 'in_review', 'decided', 'appealed', 'closed'];
exports.DECISION_KINDS = ['decision', 'appeal_decision'];
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Bounded opaque id (case/report/target/user). Returns null when malformed. */
function normalizeModerationId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > exports.MAX_ID_LENGTH || !ID_PATTERN.test(trimmed))
        return null;
    return trimmed;
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function isTargetType(value) {
    return typeof value === 'string' && exports.MODERATION_TARGET_TYPES.includes(value);
}
function isDecision(value) {
    return typeof value === 'string' && exports.MODERATION_DECISIONS.includes(value);
}
function isCaseStatus(value) {
    return typeof value === 'string' && exports.CASE_STATUSES.includes(value);
}
/** The single decision → content-action mapping. */
function contentActionForDecision(decision) {
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
function clampListLimit(raw) {
    if (raw === undefined || raw === '')
        return exports.DEFAULT_LIST_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1)
        return null;
    return Math.min(parsed, exports.MAX_LIST_LIMIT);
}
/** SHA-256 of message content, so evidence can be proven without storing it. */
function hashContent(value) {
    if (value === null || value === undefined)
        return null;
    const text = typeof value === 'string' ? value : String(value);
    if (!text)
        return null;
    return (0, crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
const normalizeReason = (raw, required) => {
    if (raw === undefined || raw === null) {
        return required ? { ok: false, error: 'reason is required' } : { ok: true, value: null };
    }
    if (typeof raw !== 'string')
        return { ok: false, error: 'reason must be a string' };
    const reason = raw.trim();
    if (!reason)
        return required ? { ok: false, error: 'reason is required' } : { ok: true, value: null };
    if (reason.length > exports.MAX_REASON_LENGTH)
        return { ok: false, error: `reason must be at most ${exports.MAX_REASON_LENGTH} characters` };
    return { ok: true, value: reason };
};
function validateCaseOpenInput(body) {
    const record = isRecord(body) ? body : {};
    const reportId = normalizeModerationId(record['report_id']);
    if (!reportId)
        return { ok: false, error: 'A valid report_id is required' };
    return { ok: true, value: { reportId } };
}
function validateAssignInput(body) {
    const record = isRecord(body) ? body : {};
    if (record['reviewer_user_id'] === undefined || record['reviewer_user_id'] === null || record['reviewer_user_id'] === '') {
        return { ok: true, value: { reviewerUserId: null } };
    }
    const reviewerUserId = normalizeModerationId(record['reviewer_user_id']);
    if (!reviewerUserId)
        return { ok: false, error: 'reviewer_user_id must be a valid id' };
    return { ok: true, value: { reviewerUserId } };
}
function validateDecisionInput(body) {
    const record = isRecord(body) ? body : {};
    if (!isDecision(record['decision'])) {
        return { ok: false, error: `decision must be one of ${exports.MODERATION_DECISIONS.join(', ')}` };
    }
    const reason = normalizeReason(record['reason'], true);
    if (!reason.ok || reason.value === null)
        return { ok: false, error: reason.ok ? 'reason is required' : reason.error };
    if (reason.value.length < exports.MIN_DECISION_REASON_LENGTH) {
        return { ok: false, error: `reason must be at least ${exports.MIN_DECISION_REASON_LENGTH} characters` };
    }
    return { ok: true, value: { decision: record['decision'], reason: reason.value } };
}
function validateAppealInput(body) {
    const record = isRecord(body) ? body : {};
    const reason = normalizeReason(record['reason'], true);
    if (!reason.ok || reason.value === null)
        return { ok: false, error: reason.ok ? 'reason is required' : reason.error };
    return { ok: true, value: { reason: reason.value } };
}
const noopModerationOwnerNotifier = async () => undefined;
exports.noopModerationOwnerNotifier = noopModerationOwnerNotifier;
const CASE_COLUMNS = `id, tenant_id, report_id, target_type, target_id, reporter_user_id, report_reason,
    target_author_user_id, evidence_snapshot, status, assigned_reviewer_user_id, assigned_at,
    decision, decision_reason, decided_by_user_id, decided_at, version, created_at`;
const HISTORY_COLUMNS = `id, case_id, tenant_id, revision_no, kind, decision, reason, actor_user_id, actor_role, created_at`;
const APPEAL_COLUMNS = `id, case_id, tenant_id, appellant_user_id, reason, status, reviewed_by_user_id, reviewed_at, created_at`;
function createSqlModerationStore(db) {
    return {
        insertCase: async (row) => {
            await db.execute(`INSERT INTO moderation_cases
                    (id, tenant_id, report_id, target_type, target_id, reporter_user_id, report_reason,
                     target_author_user_id, evidence_snapshot, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`, [
                row.id, row.tenant_id, row.report_id, row.target_type, row.target_id,
                row.reporter_user_id, row.report_reason, row.target_author_user_id,
                row.evidence_snapshot === null || row.evidence_snapshot === undefined
                    ? null
                    : JSON.stringify(row.evidence_snapshot),
            ]);
        },
        findCaseById: async (caseId) => db.queryOne(`SELECT ${CASE_COLUMNS} FROM moderation_cases WHERE id = ? LIMIT 1`, [caseId]),
        findCaseByReportId: async (reportId) => db.queryOne(`SELECT ${CASE_COLUMNS} FROM moderation_cases WHERE report_id = ? LIMIT 1`, [reportId]),
        listCases: async (filter) => {
            const conditions = [];
            const params = [];
            if (filter.tenantId !== null) {
                conditions.push('tenant_id = ?');
                params.push(filter.tenantId);
            }
            if (filter.status !== null) {
                conditions.push('status = ?');
                params.push(filter.status);
            }
            if (filter.targetType !== null) {
                conditions.push('target_type = ?');
                params.push(filter.targetType);
            }
            if (filter.assignedReviewerUserId !== null) {
                conditions.push('assigned_reviewer_user_id = ?');
                params.push(filter.assignedReviewerUserId);
            }
            const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
            return db.query(`SELECT ${CASE_COLUMNS} FROM moderation_cases${where}
                 ORDER BY created_at ASC LIMIT ${Math.min(Math.max(filter.limit, 1), exports.MAX_LIST_LIMIT)}`, params);
        },
        maxRevision: async (caseId) => {
            const rows = await db.query('SELECT COALESCE(MAX(revision_no), 0) AS max_revision FROM moderation_decision_history WHERE case_id = ?', [caseId]);
            return Number(rows[0]?.max_revision ?? 0);
        },
        appendHistory: async (row) => {
            const result = await db.execute(`INSERT INTO moderation_decision_history
                    (id, case_id, tenant_id, revision_no, kind, decision, reason, actor_user_id, actor_role)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                row.id, row.case_id, row.tenant_id, row.revision_no, row.kind,
                row.decision, row.reason, row.actor_user_id, row.actor_role,
            ]);
            return Number(result.affectedRows ?? 0);
        },
        listHistory: async (caseId) => db.query(`SELECT ${HISTORY_COLUMNS} FROM moderation_decision_history
             WHERE case_id = ? ORDER BY revision_no ASC LIMIT ${exports.MAX_HISTORY_ROWS}`, [caseId]),
        findAppealByCaseId: async (caseId) => db.queryOne(`SELECT ${APPEAL_COLUMNS} FROM moderation_appeals WHERE case_id = ? LIMIT 1`, [caseId]),
        insertAppeal: async (row) => {
            const result = await db.execute(`INSERT INTO moderation_appeals
                    (id, case_id, tenant_id, appellant_user_id, reason, status)
                 VALUES (?, ?, ?, ?, ?, 'pending')`, [row.id, row.case_id, row.tenant_id, row.appellant_user_id, row.reason]);
            return Number(result.affectedRows ?? 0);
        },
        resolveAppeal: async (caseId, reviewerUserId, at) => {
            const result = await db.execute(`UPDATE moderation_appeals
                 SET status = 'resolved', reviewed_by_user_id = ?, reviewed_at = ?
                 WHERE case_id = ? AND status = 'pending'`, [reviewerUserId, at, caseId]);
            return Number(result.affectedRows ?? 0);
        },
        assignCase: async (caseId, tenantId, reviewerUserId, at, expectedReviewerUserId) => {
            const result = await db.execute(`UPDATE moderation_cases
                 SET assigned_reviewer_user_id = ?, assigned_at = ?, status = 'in_review',
                     version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND tenant_id = ? AND status IN ('open','in_review')
                   AND assigned_reviewer_user_id <=> ?`, [reviewerUserId, at, caseId, tenantId, expectedReviewerUserId]);
            return Number(result.affectedRows ?? 0);
        },
        setStatus: async (caseId, tenantId, status, at) => {
            const result = await db.execute(`UPDATE moderation_cases
                 SET status = ?, version = version + 1, updated_at = ?
                 WHERE id = ? AND tenant_id = ?${status === 'appealed' ? " AND status = 'decided'" : ''}`, [status, at, caseId, tenantId]);
            return Number(result.affectedRows ?? 0);
        },
        recordDecision: async (caseId, tenantId, decision, reason, actorUserId, at, status) => {
            const result = await db.execute(`UPDATE moderation_cases
                 SET decision = ?, decision_reason = ?, decided_by_user_id = ?, decided_at = ?,
                     status = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND tenant_id = ?
                   AND status ${status === 'closed' ? "= 'appealed'" : "IN ('open','in_review')"}`, [decision, reason, actorUserId, at, status, caseId, tenantId]);
            return Number(result.affectedRows ?? 0);
        },
    };
}
/* ------------------------------------------------------------------------- */
/* Projections (never leak raw content; evidence is parsed defensively)        */
/* ------------------------------------------------------------------------- */
const toIso = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const date = value instanceof Date
        ? value
        : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
function parseEvidence(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    if (!isRecord(value))
        return null;
    if (!isTargetType(value['target_type']))
        return null;
    const targetId = normalizeModerationId(value['target_id']);
    if (!targetId)
        return null;
    const optionalId = (key) => normalizeModerationId(value[key]);
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
function projectCase(row) {
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
function projectHistory(row) {
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
function projectAppeal(row) {
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
const defaultModerationIdFactory = () => (0, crypto_1.randomUUID)();
exports.defaultModerationIdFactory = defaultModerationIdFactory;
