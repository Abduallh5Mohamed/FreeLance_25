import type { AuthRequest } from '../middleware/auth';
import type { CourseLessonConnection } from '../routes/course-lessons';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';
export const CENTER_PERMISSIONS = ['groups.read', 'attendance.mark', 'tasks.manage'] as const;
export type CenterPermission = typeof CENTER_PERMISSIONS[number];
export const centerUuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
export const centerPermissions = (raw: unknown): CenterPermission[] => {
  const x = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(x) || !x.length || x.length > 3 || new Set(x).size !== x.length || x.some(v => !CENTER_PERMISSIONS.includes(v))) throw Error('Invalid center permissions');
  return [...x].sort();
};
export class CenterDenied extends Error { constructor(public status = 404, public code = 'CENTER_SCOPE_DENIED') { super(code); } }
export class CenterConflict extends Error {}
export interface CenterDb { query(sql: string, p?: unknown[]): Promise<any[]>; execute(sql: string, p?: unknown[]): Promise<{ affectedRows: number }> }
export function centerDb(c: CourseLessonConnection): CenterDb {
  return { query: async (s, p = []) => { const [r] = await c.execute(s, p); if (!Array.isArray(r)) throw Error('Invalid SQL rows'); return r; },
    execute: async (s, p = []) => { const [r] = await c.execute(s, p); if (!r || !Number.isSafeInteger((r as any).affectedRows)) throw Error('Write not confirmed'); return r as any; } };
}
export async function centerTeamReady(db: CenterDb) {
  const names=['center_team_members','center_team_branches','center_team_tasks','center_team_operations','users','tenants','branches','audit_events'];
  const engines=await db.query(`SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${names.map(()=>'?').join(',')}) LIMIT 8`,names);
  if(!names.every(n=>engines.some(e=>e.name===n&&e.engine==='InnoDB')))throw Error('Center transaction schema unavailable');
  const cols=await db.query("SELECT TABLE_NAME AS name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type,COLLATION_NAME AS collation_name,CHARACTER_MAXIMUM_LENGTH AS max_length FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='center_team_members' AND COLUMN_NAME='permissions') OR (TABLE_NAME='center_team_operations' AND COLUMN_NAME IN ('id','result')) OR (TABLE_NAME='users' AND COLUMN_NAME='center_account')) LIMIT 4");
  if(!cols.some(c=>c.name==='users'&&c.column_name==='center_account'&&c.data_type==='tinyint')||!cols.some(c=>c.name==='center_team_members'&&c.column_name==='permissions'&&c.data_type==='json')||!cols.some(c=>c.name==='center_team_operations'&&c.column_name==='result'&&c.data_type==='json')||!cols.some(c=>c.name==='center_team_operations'&&c.column_name==='id'&&c.data_type==='char'&&Number(c.max_length)===36&&c.collation_name==='ascii_bin'))throw Error('Center receipt schema unavailable');
  const ix=await db.query("SELECT TABLE_NAME AS name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('center_team_members','center_team_branches','center_team_operations','center_team_tasks') LIMIT 40");
  for(const [table,columns]of [['center_team_members',['id']],['center_team_members',['user_id']],['center_team_branches',['member_id','branch_id']],['center_team_operations',['id']],['center_team_tasks',['id']]]as const){const starts=ix.filter(i=>i.name===table&&Number(i.seq)===1&&Number(i.non_unique)===0);if(!starts.some(s=>{const parts=ix.filter(i=>i.name===table&&i.index_name===s.index_name).sort((a,b)=>Number(a.seq)-Number(b.seq));return parts.length===columns.length&&columns.every((c,n)=>parts[n].column_name===c);}))throw Error('Center identity index unavailable');}
}
const live = (a: string) => `NOT ${ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, a + '.suspended_until')}`;
export async function centerAttendanceReady(db: CenterDb) {
  const names = ['attendance_records', 'schedule_sessions', 'students'];
  const tables = await db.query('SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?) LIMIT 3', names);
  if (!names.every(name => tables.some(t => t.name === name && t.engine === 'InnoDB'))) throw Error('Center attendance transaction schema unavailable');
  const indexes = await db.query("SELECT INDEX_NAME AS name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='attendance_records' AND NON_UNIQUE=0 ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 30");
  if (!indexes.some(i => Number(i.seq) === 1 && i.column_name === 'session_id' && indexes.filter(p => p.name === i.name).length === 2 && indexes.some(p => p.name === i.name && Number(p.seq) === 2 && p.column_name === 'student_id'))) throw Error('Center attendance identity unavailable');
}
export async function proveCenterOwner(db: CenterDb, actor: NonNullable<AuthRequest['user']>, lock = false) {
  if (!actor.tenantId || actor.identitySource === 'staff' || actor.billingOnly) throw new CenterDenied(403);
  const rows = await db.query(`SELECT t.id FROM tenants t INNER JOIN users u ON u.id=t.owner_user_id
    WHERE t.id=? AND t.owner_user_id=? AND t.status='active' AND u.is_active=1 AND ${live('u')} AND COALESCE(u.token_version,0)=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [actor.tenantId, actor.id, actor.tokenVersion??0]);
  if (!rows.some(r => r.id === actor.tenantId)) throw new CenterDenied(403);
  return actor.tenantId;
}
export async function proveCenterMember(db: CenterDb, actor: NonNullable<AuthRequest['user']>, memberId: string, permission?: CenterPermission, lock = false) {
  if (actor.identitySource === 'staff' || actor.billingOnly || !centerUuid(memberId)) throw new CenterDenied();
  const rows = await db.query(`SELECT m.id,m.tenant_id,m.user_id,m.permissions,m.status,m.version
    FROM center_team_members m INNER JOIN tenants t ON t.id=m.tenant_id AND t.status='active'
    INNER JOIN users u ON u.id=m.user_id AND u.is_active=1 AND u.role='staff' AND u.center_account=1 AND ${live('u')}
    WHERE m.id=? AND m.user_id=? AND m.status='active' AND COALESCE(u.token_version,0)=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [memberId, actor.id, actor.tokenVersion ?? 0]);
  if (rows.length !== 1) throw new CenterDenied();
  const m = rows[0], permissions = centerPermissions(m.permissions);
  if (permission && !permissions.includes(permission)) throw new CenterDenied();
  return { ...m, permissions };
}
export async function proveCenterBranch(db: CenterDb, tenantId: string, memberId: string, branchId: string, lock = false) {
  const rows = await db.query(`SELECT b.id FROM branches b INNER JOIN center_team_branches mb ON mb.branch_id=b.id AND mb.member_id=?
    WHERE b.id=? AND b.tenant_id=? AND b.status='active' LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [memberId, branchId, tenantId]);
  if (rows.length !== 1) throw new CenterDenied();
}
export async function centerAudit(db: CenterDb, actorId: string, tenantId: string, action: string, resource: string, result: unknown) {
  const { randomUUID } = await import('node:crypto');
  const r=await db.execute('INSERT INTO audit_events(id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value) VALUES(?,?,?,?,?,?,?)', [randomUUID(), actorId, tenantId, action, 'center_team', resource, JSON.stringify(result)]);
  if(r.affectedRows!==1)throw Error('Center audit not confirmed');
}
