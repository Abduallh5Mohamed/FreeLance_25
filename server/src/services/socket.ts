import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { getPool } from '../db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface UserSocket extends Socket {
    userId?: string;
}

export const setupSocketIO = (httpServer: HTTPServer) => {
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: (origin, callback) => {
                const allowedOrigins = [
                    'http://localhost:8080',
                    'http://localhost:8081',
                    'http://localhost:3000',
                    'http://127.0.0.1:8080',
                    'http://127.0.0.1:8081',
                    'http://127.0.0.1:3000',
                ];

                if (!origin || allowedOrigins.some(allowed => origin.includes(allowed))) {
                    callback(null, true);
                } else {
                    callback(null, true);
                }
            },
            credentials: true,
        },
    });

    io.on('connection', (socket: UserSocket) => {
        console.log('🔌 New socket connection:', socket.id);

        // User connects and sets online status
        socket.on('user:connect', async (userId: string) => {
            try {
                socket.userId = userId;
                socket.join(`user:${userId}`);

                // Update user online status
                await getPool().query(`
                    INSERT INTO user_online_status (user_id, is_online, socket_id, last_seen)
                    VALUES (?, TRUE, ?, NOW())
                    ON DUPLICATE KEY UPDATE
                        is_online = TRUE,
                        socket_id = ?,
                        last_seen = NOW()
                `, [userId, socket.id, socket.id]);

                // Notify all connected users about this user's online status
                io.emit('user:status', { userId, isOnline: true });

                console.log(`✅ User ${userId} is now online`);
            } catch (error) {
                console.error('Error setting user online:', error);
            }
        });

        // Send message
        socket.on('message:send', async (data: {
            senderId: string;
            receiverId: string;
            content: string;
            messageType: 'text' | 'image';
            imageUrl?: string;
        }) => {
            try {
                const { senderId, receiverId, content, messageType, imageUrl } = data;

                // Insert message into database
                const [result] = await getPool().query<any>(`
                    INSERT INTO messages (sender_id, receiver_id, content, message_type, image_url)
                    VALUES (?, ?, ?, ?, ?)
                `, [senderId, receiverId, content || null, messageType, imageUrl || null]);

                const messageId = result.insertId;

                // Insert message status
                await getPool().query(`
                    INSERT INTO message_status (message_id, is_delivered, delivered_at)
                    VALUES (?, TRUE, NOW())
                `, [messageId]);

                // Update conversation - sort IDs alphabetically for consistency
                const [user1Id, user2Id] = [senderId, receiverId].sort();

                // Determine which unread count to increment based on who is the receiver
                if (receiverId === user1Id) {
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

                // Get the complete message with status
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
                    WHERE m.id = ?
                `, [messageId]);

                const message = messages[0];

                console.log(`📨 Message created with ID: ${messageId}`);
                console.log(`📤 Sending to receiver room: user:${receiverId}`);
                console.log(`✅ Sending confirmation to sender: ${senderId}`);

                // Send to receiver
                io.to(`user:${receiverId}`).emit('message:new', message);

                // Send confirmation to sender
                socket.emit('message:sent', message);

                console.log(`✅ Message sent from ${senderId} to ${receiverId}`);
            } catch (error) {
                console.error('Error sending message:', error);
                socket.emit('message:error', { error: 'Failed to send message' });
            }
        });

        // Mark message as read
        socket.on('message:read', async (data: { messageId: number; userId: string }) => {
            try {
                const { messageId, userId } = data;

                // Verify user is the receiver
                const [messages] = await getPool().query<RowDataPacket[]>(`
                    SELECT sender_id, receiver_id FROM messages WHERE id = ?
                `, [messageId]);

                if (messages.length > 0 && messages[0].receiver_id === userId) {
                    // Update message status
                    await getPool().query(`
                        UPDATE message_status 
                        SET is_read = TRUE, read_at = NOW()
                        WHERE message_id = ?
                    `, [messageId]);

                    // Update conversation unread count
                    const senderId = messages[0].sender_id;
                    const receiverId = messages[0].receiver_id;
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

                    // Notify sender that message was read
                    io.to(`user:${messages[0].sender_id}`).emit('message:read', {
                        messageId,
                        readAt: new Date()
                    });

                    console.log(`✓ Message ${messageId} marked as read by user ${userId}`);
                }
            } catch (error) {
                console.error('Error marking message as read:', error);
            }
        });

        // Edit message
        socket.on('message:edit', async (data: { messageId: number; userId: string; content: string }) => {
            try {
                const { messageId, userId, content } = data;

                // Verify user owns the message
                const [messages] = await getPool().query<RowDataPacket[]>(`
                    SELECT sender_id, receiver_id FROM messages WHERE id = ? AND sender_id = ?
                `, [messageId, userId]);

                if (messages.length > 0) {
                    // Update message
                    await getPool().query(`
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

                    // Notify both users
                    io.to(`user:${messages[0].sender_id}`).emit('message:edited', editedMessage);
                    io.to(`user:${messages[0].receiver_id}`).emit('message:edited', editedMessage);

                    console.log(`✏️ Message ${messageId} edited by user ${userId}`);
                }
            } catch (error) {
                console.error('Error editing message:', error);
                socket.emit('message:error', { error: 'Failed to edit message' });
            }
        });

        // Delete message
        socket.on('message:delete', async (data: { messageId: number; userId: number }) => {
            try {
                const { messageId, userId } = data;

                // Verify user owns the message
                const [messages] = await getPool().query<RowDataPacket[]>(`
                    SELECT sender_id, receiver_id FROM messages WHERE id = ? AND sender_id = ?
                `, [messageId, userId]);

                if (messages.length > 0) {
                    // Soft delete
                    await getPool().query(`
                        UPDATE messages 
                        SET is_deleted = TRUE, deleted_at = NOW()
                        WHERE id = ?
                    `, [messageId]);

                    // Notify both users
                    io.to(`user:${messages[0].sender_id}`).emit('message:deleted', { messageId });
                    io.to(`user:${messages[0].receiver_id}`).emit('message:deleted', { messageId });

                    console.log(`🗑️ Message ${messageId} deleted by user ${userId}`);
                }
            } catch (error) {
                console.error('Error deleting message:', error);
                socket.emit('message:error', { error: 'Failed to delete message' });
            }
        });

        // User typing indicator
        socket.on('typing:start', (data: { senderId: number; receiverId: number }) => {
            io.to(`user:${data.receiverId}`).emit('typing:start', { userId: data.senderId });
        });

        socket.on('typing:stop', (data: { senderId: number; receiverId: number }) => {
            io.to(`user:${data.receiverId}`).emit('typing:stop', { userId: data.senderId });
        });

        // User disconnects
        socket.on('disconnect', async () => {
            try {
                if (socket.userId) {
                    // Update user online status
                    await getPool().query(`
                        UPDATE user_online_status 
                        SET is_online = FALSE, last_seen = NOW()
                        WHERE user_id = ?
                    `, [socket.userId]);

                    // Notify all connected users
                    io.emit('user:status', {
                        userId: socket.userId,
                        isOnline: false,
                        lastSeen: new Date()
                    });

                    console.log(`👋 User ${socket.userId} went offline`);
                }
            } catch (error) {
                console.error('Error setting user offline:', error);
            }
        });
    });

    console.log('✅ Socket.IO initialized for real-time messaging');

    return io;
};
