"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFollowupInput = parseFollowupInput;
exports.readSupportFollowup = readSupportFollowup;
const validId = (x) => typeof x === 'string' && /^[a-zA-Z0-9-]{1,36}$/.test(x);
const integer = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
const epoch = (x) => { if (!(typeof x === 'number' || typeof x === 'string' && /^\d+$/.test(x)) || !integer(Number(x)))
    throw Error('Invalid support epoch'); return Number(x); };
const exact = (x, keys) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
function parseFollowupInput(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['scope', 'status', 'min_hours', 'after'].includes(k)))
        return null;
    const r = raw;
    const scope = r.scope ?? 'mine', status = r.status ?? 'needs_support', hours = r.min_hours ?? '24';
    if (!['mine', 'unassigned'].includes(scope) || !['needs_support', 'waiting_on_user'].includes(status) || !['0', '24', '72', '168'].includes(hours))
        return null;
    const filters = { scope, status, min_hours: Number(hours) };
    let cursor = null;
    if (r.after !== undefined) {
        if (typeof r.after !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(r.after))
            return null;
        try {
            const bytes = Buffer.from(r.after, 'base64url');
            if (bytes.toString('base64url') !== r.after)
                return null;
            const c = JSON.parse(bytes.toString('utf8'));
            if (!exact(c, ['v', 'scope', 'status', 'min_hours', 'as_of', 'updated', 'id']) || c.v !== 1 || c.scope !== filters.scope || c.status !== filters.status || c.min_hours !== filters.min_hours
                || !integer(c.as_of) || !integer(c.updated) || c.updated > c.as_of - filters.min_hours * 3600 || !validId(c.id))
                return null;
            cursor = c;
        }
        catch {
            return null;
        }
    }
    return { filters, cursor };
}
const unavailable = () => ({ status: 503, body: { code: 'SUPPORT_FOLLOWUP_UNAVAILABLE', error: 'Support follow-up unavailable' } });
/** Called only inside the shared live identity/permission transaction. */
async function readSupportFollowup(connection, actorId, input) {
    const [metadata] = await connection.execute(`SELECT COLUMN_NAME AS column_name,DATA_TYPE AS data_type,DATETIME_PRECISION AS datetime_precision
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_tickets' AND COLUMN_NAME IN ('created_at','updated_at') LIMIT 2`);
    if (!Array.isArray(metadata) || metadata.length !== 2 || !['created_at', 'updated_at'].every(n => metadata.some((r) => r.column_name === n && r.data_type === 'timestamp' && [0, '0'].includes(r.datetime_precision))))
        return unavailable();
    const [index] = await connection.execute(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_tickets' AND INDEX_NAME='idx_support_followup' ORDER BY SEQ_IN_INDEX LIMIT 5`);
    if (!Array.isArray(index) || index.length !== 4 || !['assigned_to', 'status', 'updated_at', 'id'].every((n, i) => index[i].column_name === n && Number(index[i].seq_in_index) === i + 1))
        return unavailable();
    const [clocks] = await connection.execute('SELECT UNIX_TIMESTAMP() AS now_epoch');
    const now = epoch(clocks[0]?.now_epoch);
    const asOf = input.cursor?.as_of ?? now;
    if (asOf > now || now - asOf > 1800)
        return { status: 400, body: { code: 'SUPPORT_FOLLOWUP_INPUT', error: 'Refresh the follow-up window' } };
    const cutoff = asOf - input.filters.min_hours * 3600;
    const projection = 't.id,t.ticket_number,t.category,t.subject,t.status,t.priority,UNIX_TIMESTAMP(t.created_at) AS created_at_epoch,UNIX_TIMESTAMP(t.updated_at) AS updated_at_epoch';
    const statuses = input.filters.status === 'needs_support' ? ['open', 'waiting_on_support'] : ['waiting_on_user'];
    const params = [];
    const branches = statuses.map(status => {
        const assigned = input.filters.scope === 'mine' ? 't.assigned_to=?' : 't.assigned_to IS NULL';
        if (input.filters.scope === 'mine')
            params.push(actorId);
        params.push(status, cutoff);
        const after = input.cursor ? ' AND (t.updated_at>FROM_UNIXTIME(?) OR (t.updated_at=FROM_UNIXTIME(?) AND t.id>?))' : '';
        if (input.cursor)
            params.push(input.cursor.updated, input.cursor.updated, input.cursor.id);
        return `(SELECT ${projection} FROM support_tickets t WHERE ${assigned} AND t.status=? AND t.updated_at<=FROM_UNIXTIME(?)${after} ORDER BY t.updated_at ASC,t.id ASC LIMIT 26)`;
    });
    // One bounded range per exact status; avoid sorting every ticket across two
    // statuses before LIMIT. Outer merge retains the database's ID collation.
    const [raw] = await connection.execute(`SELECT id,ticket_number,category,subject,status,priority,created_at_epoch,updated_at_epoch
      FROM (${branches.join(' UNION ALL ')}) followup_page ORDER BY updated_at_epoch ASC,id ASC LIMIT 26`, params);
    if (!Array.isArray(raw) || raw.length > 26)
        throw Error('Invalid follow-up page');
    const seen = new Set();
    let previous = 0;
    const rows = raw.map((r) => {
        const created = epoch(r.created_at_epoch), updated = epoch(r.updated_at_epoch);
        if (!validId(r.id) || seen.has(r.id.toLowerCase()) || typeof r.ticket_number !== 'string' || !r.ticket_number || r.ticket_number.length > 32
            || typeof r.subject !== 'string' || !r.subject.trim() || r.subject.length > 200 || !['technical', 'account', 'billing', 'content', 'exam', 'video', 'other'].includes(r.category)
            || !statuses.includes(r.status) || !['low', 'normal', 'high', 'urgent'].includes(r.priority) || !integer(created) || !integer(updated) || updated < created || updated > cutoff || updated < previous
            || input.cursor && (updated < input.cursor.updated || updated === input.cursor.updated && r.id.toLowerCase() === input.cursor.id.toLowerCase()))
            throw Error('Invalid follow-up row');
        seen.add(r.id.toLowerCase());
        previous = updated;
        return { row: { id: r.id, ticket_number: r.ticket_number, category: r.category, subject: r.subject, status: r.status, priority: r.priority, created_at: new Date(created * 1000).toISOString(), updated_at: new Date(updated * 1000).toISOString() }, updated };
    });
    const page = rows.slice(0, 25), last = page[page.length - 1];
    const next = rows.length > 25 ? Buffer.from(JSON.stringify({ v: 1, ...input.filters, as_of: asOf, updated: last.updated, id: last.row.id })).toString('base64url') : null;
    return { status: 200, body: { tickets: page.map(r => r.row), next_cursor: next, as_of: new Date(asOf * 1000).toISOString(), filters: input.filters } };
}
