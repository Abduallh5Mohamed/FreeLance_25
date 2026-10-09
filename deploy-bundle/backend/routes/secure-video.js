"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Secure Video Streaming Routes
 * - JWT-protected session creation
 * - Token-bound segment proxy
 * - Heartbeat endpoint
 * - Violation reporting & kill-session
 * - HLS key delivery via signed session
 */
const express_1 = require("express");
const db_1 = require("../db");
const uuid_1 = require("uuid");
const auth_1 = require("../middleware/auth");
const video_security_1 = require("../services/video-security");
const minio_1 = require("../services/minio");
const router = (0, express_1.Router)();
// ═══════════════════════════════════════
// SESSION CREATION (Requires Auth)
// ═══════════════════════════════════════
/**
 * POST /api/secure-video/session
 * Create a secure video session. Returns session token + watermark seed.
 */
router.post('/session', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { videoId, fingerprint, screenRes } = req.body;
        if (!videoId || !fingerprint || !screenRes) {
            return res.status(400).json({ error: 'videoId, fingerprint, screenRes required' });
        }
        // Check suspension
        const suspension = await (0, video_security_1.isUserSuspended)(userId);
        if (suspension.suspended) {
            return res.status(403).json({
                error: 'account_suspended',
                message: suspension.reason,
                until: suspension.until
            });
        }
        const ip = (0, auth_1.getClientIp)(req);
        const userAgent = req.headers['user-agent'] || '';
        // Verify video exists and user has access
        const video = await (0, db_1.queryOne)(`SELECT v.*, c.name as course_name 
             FROM videos v
             LEFT JOIN courses c ON v.course_id = c.id
             WHERE v.id = ? AND v.status = 'ready'`, [videoId]);
        if (!video) {
            return res.status(404).json({ error: 'Video not found or not ready' });
        }
        // Check access
        const hasAccess = await checkVideoAccess(userId, video.course_id);
        if (!hasAccess) {
            return res.status(403).json({ error: 'No access to this video' });
        }
        // Create session
        const { sessionId, watermarkSeed } = await (0, video_security_1.createVideoSession)({
            userId,
            videoId,
            ip,
            userAgent,
            fingerprint,
            screenRes
        });
        // Generate short-lived token
        const sessionToken = (0, auth_1.generateVideoSessionToken)({
            userId,
            videoId,
            sessionId,
            ip,
            userAgent,
            fingerprint,
            screenRes
        });
        // Get streaming URL
        let streamUrl;
        if (video.hls_key && video.hls_key !== video.original_key) {
            streamUrl = await (0, minio_1.getSignedStreamUrl)(videoId, 'playlist.m3u8');
        }
        else {
            streamUrl = await (0, minio_1.getSignedStreamUrl)(videoId, video.original_key, minio_1.BUCKETS.ORIGINALS);
        }
        const thumbnailUrl = await (0, minio_1.getThumbnailUrl)(videoId);
        // Log access
        await (0, db_1.execute)(`INSERT INTO video_access_logs (video_id, user_id, ip_address, user_agent)
             VALUES (?, ?, ?, ?)`, [videoId, userId, ip, userAgent]);
        // Get student info for watermark
        let studentName = '';
        let studentPhone = '';
        let groupName = '';
        try {
            const user = await (0, db_1.queryOne)('SELECT name, phone FROM users WHERE id = ?', [userId]);
            if (user) {
                studentName = user.name || '';
                studentPhone = user.phone ? user.phone.slice(-4) : '';
            }
            const student = await (0, db_1.queryOne)(`SELECT s.name, g.name as group_name FROM students s 
                 LEFT JOIN \`groups\` g ON s.group_id = g.id
                 WHERE s.phone = ?`, [user?.phone]);
            if (student) {
                studentName = student.name || studentName;
                groupName = student.group_name || '';
            }
        }
        catch (e) { /* ignore */ }
        res.json({
            sessionId,
            sessionToken,
            streamUrl,
            thumbnailUrl,
            tokenExpiresIn: 120, // 2 minutes
            refreshInterval: 90, // Refresh every 90 seconds
            watermark: {
                seed: watermarkSeed,
                studentName,
                studentPhone,
                groupName,
                userId: userId.slice(-6)
            }
        });
    }
    catch (error) {
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
router.post('/refresh-token', auth_1.authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { sessionId, fingerprint, screenRes } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        // Check session is still active
        const session = (0, video_security_1.getActiveSession)(sessionId);
        if (!session || session.userId !== userId) {
            return res.status(401).json({ error: 'session_invalid', message: 'Session expired or killed' });
        }
        // Check suspension
        const suspension = await (0, video_security_1.isUserSuspended)(userId);
        if (suspension.suspended) {
            await (0, video_security_1.killSession)(sessionId, 'user_suspended');
            return res.status(403).json({
                error: 'account_suspended',
                message: suspension.reason,
                until: suspension.until
            });
        }
        const ip = (0, auth_1.getClientIp)(req);
        const userAgent = req.headers['user-agent'] || '';
        // Check IP consistency
        if ((0, auth_1.hashValue)(ip) !== (0, auth_1.hashValue)(session.ip)) {
            await (0, video_security_1.recordViolation)({
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
        const sessionToken = (0, auth_1.generateVideoSessionToken)({
            userId,
            videoId: session.videoId,
            sessionId,
            ip,
            userAgent,
            fingerprint: fingerprint || session.fingerprint,
            screenRes: screenRes || session.screenRes
        });
        // Refresh stream URL too
        let streamUrl;
        const video = await (0, db_1.queryOne)('SELECT * FROM videos WHERE id = ?', [session.videoId]);
        if (video) {
            if (video.hls_key && video.hls_key !== video.original_key) {
                streamUrl = await (0, minio_1.getSignedStreamUrl)(session.videoId, 'playlist.m3u8');
            }
            else {
                streamUrl = await (0, minio_1.getSignedStreamUrl)(session.videoId, video.original_key, minio_1.BUCKETS.ORIGINALS);
            }
        }
        res.json({
            sessionToken,
            streamUrl,
            tokenExpiresIn: 120
        });
    }
    catch (error) {
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
router.post('/heartbeat', async (req, res) => {
    try {
        const { sessionId, sessionToken } = req.body;
        if (!sessionId || !sessionToken) {
            return res.status(400).json({ error: 'sessionId and sessionToken required' });
        }
        // Verify token
        const tokenResult = (0, auth_1.verifyVideoSessionToken)(sessionToken, req);
        if (!tokenResult.valid) {
            return res.status(401).json({
                error: 'token_invalid',
                reason: tokenResult.reason
            });
        }
        // Record heartbeat
        const alive = (0, video_security_1.recordHeartbeat)(sessionId);
        if (!alive) {
            return res.status(401).json({
                error: 'session_dead',
                message: 'Session no longer active'
            });
        }
        res.json({ ok: true, ts: Date.now() });
    }
    catch (error) {
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
router.post('/report-violation', async (req, res) => {
    try {
        const { sessionId, sessionToken, violationType, details } = req.body;
        if (!sessionId || !violationType) {
            return res.status(400).json({ error: 'sessionId, violationType required' });
        }
        const session = (0, video_security_1.getActiveSession)(sessionId);
        if (!session) {
            return res.json({ action: 'session_already_dead' });
        }
        const ip = (0, auth_1.getClientIp)(req);
        const userAgent = req.headers['user-agent'] || '';
        const result = await (0, video_security_1.recordViolation)({
            sessionId,
            userId: session.userId,
            videoId: session.videoId,
            violationType,
            details,
            ip,
            userAgent
        });
        res.json({
            action: result.action,
            score: result.score,
            killed: result.killed,
            suspended: result.suspended
        });
    }
    catch (error) {
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
router.post('/kill-session', async (req, res) => {
    try {
        const { sessionId, reason } = req.body;
        if (!sessionId) {
            return res.status(400).json({ error: 'sessionId required' });
        }
        await (0, video_security_1.killSession)(sessionId, reason || 'client_requested');
        res.json({ ok: true });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to kill session' });
    }
});
// ═══════════════════════════════════════
// SECURE KEY DELIVERY
// ═══════════════════════════════════════
/**
 * GET /api/secure-video/key/:videoId
 * Serve encryption key ONLY with valid session token
 */
router.get('/key/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const sessionToken = req.query.token;
        const sessionId = req.query.sid;
        if (!sessionToken || !sessionId) {
            return res.status(401).json({ error: 'Token and session required' });
        }
        // Verify token
        const tokenResult = (0, auth_1.verifyVideoSessionToken)(sessionToken, req);
        if (!tokenResult.valid) {
            return res.status(401).json({ error: 'Invalid session token' });
        }
        // Verify session is active
        const session = (0, video_security_1.getActiveSession)(sessionId);
        if (!session) {
            return res.status(401).json({ error: 'Session expired' });
        }
        // Get encryption key
        const video = await (0, db_1.queryOne)('SELECT encryption_key, is_encrypted FROM videos WHERE id = ?', [videoId]);
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
    }
    catch (error) {
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
router.post('/security/log', async (req, res) => {
    try {
        const { userId, videoId, activityType, details, sessionId } = req.body;
        if (!userId || !activityType) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        const ip = (0, auth_1.getClientIp)(req);
        const userAgent = req.headers['user-agent'] || '';
        await (0, db_1.execute)(`INSERT INTO video_security_logs 
             (id, user_id, video_id, activity_type, ip_address, user_agent, details, session_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`, [(0, uuid_1.v4)(), userId, videoId || null, activityType, ip, userAgent, details || null, sessionId || null]);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: 'Log failed' });
    }
});
// ═══════════════════════════════════════
// ACCESS CHECK (reused from videos.ts)
// ═══════════════════════════════════════
async function checkVideoAccess(userId, courseId) {
    const user = await (0, db_1.queryOne)('SELECT id, role, phone FROM users WHERE id = ?', [userId]);
    if (!user)
        return false;
    if (user.role === 'admin' || user.role === 'teacher')
        return true;
    const student = await (0, db_1.queryOne)('SELECT id FROM students WHERE phone = ? AND is_active = TRUE', [user.phone]);
    return !!student;
}
exports.default = router;
