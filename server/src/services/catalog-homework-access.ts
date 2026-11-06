import type { AuthRequest } from '../middleware/auth';
import type { AssignmentsDataAccess } from '../routes/assignments';
import type { CourseLessonConnection } from '../routes/course-lessons';
import { proveStudentCatalogActivity } from './student-lesson-activities';
import { normalizeAllowedFileTypes, normalizeLatePolicy, normalizeResubmissionPolicy, MIN_FILE_BYTES, MAX_FILE_BYTES_LIMIT, MAX_SUBMISSIONS_LIMIT } from './assignments';
import { toUtcIso } from './content-release';
type Principal = NonNullable<AuthRequest['user']>;
export interface HomeworkSelectors {
    courseId: string;
    lessonId: string;
    contentId: string;
}
export interface CatalogHomeworkContext extends HomeworkSelectors {
    userId: string;
    tenantId: string;
    enrollmentId: string;
    assignmentId: string;
}
export class CatalogHomeworkDenied extends Error {
    constructor() { super('Catalog homework access denied'); }
}
export const homeworkUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
export function parseHomeworkContext(raw: unknown): CatalogHomeworkContext {
    let value: any = raw;
    if (typeof raw === 'string') {
        if (raw.length > 2048)
            throw new CatalogHomeworkDenied();
        try {
            value = JSON.parse(raw);
        }
        catch {
            throw new CatalogHomeworkDenied();
        }
    }
    const keys = ['courseId', 'lessonId', 'contentId', 'userId', 'tenantId', 'enrollmentId', 'assignmentId'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',') || !['courseId', 'lessonId', 'contentId', 'assignmentId'].every(k => homeworkUuid(value[k])) || !['userId', 'tenantId', 'enrollmentId'].every(k => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 64 && value[k].trim() === value[k]))
        throw new CatalogHomeworkDenied();
    return Object.fromEntries(keys.map(k => [k, value[k]])) as unknown as CatalogHomeworkContext;
}
export const sameHomeworkContext = (a: unknown, b: unknown) => JSON.stringify(parseHomeworkContext(a)) === JSON.stringify(parseHomeworkContext(b));
export interface CatalogHomeworkAuthority {
    ready(db: AssignmentsDataAccess): Promise<void>;
    hasBindings(db: AssignmentsDataAccess, assignmentId: string): Promise<boolean>;
    resolve(db: AssignmentsDataAccess, principal: Principal, selectors: HomeworkSelectors, lock?: boolean): Promise<CatalogHomeworkContext>;
    checkSubmission(db: AssignmentsDataAccess, context: CatalogHomeworkContext, id: string, lock?: boolean): Promise<void>;
}
const connectionFor = (db: AssignmentsDataAccess): CourseLessonConnection => ({ execute: async (sql, p) => [await db.query(sql, p), []], beginTransaction: async () => { throw Error('Engine owns transaction'); }, commit: async () => { throw Error('Engine owns transaction'); }, rollback: async () => { throw Error('Engine owns transaction'); }, release: () => { throw Error('Engine owns connection'); }, destroy: () => { throw Error('Engine owns connection'); } });
export const createCatalogHomeworkAuthority = (): CatalogHomeworkAuthority => ({
    async ready(db) {
        const columns = await db.query<any>(`SELECT COLUMN_NAME AS column_name,DATA_TYPE AS data_type,CHARACTER_MAXIMUM_LENGTH AS max_length,COLLATION_NAME AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_submissions' AND COLUMN_NAME IN ('catalog_context','catalog_request_key','object_etag') LIMIT 3`);
        if (!columns.some(r => r.column_name === 'catalog_context' && r.data_type === 'json') || !columns.some(r => r.column_name === 'catalog_request_key' && r.data_type === 'char' && Number(r.max_length) === 36 && r.collation_name === 'ascii_bin') || !columns.some(r => r.column_name === 'object_etag' && r.data_type === 'varchar' && Number(r.max_length) === 256 && r.collation_name === 'utf8mb4_0900_bin'))
            throw Error('Catalog homework schema unavailable');
        const engines = await db.query<any>(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('assignment_submissions','assignments','audit_events') LIMIT 3`);
        if (!['assignment_submissions', 'assignments', 'audit_events'].every(name => engines.some(r => r.table_name === name && r.engine === 'InnoDB')))
            throw Error('Catalog homework engine unavailable');
        const indexes = await db.query<any>(`SELECT INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_submissions' AND INDEX_NAME IN ('PRIMARY','uq_assignment_submission_version','uq_catalog_homework_request') ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 8`);
        for (const [name, columns] of [['PRIMARY', ['id']], ['uq_assignment_submission_version', ['assignment_id', 'student_enrollment_id', 'version']], ['uq_catalog_homework_request', ['tenant_id', 'student_enrollment_id', 'catalog_request_key']]] as const) {
            const found = indexes.filter(r => r.index_name === name);
            if (found.length !== columns.length || !columns.every((col, i) => found[i].column_name === col && Number(found[i].seq_in_index) === i + 1 && Number(found[i].non_unique) === 0))
                throw Error('Catalog homework index unavailable');
        }
    },
    async hasBindings(db, assignmentId) {
        const columns = await db.query<any>(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='course_lesson_activities' AND COLUMN_NAME IN ('assignment_id','kind')) OR (TABLE_NAME='assignment_submissions' AND COLUMN_NAME='catalog_context')) LIMIT 3`);
        const refs = columns.filter(r => r.table_name === 'course_lesson_activities');
        if (refs.length && refs.length !== 2)
            throw Error('Partial homework reference schema');
        if (refs.length && await db.queryOne(`SELECT id FROM course_lesson_activities WHERE assignment_id=? AND kind='homework' LIMIT 1`, [assignmentId]))
            return true;
        const marker = columns.find(r => r.table_name === 'assignment_submissions');
        if (marker && marker.data_type !== 'json')
            throw Error('Invalid homework context schema');
        return !!marker && !!await db.queryOne(`SELECT id FROM assignment_submissions WHERE assignment_id=? AND catalog_context IS NOT NULL LIMIT 1`, [assignmentId]);
    },
    async resolve(db, principal, selectors, lock = false) {
        if (!principal.tenantId || !principal.studentEnrollmentId || ![selectors.courseId, selectors.lessonId, selectors.contentId].every(homeworkUuid))
            throw new CatalogHomeworkDenied();
        await this.ready(db);
        if (lock && !await db.queryOne('SELECT id FROM courses WHERE id=? AND tenant_id=? FOR UPDATE', [selectors.courseId, principal.tenantId]))
            throw new CatalogHomeworkDenied();
        const proof = await proveStudentCatalogActivity(connectionFor(db), { userId: principal.id, tenantId: principal.tenantId, enrollmentId: principal.studentEnrollmentId }, selectors.courseId, selectors.lessonId, selectors.contentId, principal, lock);
        if (!proof.ok || proof.activity.kind !== 'homework')
            throw new CatalogHomeworkDenied();
        const policy = await db.queryOne<any>(`SELECT deadline_at,late_policy,resubmission_policy,max_submissions,max_file_bytes,allowed_file_types FROM assignments WHERE id=? AND tenant_id=? AND status='published' AND archived_at IS NULL LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [proof.activity.source_id, principal.tenantId]);
        let types: unknown = policy?.allowed_file_types;
        if (typeof types === 'string') {
            try {
                types = JSON.parse(types);
            }
            catch {
                throw Error('Invalid homework file policy');
            }
        }
        if (!policy || policy.deadline_at !== null && !toUtcIso(policy.deadline_at) || !normalizeLatePolicy(policy.late_policy) || !normalizeResubmissionPolicy(policy.resubmission_policy) || !Number.isInteger(Number(policy.max_submissions)) || Number(policy.max_submissions) < 1 || Number(policy.max_submissions) > MAX_SUBMISSIONS_LIMIT || !Number.isInteger(Number(policy.max_file_bytes)) || Number(policy.max_file_bytes) < MIN_FILE_BYTES || Number(policy.max_file_bytes) > MAX_FILE_BYTES_LIMIT || !normalizeAllowedFileTypes(types))
            throw Error('Invalid homework submission policy');
        return parseHomeworkContext({ ...selectors, userId: principal.id, tenantId: principal.tenantId, enrollmentId: principal.studentEnrollmentId, assignmentId: proof.activity.source_id });
    },
    async checkSubmission(db, context, id, lock = false) {
        const row = await db.queryOne<any>(`SELECT catalog_context,student_user_id FROM assignment_submissions WHERE id=? AND assignment_id=? AND tenant_id=? AND student_enrollment_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, context.assignmentId, context.tenantId, context.enrollmentId]);
        if (!row || row.student_user_id !== context.userId || !sameHomeworkContext(row.catalog_context, context))
            throw new CatalogHomeworkDenied();
    },
});
