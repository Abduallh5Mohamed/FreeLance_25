"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVideoSession = createVideoSession;
exports.killSession = killSession;
exports.getActiveSession = getActiveSession;
exports.recordHeartbeat = recordHeartbeat;
exports.cleanupDeadSessions = cleanupDeadSessions;
exports.recordViolation = recordViolation;
exports.isUserSuspended = isUserSuspended;
exports.getUserActiveSessionId = getUserActiveSessionId;
/**
 * Video Security Engine
 * - Violation scoring per user session
 * - Temporary account suspension
 * - Session kill
 * - Heartbeat monitoring
 * - Concurrent session detection
 */
const db_1 = require("../db");
const uuid_1 = require("uuid");
const crypto_1 = __importDefault(require("crypto"));
// ═══════════════════════════════════════
// VIOLATION SCORING WEIGHTS
// ═══════════════════════════════════════
const VIOLATION_WEIGHTS = {
    devtools_open: 3,
    token_reuse: 4,
    ip_change: 3,
    suspicious_segment_rate: 3,
    fullscreen_exit: 1,
    heartbeat_loss: 5,
    screen_capture_attempt: 4,
    debugger_detected: 4,
    console_tamper: 3,
    dom_mutation: 2,
    visibility_change: 1,
    multi_tab: 2,
    abnormal_playback: 2,
    media_recorder_detected: 5,
    print_screen: 5,
};
// Threshold for auto-suspension
const SUSPENSION_THRESHOLD = parseInt(process.env.VIOLATION_THRESHOLD || '10');
const SUSPENSION_DURATION_MINUTES = parseInt(process.env.SUSPENSION_DURATION || '30');
const activeSessions = new Map();
const userSessionMap = new Map(); // userId -> sessionId (only 1 allowed)
// ═══════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════
/**
 * Create a new video session.
 * Kills any existing session for this user.
 */
async function createVideoSession(params) {
    const { userId, videoId, ip, userAgent, fingerprint, screenRes } = params;
    // Kill existing session for this user
    const existingSessionId = userSessionMap.get(userId);
    if (existingSessionId) {
        await killSession(existingSessionId, 'new_session_started');
    }
    const sessionId = (0, uuid_1.v4)();
    const watermarkSeed = crypto_1.default.randomBytes(16).toString('hex');
    const session = {
        sessionId,
        userId,
        videoId,
        ip,
        userAgent,
        fingerprint,
        screenRes,
        createdAt: Date.now(),
        lastHeartbeat: Date.now(),
        violationScore: 0,
        isActive: true,
    };
    activeSessions.set(sessionId, session);
    userSessionMap.set(userId, sessionId);
    // Persist to DB
    try {
        await (0, db_1.execute)(`INSERT INTO video_sessions 
             (id, user_id, video_id, ip_address, user_agent, fingerprint, screen_resolution, watermark_seed, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())`, [sessionId, userId, videoId, ip, userAgent, fingerprint, screenRes, watermarkSeed]);
    }
    catch (e) {
        console.error('[Security] Failed to persist session:', e);
    }
    console.log(`[Security] Session created: ${sessionId} for user ${userId}`);
    return { sessionId, watermarkSeed };
}
/**
 * Kill a session - invalidate immediately
 */
async function killSession(sessionId, reason) {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.isActive = false;
        activeSessions.delete(sessionId);
        userSessionMap.delete(session.userId);
    }
    try {
        await (0, db_1.execute)(`UPDATE video_sessions SET is_active = 0, killed_reason = ?, killed_at = NOW() WHERE id = ?`, [reason, sessionId]);
    }
    catch (e) {
        console.error('[Security] Failed to update session in DB:', e);
    }
    console.log(`[Security] Session killed: ${sessionId} reason: ${reason}`);
}
/**
 * Validate session is still active
 */
function getActiveSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.isActive)
        return null;
    return session;
}
/**
 * Record heartbeat
 */
function recordHeartbeat(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.isActive)
        return false;
    session.lastHeartbeat = Date.now();
    return true;
}
/**
 * Check for dead sessions (no heartbeat for 15 seconds)
 */
function cleanupDeadSessions() {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
        if (now - session.lastHeartbeat > 15000 && session.isActive) {
            console.log(`[Security] Dead session detected: ${id} (no heartbeat for 15s)`);
            killSession(id, 'heartbeat_timeout');
        }
    }
}
// Run cleanup every 10 seconds
setInterval(cleanupDeadSessions, 10000);
// ═══════════════════════════════════════
// VIOLATION SCORING
// ═══════════════════════════════════════
/**
 * Record a violation and update score.
 * Returns { suspended: boolean, score: number, action: string }
 */
async function recordViolation(params) {
    const { sessionId, userId, videoId, violationType, details, ip, userAgent } = params;
    const weight = VIOLATION_WEIGHTS[violationType] || 1;
    const session = activeSessions.get(sessionId);
    let totalScore = weight;
    if (session) {
        session.violationScore += weight;
        totalScore = session.violationScore;
    }
    // Log to DB
    try {
        await (0, db_1.execute)(`INSERT INTO video_security_logs 
             (id, user_id, video_id, activity_type, ip_address, user_agent, details, session_id, violation_score, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`, [(0, uuid_1.v4)(), userId, videoId, violationType, ip || 'unknown', userAgent || 'unknown',
            details || null, sessionId, totalScore]);
    }
    catch (e) {
        console.error('[Security] Failed to log violation:', e);
    }
    let action = 'logged';
    let suspended = false;
    let killed = false;
    // Check if threshold exceeded
    if (totalScore >= SUSPENSION_THRESHOLD) {
        // Kill session
        await killSession(sessionId, `violation_threshold_exceeded (score: ${totalScore})`);
        killed = true;
        // Suspend account temporarily
        try {
            const suspendUntil = new Date(Date.now() + SUSPENSION_DURATION_MINUTES * 60 * 1000);
            await (0, db_1.execute)(`UPDATE users SET suspended_until = ?, suspension_reason = ? WHERE id = ?`, [suspendUntil, `تم تعليق الحساب مؤقتاً بسبب محاولات مشبوهة (نقاط المخالفات: ${totalScore})`, userId]);
            suspended = true;
            action = 'suspended';
            console.log(`[Security] User ${userId} SUSPENDED until ${suspendUntil.toISOString()}`);
        }
        catch (e) {
            console.error('[Security] Failed to suspend user:', e);
            action = 'session_killed';
        }
    }
    else if (totalScore >= SUSPENSION_THRESHOLD * 0.7) {
        // Warning zone
        action = 'warning';
    }
    console.log(`[Security] Violation: ${violationType} user=${userId} score=${totalScore}/${SUSPENSION_THRESHOLD} action=${action}`);
    return { suspended, score: totalScore, action, killed };
}
/**
 * Check if user is suspended
 */
async function isUserSuspended(userId) {
    try {
        const user = await (0, db_1.queryOne)('SELECT suspended_until, suspension_reason FROM users WHERE id = ?', [userId]);
        if (!user || !user.suspended_until) {
            return { suspended: false };
        }
        const now = new Date();
        const until = new Date(user.suspended_until);
        if (until > now) {
            return { suspended: true, until, reason: user.suspension_reason };
        }
        // Suspension expired, clear it
        await (0, db_1.execute)('UPDATE users SET suspended_until = NULL, suspension_reason = NULL WHERE id = ?', [userId]);
        return { suspended: false };
    }
    catch (e) {
        console.error('[Security] Failed to check suspension:', e);
        return { suspended: false };
    }
}
/**
 * Get user's active session ID (for external checks)
 */
function getUserActiveSessionId(userId) {
    return userSessionMap.get(userId) || null;
}
