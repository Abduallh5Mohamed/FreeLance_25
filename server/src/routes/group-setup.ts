import { Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type { CourseLessonConnection } from './course-lessons';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';

const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const label = (x: unknown): x is string => typeof x === 'string' && !!x.trim() && x.length <= 255;
const suspension = (alias: string) => ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, alias + '.suspended_until');
const flag = (x: unknown): boolean => { if (![0,1,'0','1',false,true].includes(x as never)) throw Error('Invalid setup evidence'); return x === 1 || x === '1' || x === true; };
const integer = (x: unknown, max: number) => { const n = Number(x); if (x === null || x === '' || !Number.isSafeInteger(n) || n < 0 || n > max) throw Error('Invalid setup count'); return n; };
interface GroupRow { id: string; name: string; course_id: string; course_name: string; course_active: number; is_active: number;
    max_students: number; instructor_id: string | null; branch_scope: string; branch_id: string | null; branch_valid: number }
const GROUP_SQL = `SELECT g.id,g.name,g.course_id,c.name AS course_name,c.is_active AS course_active,g.is_active,g.max_students,
    g.instructor_id,g.branch_scope,g.branch_id,
    CASE WHEN g.branch_scope='tenant' AND g.branch_id IS NULL THEN 1
      WHEN g.branch_scope='branch' AND EXISTS(SELECT 1 FROM branches b WHERE b.id=g.branch_id AND b.tenant_id=c.tenant_id AND b.status='active') THEN 1 ELSE 0 END AS branch_valid
    FROM \`groups\` g INNER JOIN courses c ON c.id=g.course_id AND c.tenant_id=? WHERE g.id=? LIMIT 2`;
const OWNER_SQL = `SELECT t.owner_user_id FROM tenants t INNER JOIN users u ON u.id=t.owner_user_id
    WHERE t.id=? AND t.owner_user_id=? AND t.status='active' AND u.is_active=1 AND NOT ${suspension('u')} LIMIT 1`;

export function createGroupSetupRouter(deps: { getConnection(): Promise<CourseLessonConnection>; now?: () => Date }) {
    const router = Router();
    router.get('/groups/:groupId/setup', async (req: AuthRequest, res) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user) return res.status(401).json({code:'SESSION_REQUIRED'});
        if (req.user.billingOnly || req.user.identitySource === 'staff' || req.impersonation || req.headers['x-impersonation'] !== undefined)
            return res.status(403).json({code:'GROUP_SETUP_OWNER_REQUIRED'});
        const {groupId} = req.params, tenantId = req.user.tenantId, userId = req.user.id;
        if (!uuid(groupId) || Object.keys(req.query ?? {}).length || Object.keys(req.body ?? {}).length
            || ['x-tenant-id','x-student-id','x-enrollment-id','x-instructor-id'].some(k=>req.headers[k] !== undefined)) return res.status(400).json({code:'INVALID_GROUP_SETUP_SELECTORS'});
        if (!tenantId || !userId) return res.status(404).json({code:'GROUP_SETUP_NOT_FOUND'});
        let connection: CourseLessonConnection | null = null, discard = false;
        try {
            connection = await deps.getConnection();
            const read = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
                const [rows] = await connection!.execute(sql, params); if (!Array.isArray(rows)) throw Error('Invalid setup rows'); return rows as T[];
            };
            const owner = async () => (await read<{owner_user_id:string}>(OWNER_SQL,[tenantId,userId])).some(r=>r.owner_user_id===userId);
            if (!await owner()) return res.status(403).json({code:'GROUP_SETUP_OWNER_REQUIRED'});
            const groupRows = await read<GroupRow>(GROUP_SQL,[tenantId,groupId]);
            if (groupRows.length !== 1 || groupRows[0].id.toLowerCase() !== groupId.toLowerCase()) return res.status(404).json({code:'GROUP_SETUP_NOT_FOUND'});
            const g = groupRows[0];
            if (!label(g.name) || !label(g.course_name) || !uuid(g.course_id)) throw Error('Invalid group');
            const active = flag(g.is_active), courseActive = flag(g.course_active), branchValid = flag(g.branch_valid), capacity = integer(g.max_students,1000000);
            // Only inspect this group's records. No cached current_students,
            // tenant-wide roster, names, contacts or implicit account creation.
            const students = await read<{id:string;is_offline:unknown;enrollment_live:unknown;account_live:unknown;assigned_live:unknown}>(
                `SELECT s.id,s.is_offline,
                  CASE WHEN s.is_active=1 AND (s.approval_status IS NULL OR s.approval_status='approved')
                    AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
                    AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
                    AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP()) THEN 1 ELSE 0 END AS enrollment_live,
                  CASE WHEN u.id IS NOT NULL AND u.is_active=1 AND NOT ${suspension('u')} THEN 1 ELSE 0 END AS account_live,
                  EXISTS(SELECT 1 FROM student_courses sc WHERE sc.student_id=s.id AND sc.course_id=? AND sc.status='active') AS assigned_live
                 FROM students s LEFT JOIN users u ON u.id=s.user_id WHERE s.tenant_id=? AND s.group_id=? ORDER BY s.id LIMIT 501`,
                [g.course_id,tenantId,groupId]);
            if (students.length>500 || new Set(students.map(s=>s.id)).size!==students.length) throw Error('Setup roster cap');
            let live=0,offline=0,missingAccount=0,missingAssignment=0;
            for (const row of students) {
                if (typeof row.id!=='string'||!row.id||row.id.length>64) throw Error('Invalid student');
                const enrolled=flag(row.enrollment_live),account=flag(row.account_live),assigned=flag(row.assigned_live),isOffline=flag(row.is_offline);
                if (enrolled) { live++; if(isOffline)offline++; if (!isOffline&&!account) missingAccount++; if (!assigned) missingAssignment++; }
            }
            const teachers = g.instructor_id === null ? [] : await read<{name:string}>(
                `SELECT u.name FROM users u INNER JOIN tenants t ON t.id=? WHERE u.id=? AND u.is_active=1 AND NOT ${suspension('u')}
                 AND (t.owner_user_id=u.id OR EXISTS(SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=t.id AND m.user_id=u.id AND m.status='active' AND m.role_key IN ('owner','instructor'))) LIMIT 2`,[tenantId,g.instructor_id]);
            if (teachers.length>1 || teachers.some(t=>!label(t.name))) throw Error('Invalid instructor');
            // Optional concrete schedules stay unknown when their schema/index
            // cannot be proved. Weekly text on a group isn't a generated session.
            const [metadata] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schedule_sessions' LIMIT 40`);
            const required=['id','tenant_id','group_id','audience','title','starts_at','ends_at','status'];
            let schedule: {status:'available'|'unavailable';sessions:Array<{id:string;title:string;starts_at:string}>} = {status:'unavailable',sessions:[]};
            if (Array.isArray(metadata)&&required.every(n=>metadata.some((r:{column_name:string})=>r.column_name===n))) {
                const indexes=await read<{index_name:string;column_name:string;seq:number}>(`SELECT INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schedule_sessions' LIMIT 80`);
                const indexed=indexes.some(r=>Number(r.seq)===1&&['tenant_id','group_id','starts_at'].every((n,i)=>indexes.some(p=>p.index_name===r.index_name&&Number(p.seq)===i+1&&p.column_name===n)));
                if (indexed) {
                    const sessions=await read<{id:string;title:string;starts_at:string}>(`SELECT id,title,DATE_FORMAT(starts_at,'%Y-%m-%dT%H:%i:%s.000Z') AS starts_at FROM schedule_sessions
                      WHERE tenant_id=? AND group_id=? AND audience='group' AND status='scheduled' AND starts_at>=UTC_TIMESTAMP() AND starts_at<DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY) ORDER BY starts_at,id LIMIT 21`,[tenantId,groupId]);
                    if (sessions.length>20 || new Set(sessions.map(s=>s.id)).size!==sessions.length) throw Error('Setup schedule cap');
                    if (sessions.some(s=>!uuid(s.id)||!label(s.title)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(s.starts_at)||!Number.isFinite(Date.parse(s.starts_at)))) throw Error('Invalid session');
                    schedule={status:'available',sessions:sessions.map(s=>({id:s.id,title:s.title,starts_at:s.starts_at}))};
                }
            }
            const issues:string[]=[];
            if (!active||!courseActive||!branchValid) issues.push('review_group');
            if (!teachers.length) issues.push('assign_instructor');
            if (!students.length) issues.push('add_students');
            else if (!live) issues.push('review_enrollments');
            if (missingAccount) issues.push('review_accounts');
            if (missingAssignment) issues.push('review_course_assignments');
            if (capacity===0||live>capacity) issues.push('review_capacity');
            if (schedule.status==='unavailable') issues.push('verify_schedule_source');
            else if (!schedule.sessions.length) issues.push('prepare_sessions');
            const finalGroup=await read<GroupRow>(GROUP_SQL,[tenantId,groupId]);
            if (!await owner()||finalGroup.length!==1||JSON.stringify(finalGroup[0])!==JSON.stringify(g)) return res.status(409).json({code:'GROUP_SETUP_CHANGED'});
            return res.json({group:{id:groupId.toLowerCase(),name:g.name,course_name:g.course_name,active,course_active:courseActive,branch_valid:branchValid,capacity},
                instructor:{status:teachers.length?'active':g.instructor_id===null?'not_assigned':'unavailable',name:teachers[0]?.name??null},
                students:{total:students.length,active:live,inactive:students.length-live,offline,missing_account:missingAccount,missing_course_assignment:missingAssignment},
                schedule,issues,next_action:issues[0]??'practice_handover',checked_at:(deps.now??(()=>new Date()))().toISOString(),readiness:'review_only'});
        } catch { discard=true; return res.status(503).json({code:'GROUP_SETUP_UNAVAILABLE'}); }
        finally { if (connection) { try { if(discard)connection.destroy();else connection.release(); } catch { try{connection.destroy();}catch{} } } }
    });
    return router;
}
