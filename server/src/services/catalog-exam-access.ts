import type { AuthRequest } from '../middleware/auth';
import type { ExamVersionsDataAccess } from '../routes/exam-versions';
import type { CourseLessonConnection } from '../routes/course-lessons';
import { proveStudentCatalogActivity } from './student-lesson-activities';
import { lessonQuizVersionSchemaReady } from './lesson-quiz-versions';
import { buildSnapshotEntries, MAX_SNAPSHOT_QUESTIONS, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, MAX_GRACE_SECONDS, type SnapshotTiming } from './exam-snapshots';
import { normalizeScoringPolicy, toHundredths } from './exam-grading';
import { toUtcIso } from './content-release';
import { createHash } from 'crypto';
import { MAX_QUESTION_TEXT, MAX_OPTIONS, MAX_OPTION_LENGTH } from './question-bank';
export interface CatalogExamSelectors {
    courseId: string;
    lessonId: string;
    contentId: string;
}
export interface CatalogExamContext extends CatalogExamSelectors {
    userId: string;
    tenantId: string;
    enrollmentId: string;
    examId: string;
    versionId: string;
    snapshotFingerprint: string;
}
export interface CatalogAttemptView {
    id: string;
    tenant_id: string;
    exam_id: string;
    exam_version_id: string;
    student_enrollment_id: string;
    student_user_id: string;
    status: string;
}
type Principal = NonNullable<AuthRequest['user']>;
export interface CatalogExamAuthority {
    hasBindings(db: ExamVersionsDataAccess, examId: string): Promise<boolean>;
    resolve(db: ExamVersionsDataAccess, principal: Principal, selectors: CatalogExamSelectors, lock?: boolean): Promise<CatalogExamContext | null>;
    check(db: ExamVersionsDataAccess, principal: Principal, attempt: CatalogAttemptView, write?: boolean): Promise<boolean>;
    checkFrozen(db: ExamVersionsDataAccess, attempt: CatalogAttemptView): Promise<boolean>;
    draft(db: ExamVersionsDataAccess, principal: Principal, attempt: CatalogAttemptView): Promise<Record<string, unknown> | null>;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 64 && value.trim() === value;
const json = (value: string): unknown => { try {
    return JSON.parse(value);
}
catch {
    throw Error('Invalid stored catalog JSON');
} };
export function parseCatalogExamContext(raw: unknown): CatalogExamContext {
    const x = typeof raw === 'string' ? json(raw) : raw;
    const keys = ['courseId', 'lessonId', 'contentId', 'userId', 'tenantId', 'enrollmentId', 'examId', 'versionId', 'snapshotFingerprint'];
    if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).sort().join(',') !== [...keys].sort().join(','))
        throw Error('Invalid catalog attempt context');
    const row = x as Record<string, unknown>;
    if (!['courseId', 'lessonId', 'contentId', 'examId', 'versionId'].every(key => uuid(row[key])) || !['userId', 'tenantId', 'enrollmentId'].every(key => identity(row[key])))
        throw Error('Invalid catalog attempt context');
    if (typeof row.snapshotFingerprint !== 'string' || !/^[a-f\d]{64}$/.test(row.snapshotFingerprint))
        throw Error('Invalid snapshot fingerprint');
    return Object.fromEntries(keys.map(key => [key, row[key]])) as unknown as CatalogExamContext;
}
/** Shared proof functions need only execute; transaction ownership stays with the engine. */
const connectionFor = (db: ExamVersionsDataAccess): CourseLessonConnection => ({
    execute: async (sql: string, params?: any[]) => [await db.query(sql, params), []],
    beginTransaction: async () => { throw Error('Nested catalog transaction forbidden'); }, commit: async () => { throw Error('Nested catalog transaction forbidden'); }, rollback: async () => { throw Error('Nested catalog transaction forbidden'); },
    release: () => { throw Error('Engine owns connection'); }, destroy: () => { throw Error('Engine owns connection'); },
});
export class CatalogExamDenied extends Error {
    constructor() { super('Catalog exam access denied'); }
}
/** Validate, rather than repair, the existing engine's frozen content and timing. */
export async function validateCatalogExamSnapshot(db: ExamVersionsDataAccess, context: Pick<CatalogExamContext, 'versionId' | 'examId' | 'tenantId'>, lock = false): Promise<SnapshotTiming & {
    fingerprint: string;
}> {
    const header = await db.queryOne<any>(`SELECT id,duration_seconds,opens_at,closes_at,grace_seconds,total_points,passing_points,scoring_policy FROM exam_versions WHERE id=? AND exam_id=? AND tenant_id=? AND status='published' AND published_at IS NOT NULL LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [context.versionId, context.examId, context.tenantId]);
    const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
    if (!header || !integer(header.duration_seconds) || Number(header.duration_seconds) < MIN_DURATION_SECONDS || Number(header.duration_seconds) > MAX_DURATION_SECONDS || !integer(header.grace_seconds) || Number(header.grace_seconds) < 0 || Number(header.grace_seconds) > MAX_GRACE_SECONDS)
        throw Error('Invalid catalog snapshot timing');
    const opens = toUtcIso(header.opens_at), closes = toUtcIso(header.closes_at);
    if (header.opens_at !== null && !opens || header.closes_at !== null && !closes || opens && closes && Date.parse(opens) >= Date.parse(closes))
        throw Error('Invalid catalog snapshot window');
    const scoring = typeof header.scoring_policy === 'string' ? json(header.scoring_policy) : header.scoring_policy;
    if (scoring === undefined || scoring !== null && !normalizeScoringPolicy(scoring))
        throw Error('Invalid catalog scoring policy');
    const rows = await db.query<any>(`SELECT id,position,question_id,question_version,question_type,question_text,options,correct_answers,points,explanation,content_hash FROM exam_version_questions WHERE exam_version_id=? AND tenant_id=? ORDER BY position,id LIMIT 201${lock ? ' FOR UPDATE' : ''}`, [context.versionId, context.tenantId]);
    if (!rows.length || rows.length > MAX_SNAPSHOT_QUESTIONS || new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.position)).size !== rows.length)
        throw Error('Invalid catalog snapshot question bound');
    const array = (raw: unknown): string[] => { const value = typeof raw === 'string' ? json(raw) : raw; if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.length <= MAX_OPTION_LENGTH) || value.length > MAX_OPTIONS)
        throw Error('Invalid snapshot array'); return value; };
    const snapshot = buildSnapshotEntries(rows.map(row => {
        if (!uuid(row.id) || typeof row.question_id !== 'string' || !row.question_id || !Number.isInteger(Number(row.question_version)) || Number(row.question_version) < 1 || !Number.isInteger(row.position) || row.position < 1 || row.position > MAX_SNAPSHOT_QUESTIONS || typeof row.question_text !== 'string' || row.question_text.length > MAX_QUESTION_TEXT || toHundredths(row.points) === null || typeof row.content_hash !== 'string' || !/^[a-f\d]{64}$/i.test(row.content_hash))
            throw Error('Invalid snapshot question');
        return { source: { questionId: row.question_id, version: Number(row.question_version), questionType: row.question_type, questionText: row.question_text, options: array(row.options), correctAnswers: array(row.correct_answers), points: Number(row.points), explanation: row.explanation }, position: row.position };
    }));
    if (!snapshot.ok || snapshot.value.some((row, i) => row.contentHash !== rows[i].content_hash))
        throw Error('Catalog snapshot hash mismatch');
    const total = toHundredths(header.total_points), passing = toHundredths(header.passing_points), sum = snapshot.value.reduce((value, row) => value + toHundredths(row.points)!, 0);
    if (total === null || passing === null || total !== sum || passing < 0 || passing > total)
        throw Error('Invalid snapshot point totals');
    const timing = { durationSeconds: Number(header.duration_seconds), opensAtUtc: opens, closesAtUtc: closes, graceSeconds: Number(header.grace_seconds) };
    const fingerprint = createHash('sha256').update(JSON.stringify([context.versionId, timing, total, passing, normalizeScoringPolicy(scoring), rows.map(row => [row.id, row.position, row.content_hash])])).digest('hex');
    return { ...timing, fingerprint };
}
export const createCatalogExamAuthority = (): CatalogExamAuthority => {
    const contextColumn = async (db: ExamVersionsDataAccess) => {
        const rows = await db.query<any>(`SELECT COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exam_versioned_attempts' AND COLUMN_NAME='catalog_context' LIMIT 1`);
        if (rows.length && rows[0].data_type !== 'json')
            throw Error('Invalid catalog context column');
        return rows.some(row => row.column_name === 'catalog_context');
    };
    const ready = async (db: ExamVersionsDataAccess) => {
        if (!await contextColumn(db) || !await lessonQuizVersionSchemaReady(connectionFor(db)))
            throw Error('Catalog attempt schema unavailable');
        const engines = await db.query<any>(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('exam_versioned_attempts','exam_version_questions','exam_versioned_answers','exam_grading_runs') LIMIT 4`);
        if (!['exam_versioned_attempts', 'exam_version_questions', 'exam_versioned_answers', 'exam_grading_runs'].every(name => engines.some(row => row.table_name === name && row.engine === 'InnoDB')))
            throw Error('Catalog attempt engines unavailable');
        const indexes = await db.query<any>(`SELECT INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='exam_versioned_attempts' AND INDEX_NAME IN ('PRIMARY','uq_exam_attempt_student') ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 4`);
        for (const [name, columns] of [['PRIMARY', ['id']], ['uq_exam_attempt_student', ['exam_id', 'student_enrollment_id']]] as const) {
            const rows = indexes.filter(row => row.index_name === name);
            if (rows.length !== columns.length || !columns.every((column, i) => rows[i].column_name === column && Number(rows[i].seq_in_index) === i + 1 && Number(rows[i].non_unique) === 0))
                throw Error('Catalog attempt identity index unavailable');
        }
        const ledgers = await db.query<any>(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('exam_version_questions','exam_versioned_answers','exam_grading_runs') AND INDEX_NAME IN ('PRIMARY','uq_exam_version_question','uq_exam_answer','uq_exam_grading_run') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 16`);
        for (const [table, index, columns] of [['exam_version_questions', 'PRIMARY', ['id']], ['exam_version_questions', 'uq_exam_version_question', ['exam_version_id', 'position']], ['exam_versioned_answers', 'PRIMARY', ['id']], ['exam_versioned_answers', 'uq_exam_answer', ['attempt_id', 'question_ref']], ['exam_grading_runs', 'PRIMARY', ['id']], ['exam_grading_runs', 'uq_exam_grading_run', ['attempt_id', 'idempotency_key']]] as const) {
            const rows = ledgers.filter(row => row.table_name === table && row.index_name === index);
            if (rows.length !== columns.length || !columns.every((column, i) => rows[i].column_name === column && Number(rows[i].seq_in_index) === i + 1 && Number(rows[i].non_unique) === 0))
                throw Error('Catalog grading index unavailable');
        }
    };
    const hasBindings: CatalogExamAuthority['hasBindings'] = async (db, examId) => {
        const columns = await db.query<any>(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_lesson_quiz_versions' LIMIT 4`);
        if (!columns.length)
            return false;
        if (!['content_id', 'exam_id', 'exam_version_id'].every(name => columns.some(row => row.column_name === name)))
            throw Error('Catalog quiz schema unavailable');
        return !!await db.queryOne('SELECT content_id FROM course_lesson_quiz_versions WHERE exam_id=? LIMIT 1', [examId]);
    };
    const resolve: CatalogExamAuthority['resolve'] = async (db, principal, selectors, lock = false) => {
        if (!principal.studentEnrollmentId || !principal.tenantId || ![selectors.courseId, selectors.lessonId, selectors.contentId].every(uuid))
            return null;
        await ready(db);
        const proof = await proveStudentCatalogActivity(connectionFor(db), { userId: principal.id, tenantId: principal.tenantId, enrollmentId: principal.studentEnrollmentId }, selectors.courseId, selectors.lessonId, selectors.contentId, principal, lock);
        if (!proof.ok || proof.activity.kind !== 'quiz')
            return null;
        const pin = await db.queryOne<any>(`SELECT q.exam_id,q.exam_version_id FROM course_lesson_quiz_versions q INNER JOIN exam_versions v ON v.id=q.exam_version_id AND v.exam_id=q.exam_id AND v.tenant_id=? AND v.status='published' AND v.published_at IS NOT NULL WHERE q.content_id=? AND q.exam_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [principal.tenantId, proof.activity.content_id, proof.activity.source_id]);
        if (!pin)
            return null;
        const fingerprint = (await validateCatalogExamSnapshot(db, { examId: pin.exam_id, versionId: pin.exam_version_id, tenantId: principal.tenantId }, lock)).fingerprint;
        return parseCatalogExamContext({ courseId: selectors.courseId, lessonId: selectors.lessonId, contentId: selectors.contentId, userId: principal.id, tenantId: principal.tenantId, enrollmentId: principal.studentEnrollmentId, examId: pin.exam_id, versionId: pin.exam_version_id, snapshotFingerprint: fingerprint });
    };
    const authority: CatalogExamAuthority = { hasBindings, resolve, draft: async (db, principal, attempt) => {
            if (!await authority.check(db, principal, attempt))
                throw new CatalogExamDenied();
            if (!await contextColumn(db))
                return null;
            const marker = await db.queryOne<any>('SELECT catalog_context FROM exam_versioned_attempts WHERE id=? AND tenant_id=? LIMIT 1', [attempt.id, attempt.tenant_id]);
            if (!marker || marker.catalog_context === null)
                return null;
            const rows = await db.query<any>(`SELECT a.question_ref,q.id AS valid_ref,OCTET_LENGTH(CAST(a.response AS CHAR)) AS response_bytes,CASE WHEN OCTET_LENGTH(CAST(a.response AS CHAR))<=131072 THEN CAST(a.response AS CHAR) ELSE NULL END AS response_json
      FROM exam_versioned_answers a LEFT JOIN exam_version_questions q ON q.id=a.question_ref AND q.tenant_id=a.tenant_id AND q.exam_version_id=a.exam_version_id
      WHERE a.attempt_id=? AND a.tenant_id=? AND a.exam_version_id=? ORDER BY a.question_ref LIMIT 201`, [attempt.id, attempt.tenant_id, attempt.exam_version_id]);
            if (rows.length > MAX_SNAPSHOT_QUESTIONS)
                throw Error('Catalog draft exceeds bound');
            const answers: Record<string, unknown> = {};
            for (const row of rows) {
                if (!uuid(row.question_ref) || row.valid_ref !== row.question_ref || Object.prototype.hasOwnProperty.call(answers, row.question_ref) || Number(row.response_bytes ?? 0) > 131072)
                    throw Error('Invalid catalog draft');
                answers[row.question_ref] = row.response_json === null ? null : json(row.response_json);
            }
            if (Buffer.byteLength(JSON.stringify(answers), 'utf8') > 131072)
                throw Error('Catalog draft exceeds byte bound');
            return answers;
        }, checkFrozen: async (db, attempt) => {
            if (!await contextColumn(db))
                return true;
            const row = await db.queryOne<any>('SELECT catalog_context FROM exam_versioned_attempts WHERE id=? AND tenant_id=? LIMIT 1', [attempt.id, attempt.tenant_id]);
            if (!row)
                return false;
            if (row.catalog_context === null)
                return true;
            const context = parseCatalogExamContext(row.catalog_context);
            if (context.examId !== attempt.exam_id || context.versionId !== attempt.exam_version_id || context.userId !== attempt.student_user_id || context.enrollmentId !== attempt.student_enrollment_id || context.tenantId !== attempt.tenant_id)
                return false;
            return (await validateCatalogExamSnapshot(db, context, true)).fingerprint === context.snapshotFingerprint;
        }, check: async (db, principal, attempt, write = false) => {
            if (principal.role !== 'student' || principal.id !== attempt.student_user_id || principal.tenantId !== attempt.tenant_id || principal.studentEnrollmentId !== attempt.student_enrollment_id)
                return false;
            if (!await contextColumn(db))
                return !await hasBindings(db, attempt.exam_id);
            const load = (lock: boolean) => db.queryOne<any>(`SELECT id,exam_id,exam_version_id,student_user_id,student_enrollment_id,tenant_id,status,catalog_context FROM exam_versioned_attempts WHERE id=? AND tenant_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [attempt.id, attempt.tenant_id]);
            let row = await load(false);
            const valid = (item: any) => item && item.exam_id === attempt.exam_id && item.exam_version_id === attempt.exam_version_id && item.student_user_id === principal.id && item.student_enrollment_id === principal.studentEnrollmentId && (!write || item.status === 'in_progress');
            if (!valid(row))
                return false;
            if (row.catalog_context === null) {
                if (write) {
                    row = await load(true);
                    if (!valid(row) || row.catalog_context !== null)
                        return false;
                }
                return !await hasBindings(db, row.exam_id);
            }
            const context = parseCatalogExamContext(row.catalog_context);
            if (context.userId !== principal.id || context.tenantId !== row.tenant_id || context.enrollmentId !== row.student_enrollment_id || context.examId !== row.exam_id || context.versionId !== row.exam_version_id)
                return false;
            if (write) {
                if (!await db.queryOne('SELECT id FROM courses WHERE id=? AND tenant_id=? FOR UPDATE', [context.courseId, context.tenantId]))
                    return false;
                row = await load(true);
                if (!valid(row) || JSON.stringify(parseCatalogExamContext(row.catalog_context)) !== JSON.stringify(context))
                    return false;
            }
            const fresh = await resolve(db, principal, context, write);
            return !!fresh && JSON.stringify(fresh) === JSON.stringify(context);
        } };
    return authority;
};
