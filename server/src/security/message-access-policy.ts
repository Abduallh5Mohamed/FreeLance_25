/**
 * Shared message-access policy for REST and Socket.IO.
 *
 * One deny-by-default policy serves every message surface: receiver
 * authorization, participant authorization, payload limits, and message-type
 * allowlisting live here so REST text/image sends and socket events cannot
 * drift apart. The core is pure; SQL readers are injected, so production
 * wiring passes the pool while hermetic tests pass isolated fixtures without
 * touching a database, env, or network.
 *
 * A legitimate relation is always server-verified: either an active
 * membership in the same active tenant, or an active teacher-student
 * enrollment between the two principals (either direction). No client claim,
 * role name, or hardcoded identity is ever treated as authority.
 */
import { RowDataPacket } from 'mysql2';

/** mysql2-style executor that resolves to [rows]. */
export type MessageAccessExecutor = <T = RowDataPacket[]>(sql: string, params?: unknown[]) => Promise<[T]>;

// ---------------------------------------------------------------------------
// Payload limits and message types
// ---------------------------------------------------------------------------

export const ALLOWED_MESSAGE_TYPES = ['text', 'image'] as const;
export type MessageType = (typeof ALLOWED_MESSAGE_TYPES)[number];
export const MESSAGE_TEXT_MAX_LENGTH = 4000;
export const MESSAGE_IMAGE_URL_MAX_LENGTH = 2048;

export const isAllowedMessageType = (value: unknown): value is MessageType =>
    typeof value === 'string' && (ALLOWED_MESSAGE_TYPES as readonly string[]).includes(value);

export interface NormalizedMessagePayload {
    receiverId: string;
    content: string | null;
    messageType: MessageType;
    imageUrl: string | null;
}

export type MessagePayloadResult =
    | { ok: true; payload: NormalizedMessagePayload }
    | { ok: false; error: string };

/**
 * Validate and normalize a message payload from any surface. Text requires
 * content within the length cap; image requires a bounded image reference.
 * Anything else fails closed with a 400-worthy error.
 */
export const validateMessagePayload = (input: {
    receiverId?: unknown;
    content?: unknown;
    messageType?: unknown;
    imageUrl?: unknown;
}): MessagePayloadResult => {
    const receiverId = typeof input.receiverId === 'string' ? input.receiverId.trim() : '';
    if (!receiverId) {
        return { ok: false, error: 'Missing required fields' };
    }

    const messageType: unknown = input.messageType === undefined || input.messageType === null ? 'text' : input.messageType;
    if (!isAllowedMessageType(messageType)) {
        return { ok: false, error: 'Unsupported message type' };
    }

    if (messageType === 'text') {
        if (typeof input.content !== 'string' || input.content.trim().length === 0) {
            return { ok: false, error: 'Missing required fields' };
        }
        if (input.content.length > MESSAGE_TEXT_MAX_LENGTH) {
            return { ok: false, error: 'Message is too long' };
        }
        return { ok: true, payload: { receiverId, content: input.content, messageType, imageUrl: null } };
    }

    // image: an image reference is mandatory and bounded; content stays optional.
    if (typeof input.imageUrl !== 'string' || input.imageUrl.trim().length === 0 || input.imageUrl.length > MESSAGE_IMAGE_URL_MAX_LENGTH) {
        return { ok: false, error: 'Missing or invalid image reference' };
    }
    const content = typeof input.content === 'string' && input.content.length <= MESSAGE_TEXT_MAX_LENGTH ? input.content : null;
    return { ok: true, payload: { receiverId, content, messageType, imageUrl: input.imageUrl } };
};

// ---------------------------------------------------------------------------
// Receiver relation: same active tenant, or active teacher-student enrollment
// ---------------------------------------------------------------------------

/**
 * SQL predicate: the pair (a, b) is legitimately related when they share an
 * active tenant membership, or when an active enrollment links them as
 * teacher and student in either direction. Bound parameters are injected at
 * the call site; the conversations query passes SQL expressions instead.
 */
export const MESSAGE_RELATION_PREDICATE_SQL = (a: string, b: string): string => `
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

/** Message-scoped relation probe. Param order: [a, b, b, a, a, b]. */
export const MESSAGE_RELATION_SQL =
    `SELECT 1 AS related WHERE ${MESSAGE_RELATION_PREDICATE_SQL('?', '?')} LIMIT 1`;

export interface MessageRelationReader {
    areMessageRelated(senderId: string, receiverId: string): Promise<boolean>;
}

export type MessageRecipientDecision =
    | { allowed: true }
    | { allowed: false; error: string };

/**
 * Authorize a send: the receiver must be legitimately related to the sender.
 * Runs before any row is written on every surface.
 */
export const authorizeMessageRecipient = async (
    reader: MessageRelationReader,
    senderId: string,
    receiverId: string,
): Promise<MessageRecipientDecision> => {
    if (!senderId || !receiverId) {
        return { allowed: false, error: 'Missing sender or receiver' };
    }
    const related = await reader.areMessageRelated(senderId, receiverId);
    return related ? { allowed: true } : { allowed: false, error: 'Receiver is outside your workspace network' };
};

export const createSqlMessageRelationReader = (query: MessageAccessExecutor): MessageRelationReader => ({
    areMessageRelated: async (senderId: string, receiverId: string) => {
        const [rows] = await query<RowDataPacket[]>(MESSAGE_RELATION_SQL,
            [senderId, receiverId, receiverId, senderId, senderId, receiverId]);
        return rows.length > 0;
    },
});

// ---------------------------------------------------------------------------
// Participant authorization: sender or receiver of the message itself
// ---------------------------------------------------------------------------

export const MESSAGE_PARTICIPANTS_SQL =
    'SELECT sender_id, receiver_id FROM messages WHERE id = ?';

export interface MessageParticipants {
    senderId: string;
    receiverId: string;
}

export interface MessageParticipantReader {
    findMessageParticipants(messageId: string): Promise<MessageParticipants | null>;
}

export type MessageParticipantDecision =
    | { allowed: true; participants: MessageParticipants }
    | { allowed: false; error: string };

/**
 * Authorize an action on an existing message (read/edit/delete). The caller
 * must be a participant; a missing message and a stranger are both denied.
 */
export const authorizeMessageParticipant = async (
    reader: MessageParticipantReader,
    messageId: string,
    userId: string,
): Promise<MessageParticipantDecision> => {
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

export const createSqlMessageParticipantReader = (query: MessageAccessExecutor): MessageParticipantReader => ({
    findMessageParticipants: async (messageId: string) => {
        const [rows] = await query<RowDataPacket[]>(MESSAGE_PARTICIPANTS_SQL, [messageId]);
        const row = rows[0];
        if (!row) return null;
        return { senderId: String(row.sender_id), receiverId: String(row.receiver_id) };
    },
});
