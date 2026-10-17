import { Router, Request, Response, RequestHandler } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { notifyAdminNewMessage, notifyStudentMessageResponse } from '../utils/notifications';
import { getIO } from '../services/socket';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import {
    authorizeMessageParticipant,
    authorizeMessageRecipient,
    createSqlMessageParticipantReader,
    createSqlMessageRelationReader,
    validateMessagePayload,
    MESSAGE_IMAGE_SEND_RATE_LIMIT,
    MESSAGE_SEND_RATE_LIMIT,
    type MessageAccessExecutor,
} from '../security/message-access-policy';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';

const MESSAGES_PLATFORM_PERMISSION = 'messages.manage';

/**
 * Data-access seam for the messages router. Production binds the pool
 * (lazily); hermetic tests inject isolated fixtures through the same
 * boundary so the real authorization logic runs without a database.
 */
export interface MessagesDataAccess {
    queryRows: <T = RowDataPacket[]>(sql: string, params?: unknown[]) => Promise<T[]>;
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number; insertId: number }>;
}

export interface MessagesRouterDeps {
    db: MessagesDataAccess;
    authenticate: RequestHandler;
    hasVerifiedPlatformCapability: (userId: string) => Promise<boolean>;
}

interface ConversationRow extends RowDataPacket {
    id: string;
}

const toExecutor = (db: MessagesDataAccess): MessageAccessExecutor => {
    // Bridge: MessagesDataAccess is element-generic (T = row, returns T[]),
    // while MessageAccessExecutor is array-generic (T = rows, returns [T]).
    // So unwrap the row element with a conditional before delegating.
    return async <T = RowDataPacket[]>(sql: string, params?: unknown[]): Promise<[T]> => {
        const rows = await db.queryRows<T extends unknown[] ? T[number] : never>(sql, params);
        return [rows as unknown as T];
    };
};

const parseMessageId = (value: unknown): number | null => {
    const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
};

const isValidGeneratedMessageId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export const createMessagesRouter = (deps: MessagesRouterDeps): Router => {
    const router = Router();
    const executor = toExecutor(deps.db);
    const relationReader = createSqlMessageRelationReader(executor);
    const participantReader = createSqlMessageParticipantReader(executor);

    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => {
            const uploadDir = path.join(__dirname, '../../uploads/messages');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: (_req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'message-' + uniqueSuffix + path.extname(file.originalname));
        }
    });

    const upload = multer({
        storage: storage,
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: (_req, file, cb) => {
            const allowedTypes = /jpeg|jpg|png|gif|webp/;
            const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
            const mimetype = allowedTypes.test(file.mimetype);
            if (extname && mimetype) {
                cb(null, true);
            } else {
                cb(new Error('Only images are allowed'));
            }
        }
    });

    const sendRateLimit = rateLimit('messages-send', MESSAGE_SEND_RATE_LIMIT.max, MESSAGE_SEND_RATE_LIMIT.windowMs);
    const imageRateLimit = rateLimit('messages-image', MESSAGE_IMAGE_SEND_RATE_LIMIT.max, MESSAGE_IMAGE_SEND_RATE_LIMIT.windowMs);

    // GET /api/messages/conversations - own conversations only (participant-scoped)
    router.get('/conversations', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const conversations = await deps.db.queryRows<ConversationRow>(`
                SELECT
                    c.*,
                    CASE
                        WHEN c.user1_id = ? THEN c.user2_id
                        ELSE c.user1_id
                    END as other_user_id,
                    CASE
                        WHEN c.user1_id = ? THEN u2.name
                        ELSE u1.name
                    END as other_user_name,
                    CASE
                        WHEN c.user1_id = ? THEN u2.role
                        ELSE u1.role
                    END as other_user_role,
                    CASE
                        WHEN c.user1_id = ? THEN c.unread_count_user1
                        ELSE c.unread_count_user2
                    END as unread_count,
                    m.content as last_message_content,
                    m.message_type as last_message_type,
                    m.created_at as last_message_time,
                    uos.is_online,
                    uos.last_seen
                FROM conversations c
                LEFT JOIN users u1 ON c.user1_id = u1.id
                LEFT JOIN users u2 ON c.user2_id = u2.id
                LEFT JOIN messages m ON c.last_message_id = m.id
                LEFT JOIN user_online_status uos ON
                    CASE
                        WHEN c.user1_id = ? THEN uos.user_id = c.user2_id
                        ELSE uos.user_id = c.user1_id
                    END
                WHERE c.user1_id = ? OR c.user2_id = ?
                ORDER BY c.updated_at DESC
            `, [userId, userId, userId, userId, userId, userId, userId]);
            res.json(conversations);
        } catch (error) {
            console.error('Error fetching conversations:', error);
            res.status(500).json({ error: 'Failed to fetch conversations' });
        }
    });

    // GET /api/messages/unread-total
    router.get('/unread-total', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const result = await deps.db.queryRows<RowDataPacket>(`
                SELECT
                    COALESCE(
                        (SELECT SUM(unread_count_user1) FROM conversations WHERE user1_id = ?), 0
                    ) +
                    COALESCE(
                        (SELECT SUM(unread_count_user2) FROM conversations WHERE user2_id = ?), 0
                    ) as total_unread
            `, [userId, userId]);
            const totalUnread = result[0]?.total_unread || 0;
            res.json({ count: totalUnread });
        } catch (error) {
            console.error('Error fetching unread total:', error);
            res.status(500).json({ error: 'Failed to fetch unread count' });
        }
    });

    // GET /api/messages/recent-unread
    router.get('/recent-unread', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const messages = await deps.db.queryRows<RowDataPacket>(`
                SELECT
                    m.id,
                    m.content,
                    m.message_type,
                    m.created_at,
                    m.sender_id,
                    u.name as sender_name,
                    u.role as sender_role
                FROM messages m
                LEFT JOIN message_status ms ON m.id = ms.message_id
                JOIN users u ON m.sender_id = u.id
                WHERE m.receiver_id = ? AND (ms.is_read = FALSE OR ms.is_read IS NULL)
                ORDER BY m.created_at DESC
                LIMIT 10
            `, [userId]);
            res.json(messages);
        } catch (error) {
            console.error('Error fetching recent unread:', error);
            res.status(500).json({ error: 'Failed to fetch recent messages' });
        }
    });

    // GET /api/messages/users/available - tenant-scoped directory
    router.get('/users/available', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            const userRole = req.user?.role;
            const tenantId = req.user?.tenantId;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (!userRole) {
                return res.status(403).json({ error: 'Invalid user role' });
            }

            if (userRole === 'teacher' || userRole === 'staff') {
                if (!tenantId) {
                    return res.status(403).json({ error: 'Tenant membership required' });
                }
                const users = await deps.db.queryRows<RowDataPacket>(`
                    SELECT u.id, u.name, u.role, uos.is_online, uos.last_seen
                    FROM users u
                    INNER JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.status = 'active'
                    LEFT JOIN user_online_status uos ON u.id = uos.user_id
                    WHERE u.role = 'student' AND u.id != ? AND tm.tenant_id = ?
                    ORDER BY uos.is_online DESC, u.name ASC
                `, [userId, tenantId]);
                return res.json(users);
            }
            if (userRole === 'instructor') {
                const users = await deps.db.queryRows<RowDataPacket>(`
                    SELECT DISTINCT u.id, u.name, u.role, uos.is_online, uos.last_seen
                    FROM users u
                    INNER JOIN students s ON s.phone = u.phone
                    LEFT JOIN user_online_status uos ON u.id = uos.user_id
                    WHERE u.role = 'student'
                      AND u.id != ?
                      AND s.instructor_id = ?
                    ORDER BY uos.is_online DESC, u.name ASC
                `, [userId, userId]);
                return res.json(users);
            }
            if (userRole === 'student') {
                if (!req.user?.studentEnrollmentId || !req.user?.tenantId) {
                    return res.status(403).json({ error: 'Student workspace access required' });
                }
                const users = await deps.db.queryRows<RowDataPacket>(`
                    SELECT DISTINCT u.id, u.name, u.role, uos.is_online, uos.last_seen
                    FROM users u
                    LEFT JOIN user_online_status uos ON u.id = uos.user_id
                    WHERE u.id != ?
                      AND (
                        u.role = 'teacher'
                        OR (
                          u.role = 'instructor'
                          AND EXISTS (
                            SELECT 1 FROM students s
                            INNER JOIN users current_user ON current_user.phone = s.phone
                            WHERE current_user.id = ?
                              AND s.instructor_id = u.id
                          )
                        )
                      )
                    ORDER BY uos.is_online DESC, u.name ASC
                `, [userId, userId]);
                return res.json(users);
            }
            if (userRole === 'admin') {
                if (await deps.hasVerifiedPlatformCapability(userId)) {
                    const users = await deps.db.queryRows<RowDataPacket>(`
                        SELECT u.id, u.name, u.role, uos.is_online, uos.last_seen
                        FROM users u
                        LEFT JOIN user_online_status uos ON u.id = uos.user_id
                        WHERE u.id != ?
                        ORDER BY uos.is_online DESC, u.name ASC
                    `, [userId]);
                    return res.json(users);
                }
                if (!tenantId) {
                    return res.status(403).json({ error: 'Forbidden' });
                }
                const users = await deps.db.queryRows<RowDataPacket>(`
                    SELECT u.id, u.name, u.role, uos.is_online, uos.last_seen
                    FROM users u
                    INNER JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.status = 'active'
                    LEFT JOIN user_online_status uos ON u.id = uos.user_id
                    WHERE u.id != ? AND tm.tenant_id = ?
                    ORDER BY uos.is_online DESC, u.name ASC
                `, [userId, tenantId]);
                return res.json(users);
            }
            return res.status(403).json({ error: 'Invalid user role' });
        } catch (error) {
            console.error('Error fetching available users:', error);
            res.status(500).json({ error: 'Failed to fetch available users' });
        }
    });

    // GET /api/messages/:userId - participant + relation scoped (deny-by-default)
    router.get('/:userId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const currentUserId = req.user?.id;
            const otherUserId = String(req.params.userId ?? '').trim();
            if (!currentUserId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (!otherUserId) {
                return res.status(400).json({ error: 'Missing user id' });
            }
            if (req.user?.role === 'student' && (!req.user.tenantId || !req.user.studentEnrollmentId)) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }
            const recipient = await authorizeMessageRecipient(relationReader, currentUserId, otherUserId);
            if (!recipient.allowed) {
                const status = recipient.error === 'Cannot message yourself' ? 400 : 403;
                return res.status(status).json({ error: recipient.error });
            }
            const messages = await deps.db.queryRows<RowDataPacket>(`
                SELECT m.*, ms.is_delivered, ms.delivered_at, ms.is_read, ms.read_at,
                    u.name as sender_name, u.role as sender_role
                FROM messages m
                LEFT JOIN message_status ms ON m.id = ms.message_id
                LEFT JOIN users u ON m.sender_id = u.id
                LEFT JOIN message_deletions md ON m.id = md.message_id AND md.user_id = ?
                WHERE ((m.sender_id = ? AND m.receiver_id = ?) OR
                       (m.sender_id = ? AND m.receiver_id = ?))
                  AND md.id IS NULL
                ORDER BY m.created_at ASC
            `, [currentUserId, currentUserId, otherUserId, otherUserId, currentUserId]);
            res.json(messages);
        } catch (error) {
            console.error('Error fetching messages:', error);
            res.status(500).json({ error: 'Failed to fetch messages' });
        }
    });

    // POST /api/messages/send - validated, relation-authorized, rate-limited
    router.post('/send', deps.authenticate, sendRateLimit, async (req: AuthRequest, res: Response) => {
        try {
            const senderId = req.user?.id;
            if (!senderId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (req.user?.role === 'student' && (!req.user.tenantId || !req.user.studentEnrollmentId)) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }
            const body = (req.body ?? {}) as Record<string, unknown>;
            const validation = validateMessagePayload({
                receiverId: body.receiver_id ?? body.receiverId,
                content: body.content,
                messageType: body.message_type ?? body.messageType ?? 'text',
                imageUrl: body.image_url ?? body.imageUrl,
            });
            if (!validation.ok) {
                return res.status(400).json({ error: validation.error });
            }
            const recipient = await authorizeMessageRecipient(relationReader, senderId, validation.payload.receiverId);
            if (!recipient.allowed) {
                const status = recipient.error === 'Cannot message yourself' ? 400 : 403;
                return res.status(status).json({ error: recipient.error });
            }
            const { receiverId, content, messageType } = validation.payload;

            const result = await deps.db.execute(`
                INSERT INTO messages (sender_id, receiver_id, content, message_type)
                VALUES (?, ?, ?, ?)
            `, [senderId, receiverId, content, messageType]);
            const messageId = result.insertId;
            if (!isValidGeneratedMessageId(messageId)) {
                return res.status(500).json({ error: 'Failed to send message' });
            }

            await deps.db.execute(`
                INSERT INTO message_status (message_id, is_delivered, delivered_at)
                VALUES (?, TRUE, NOW())
            `, [messageId]);

            const [user1Id, user2Id] = [senderId, receiverId].sort();
            if (receiverId === user1Id) {
                await deps.db.execute(`
                    INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user1, updated_at)
                    VALUES (?, ?, ?, 1, NOW())
                    ON DUPLICATE KEY UPDATE last_message_id = ?, unread_count_user1 = unread_count_user1 + 1, updated_at = NOW()
                `, [user1Id, user2Id, messageId, messageId]);
            } else {
                await deps.db.execute(`
                    INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user2, updated_at)
                    VALUES (?, ?, ?, 1, NOW())
                    ON DUPLICATE KEY UPDATE last_message_id = ?, unread_count_user2 = unread_count_user2 + 1, updated_at = NOW()
                `, [user1Id, user2Id, messageId, messageId]);
            }

            const messages = await deps.db.queryRows<RowDataPacket>(`
                SELECT m.*, ms.is_delivered, ms.delivered_at, ms.is_read, ms.read_at,
                    u.name as sender_name, u.role as sender_role
                FROM messages m
                LEFT JOIN message_status ms ON m.id = ms.message_id
                LEFT JOIN users u ON m.sender_id = u.id
                WHERE m.id = ?
            `, [messageId]);

            try {
                const senderInfo = await deps.db.queryRows<RowDataPacket>(
                    'SELECT name, role FROM users WHERE id = ? UNION SELECT name, "student" as role FROM students WHERE id = ?',
                    [senderId, senderId]
                );
                const userReceiver = await deps.db.queryRows<RowDataPacket>('SELECT id, role FROM users WHERE id = ?', [receiverId]);
                let receiverUserId = receiverId;
                let receiverRole = '';
                if (userReceiver.length > 0) {
                    receiverRole = String(userReceiver[0].role);
                } else {
                    const studentInfo = await deps.db.queryRows<RowDataPacket>('SELECT s.id, s.phone, s.name FROM students s WHERE s.id = ?', [receiverId]);
                    if (studentInfo.length > 0) {
                        receiverRole = 'student';
                        const userByPhone = await deps.db.queryRows<RowDataPacket>('SELECT id FROM users WHERE phone = ?', [String(studentInfo[0].phone)]);
                        if (userByPhone.length > 0) {
                            receiverUserId = String(userByPhone[0].id);
                        }
                    }
                }
                if (senderInfo.length > 0 && receiverRole) {
                    const senderName = String(senderInfo[0].name || 'المستخدم');
                    if (receiverRole === 'admin' || receiverRole === 'teacher') {
                        await notifyAdminNewMessage(receiverUserId, senderName, content || 'صورة');
                    } else if (receiverRole === 'student') {
                        await notifyStudentMessageResponse(receiverUserId, content || 'صورة');
                    }
                }
            } catch (notifError) {
                console.error('Error sending notification:', notifError);
            }

            try {
                const io = getIO();
                if (io) {
                    io.to(`user:${receiverId}`).emit('message:new', messages[0]);
                }
            } catch (socketError) {
                console.error('Socket emit error:', socketError);
            }
            res.status(201).json(messages[0]);
        } catch (error) {
            console.error('Error sending message:', error);
            res.status(500).json({ error: 'Failed to send message' });
        }
    });

    // POST /api/messages/upload-image - relation-authorized, rate-limited
    router.post('/upload-image', deps.authenticate, imageRateLimit, upload.single('image'), async (req: AuthRequest, res: Response) => {
        try {
            const senderId = req.user?.id;
            const body = (req.body ?? {}) as Record<string, unknown>;
            const receiverId = typeof body.receiver_id === 'string' ? body.receiver_id.trim()
                : typeof body.receiverId === 'string' ? body.receiverId.trim() : '';
            if (!senderId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'No image uploaded' });
            }
            if (!receiverId) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            if (req.user?.role === 'student' && (!req.user.tenantId || !req.user.studentEnrollmentId)) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }
            const tenantId = req.user?.tenantId;
            if (!tenantId || !req.user?.id) return res.status(403).json({ error: 'Tenant membership required' });
            const recipient = await authorizeMessageRecipient(relationReader, senderId, receiverId);
            if (!recipient.allowed) {
                const status = recipient.error === 'Cannot message yourself' ? 400 : 403;
                return res.status(status).json({ error: recipient.error });
            }
            const fileId = randomUUID();
            await deps.db.execute(
                `INSERT INTO tenant_media_files (id,tenant_id,uploaded_by,storage_path,original_name,mime_type,byte_size)
                 VALUES (?,?,?,?,?,?,?)`,
                [fileId, tenantId, req.user.id, path.relative(process.cwd(), req.file.path), req.file.originalname, req.file.mimetype, req.file.size]
            );
            const imageUrl = `/api/files/${fileId}/download`;

            const result = await deps.db.execute(`
                INSERT INTO messages (sender_id, receiver_id, message_type, image_url)
                VALUES (?, ?, 'image', ?)
            `, [senderId, receiverId, imageUrl]);
            const messageId = result.insertId;
            if (!isValidGeneratedMessageId(messageId)) {
                return res.status(500).json({ error: 'Failed to send message' });
            }

            await deps.db.execute(`
                INSERT INTO message_status (message_id, is_delivered, delivered_at)
                VALUES (?, TRUE, NOW())
            `, [messageId]);

            const [user1Id, user2Id] = [senderId, receiverId].sort();
            if (receiverId === user1Id) {
                await deps.db.execute(`
                    INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user1, updated_at)
                    VALUES (?, ?, ?, 1, NOW())
                    ON DUPLICATE KEY UPDATE last_message_id = ?, unread_count_user1 = unread_count_user1 + 1, updated_at = NOW()
                `, [user1Id, user2Id, messageId, messageId]);
            } else {
                await deps.db.execute(`
                    INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user2, updated_at)
                    VALUES (?, ?, ?, 1, NOW())
                    ON DUPLICATE KEY UPDATE last_message_id = ?, unread_count_user2 = unread_count_user2 + 1, updated_at = NOW()
                `, [user1Id, user2Id, messageId, messageId]);
            }

            const messages = await deps.db.queryRows<RowDataPacket>(`
                SELECT m.*, ms.is_delivered, ms.delivered_at, ms.is_read, ms.read_at,
                    u.name as sender_name, u.role as sender_role
                FROM messages m
                LEFT JOIN message_status ms ON m.id = ms.message_id
                LEFT JOIN users u ON m.sender_id = u.id
                WHERE m.id = ?
            `, [messageId]);

            try {
                const io = getIO();
                if (io) {
                    io.to(`user:${receiverId}`).emit('message:new', messages[0]);
                }
            } catch (socketError) {
                console.error('Socket emit error:', socketError);
            }
            res.status(201).json(messages[0]);
        } catch (error) {
            console.error('Error uploading image:', error);
            res.status(500).json({ error: 'Failed to upload image' });
        }
    });

    // PUT /api/messages/:id/edit - sender-only, participant-checked
    router.put('/:id/edit', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            const messageId = parseMessageId(req.params.id);
            const body = (req.body ?? {}) as Record<string, unknown>;
            const content = body.content;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (messageId === null) {
                return res.status(400).json({ error: 'Invalid message id' });
            }
            if (typeof content !== 'string' || content.trim().length === 0 || content.length > 4000) {
                return res.status(400).json({ error: 'Invalid message content' });
            }
            const access = await authorizeMessageParticipant(participantReader, String(messageId), userId);
            if (!access.allowed) {
                return res.status(404).json({ error: 'Message not found' });
            }
            if (access.participants.senderId !== String(userId)) {
                return res.status(403).json({ error: 'Not authorized to edit this message' });
            }
            await deps.db.execute(`UPDATE messages SET content = ?, is_edited = TRUE, edited_at = NOW() WHERE id = ?`, [content, messageId]);
            const updatedMessages = await deps.db.queryRows<RowDataPacket>(`
                SELECT m.*, ms.is_delivered, ms.delivered_at, ms.is_read, ms.read_at
                FROM messages m LEFT JOIN message_status ms ON m.id = ms.message_id WHERE m.id = ?
            `, [messageId]);
            res.json(updatedMessages[0]);
        } catch (error) {
            console.error('Error editing message:', error);
            res.status(500).json({ error: 'Failed to edit message' });
        }
    });

    // DELETE /api/messages/:id - participant-only soft delete
    router.delete('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            const messageId = parseMessageId(req.params.id);
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (messageId === null) {
                return res.status(400).json({ error: 'Invalid message id' });
            }
            const access = await authorizeMessageParticipant(participantReader, String(messageId), userId);
            if (!access.allowed) {
                return res.status(404).json({ error: 'Message not found' });
            }
            await deps.db.execute(`
                INSERT INTO message_deletions (message_id, user_id)
                VALUES (?, ?) ON DUPLICATE KEY UPDATE deleted_at = NOW()
            `, [messageId, userId]);
            res.json({ success: true, message: 'Message deleted' });
        } catch (error) {
            console.error('Error deleting message:', error);
            res.status(500).json({ error: 'Failed to delete message' });
        }
    });

    // PUT /api/messages/:id/mark-read - receiver-only
    router.put('/:id/mark-read', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            const messageId = parseMessageId(req.params.id);
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (messageId === null) {
                return res.status(400).json({ error: 'Invalid message id' });
            }
            const access = await authorizeMessageParticipant(participantReader, String(messageId), userId);
            if (!access.allowed) {
                return res.status(404).json({ error: 'Message not found' });
            }
            if (access.participants.receiverId !== String(userId)) {
                return res.status(403).json({ error: 'Not authorized' });
            }
            await deps.db.execute(`UPDATE message_status SET is_read = TRUE, read_at = NOW() WHERE message_id = ?`, [messageId]);
            const senderId = access.participants.senderId;
            const receiverId = access.participants.receiverId;
            const [user1Id, user2Id] = [senderId, receiverId].sort();
            if (receiverId === user1Id) {
                await deps.db.execute(`
                    UPDATE conversations SET unread_count_user1 = GREATEST(0, unread_count_user1 - 1)
                    WHERE user1_id = ? AND user2_id = ?
                `, [user1Id, user2Id]);
            } else {
                await deps.db.execute(`
                    UPDATE conversations SET unread_count_user2 = GREATEST(0, unread_count_user2 - 1)
                    WHERE user1_id = ? AND user2_id = ?
                `, [user1Id, user2Id]);
            }
            res.json({ success: true });
        } catch (error) {
            console.error('Error marking message as read:', error);
            res.status(500).json({ error: 'Failed to mark message as read' });
        }
    });

    // PUT /api/messages/mark-all-read/:otherUserId - relation-checked
    router.put('/mark-all-read/:otherUserId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const userId = req.user?.id;
            const otherUserId = String(req.params.otherUserId ?? '').trim();
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            if (!otherUserId) {
                return res.status(400).json({ error: 'Missing user id' });
            }
            const recipient = await authorizeMessageRecipient(relationReader, userId, otherUserId);
            if (!recipient.allowed) {
                const status = recipient.error === 'Cannot message yourself' ? 400 : 403;
                return res.status(status).json({ error: recipient.error });
            }
            await deps.db.execute(`
                UPDATE message_status ms INNER JOIN messages m ON ms.message_id = m.id
                SET ms.is_read = TRUE, ms.read_at = NOW()
                WHERE m.sender_id = ? AND m.receiver_id = ? AND ms.is_read = FALSE
            `, [otherUserId, userId]);
            const [user1Id, user2Id] = [userId, otherUserId].sort();
            if (userId === user1Id) {
                await deps.db.execute(`UPDATE conversations SET unread_count_user1 = 0 WHERE user1_id = ? AND user2_id = ?`, [user1Id, user2Id]);
            } else {
                await deps.db.execute(`UPDATE conversations SET unread_count_user2 = 0 WHERE user1_id = ? AND user2_id = ?`, [user1Id, user2Id]);
            }
            res.json({ success: true });
        } catch (error) {
            console.error('Error marking all messages as read:', error);
            res.status(500).json({ error: 'Failed to mark all messages as read' });
        }
    });

    return router;
};

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: MessagesDataAccess = {
    queryRows: async <T = RowDataPacket[]>(sql: string, params?: unknown[]): Promise<T[]> => {
        const db = await loadDb();
        const [rows] = await (db.getPool().query(sql, params) as unknown as Promise<[T[], unknown]>);
        return rows;
    },
    execute: async (sql: string, params?: unknown[]): Promise<{ affectedRows: number; insertId: number }> => {
        const db = await loadDb();
        const [result] = await (db.getPool().query(sql, params) as unknown as Promise<[ResultSetHeader, unknown]>);
        return { affectedRows: Number(result.affectedRows ?? 0), insertId: Number(result.insertId ?? 0) };
    },
};

const productionPlatformCapability = async (userId: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes(MESSAGES_PLATFORM_PERMISSION);
};

export default createMessagesRouter({
    db: productionDb,
    authenticate: authenticateToken,
    hasVerifiedPlatformCapability: productionPlatformCapability,
});
