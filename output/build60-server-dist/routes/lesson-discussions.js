"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_LIST_LIMIT = exports.hasLessonTenantReach = void 0;
exports.createLessonDiscussionsRouter = createLessonDiscussionsRouter;
exports.resolveProductionLessonAccess = resolveProductionLessonAccess;
const express_1 = require("express");
const audit_1 = require("../security/audit");
const lesson_discussions_1 = require("../services/lesson-discussions");
Object.defineProperty(exports, "MAX_LIST_LIMIT", { enumerable: true, get: function () { return lesson_discussions_1.MAX_LIST_LIMIT; } });
const content_access_1 = require("./content-access");
const content_release_1 = require("../services/content-release");
const lesson_progress_1 = require("../services/lesson-progress");
const resource_branch_1 = require("../security/resource-branch");
const admin_permissions_1 = require("../security/admin-permissions");
const RATE_LIMITS = {
    thread: { max: 10, windowMs: 60000 },
    reply: { max: 30, windowMs: 60000 },
    report: { max: 20, windowMs: 60000 },
    block: { max: 40, windowMs: 60000 },
};
function createLessonDiscussionsRouter(deps) {
    const router = (0, express_1.Router)();
    const now = deps.now ?? (() => new Date());
    const idFactory = deps.idFactory ?? lesson_discussions_1.defaultIdFactory;
    const notify = deps.notify ?? lesson_discussions_1.noopDiscussionNotificationHook;
    const audit = deps.audit ?? (async () => undefined);
    const runAtomic = deps.transaction ?? ((fn) => fn());
    const store = deps.store
        ?? (0, lesson_discussions_1.createSqlLessonDiscussionsStore)(deps.db);
    const limiters = {
        thread: (0, lesson_discussions_1.createUserRateLimiter)({ ...RATE_LIMITS.thread, now }),
        reply: (0, lesson_discussions_1.createUserRateLimiter)({ ...RATE_LIMITS.reply, now }),
        report: (0, lesson_discussions_1.createUserRateLimiter)({ ...RATE_LIMITS.report, now }),
        block: (0, lesson_discussions_1.createUserRateLimiter)({ ...RATE_LIMITS.block, now }),
    };
    router.use(deps.authenticate);
    const principalOf = (req) => {
        const user = req.user;
        if (!user)
            return null;
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
    const requireAccess = async (req, res, lectureId) => {
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
    const rateLimit = (res, tier, principal) => {
        if (limiters[tier].tryConsume(`${principal.id}:${tier}`))
            return true;
        res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return false;
    };
    /** Personal block set for the caller inside one tenant (bounded). */
    const blockedAuthors = async (tenantId, userId) => {
        const rows = await store.listBlocks(tenantId, userId);
        return new Set(rows.map((row) => row.blocked_user_id));
    };
    const bestEffort = async (fn) => {
        try {
            await fn();
        }
        catch (error) {
            // A notification failure never fails the accepted mutation, and the
            // error is never logged with message content.
            console.error('Lesson discussion notification error:', error instanceof Error ? error.name : 'unknown');
        }
    };
    /* --------------------------------------------------------------------- */
    /* GET /lessons/:lectureId/threads                                        */
    /* --------------------------------------------------------------------- */
    router.get('/lessons/:lectureId/threads', async (req, res) => {
        try {
            const lectureId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.lectureId);
            if (!lectureId)
                return res.status(404).json({ error: 'Lesson not found' });
            const limit = (0, lesson_discussions_1.clampListLimit)(req.query.limit);
            if (limit === null)
                return res.status(400).json({ error: 'Invalid limit' });
            const access = await requireAccess(req, res, lectureId);
            if (!access)
                return;
            const rows = await store.listThreads(access.tenantId, lectureId, limit);
            const blocked = await blockedAuthors(access.tenantId, req.user.id);
            const visible = access.isStaff ? rows : rows.filter(lesson_discussions_1.isThreadVisibleToStudent);
            res.json(visible
                .filter((row) => !blocked.has(row.author_user_id))
                .map((row) => (0, lesson_discussions_1.projectThread)(row, access.isStaff)));
        }
        catch (error) {
            console.error('List discussion threads error:', error);
            res.status(500).json({ error: 'Failed to load discussion' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /lessons/:lectureId/threads                                       */
    /* --------------------------------------------------------------------- */
    router.post('/lessons/:lectureId/threads', async (req, res) => {
        try {
            const lectureId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.lectureId);
            if (!lectureId)
                return res.status(404).json({ error: 'Lesson not found' });
            const access = await requireAccess(req, res, lectureId);
            if (!access)
                return;
            const principal = principalOf(req);
            if (!rateLimit(res, 'thread', principal))
                return;
            const validated = (0, lesson_discussions_1.parseCreateThread)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const value = validated.value;
            const createdAt = now();
            const id = idFactory();
            const row = {
                id,
                tenant_id: access.tenantId,
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
                    newValue: (0, audit_1.snapshotRow)({ lecture_id: lectureId, title: value.title }),
                });
            });
            await bestEffort(() => notify.onThreadCreated({
                thread_id: id,
                tenant_id: access.tenantId,
                lecture_id: lectureId,
                author_user_id: principal.id,
                author_role: principal.role,
            }));
            res.status(201).json((0, lesson_discussions_1.projectThread)({ ...row, created_at: createdAt }, principal.role !== 'student'));
        }
        catch (error) {
            console.error('Create discussion thread error:', error);
            res.status(500).json({ error: 'Failed to create discussion thread' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /threads/:threadId — thread + replies                              */
    /* --------------------------------------------------------------------- */
    router.get('/threads/:threadId', async (req, res) => {
        try {
            const threadId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.threadId);
            if (!threadId)
                return res.status(404).json({ error: 'Thread not found' });
            const thread = await store.findThreadById(threadId);
            if (!thread)
                return res.status(404).json({ error: 'Thread not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access)
                return;
            if (thread.tenant_id !== access.tenantId)
                return res.status(404).json({ error: 'Thread not found' });
            if (!access.isStaff && !(0, lesson_discussions_1.isThreadVisibleToStudent)(thread)) {
                return res.status(404).json({ error: 'Thread not found' });
            }
            const limit = (0, lesson_discussions_1.clampListLimit)(req.query.limit);
            if (limit === null)
                return res.status(400).json({ error: 'Invalid limit' });
            const principal = principalOf(req);
            const blocked = await blockedAuthors(access.tenantId, principal.id);
            const replies = await store.listReplies(access.tenantId, threadId, limit);
            const visibleReplies = (access.isStaff ? replies : replies.filter(lesson_discussions_1.isReplyVisibleToStudent))
                .filter((row) => !blocked.has(row.author_user_id));
            res.json({
                thread: (0, lesson_discussions_1.projectThread)(thread, access.isStaff),
                replies: visibleReplies.map((row) => (0, lesson_discussions_1.projectReply)(row, access.isStaff)),
            });
        }
        catch (error) {
            console.error('Load discussion thread error:', error);
            res.status(500).json({ error: 'Failed to load thread' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /threads/:threadId/replies                                        */
    /* --------------------------------------------------------------------- */
    router.post('/threads/:threadId/replies', async (req, res) => {
        try {
            const threadId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.threadId);
            if (!threadId)
                return res.status(404).json({ error: 'Thread not found' });
            const validated = (0, lesson_discussions_1.parseReply)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const thread = await store.findThreadById(threadId);
            if (!thread)
                return res.status(404).json({ error: 'Thread not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access)
                return;
            if (thread.tenant_id !== access.tenantId)
                return res.status(404).json({ error: 'Thread not found' });
            if (!access.isStaff && !(0, lesson_discussions_1.isThreadVisibleToStudent)(thread)) {
                return res.status(404).json({ error: 'Thread not found' });
            }
            const principal = principalOf(req);
            if (!rateLimit(res, 'reply', principal))
                return;
            const createdAt = now();
            const id = idFactory();
            const row = {
                id,
                thread_id: threadId,
                tenant_id: access.tenantId,
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
                    newValue: (0, audit_1.snapshotRow)({ thread_id: threadId }),
                });
            });
            await bestEffort(() => notify.onReplyCreated({
                thread_id: threadId,
                reply_id: id,
                tenant_id: access.tenantId,
                lecture_id: thread.lecture_id,
                author_user_id: principal.id,
                author_role: principal.role,
            }));
            res.status(201).json((0, lesson_discussions_1.projectReply)({ ...row, created_at: createdAt }, principal.role !== 'student'));
        }
        catch (error) {
            console.error('Create discussion reply error:', error);
            res.status(500).json({ error: 'Failed to create reply' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* DELETE /threads/:threadId — author or staff soft delete               */
    /* --------------------------------------------------------------------- */
    router.delete('/threads/:threadId', async (req, res) => {
        try {
            const threadId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.threadId);
            if (!threadId)
                return res.status(404).json({ error: 'Thread not found' });
            const thread = await store.findThreadById(threadId);
            if (!thread)
                return res.status(404).json({ error: 'Thread not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access)
                return;
            if (thread.tenant_id !== access.tenantId)
                return res.status(404).json({ error: 'Thread not found' });
            const principal = principalOf(req);
            if (!access.isStaff && thread.author_user_id !== principal.id) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (thread.deleted_at)
                return res.status(409).json({ error: 'Thread is already deleted' });
            const deletedAt = now();
            const retentionExpiresAt = (0, lesson_discussions_1.computeRetentionExpiry)(deletedAt, lesson_discussions_1.DEFAULT_RETENTION_DAYS);
            const affected = await runAtomic(async () => {
                const count = await store.softDeleteThread(access.tenantId, threadId, principal.id, deletedAt, retentionExpiresAt);
                if (count > 0) {
                    await audit({
                        actorUserId: principal.id,
                        tenantId: access.tenantId,
                        action: 'thread.delete',
                        resourceType: 'lesson_discussion_thread',
                        resourceId: threadId,
                        oldValue: (0, audit_1.snapshotRow)({ status: thread.status, author_user_id: thread.author_user_id }),
                        newValue: (0, audit_1.snapshotRow)({ status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() }),
                    });
                }
                return count;
            });
            if (affected === 0)
                return res.status(409).json({ error: 'Thread is already deleted' });
            res.json({ id: threadId, status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() });
        }
        catch (error) {
            console.error('Delete discussion thread error:', error);
            res.status(500).json({ error: 'Failed to delete thread' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* DELETE /replies/:replyId — author or staff soft delete                */
    /* --------------------------------------------------------------------- */
    router.delete('/replies/:replyId', async (req, res) => {
        try {
            const replyId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.replyId);
            if (!replyId)
                return res.status(404).json({ error: 'Reply not found' });
            const reply = await store.findReplyById(replyId);
            if (!reply)
                return res.status(404).json({ error: 'Reply not found' });
            const thread = await store.findThreadById(reply.thread_id);
            if (!thread)
                return res.status(404).json({ error: 'Reply not found' });
            const access = await requireAccess(req, res, thread.lecture_id);
            if (!access)
                return;
            if (reply.tenant_id !== access.tenantId)
                return res.status(404).json({ error: 'Reply not found' });
            const principal = principalOf(req);
            if (!access.isStaff && reply.author_user_id !== principal.id) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (reply.deleted_at)
                return res.status(409).json({ error: 'Reply is already deleted' });
            const deletedAt = now();
            const retentionExpiresAt = (0, lesson_discussions_1.computeRetentionExpiry)(deletedAt, lesson_discussions_1.DEFAULT_RETENTION_DAYS);
            const affected = await runAtomic(async () => {
                const count = await store.softDeleteReply(access.tenantId, replyId, principal.id, deletedAt, retentionExpiresAt);
                if (count > 0) {
                    await audit({
                        actorUserId: principal.id,
                        tenantId: access.tenantId,
                        action: 'reply.delete',
                        resourceType: 'lesson_discussion_reply',
                        resourceId: replyId,
                        oldValue: (0, audit_1.snapshotRow)({ status: reply.status, author_user_id: reply.author_user_id }),
                        newValue: (0, audit_1.snapshotRow)({ status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() }),
                    });
                }
                return count;
            });
            if (affected === 0)
                return res.status(409).json({ error: 'Reply is already deleted' });
            res.json({ id: replyId, status: 'deleted', retention_expires_at: retentionExpiresAt.toISOString() });
        }
        catch (error) {
            console.error('Delete discussion reply error:', error);
            res.status(500).json({ error: 'Failed to delete reply' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* Moderation: staff hide/restore/delete with a recorded reason           */
    /* --------------------------------------------------------------------- */
    const moderateThread = async (req, res) => {
        const threadId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.threadId);
        if (!threadId)
            return void res.status(404).json({ error: 'Thread not found' });
        const validated = (0, lesson_discussions_1.parseModeration)(req.body);
        if (!validated.ok)
            return void res.status(400).json({ error: validated.error });
        const thread = await store.findThreadById(threadId);
        if (!thread)
            return void res.status(404).json({ error: 'Thread not found' });
        const access = await requireAccess(req, res, thread.lecture_id);
        if (!access)
            return;
        if (thread.tenant_id !== access.tenantId)
            return void res.status(404).json({ error: 'Thread not found' });
        if (!access.isStaff)
            return void res.status(403).json({ error: 'Moderator access required' });
        if (thread.deleted_at)
            return void res.status(409).json({ error: 'A deleted thread cannot be moderated' });
        const principal = principalOf(req);
        const { action, reason } = validated.value;
        const status = moderationThreadStatus(action);
        const at = now();
        const affected = await runAtomic(async () => {
            const count = await store.setThreadStatus(access.tenantId, threadId, status, reason, principal.id, at);
            if (count > 0) {
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: `thread.moderate.${action}`,
                    resourceType: 'lesson_discussion_thread',
                    resourceId: threadId,
                    oldValue: (0, audit_1.snapshotRow)({ status: thread.status }),
                    newValue: (0, audit_1.snapshotRow)({ status, hidden_reason: reason }),
                    reason: reason ?? undefined,
                });
            }
            return count;
        });
        if (affected === 0)
            return void res.status(409).json({ error: 'Thread state changed concurrently' });
        await bestEffort(() => notify.onModerated({
            target_type: 'thread', target_id: threadId, tenant_id: access.tenantId,
            action, actor_user_id: principal.id, target_author_user_id: thread.author_user_id,
        }));
        res.json({ id: threadId, status, hidden_reason: reason });
    };
    const moderateReply = async (req, res) => {
        const replyId = (0, lesson_discussions_1.normalizeDiscussionId)(req.params.replyId);
        if (!replyId)
            return void res.status(404).json({ error: 'Reply not found' });
        const validated = (0, lesson_discussions_1.parseModeration)(req.body);
        if (!validated.ok)
            return void res.status(400).json({ error: validated.error });
        const reply = await store.findReplyById(replyId);
        if (!reply)
            return void res.status(404).json({ error: 'Reply not found' });
        const thread = await store.findThreadById(reply.thread_id);
        if (!thread)
            return void res.status(404).json({ error: 'Reply not found' });
        const access = await requireAccess(req, res, thread.lecture_id);
        if (!access)
            return;
        if (reply.tenant_id !== access.tenantId)
            return void res.status(404).json({ error: 'Reply not found' });
        if (!access.isStaff)
            return void res.status(403).json({ error: 'Moderator access required' });
        if (reply.deleted_at)
            return void res.status(409).json({ error: 'A deleted reply cannot be moderated' });
        const principal = principalOf(req);
        const { action, reason } = validated.value;
        const status = moderationReplyStatus(action);
        const at = now();
        const affected = await runAtomic(async () => {
            const count = await store.setReplyStatus(access.tenantId, replyId, status, reason, principal.id, at);
            if (count > 0) {
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: `reply.moderate.${action}`,
                    resourceType: 'lesson_discussion_reply',
                    resourceId: replyId,
                    oldValue: (0, audit_1.snapshotRow)({ status: reply.status }),
                    newValue: (0, audit_1.snapshotRow)({ status, hidden_reason: reason }),
                    reason: reason ?? undefined,
                });
            }
            return count;
        });
        if (affected === 0)
            return void res.status(409).json({ error: 'Reply state changed concurrently' });
        await bestEffort(() => notify.onModerated({
            target_type: 'reply', target_id: replyId, tenant_id: access.tenantId,
            action, actor_user_id: principal.id, target_author_user_id: reply.author_user_id,
        }));
        res.json({ id: replyId, status, hidden_reason: reason });
    };
    router.post('/threads/:threadId/moderate', (req, res) => {
        moderateThread(req, res).catch((error) => {
            console.error('Moderate discussion thread error:', error);
            if (!res.headersSent)
                res.status(500).json({ error: 'Failed to moderate thread' });
        });
    });
    router.post('/replies/:replyId/moderate', (req, res) => {
        moderateReply(req, res).catch((error) => {
            console.error('Moderate discussion reply error:', error);
            if (!res.headersSent)
                res.status(500).json({ error: 'Failed to moderate reply' });
        });
    });
    /* --------------------------------------------------------------------- */
    /* POST /reports — report a thread/reply in an accessible lesson          */
    /* --------------------------------------------------------------------- */
    router.post('/reports', async (req, res) => {
        try {
            const validated = (0, lesson_discussions_1.parseReport)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const { targetType, targetId, reason } = validated.value;
            let tenantId = null;
            let lectureId = null;
            let authorUserId = null;
            if (targetType === 'thread') {
                const thread = await store.findThreadById(targetId);
                if (thread) {
                    tenantId = thread.tenant_id;
                    lectureId = thread.lecture_id;
                    authorUserId = thread.author_user_id;
                }
            }
            else {
                const reply = await store.findReplyById(targetId);
                if (reply) {
                    tenantId = reply.tenant_id;
                    authorUserId = reply.author_user_id;
                    const thread = await store.findThreadById(reply.thread_id);
                    lectureId = thread ? thread.lecture_id : null;
                }
            }
            if (!tenantId || !lectureId)
                return res.status(404).json({ error: 'Report target not found' });
            const access = await requireAccess(req, res, lectureId);
            if (!access)
                return;
            if (tenantId !== access.tenantId)
                return res.status(404).json({ error: 'Report target not found' });
            const principal = principalOf(req);
            if (!rateLimit(res, 'report', principal))
                return;
            if (authorUserId === principal.id) {
                return res.status(400).json({ error: 'You cannot report your own content' });
            }
            const id = idFactory();
            await runAtomic(async () => {
                await store.insertReport({
                    id, tenant_id: access.tenantId, target_type: targetType,
                    target_id: targetId, reporter_user_id: principal.id, reason,
                });
                await audit({
                    actorUserId: principal.id,
                    tenantId: access.tenantId,
                    action: 'discussion.report',
                    resourceType: `lesson_discussion_${targetType}`,
                    resourceId: targetId,
                    newValue: (0, audit_1.snapshotRow)({ reason }),
                });
            });
            await bestEffort(() => notify.onReported({
                target_type: targetType, target_id: targetId,
                tenant_id: access.tenantId, reporter_user_id: principal.id,
            }));
            res.status(201).json({ id, target_type: targetType, target_id: targetId, status: 'open' });
        }
        catch (error) {
            console.error('Report discussion target error:', error);
            res.status(500).json({ error: 'Failed to submit report' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* Block list (personal, tenant-scoped)                                   */
    /* --------------------------------------------------------------------- */
    router.get('/blocks', async (req, res) => {
        try {
            const principal = principalOf(req);
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId)
                return res.status(403).json({ error: 'An active tenant membership is required' });
            const rows = await store.listBlocks(principal.tenantId, principal.id);
            res.json(rows.map((row) => ({ blocked_user_id: row.blocked_user_id, created_at: row.created_at ?? null })));
        }
        catch (error) {
            console.error('List discussion blocks error:', error);
            res.status(500).json({ error: 'Failed to load blocks' });
        }
    });
    router.post('/blocks', async (req, res) => {
        try {
            const principal = principalOf(req);
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId)
                return res.status(403).json({ error: 'An active tenant membership is required' });
            if (!rateLimit(res, 'block', principal))
                return;
            const validated = (0, lesson_discussions_1.parseBlock)(req.body);
            if (!validated.ok)
                return res.status(400).json({ error: validated.error });
            const blockedUserId = validated.value.blockedUserId;
            if (blockedUserId === principal.id)
                return res.status(400).json({ error: 'You cannot block yourself' });
            const existing = await store.findBlock(principal.tenantId, principal.id, blockedUserId);
            if (existing)
                return res.json({ blocked_user_id: blockedUserId, created: false });
            const id = idFactory();
            await runAtomic(async () => {
                await store.insertBlock({
                    id, tenant_id: principal.tenantId,
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
        }
        catch (error) {
            console.error('Create discussion block error:', error);
            res.status(500).json({ error: 'Failed to block user' });
        }
    });
    router.delete('/blocks/:blockedUserId', async (req, res) => {
        try {
            const principal = principalOf(req);
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId)
                return res.status(403).json({ error: 'An active tenant membership is required' });
            const blockedUserId = (0, lesson_discussions_1.normalizeUserId)(req.params.blockedUserId);
            if (!blockedUserId)
                return res.status(400).json({ error: 'Invalid blocked_user_id' });
            const removed = await runAtomic(async () => {
                const count = await store.deleteBlock(principal.tenantId, principal.id, blockedUserId);
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
        }
        catch (error) {
            console.error('Delete discussion block error:', error);
            res.status(500).json({ error: 'Failed to unblock user' });
        }
    });
    return router;
}
function moderationThreadStatus(action) {
    return action === 'hide' ? 'hidden' : action === 'delete' ? 'deleted' : 'open';
}
function moderationReplyStatus(action) {
    return action === 'hide' ? 'hidden' : action === 'delete' ? 'deleted' : 'visible';
}
/* ------------------------------------------------------------------------- */
/* Production wiring                                                          */
/* ------------------------------------------------------------------------- */
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const productionDb = {
    query: async (sql, params) => {
        const { query } = await loadDb();
        return query(sql, params);
    },
    queryOne: async (sql, params) => {
        const { queryOne } = await loadDb();
        return queryOne(sql, params);
    },
    execute: async (sql, params) => {
        const { execute } = await loadDb();
        return execute(sql, params);
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
function deriveAccessBranch(scope, branchId) {
    const normalized = (scope ?? '').trim().toLowerCase();
    if (normalized === 'branch') {
        return branchId ? { branchId, ambiguous: false } : { branchId: null, ambiguous: true };
    }
    return { branchId: null, ambiguous: false };
}
function accessLectureFacts(lecture) {
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
function accessEnrollmentFacts(enrollment) {
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
const DENIED_ACCESS = {
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
const hasLessonTenantReach = async (principal, lectureTenantId, hasPlatformCapability) => {
    if (principal.tenantId && principal.tenantId === lectureTenantId)
        return true;
    return hasPlatformCapability(principal.id);
};
exports.hasLessonTenantReach = hasLessonTenantReach;
/**
 * Production access resolver. Reuses the composed content-access policy so the
 * lesson must be published, in the caller's enrolled audience/branch, and
 * released (immediate/scheduled/sequential) before any discussion is served.
 * A non-student principal reaches a lesson only inside its own server-derived
 * tenant; cross-tenant reach requires a verified platform capability and never
 * a `role` label. Nothing from the request body participates.
 */
async function resolveProductionLessonAccess(principal, lectureId) {
    const { query, queryOne, execute } = await loadDb();
    const lecture = await queryOne(ACCESS_LECTURE_SQL, [lectureId]);
    if (!lecture)
        return DENIED_ACCESS;
    const branch = deriveAccessBranch(lecture.group_branch_scope, lecture.group_branch_id);
    const base = {
        tenantId: lecture.tenant_id,
        courseId: lecture.course_id,
        branchId: branch.branchId,
        branchAmbiguous: branch.ambiguous,
    };
    if (principal.role !== 'student') {
        const reach = await (0, exports.hasLessonTenantReach)(principal, lecture.tenant_id, (userId) => (0, admin_permissions_1.hasVerifiedPlatformPermission)(LESSON_PLATFORM_PERMISSION_KEY, userId));
        if (!reach)
            return DENIED_ACCESS;
        const decision = await (0, resource_branch_1.resolveResourceBranchAccess)((0, resource_branch_1.getResourceBranchDeps)(), (0, resource_branch_1.principalFromAuthUser)({
            id: principal.id,
            role: principal.role,
            tenantId: principal.tenantId,
            branchId: principal.branchId ?? null,
            branchMembershipVersion: principal.branchMembershipVersion ?? null,
        }), { resourceType: 'lecture', resourceId: lectureId });
        if (decision.kind !== 'allowed') {
            return { ...DENIED_ACCESS, tenantId: lecture.tenant_id, courseId: lecture.course_id };
        }
        return { allowed: true, ...base, isStaff: true, enrollmentId: null };
    }
    const enrollmentId = principal.studentEnrollmentId ?? null;
    const enrollment = enrollmentId
        ? await queryOne(ACCESS_ENROLLMENT_SQL, [enrollmentId, principal.id])
        : null;
    const policyRow = await queryOne(ACCESS_POLICY_SQL, [lectureId]);
    const policy = (0, content_release_1.buildLessonReleasePolicy)(lecture, policyRow);
    let prerequisiteCompleted = false;
    if (policy.releaseMode === 'sequential' && policy.prerequisiteLectureId && enrollment) {
        const progress = (0, lesson_progress_1.createLessonProgressService)({ query, queryOne, execute });
        prerequisiteCompleted = await progress.isCompleted(enrollment.id, policy.prerequisiteLectureId);
    }
    const decision = (0, content_access_1.evaluateContentAccess)({
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
exports.default = createLessonDiscussionsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    resolveLessonAccess: resolveProductionLessonAccess,
    audit: async (input) => {
        const { recordAudit } = await Promise.resolve().then(() => __importStar(require('../security/audit')));
        await recordAudit(productionDb.execute, input);
    },
});
