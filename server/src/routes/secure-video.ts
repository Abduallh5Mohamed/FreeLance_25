/**
 * Secure Video Streaming Routes
 * - JWT-protected session creation
 * - Token-bound segment proxy
 * - Heartbeat endpoint
 * - Violation reporting & kill-session
 * - HLS key delivery via signed session
 */
import { Router, Request, Response } from 'express';
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
    inspectDeliveryRequest
} from '../services/video-security';
import { getThumbnailUrl, getObjectBuffer, getObjectStream, BUCKETS } from '../services/minio';
import { createNotification } from '../utils/notifications';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';
import { createSqlVideoAccessRepository, evaluateVideoAccess, type VideoAccessScope } from '../security/video-access-policy';

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
 * POST /api/secure-video/session
 * Create a secure video session. Returns session token + watermark seed.
 */
router.post('/session', authenticateToken, async (req: AuthRequest, res: Response) => {
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
        if (access === 'preview_unavailable') {
            return res.status(403).json({ error: 'Preview offer is not available' });
        }
        if (access === 'no_access') {
            return res.status(403).json({ error: 'No access to this video' });
        }
        // A pending offer grants the truncated preview only; every other
        // playback grant came from the verified policy above.
        const previewOnly = access === 'preview';

        // Create session
        const { sessionId, watermarkSeed } = await createVideoSession({
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
            const user = await queryOne('SELECT name, phone FROM users WHERE id = ?', [userId]);
            if (user) {
                studentName = user.name || '';
                studentPhone = user.phone ? user.phone.slice(-4) : '';
            }
            const student = await queryOne(
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

// ═══════════════════════════════════════
// TOKEN REFRESH
// ═══════════════════════════════════════

/**
 * POST /api/secure-video/refresh-token
 * Refresh the short-lived session token
 */
router.post('/refresh-token', authenticateToken, async (req: AuthRequest, res: Response) => {
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
        const video = await queryOne('SELECT * FROM videos WHERE id = ?', [session.videoId]);
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

function validateMediaSession(req: Request, videoId: string) {
    const token = String(req.query.token || '');
    const sessionId = String(req.query.sid || '');
    const verified = verifyVideoSessionToken(token, req);
    const session = sessionId ? getActiveSession(sessionId) : null;
    const valid = isMediaSessionBound(verified.decoded, session, videoId);
    return { valid, token, sessionId, previewOnly: Boolean(verified.decoded?.po), session };
}

async function rejectSuspiciousDelivery(req: Request, res: Response, videoId: string,
    auth: ReturnType<typeof validateMediaSession>, kind: 'manifest' | 'segment' | 'key') {
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
}

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

const deliveryAccessDeps: DeliveryAccessDeps = {
    hasVideoAccess: (userId, videoId, scope) => checkVideoAccess(userId, videoId, scope),
    hasPreviewOffer: (offerId, videoId, userId) => evaluatePreviewOffer(offerId, videoId, userId, queryOne),
};

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
        const delivery = await rejectSuspiciousDelivery(req, res, videoId, validateMediaSession(req, videoId), 'key');
        if (!delivery) return;

        // Get encryption key
        const video = await queryOne(
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

const sessionAccessDeps: SessionAccessDeps = {
    hasPreviewOffer: (offerId, videoId, userId) => evaluatePreviewOffer(offerId, videoId, userId, queryOne),
    hasVideoAccess: (userId, videoId, scope) => checkVideoAccess(userId, videoId, scope),
};

export default router;
