import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '../db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Authentication middleware
interface AuthRequest extends Request {
    user?: {
        id: string;
        role: string;
    };
}

const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Setup multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads/messages');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'message-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
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

// GET /api/messages/conversations - Get all conversations for the logged-in user
router.get('/conversations', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const [conversations] = await getPool().query<RowDataPacket[]>(`
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

// GET /api/messages/:userId - Get messages with a specific user
router.get('/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const currentUserId = req.user?.id;
        const otherUserId = req.params.userId;

        if (!currentUserId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const [messages] = await getPool().query<RowDataPacket[]>(`
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
            WHERE 
                (m.sender_id = ? AND m.receiver_id = ?) OR
                (m.sender_id = ? AND m.receiver_id = ?)
            AND m.is_deleted = FALSE
            ORDER BY m.created_at ASC
        `, [currentUserId, otherUserId, otherUserId, currentUserId]);

        res.json(messages);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ error: 'Failed to fetch messages' });
    }
});

// POST /api/messages/send - Send a new message
router.post('/send', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const senderId = req.user?.id;
        const { receiver_id, content, message_type = 'text' } = req.body;

        if (!senderId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!receiver_id || (!content && message_type === 'text')) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Insert message
        const [result] = await getPool().query<ResultSetHeader>(`
            INSERT INTO messages (sender_id, receiver_id, content, message_type)
            VALUES (?, ?, ?, ?)
        `, [senderId, receiver_id, content, message_type]);

        const messageId = result.insertId;

        // Insert message status
        await getPool().query(`
            INSERT INTO message_status (message_id, is_delivered, delivered_at)
            VALUES (?, TRUE, NOW())
        `, [messageId]);

        // Update or create conversation
        // Sort IDs alphabetically for consistent user1/user2 ordering
        const [user1Id, user2Id] = [senderId, receiver_id].sort();

        await getPool().query(`
            INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user2, updated_at)
            VALUES (?, ?, ?, 1, NOW())
            ON DUPLICATE KEY UPDATE
                last_message_id = ?,
                unread_count_user2 = unread_count_user2 + 1,
                updated_at = NOW()
        `, [user1Id, user2Id, messageId, messageId]);

        // Get the created message with status
        const [messages] = await getPool().query<RowDataPacket[]>(`
            SELECT 
                m.*,
                ms.is_delivered,
                ms.delivered_at,
                ms.is_read,
                ms.read_at
            FROM messages m
            LEFT JOIN message_status ms ON m.id = ms.message_id
            WHERE m.id = ?
        `, [messageId]);

        res.status(201).json(messages[0]);
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// POST /api/messages/upload-image - Upload image for message
router.post('/upload-image', authenticateToken, upload.single('image'), async (req: AuthRequest, res: Response) => {
    try {
        const senderId = req.user?.id;
        const { receiver_id } = req.body;

        if (!senderId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded' });
        }

        const imageUrl = `/uploads/messages/${req.file.filename}`;

        // Insert message with image
        const [result] = await getPool().query<ResultSetHeader>(`
            INSERT INTO messages (sender_id, receiver_id, message_type, image_url)
            VALUES (?, ?, 'image', ?)
        `, [senderId, receiver_id, imageUrl]);

        const messageId = result.insertId;

        // Insert message status
        await getPool().query(`
            INSERT INTO message_status (message_id, is_delivered, delivered_at)
            VALUES (?, TRUE, NOW())
        `, [messageId]);

        // Update conversation
        const [user1Id, user2Id] = [senderId, receiver_id].sort();

        // Determine which unread count to increment based on who is the receiver
        if (receiver_id === user1Id) {
            // Receiver is user1, increment unread_count_user1
            await getPool().query(`
                INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user1, updated_at)
                VALUES (?, ?, ?, 1, NOW())
                ON DUPLICATE KEY UPDATE
                    last_message_id = ?,
                    unread_count_user1 = unread_count_user1 + 1,
                    updated_at = NOW()
            `, [user1Id, user2Id, messageId, messageId]);
        } else {
            // Receiver is user2, increment unread_count_user2
            await getPool().query(`
                INSERT INTO conversations (user1_id, user2_id, last_message_id, unread_count_user2, updated_at)
                VALUES (?, ?, ?, 1, NOW())
                ON DUPLICATE KEY UPDATE
                    last_message_id = ?,
                    unread_count_user2 = unread_count_user2 + 1,
                    updated_at = NOW()
            `, [user1Id, user2Id, messageId, messageId]);
        }

        // Get the created message
        const [messages] = await getPool().query<RowDataPacket[]>(`
            SELECT 
                m.*,
                ms.is_delivered,
                ms.delivered_at,
                ms.is_read,
                ms.read_at
            FROM messages m
            LEFT JOIN message_status ms ON m.id = ms.message_id
            WHERE m.id = ?
        `, [messageId]);

        res.status(201).json(messages[0]);
    } catch (error) {
        console.error('Error uploading image:', error);
        res.status(500).json({ error: 'Failed to upload image' });
    }
});

// PUT /api/messages/:id/edit - Edit a message
router.put('/:id/edit', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        const messageId = parseInt(req.params.id);
        const { content } = req.body;

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Check if user owns the message
        const [messages] = await getPool().query<RowDataPacket[]>(`
            SELECT * FROM messages WHERE id = ? AND sender_id = ?
        `, [messageId, userId]);

        if (messages.length === 0) {
            return res.status(403).json({ error: 'Not authorized to edit this message' });
        }

        // Update message
        await getPool().query(`
            UPDATE messages 
            SET content = ?, is_edited = TRUE, edited_at = NOW()
            WHERE id = ?
        `, [content, messageId]);

        // Get updated message
        const [updatedMessages] = await getPool().query<RowDataPacket[]>(`
            SELECT 
                m.*,
                ms.is_delivered,
                ms.delivered_at,
                ms.is_read,
                ms.read_at
            FROM messages m
            LEFT JOIN message_status ms ON m.id = ms.message_id
            WHERE m.id = ?
        `, [messageId]);

        res.json(updatedMessages[0]);
    } catch (error) {
        console.error('Error editing message:', error);
        res.status(500).json({ error: 'Failed to edit message' });
    }
});

// DELETE /api/messages/:id - Delete a message
router.delete('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        const messageId = parseInt(req.params.id);

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Check if user owns the message
        const [messages] = await getPool().query<RowDataPacket[]>(`
            SELECT * FROM messages WHERE id = ? AND sender_id = ?
        `, [messageId, userId]);

        if (messages.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete this message' });
        }

        // Soft delete
        await getPool().query(`
            UPDATE messages 
            SET is_deleted = TRUE, deleted_at = NOW()
            WHERE id = ?
        `, [messageId]);

        res.json({ success: true, message: 'Message deleted' });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// PUT /api/messages/:id/mark-read - Mark message as read
router.put('/:id/mark-read', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        const messageId = parseInt(req.params.id);

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Check if user is the receiver
        const [messages] = await getPool().query<RowDataPacket[]>(`
            SELECT * FROM messages WHERE id = ? AND receiver_id = ?
        `, [messageId, userId]);

        if (messages.length === 0) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        // Update message status
        await getPool().query(`
            UPDATE message_status 
            SET is_read = TRUE, read_at = NOW()
            WHERE message_id = ?
        `, [messageId]);

        // Get message details to update conversation unread count
        const message = messages[0];
        const senderId = message.sender_id;
        const receiverId = message.receiver_id;
        const [user1Id, user2Id] = [senderId, receiverId].sort();

        // Decrease unread count for the receiver
        // If receiver is user1, decrease unread_count_user1
        // If receiver is user2, decrease unread_count_user2
        if (receiverId === user1Id) {
            await getPool().query(`
                UPDATE conversations
                SET unread_count_user1 = GREATEST(0, unread_count_user1 - 1)
                WHERE user1_id = ? AND user2_id = ?
            `, [user1Id, user2Id]);
        } else {
            await getPool().query(`
                UPDATE conversations
                SET unread_count_user2 = GREATEST(0, unread_count_user2 - 1)
                WHERE user1_id = ? AND user2_id = ?
            `, [user1Id, user2Id]);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error marking message as read:', error);
        res.status(500).json({ error: 'Failed to mark message as read' });
    }
});

// PUT /api/messages/mark-all-read/:otherUserId - Mark all messages with a user as read
router.put('/mark-all-read/:otherUserId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        const otherUserId = req.params.otherUserId;

        console.log(`📖 Mark all read request: userId=${userId}, otherUserId=${otherUserId}`);

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Mark all messages from otherUserId to userId as read
        const [result1] = await getPool().query<any>(`
            UPDATE message_status ms
            INNER JOIN messages m ON ms.message_id = m.id
            SET ms.is_read = TRUE, ms.read_at = NOW()
            WHERE m.sender_id = ? AND m.receiver_id = ? AND ms.is_read = FALSE
        `, [otherUserId, userId]);

        console.log(`✅ Marked ${result1.affectedRows} messages as read`);

        // Reset unread count in conversations table
        const [user1Id, user2Id] = [userId, otherUserId].sort();

        if (userId === user1Id) {
            const [result2] = await getPool().query<any>(`
                UPDATE conversations
                SET unread_count_user1 = 0
                WHERE user1_id = ? AND user2_id = ?
            `, [user1Id, user2Id]);
            console.log(`✅ Reset unread_count_user1 (${result2.affectedRows} rows)`);
        } else {
            const [result2] = await getPool().query<any>(`
                UPDATE conversations
                SET unread_count_user2 = 0
                WHERE user1_id = ? AND user2_id = ?
            `, [user1Id, user2Id]);
            console.log(`✅ Reset unread_count_user2 (${result2.affectedRows} rows)`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error marking all messages as read:', error);
        res.status(500).json({ error: 'Failed to mark all messages as read' });
    }
});

// GET /api/messages/users/available - Get available users to chat with
router.get('/users/available', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user?.id;
        const userRole = req.user?.role;

        console.log('🔍 Getting available users for:', { userId, userRole });

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        let query = '';
        if (userRole === 'teacher') {
            // Teachers can chat with students
            query = `
                SELECT 
                    u.id,
                    u.name,
                    u.role,
                    uos.is_online,
                    uos.last_seen
                FROM users u
                LEFT JOIN user_online_status uos ON u.id = uos.user_id
                WHERE u.role = 'student' AND u.id != ?
                ORDER BY uos.is_online DESC, u.name ASC
            `;
        } else if (userRole === 'student') {
            // Students can chat with teachers only
            query = `
                SELECT 
                    u.id,
                    u.name,
                    u.role,
                    uos.is_online,
                    uos.last_seen
                FROM users u
                LEFT JOIN user_online_status uos ON u.id = uos.user_id
                WHERE u.role = 'teacher' AND u.id != ?
                ORDER BY uos.is_online DESC, u.name ASC
            `;
        } else if (userRole === 'admin') {
            // Admins can chat with everyone
            query = `
                SELECT 
                    u.id,
                    u.name,
                    u.role,
                    uos.is_online,
                    uos.last_seen
                FROM users u
                LEFT JOIN user_online_status uos ON u.id = uos.user_id
                WHERE u.id != ?
                ORDER BY uos.is_online DESC, u.name ASC
            `;
        } else {
            return res.status(403).json({ error: 'Invalid user role' });
        }

        const [users] = await getPool().query<RowDataPacket[]>(query, [userId]);
        console.log('✅ Found users:', users.length);
        res.json(users);
    } catch (error) {
        console.error('❌ Error fetching available users:', error);
        res.status(500).json({ error: 'Failed to fetch available users' });
    }
});

export default router;
