import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';

export interface FamilyReadDb {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface FamilyScope { tenantId: string; studentEnrollmentId: string; parentUserId: string }
export interface FamilySession { id: string; title: string; starts_at: string; ends_at: string }
export type AttendanceState = 'present' | 'late' | 'absent' | 'excused' | 'unmarked';
export interface FamilySummary {
    checked_at: string;
    window: { from: string; now: string; to: string };
    child: { name: string; group: string | null; course: string | null };
    scope: 'current_group' | 'no_current_group';
    attendance: { sessions: Array<FamilySession & { state: AttendanceState }>; counts: Record<AttendanceState, number> };
    agenda: FamilySession[];
    next_action: 'check_attendance' | 'confirm_unmarked' | 'prepare_next_session' | 'contact_teacher' | 'no_action';
    grades: { status: 'unavailable'; reason: 'publication_contract_required' };
}
export class FamilyUnavailable extends Error {}
export class FamilyScopeLost extends Error {}
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64 && x.trim() === x;
const name = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 255;
const utc = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(x)
    && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const mysql = (x: string) => x.slice(0, 19).replace('T', ' ');
const suspension = (alias: string) => ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, alias + '.suspended_until');
const TABLES: Record<string, string[]> = {
    students: ['id', 'name', 'tenant_id', 'user_id', 'group_id', 'is_active', 'approval_status', 'enrollment_status', 'enrollment_start_date', 'enrollment_end_date'],
    users: ['id', 'is_active', 'suspended_until'], tenants: ['id', 'status'],
    groups: ['id', 'name', 'course_id', 'branch_scope', 'branch_id'],
    courses: ['id', 'name', 'tenant_id', 'is_active'], branches: ['id', 'tenant_id', 'status'],
    student_courses: ['student_id', 'course_id', 'status'],
    schedule_sessions: ['id', 'tenant_id', 'group_id', 'audience', 'title', 'starts_at', 'ends_at', 'status'],
    attendance_records: ['session_id', 'tenant_id', 'student_id', 'state'],
};

// Existing schema only. This verifies required columns rather than inferring
// availability from migration files; SQL failures also fail the entire read.
async function checkSchema(db: FamilyReadDb): Promise<void> {
    const tables = Object.keys(TABLES);
    const columns = await db.query<{ table_name: string; column_name: string }>(
        `SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')}) LIMIT 250`, tables);
    if (!Object.entries(TABLES).every(([table, names]) => names.every(column => columns.some(r => r.table_name === table && r.column_name === column)))) throw new FamilyUnavailable();
    const indexes = await db.query<{ table_name: string; index_name: string; column_name: string; seq: number; non_unique: number }>(
        `SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,
            SEQ_IN_INDEX AS seq,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('schedule_sessions','attendance_records') LIMIT 100`);
    const hasIndex = (table: string, names: string[], unique: boolean) => {
        const candidates = indexes.filter(r => r.table_name === table && Number(r.seq) === 1);
        return candidates.some(first => {
            const parts = indexes.filter(r => r.table_name === table && r.index_name === first.index_name).sort((a,b) => Number(a.seq)-Number(b.seq));
            return (!unique || Number(first.non_unique) === 0 && parts.length === names.length)
                && names.every((n,i) => parts[i]?.column_name === n && Number(parts[i].seq) === i+1);
        });
    };
    if (!hasIndex('schedule_sessions', ['tenant_id','group_id','starts_at'], false)
        || !hasIndex('attendance_records', ['session_id','student_id'], true)) throw new FamilyUnavailable();
}

interface ChildRow {
    name: string; user_id: string; group_id: string | null; group_name: string | null;
    course_id: string | null; course_name: string | null; branch_scope: string | null; branch_id: string | null;
}
// Only an active course assignment and valid current branch can expose a group.
// A missing/invalid assignment is an explicit no-current-group result, not zero attendance.
const CHILD_SQL = `SELECT s.name,s.user_id,g.id AS group_id,g.name AS group_name,
    c.id AS course_id,c.name AS course_name,g.branch_scope,g.branch_id
    FROM students s INNER JOIN tenants t ON t.id=s.tenant_id AND t.status='active'
    INNER JOIN users su ON su.id=s.user_id AND su.is_active=1 AND NOT ${suspension('su')}
    INNER JOIN users pu ON pu.id=? AND pu.is_active=1 AND NOT ${suspension('pu')}
    LEFT JOIN student_courses sc ON sc.student_id=s.id AND sc.status='active'
      AND sc.course_id=(SELECT cg.course_id FROM \`groups\` cg WHERE cg.id=s.group_id LIMIT 1)
    LEFT JOIN courses c ON c.id=sc.course_id AND c.tenant_id=s.tenant_id AND c.is_active=1
    LEFT JOIN \`groups\` g ON g.id=s.group_id AND g.course_id=c.id
      AND ((g.branch_scope='tenant' AND g.branch_id IS NULL) OR
        (g.branch_scope='branch' AND EXISTS (SELECT 1 FROM branches b WHERE b.id=g.branch_id AND b.tenant_id=s.tenant_id AND b.status='active')))
    WHERE s.tenant_id=? AND s.id=? AND s.is_active=1
      AND (s.approval_status IS NULL OR s.approval_status='approved')
      AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
      AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
      AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP()) LIMIT 2`;

async function readChild(db: FamilyReadDb, scope: FamilyScope): Promise<ChildRow> {
    const rows = await db.query<ChildRow>(CHILD_SQL, [scope.parentUserId, scope.tenantId, scope.studentEnrollmentId]);
    if (!rows.length) throw new FamilyScopeLost();
    const row = rows[0];
    if (rows.length !== 1 || !name(row.name) || !id(row.user_id)
        || row.group_id !== null && (!id(row.group_id) || !name(row.group_name) || !id(row.course_id) || !name(row.course_name))) throw new FamilyUnavailable();
    return row;
}

function session(row: FamilySession, from: string, to: string): FamilySession {
    if (!id(row.id) || !name(row.title) || !utc(row.starts_at) || !utc(row.ends_at)
        || row.ends_at <= row.starts_at || row.starts_at < from || row.starts_at >= to) throw new FamilyUnavailable();
    return { id: row.id, title: row.title, starts_at: row.starts_at, ends_at: row.ends_at };
}

export async function readFamilySummary(db: FamilyReadDb, scope: FamilyScope, now: Date): Promise<FamilySummary> {
    if (![scope.tenantId, scope.studentEnrollmentId, scope.parentUserId].every(id) || !Number.isFinite(now.getTime())) throw new FamilyScopeLost();
    await checkSchema(db);
    const child = await readChild(db, scope);
    // All windows are UTC instants. No browser-defined dates or child selectors.
    const at = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
    const from = new Date(Date.parse(at) - 7 * 86400000).toISOString();
    const to = new Date(Date.parse(at) + 7 * 86400000).toISOString();
    const counts: Record<AttendanceState, number> = { present: 0, late: 0, absent: 0, excused: 0, unmarked: 0 };
    const result: FamilySummary = { checked_at: at, window: { from, now: at, to },
        child: { name: child.name, group: child.group_id === null ? null : child.group_name, course: child.group_id === null ? null : child.course_name },
        scope: child.group_id === null ? 'no_current_group' : 'current_group', attendance: { sessions: [], counts }, agenda: [],
        next_action: child.group_id === null ? 'contact_teacher' : 'no_action',
        grades: { status: 'unavailable', reason: 'publication_contract_required' } };
    if (child.group_id !== null) {
        const projection = `ss.id,ss.title,DATE_FORMAT(ss.starts_at,'%Y-%m-%dT%H:%i:%s.000Z') AS starts_at,
            DATE_FORMAT(ss.ends_at,'%Y-%m-%dT%H:%i:%s.000Z') AS ends_at`;
        // Enforce the enrollment window as well as the current group. This is
        // not a reconstruction of historical group membership.
        const membership = `EXISTS (SELECT 1 FROM students s WHERE s.id=? AND s.tenant_id=ss.tenant_id AND s.group_id=ss.group_id
            AND (s.enrollment_start_date IS NULL OR ss.starts_at>=s.enrollment_start_date)
            AND (s.enrollment_end_date IS NULL OR ss.ends_at<=s.enrollment_end_date))`;
        const recent = await db.query<FamilySession & { state: string | null }>(
            `SELECT ${projection},a.state FROM schedule_sessions ss
             LEFT JOIN attendance_records a ON a.session_id=ss.id AND a.tenant_id=ss.tenant_id AND a.student_id=?
             WHERE ss.tenant_id=? AND ss.group_id=? AND ss.audience='group' AND ss.status='scheduled'
               AND ss.starts_at>=? AND ss.starts_at<? AND ss.ends_at<=? AND ${membership}
             ORDER BY ss.starts_at,ss.id LIMIT 101`,
            [scope.studentEnrollmentId, scope.tenantId, child.group_id, mysql(from), mysql(at), mysql(at), scope.studentEnrollmentId]);
        const future = await db.query<FamilySession>(
            `SELECT ${projection} FROM schedule_sessions ss
             WHERE ss.tenant_id=? AND ss.group_id=? AND ss.audience='group' AND ss.status='scheduled'
               AND ss.starts_at>=? AND ss.starts_at<? AND ${membership}
             ORDER BY ss.starts_at,ss.id LIMIT 101`,
            [scope.tenantId, child.group_id, mysql(at), mysql(to), scope.studentEnrollmentId]);
        if (recent.length > 100 || future.length > 100) throw new FamilyUnavailable();
        result.attendance.sessions = recent.map(row => {
            const item = session(row, from, at);
            if (item.ends_at > at) throw new FamilyUnavailable();
            const state = row.state === null ? 'unmarked' : row.state;
            if (!Object.prototype.hasOwnProperty.call(counts, state)) throw new FamilyUnavailable();
            counts[state as AttendanceState]++;
            return { ...item, state: state as AttendanceState };
        });
        result.agenda = future.map(row => session(row, at, to));
        if (new Set([...recent, ...future].map(r => r.id)).size !== recent.length + future.length) throw new FamilyUnavailable();
        result.next_action = counts.absent ? 'check_attendance' : counts.unmarked ? 'confirm_unmarked'
            : result.agenda.length ? 'prepare_next_session' : 'no_action';
    }
    // Re-read outside a long-lived snapshot: concurrent identity/group loss must
    // discard the collected private facts. This is not an atomic publication snapshot.
    const current = await readChild(db, scope);
    if (JSON.stringify(current) !== JSON.stringify(child)) throw new FamilyScopeLost();
    return result;
}
