"use strict";
/**
 * M6 P6 — lesson comments and Q&A domain policy.
 *
 * Pure, deterministic and clock-injected: this module validates/normalizes
 * input, owns the retention and rate-limit primitives, defines the injectable
 * notification hook and the persistence contract, and projects persisted rows
 * for the route. It never reads the request and never resolves authorization:
 * the route composes it with the verified principal and the content-access
 * policy re-checked on every request.
 *
 * Access note: which lesson a thread/reply belongs to, and whether the caller
 * is enrolled, is NEVER decided here. The route resolves it from server rows
 * and denies by default before any of these functions run.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultIdFactory = exports.MAX_LIST_LIMIT = exports.noopDiscussionNotificationHook = exports.MODERATION_ACTIONS = exports.REPORT_STATUSES = exports.REPLY_STATUSES = exports.THREAD_STATUSES = exports.MAX_RETENTION_DAYS = exports.MIN_RETENTION_DAYS = exports.DEFAULT_RETENTION_DAYS = exports.MAX_USER_ID_LENGTH = exports.MAX_ID_LENGTH = exports.MAX_REASON_LENGTH = exports.MAX_BODY_LENGTH = exports.MAX_TITLE_LENGTH = void 0;
exports.normalizeDiscussionId = normalizeDiscussionId;
exports.normalizeUserId = normalizeUserId;
exports.normalizeRetentionDays = normalizeRetentionDays;
exports.computeRetentionExpiry = computeRetentionExpiry;
exports.normalizeModerationAction = normalizeModerationAction;
exports.parseCreateThread = parseCreateThread;
exports.parseReply = parseReply;
exports.parseModeration = parseModeration;
exports.parseReport = parseReport;
exports.parseBlock = parseBlock;
exports.createUserRateLimiter = createUserRateLimiter;
exports.clampListLimit = clampListLimit;
exports.projectThread = projectThread;
exports.projectReply = projectReply;
exports.isThreadVisibleToStudent = isThreadVisibleToStudent;
exports.isReplyVisibleToStudent = isReplyVisibleToStudent;
exports.createSqlLessonDiscussionsStore = createSqlLessonDiscussionsStore;
const crypto_1 = require("crypto");
exports.MAX_TITLE_LENGTH = 160;
exports.MAX_BODY_LENGTH = 4000;
exports.MAX_REASON_LENGTH = 300;
exports.MAX_ID_LENGTH = 64;
exports.MAX_USER_ID_LENGTH = 64;
exports.DEFAULT_RETENTION_DAYS = 180;
exports.MIN_RETENTION_DAYS = 1;
exports.MAX_RETENTION_DAYS = 3650;
exports.THREAD_STATUSES = ['open', 'hidden', 'deleted'];
exports.REPLY_STATUSES = ['visible', 'hidden', 'deleted'];
// Existing legal `lesson_discussion_reports.status` values (migration
// 20261018_16_lesson_discussions.sql). A report is inserted `open`.
exports.REPORT_STATUSES = ['open', 'reviewed', 'dismissed'];
exports.MODERATION_ACTIONS = ['hide', 'restore', 'delete'];
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Bounded opaque id (thread/reply/lecture). Returns null when malformed. */
function normalizeDiscussionId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > exports.MAX_ID_LENGTH || !ID_PATTERN.test(trimmed))
        return null;
    return trimmed;
}
/** Bounded opaque identity id (author/blocker/blocked). Returns null when malformed. */
function normalizeUserId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > exports.MAX_USER_ID_LENGTH || !ID_PATTERN.test(trimmed))
        return null;
    return trimmed;
}
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function normalizeRetentionDays(raw) {
    if (raw === undefined || raw === null || raw === '')
        return exports.DEFAULT_RETENTION_DAYS;
    const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed))
        return exports.DEFAULT_RETENTION_DAYS;
    return Math.min(exports.MAX_RETENTION_DAYS, Math.max(exports.MIN_RETENTION_DAYS, parsed));
}
/** Soft-delete retention window end. */
function computeRetentionExpiry(now, days) {
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
function normalizeModerationAction(value) {
    return typeof value === 'string' && exports.MODERATION_ACTIONS.includes(value)
        ? value
        : null;
}
function parseCreateThread(body) {
    const record = isRecord(body) ? body : {};
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const text = typeof record['body'] === 'string' ? record['body'].trim() : '';
    if (!title)
        return { ok: false, error: 'title is required' };
    if (title.length > exports.MAX_TITLE_LENGTH)
        return { ok: false, error: `title must be at most ${exports.MAX_TITLE_LENGTH} characters` };
    if (!text)
        return { ok: false, error: 'body is required' };
    if (text.length > exports.MAX_BODY_LENGTH)
        return { ok: false, error: `body must be at most ${exports.MAX_BODY_LENGTH} characters` };
    return { ok: true, value: { title, body: text, retentionDays: normalizeRetentionDays(record['retention_days']) } };
}
function parseReply(body) {
    const record = isRecord(body) ? body : {};
    const text = typeof record['body'] === 'string' ? record['body'].trim() : '';
    if (!text)
        return { ok: false, error: 'body is required' };
    if (text.length > exports.MAX_BODY_LENGTH)
        return { ok: false, error: `body must be at most ${exports.MAX_BODY_LENGTH} characters` };
    return { ok: true, value: { body: text } };
}
/**
 * Moderation input. `hide`/`delete` require a non-empty reason (the acceptance
 * criteria require a reason to be recorded); `restore` must not carry one.
 */
function parseModeration(body) {
    const record = isRecord(body) ? body : {};
    const action = normalizeModerationAction(record['action']);
    if (!action)
        return { ok: false, error: 'action must be hide, restore or delete' };
    const rawReason = record['reason'] === undefined || record['reason'] === null ? '' : record['reason'];
    const reason = typeof rawReason === 'string' ? rawReason.trim() : null;
    if (reason === null)
        return { ok: false, error: 'reason must be a string' };
    if ((action === 'hide' || action === 'delete') && !reason) {
        return { ok: false, error: 'a reason is required to hide or delete' };
    }
    if (reason.length > exports.MAX_REASON_LENGTH)
        return { ok: false, error: `reason must be at most ${exports.MAX_REASON_LENGTH} characters` };
    if (action === 'restore' && reason)
        return { ok: false, error: 'restore must not carry a reason' };
    return { ok: true, value: { action, reason: reason || null } };
}
function parseReport(body) {
    const record = isRecord(body) ? body : {};
    const targetType = record['target_type'];
    if (targetType !== 'thread' && targetType !== 'reply') {
        return { ok: false, error: 'target_type must be thread or reply' };
    }
    const targetId = normalizeDiscussionId(record['target_id']);
    if (!targetId)
        return { ok: false, error: 'A valid target_id is required' };
    const reason = typeof record['reason'] === 'string' ? record['reason'].trim() : '';
    if (!reason)
        return { ok: false, error: 'reason is required' };
    if (reason.length > exports.MAX_REASON_LENGTH)
        return { ok: false, error: `reason must be at most ${exports.MAX_REASON_LENGTH} characters` };
    return { ok: true, value: { targetType, targetId, reason } };
}
function parseBlock(body) {
    const record = isRecord(body) ? body : {};
    const blockedUserId = normalizeUserId(record['blocked_user_id']);
    if (!blockedUserId)
        return { ok: false, error: 'A valid blocked_user_id is required' };
    return { ok: true, value: { blockedUserId } };
}
function createUserRateLimiter(options) {
    const now = options.now ?? (() => new Date());
    const max = Math.max(1, Math.trunc(options.max));
    const windowMs = Math.max(1000, Math.trunc(options.windowMs));
    const maxKeys = options.maxKeys ?? 10000;
    const buckets = new Map();
    return {
        tryConsume: (key) => {
            const current = now().getTime();
            if (buckets.size > maxKeys) {
                for (const [bucketKey, entry] of buckets) {
                    if (entry.resetAt <= current)
                        buckets.delete(bucketKey);
                }
            }
            const entry = buckets.get(key);
            if (!entry || entry.resetAt <= current) {
                buckets.set(key, { count: 1, resetAt: current + windowMs });
                return true;
            }
            entry.count += 1;
            return entry.count <= max;
        },
    };
}
exports.noopDiscussionNotificationHook = {
    onThreadCreated: async () => undefined,
    onReplyCreated: async () => undefined,
    onModerated: async () => undefined,
    onReported: async () => undefined,
};
const THREAD_COLUMNS = `id, tenant_id, lecture_id, course_id, author_user_id, author_role, title, body,
    status, hidden_reason, moderated_by, moderated_at, deleted_at, retention_expires_at,
    reply_count, last_activity_at, version, created_at`;
const REPLY_COLUMNS = `id, thread_id, tenant_id, author_user_id, author_role, body, status,
    hidden_reason, moderated_by, moderated_at, deleted_at, retention_expires_at, created_at`;
const DEFAULT_LIST_LIMIT = 100;
exports.MAX_LIST_LIMIT = 200;
function clampListLimit(raw) {
    if (raw === undefined || raw === '')
        return DEFAULT_LIST_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1)
        return null;
    return Math.min(parsed, exports.MAX_LIST_LIMIT);
}
/* ------------------------------------------------------------------------- */
/* Projections (route-only views; hidden/deleted bodies never leak)            */
/* ------------------------------------------------------------------------- */
const toIso = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
/** A student never sees a hidden/deleted body; staff keep the moderation view. */
function projectThread(row, includeModerated) {
    const visible = row.status === 'open';
    return {
        id: row.id,
        lecture_id: row.lecture_id,
        course_id: row.course_id,
        author_user_id: row.author_user_id,
        author_role: row.author_role,
        title: row.title,
        body: visible || includeModerated ? row.body : null,
        status: row.status,
        reply_count: Number(row.reply_count ?? 0),
        last_activity_at: toIso(row.last_activity_at),
        created_at: toIso(row.created_at),
        hidden_reason: includeModerated ? row.hidden_reason : null,
        retention_expires_at: includeModerated ? toIso(row.retention_expires_at) : null,
    };
}
function projectReply(row, includeModerated) {
    const visible = row.status === 'visible';
    return {
        id: row.id,
        thread_id: row.thread_id,
        author_user_id: row.author_user_id,
        author_role: row.author_role,
        body: visible || includeModerated ? row.body : null,
        status: row.status,
        created_at: toIso(row.created_at),
        hidden_reason: includeModerated ? row.hidden_reason : null,
        retention_expires_at: includeModerated ? toIso(row.retention_expires_at) : null,
    };
}
/** A row is delivered to a student only when visible and not deleted. */
function isThreadVisibleToStudent(row) {
    return row.status === 'open' && (row.deleted_at === null || row.deleted_at === undefined);
}
function isReplyVisibleToStudent(row) {
    return row.status === 'visible' && (row.deleted_at === null || row.deleted_at === undefined);
}
/* ------------------------------------------------------------------------- */
/* SQL store                                                                  */
/* ------------------------------------------------------------------------- */
function createSqlLessonDiscussionsStore(db) {
    return {
        listThreads: async (tenantId, lectureId, limit) => db.query(`SELECT ${THREAD_COLUMNS} FROM lesson_discussion_threads
             WHERE tenant_id = ? AND lecture_id = ? AND deleted_at IS NULL
             ORDER BY last_activity_at DESC, created_at DESC LIMIT ${Math.min(Math.max(limit, 1), exports.MAX_LIST_LIMIT)}`, [tenantId, lectureId]),
        findThreadById: async (threadId) => db.queryOne(`SELECT ${THREAD_COLUMNS} FROM lesson_discussion_threads WHERE id = ? LIMIT 1`, [threadId]),
        listReplies: async (tenantId, threadId, limit) => db.query(`SELECT ${REPLY_COLUMNS} FROM lesson_discussion_replies
             WHERE tenant_id = ? AND thread_id = ? AND deleted_at IS NULL
             ORDER BY created_at ASC LIMIT ${Math.min(Math.max(limit, 1), exports.MAX_LIST_LIMIT)}`, [tenantId, threadId]),
        findReplyById: async (replyId) => db.queryOne(`SELECT ${REPLY_COLUMNS} FROM lesson_discussion_replies WHERE id = ? LIMIT 1`, [replyId]),
        insertThread: async (row) => {
            await db.execute(`INSERT INTO lesson_discussion_threads
                    (id, tenant_id, lecture_id, course_id, author_user_id, author_role, title, body,
                     status, reply_count, last_activity_at, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, 0)`, [row.id, row.tenant_id, row.lecture_id, row.course_id, row.author_user_id,
                row.author_role, row.title, row.body, row.last_activity_at ?? null]);
        },
        insertReply: async (row, activityAt) => {
            await db.execute(`INSERT INTO lesson_discussion_replies
                    (id, thread_id, tenant_id, author_user_id, author_role, body, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'visible')`, [row.id, row.thread_id, row.tenant_id, row.author_user_id, row.author_role, row.body]);
            await db.execute(`UPDATE lesson_discussion_threads
                 SET reply_count = reply_count + 1, last_activity_at = ?, version = version + 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, [activityAt, row.tenant_id, row.thread_id]);
        },
        setThreadStatus: async (tenantId, threadId, status, reason, actorUserId, now) => {
            const result = await db.execute(`UPDATE lesson_discussion_threads
                 SET status = ?, hidden_reason = ?, moderated_by = ?, moderated_at = ?,
                     version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, [status, reason, actorUserId, now, tenantId, threadId]);
            return Number(result.affectedRows ?? 0);
        },
        setReplyStatus: async (tenantId, replyId, status, reason, actorUserId, now) => {
            const result = await db.execute(`UPDATE lesson_discussion_replies
                 SET status = ?, hidden_reason = ?, moderated_by = ?, moderated_at = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, [status, reason, actorUserId, now, tenantId, replyId]);
            return Number(result.affectedRows ?? 0);
        },
        softDeleteThread: async (tenantId, threadId, actorUserId, now, retentionExpiresAt) => {
            const result = await db.execute(`UPDATE lesson_discussion_threads
                 SET status = 'deleted', deleted_at = ?, moderated_by = ?, moderated_at = ?,
                     retention_expires_at = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, [now, actorUserId, now, retentionExpiresAt, tenantId, threadId]);
            return Number(result.affectedRows ?? 0);
        },
        softDeleteReply: async (tenantId, replyId, actorUserId, now, retentionExpiresAt) => {
            const result = await db.execute(`UPDATE lesson_discussion_replies
                 SET status = 'deleted', deleted_at = ?, moderated_by = ?, moderated_at = ?,
                     retention_expires_at = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`, [now, actorUserId, now, retentionExpiresAt, tenantId, replyId]);
            return Number(result.affectedRows ?? 0);
        },
        insertReport: async (row) => {
            await db.execute(`INSERT INTO lesson_discussion_reports
                    (id, tenant_id, target_type, target_id, reporter_user_id, reason, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'open')`, [row.id, row.tenant_id, row.target_type, row.target_id, row.reporter_user_id, row.reason]);
        },
        findBlock: async (tenantId, blockerUserId, blockedUserId) => db.queryOne(`SELECT id, tenant_id, blocker_user_id, blocked_user_id, created_at
             FROM lesson_discussion_blocks
             WHERE tenant_id = ? AND blocker_user_id = ? AND blocked_user_id = ? LIMIT 1`, [tenantId, blockerUserId, blockedUserId]),
        listBlocks: async (tenantId, blockerUserId) => db.query(`SELECT id, tenant_id, blocker_user_id, blocked_user_id, created_at
             FROM lesson_discussion_blocks
             WHERE tenant_id = ? AND blocker_user_id = ? ORDER BY created_at DESC LIMIT 500`, [tenantId, blockerUserId]),
        insertBlock: async (row) => {
            await db.execute(`INSERT INTO lesson_discussion_blocks (id, tenant_id, blocker_user_id, blocked_user_id)
                 VALUES (?, ?, ?, ?)`, [row.id, row.tenant_id, row.blocker_user_id, row.blocked_user_id]);
        },
        deleteBlock: async (tenantId, blockerUserId, blockedUserId) => {
            const result = await db.execute(`DELETE FROM lesson_discussion_blocks
                 WHERE tenant_id = ? AND blocker_user_id = ? AND blocked_user_id = ?`, [tenantId, blockerUserId, blockedUserId]);
            return Number(result.affectedRows ?? 0);
        },
    };
}
const defaultIdFactory = () => (0, crypto_1.randomUUID)();
exports.defaultIdFactory = defaultIdFactory;
