"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPrivateNotesSchema = verifyPrivateNotesSchema;
exports.privateNoteDto = privateNoteDto;
exports.findPrivateNote = findPrivateNote;
exports.listPrivateNotes = listPrivateNotes;
async function verifyPrivateNotesSchema(connection) {
    const [tables] = await connection.execute(`SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_ticket_private_notes' LIMIT 1`);
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_ticket_private_notes' LIMIT 8`);
    const [primary] = await connection.execute(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_ticket_private_notes' AND INDEX_NAME='PRIMARY' LIMIT 2`);
    const [page] = await connection.execute(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_ticket_private_notes' AND INDEX_NAME='idx_support_private_notes_page' ORDER BY SEQ_IN_INDEX LIMIT 4`);
    return tables[0]?.engine === 'InnoDB'
        && ['id', 'ticket_id', 'author_user_id', 'body', 'created_at'].every(name => columns.some(row => row.column_name === name))
        && primary.length === 1 && primary[0].column_name === 'id' && Number(primary[0].seq_in_index) === 1
        && page.length === 3 && ['ticket_id', 'created_at', 'id'].every((name, index) => page[index].column_name === name && Number(page[index].seq_in_index) === index + 1);
}
const fields = 'n.id,n.ticket_id,n.author_user_id AS author_id,u.name AS author_name,n.body,UNIX_TIMESTAMP(n.created_at) AS created_at_epoch';
function privateNoteDto(row) {
    if (typeof row.id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(row.id)
        || ![row.ticket_id, row.author_id].every(value => typeof value === 'string' && value.length > 0 && value.length <= 36)
        || typeof row.author_name !== 'string' || row.author_name.length > 255 || typeof row.body !== 'string' || !row.body.trim() || row.body.length > 10000)
        throw Error('Invalid private note record');
    const raw = row.created_at_epoch;
    if (typeof raw !== 'number' && !(typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw)))
        throw Error('Unreadable private note instant');
    const epoch = Number(raw), instant = new Date(epoch * 1000);
    if (!Number.isFinite(epoch) || epoch <= 0 || Number.isNaN(instant.getTime()))
        throw Error('Unreadable private note instant');
    return { id: row.id, ticket_id: row.ticket_id, author_id: row.author_id, author_name: row.author_name, body: row.body, created_at: instant.toISOString() };
}
async function findPrivateNote(connection, noteId, ticketId, lock = false) {
    const [rows] = await connection.execute(`SELECT ${fields} FROM support_ticket_private_notes n INNER JOIN users u ON u.id=n.author_user_id WHERE n.id=? AND n.ticket_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [noteId, ticketId]);
    return rows[0] ?? null;
}
async function listPrivateNotes(connection, ticketId, before) {
    const [rows] = await connection.execute(`SELECT ${fields} FROM support_ticket_private_notes n INNER JOIN users u ON u.id=n.author_user_id
    ${before ? 'INNER JOIN support_ticket_private_notes anchor ON anchor.id=? AND anchor.ticket_id=n.ticket_id' : ''}
    WHERE n.ticket_id=? ${before ? 'AND (n.created_at<anchor.created_at OR (n.created_at=anchor.created_at AND n.id<anchor.id))' : ''}
    ORDER BY n.created_at DESC,n.id DESC LIMIT 101`, before ? [before, ticketId] : [ticketId]);
    const items = rows.slice(0, 100).map(privateNoteDto);
    return { notes: items.reverse(), next_cursor: rows.length > 100 ? String(rows[99].id) : null };
}
