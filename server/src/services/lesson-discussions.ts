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

import { randomUUID } from 'crypto';

export const MAX_TITLE_LENGTH = 160;
export const MAX_BODY_LENGTH = 4000;
export const MAX_REASON_LENGTH = 300;
export const MAX_ID_LENGTH = 64;
export const MAX_USER_ID_LENGTH = 64;

export const DEFAULT_RETENTION_DAYS = 180;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export const THREAD_STATUSES = ['open', 'hidden', 'deleted'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export const REPLY_STATUSES = ['visible', 'hidden', 'deleted'] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];
// Existing legal `lesson_discussion_reports.status` values (migration
// 20261018_16_lesson_discussions.sql). A report is inserted `open`.
export const REPORT_STATUSES = ['open', 'reviewed', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type ModerationAction = 'hide' | 'restore' | 'delete';
export const MODERATION_ACTIONS: readonly ModerationAction[] = ['hide', 'restore', 'delete'];
export type DiscussionTargetType = 'thread' | 'reply';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Bounded opaque id (thread/reply/lecture). Returns null when malformed. */
export function normalizeDiscussionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ID_LENGTH || !ID_PATTERN.test(trimmed)) return null;
    return trimmed;
}

/** Bounded opaque identity id (author/blocker/blocked). Returns null when malformed. */
export function normalizeUserId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_USER_ID_LENGTH || !ID_PATTERN.test(trimmed)) return null;
    return trimmed;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export function normalizeRetentionDays(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_RETENTION_DAYS;
    const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
    return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, parsed));
}

/** Soft-delete retention window end. */
export function computeRetentionExpiry(now: Date, days: number): Date {
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                 */
/* ------------------------------------------------------------------------- */

export interface ValidatedThread {
    title: string;
    body: string;
    retentionDays: number;
}
export interface ValidatedReply {
    body: string;
}
export interface ValidatedModeration {
    action: ModerationAction;
    reason: string | null;
}
export interface ValidatedReport {
    targetType: DiscussionTargetType;
    targetId: string;
    reason: string;
}
export interface ValidatedBlock {
    blockedUserId: string;
}

export function normalizeModerationAction(value: unknown): ModerationAction | null {
    return typeof value === 'string' && (MODERATION_ACTIONS as readonly string[]).includes(value)
        ? (value as ModerationAction)
        : null;
}

export function parseCreateThread(body: unknown): ValidationResult<ValidatedThread> {
    const record = isRecord(body) ? body : {};
    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    const text = typeof record['body'] === 'string' ? record['body'].trim() : '';
    if (!title) return { ok: false, error: 'title is required' };
    if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `title must be at most ${MAX_TITLE_LENGTH} characters` };
    if (!text) return { ok: false, error: 'body is required' };
    if (text.length > MAX_BODY_LENGTH) return { ok: false, error: `body must be at most ${MAX_BODY_LENGTH} characters` };
    return { ok: true, value: { title, body: text, retentionDays: normalizeRetentionDays(record['retention_days']) } };
}

export function parseReply(body: unknown): ValidationResult<ValidatedReply> {
    const record = isRecord(body) ? body : {};
    const text = typeof record['body'] === 'string' ? record['body'].trim() : '';
    if (!text) return { ok: false, error: 'body is required' };
    if (text.length > MAX_BODY_LENGTH) return { ok: false, error: `body must be at most ${MAX_BODY_LENGTH} characters` };
    return { ok: true, value: { body: text } };
}

/**
 * Moderation input. `hide`/`delete` require a non-empty reason (the acceptance
 * criteria require a reason to be recorded); `restore` must not carry one.
 */
export function parseModeration(body: unknown): ValidationResult<ValidatedModeration> {
    const record = isRecord(body) ? body : {};
    const action = normalizeModerationAction(record['action']);
    if (!action) return { ok: false, error: 'action must be hide, restore or delete' };
    const rawReason = record['reason'] === undefined || record['reason'] === null ? '' : record['reason'];
    const reason = typeof rawReason === 'string' ? rawReason.trim() : null;
    if (reason === null) return { ok: false, error: 'reason must be a string' };
    if ((action === 'hide' || action === 'delete') && !reason) {
        return { ok: false, error: 'a reason is required to hide or delete' };
    }
    if (reason.length > MAX_REASON_LENGTH) return { ok: false, error: `reason must be at most ${MAX_REASON_LENGTH} characters` };
    if (action === 'restore' && reason) return { ok: false, error: 'restore must not carry a reason' };
    return { ok: true, value: { action, reason: reason || null } };
}

export function parseReport(body: unknown): ValidationResult<ValidatedReport> {
    const record = isRecord(body) ? body : {};
    const targetType = record['target_type'];
    if (targetType !== 'thread' && targetType !== 'reply') {
        return { ok: false, error: 'target_type must be thread or reply' };
    }
    const targetId = normalizeDiscussionId(record['target_id']);
    if (!targetId) return { ok: false, error: 'A valid target_id is required' };
    const reason = typeof record['reason'] === 'string' ? record['reason'].trim() : '';
    if (!reason) return { ok: false, error: 'reason is required' };
    if (reason.length > MAX_REASON_LENGTH) return { ok: false, error: `reason must be at most ${MAX_REASON_LENGTH} characters` };
    return { ok: true, value: { targetType, targetId, reason } };
}

export function parseBlock(body: unknown): ValidationResult<ValidatedBlock> {
    const record = isRecord(body) ? body : {};
    const blockedUserId = normalizeUserId(record['blocked_user_id']);
    if (!blockedUserId) return { ok: false, error: 'A valid blocked_user_id is required' };
    return { ok: true, value: { blockedUserId } };
}

/* ------------------------------------------------------------------------- */
/* Rate limiting (per user, injectable clock)                                 */
/* ------------------------------------------------------------------------- */

export interface UserRateLimiter {
    /** Consume one unit for `key`; false when the window budget is exhausted. */
    tryConsume(key: string): boolean;
}

export interface UserRateLimiterOptions {
    max: number;
    windowMs: number;
    now?: () => Date;
    /** Soft cap on tracked keys before expired entries are purged. */
    maxKeys?: number;
}

export function createUserRateLimiter(options: UserRateLimiterOptions): UserRateLimiter {
    const now = options.now ?? (() => new Date());
    const max = Math.max(1, Math.trunc(options.max));
    const windowMs = Math.max(1000, Math.trunc(options.windowMs));
    const maxKeys = options.maxKeys ?? 10_000;
    const buckets = new Map<string, { count: number; resetAt: number }>();
    return {
        tryConsume: (key) => {
            const current = now().getTime();
            if (buckets.size > maxKeys) {
                for (const [bucketKey, entry] of buckets) {
                    if (entry.resetAt <= current) buckets.delete(bucketKey);
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

/* ------------------------------------------------------------------------- */
/* Notification hook (injected; production default is a no-op)                 */
/* ------------------------------------------------------------------------- */

export interface ThreadNotification {
    thread_id: string;
    tenant_id: string;
    lecture_id: string;
    author_user_id: string;
    author_role: string;
}
export interface ReplyNotification extends ThreadNotification {
    reply_id: string;
}
export interface ModerationNotification {
    target_type: DiscussionTargetType;
    target_id: string;
    tenant_id: string;
    action: ModerationAction;
    actor_user_id: string;
    target_author_user_id: string;
}
export interface ReportNotification {
    target_type: DiscussionTargetType;
    target_id: string;
    tenant_id: string;
    reporter_user_id: string;
}

/**
 * The discussion notification seam. It carries ids and actor ids only — never
 * message bodies, contact details or any PII — so a delivery implementation can
 * enqueue templates without leaking content into logs.
 */
export interface DiscussionNotificationHook {
    onThreadCreated(event: ThreadNotification): Promise<void>;
    onReplyCreated(event: ReplyNotification): Promise<void>;
    onModerated(event: ModerationNotification): Promise<void>;
    onReported(event: ReportNotification): Promise<void>;
}

export const noopDiscussionNotificationHook: DiscussionNotificationHook = {
    onThreadCreated: async () => undefined,
    onReplyCreated: async () => undefined,
    onModerated: async () => undefined,
    onReported: async () => undefined,
};

/* ------------------------------------------------------------------------- */
/* Access contract (resolved by the route; never trusted from the client)     */
/* ------------------------------------------------------------------------- */

export interface LessonAccessPrincipal {
    id: string;
    role: string;
    tenantId: string | null;
    studentEnrollmentId?: string | null;
    branchId?: string | null;
    branchMembershipVersion?: number | null;
}

export interface LessonAccess {
    /** True only when the content-access policy allows this lesson. */
    allowed: boolean;
    /** Tenant proven from the lecture row (null when unprovable). */
    tenantId: string | null;
    /** Course the lesson belongs to (proven from the lecture row). */
    courseId: string | null;
    /** Branch derived from the lecture's server parents (null = tenant-level). */
    branchId: string | null;
    /** A branch-scoped lecture whose branch could not be proven is denied. */
    branchAmbiguous: boolean;
    /** True for verified owner/instructor/admin in the lecture tenant. */
    isStaff: boolean;
    /** The caller's own enrollment id for a student, else null. */
    enrollmentId: string | null;
}

export type LessonAccessResolver = (
    principal: LessonAccessPrincipal,
    lectureId: string,
) => Promise<LessonAccess>;

/* ------------------------------------------------------------------------- */
/* Persistence contract                                                       */
/* ------------------------------------------------------------------------- */

export interface LessonDiscussionsDb {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface ThreadRow {
    id: string;
    tenant_id: string;
    lecture_id: string;
    course_id: string;
    author_user_id: string;
    author_role: string;
    title: string;
    body: string;
    status: string;
    hidden_reason: string | null;
    moderated_by: string | null;
    moderated_at: string | Date | null;
    deleted_at: string | Date | null;
    retention_expires_at: string | Date | null;
    reply_count: number;
    last_activity_at: string | Date | null;
    version: number;
    created_at?: string | Date;
}

export interface ReplyRow {
    id: string;
    thread_id: string;
    tenant_id: string;
    author_user_id: string;
    author_role: string;
    body: string;
    status: string;
    hidden_reason: string | null;
    moderated_by: string | null;
    moderated_at: string | Date | null;
    deleted_at: string | Date | null;
    retention_expires_at: string | Date | null;
    created_at?: string | Date;
}

export interface ReportRow {
    id: string;
    tenant_id: string;
    target_type: string;
    target_id: string;
    reporter_user_id: string;
    reason: string;
    status?: string;
}

export interface BlockRow {
    id: string;
    tenant_id: string;
    blocker_user_id: string;
    blocked_user_id: string;
    created_at?: string | Date;
}

export interface LessonDiscussionsStore {
    listThreads(tenantId: string, lectureId: string, limit: number): Promise<ThreadRow[]>;
    findThreadById(threadId: string): Promise<ThreadRow | null>;
    listReplies(tenantId: string, threadId: string, limit: number): Promise<ReplyRow[]>;
    findReplyById(replyId: string): Promise<ReplyRow | null>;
    insertThread(row: ThreadRow): Promise<void>;
    /** Inserts a reply and bumps the parent thread's reply_count/activity. */
    insertReply(row: ReplyRow, activityAt: Date): Promise<void>;
    setThreadStatus(tenantId: string, threadId: string, status: ThreadStatus, reason: string | null, actorUserId: string | null, now: Date): Promise<number>;
    setReplyStatus(tenantId: string, replyId: string, status: ReplyStatus, reason: string | null, actorUserId: string | null, now: Date): Promise<number>;
    softDeleteThread(tenantId: string, threadId: string, actorUserId: string, now: Date, retentionExpiresAt: Date): Promise<number>;
    softDeleteReply(tenantId: string, replyId: string, actorUserId: string, now: Date, retentionExpiresAt: Date): Promise<number>;
    insertReport(row: ReportRow): Promise<void>;
    findBlock(tenantId: string, blockerUserId: string, blockedUserId: string): Promise<BlockRow | null>;
    listBlocks(tenantId: string, blockerUserId: string): Promise<BlockRow[]>;
    insertBlock(row: BlockRow): Promise<void>;
    deleteBlock(tenantId: string, blockerUserId: string, blockedUserId: string): Promise<number>;
}

const THREAD_COLUMNS = `id, tenant_id, lecture_id, course_id, author_user_id, author_role, title, body,
    status, hidden_reason, moderated_by, moderated_at, deleted_at, retention_expires_at,
    reply_count, last_activity_at, version, created_at`;
const REPLY_COLUMNS = `id, thread_id, tenant_id, author_user_id, author_role, body, status,
    hidden_reason, moderated_by, moderated_at, deleted_at, retention_expires_at, created_at`;

const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 200;

export function clampListLimit(raw: unknown): number | null {
    if (raw === undefined || raw === '') return DEFAULT_LIST_LIMIT;
    const parsed = Array.isArray(raw) ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    return Math.min(parsed, MAX_LIST_LIMIT);
}

/* ------------------------------------------------------------------------- */
/* Projections (route-only views; hidden/deleted bodies never leak)            */
/* ------------------------------------------------------------------------- */

const toIso = (value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** A student never sees a hidden/deleted body; staff keep the moderation view. */
export function projectThread(row: ThreadRow, includeModerated: boolean): Record<string, unknown> {
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

export function projectReply(row: ReplyRow, includeModerated: boolean): Record<string, unknown> {
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
export function isThreadVisibleToStudent(row: ThreadRow): boolean {
    return row.status === 'open' && (row.deleted_at === null || row.deleted_at === undefined);
}

export function isReplyVisibleToStudent(row: ReplyRow): boolean {
    return row.status === 'visible' && (row.deleted_at === null || row.deleted_at === undefined);
}

/* ------------------------------------------------------------------------- */
/* SQL store                                                                  */
/* ------------------------------------------------------------------------- */

export function createSqlLessonDiscussionsStore(db: LessonDiscussionsDb): LessonDiscussionsStore {
    return {
        listThreads: async (tenantId, lectureId, limit) => db.query<ThreadRow>(
            `SELECT ${THREAD_COLUMNS} FROM lesson_discussion_threads
             WHERE tenant_id = ? AND lecture_id = ? AND deleted_at IS NULL
             ORDER BY last_activity_at DESC, created_at DESC LIMIT ${Math.min(Math.max(limit, 1), MAX_LIST_LIMIT)}`,
            [tenantId, lectureId],
        ),
        findThreadById: async (threadId) => db.queryOne<ThreadRow>(
            `SELECT ${THREAD_COLUMNS} FROM lesson_discussion_threads WHERE id = ? LIMIT 1`,
            [threadId],
        ),
        listReplies: async (tenantId, threadId, limit) => db.query<ReplyRow>(
            `SELECT ${REPLY_COLUMNS} FROM lesson_discussion_replies
             WHERE tenant_id = ? AND thread_id = ? AND deleted_at IS NULL
             ORDER BY created_at ASC LIMIT ${Math.min(Math.max(limit, 1), MAX_LIST_LIMIT)}`,
            [tenantId, threadId],
        ),
        findReplyById: async (replyId) => db.queryOne<ReplyRow>(
            `SELECT ${REPLY_COLUMNS} FROM lesson_discussion_replies WHERE id = ? LIMIT 1`,
            [replyId],
        ),
        insertThread: async (row) => {
            await db.execute(
                `INSERT INTO lesson_discussion_threads
                    (id, tenant_id, lecture_id, course_id, author_user_id, author_role, title, body,
                     status, reply_count, last_activity_at, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, 0)`,
                [row.id, row.tenant_id, row.lecture_id, row.course_id, row.author_user_id,
                    row.author_role, row.title, row.body, row.last_activity_at ?? null],
            );
        },
        insertReply: async (row, activityAt) => {
            await db.execute(
                `INSERT INTO lesson_discussion_replies
                    (id, thread_id, tenant_id, author_user_id, author_role, body, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'visible')`,
                [row.id, row.thread_id, row.tenant_id, row.author_user_id, row.author_role, row.body],
            );
            await db.execute(
                `UPDATE lesson_discussion_threads
                 SET reply_count = reply_count + 1, last_activity_at = ?, version = version + 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
                [activityAt, row.tenant_id, row.thread_id],
            );
        },
        setThreadStatus: async (tenantId, threadId, status, reason, actorUserId, now) => {
            const result = await db.execute(
                `UPDATE lesson_discussion_threads
                 SET status = ?, hidden_reason = ?, moderated_by = ?, moderated_at = ?,
                     version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
                [status, reason, actorUserId, now, tenantId, threadId],
            );
            return Number(result.affectedRows ?? 0);
        },
        setReplyStatus: async (tenantId, replyId, status, reason, actorUserId, now) => {
            const result = await db.execute(
                `UPDATE lesson_discussion_replies
                 SET status = ?, hidden_reason = ?, moderated_by = ?, moderated_at = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
                [status, reason, actorUserId, now, tenantId, replyId],
            );
            return Number(result.affectedRows ?? 0);
        },
        softDeleteThread: async (tenantId, threadId, actorUserId, now, retentionExpiresAt) => {
            const result = await db.execute(
                `UPDATE lesson_discussion_threads
                 SET status = 'deleted', deleted_at = ?, moderated_by = ?, moderated_at = ?,
                     retention_expires_at = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
                [now, actorUserId, now, retentionExpiresAt, tenantId, threadId],
            );
            return Number(result.affectedRows ?? 0);
        },
        softDeleteReply: async (tenantId, replyId, actorUserId, now, retentionExpiresAt) => {
            const result = await db.execute(
                `UPDATE lesson_discussion_replies
                 SET status = 'deleted', deleted_at = ?, moderated_by = ?, moderated_at = ?,
                     retention_expires_at = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`,
                [now, actorUserId, now, retentionExpiresAt, tenantId, replyId],
            );
            return Number(result.affectedRows ?? 0);
        },
        insertReport: async (row) => {
            await db.execute(
                `INSERT INTO lesson_discussion_reports
                    (id, tenant_id, target_type, target_id, reporter_user_id, reason, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'open')`,
                [row.id, row.tenant_id, row.target_type, row.target_id, row.reporter_user_id, row.reason],
            );
        },
        findBlock: async (tenantId, blockerUserId, blockedUserId) => db.queryOne<BlockRow>(
            `SELECT id, tenant_id, blocker_user_id, blocked_user_id, created_at
             FROM lesson_discussion_blocks
             WHERE tenant_id = ? AND blocker_user_id = ? AND blocked_user_id = ? LIMIT 1`,
            [tenantId, blockerUserId, blockedUserId],
        ),
        listBlocks: async (tenantId, blockerUserId) => db.query<BlockRow>(
            `SELECT id, tenant_id, blocker_user_id, blocked_user_id, created_at
             FROM lesson_discussion_blocks
             WHERE tenant_id = ? AND blocker_user_id = ? ORDER BY created_at DESC LIMIT 500`,
            [tenantId, blockerUserId],
        ),
        insertBlock: async (row) => {
            await db.execute(
                `INSERT INTO lesson_discussion_blocks (id, tenant_id, blocker_user_id, blocked_user_id)
                 VALUES (?, ?, ?, ?)`,
                [row.id, row.tenant_id, row.blocker_user_id, row.blocked_user_id],
            );
        },
        deleteBlock: async (tenantId, blockerUserId, blockedUserId) => {
            const result = await db.execute(
                `DELETE FROM lesson_discussion_blocks
                 WHERE tenant_id = ? AND blocker_user_id = ? AND blocked_user_id = ?`,
                [tenantId, blockerUserId, blockedUserId],
            );
            return Number(result.affectedRows ?? 0);
        },
    };
}

/** The single id source, so tests can make mutations deterministic. */
export type IdFactory = () => string;
export const defaultIdFactory: IdFactory = () => randomUUID();
