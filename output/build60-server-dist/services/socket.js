"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionNotify = exports.setupSocketIO = exports.createSocketIO = exports.createSocketPrincipalResolver = exports.getIO = void 0;
exports.verifySocketPrincipal = verifySocketPrincipal;
const socket_io_1 = require("socket.io");
const db_1 = require("../db");
const notifications_1 = require("../utils/notifications");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const auth_1 = require("../middleware/auth");
const principal_repository_1 = require("../security/principal-repository");
const message_access_policy_1 = require("../security/message-access-policy");
// Global reference to io instance for use by REST routes
let ioInstance = null;
const getIO = () => ioInstance;
exports.getIO = getIO;
function verifySocketPrincipal(token) {
    const principal = jsonwebtoken_1.default.verify(token, (0, auth_1.getJwtSecret)(), { algorithms: ['HS256'] });
    const allowedRoles = new Set(['admin', 'instructor', 'teacher', 'staff', 'student', 'parent']);
    if (typeof principal.id !== 'string' || !principal.id ||
        typeof principal.role !== 'string' || !allowedRoles.has(principal.role)) {
        throw new Error('Invalid token claims');
    }
    return { id: principal.id, role: principal.role };
}
/**
 * Resolve the CURRENT principal behind a raw socket token by driving the
 * production authentication middleware (identity liveness, token version,
 * time-bound suspension) over an injected repository. Returns null for
 * missing, invalid, revoked, or suspended tokens so the handshake fails
 * closed — socket auth can never be weaker than REST auth.
 */
const createSocketPrincipalResolver = (repository = principal_repository_1.defaultPrincipalRepository) => async (token) => {
    const authenticate = (0, auth_1.createAuthenticateToken)(repository);
    const request = {
        headers: { authorization: `Bearer ${token}` },
        method: 'GET',
        originalUrl: '/socket',
    };
    let settle;
    const response = {
        status(code) { response.statusCode = code; return response; },
        json() {
            // A middleware denial answers instead of calling next():
            // settle to no principal so the handshake fails closed.
            settle?.(null);
            return response;
        },
    };
    return new Promise((resolve) => {
        const done = resolve;
        settle = done;
        void authenticate(request, response, (() => {
            const user = request.user;
            done(user ? { id: user.id, role: user.role } : null);
        })).catch(() => done(null));
    });
};
exports.createSocketPrincipalResolver = createSocketPrincipalResolver;
/**
 * Two users may exchange messages only when a server-side relation exists:
 * an active membership in the same active tenant, or an active
 * teacher-student enrollment between them. Anything else (including every
 * cross-tenant pair) is denied before any row is written.
 *
 * Users allowed to observe a principal's presence: members of the same
 * active tenant plus the teacher/student counterparts of active
 * enrollments. Never the whole platform (no cross-tenant presence leak).
 */
const RELATED_USERS_SQL = `
    SELECT DISTINCT user_id FROM (
        SELECT b.user_id AS user_id
        FROM tenant_memberships a
        INNER JOIN tenant_memberships b ON b.tenant_id = a.tenant_id AND b.status = 'active'
        WHERE a.user_id = ? AND a.status = 'active'
        UNION
        SELECT s.user_id FROM students s WHERE s.instructor_id = ? AND s.is_active = 1 AND s.user_id IS NOT NULL
        UNION
        SELECT s.instructor_id FROM students s WHERE s.user_id = ? AND s.is_active = 1 AND s.instructor_id IS NOT NULL
    ) related
    WHERE user_id <> ?
`;
const productionNotify = async (event) => {
    if (event.channel === 'admin') {
        await (0, notifications_1.notifyAdminNewMessage)(event.userId, event.senderName, event.content);
    }
    else {
        await (0, notifications_1.notifyStudentMessageResponse)(event.userId, event.content);
    }
};
exports.productionNotify = productionNotify;
const noopNotify = async (_event) => undefined;
/**
 * Socket CORS policy mirrors the exact-origin parsing used by Express.
 * Loopback origins are development-only; deployments must configure their
 * allowed origins explicitly.
 */
function isAllowedSocketOrigin(origin, corsOrigin, vercelUrl, nodeEnv) {
    if (!origin)
        return true;
    let parsedOrigin;
    try {
        parsedOrigin = new URL(origin);
    }
    catch {
        return false;
    }
    if (parsedOrigin.origin !== origin || (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:')) {
        return false;
    }
    const configuredOrigins = [
        corsOrigin,
        vercelUrl ? `https://${vercelUrl}` : undefined,
    ].filter((value) => Boolean(value));
    if (configuredOrigins.includes(origin))
        return true;
    if (nodeEnv === 'production')
        return false;
    return parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1';
}
const corsOriginHandler = (origin, callback) => {
    if (isAllowedSocketOrigin(origin, process.env.CORS_ORIGIN, process.env.VERCEL_URL, process.env.NODE_ENV)) {
        callback(null, true);
    }
    else {
        callback(new Error('Origin is not allowed by CORS'));
    }
};
/**
 * Build the Socket.IO server over injected dependencies. Production wiring
 * (default export flow) passes the real pool query, the live-principal
 * resolver, and the notification service; hermetic tests pass isolated
 * fixtures and exercise the real handlers without a database.
 */
const createSocketIO = (deps) => (httpServer) => {
    const notify = deps.notify ?? noopNotify;
    const io = new socket_io_1.Server(httpServer, {
        cors: { origin: corsOriginHandler, credentials: true },
    });
    io.use(async (socket, next) => {
        try {
            const authHeader = socket.handshake.headers.authorization;
            const bearerMatch = authHeader ? /^Bearer\s+(\S+)$/i.exec(authHeader) : null;
            if (authHeader && !bearerMatch)
                return next(new Error('Invalid authorization header'));
            const bearerToken = bearerMatch?.[1];
            const token = socket.handshake.auth?.token || bearerToken;
            if (!token) {
                return next(new Error('Authentication required'));
            }
            // Live identity: revoked/suspended/inactive tokens never connect.
            const principal = await deps.resolvePrincipal(String(token));
            if (!principal) {
                return next(new Error('Invalid or expired token'));
            }
            socket.userId = principal.id;
            socket.userRole = principal.role;
            socket.principalCheckedAt = Date.now();
            // Kept only to revalidate liveness while the socket is open.
            socket.authToken = String(token);
            next();
        }
        catch {
            next(new Error('Invalid or expired token'));
        }
    });
    // Receiver/participant authorization is the shared message-access
    // policy; REST uses the very same readers.
    const relationReader = (0, message_access_policy_1.createSqlMessageRelationReader)(deps.query);
    const participantReader = (0, message_access_policy_1.createSqlMessageParticipantReader)(deps.query);
    const isRelated = (senderId, receiverId) => relationReader.areMessageRelated(senderId, receiverId);
    /**
     * Revalidate the live principal behind an established socket before
     * handling security-relevant events: the handshake alone cannot
     * observe a token that expired, or a session that was revoked or
     * suspended, after the connection was accepted. Renewal is bounded
     * (at most one live lookup per socket per window) and every failure
     * disconnects the socket — fail closed.
     */
    const PRINCIPAL_REVALIDATION_WINDOW_MS = 60000;
    const ensureLivePrincipal = async (socket) => {
        const token = socket.authToken;
        if (!token || !socket.userId)
            return true; // no renewable session on this socket
        const checkedAt = socket.principalCheckedAt ?? 0;
        if (Date.now() - checkedAt < PRINCIPAL_REVALIDATION_WINDOW_MS)
            return true;
        const principal = await deps.resolvePrincipal(token);
        if (!principal || String(principal.id) !== String(socket.userId)) {
            socket.disconnect(true);
            return false;
        }
        socket.principalCheckedAt = Date.now();
        socket.userRole = principal.role;
        return true;
    };
    /**
     * Per-socket event throttle: a single connection may not flood
     * message or typing events. State is keyed per socket and dies with
     * it; the window is lazy so idle sockets cost nothing.
     */
    const EVENT_THROTTLE_WINDOW_MS = 10000;
    const EVENT_LIMITS = { 'message:send': 20, 'typing:start': 60, 'typing:stop': 60 };
    const throttleState = new WeakMap();
    const allowEvent = (socket, event) => {
        const now = Date.now();
        const current = throttleState.get(socket);
        const state = !current || current.resetAt <= now ? { count: 0, resetAt: now + EVENT_THROTTLE_WINDOW_MS } : current;
        state.count += 1;
        throttleState.set(socket, state);
        return state.count <= EVENT_LIMITS[event];
    };
    const relatedUserIds = async (userId) => {
        const [rows] = await deps.query(RELATED_USERS_SQL, [userId, userId, userId, userId]);
        return rows.map((row) => String(row.user_id));
    };
    const emitPresence = async (userId, isOnline) => {
        const related = await relatedUserIds(userId);
        for (const relatedId of related) {
            io.to(`user:${relatedId}`).emit('user:status', { userId, isOnline, lastSeen: new Date() });
        }
    };
    io.on('connection', (socket) => {
        // User connects and sets online status
        socket.on('user:connect', async () => {
            try {
                if (!(await ensureLivePrincipal(socket)))
                    return;
                const userId = socket.userId;
                socket.join(`user:${userId}`);
                await deps.query(`
                        INSERT INTO user_online_status (user_id, is_online, socket_id, last_seen)
                        VALUES (?, TRUE, ?, NOW())
                        ON DUPLICATE KEY UPDATE
                            is_online = TRUE,
                            socket_id = ?,
                            last_seen = NOW()
                    `, [userId, socket.id, socket.id]);
                // Presence is scoped to the workspace network, never global.
                await emitPresence(userId, true);
            }
            catch (error) {
                console.error('Error setting user online:', error);
            }
        });
        // Send message
        socket.on('message:send', async (data) => {
            try {
                // A session that stopped being live mid-connection is dropped.
                if (!(await ensureLivePrincipal(socket)))
                    return;
                if (!allowEvent(socket, 'message:send')) {
                    socket.emit('message:error', { error: 'Too many messages. Please slow down.' });
                    return;
                }
                // The sender is the authenticated principal, never the payload.
                const senderId = socket.userId;
                const validation = (0, message_access_policy_1.validateMessagePayload)({
                    receiverId: data?.receiverId,
                    content: data?.content,
                    messageType: data?.messageType,
                    imageUrl: data?.imageUrl,
                });
                if (!validation.ok) {
                    socket.emit('message:error', { error: validation.error });
                    return;
                }
                const { receiverId, content, messageType, imageUrl } = validation.payload;
                // Receiver authorization happens before any write: the
                // receiver must share the sender's tenant or be the
                // teacher/student counterpart of an active enrollment.
                const recipient = await (0, message_access_policy_1.authorizeMessageRecipient)(relationReader, senderId, receiverId);
                if (!recipient.allowed) {
                    socket.emit('message:error', { error: recipient.error });
                    return;
                }
                const [insertResult] = await deps.query(`
                        INSERT INTO messages (sender_id, receiver_id, content, message_type, image_url)
                        VALUES (?, ?, ?, ?, ?)
                    `, [senderId, receiverId, content || null, messageType, imageUrl || null]);
                const messageId = insertResult.insertId;
                if (!Number.isSafeInteger(messageId) || messageId <= 0) {
                    socket.emit('message:error', { error: 'Message could not be saved' });
                    return;
                }
                await deps.query(`
                        INSERT INTO message_status (message_id, is_delivered, delivered_at)
                        VALUES (?, TRUE, NOW())
                    `, [messageId]);
                const [user1Id, user2Id] = [senderId, receiverId].sort();
                if (receiverId === user1Id) {
                    await deps.query(`
                            INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user1, updated_at)
                            VALUES (?, ?, ?, 1, NOW())
                            ON DUPLICATE KEY UPDATE
                                last_message_id = ?,
                                unread_count_user1 = unread_count_user1 + 1,
                                updated_at = NOW()
                        `, [user1Id, user2Id, messageId, messageId]);
                }
                else {
                    await deps.query(`
                            INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user2, updated_at)
                            VALUES (?, ?, ?, 1, NOW())
                            ON DUPLICATE KEY UPDATE
                                last_message_id = ?,
                                unread_count_user2 = unread_count_user2 + 1,
                                updated_at = NOW()
                        `, [user1Id, user2Id, messageId, messageId]);
                }
                const [messages] = await deps.query(`
                        SELECT
                            m.*,
                            ms.is_delivered,
                            ms.delivered_at,
                            ms.is_read,
                            ms.read_at,
                            u.name as sender_name,
                            u.role as sender_role
                        FROM messages m
                        LEFT JOIN message_status ms ON m.id = ms.message_id
                        LEFT JOIN users u ON m.sender_id = u.id
                        WHERE m.id = ?
                    `, [messageId]);
                const message = messages[0];
                io.to(`user:${receiverId}`).emit('message:new', message);
                socket.emit('message:sent', message);
                // Notification for the receiver
                try {
                    const [senderInfo] = await deps.query('SELECT name, role FROM users WHERE id = ?', [senderId]);
                    const [userReceiver] = await deps.query('SELECT id, role FROM users WHERE id = ?', [receiverId]);
                    let receiverUserId = receiverId;
                    let receiverRole = '';
                    if (userReceiver.length > 0) {
                        receiverRole = userReceiver[0].role;
                    }
                    else {
                        const [studentInfo] = await deps.query('SELECT id, phone, name FROM students WHERE id = ?', [receiverId]);
                        if (studentInfo.length > 0) {
                            receiverRole = 'student';
                            const [userByPhone] = await deps.query('SELECT id FROM users WHERE phone = ?', [studentInfo[0].phone]);
                            if (userByPhone.length > 0) {
                                receiverUserId = userByPhone[0].id;
                            }
                        }
                    }
                    if (senderInfo.length > 0 && receiverRole) {
                        const senderName = senderInfo[0].name || 'المستخدم';
                        if (receiverRole === 'admin' || receiverRole === 'teacher') {
                            await notify({ channel: 'admin', userId: receiverUserId, senderName, content: content || 'صورة' });
                        }
                        else if (receiverRole === 'student') {
                            await notify({ channel: 'student', userId: receiverUserId, senderName, content: content || 'صورة' });
                        }
                    }
                }
                catch (notifError) {
                    console.error('Error sending notification:', notifError);
                }
            }
            catch (error) {
                console.error('Error sending message:', error);
                socket.emit('message:error', { error: 'Failed to send message' });
            }
        });
        // Mark message as read
        socket.on('message:read', async (data) => {
            try {
                if (!(await ensureLivePrincipal(socket)))
                    return;
                const { messageId } = data;
                const userId = socket.userId;
                const access = await (0, message_access_policy_1.authorizeMessageParticipant)(participantReader, String(messageId), userId);
                if (!access.allowed) {
                    socket.emit('message:error', { error: access.error });
                    return;
                }
                // Only the receiver may mark a message read.
                if (access.participants.receiverId !== String(userId)) {
                    socket.emit('message:error', { error: 'Not authorized for this message' });
                    return;
                }
                await deps.query(`
                        UPDATE message_status
                        SET is_read = TRUE, read_at = NOW()
                        WHERE message_id = ?
                    `, [messageId]);
                const senderId = access.participants.senderId;
                const receiverId = access.participants.receiverId;
                const [user1Id, user2Id] = [senderId, receiverId].sort();
                if (receiverId === user1Id) {
                    await deps.query(`
                            UPDATE conversations
                            SET unread_count_user1 = GREATEST(0, unread_count_user1 - 1)
                            WHERE user1_id = ? AND user2_id = ?
                        `, [user1Id, user2Id]);
                }
                else {
                    await deps.query(`
                            UPDATE conversations
                            SET unread_count_user2 = GREATEST(0, unread_count_user2 - 1)
                            WHERE user1_id = ? AND user2_id = ?
                        `, [user1Id, user2Id]);
                }
                io.to(`user:${senderId}`).emit('message:read', {
                    messageId,
                    readAt: new Date()
                });
            }
            catch (error) {
                console.error('Error marking message as read:', error);
                socket.emit('message:error', { error: 'Failed to mark message as read' });
            }
        });
        // Edit message
        socket.on('message:edit', async (data) => {
            try {
                if (!(await ensureLivePrincipal(socket)))
                    return;
                const { messageId, content } = data;
                const userId = socket.userId;
                if (typeof content !== 'string' || content.trim().length === 0 || content.length > 4000) {
                    socket.emit('message:error', { error: 'Invalid message content' });
                    return;
                }
                const access = await (0, message_access_policy_1.authorizeMessageParticipant)(participantReader, String(messageId), userId);
                if (!access.allowed) {
                    socket.emit('message:error', { error: access.error });
                    return;
                }
                // Only the sender may edit a message.
                if (access.participants.senderId !== String(userId)) {
                    socket.emit('message:error', { error: 'Not authorized for this message' });
                    return;
                }
                await deps.query(`
                        UPDATE messages
                        SET content = ?, is_edited = TRUE, edited_at = NOW()
                        WHERE id = ?
                    `, [content, messageId]);
                const editedMessage = {
                    messageId,
                    content,
                    isEdited: true,
                    editedAt: new Date()
                };
                io.to(`user:${access.participants.senderId}`).emit('message:edited', editedMessage);
                io.to(`user:${access.participants.receiverId}`).emit('message:edited', editedMessage);
            }
            catch (error) {
                console.error('Error editing message:', error);
                socket.emit('message:error', { error: 'Failed to edit message' });
            }
        });
        // Delete message (for current user only)
        socket.on('message:delete', async (data) => {
            try {
                if (!(await ensureLivePrincipal(socket)))
                    return;
                const { messageId } = data;
                const userId = socket.userId;
                // Only a participant of the message may soft-delete it for
                // themselves; a stranger never learns the message exists.
                const access = await (0, message_access_policy_1.authorizeMessageParticipant)(participantReader, String(messageId), userId);
                if (!access.allowed) {
                    socket.emit('message:error', { error: access.error });
                    return;
                }
                await deps.query(`
                        INSERT INTO message_deletions (message_id, user_id)
                        VALUES (?, ?)
                        ON DUPLICATE KEY UPDATE deleted_at = NOW()
                    `, [messageId, userId]);
                io.to(`user:${userId}`).emit('message:deleted', { messageId });
            }
            catch (error) {
                console.error('Error deleting message:', error);
                socket.emit('message:error', { error: 'Failed to delete message' });
            }
        });
        // User typing indicator (receiver must share a workspace relation)
        socket.on('typing:start', async (data) => {
            const senderId = socket.userId;
            if (!(await ensureLivePrincipal(socket)))
                return;
            if (!allowEvent(socket, 'typing:start'))
                return;
            const recipient = await (0, message_access_policy_1.authorizeMessageRecipient)(relationReader, senderId, String(data?.receiverId));
            if (!recipient.allowed) {
                socket.emit('message:error', { error: recipient.error });
                return;
            }
            io.to(`user:${data.receiverId}`).emit('typing:start', { userId: socket.userId });
        });
        socket.on('typing:stop', async (data) => {
            const senderId = socket.userId;
            if (!(await ensureLivePrincipal(socket)))
                return;
            if (!allowEvent(socket, 'typing:stop'))
                return;
            const recipient = await (0, message_access_policy_1.authorizeMessageRecipient)(relationReader, senderId, String(data?.receiverId));
            if (!recipient.allowed) {
                socket.emit('message:error', { error: recipient.error });
                return;
            }
            io.to(`user:${data.receiverId}`).emit('typing:stop', { userId: socket.userId });
        });
        // User disconnects
        socket.on('disconnect', async () => {
            try {
                if (socket.userId) {
                    await deps.query(`
                            UPDATE user_online_status
                            SET is_online = FALSE, last_seen = NOW()
                            WHERE user_id = ?
                        `, [socket.userId]);
                    await emitPresence(socket.userId, false);
                }
            }
            catch (error) {
                console.error('Error setting user offline:', error);
            }
        });
    });
    ioInstance = io;
    return io;
};
exports.createSocketIO = createSocketIO;
const productionQuery = async function (sql, params) {
    // mysql2 resolves to [rows, fields]; adapt to the injected [rows] contract.
    // The cast is confined to this adapter boundary.
    const [rows] = await (0, db_1.getPool)().query(sql, params);
    return [rows];
};
/** Production wiring: real pool, live-principal bridge, notification service. */
exports.setupSocketIO = (0, exports.createSocketIO)({
    query: productionQuery,
    resolvePrincipal: (0, exports.createSocketPrincipalResolver)(),
    notify: productionNotify,
});
