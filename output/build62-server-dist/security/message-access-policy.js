"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSqlMessageParticipantReader = exports.authorizeMessageParticipant = exports.MESSAGE_PARTICIPANTS_SQL = exports.createSqlMessageRelationReader = exports.authorizeMessageRecipient = exports.MESSAGE_IMAGE_SEND_RATE_LIMIT = exports.MESSAGE_SEND_RATE_LIMIT = exports.MESSAGE_RELATION_SQL = exports.MESSAGE_RELATION_PREDICATE_SQL = exports.validateMessagePayload = exports.isAllowedMessageType = exports.MESSAGE_IMAGE_URL_MAX_LENGTH = exports.MESSAGE_TEXT_MAX_LENGTH = exports.ALLOWED_MESSAGE_TYPES = void 0;
// ---------------------------------------------------------------------------
// Payload limits and message types
// ---------------------------------------------------------------------------
exports.ALLOWED_MESSAGE_TYPES = ['text', 'image'];
exports.MESSAGE_TEXT_MAX_LENGTH = 4000;
exports.MESSAGE_IMAGE_URL_MAX_LENGTH = 2048;
const isAllowedMessageType = (value) => typeof value === 'string' && exports.ALLOWED_MESSAGE_TYPES.includes(value);
exports.isAllowedMessageType = isAllowedMessageType;
/**
 * Validate and normalize a message payload from any surface. Text requires
 * content within the length cap; image requires a bounded image reference.
 * Anything else fails closed with a 400-worthy error.
 */
const validateMessagePayload = (input) => {
    const receiverId = typeof input.receiverId === 'string' ? input.receiverId.trim() : '';
    if (!receiverId) {
        return { ok: false, error: 'Missing required fields' };
    }
    const messageType = input.messageType === undefined || input.messageType === null ? 'text' : input.messageType;
    if (!(0, exports.isAllowedMessageType)(messageType)) {
        return { ok: false, error: 'Unsupported message type' };
    }
    if (messageType === 'text') {
        if (typeof input.content !== 'string' || input.content.trim().length === 0) {
            return { ok: false, error: 'Missing required fields' };
        }
        if (input.content.length > exports.MESSAGE_TEXT_MAX_LENGTH) {
            return { ok: false, error: 'Message is too long' };
        }
        return { ok: true, payload: { receiverId, content: input.content, messageType, imageUrl: null } };
    }
    // image: an image reference is mandatory and bounded; content stays optional.
    if (typeof input.imageUrl !== 'string' || input.imageUrl.trim().length === 0 || input.imageUrl.length > exports.MESSAGE_IMAGE_URL_MAX_LENGTH) {
        return { ok: false, error: 'Missing or invalid image reference' };
    }
    const content = typeof input.content === 'string' && input.content.length <= exports.MESSAGE_TEXT_MAX_LENGTH ? input.content : null;
    return { ok: true, payload: { receiverId, content, messageType, imageUrl: input.imageUrl } };
};
exports.validateMessagePayload = validateMessagePayload;
// ---------------------------------------------------------------------------
// Receiver relation: same active tenant, or active teacher-student enrollment
// ---------------------------------------------------------------------------
/**
 * SQL predicate: the pair (a, b) is legitimately related when they share an
 * active tenant membership, or when an active enrollment links them as
 * teacher and student in either direction. Bound parameters are injected at
 * the call site; the conversations query passes SQL expressions instead.
 */
const MESSAGE_RELATION_PREDICATE_SQL = (a, b) => `
    EXISTS (
        SELECT 1 FROM tenant_memberships ma
        INNER JOIN tenant_memberships mb ON mb.tenant_id = ma.tenant_id AND mb.status = 'active'
        WHERE ma.user_id = ${a} AND ma.status = 'active' AND mb.user_id = ${b}
    )
    OR EXISTS (
        SELECT 1 FROM students s
        WHERE s.user_id = ${a} AND s.instructor_id = ${b} AND s.is_active = 1
    )
    OR EXISTS (
        SELECT 1 FROM students s
        WHERE s.user_id = ${b} AND s.instructor_id = ${a} AND s.is_active = 1
    )`;
exports.MESSAGE_RELATION_PREDICATE_SQL = MESSAGE_RELATION_PREDICATE_SQL;
/** Message-scoped relation probe. Param order: [a, b, b, a, a, b]. */
exports.MESSAGE_RELATION_SQL = `SELECT 1 AS related WHERE ${(0, exports.MESSAGE_RELATION_PREDICATE_SQL)('?', '?')} LIMIT 1`;
/**
 * Authorize a send: the receiver must be legitimately related to the sender.
 * Runs before any row is written on every surface.
 */
exports.MESSAGE_SEND_RATE_LIMIT = { max: 30, windowMs: 60000 };
exports.MESSAGE_IMAGE_SEND_RATE_LIMIT = { max: 20, windowMs: 60000 };
const authorizeMessageRecipient = async (reader, senderId, receiverId) => {
    if (!senderId || !receiverId) {
        return { allowed: false, error: 'Missing sender or receiver' };
    }
    if (String(senderId) === String(receiverId)) {
        return { allowed: false, error: 'Cannot message yourself' };
    }
    const related = await reader.areMessageRelated(senderId, receiverId);
    return related ? { allowed: true } : { allowed: false, error: 'Receiver is outside your workspace network' };
};
exports.authorizeMessageRecipient = authorizeMessageRecipient;
const createSqlMessageRelationReader = (query) => ({
    areMessageRelated: async (senderId, receiverId) => {
        const [rows] = await query(exports.MESSAGE_RELATION_SQL, [senderId, receiverId, receiverId, senderId, senderId, receiverId]);
        return rows.length > 0;
    },
});
exports.createSqlMessageRelationReader = createSqlMessageRelationReader;
// ---------------------------------------------------------------------------
// Participant authorization: sender or receiver of the message itself
// ---------------------------------------------------------------------------
exports.MESSAGE_PARTICIPANTS_SQL = 'SELECT sender_id, receiver_id FROM messages WHERE id = ?';
/**
 * Authorize an action on an existing message (read/edit/delete). The caller
 * must be a participant; a missing message and a stranger are both denied.
 */
const authorizeMessageParticipant = async (reader, messageId, userId) => {
    const row = await reader.findMessageParticipants(messageId);
    if (!row) {
        return { allowed: false, error: 'Message not found' };
    }
    const caller = String(userId);
    if (String(row.senderId) !== caller && String(row.receiverId) !== caller) {
        return { allowed: false, error: 'Not authorized for this message' };
    }
    return { allowed: true, participants: { senderId: String(row.senderId), receiverId: String(row.receiverId) } };
};
exports.authorizeMessageParticipant = authorizeMessageParticipant;
const createSqlMessageParticipantReader = (query) => ({
    findMessageParticipants: async (messageId) => {
        const [rows] = await query(exports.MESSAGE_PARTICIPANTS_SQL, [messageId]);
        const row = rows[0];
        if (!row)
            return null;
        return { senderId: String(row.sender_id), receiverId: String(row.receiver_id) };
    },
});
exports.createSqlMessageParticipantReader = createSqlMessageParticipantReader;
