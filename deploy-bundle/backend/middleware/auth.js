"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticateToken = void 0;
exports.generateVideoSessionToken = generateVideoSessionToken;
exports.verifyVideoSessionToken = verifyVideoSessionToken;
exports.getClientIp = getClientIp;
exports.hashValue = hashValue;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const JWT_SECRET = process.env.JWT_SECRET || 'secret';
/**
 * Basic JWT authentication - verifies token and attaches user
 */
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.user = {
            id: decoded.id,
            email: decoded.email || null,
            phone: decoded.phone || null,
            role: decoded.role
        };
        next();
    }
    catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: 'Invalid token' });
    }
};
exports.authenticateToken = authenticateToken;
/**
 * Generate a short-lived video session token (2 minutes)
 * Bound to: userId, IP, userAgent, screenRes, fingerprint
 */
function generateVideoSessionToken(payload) {
    return jsonwebtoken_1.default.sign({
        sub: payload.userId,
        vid: payload.videoId,
        sid: payload.sessionId,
        ip: hashValue(payload.ip),
        ua: hashValue(payload.userAgent),
        fp: payload.fingerprint,
        sr: payload.screenRes,
        type: 'video_session'
    }, JWT_SECRET, { expiresIn: '2m' });
}
/**
 * Verify video session token and check binding
 */
function verifyVideoSessionToken(token, req) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        if (decoded.type !== 'video_session') {
            return { valid: false, reason: 'Invalid token type' };
        }
        // Check IP binding
        const currentIp = getClientIp(req);
        if (decoded.ip !== hashValue(currentIp)) {
            return { valid: false, reason: 'IP mismatch', decoded };
        }
        // Check User-Agent binding
        const currentUA = req.headers['user-agent'] || '';
        if (decoded.ua !== hashValue(currentUA)) {
            return { valid: false, reason: 'User-Agent mismatch', decoded };
        }
        return { valid: true, decoded };
    }
    catch (error) {
        if (error.name === 'TokenExpiredError') {
            return { valid: false, reason: 'Token expired' };
        }
        return { valid: false, reason: 'Invalid token' };
    }
}
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.ip || 'unknown';
}
function hashValue(val) {
    return crypto_1.default.createHash('sha256').update(val).digest('hex').substring(0, 16);
}
