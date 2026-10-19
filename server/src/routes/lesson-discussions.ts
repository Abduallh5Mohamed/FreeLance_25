/**
 * M6 P6 — lesson comments and Q&A routes.
 *
 * Model:
 *  - Students may read/post only inside lessons the server-side content-access
 *    policy has already released to their own enrolled workspace. Every
 *    thread/reply/report request re-resolves access from server rows through an
 *    injected `resolveLessonAccess`; a client-supplied lecture/tenant/branch is
 *    never evidence of enrollment.
 *  - Enrolled-only: a caller with no allowed access (including an unenrolled or
 *    cross-tenant caller) receives 404, so lessons/threads cannot be enumerated.
 *  - Moderation: verified tenant staff (owner/instructor/admin) may hide,
 *    restore and delete threads/replies with a recorded reason. Deletion is a
 *    soft delete carrying an explicit retention window; hidden bodies are never
 *    projected to students.
 *  - Reporting and blocking: a caller may report a thread/reply in a lesson
 *    they can access, and manage a personal block list scoped to their tenant.
 *    A block only filters visibility; it never mutates the blocked user's rows.
 *  - Notifications: an injected, PII-free hook (ids only) is called best-effort
 *    after each mutation; a failed hook never fails the request.
 *  - Rate limits: per-user, clock-injectable, bounded limiter per action.
 *
 * Mutations are audited through an injected sink wrapped by an optional
 * transaction seam (production shares one pooled connection; tests assert the
 * decision boundary). No `any`, no ts-ignore, no runtime DDL, no content in
 * logs.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { AuditRecordInput, snapshotRow } from '../security/audit';
import {
    DEFAULT_RETENTION_DAYS,
    DiscussionNotificationHook,
    IdFactory,
    LessonAccess,
    LessonAccessPrincipal,
    LessonAccessResolver,
    LessonDiscussionsStore,
    MAX_LIST_LIMIT,
    ModerationAction,
    ReplyRow,
    ReplyStatus,
    ThreadRow,
    ThreadStatus,
    UserRateLimiter,
    clampListLimit,
    computeRetentionExpiry,
    createSqlLessonDiscussionsStore,
    createUserRateLimiter,
    defaultIdFactory,
    isReplyVisibleToStudent,
    isThreadVisibleToStudent,
    noopDiscussionNotificationHook,
    normalizeDiscussionId,
    normalizeUserId,
    parseBlock,
    parseCreateThread,
    parseModeration,
    parseReply,
    parseReport,
    projectReply,
    projectThread,
} from '../services/lesson-discussions';
import { evaluateContentAccess, LessonAccessFacts } from './content-access';
import { ReleasePolicyRow, buildLessonReleasePolicy } from '../services/content-release';
import { LessonProgressDb, createLessonProgressService } from '../services/lesson-progress';
import {
    principalFromAuthUser,
    resolveResourceBranchAccess,
    getResourceBranchDeps,
} from '../security/resource-branch';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

export interface LessonDiscussionsDb {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export type DiscussionAuditSink = (input: AuditRecordInput) => Promise<void>;

export interface LessonDiscussionsDeps {
    /** Discussion-table persistence. Defaults to the SQL store over `db`. */
    store?: LessonDiscussionsStore;
    /** Raw connection used for the default store and (in production) audit. */
    db?: LessonDiscussionsDb;
    authenticate: RequestHandler;
    /** Access is ALWAYS resolved from server rows through this seam. */
    resolveLessonAccess: LessonAccessResolver;
    audit?: DiscussionAuditSink;
    notify?: DiscussionNotificationHook;
    now?: () => Date;
    idFactory?: IdFactory;
    /** Optional atomic wrapper around a mutation and its audit row. */
    transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const RATE_LIMITS = {
    thread: { max: 10, windowMs: 60_000 },
    reply: { max: 30, windowMs: 60_000 },
    report: { max: 20, windowMs: 60_000 },
    block: { max: 40, windowMs: 60_000 },
} as const;

export function createLessonDiscussionsRouter(deps: LessonDiscussionsDeps): Router {
    const router = Router();
    const now = deps.now ?? ((): Date => new Date());
    const idFactory = deps.idFactory ?? defaultIdFactory;
    const notify = deps.notify ?? noopDiscussionNotificationHook;
    const audit: DiscussionAuditSink = deps.audit ?? (async () => undefined);
    const runAtomic = deps.transaction ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
    const store: LessonDiscussionsStore = deps.store
        ?? createSqlLessonDiscussionsStore(deps.db as LessonDiscussionsDb);

    const limiters: Record<keyof typeof RATE_LIMITS, UserRateLimiter> = {
        thread: createUserRateLimiter({ ...RATE_LIMITS.thread, now }),
        reply: createUserRateLimiter({ ...RATE_LIMITS.reply, now }),
        report: createUserRateLimiter({ ...RATE_LIMITS.report, now }),
        block: createUserRateLimiter({ ...RATE_LIMITS.block, now }),
    };

    router.use(deps.authenticate);

    const principalOf = (req: AuthRequest): LessonAccessPrincipal | null => {
        const user = req.user;
        if (!user) return null;
        return {
            id: user.id,
            role: user.role,
            tenantId: user.tenantId ?? null,
            studentEnrollmentId: user.studentEnrollmentId ?? null,
            branchId: user.branchId ?? null,
            branchMembershipVersion: user.branchMembershipVersion ?? null,
        };
    };

    /** Resolve access or write the denial; returns null when the response is done. */
    const requireAccess = async (
        req: AuthRequest,
        res: Response,
        lectureId: string,
    ): Promise<LessonAccess | null> => {
        const principal = principalOf(req);
        if (!principal) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        const access = await deps.resolveLessonAccess(principal, lectureId);
        if (!access.allowed || !access.tenantId) {
            res.status(404).json({ error: 'Lesson not found' });
            return null;
        }
        if (access.branchAmbiguous) {
            res.status(403).json({ error: 'Forbidden', code: 'BRANCH_CONTEXT_DENIED' });
            return null;
        }
        return access;
    };

    const rateLimit = (res: Response, tier: keyof typeof RATE_LIMITS, principal: LessonAccessPrincipal): boolean => {
        if (limiters[tier].tryConsume(`${principal.id}:${tier}`)) return true;
        res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return false;
    };

    /** Personal block set for the caller inside one tenant (bounded). */
    const blockedAuthors = async (tenantId: string, userId: string): Promise<Set<string>> => {
        const rows = await store.listBlocks(tenantId, userId);
        return new Set(rows.map((row) => row.blocked_user_id));
    };

    const bestEffort = async (fn: () => Promise<void>): Promise<void> => {
        try {
            await fn();
        } catch (error) {
            // A notification failure never fails the accepted mutation, and the
            // error is never logged with message content.
            console.error('Lesson discussion notification error:', error instanceof Error ? error.name : 'unknown');
        }
    };

    /* --------------------------------------------------------------------- */
    /* GET /lessons/:lectureId/threads                                        */
    /* --------------------------------------------------------------------- */
    router.get('/lessons/:lectureId/threads', async (req: AuthRequest, res: Response) => {
        try {
            const lectureId = normalizeDiscussionId(req.params.lectureId);
            if (!lectureId) return res.status(404).json({ error: 'Lesson not found' });
            const limit = clampListLimit(req.query.limit);
            if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
            const access = await requireAccess(req, res, lectureId);
            if (!access) return;

            const rows = await store.listThreads(access.tenantId as string, lectureId, limit);
            const blocked = await blockedAuthors(access.tenantId as string, (req.user as { id: string }).id);
            const visible = access.isStaff ? rows : rows.filter(isThreadVisibleToStudent);
            res.json(visible
                .filter((row) => !blocked.has(row.author_user_id))
                .map((row) => projectThread(row, access.isStaff)));
        } catch (error) {
            console.error('List discussion threads error:', error);
            res.status(500).json({ error: 'Failed to load discussion' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /lessons/:lectureId/threads                                       */
    /* --------------------------------------------------------------------- */
    router.post('/lessons/:lectureId/threads', async (req: AuthRequest, res: Response) => {
        try {
            const lectureId = normalizeDiscussionId(req.params.lectureId);
            if (!lectureId) return res.status(404).json({ error: 'Lesson not found' });
            const access = await requireAccess(req, res, lectureId);
            if (!access) return;
            const principal = principalOf(req) as LessonAccessPrincipal;
            if (!rateLimit(res, 'thread', principal)) return;

            const validated = parseCreateThread(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const value = validated.value;
            const createdAt = now();
            const id = idFactory();
            const row: ThreadRow = {
                id,
                tenant_id: access.tenantId as string,
                lecture_id: lectureId,
                course_id: access.courseId ?? '',
                author_user_id: principal.id,
                author_role: principal.role,
                title: value.title,
                body: value.body,
                status: 'open',
                hidden_reason: null,
                moderated_by: null,
                moderated_at: null,
                deleted_at: null,
                retention_expires_at: null,
                reply_count: 0,
                last_activity_at: createdAt,
                version: 0,
            };
            await runAtomic(async () => {
                await store.insertThread(row);
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: 'thread.create',
                    resourceType: 'lesson_discussion_thread',
                    resourceId: id,
                    newValue: snapshotRow({ lecture_id: lectureId, title: value.title }),
                });
            });
            await bestEffort(() => notify.onThreadCreated({
                thread_id: id,
                tenant_id: access.tenantId as string,
                lecture_id: lectureId,
                author_user_id: principal.id,
                author_role: principal.role,
            }));
            res.status(201).json(projectThread({ ...row, created_at: createdAt }, principal.role !== 'student'));
        } catch (error) {
            console.error('Create discussion thread error:', error);
            res.status(500).json({ error: 'Failed to create discussion thread' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /threads/:threadId — thread + replies                              */
    /* --------------------------------------------------------------------- */
    router.get('/threads/:threadId', async (req: AuthRequest, res: Response) => {
        try {
            const threadId = normalizeDiscussionId(req.params.threadId);
            if (!threadId) return res.status(404).json({ error: 'Thread not found' });
            const thread = await store.findThreadById(threadId);
            if (!thread) return res.status(404).json({ error: 'Thread not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access) return;
            if (thread.tenant_id !== access.tenantId) return res.status(404).json({ error: 'Thread not found' });
            if (!access.isStaff && !isThreadVisibleToStudent(thread)) {
                return res.status(404).json({ error: 'Thread not found' });
            }

            const limit = clampListLimit(req.query.limit);
            if (limit === null) return res.status(400).json({ error: 'Invalid limit' });
            const principal = principalOf(req) as LessonAccessPrincipal;
            const blocked = await blockedAuthors(access.tenantId as string, principal.id);
            const replies = await store.listReplies(access.tenantId as string, threadId, limit);
            const visibleReplies = (access.isStaff ? replies : replies.filter(isReplyVisibleToStudent))
                .filter((row) => !blocked.has(row.author_user_id));
            res.json({
                thread: projectThread(thread, access.isStaff),
                replies: visibleReplies.map((row) => projectReply(row, access.isStaff)),
            });
        } catch (error) {
            console.error('Load discussion thread error:', error);
            res.status(500).json({ error: 'Failed to load thread' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /threads/:threadId/replies                                        */
    /* --------------------------------------------------------------------- */
    router.post('/threads/:threadId/replies', async (req: AuthRequest, res: Response) => {
        try {
            const threadId = normalizeDiscussionId(req.params.threadId);
            if (!threadId) return res.status(404).json({ error: 'Thread not found' });
            const validated = parseReply(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const thread = await store.findThreadById(threadId);
            if (!thread) return res.status(404).json({ error: 'Thread not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access) return;
            if (thread.tenant_id !== access.tenantId) return res.status(404).json({ error: 'Thread not found' });
            if (!access.isStaff && !isThreadVisibleToStudent(thread)) {
                return res.status(404).json({ error: 'Thread not found' });
            }
            const principal = principalOf(req) as LessonAccessPrincipal;
            if (!rateLimit(res, 'reply', principal)) return;

            const createdAt = now();
            const id = idFactory();
            const row: ReplyRow = {
                id,
                thread_id: threadId,
                tenant_id: access.tenantId as string,
                author_user_id: principal.id,
                author_role: principal.role,
                body: validated.value.body,
                status: 'visible',
                hidden_reason: null,
                moderated_by: null,
                moderated_at: null,
                deleted_at: null,
                retention_expires_at: null,
            };
            await runAtomic(async () => {
                await store.insertReply(row, createdAt);
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: 'reply.create',
                    resourceType: 'lesson_discussion_reply',
                    resourceId: id,
                    newValue: snapshotRow({ thread_id: threadId }),
                });
            });
            await bestEffort(() => notify.onReplyCreated({
                thread_id: threadId,
                reply_id: id,
                tenant_id: access.tenantId as string,
                lecture_id: thread.lecture_id,
                author_user_id: principal.id,
                author_role: principal.role,
            }));
            res.status(201).json(projectReply({ ...row, created_at: createdAt }, principal.role !== 'student'));
        } catch (error) {
            console.error('Create discussion reply error:', error);
            res.status(500).json({ error: 'Failed to create reply' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* DELETE /threads/:threadId — author or staff soft delete               */
    /* --------------------------------------------------------------------- */
    router.delete('/threads/:threadId', async (req: AuthRequest, res: Response) => {
        try {
            const threadId = normalizeDiscussionId(req.params.threadId);
            if (!threadId) return res.status(404).json({ error: 'Thread not found' });
            const thread = await store.findThreadById(threadId);
            if (!thread) return res.status(404).json({ error: 'Thread not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access) return;
            if (thread.tenant_id !== access.tenantId) return res.status(404).json({ error: 'Thread not found' });
            const principal = principalOf(req) as LessonAccessPrincipal;
            if (!access.isStaff && thread.author_user_id !== principal.id) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (thread.deleted_at) return res.status(409).json({ error: 'Thread is already deleted' });

            const deletedAt = now();
            const retentionExpiresAt = computeRetentionExpiry(deletedAt, DEFAULT_RETENTION_DAYS);
            const affected = await runAtomic(async () => {
                const count = await store.softDeleteThread(
                    access.tenantId as string, threadId, principal.id, deletedAt, retentionExpiresAt,
                );
                if (count > 0) {
                    await audit({
                        actorUserId: principal.id,
                        tenantId: access.tenantId,
                        action: 'thread.delete',
                        resourceType: 'lesson_discussion_thread',
                        resourceId: threadId,
                        oldValue: snapshotRow({ status: thread.status, author_user_id: thread.author_user_id }),
                        newValue: snapshotRow({ status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() }),
                    });
                }
                return count;
            });
            if (affected === 0) return res.status(409).json({ error: 'Thread is already deleted' });
            res.json({ id: threadId, status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() });
        } catch (error) {
            console.error('Delete discussion thread error:', error);
            res.status(500).json({ error: 'Failed to delete thread' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* DELETE /replies/:replyId — author or staff soft delete                */
    /* --------------------------------------------------------------------- */
    router.delete('/replies/:replyId', async (req: AuthRequest, res: Response) => {
        try {
            const replyId = normalizeDiscussionId(req.params.replyId);
            if (!replyId) return res.status(404).json({ error: 'Reply not found' });
            const reply = await store.findReplyById(replyId);
            if (!reply) return res.status(404).json({ error: 'Reply not found' });
            const thread = await store.findThreadById(reply.thread_id);
            if (!thread) return res.status(404).json({ error: 'Reply not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access) return;
            if (reply.tenant_id !== access.tenantId) return res.status(404).json({ error: 'Reply not found' });
            const principal = principalOf(req) as LessonAccessPrincipal;
            if (!access.isStaff && reply.author_user_id !== principal.id) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (reply.deleted_at) return res.status(409).json({ error: 'Reply is already deleted' });

            const deletedAt = now();
            const retentionExpiresAt = computeRetentionExpiry(deletedAt, DEFAULT_RETENTION_DAYS);
            const affected = await runAtomic(async () => {
                const count = await store.softDeleteReply(
                    access.tenantId as string, replyId, principal.id, deletedAt, retentionExpiresAt,
                );
                if (count > 0) {
                    await audit({
                        actorUserId: principal.id,
                        tenantId: access.tenantId,
                        action: 'reply.delete',
                        resourceType: 'lesson_discussion_reply',
                        resourceId: replyId,
                        oldValue: snapshotRow({ status: reply.status, author_user_id: reply.author_user_id }),
                        newValue: snapshotRow({ status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() }),
                    });
                }
                return count;
            });
            if (affected === 0) return res.status(409).json({ error: 'Reply is already deleted' });
            res.json({ id: replyId, status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() });
        } catch (error) {
            console.error('Delete discussion reply error:', error);
            res.status(500).json({ error: 'Failed to delete reply' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* Moderation: staff hide/restore/delete with a recorded reason           */
    /* --------------------------------------------------------------------- */
    const moderateThread = async (req: AuthRequest, res: Response): Promise<void> => {
        const threadId = normalizeDiscussionId(req.params.threadId);
        if (!threadId) return void res.status(404).json({ error: 'Thread not found' });
        const validated = parseModeration(req.body);
        if (!validated.ok) return void res.status(400).json({ error: validated.error });
        const thread = await store.findThreadById(threadId);
        if (!thread) return void res.status(404).json({ error: 'Thread not found' });
        const access = await requireAccess(req, res, thread.lecture_id);
        if (!access) return;
        if (thread.tenant_id !== access.tenantId) return void res.status(404).json({ error: 'Thread not found' });
        if (!access.isStaff) return void res.status(403).json({ error: 'Moderator access required' });
        if (thread.deleted_at) return void res.status(409).json({ error: 'A deleted thread cannot be moderated' });

        const principal = principalOf(req) as LessonAccessPrincipal;
        const { action, reason } = validated.value;
        const status = moderationThreadStatus(action);
        const at = now();
        const affected = await runAtomic(async () => {
            const count = await store.setThreadStatus(
                access.tenantId as string, threadId, status, reason, principal.id, at,
            );
            if (count > 0) {
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: `thread.moderate.${action}`,
                    resourceType: 'lesson_discussion_thread',
                    resourceId: threadId,
                    oldValue: snapshotRow({ status: thread.status }),
                    newValue: snapshotRow({ status, hidden_reason: reason }),
                    reason: reason ?? undefined,
                });
            }
            return count;
        });
        if (affected === 0) return void res.status(409).json({ error: 'Thread state changed concurrently' });
        await bestEffort(() => notify.onModerated({
            target_type: 'thread', target_id: threadId, tenant_id: access.tenantId as string,
            action, actor_user_id: principal.id, target_author_user_id: thread.author_user_id,
        }));
        res.json({ id: threadId, status, hidden_reason: reason });
    };

    const moderateReply = async (req: AuthRequest, res: Response): Promise<void> => {
        const replyId = normalizeDiscussionId(req.params.replyId);
        if (!replyId) return void res.status(404).json({ error: 'Reply not found' });
        const validated = parseModeration(req.body);
        if (!validated.ok) return void res.status(400).json({ error: validated.error });
        const reply = await store.findReplyById(replyId);
        if (!reply) return void res.status(404).json({ error: 'Reply not found' });
        const thread = await store.findThreadById(reply.thread_id);
        if (!thread) return void res.status(404).json({ error: 'Reply not found' });
        const access = await requireAccess(req, res, thread.lecture_id);
        if (!access) return;
        if (reply.tenant_id !== access.tenantId) return void res.status(404).json({ error: 'Reply not found' });
        if (!access.isStaff) return void res.status(403).json({ error: 'Moderator access required' });
        if (reply.deleted_at) return void res.status(409).json({ error: 'A deleted reply cannot be moderated' });

        const principal = principalOf(req) as LessonAccessPrincipal;
        const { action, reason } = validated.value;
        const status = moderationReplyStatus(action);
        const at = now();
        const affected = await runAtomic(async () => {
            const count = await store.setReplyStatus(
                access.tenantId as string, replyId, status, reason, principal.id, at,
            );
            if (count > 0) {
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: `reply.moderate.${action}`,
                    resourceType: 'lesson_discussion_reply',
                    resourceId: replyId,
                    oldValue: snapshotRow({ status: reply.status }),
                    newValue: snapshotRow({ status, hidden_reason: reason }),
                    reason: reason ?? undefined,
                });
            }
            return count;
        });
        if (affected === 0) return void res.status(409).json({ error: 'Reply state changed concurrently' });
        await bestEffort(() => notify.onModerated({
            target_type: 'reply', target_id: replyId, tenant_id: access.tenantId as string,
            action, actor_user_id: principal.id, target_author_user_id: reply.author_user_id,
        }));
        res.json({ id: replyId, status, hidden_reason: reason });
    };

    router.post('/threads/:threadId/moderate', (req, res) => {
        moderateThread(req as AuthRequest, res).catch((error) => {
            console.error('Moderate discussion thread error:', error);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to moderate thread' });
        });
    });

    router.post('/replies/:replyId/moderate', (req, res) => {
        moderateReply(req as AuthRequest, res).catch((error) => {
            console.error('Moderate discussion reply error:', error);
            if (!res.headersSent) res.status(500).json({ error: 'Failed to moderate reply' });
        });
    });

    /* --------------------------------------------------------------------- */
    /* POST /reports — report a thread/reply in an accessible lesson          */
    /* --------------------------------------------------------------------- */
    router.post('/reports', async (req: AuthRequest, res: Response) => {
        try {
            const validated = parseReport(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const { targetType, targetId, reason } = validated.value;

            let tenantId: string | null = null;
            let lectureId: string | null = null;
            let authorUserId: string | null = null;
            if (targetType === 'thread') {
                const thread = await store.findThreadById(targetId);
                if (thread) {
                    tenantId = thread.tenant_id;
                    lectureId = thread.lecture_id;
                    authorUserId = thread.author_user_id;
                }
            } else {
                const reply = await store.findReplyById(targetId);
                if (reply) {
                    tenantId = reply.tenant_id;
                    authorUserId = reply.author_user_id;
                    const thread = await store.findThreadById(reply.thread_id);
                    lectureId = thread ? thread.lecture_id : null;
                }
            }
            if (!tenantId || !lectureId) return res.status(404).json({ error: 'Report target not found' });

            const access = await requireAccess(req, res, lectureId);
            if (!access) return;
            if (tenantId !== access.tenantId) return res.status(404).json({ error: 'Report target not found' });
            const principal = principalOf(req) as LessonAccessPrincipal;
            if (!rateLimit(res, 'report', principal)) return;
            if (authorUserId === principal.id) {
                return res.status(400).json({ error: 'You cannot report your own content' });
            }

            const id = idFactory();
            await runAtomic(async () => {
                await store.insertReport({
                    id, tenant_id: access.tenantId as string, target_type: targetType,
                    target_id: targetId, reporter_user_id: principal.id, reason,
                });
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: 'discussion.report',
                    resourceType: `lesson_discussion_${targetType}`,
                    resourceId: targetId,
                    newValue: snapshotRow({ reason }),
                });
            });
            await bestEffort(() => notify.onReported({
                target_type: targetType, target_id: targetId,
                tenant_id: access.tenantId as string, reporter_user_id: principal.id,
            }));
            res.status(201).json({ id, target_type: targetType, target_id: targetId, status: 'open' });
        } catch (error) {
            console.error('Report discussion target error:', error);
            res.status(500).json({ error: 'Failed to submit report' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* Block list (personal, tenant-scoped)                                   */
    /* --------------------------------------------------------------------- */
    router.get('/blocks', async (req: AuthRequest, res: Response) => {
        try {
            const principal = principalOf(req);
            if (!principal) return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
            const rows = await store.listBlocks(principal.tenantId, principal.id);
            res.json(rows.map((row) => ({ blocked_user_id: row.blocked_user_id, created_at: row.created_at ?? null })));
        } catch (error) {
            console.error('List discussion blocks error:', error);
            res.status(500).json({ error: 'Failed to load blocks' });
        }
    });

    router.post('/blocks', async (req: AuthRequest, res: Response) => {
        try {
            const principal = principalOf(req);
            if (!principal) return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
            if (!rateLimit(res, 'block', principal)) return;
            const validated = parseBlock(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });
            const blockedUserId = validated.value.blockedUserId;
            if (blockedUserId === principal.id) return res.status(400).json({ error: 'You cannot block yourself' });

            const existing = await store.findBlock(principal.tenantId, principal.id, blockedUserId);
            if (existing) return res.json({ blocked_user_id: blockedUserId, created: false });
            const id = idFactory();
            await runAtomic(async () => {
                await store.insertBlock({
                    id, tenant_id: principal.tenantId as string,
                    blocker_user_id: principal.id, blocked_user_id: blockedUserId,
                });
                await audit({
                    actorUserId: principal.id,
                    tenantId: principal.tenantId,
                    action: 'discussion.block',
                    resourceType: 'lesson_discussion_block',
                    resourceId: blockedUserId,
                });
            });
            res.status(201).json({ blocked_user_id: blockedUserId, created: true });
        } catch (error) {
            console.error('Create discussion block error:', error);
            res.status(500).json({ error: 'Failed to block user' });
        }
    });

    router.delete('/blocks/:blockedUserId', async (req: AuthRequest, res: Response) => {
        try {
            const principal = principalOf(req);
            if (!principal) return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
            const blockedUserId = normalizeUserId(req.params.blockedUserId);
            if (!blockedUserId) return res.status(400).json({ error: 'Invalid blocked_user_id' });
            const removed = await runAtomic(async () => {
                const count = await store.deleteBlock(principal.tenantId as string, principal.id, blockedUserId);
                if (count > 0) {
                    await audit({
                        actorUserId: principal.id,
                        tenantId: principal.tenantId,
                        action: 'discussion.unblock',
                        resourceType: 'lesson_discussion_block',
                        resourceId: blockedUserId,
                    });
                }
                return count;
            });
            res.json({ blocked_user_id: blockedUserId, removed: removed > 0 });
        } catch (error) {
            console.error('Delete discussion block error:', error);
            res.status(500).json({ error: 'Failed to unblock user' });
        }
    });

    return router;
}

function moderationThreadStatus(action: ModerationAction): ThreadStatus {
    return action === 'hide' ? 'hidden' : action === 'delete' ? 'deleted' : 'open';
}

function moderationReplyStatus(action: ModerationAction): ReplyStatus {
    return action === 'hide' ? 'hidden' : action === 'delete' ? 'deleted' : 'visible';
}

/* ------------------------------------------------------------------------- */
/* Production wiring                                                          */
/* ------------------------------------------------------------------------- */

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: LessonDiscussionsDb = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const ACCESS_LECTURE_SQL = `
    SELECT l.id, l.course_id, l.instructor_id, l.group_id, l.grade_id,
           l.title, l.description, l.video_url, l.duration_minutes, l.is_free,
           l.is_published, l.display_order, l.archived_at, c.tenant_id,
           g.branch_id AS group_branch_id, g.branch_scope AS group_branch_scope
    FROM lectures l
    INNER JOIN courses c ON c.id = l.course_id
    LEFT JOIN \`groups\` g ON g.id = l.group_id
    WHERE l.id = ?
`;

const ACCESS_ENROLLMENT_SQL = `
    SELECT s.id, s.tenant_id, s.instructor_id, s.group_id, s.grade_id,
           g.branch_id AS group_branch_id, g.branch_scope AS group_branch_scope
    FROM students s
    INNER JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN \`groups\` g ON g.id = s.group_id
    WHERE s.id = ? AND s.user_id = ? AND s.is_active = 1 AND s.approval_status = 'approved' AND t.status = 'active'
      AND (s.enrollment_status IS NULL OR s.enrollment_status = 'active')
      AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date <= UTC_TIMESTAMP())
      AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date > UTC_TIMESTAMP())
    LIMIT 1
`;

const ACCESS_POLICY_SQL = `
    SELECT lecture_id, course_id, tenant_id, release_mode, release_at, release_timezone,
           prerequisite_lecture_id, released_at
    FROM lesson_release_policies WHERE lecture_id = ? LIMIT 1
`;

interface AccessLectureRow {
    id: string;
    course_id: string;
    instructor_id: string | null;
    group_id: string | null;
    grade_id: string | null;
    is_published: boolean | number;
    display_order: number | null;
    archived_at: string | Date | null;
    tenant_id: string;
    group_branch_id: string | null;
    group_branch_scope: string | null;
}

interface AccessEnrollmentRow {
    id: string;
    tenant_id: string;
    instructor_id: string | null;
    group_id: string | null;
    grade_id: string | null;
    group_branch_id: string | null;
    group_branch_scope: string | null;
}

function deriveAccessBranch(scope: string | null, branchId: string | null): { branchId: string | null; ambiguous: boolean } {
    const normalized = (scope ?? '').trim().toLowerCase();
    if (normalized === 'branch') {
        return branchId ? { branchId, ambiguous: false } : { branchId: null, ambiguous: true };
    }
    return { branchId: null, ambiguous: false };
}

function accessLectureFacts(lecture: AccessLectureRow): LessonAccessFacts['lecture'] {
    const branch = deriveAccessBranch(lecture.group_branch_scope, lecture.group_branch_id);
    return {
        tenantId: lecture.tenant_id,
        instructorId: lecture.instructor_id,
        groupId: lecture.group_id,
        gradeId: lecture.grade_id,
        branchId: branch.branchId,
        branchAmbiguous: branch.ambiguous,
        isPublished: Boolean(lecture.is_published),
        archived: lecture.archived_at !== null && lecture.archived_at !== undefined,
        displayOrder: Number(lecture.display_order ?? 0),
    };
}

function accessEnrollmentFacts(enrollment: AccessEnrollmentRow): LessonAccessFacts['enrollment'] {
    const branch = deriveAccessBranch(enrollment.group_branch_scope, enrollment.group_branch_id);
    return {
        id: enrollment.id,
        tenantId: enrollment.tenant_id,
        instructorId: enrollment.instructor_id,
        groupId: enrollment.group_id,
        gradeId: enrollment.grade_id,
        branchId: branch.branchId,
    };
}

const DENIED_ACCESS: LessonAccess = {
    allowed: false, tenantId: null, courseId: null, branchId: null,
    branchAmbiguous: false, isStaff: false, enrollmentId: null,
};

/**
 * H1: the platform capability that authorizes cross-tenant discussion reach.
 * It is the same verified "platform operator" tier used by resource-derived
 * branch access (`security.manage`/super admin), never a bare role label.
 */
const LESSON_PLATFORM_PERMISSION_KEY = 'security.manage';

/**
 * H1: tenant reach for a non-student principal. A principal may only act on a
 * lesson inside its own server-derived tenant; cross-tenant reach is granted
 * solely by a *verified* platform capability, never by a `role` label such as
 * `admin`. The capability lookup is injected so the decision boundary is
 * testable without a database; production passes
 * `hasVerifiedPlatformPermission`.
 */
export const hasLessonTenantReach = async (
    principal: Pick<LessonAccessPrincipal, 'id' | 'tenantId'>,
    lectureTenantId: string,
    hasPlatformCapability: (userId: string) => Promise<boolean>,
): Promise<boolean> => {
    if (principal.tenantId && principal.tenantId === lectureTenantId) return true;
    return hasPlatformCapability(principal.id);
};

/**
 * Production access resolver. Reuses the composed content-access policy so the
 * lesson must be published, in the caller's enrolled audience/branch, and
 * released (immediate/scheduled/sequential) before any discussion is served.
 * A non-student principal reaches a lesson only inside its own server-derived
 * tenant; cross-tenant reach requires a verified platform capability and never
 * a `role` label. Nothing from the request body participates.
 */
export async function resolveProductionLessonAccess(
    principal: LessonAccessPrincipal,
    lectureId: string,
): Promise<LessonAccess> {
    const { query, queryOne, execute } = await loadDb();
    const lecture = await queryOne<AccessLectureRow>(ACCESS_LECTURE_SQL, [lectureId]);
    if (!lecture) return DENIED_ACCESS;
    const branch = deriveAccessBranch(lecture.group_branch_scope, lecture.group_branch_id);
    const base = {
        tenantId: lecture.tenant_id,
        courseId: lecture.course_id,
        branchId: branch.branchId,
        branchAmbiguous: branch.ambiguous,
    };

    if (principal.role !== 'student') {
        const reach = await hasLessonTenantReach(
            principal,
            lecture.tenant_id,
            (userId) => hasVerifiedPlatformPermission(LESSON_PLATFORM_PERMISSION_KEY, userId),
        );
        if (!reach) return DENIED_ACCESS;
        const decision = await resolveResourceBranchAccess(
            getResourceBranchDeps(),
            principalFromAuthUser({
                id: principal.id,
                role: principal.role,
                tenantId: principal.tenantId,
                branchId: principal.branchId ?? null,
                branchMembershipVersion: principal.branchMembershipVersion ?? null,
            }),
            { resourceType: 'lecture', resourceId: lectureId },
        );
        if (decision.kind !== 'allowed') {
            return { ...DENIED_ACCESS, tenantId: lecture.tenant_id, courseId: lecture.course_id };
        }
        return { allowed: true, ...base, isStaff: true, enrollmentId: null };
    }

    const enrollmentId = principal.studentEnrollmentId ?? null;
    const enrollment = enrollmentId
        ? await queryOne<AccessEnrollmentRow>(ACCESS_ENROLLMENT_SQL, [enrollmentId, principal.id])
        : null;
    const policyRow = await queryOne<ReleasePolicyRow>(ACCESS_POLICY_SQL, [lectureId]);
    const policy = buildLessonReleasePolicy(lecture, policyRow);

    let prerequisiteCompleted = false;
    if (policy.releaseMode === 'sequential' && policy.prerequisiteLectureId && enrollment) {
        const progress = createLessonProgressService({ query, queryOne, execute } as LessonProgressDb);
        prerequisiteCompleted = await progress.isCompleted(enrollment.id, policy.prerequisiteLectureId);
    }

    const decision = evaluateContentAccess({
        isStaff: false,
        lecture: accessLectureFacts(lecture),
        enrollment: enrollment ? accessEnrollmentFacts(enrollment) : null,
        policy,
        prerequisiteCompleted,
        now: new Date(),
    });
    if (!decision.allowed) {
        return { ...DENIED_ACCESS, tenantId: lecture.tenant_id, courseId: lecture.course_id };
    }
    return { allowed: true, ...base, isStaff: false, enrollmentId: enrollment?.id ?? null };
}

export default createLessonDiscussionsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    resolveLessonAccess: resolveProductionLessonAccess,
    audit: async (input) => {
        const { recordAudit } = await import('../security/audit');
        await recordAudit(productionDb.execute, input);
    },
});

export { MAX_LIST_LIMIT };
