/**
 * Secure Video Streaming Routes
 * - JWT-protected session creation
 * - Token-bound segment proxy
 * - Heartbeat endpoint
 * - Violation reporting & kill-session
 * - HLS key delivery via signed session
 */
import { Router, Request, Response, RequestHandler } from 'express';
import { query, queryOne, execute } from '../db';
import { v4 as uuidv4 } from 'uuid';
import {
    AuthRequest,
    authenticateToken,
    generateVideoSessionToken,
    verifyVideoSessionToken,
    getClientIp,
    hashValue
} from '../middleware/auth';
import {
    createVideoSession,
    killSession,
    getActiveSession,
    recordHeartbeat,
    recordViolation,
    isUserSuspended,
    getUserActiveSessionId,
    getUserVideoRestrictions,
    inspectDeliveryRequest,
    readDurableSessionStatus,
} from '../services/video-security';
import {
    getResourceBranchDeps,
    principalFromAuthUser,
    resolveResourceBranchAccess,
    resourceBranchDenial,
    type ResourceBranchDecision,
    type ResourceBranchPrincipal,
} from '../security/resource-branch';
import { getThumbnailUrl, getObjectBuffer, getObjectStream, BUCKETS } from '../services/minio';
import { createNotification } from '../utils/notifications';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';
import { createSqlVideoAccessRepository, evaluateVideoAccess, type VideoAccessScope } from '../security/video-access-policy';
import {
    PlaybackDenialReason,
    PlaybackEntitlementRecord,
    PlaybackEntitlementService,
    PLAYBACK_TOKEN_MAX_TTL_SECONDS,
    createPlaybackEntitlementService,
    createSqlPlaybackEntitlementStore,
} from '../services/playback-entitlement';

const router = Router();
const VIDEO_TERMS_VERSION = 'video-security-v1';

/**
 * Platform capability key for cross-tenant video security administration.
 * Migrations seed no security.* key beyond the verified super_admin role, so
 * the verified capability check is the effective policy; a bare admin role
 * claim never satisfies it.
 */
const PLATFORM_SECURITY_PERMISSION = 'security.manage';

/**
 * Verified platform capability, resolved server-side (active super_admin or a
 * seeded permission key). Never consults a JWT role claim.
 */
const hasVerifiedPlatformCapability = async (userId: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes(PLATFORM_SECURITY_PERMISSION);
};

router.get('/consent', authenticateToken, async (req: AuthRequest, res: Response) => {
    const consent = await queryOne(
        'SELECT accepted_at FROM video_security_consents WHERE user_id=? AND terms_version=? LIMIT 1',
        [req.user!.id, VIDEO_TERMS_VERSION]
    );
    res.json({ required: !consent, accepted: Boolean(consent), termsVersion: VIDEO_TERMS_VERSION });
});

router.post('/consent', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.body?.termsVersion !== VIDEO_TERMS_VERSION || req.body?.accepted !== true) {
        return res.status(400).json({ error: 'Explicit acceptance of the current terms is required' });
    }
    await execute(
        `INSERT INTO video_security_consents (id,user_id,terms_version,accepted_at,ip_address,user_agent)
         VALUES (?,?,?,UTC_TIMESTAMP(),?,?)
         ON DUPLICATE KEY UPDATE accepted_at=UTC_TIMESTAMP(),ip_address=VALUES(ip_address),user_agent=VALUES(user_agent)`,
        [uuidv4(), req.user!.id, VIDEO_TERMS_VERSION, getClientIp(req), req.headers['user-agent'] || '']
    );
    res.json({ accepted: true, termsVersion: VIDEO_TERMS_VERSION });
});

// ═══════════════════════════════════════
// SESSION CREATION (Requires Auth)
// ═══════════════════════════════════════

/**
 * The same resource-derived branch decision for token-bound media delivery,
 * where no auth header is present. The session carries the server-derived
 * user and tenant captured at issuance; a branch-owned video still requires
 * a live membership on every manifest/segment/key/heartbeat request, and an
 * ambiguous parent chain denies. Existing delivery policy is checked
 * separately and is never replaced by this helper.
 *
 * This production binding is kept for the heartbeat route; the delivery
 * factory receives the same decision through its injected `resolveBranch`.
 */
const sessionVideoBranchAllowed = async (
    session: { userId: string; tenantId?: string } | null,
    videoId: string,
): Promise<boolean> => {
    if (!session) return false;
    const decision = await resolveResourceBranchAccess(
        getResourceBranchDeps(),
        { userId: session.userId, tenantId: session.tenantId ?? null, role: 'student' },
        { resourceType: 'video', resourceId: videoId },
    );
    return decision.kind === 'allowed';
};

// ═══════════════════════════════════════
// SESSION CREATION / REFRESH / MEDIA DELIVERY
// ═══════════════════════════════════════
// These routes are built by createSecureVideoDeliveryRouter below, so the
// server-owned entitlement check can be exercised hermetically with injected
// dependencies while the production export keeps the same paths and contract.


// The refresh route is built by createSecureVideoDeliveryRouter below.


// ═══════════════════════════════════════
// HEARTBEAT
// ═══════════════════════════════════════

/**
 * POST /api/secure-video/heartbeat
 * Must be called every 5 seconds by client
 */
router.post('/heartbeat', async (req: Request, res: Response) => {
    try {
        const { sessionId, sessionToken } = req.body;

        if (!sessionId || !sessionToken) {
            return res.status(400).json({ error: 'sessionId and sessionToken required' });
        }

        // Verify token
        const tokenResult = verifyVideoSessionToken(sessionToken, req);
        if (!tokenResult.valid) {
            return res.status(401).json({
                error: 'token_invalid',
                reason: tokenResult.reason
            });
        }

        const session = getActiveSession(sessionId);
        if (
            !session ||
            tokenResult.decoded?.sid !== sessionId ||
            tokenResult.decoded?.sub !== session.userId ||
            tokenResult.decoded?.vid !== session.videoId
        ) {
            return res.status(401).json({ error: 'session_dead', message: 'Session binding mismatch' });
        }

        // The SAME authorization is rechecked on every heartbeat, with the
        // scope captured when the session was created (server-derived).
        const stillAllowed = session.previewOnly
            ? await evaluatePreviewOffer(session.offerId, session.videoId, session.userId, queryOne)
            : await checkVideoAccess(session.userId, session.videoId, {
                tenantId: session.tenantId,
                studentEnrollmentId: session.studentEnrollmentId,
            });
        if (!stillAllowed) {
            await killSession(sessionId, 'access_revoked');
            return res.status(403).json({ error: 'Video access was revoked' });
        }
        // Branch ownership is re-derived on every heartbeat too, so a revoked
        // membership or a newly ambiguous parent chain ends the session.
        if (!(await sessionVideoBranchAllowed(session, session.videoId))) {
            await killSession(sessionId, 'access_revoked');
            return res.status(403).json({ error: 'Video access was revoked' });
        }

        // Record heartbeat
        const alive = recordHeartbeat(sessionId);
        if (!alive) {
            return res.status(401).json({
                error: 'session_dead',
                message: 'Session no longer active'
            });
        }

        res.json({ ok: true, ts: Date.now() });

    } catch (error) {
        return res.status(500).json({ error: 'Heartbeat failed' });
    }
});

// ═══════════════════════════════════════
// VIOLATION REPORTING
// ═══════════════════════════════════════

/**
 * POST /api/secure-video/report-violation
 * Client reports a security violation
 */
router.post('/report-violation', async (req: Request, res: Response) => {
    try {
        const { sessionId, sessionToken, violationType, details, confidence } = req.body;

        if (!sessionId || !sessionToken || !violationType) {
            return res.status(400).json({ error: 'sessionId, sessionToken, violationType required' });
        }

        const session = getActiveSession(sessionId);
        if (!session) {
            return res.json({ action: 'session_already_dead' });
        }

        const tokenResult = verifyVideoSessionToken(sessionToken, req);
        if (
            !tokenResult.valid ||
            tokenResult.decoded?.sid !== sessionId ||
            tokenResult.decoded?.sub !== session.userId ||
            tokenResult.decoded?.vid !== session.videoId
        ) {
            return res.status(401).json({ error: 'Invalid session token' });
        }

        const ip = getClientIp(req);
        const userAgent = req.headers['user-agent'] || '';

        const result = await recordViolation({
            sessionId,
            userId: session.userId,
            videoId: session.videoId,
            violationType,
            details,
            ip,
            userAgent,
            confidence: ['low', 'medium', 'high'].includes(confidence) ? confidence : 'medium'
        });

        res.json({
            action: result.action,
            score: result.score,
            killed: result.killed,
            suspended: result.suspended,
            restrictions: result.restrictions
        });

    } catch (error) {
        console.error('[SecureVideo] Violation report error:', error);
        res.status(500).json({ error: 'Failed to report violation' });
    }
});

// ═══════════════════════════════════════
// KILL SESSION
// ═══════════════════════════════════════

/**
 * POST /api/secure-video/kill-session
 * Force kill a session (from client or admin)
 */
router.post('/kill-session', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { sessionId, reason } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }

        const session = getActiveSession(sessionId);
        if (!session) {
            return res.json({ ok: true });
        }

        // Only the session owner or a verified platform admin may force-kill;
        // a bare admin role claim is not a capability.
        const isPlatformAdmin = await hasVerifiedPlatformCapability(req.user!.id);
        if (session.userId !== req.user!.id && !isPlatformAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await killSession(sessionId, reason || 'client_requested');
        res.json({ ok: true });

    } catch (error) {
        res.status(500).json({ error: 'Failed to kill session' });
    }
});

// ═══════════════════════════════════════
// SECURE KEY DELIVERY
// ═══════════════════════════════════════

/**
 * Session binding for media delivery: the verified token, the ACTIVE
 * session, and the requested asset must all name the same session, user,
 * and video — a token minted for one asset never serves another. Exported
 * so the binding rule itself is testable without a database.
 */
export const isMediaSessionBound = (
    decoded: { sid?: string; sub?: string; vid?: string } | undefined,
    session: { sessionId: string; userId: string; videoId: string } | null,
    videoId: string,
): boolean => Boolean(
    decoded && session
    && session.videoId === videoId
    && decoded.sid === session.sessionId
    && decoded.sub === session.userId
    && decoded.vid === videoId
);

/** Session facts a delivery recheck needs (all bound at session creation). */
export interface DeliverySession {
    userId: string;
    videoId: string;
    previewOnly: boolean;
    offerId?: string;
    tenantId?: string;
    studentEnrollmentId?: string;
}

/** Reads the delivery recheck needs; production wires the pool + policy. */
export interface DeliveryAccessDeps {
    hasVideoAccess: (userId: string, videoId: string, scope: VideoAccessScope) => Promise<boolean>;
    hasPreviewOffer: (offerId: string | undefined, videoId: string, userId: string) => Promise<boolean>;
}

/**
 * Delivery recheck: the SAME production authorization that issued the
 * session must still hold when a manifest, a segment, or a key is served —
 * a purchased grant revoked mid-session denies here instead of riding a
 * still-valid token. Preview sessions recheck their own pending offer, so
 * previewOnly is never an authorization bypass. The scope is the one
 * captured at session creation (server-derived), never a request value.
 */
export const evaluateDeliveryAccess = async (
    session: DeliverySession,
    deps: DeliveryAccessDeps,
): Promise<boolean> => {
    if (session.previewOnly) {
        return deps.hasPreviewOffer(session.offerId, session.videoId, session.userId);
    }
    return deps.hasVideoAccess(session.userId, session.videoId, {
        tenantId: session.tenantId,
        studentEnrollmentId: session.studentEnrollmentId,
    });
};

// The manifest/media/key routes are built by createSecureVideoDeliveryRouter below.


/** Confirmed browser-visible capture signal: kill video and revoke student JWTs. */
router.post('/force-logout', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const sessionId = String(req.body.sessionId || '');
        const activityType = String(req.body.activityType || 'screen_capture_attempt').slice(0, 100);
        const details = String(req.body.details || '').slice(0, 1000);
        const session = sessionId ? getActiveSession(sessionId) : null;
        if (!session || session.userId !== req.user!.id) return res.status(404).json({ error: 'Active session not found' });
        await recordViolation({ sessionId, userId: session.userId, videoId: session.videoId,
            violationType: activityType, details, ip: getClientIp(req), userAgent: req.headers['user-agent'] || '', confidence: 'high' });
        await killSession(sessionId, `forced_logout:${activityType}`);
        if (req.user!.role === 'student') {
            await execute('UPDATE users SET token_version=token_version+1 WHERE id=? AND role=\'student\'', [req.user!.id]);
        }
        res.json({ logged_out: true });
    } catch (error) {
        console.error('[SecureVideo] Forced logout error:', error);
        res.status(500).json({ error: 'Failed to revoke session' });
    }
});

// The media route is built by createSecureVideoDeliveryRouter below.

// The key route is built by createSecureVideoDeliveryRouter below.

// ═══════════════════════════════════════
// SECURITY LOG (Legacy compatible)
// ═══════════════════════════════════════

/**
 * POST /api/secure-video/security/log
 * Generic security log endpoint
 */
router.post('/security/log', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId, activityType, details, sessionId } = req.body;
        const userId = req.user!.id;

        if (!userId || !activityType) {
            return res.status(400).json({ error: 'Missing fields' });
        }

        const ip = getClientIp(req);
        const userAgent = req.headers['user-agent'] || '';

        await execute(
            `INSERT INTO video_security_logs
             (id, user_id, video_id, activity_type, ip_address, user_agent, details, session_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [uuidv4(), userId, videoId || null, activityType, ip, userAgent, details || null, sessionId || null]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Log failed' });
    }
});

router.get('/instructor/violations', authenticateToken, async (req: AuthRequest, res: Response) => {
    // Instructor scope is verified per student row below; platform-wide
    // visibility requires the verified platform capability, not a role claim.
    const isPlatformAdmin = await hasVerifiedPlatformCapability(req.user!.id);
    const isInstructor = req.user!.role === 'instructor';
    if (!isPlatformAdmin && !isInstructor) return res.status(403).json({ error: 'Forbidden' });
    const instructorFilter = isInstructor ? 'AND s.instructor_id=?' : '';
    const params = isInstructor ? [req.user!.id] : [];
    const rows = await query<any>(
        `SELECT l.id,l.activity_type,l.details,l.violation_score,l.violation_weight,l.confidence,l.created_at,
                RIGHT(l.ip_address,7) masked_ip,l.user_agent,s.user_id student_user_id,s.name student_name,
                v.title video_title
         FROM video_security_logs l
         JOIN students s ON s.user_id=l.user_id AND s.is_active=1
         LEFT JOIN videos v ON v.id=l.video_id
         WHERE l.created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY) ${instructorFilter}
         ORDER BY l.created_at DESC LIMIT 200`, params
    );
    res.json(rows);
});

router.post('/instructor/students/:studentUserId/suspend', authenticateToken, async (req: AuthRequest, res: Response) => {
    // Instructor scope is verified through student ownership; platform-wide
    // suspension requires the verified platform capability, not a role claim.
    const isPlatformAdmin = await hasVerifiedPlatformCapability(req.user!.id);
    const isInstructor = req.user!.role === 'instructor';
    if (!isPlatformAdmin && !isInstructor) return res.status(403).json({ error: 'Forbidden' });
    const studentUserId = String(req.params.studentUserId || '');
    const minutes = Math.max(5, Math.min(1440, Number(req.body?.minutes) || 30));
    const reason = String(req.body?.reason || 'Video security review').slice(0, 500);
    const owned = await queryOne<any>(
        `SELECT id,name FROM students WHERE user_id=? AND is_active=1 ${isInstructor ? 'AND instructor_id=?' : ''} LIMIT 1`,
        isInstructor ? [studentUserId, req.user!.id] : [studentUserId]
    );
    if (!owned) return res.status(404).json({ error: 'Student not found in your space' });
    await execute(
        `UPDATE users SET suspended_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL ? MINUTE),suspension_reason=?,token_version=token_version+1
         WHERE id=? AND role='student'`, [minutes, reason, studentUserId]
    );
    const activeSession = getUserActiveSessionId(studentUserId);
    if (activeSession) await killSession(activeSession, 'instructor_suspension');
    await createNotification({ user_id: studentUserId, user_type: 'student', title: 'تم تعليق الحساب مؤقتًا',
        message: `تم تعليق حسابك لمدة ${minutes} دقيقة للمراجعة الأمنية.`, type: 'general' });
    res.json({ suspended: true, minutes });
});

router.post('/instructor/students/:studentUserId/unsuspend', authenticateToken, async (req: AuthRequest, res: Response) => {
    // Instructor scope is verified through student ownership; platform-wide
    // unsuspension requires the verified platform capability, not a role claim.
    const isPlatformAdmin = await hasVerifiedPlatformCapability(req.user!.id);
    const isInstructor = req.user!.role === 'instructor';
    if (!isPlatformAdmin && !isInstructor) return res.status(403).json({ error: 'Forbidden' });
    const studentUserId = String(req.params.studentUserId || '');
    const owned = await queryOne<any>(
        `SELECT id FROM students WHERE user_id=? AND is_active=1 ${isInstructor ? 'AND instructor_id=?' : ''} LIMIT 1`,
        isInstructor ? [studentUserId, req.user!.id] : [studentUserId]
    );
    if (!owned) return res.status(404).json({ error: 'Student not found in your space' });
    await execute('UPDATE users SET suspended_until=NULL,suspension_reason=NULL WHERE id=? AND role=\'student\'', [studentUserId]);
    res.json({ suspended: false });
});


// ═══════════════════════════════════════
// ACCESS CHECK (reused from videos.ts)
// ═══════════════════════════════════════

/**
 * Production SQL repository for the pure access policy, built over the
 * pool-backed helpers this router already uses (the policy module itself
 * carries no eager service import).
 */
const videoAccessRepository = createSqlVideoAccessRepository({
    queryOne,
    hasPlatformCapability: (userId) => hasVerifiedPlatformCapability(userId),
});

/**
 * Verified video access (deny-by-default). Delegates to the pure production
 * policy: ACTIVE per-resource teacher authority (uploader / own or assigned
 * lesson in a live tenant), an explicit verified instructor license, or the
 * server-selected student enrollment via an in-scope lecture, a verified
 * publication, or an exact purchased license. A teaching membership in the
 * video's tenant is NOT an entitlement.
 *
 * The scope is the authenticated, server-derived selection (auth middleware),
 * never a request body value.
 */
async function checkVideoAccess(userId: string, videoId: string, scope: VideoAccessScope): Promise<boolean> {
    return evaluateVideoAccess(userId, videoId, scope, videoAccessRepository);
}

// ═══════════════════════════════════════
// SESSION & PREVIEW AUTHORIZATION (injectable decisions; production wiring)
// ═══════════════════════════════════════

/**
 * A pending preview offer for exactly this video, held by the caller
 * (requester or owner) and still merely 'proposed'. The reader is injected
 * so the predicate is testable without a database; production wires the
 * pool-backed queryOne. A missing offer id fails closed.
 */
export const evaluatePreviewOffer = async (
    offerId: string | undefined,
    videoId: string,
    userId: string,
    reader: (sql: string, params: unknown[]) => Promise<unknown>,
): Promise<boolean> => {
    if (!offerId) return false;
    const offer = await reader(
        `SELECT o.id FROM instructor_video_offers o INNER JOIN instructor_video_requests r ON r.id=o.request_id
         WHERE o.id=? AND o.video_id=? AND (r.requester_id=? OR r.owner_id=?) AND o.status='proposed' LIMIT 1`,
        [offerId, videoId, userId, userId]
    );
    return Boolean(offer);
};

/** Outcome of the session-creation authorization decision. */
export type SessionAccessDecision =
    | 'video_not_found'
    | 'preview_unavailable'
    | 'no_access'
    | 'preview'
    | 'allowed';

/** Reads the session-creation decision needs; production wires the pool. */
export interface SessionAccessDeps {
    hasPreviewOffer: (offerId: string | undefined, videoId: string, userId: string) => Promise<boolean>;
    hasVideoAccess: (userId: string, videoId: string, scope: VideoAccessScope) => Promise<boolean>;
}

/**
 * Session-creation authorization (deny-by-default). The video must exist
 * and be ready; a requested preview is granted ONLY by the caller's own
 * still-pending offer and yields the truncated preview alone; every other
 * playback grant comes from the verified resource policy with the
 * authenticated, server-derived scope — the requesting tenant stays a
 * scope input, never the asset owner's authority.
 */
export const evaluateSessionAccess = async (
    video: { id: string } | null,
    request: { userId: string; offerId?: string; scope: VideoAccessScope },
    deps: SessionAccessDeps,
): Promise<SessionAccessDecision> => {
    if (!video) return 'video_not_found';
    if (request.offerId) {
        return (await deps.hasPreviewOffer(request.offerId, video.id, request.userId))
            ? 'preview'
            : 'preview_unavailable';
    }
    return (await deps.hasVideoAccess(request.userId, video.id, request.scope)) ? 'allowed' : 'no_access';
};

/* =========================================================================
 * VIDEO → LECTURE / MATERIAL / COURSE ASSOCIATION (server rows only)
 * ========================================================================= */

/**
 * The schema carries TWO independent link directions:
 *  - `videos.course_id` / `videos.lecture_id` / `videos.material_id`
 *    (written by the upload-init route, `videos.ts:1603-1618`);
 *  - `lectures.video_url = 'video://<id>'` and
 *    `course_materials.file_url = 'video://<id>'` (written by the lecture /
 *    material routes, `lectures.ts:496,729`, `materials.ts:550,660`).
 * Neither direction is unique and `videos.lecture_id` / `material_id` have no
 * foreign key, so a video can be reachable from several lectures/materials,
 * from none, or from rows that disagree about the course/tenant. This
 * resolver reports the shape instead of picking a row.
 */
export type VideoLessonAssociation =
    | { kind: 'unique'; lessonId: string }
    | { kind: 'none'; lessonId: null; reason: 'course-only' | 'material-only' }
    | { kind: 'ambiguous'; lessonId: null; reason: string };

export interface VideoParentReader {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
}

interface VideoParentRow {
    id: string;
    course_id: string | null;
    tenant_id: string | null;
    lecture_id: string | null;
    material_id: string | null;
    course_row_id: string | null;
    course_tenant_id: string | null;
}

interface LectureParentRow {
    id: string;
    course_id: string | null;
    tenant_id: string | null;
}

interface MaterialParentRow {
    id: string;
    course_id: string | null;
    tenant_id: string | null;
}

const VIDEO_PARENT_SQL = `
    SELECT v.id, v.course_id, v.tenant_id, v.lecture_id, v.material_id,
           c.id AS course_row_id, c.tenant_id AS course_tenant_id
    FROM videos v
    LEFT JOIN courses c ON c.id = v.course_id
    WHERE v.id = ? LIMIT 1
`;

const LECTURE_PARENT_SQL = `
    SELECT l.id, l.course_id, c.tenant_id
    FROM lectures l
    LEFT JOIN courses c ON c.id = l.course_id
    WHERE l.id = ? LIMIT 1
`;

const LECTURES_FOR_VIDEO_SQL = `
    SELECT l.id, l.course_id, c.tenant_id
    FROM lectures l
    LEFT JOIN courses c ON c.id = l.course_id
    WHERE l.video_url = CONCAT('video://', ?)
`;

const MATERIAL_PARENT_SQL = `
    SELECT cm.id, cm.course_id, c.tenant_id
    FROM course_materials cm
    LEFT JOIN courses c ON c.id = cm.course_id
    WHERE cm.id = ? LIMIT 1
`;

const MATERIALS_FOR_VIDEO_SQL = `
    SELECT cm.id, cm.course_id, c.tenant_id
    FROM course_materials cm
    LEFT JOIN courses c ON c.id = cm.course_id
    WHERE cm.material_type = 'video' AND cm.file_url = CONCAT('video://', ?)
`;

/**
 * Resolve the video's parents from server rows. Ambiguous means more than one
 * lecture/material, a dangling parent id, a parent in another course, or a
 * parent whose tenant disagrees with the video/course. Such a row is never
 * resolved by choosing the first match.
 */
export const resolveVideoLessonAssociation = async (
    videoId: string,
    reader: VideoParentReader,
): Promise<VideoLessonAssociation> => {
    const video = await reader.queryOne<VideoParentRow>(VIDEO_PARENT_SQL, [videoId]);
    if (!video) return { kind: 'ambiguous', lessonId: null, reason: 'video-not-found' };
    if (video.course_id && !video.course_row_id) {
        return { kind: 'ambiguous', lessonId: null, reason: 'dangling-course-parent' };
    }
    if (video.course_id && !video.course_tenant_id) {
        return { kind: 'ambiguous', lessonId: null, reason: 'course-tenant-unprovable' };
    }

    const lectures = new Map<string, LectureParentRow>();
    if (video.lecture_id) {
        const direct = await reader.queryOne<LectureParentRow>(LECTURE_PARENT_SQL, [video.lecture_id]);
        if (!direct) return { kind: 'ambiguous', lessonId: null, reason: 'dangling-lecture-parent' };
        lectures.set(direct.id, direct);
    }
    const reverseLectures = await reader.query<LectureParentRow>(LECTURES_FOR_VIDEO_SQL, [videoId]);
    for (const lecture of reverseLectures) lectures.set(lecture.id, lecture);

    const materials = new Map<string, MaterialParentRow>();
    if (video.material_id) {
        const direct = await reader.queryOne<MaterialParentRow>(MATERIAL_PARENT_SQL, [video.material_id]);
        if (!direct) return { kind: 'ambiguous', lessonId: null, reason: 'dangling-material-parent' };
        materials.set(direct.id, direct);
    }
    const reverseMaterials = await reader.query<MaterialParentRow>(MATERIALS_FOR_VIDEO_SQL, [videoId]);
    for (const material of reverseMaterials) materials.set(material.id, material);

    const parents: Array<{ course_id: string | null; tenant_id: string | null }> = [
        ...lectures.values(),
        ...materials.values(),
    ];
    for (const parent of parents) {
        if (!parent.course_id || parent.course_id !== video.course_id) {
            return { kind: 'ambiguous', lessonId: null, reason: 'conflicting-course-provenance' };
        }
        if (!parent.tenant_id) {
            return { kind: 'ambiguous', lessonId: null, reason: 'parent-tenant-unprovable' };
        }
    }

    const tenantIds = new Set<string>();
    if (video.tenant_id) tenantIds.add(video.tenant_id);
    if (video.course_tenant_id) tenantIds.add(video.course_tenant_id);
    for (const parent of parents) if (parent.tenant_id) tenantIds.add(parent.tenant_id);
    if (tenantIds.size > 1) {
        return { kind: 'ambiguous', lessonId: null, reason: 'conflicting-parent-tenant' };
    }

    if (materials.size > 1) {
        return { kind: 'ambiguous', lessonId: null, reason: 'ambiguous-material-parents' };
    }
    if (lectures.size > 1) {
        return { kind: 'ambiguous', lessonId: null, reason: 'ambiguous-lecture-parents' };
    }
    if (lectures.size === 1) {
        return { kind: 'unique', lessonId: [...lectures.keys()][0] };
    }
    if (materials.size === 1) return { kind: 'none', lessonId: null, reason: 'material-only' };
    if (video.course_id) return { kind: 'none', lessonId: null, reason: 'course-only' };
    return { kind: 'ambiguous', lessonId: null, reason: 'video-without-context' };
};

/* =========================================================================
 * SERVER-OWNED SESSION ENTITLEMENT (delivery verification)
 * ========================================================================= */

export type SessionEntitlementDenialReason = PlaybackDenialReason | 'missing' | 'ambiguous-parent' | 'store-unavailable';

export interface SessionEntitlementDecision {
    /** Whether this session is in the scope the entitlement model can bind. */
    required: boolean;
    allowed: boolean;
    reason?: SessionEntitlementDenialReason;
    jti?: string;
    newest?: PlaybackEntitlementRecord;
    /** A valid record is close enough to expiry that refresh must re-issue. */
    needsRenewal: boolean;
}

export interface SessionEntitlementDeps {
    findBySessionId?: (sessionId: string) => Promise<PlaybackEntitlementRecord[]>;
    now: () => number;
    renewBeforeMs?: number;
}

/**
 * Verify the server-owned records for one session. The client presents no
 * token on the existing media URLs, so the server looks the records up by the
 * session id captured at issuance. Every record for the session is considered:
 * a single revocation denies the session, and the newest record that matches
 * tenant + enrollment + the server-resolved lesson must still be unexpired.
 *
 * Sessions outside the per-student entitlement model (preview offers, staff
 * sessions without an enrollment, and videos with no unique lecture) return
 * `required: false`; their existing verified access policy remains the
 * authority. That is recorded as a product question, not silently widened.
 */
export const evaluateSessionEntitlement = async (
    session: { sessionId: string; tenantId?: string; studentEnrollmentId?: string; previewOnly: boolean },
    association: VideoLessonAssociation,
    deps: SessionEntitlementDeps,
): Promise<SessionEntitlementDecision> => {
    const notRequired: SessionEntitlementDecision = { required: false, allowed: true, needsRenewal: false };
    if (session.previewOnly) return notRequired;
    // An ambiguous parent chain has no unique lesson to bind, so a full-content
    // session is denied even when the per-student model would not apply.
    if (association.kind === 'ambiguous') {
        return { required: true, allowed: false, reason: 'ambiguous-parent', needsRenewal: false };
    }
    if (!session.tenantId || !session.studentEnrollmentId) return notRequired;
    if (association.kind !== 'unique' || !association.lessonId) return notRequired;
    if (!deps.findBySessionId) {
        return { required: true, allowed: false, reason: 'store-unavailable', needsRenewal: false };
    }

    let records: PlaybackEntitlementRecord[];
    try {
        records = await deps.findBySessionId(session.sessionId);
    } catch {
        return { required: true, allowed: false, reason: 'store-unavailable', needsRenewal: false };
    }
    records = records.slice().sort((a, b) => b.issuedAtMs - a.issuedAtMs);
    if (records.length === 0) {
        return { required: true, allowed: false, reason: 'missing', needsRenewal: false };
    }

    const revoked = records.find((record) => record.revokedAtMs !== null);
    if (revoked) {
        return { required: true, allowed: false, reason: 'revoked', jti: revoked.jti, newest: revoked, needsRenewal: false };
    }

    const newest = records.find((record) =>
        record.sessionId === session.sessionId
        && record.tenantId === session.tenantId
        && record.studentEnrollmentId === session.studentEnrollmentId
        && record.lessonId === association.lessonId);
    if (!newest) {
        const candidate = records[0];
        const reason: SessionEntitlementDenialReason = candidate.lessonId !== association.lessonId
            ? 'lesson-mismatch'
            : candidate.sessionId !== session.sessionId
                ? 'session-mismatch'
                : candidate.tenantId !== session.tenantId
                    ? 'tenant-mismatch'
                    : 'student-mismatch';
        return { required: true, allowed: false, reason, newest: candidate, needsRenewal: false };
    }

    const nowMs = deps.now();
    if (!Number.isFinite(newest.expiresAtMs) || newest.expiresAtMs <= nowMs) {
        return { required: true, allowed: false, reason: 'expired', jti: newest.jti, newest, needsRenewal: false };
    }

    const renewBeforeMs = deps.renewBeforeMs ?? 120_000;
    return {
        required: true,
        allowed: true,
        jti: newest.jti,
        newest,
        needsRenewal: newest.expiresAtMs - nowMs <= renewBeforeMs,
    };
};

/* =========================================================================
 * DELIVERY ROUTER FACTORY
 * ========================================================================= */

export interface SecureVideoDeliveryDeps {
    authenticate: RequestHandler;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<unknown>;
    getActiveSession: typeof getActiveSession;
    createVideoSession: typeof createVideoSession;
    killSession: typeof killSession;
    isUserSuspended: typeof isUserSuspended;
    generateVideoSessionToken: typeof generateVideoSessionToken;
    verifyVideoSessionToken: typeof verifyVideoSessionToken;
    getClientIp: typeof getClientIp;
    hashValue: typeof hashValue;
    recordViolation: typeof recordViolation;
    getThumbnailUrl: typeof getThumbnailUrl;
    getUserVideoRestrictions: typeof getUserVideoRestrictions;
    inspectDeliveryRequest: typeof inspectDeliveryRequest;
    getObjectBuffer: typeof getObjectBuffer;
    getObjectStream: typeof getObjectStream;
    hasVideoAccess: (userId: string, videoId: string, scope: VideoAccessScope) => Promise<boolean>;
    hasPreviewOffer: (offerId: string | undefined, videoId: string, userId: string) => Promise<boolean>;
    resolveBranch: (
        principal: ResourceBranchPrincipal,
        videoId: string,
        requestedBranchId?: unknown,
    ) => Promise<ResourceBranchDecision>;
    resolveVideoLesson: (videoId: string) => Promise<VideoLessonAssociation>;
    entitlement: PlaybackEntitlementService;
    now: () => number;
    issueEntitlementTtlSeconds?: number;
    renewBeforeMs?: number;
}

/**
 * Build the session / refresh / manifest / media / key routes over injected
 * seams. Production uses the export below; hermetic tests drive THESE handlers
 * with a fake session store, branch decision, lesson association and
 * entitlement records, so the protected-byte path is exercised as a request,
 * not as a copied predicate.
 */
export function createSecureVideoDeliveryRouter(deps: SecureVideoDeliveryDeps): Router {
    const router = Router();
    const {
        queryOne, execute, getActiveSession, createVideoSession, killSession, isUserSuspended,
        generateVideoSessionToken, verifyVideoSessionToken, getClientIp, hashValue, recordViolation,
        getThumbnailUrl, getUserVideoRestrictions, inspectDeliveryRequest, getObjectBuffer, getObjectStream,
    } = deps;

    const checkVideoAccess = (userId: string, videoId: string, scope: VideoAccessScope): Promise<boolean> =>
        deps.hasVideoAccess(userId, videoId, scope);

    const sessionAccessDeps: SessionAccessDeps = {
        hasPreviewOffer: (offerId, videoId, userId) => deps.hasPreviewOffer(offerId, videoId, userId),
        hasVideoAccess: (userId, videoId, scope) => deps.hasVideoAccess(userId, videoId, scope),
    };
    const deliveryAccessDeps: DeliveryAccessDeps = {
        hasVideoAccess: (userId, videoId, scope) => deps.hasVideoAccess(userId, videoId, scope),
        hasPreviewOffer: (offerId, videoId, userId) => deps.hasPreviewOffer(offerId, videoId, userId),
    };

    const enforceVideoBranch = async (
        req: AuthRequest,
        res: Response,
        videoId: string,
        requestedBranchId?: unknown,
    ): Promise<boolean> => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return false;
        }
        const decision = await deps.resolveBranch(principalFromAuthUser(req.user), videoId, requestedBranchId);
        if (decision.kind !== 'allowed') {
            const denial = resourceBranchDenial(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };

    const sessionVideoBranchAllowed = async (
        session: { userId: string; tenantId?: string } | null,
        videoId: string,
    ): Promise<boolean> => {
        if (!session) return false;
        const decision = await deps.resolveBranch(
            { userId: session.userId, tenantId: session.tenantId ?? null, role: 'student' },
            videoId,
        );
        return decision.kind === 'allowed';
    };

    const validateMediaSession = (req: Request, videoId: string) => {
        const token = String(req.query.token || '');
        const sessionId = String(req.query.sid || '');
        const verified = verifyVideoSessionToken(token, req);
        const session = sessionId ? getActiveSession(sessionId) : null;
        const valid = isMediaSessionBound(verified.decoded, session, videoId);
        return { valid, token, sessionId, previewOnly: Boolean(verified.decoded?.po), session };
    };

    const rejectSuspiciousDelivery = async (req: Request, res: Response, videoId: string,
        auth: ReturnType<typeof validateMediaSession>, kind: 'manifest' | 'segment' | 'key') => {
        const inspection = inspectDeliveryRequest(auth.sessionId, kind);
        if (inspection.allowed) return inspection;
        if (auth.session) await recordViolation({
            sessionId: auth.sessionId, userId: auth.session.userId, videoId,
            violationType: 'suspicious_segment_rate', details: inspection.reason,
            ip: getClientIp(req), userAgent: req.headers['user-agent'] || '', confidence: 'high',
        });
        inspection.release();
        res.status(429).json({ error: 'Suspicious media request rate' });
        return null;
    };

    const deliveryEntitlement = async (
        session: { sessionId: string; userId: string; videoId: string; previewOnly: boolean; tenantId?: string; studentEnrollmentId?: string },
        videoId: string,
    ): Promise<SessionEntitlementDecision> => {
        let association: VideoLessonAssociation;
        try {
            association = await deps.resolveVideoLesson(videoId);
        } catch {
            // An unreadable parent chain is a fail-closed delivery error, not a
            // reason to fall back to the token alone.
            return { required: true, allowed: false, reason: 'store-unavailable', needsRenewal: false };
        }
        return evaluateSessionEntitlement(
            {
                sessionId: session.sessionId,
                tenantId: session.tenantId,
                studentEnrollmentId: session.studentEnrollmentId,
                previewOnly: session.previewOnly,
            },
            association,
            {
                findBySessionId: deps.entitlement.findBySessionId
                    ? (sessionId) => deps.entitlement.findBySessionId!(sessionId)
                    : undefined,
                now: deps.now,
                renewBeforeMs: deps.renewBeforeMs,
            },
        );
    };

    const denyDeliveryEntitlement = async (
        res: Response,
        sessionId: string,
        decision: SessionEntitlementDecision,
    ) => {
        await killSession(sessionId, decision.reason === 'ambiguous-parent' ? 'ambiguous_parent' : 'entitlement_denied');
        return res.status(403).json({
            error: 'Video access was revoked',
            code: decision.reason === 'ambiguous-parent' ? 'VIDEO_PARENT_AMBIGUOUS' : 'PLAYBACK_ENTITLEMENT_DENIED',
            reason: decision.reason,
        });
    };

    /**
     * Second half of the delivery authority: the durable session row.
     *
     * The entitlement record answers "may this session still play this
     * lecture"; the `video_sessions` row answers "is this session still alive"
     * for kills that never touch an entitlement (violation, suspension,
     * instructor action) — and it is the only answer another process can see.
     *
     * Fail closed: only `active` is live. `unknown` (no row) means the session
     * was never provably persisted, so it cannot serve even on the process that
     * created it — the process cache is never an alternative authority.
     * `unavailable` (the read failed) denies as well.
     */
    const deliverySessionIsLive = async (sessionId: string): Promise<boolean> => {
        const status = await readDurableSessionStatus(deps, sessionId);
        return status === 'active';
    };

    const denyInactiveDeliverySession = (res: Response) =>
        res.status(401).json({ error: 'session_inactive' });

    const issueSessionEntitlement = async (
        sessionId: string,
        tenantId: string,
        studentEnrollmentId: string,
        lessonId: string,
    ): Promise<boolean> => {
        try {
            const issued = await deps.entitlement.issue(
                { tenantId, lessonId, studentEnrollmentId, sessionId },
                deps.issueEntitlementTtlSeconds ?? PLAYBACK_TOKEN_MAX_TTL_SECONDS,
            );
            return issued.ok;
        } catch {
            // A signing/store failure is never a reason to serve bytes.
            return false;
        }
    };

    /**
     * POST /api/secure-video/session
     * Create a secure video session. Returns session token + watermark seed.
     */
    router.post('/session', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user!.id;
            const { videoId, fingerprint, screenRes } = req.body;
            const offerId: string | undefined = req.body?.offerId ? String(req.body.offerId) : undefined;

            if (!videoId || !fingerprint || !screenRes) {
                return res.status(400).json({ error: 'videoId, fingerprint, screenRes required' });
            }

            // Check suspension
            const suspension = await isUserSuspended(userId);
            if (suspension.suspended) {
                return res.status(403).json({
                    error: 'account_suspended',
                    message: suspension.reason,
                    until: suspension.until
                });
            }

            if (req.user!.role === 'student') {
                const consent = await queryOne(
                    'SELECT id FROM video_security_consents WHERE user_id=? AND terms_version=? LIMIT 1',
                    [userId, VIDEO_TERMS_VERSION]
                );
                if (!consent) return res.status(428).json({
                    error: 'consent_required', code: 'VIDEO_CONSENT_REQUIRED', termsVersion: VIDEO_TERMS_VERSION,
                });
            }

            const ip = getClientIp(req);
            const userAgent = req.headers['user-agent'] || '';

            // Verify the video exists and is playable. There is deliberately NO
            // early tenant-only filter: the requesting tenant and the asset owner
            // are separate facts, and an exact verified license (a purchased
            // lecture or an approved exchange) is the only grant allowed to cross
            // that boundary. Access itself is decided below from server-side rows.
            const video = await queryOne<{
                id: string;
                is_encrypted: boolean | number;
                hls_key: string | null;
                original_key: string | null;
            }>(
                `SELECT v.*, c.name as course_name
                 FROM videos v
                 LEFT JOIN courses c ON v.course_id = c.id
                 WHERE v.id = ? AND v.status = 'ready'`,
                [videoId]
            );

            // Authorize the session with the SAME production access policy, using
            // the authenticated, server-derived scope. A pending preview offer
            // grants only the physically truncated preview — never full content.
            const access = await evaluateSessionAccess(video, {
                userId,
                offerId,
                scope: {
                    tenantId: req.user?.tenantId,
                    studentEnrollmentId: req.user?.studentEnrollmentId,
                },
            }, sessionAccessDeps);
            if (!video || access === 'video_not_found') {
                return res.status(404).json({ error: 'Video not found or not ready' });
            }
            if (!(await enforceVideoBranch(req, res, videoId, req.body?.branch_id))) return;
            if (access === 'preview_unavailable') {
                return res.status(403).json({ error: 'Preview offer is not available' });
            }
            if (access === 'no_access') {
                return res.status(403).json({ error: 'No access to this video' });
            }
            // A pending offer grants the truncated preview only; every other
            // playback grant came from the verified policy above.
            const previewOnly = access === 'preview';

            // The entitlement is bound to ONE server-resolved lecture. A video
            // reachable from several lectures/materials, or whose parent rows
            // disagree, has no unique lesson to bind; deny instead of choosing.
            const association = await deps.resolveVideoLesson(videoId);
            if (!previewOnly && association.kind === 'ambiguous') {
                return res.status(403).json({
                    error: 'No access to this video',
                    code: 'VIDEO_PARENT_AMBIGUOUS',
                    reason: association.reason,
                });
            }

            // Create session. Creation is durable-first: if the row cannot be
            // written it throws, and no token, stream URL or local grant is
            // issued for a session that is not provably persisted.
            let created: { sessionId: string; watermarkSeed: string };
            try {
                created = await createVideoSession({
                    userId,
                    videoId,
                    ip,
                    userAgent,
                    fingerprint,
                    screenRes,
                    previewOnly,
                    offerId: previewOnly ? offerId : undefined,
                    studentEnrollmentId: req.user?.studentEnrollmentId,
                    tenantId: req.user?.tenantId,
                });
            } catch (error) {
                console.error('[SecureVideo] Session persistence failed:', error);
                return res.status(503).json({
                    error: 'Playback temporarily unavailable',
                    code: 'PLAYBACK_UNAVAILABLE',
                });
            }
            const { sessionId, watermarkSeed } = created;

            // Generate short-lived token
            const sessionToken = generateVideoSessionToken({
                userId,
                videoId,
                sessionId,
                ip,
                userAgent,
                fingerprint,
                screenRes,
                previewOnly,
            });

            if (!video.is_encrypted || !video.hls_key || video.hls_key === video.original_key) {
                await killSession(sessionId, 'encrypted_hls_required');
                return res.status(409).json({
                    error: 'Video must be re-uploaded and encrypted before playback',
                    code: 'VIDEO_MIGRATION_REQUIRED',
                });
            }

            // Issue the server-owned entitlement for the unique lesson. The
            // token is never returned to the client; the delivery routes read
            // the record by session id. A secret/store failure fails closed.
            if (association.kind === 'unique' && !previewOnly
                && req.user?.tenantId && req.user?.studentEnrollmentId) {
                const issued = await issueSessionEntitlement(
                    sessionId,
                    req.user.tenantId,
                    req.user.studentEnrollmentId,
                    association.lessonId,
                );
                if (!issued) {
                    await killSession(sessionId, 'entitlement_unavailable');
                    return res.status(503).json({
                        error: 'Playback temporarily unavailable',
                        code: 'PLAYBACK_UNAVAILABLE',
                    });
                }
            }

            const manifestPath = previewOnly ? 'preview/playlist.m3u8' : 'playlist.m3u8';
            const streamUrl = `/api/secure-video/manifest/${encodeURIComponent(videoId)}/${manifestPath}?sid=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(sessionToken)}`;

            const thumbnailUrl = await getThumbnailUrl(videoId);

            // Log access
            await execute(
                `INSERT INTO video_access_logs (video_id, user_id, ip_address, user_agent)
                 VALUES (?, ?, ?, ?)`,
                [videoId, userId, ip, userAgent]
            );

            // Get student info for watermark
            let studentName = '';
            let studentPhone = '';
            let groupName = '';
            try {
                const user = await queryOne<{ name: string | null; phone: string | null }>(
                    'SELECT name, phone FROM users WHERE id = ?',
                    [userId],
                );
                if (user) {
                    studentName = user.name || '';
                    studentPhone = user.phone ? user.phone.slice(-4) : '';
                }
                const student = await queryOne<{ name: string | null; group_name: string | null }>(
                    `SELECT s.name, g.name as group_name FROM students s
                     LEFT JOIN \`groups\` g ON s.group_id = g.id
                     WHERE s.id = ? AND s.user_id = ?`,
                    [req.user?.studentEnrollmentId || '', userId]
                );
                if (student) {
                    studentName = student.name || studentName;
                    groupName = student.group_name || '';
                }
            } catch (e) { /* ignore */ }

            res.json({
                sessionId,
                sessionToken,
                streamUrl,
                thumbnailUrl,
                tokenExpiresIn: 60,
                refreshInterval: 40,
                restrictions: await getUserVideoRestrictions(userId),
                watermark: {
                    seed: watermarkSeed,
                    studentName,
                    studentPhone,
                    groupName,
                    userId: userId.slice(-6),
                    forensicCode: `${sessionId.slice(0, 8)}-${watermarkSeed.slice(0, 8)}`
                }
            });

        } catch (error) {
            console.error('[SecureVideo] Session creation error:', error);
            res.status(500).json({ error: 'Failed to create session' });
        }
    });

    /**
     * POST /api/secure-video/refresh-token
     * Refresh the short-lived session token.
     */
    router.post('/refresh-token', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user!.id;
            const { sessionId, fingerprint, screenRes } = req.body;

            if (!sessionId) {
                return res.status(400).json({ error: 'sessionId required' });
            }

            // Check session is still active
            const session = getActiveSession(sessionId);
            if (!session || session.userId !== userId) {
                return res.status(401).json({ error: 'session_invalid', message: 'Session expired or killed' });
            }
            if (fingerprint !== session.fingerprint || screenRes !== session.screenRes) {
                await recordViolation({ sessionId, userId, videoId: session.videoId, violationType: 'token_reuse',
                    details: 'Device fingerprint or screen binding changed during refresh', ip: getClientIp(req), userAgent: req.headers['user-agent'] || '' });
                await killSession(sessionId, 'device_binding_changed');
                return res.status(401).json({ error: 'device_binding_changed' });
            }

            // Check suspension
            const suspension = await isUserSuspended(userId);
            if (suspension.suspended) {
                await killSession(sessionId, 'user_suspended');
                return res.status(403).json({
                    error: 'account_suspended',
                    message: suspension.reason,
                    until: suspension.until
                });
            }

            // The SAME authorization is rechecked on every refresh: a preview
            // lives only while its offer stays proposed, and every other grant
            // is re-verified by the production policy.
            const stillAllowed = session.previewOnly
                ? await evaluatePreviewOffer(session.offerId, session.videoId, userId, queryOne)
                : await checkVideoAccess(userId, session.videoId, {
                    tenantId: req.user?.tenantId,
                    studentEnrollmentId: req.user?.studentEnrollmentId,
                });
            if (!stillAllowed) {
                await killSession(sessionId, 'access_revoked');
                return res.status(403).json({ error: 'Video access was revoked' });
            }
            if (!(await enforceVideoBranch(req, res, session.videoId))) return;

            // The server-owned entitlement is rechecked on every refresh, so a
            // revoked record or a newly ambiguous parent chain ends the session
            // before a fresh token is minted.
            const association = await deps.resolveVideoLesson(session.videoId);
            const entitlement = await evaluateSessionEntitlement(
                {
                    sessionId,
                    tenantId: session.tenantId,
                    studentEnrollmentId: session.studentEnrollmentId,
                    previewOnly: session.previewOnly,
                },
                association,
                {
                    findBySessionId: deps.entitlement.findBySessionId
                        ? (id) => deps.entitlement.findBySessionId!(id)
                        : undefined,
                    now: deps.now,
                    renewBeforeMs: deps.renewBeforeMs,
                },
            );
            if (!entitlement.allowed) {
                return denyDeliveryEntitlement(res, sessionId, entitlement);
            }
            // A session killed anywhere (another instance, a violation, an
            // operator action) never mints a fresh token.
            if (!(await deliverySessionIsLive(sessionId))) {
                return denyInactiveDeliverySession(res);
            }
            if (entitlement.required && entitlement.needsRenewal
                && association.kind === 'unique' && session.tenantId && session.studentEnrollmentId) {
                const renewed = await issueSessionEntitlement(
                    sessionId,
                    session.tenantId,
                    session.studentEnrollmentId,
                    association.lessonId,
                );
                if (!renewed) {
                    await killSession(sessionId, 'entitlement_unavailable');
                    return res.status(503).json({
                        error: 'Playback temporarily unavailable',
                        code: 'PLAYBACK_UNAVAILABLE',
                    });
                }
            }

            const ip = getClientIp(req);
            const userAgent = req.headers['user-agent'] || '';

            // Check IP consistency
            if (hashValue(ip) !== hashValue(session.ip)) {
                await recordViolation({
                    sessionId,
                    userId,
                    videoId: session.videoId,
                    violationType: 'ip_change',
                    details: `IP changed from ${session.ip} to ${ip}`,
                    ip,
                    userAgent
                });
                // Update session IP (allow once, but log it)
                session.ip = ip;
            }

            // Generate new token
            const sessionToken = generateVideoSessionToken({
                userId,
                videoId: session.videoId,
                sessionId,
                ip,
                userAgent,
                fingerprint: fingerprint || session.fingerprint,
                screenRes: screenRes || session.screenRes,
                previewOnly: session.previewOnly,
            });

            // Refresh stream URL too
            let streamUrl: string | undefined;
            const video = await queryOne<{
                is_encrypted: boolean | number;
                hls_key: string | null;
                original_key: string | null;
            }>('SELECT * FROM videos WHERE id = ?', [session.videoId]);
            if (video) {
                if (video.is_encrypted && video.hls_key && video.hls_key !== video.original_key) {
                    const manifestPath = session.previewOnly ? 'preview/playlist.m3u8' : 'playlist.m3u8';
                    streamUrl = `/api/secure-video/manifest/${encodeURIComponent(session.videoId)}/${manifestPath}?sid=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(sessionToken)}`;
                }
            }

            res.json({
                sessionToken,
                streamUrl,
                tokenExpiresIn: 60,
                refreshInterval: 40,
                restrictions: await getUserVideoRestrictions(userId)
            });

        } catch (error) {
            console.error('[SecureVideo] Token refresh error:', error);
            res.status(500).json({ error: 'Failed to refresh token' });
        }
    });

    router.get('/manifest/:videoId/*', async (req: Request, res: Response) => {
        const videoId = req.params.videoId;
        const relativePath = String(req.params[0] || 'playlist.m3u8').replace(/\\/g, '/');
        const auth = validateMediaSession(req, videoId);
        if (!auth.valid) return res.status(401).json({ error: 'Video session expired' });
        // Recheck the SAME production authorization that issued the session
        // before any URL/token is minted or content is read.
        if (!(await evaluateDeliveryAccess(auth.session!, deliveryAccessDeps))) {
            await killSession(auth.sessionId, 'access_revoked');
            return res.status(403).json({ error: 'Video access was revoked' });
        }
        // The parent-derived branch decision is part of delivery authorization,
        // not just session issuance: a branch-owned asset is never served on a
        // tenant/exact-resource grant alone, and an ambiguous chain denies.
        if (!(await sessionVideoBranchAllowed(auth.session, videoId))) {
            await killSession(auth.sessionId, 'access_revoked');
            return res.status(403).json({ error: 'Video access was revoked' });
        }
        // The server-owned entitlement + revocation is checked on every byte
        // request, not only at issuance/heartbeat.
        const entitlement = await deliveryEntitlement(auth.session!, videoId);
        if (!entitlement.allowed) return denyDeliveryEntitlement(res, auth.sessionId, entitlement);
        if (!(await deliverySessionIsLive(auth.sessionId))) return denyInactiveDeliverySession(res);
        const delivery = await rejectSuspiciousDelivery(req, res, videoId, auth, 'manifest');
        if (!delivery) return;
        if (auth.previewOnly && !relativePath.startsWith('preview/')) return res.status(403).json({ error: 'Preview session cannot access full media' });
        if (!/^(?:preview\/)?(?:[A-Za-z0-9_-]+\/)?playlist\.m3u8$/.test(relativePath)) return res.status(400).json({ error: 'Invalid manifest path' });
        try {
            const body = (await getObjectBuffer(BUCKETS.HLS, `${videoId}/${relativePath}`)).toString('utf8');
            const baseDir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/') + 1) : '';
            const sessionQuery = `sid=${encodeURIComponent(auth.sessionId)}&token=${encodeURIComponent(auth.token)}`;
            const rewritten = body.split(/\r?\n/).map(line => {
                if (!line) return line;
                if (line.startsWith('#EXT-X-KEY')) {
                    return line.replace(/URI="[^"]+"/, `URI="/api/secure-video/key/${encodeURIComponent(videoId)}?${sessionQuery}"`);
                }
                if (line.startsWith('#')) return line;
                const clean = line.split('?')[0].replace(/^\.\//, '');
                const childPath = `${baseDir}${clean}`;
                return clean.endsWith('.m3u8')
                    ? `/api/secure-video/manifest/${encodeURIComponent(videoId)}/${childPath}?${sessionQuery}`
                    : `/api/secure-video/media/${encodeURIComponent(videoId)}?path=${encodeURIComponent(childPath)}&${sessionQuery}`;
            }).join('\n');
            res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-store' });
            res.send(rewritten);
        } catch (error) {
            console.error('[SecureVideo] Manifest proxy failed:', error);
            res.status(404).json({ error: 'Manifest not found' });
        }
    });

    router.get('/media/:videoId', async (req: Request, res: Response) => {
        const videoId = req.params.videoId;
        const relativePath = String(req.query.path || '').replace(/\\/g, '/');
        const auth = validateMediaSession(req, videoId);
        if (!auth.valid) return res.status(401).json({ error: 'Video session expired' });
        // Recheck the SAME production authorization that issued the session
        // before any segment content is read.
        if (!(await evaluateDeliveryAccess(auth.session!, deliveryAccessDeps))) {
            await killSession(auth.sessionId, 'access_revoked');
            return res.status(403).json({ error: 'Video access was revoked' });
        }
        // The parent-derived branch decision is part of delivery authorization,
        // not just session issuance: a branch-owned asset is never served on a
        // tenant/exact-resource grant alone, and an ambiguous chain denies.
        if (!(await sessionVideoBranchAllowed(auth.session, videoId))) {
            await killSession(auth.sessionId, 'access_revoked');
            return res.status(403).json({ error: 'Video access was revoked' });
        }
        const entitlement = await deliveryEntitlement(auth.session!, videoId);
        if (!entitlement.allowed) return denyDeliveryEntitlement(res, auth.sessionId, entitlement);
        if (!(await deliverySessionIsLive(auth.sessionId))) return denyInactiveDeliverySession(res);
        const delivery = await rejectSuspiciousDelivery(req, res, videoId, auth, 'segment');
        if (!delivery) return;
        if (auth.previewOnly && !relativePath.startsWith('preview/')) return res.status(403).json({ error: 'Preview session cannot access full media' });
        if (!/^(?:preview\/)?[A-Za-z0-9_-]+\/segment_\d+\.ts$/.test(relativePath)) return res.status(400).json({ error: 'Invalid media path' });
        try {
            const stream = await getObjectStream(BUCKETS.HLS, `${videoId}/${relativePath}`);
            res.set({ 'Content-Type': 'video/mp2t', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'none' });
            let released = false;
            const release = () => { if (!released) { released = true; delivery.release(); } };
            stream.on('error', () => { release(); res.end(); });
            stream.on('end', release);
            res.on('close', release);
            stream.pipe(res);
        } catch {
            delivery.release();
            res.status(404).json({ error: 'Media segment not found' });
        }
    });

    /**
     * GET /api/secure-video/key/:videoId
     * Serve encryption key ONLY with valid session token
     */
    router.get('/key/:videoId', async (req: Request, res: Response) => {
        try {
            const { videoId } = req.params;
            const sessionToken = req.query.token as string;
            const sessionId = req.query.sid as string;

            if (!sessionToken || !sessionId) {
                return res.status(401).json({ error: 'Token and session required' });
            }

            // Verify token
            const tokenResult = verifyVideoSessionToken(sessionToken, req);
            if (!tokenResult.valid) {
                return res.status(401).json({ error: 'Invalid session token' });
            }

            // Verify session is active and bound to exactly this asset
            const session = getActiveSession(sessionId);
            if (!session || !isMediaSessionBound(tokenResult.decoded, session, videoId)) {
                return res.status(401).json({ error: 'Session expired' });
            }
            // Recheck the SAME production authorization that issued the session
            // before the encryption key leaves the server.
            if (!(await evaluateDeliveryAccess(session, deliveryAccessDeps))) {
                await killSession(sessionId, 'access_revoked');
                return res.status(403).json({ error: 'Video access was revoked' });
            }
            if (!(await sessionVideoBranchAllowed(session, videoId))) {
                await killSession(sessionId, 'access_revoked');
                return res.status(403).json({ error: 'Video access was revoked' });
            }
            const entitlement = await deliveryEntitlement(session, videoId);
            if (!entitlement.allowed) return denyDeliveryEntitlement(res, sessionId, entitlement);
            if (!(await deliverySessionIsLive(sessionId))) return denyInactiveDeliverySession(res);
            const delivery = await rejectSuspiciousDelivery(req, res, videoId, validateMediaSession(req, videoId), 'key');
            if (!delivery) return;

            // Get encryption key
            const video = await queryOne<{ is_encrypted: boolean | number; encryption_key: string | null }>(
                'SELECT encryption_key, is_encrypted FROM videos WHERE id = ?',
                [videoId]
            );

            if (!video || !video.is_encrypted || !video.encryption_key) {
                return res.status(400).json({ error: 'Video not encrypted' });
            }

            const keyBuffer = Buffer.from(video.encryption_key, 'hex');

            res.set({
                'Content-Type': 'application/octet-stream',
                'Content-Length': keyBuffer.length.toString(),
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || 'https://elka2d.cloud',
            });

            res.send(keyBuffer);

        } catch (error) {
            console.error('[SecureVideo] Key delivery error:', error);
            res.status(500).json({ error: 'Key delivery failed' });
        }
    });

    return router;
}

/* =========================================================================
 * Production wiring (same paths and client contract as before)
 * ========================================================================= */

const productionDeliveryDeps: SecureVideoDeliveryDeps = {
    authenticate: authenticateToken,
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => queryOne<T>(sql, params),
    execute: (sql: string, params?: unknown[]) => execute(sql, params),
    getActiveSession,
    createVideoSession,
    killSession,
    isUserSuspended,
    generateVideoSessionToken,
    verifyVideoSessionToken,
    getClientIp,
    hashValue,
    recordViolation,
    getThumbnailUrl,
    getUserVideoRestrictions,
    inspectDeliveryRequest,
    getObjectBuffer,
    getObjectStream,
    hasVideoAccess: (userId, videoId, scope) => checkVideoAccess(userId, videoId, scope),
    hasPreviewOffer: (offerId, videoId, userId) => evaluatePreviewOffer(offerId, videoId, userId, queryOne),
    resolveBranch: (principal, videoId, requestedBranchId) => resolveResourceBranchAccess(
        getResourceBranchDeps(),
        principal,
        { resourceType: 'video', resourceId: videoId, requestedBranchId },
    ),
    resolveVideoLesson: (videoId) => resolveVideoLessonAssociation(videoId, { query, queryOne }),
    entitlement: createPlaybackEntitlementService({
        store: createSqlPlaybackEntitlementStore({ query, queryOne, execute }),
        // Same dedicated secret as the issuance/heartbeat surface. No
        // JWT_SECRET fallback: a missing secret denies delivery.
        getSecret: () => process.env.VIDEO_PLAYBACK_SECRET,
    }),
    now: () => Date.now(),
    issueEntitlementTtlSeconds: PLAYBACK_TOKEN_MAX_TTL_SECONDS,
};

router.use(createSecureVideoDeliveryRouter(productionDeliveryDeps));

/**
 * Lifecycle integration request (owner: Codex — the server process bootstrap,
 * which owns `index.ts` and the runtime that mounts this router).
 *
 * This route owns video sessions (the only surface that creates and kills
 * them) and therefore owns the dead-session sweep's public contract:
 * `startDeadSessionCleanup` / `stopDeadSessionCleanup` are defined in
 * `../services/video-security` as an explicit start/stop lifecycle. They are
 * NOT started here. Starting the sweep on router import would schedule a timer
 * merely from being imported, which is forbidden: an import side effect must
 * never spin up a timer or a service.
 *
 * The owning process MUST call `startDeadSessionCleanup()` exactly once during
 * bootstrap (after the router is mounted) and `stopDeadSessionCleanup()` during
 * graceful shutdown. This route deliberately exposes no import-time side effect
 * and starts no timer of its own; it only names the integration points. No
 * `index.ts` edit, no timer, and no service execution is performed here.
 */

export default router;
