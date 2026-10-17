/**
 * M1 expanded file-authority regressions (hermetic: no DB, no network, no
 * real env keys, no Docker, no live app startup).
 *
 * Drives the production files router (`createFilesRouter`) through injected
 * seams: a fixture SQL adapter that mirrors the emitted lookup's WHERE
 * semantics (id AND tenant), the REAL authentication middleware
 * (createAuthenticateToken) over an injected principal repository, and a
 * temporary on-disk uploads tree holding the fixture bytes. No MySQL pool is
 * ever created because no production query runs; db.ts's dotenv.config() at
 * import loads nothing (no .env exists on disk, verified by the sibling M1
 * boundary suites).
 *
 * Audit dimensions covered by the suite (from the task scope): authentication,
 * selected-tenant denial, exact resource ownership / cross-user and
 * cross-tenant isolation, path traversal and link (symlink/junction)
 * canonicalization, forged object identifiers, unsafe filename/header
 * injection, read authorization, and active-content (HTML/SVG) response
 * policy. The router has no delete/write handlers, so unauthorized
 * delete/write cannot occur on it; the suite pins the read path only.
 *
 * Evidence classes, labeled per test:
 *  - behavioral: the real handler's own decision (status code, headers,
 *    whether sendFile was reached, recorded SQL bindings).
 *  - decision-boundary (SQL text + params): the tenant scope is applied by
 *    the WHERE clause, so hermetically the suite asserts the exact SQL and
 *    bindings the handler executed. Live row-level filtering remains the
 *    Docker integration suite's responsibility (NOT RUN here).
 *  - filesystem: containment is decided against a real temp directory with a
 *    real link, so escape attempts are exercised against real kernel
 *    semantics, not a mock of path logic.
 *
 * Test limits (explicit):
 *  - The HTTP layer is not exercised (no supertest in the repo): the router
 *    is invoked as middleware with fake req/res objects, matching the
 *    established m1-materials-boundary pattern.
 *  - sendFile streams bytes in production; here it is observed (target path
 *    and error callback), not executed.
 *  - The link-escape test requires creating a directory link; on Windows a
 *    junction is used (works unprivileged). If link creation is denied, the
 *    test skips and the gap is reported instead of silently passing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateHeaderValue } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Response } from 'express';
import {
    createFilesRouter,
    FilesRouterDeps,
    TenantMediaFileRow,
} from '../src/routes/files';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';
import { AuthRequest, createAuthenticateToken } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const originalSecret = process.env.JWT_SECRET;
const originalCwd = process.cwd();

let workspace = '';
let linkEscapeAvailable = false;

const uploadsRoot = (): string => path.join(workspace, 'uploads');

before(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-files-'));
    fs.mkdirSync(path.join(workspace, 'uploads', 'questions'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'uploads-evil'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'uploads', 'questions', 'own.png'), 'png-a');
    fs.writeFileSync(path.join(workspace, 'uploads', 'questions', 'own-b.png'), 'png-b');
    fs.writeFileSync(path.join(workspace, 'outside', 'secret.txt'), 'TOP-SECRET');
    fs.writeFileSync(path.join(workspace, 'uploads-evil', 'secret.txt'), 'EVIL');
    // A directory link INSIDE the uploads root that physically targets a
    // directory OUTSIDE it: the escape shape the lexical prefix check
    // cannot see. Junction on Windows (unprivileged), symlink elsewhere.
    const linkTarget = path.join(workspace, 'outside');
    const linkPath = path.join(workspace, 'uploads', 'questions', 'escape');
    for (const type of process.platform === 'win32'
        ? (['junction', 'dir'] as const)
        : (['dir'] as const)) {
        try {
            fs.symlinkSync(linkTarget, linkPath, type);
            linkEscapeAvailable = true;
            break;
        } catch {
            // try the next link kind
        }
    }
    process.chdir(workspace);
});

after(() => {
    process.chdir(originalCwd);
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures: two tenants, ownership, parent-resource relations, hostile rows
// ---------------------------------------------------------------------------

interface MediaRow extends TenantMediaFileRow {
    tenant_id: string;
    uploaded_by: string;
}

interface Fixtures {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number }>;
    staff: Record<string, { is_active: number }>;
    instructorAccounts: Record<string, never>;
    enrollments: Record<string, Array<{
        id: string; user_id: string; tenant_id: string;
        instructor_id: string | null; group_id: string | null; grade_id: string | null;
    }>>;
    memberships: Record<string, Array<{ tenant_id: string }>>;
    files: Record<string, MediaRow>;
    /** Private chat attachments written by POST /api/messages/upload-image. */
    messages: Array<{ id: string; sender_id: string; receiver_id: string; image_url: string }>;
    /** Groups carry the instructor ownership the exam/receipt scopes prove. */
    groups: Array<{ id: string; instructor_id: string }>;
    examGroups: Array<{ exam_id: string; group_id: string }>;
    examQuestions: Array<{ id: string; exam_id: string; question_image: string | null }>;
    examAttempts: Array<{ id: string; exam_id: string; student_id: string }>;
    premiumLectures: Array<{ id: string; group_id: string }>;
    premiumPayments: Array<{ id: string; premium_lecture_id: string; receipt_image_url: string }>;
    dbFailure?: boolean;
}

const makeFixtures = (): Fixtures => ({
    users: {
        'teacher-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-none': { is_active: 1, token_version: 0, suspension_active: 0 },
        'teacher-multi': { is_active: 1, token_version: 0, suspension_active: 0 },
        // Same tenant as file-a1 but related to none of its rows: the
        // "unrelated member" authority test principal.
        'teacher-a-other': { is_active: 1, token_version: 0, suspension_active: 0 },
        // Non-owner uploader of an exam question image (exam belongs to
        // teacher-a's group): proves parent-resource entitlement without
        // being the uploader.
        'teacher-uploader': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0 },
        'student-b': { is_active: 1, token_version: 0, suspension_active: 0 },
        // Same-tenant student with no attempt on the exam: denied.
        'student-c': { is_active: 1, token_version: 0, suspension_active: 0 },
        // Receiver of a chat attachment: participant without being uploader.
        'student-x': { is_active: 1, token_version: 0, suspension_active: 0 },
        'platform-admin': { is_active: 1, token_version: 0, suspension_active: 0 },
        'revoked-user': { is_active: 0, token_version: 0, suspension_active: 0 },
        'stale-token-user': { is_active: 1, token_version: 3, suspension_active: 0 },
    },
    staff: {},
    instructorAccounts: {},
    enrollments: {
        'student-a': [{
            id: 'enrollment-a', user_id: 'student-a', tenant_id: 'tenant-a',
            instructor_id: 'instructor-a', group_id: 'group-a', grade_id: 'grade-a',
        }],
        'student-b': [{
            id: 'enrollment-b', user_id: 'student-b', tenant_id: 'tenant-b',
            instructor_id: 'instructor-b', group_id: 'group-b', grade_id: 'grade-b',
        }],
        'student-c': [{
            id: 'enrollment-c', user_id: 'student-c', tenant_id: 'tenant-a',
            instructor_id: 'instructor-a', group_id: 'group-a', grade_id: 'grade-a',
        }],
        'student-x': [{
            id: 'enrollment-x', user_id: 'student-x', tenant_id: 'tenant-a',
            instructor_id: 'instructor-a', group_id: 'group-a', grade_id: 'grade-a',
        }],
    },
    memberships: {
        'teacher-a': [{ tenant_id: 'tenant-a' }],
        'teacher-b': [{ tenant_id: 'tenant-b' }],
        'teacher-none': [],
        'teacher-multi': [{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }],
        'teacher-a-other': [{ tenant_id: 'tenant-a' }],
        'teacher-uploader': [{ tenant_id: 'tenant-a' }],
        'platform-admin': [],
    },
    files: {
        'file-a1': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'own.png',
        },
        'file-a2-missing': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/absent.png',
            mime_type: 'image/png', original_name: 'absent.png',
        },
        'file-b1': {
            tenant_id: 'tenant-b', uploaded_by: 'teacher-b',
            storage_path: 'uploads/questions/own-b.png',
            mime_type: 'image/png', original_name: 'own-b.png',
        },
        'file-a-traversal': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: '../../outside/secret.txt',
            mime_type: 'text/plain', original_name: 'secret.txt',
        },
        'file-a-absolute': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: os.tmpdir(),
            mime_type: 'application/octet-stream', original_name: 'tmp',
        },
        'file-a-sibling-prefix': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads-evil/secret.txt',
            mime_type: 'text/plain', original_name: 'secret.txt',
        },
        'file-a-link-escape': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/escape/secret.txt',
            mime_type: 'text/plain', original_name: 'secret.txt',
        },
        'file-a-root-itself': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads',
            mime_type: 'application/octet-stream', original_name: 'uploads',
        },
        'file-a-empty-path': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: '   ',
            mime_type: 'image/png', original_name: 'x.png',
        },
        'file-a-malformed-mime': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png\r\nX-Injected: 1', original_name: 'own.png',
        },
        'file-a-nonmime': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'not-a-media-type', original_name: 'own.png',
        },
        'file-a-null-mime': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: null as unknown as string, original_name: 'own.png',
        },
        // Active document content that must never render inline.
        'file-a-html': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'text/html', original_name: 'own.png',
        },
        'file-a-svg': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/svg+xml', original_name: 'own.png',
        },
        'file-a-html-upper': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'TEXT/HTML', original_name: 'own.png',
        },
        'file-a-hostile-name': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'ev"il\r\nname.png',
        },
        'file-a-traversal-name': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: '../../etc/passwd',
        },
        'file-a-null-name': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: null as unknown as string,
        },
        'file-a-case-variant': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/QUESTIONS/own.png',
            mime_type: 'image/png', original_name: 'own.png',
        },
        // original_name is stored from the client-supplied multipart filename
        // (req.file.originalname), so it can carry any script. Non-Latin1 names
        // are common (e.g. Arabic/CJK receipt scans) and Node's header writer
        // rejects those code units, so the download must sanitize them.
        'file-a-cjk-name': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: '测试.png',
        },
        'file-a-emoji-name': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: '🎓 receipt.png',
        },
        'file-a-latin1-name': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'café.png',
        },
        // Authority fixtures: parent-resource relations the server wrote.
        // Chat attachment uploaded by teacher-a, addressed to student-a
        // (participant without being the uploader).
        'file-a-msg-to-student': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'chat.png',
        },
        // Chat attachment uploaded by student-a, addressed to student-x.
        'file-a-msg-to-x': {
            tenant_id: 'tenant-a', uploaded_by: 'student-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'chat-x.png',
        },
        // Exam question image of an exam owned by teacher-a's group, uploaded
        // by a different teacher: entitlement must come from the exam scope.
        'file-a-exam-other-upload': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-uploader',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'exam-a.png',
        },
        // Exam question image of an exam the student attempted.
        'file-a-exam-attempt': {
            tenant_id: 'tenant-a', uploaded_by: 'teacher-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'exam-b.png',
        },
        // Premium lecture payment receipt (uploader = paying student).
        'file-a-receipt': {
            tenant_id: 'tenant-a', uploaded_by: 'student-a',
            storage_path: 'uploads/questions/own.png',
            mime_type: 'image/png', original_name: 'receipt.png',
        },
    },
    messages: [
        {
            id: 'msg-to-student', sender_id: 'teacher-a', receiver_id: 'student-a',
            image_url: '/api/files/file-a-msg-to-student/download',
        },
        {
            id: 'msg-to-x', sender_id: 'student-a', receiver_id: 'student-x',
            image_url: '/api/files/file-a-msg-to-x/download',
        },
    ],
    groups: [
        { id: 'group-a', instructor_id: 'teacher-a' },
        { id: 'group-b', instructor_id: 'teacher-b' },
    ],
    examGroups: [
        { exam_id: 'exam-a', group_id: 'group-a' },
        { exam_id: 'exam-b', group_id: 'group-b' },
    ],
    examQuestions: [
        { id: 'q-a', exam_id: 'exam-a', question_image: '/api/files/file-a-exam-other-upload/download' },
        { id: 'q-b', exam_id: 'exam-b', question_image: '/api/files/file-a-exam-attempt/download' },
    ],
    examAttempts: [
        { id: 'attempt-a', exam_id: 'exam-b', student_id: 'student-a' },
    ],
    premiumLectures: [
        { id: 'lecture-1', group_id: 'group-a' },
    ],
    premiumPayments: [
        {
            id: 'pay-1', premium_lecture_id: 'lecture-1',
            receipt_image_url: '/api/files/file-a-receipt/download',
        },
    ],
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => f.users[id] ?? null,
    findStaffIdentity: async (id) => f.staff[id] ?? null,
    findInstructorAccount: async (id) => f.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id) => f.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id) => f.memberships[id] ?? [],
});

interface ExecutedStatement { sql: string; params: unknown[] }

const downloadUrlOf = (fileId: string): string => `/api/files/${fileId}/download`;

/**
 * Mirrors the SQL EXISTS branches the handler emits for parent-resource
 * authority: a private message participant, the owning instructor of the
 * exam (via exam_groups -> groups.instructor_id), a student with an attempt
 * on the exam, and the instructor owning the receipt's lecture group.
 */
const hasParentEntitlement = (f: Fixtures, fileId: string, callerId: string): boolean => {
    const url = downloadUrlOf(fileId);
    if (f.messages.some((m) => m.image_url === url && (m.sender_id === callerId || m.receiver_id === callerId))) {
        return true;
    }
    const examOwnerMatches = f.examQuestions.some(
        (q) => q.question_image === url
            && f.examGroups.some((eg) => eg.exam_id === q.exam_id
                && f.groups.some((g) => g.id === eg.group_id && g.instructor_id === callerId)),
    );
    if (examOwnerMatches) return true;
    const examAttemptMatches = f.examQuestions.some(
        (q) => q.question_image === url
            && f.examAttempts.some((a) => a.exam_id === q.exam_id && a.student_id === callerId),
    );
    if (examAttemptMatches) return true;
    return f.premiumPayments.some(
        (p) => p.receipt_image_url === url
            && f.premiumLectures.some((pl) => pl.id === p.premium_lecture_id
                && f.groups.some((g) => g.id === pl.group_id && g.instructor_id === callerId)),
    );
};

/**
 * Mirrors the WHERE semantics of the emitted lookup: id AND tenant AND
 * (exact uploader OR a server-written parent-resource participant relation).
 */
const makeDb = (f: Fixtures, executed: ExecutedStatement[]): FilesRouterDeps['db'] => ({
    queryOne: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
        executed.push({ sql, params });
        if (f.dbFailure) throw new Error('simulated database failure');
        if (!sql.includes('FROM tenant_media_files')) return null;
        const [id, tenantId, callerId] = params as [string, string, string];
        const row = f.files[id];
        if (!row || row.tenant_id !== tenantId) return null;
        if (row.uploaded_by !== callerId && !hasParentEntitlement(f, id, callerId)) return null;
        return row as T;
    },
});

const makeHarness = (fixtures: Fixtures = makeFixtures()) => {
    const executed: ExecutedStatement[] = [];
    const deps: FilesRouterDeps = {
        db: makeDb(fixtures, executed),
        authenticate: createAuthenticateToken(makeRepository(fixtures)) as RequestHandler,
        storageRoot: uploadsRoot(),
        branchAccess: tenantScopeBranchDeps((type, id) =>
            type === 'file' ? fixtures.files[id]?.tenant_id ?? null : null),
    };
    return { router: createFilesRouter(deps), executed, fixtures };
};

// ---------------------------------------------------------------------------
// Fake request/response invocation (same shape as m1-materials-boundary)
// ---------------------------------------------------------------------------

interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
}

interface SendFileObservation {
    called: boolean;
    filePath?: string;
}

/** res.sendFile is both the call the handler makes and the observation point. */
type SendFileFn = ((
    filePath: string,
    callback?: (err?: NodeJS.ErrnoException) => void,
) => CapturedResponse) & SendFileObservation;

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
    sendFile: SendFileFn;
    headersSent: boolean;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
    setHeader(name: string, value: string): CapturedResponse;
    end(): CapturedResponse;
}

interface InvokeOptions {
    /** Error the simulated sendFile stream delivers to the handler's callback. */
    sendFileError?: NodeJS.ErrnoException;
    /** True once bytes/headers were already on the wire. */
    headersSentOnStreamError?: boolean;
}

const invokeRoute = async (
    router: ReturnType<typeof createFilesRouter>,
    request: RouteRequest,
    options: InvokeOptions = {},
): Promise<CapturedResponse> => {
    const response = {
        headers: {},
        headersSent: false,
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) { response.body = payload; return response; },
        setHeader(name: string, value: string) {
            // Model Node's own header writer: an invalid value (control chars
            // or anything above latin1) throws here in production, which the
            // handler's catch turns into a 500.
            validateHeaderValue(name, value);
            response.headers[name] = value;
            return response;
        },
        end() { return response; },
    } as CapturedResponse;
    const sendFile = ((filePath: string, callback?: (err?: NodeJS.ErrnoException) => void) => {
        sendFile.called = true;
        sendFile.filePath = filePath;
        if (options.sendFileError) {
            if (options.headersSentOnStreamError) {
                // Bytes/headers already left: the stream's own answer (200)
                // stands and the handler must not rewrite it.
                if (response.statusCode === undefined) response.statusCode = 200;
                response.headersSent = true;
            }
            callback?.(options.sendFileError);
            return response;
        }
        // Express's res.sendFile starts the stream with 200 when the file
        // is being transferred successfully.
        if (response.statusCode === undefined) response.statusCode = 200;
        return response;
    }) as SendFileFn;
    sendFile.called = false;
    response.sendFile = sendFile;

    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
    };
    // Express does not await async handlers; poll (bounded) until the fake
    // response settles on a final answer.
    const settled = (): boolean =>
        response.statusCode !== undefined || response.body !== undefined;
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {
        response.statusCode = 404; // unmatched route
    });
    const deadline = Date.now() + 5000;
    while (!settled() && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);

const TEACHER_A = tokenFor({ id: 'teacher-a', role: 'teacher', tv: 0 });
const TEACHER_B = tokenFor({ id: 'teacher-b', role: 'teacher', tv: 0 });
const TEACHER_NONE = tokenFor({ id: 'teacher-none', role: 'teacher', tv: 0 });
const TEACHER_MULTI_FORGED = tokenFor({ id: 'teacher-multi', role: 'teacher', tv: 0, tenant_id: 'tenant-c' });
const TEACHER_A_OTHER = tokenFor({ id: 'teacher-a-other', role: 'teacher', tv: 0 });
const TEACHER_UPLOADER = tokenFor({ id: 'teacher-uploader', role: 'teacher', tv: 0 });
const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enrollment-b' });
const STUDENT_C = tokenFor({ id: 'student-c', role: 'student', tv: 0, student_enrollment_id: 'enrollment-c' });
const STUDENT_X = tokenFor({ id: 'student-x', role: 'student', tv: 0, student_enrollment_id: 'enrollment-x' });
const PLATFORM_ADMIN = tokenFor({ id: 'platform-admin', role: 'admin', tv: 0 });
const REVOKED_USER = tokenFor({ id: 'revoked-user', role: 'teacher', tv: 0 });
const STALE_TOKEN_USER = tokenFor({ id: 'stale-token-user', role: 'teacher', tv: 0 });

const download = (fileId: string): RouteRequest => ({ method: 'GET', url: `/${fileId}/download` });
const ownA = path.join(uploadsRoot(), 'questions', 'own.png');
const ownB = path.join(uploadsRoot(), 'questions', 'own-b.png');

// ---------------------------------------------------------------------------
// Authentication rejections (behavioral)
// ---------------------------------------------------------------------------

test('anonymous download is denied with 401 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, download('file-a1'));
    assert.equal(response.statusCode, 401);
    assert.equal(response.sendFile.called, false);
    assert.equal(executed.length, 0, 'no media lookup may run for an anonymous caller');
});

test('forged or malformed token is denied with 401', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: 'not-a-jwt' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.sendFile.called, false);
    assert.equal(executed.length, 0);
});

test('revoked identity (users.is_active = 0) is denied with 401', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: REVOKED_USER });
    assert.equal(response.statusCode, 401);
    assert.equal(response.sendFile.called, false);
    assert.equal(executed.length, 0);
});

test('stale token version is rejected as a revoked session', async () => {
    const { router } = makeHarness();
    // users.token_version is 3 server-side; the token claims tv 0.
    const response = await invokeRoute(router, { ...download('file-a1'), token: STALE_TOKEN_USER });
    assert.equal(response.statusCode, 401);
    assert.equal(response.sendFile.called, false);
});

// ---------------------------------------------------------------------------
// Selected-tenant denial (behavioral)
// ---------------------------------------------------------------------------

test('authenticated principal with no selected tenant is denied 403 before any data access', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: TEACHER_NONE });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { error: 'Tenant membership required' });
    assert.equal(response.sendFile.called, false);
    assert.equal(executed.length, 0, 'the media lookup must not run without a selected tenant');
});

test('forged tenant claim outside the principals memberships derives no tenant (403)', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: TEACHER_MULTI_FORGED });
    assert.equal(response.statusCode, 403);
    assert.equal(response.sendFile.called, false);
    assert.equal(executed.length, 0);
});

test('platform admin carries no tenant scope and is fail-closed on tenant media', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: PLATFORM_ADMIN });
    assert.equal(response.statusCode, 403);
    assert.equal(response.sendFile.called, false);
    assert.equal(executed.length, 0);
});

// ---------------------------------------------------------------------------
// Ownership / cross-user and cross-tenant isolation (behavioral + SQL boundary)
// ---------------------------------------------------------------------------

test('valid own-tenant uploader download serves the canonical file with hardened headers', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
    assert.equal(response.sendFile.filePath, await fs.promises.realpath(ownA));
    assert.equal(response.headers['Content-Type'], 'image/png');
    assert.equal(response.headers['Content-Disposition'], 'inline; filename="own.png"');
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');

    // Decision-boundary evidence: the row is returned only for the exact
    // uploader or a server-written parent-resource participant, and every
    // participant id is bound as a parameter - never read from the client.
    assert.equal(executed.length, 1);
    const statement = executed[0];
    assert.match(statement.sql, /FROM tenant_media_files f/);
    assert.match(statement.sql, /id\s*=\s*\?/);
    assert.match(statement.sql, /tenant_id\s*=\s*\?/);
    assert.match(statement.sql, /uploaded_by\s*=\s*\?/);
    assert.match(statement.sql, /FROM messages m/);
    assert.match(statement.sql, /FROM exam_questions q/);
    assert.match(statement.sql, /exam_attempts a/);
    assert.match(statement.sql, /FROM premium_lecture_payments p/);
    assert.equal(statement.params.length, 8);
    assert.deepEqual(statement.params.slice(0, 3), ['file-a1', 'tenant-a', 'teacher-a']);
    for (const bound of statement.params.slice(2)) {
        assert.equal(bound, 'teacher-a', 'every participant binding must be the server-derived caller id');
    }
});

// ---------------------------------------------------------------------------
// Private-object authority: exact uploader or parent-resource participant
// (behavioral + SQL boundary)
// ---------------------------------------------------------------------------

test('same-tenant unrelated user is rejected 404 for another users file', async () => {
    // The pre-fix model: any authenticated member of the tenant could read
    // every stored attachment by id. Tenant membership is not authority.
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: TEACHER_A_OTHER });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'File not found' });
    assert.equal(response.sendFile.called, false);
    assert.match(executed[0]?.sql, /uploaded_by\s*=\s*\?/);
    assert.deepEqual(executed[0]?.params.slice(0, 3), ['file-a1', 'tenant-a', 'teacher-a-other']);
});

test('same-tenant unrelated student is rejected 404 for a private attachment', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-msg-to-student'), token: STUDENT_C });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('chat attachment receiver is an authorized participant', async () => {
    // student-a did not upload the attachment but is the message receiver:
    // the server-written participants (sender_id/receiver_id) authorize.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-msg-to-student'), token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.filePath, await fs.promises.realpath(ownA));
});

test('chat attachment sender is an authorized participant', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-msg-to-x'), token: STUDENT_X });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
});

test('exam question image is served to the owning instructor who did not upload it', async () => {
    // teacher-uploader stored the question image of exam-a, which belongs to
    // teacher-a's group: authority flows from the exam scope, not the upload.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-exam-other-upload'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
});

test('exam question image is denied to a same-tenant instructor who owns neither upload nor exam', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-exam-other-upload'), token: TEACHER_A_OTHER });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('exam question image is served to a student with an attempt on that exam', async () => {
    // Mirrors the exam review flow, which returns question_image URLs to
    // students who attempted the exam.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-exam-attempt'), token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
});

test('exam question image is denied to a same-tenant student without an attempt', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-exam-attempt'), token: STUDENT_C });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('premium receipt is served to the lecture-owning instructor (reviewer scope)', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-receipt'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
});

test('premium receipt is denied to same-tenant principals with no lecture scope', async () => {
    const { router } = makeHarness();
    for (const token of [TEACHER_A_OTHER, STUDENT_C]) {
        const response = await invokeRoute(router, { ...download('file-a-receipt'), token });
        assert.equal(response.statusCode, 404);
        assert.equal(response.sendFile.called, false);
    }
});

test('unknown relation fails closed: no parent resource and not the uploader is 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-msg-to-x'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('cross-tenant id is 404 and never reaches the filesystem, with tenant-bound lookup', async () => {
    const { router, executed } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-b1'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { error: 'File not found' });
    assert.equal(response.sendFile.called, false);
    // The tenant boundary is applied in SQL before any authority branch, so
    // a foreign row is unreachable even for a participant-looking caller.
    assert.equal(executed[0]?.params.length, 8);
    assert.deepEqual(executed[0]?.params.slice(0, 3), ['file-b1', 'tenant-a', 'teacher-a']);
});

test('cross-user same-tenant id heals nothing: unknown id in own tenant is 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('does-not-exist'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('student of another tenant cannot reach tenant media by id', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: STUDENT_B });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

// ---------------------------------------------------------------------------
// Path traversal / canonicalization (filesystem-evidenced)
// ---------------------------------------------------------------------------

test('relative ../ traversal in storage_path is denied 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-traversal'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('absolute storage path outside the uploads root is denied 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-absolute'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('sibling directory sharing the uploads root prefix is denied 404', async () => {
    // `uploads-evil` starts with the string "uploads" but is not inside it.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-sibling-prefix'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('storage_path resolving to the uploads root itself is denied 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-root-itself'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('empty or whitespace storage_path is denied 404', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-empty-path'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('directory link inside the uploads root cannot escape it (regression: previously served)', {
    skip: linkEscapeAvailable ? false : 'directory link creation is not permitted in this environment',
}, async () => {
    // The row is lexically inside the uploads root; only canonicalization
    // reveals that the link targets workspace/outside/secret.txt.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-link-escape'), token: TEACHER_A });
    assert.equal(response.statusCode, 404);
    assert.equal(response.sendFile.called, false);
});

test('case-variant storage path resolves through the filesystems real entry (Windows)', {
    skip: process.platform === 'win32' ? false : 'case-insensitive filesystem semantics only',
}, async () => {
    // `uploads/QUESTIONS/own.png` refers to the same file as
    // `uploads/questions/own.png` here. The pre-fix case-sensitive prefix
    // compare 404'd it; canonicalization serves the real entry.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-case-variant'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.filePath, await fs.promises.realpath(ownA));
});

// ---------------------------------------------------------------------------
// Read failures (behavioral)
// ---------------------------------------------------------------------------

test('missing target answers 404 through the sendFile ENOENT callback', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(
        router,
        { ...download('file-a2-missing'), token: TEACHER_A },
        { sendFileError: Object.assign(new Error('no such file'), { code: 'ENOENT' }) },
    );
    // The row exists and is in scope, so the handler reaches sendFile with
    // the canonical target; the absent file surfaces as ENOENT -> 404.
    assert.equal(response.sendFile.called, true);
    assert.equal(
        response.sendFile.filePath,
        path.join(await fs.promises.realpath(uploadsRoot()), 'questions', 'absent.png'),
    );
    assert.equal(response.statusCode, 404);
});

test('non-ENOENT stream failure answers 500', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(
        router,
        { ...download('file-a1'), token: TEACHER_A },
        { sendFileError: Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
    );
    assert.equal(response.sendFile.called, true);
    assert.equal(response.statusCode, 500);
});

test('stream failure after headers were sent does not rewrite the response', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(
        router,
        { ...download('file-a1'), token: TEACHER_A },
        {
            sendFileError: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
            headersSentOnStreamError: true,
        },
    );
    // Bytes are already on the wire: the handler must not attempt a second
    // answer, and the delivered status stays the stream's own.
    assert.equal(response.sendFile.called, true);
    assert.equal(response.statusCode, 200);
});

test('database failure surfaces 500 and serves nothing', async () => {
    const fixtures = makeFixtures();
    fixtures.dbFailure = true;
    const { router } = makeHarness(fixtures);
    const response = await invokeRoute(router, { ...download('file-a1'), token: TEACHER_A });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { error: 'File download failed' });
    assert.equal(response.sendFile.called, false);
});

// ---------------------------------------------------------------------------
// Header safety (behavioral)
// ---------------------------------------------------------------------------

test('mime value with header-injection characters falls back to a safe type instead of 500', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-malformed-mime'), token: TEACHER_A });
    // Pre-fix, the raw value made Node's header writer throw -> 500 JSON.
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'application/octet-stream');
    assert.equal(response.sendFile.called, true);
});

test('non-media-type mime value falls back to a safe type', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-nonmime'), token: TEACHER_A });
    assert.equal(response.headers['Content-Type'], 'application/octet-stream');
    assert.equal(response.sendFile.called, true);
});

// ---------------------------------------------------------------------------
// Active document content policy (behavioral): HTML/SVG never renders inline
// ---------------------------------------------------------------------------

test('text/html attachment is answered as safe binary download, never inline', async () => {
    // Pre-fix the stored type was echoed inline: an uploaded HTML attachment
    // executed as markup/script under the authenticated reader's origin.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-html'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
    assert.equal(response.headers['Content-Type'], 'application/octet-stream');
    assert.equal(response.headers['Content-Disposition'], 'attachment; filename="own.png"');
});

test('image/svg+xml attachment is answered as safe binary download, never inline', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-svg'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
    assert.equal(response.headers['Content-Type'], 'application/octet-stream');
    assert.equal(response.headers['Content-Disposition'], 'attachment; filename="own.png"');
});

test('mixed-case active mime is normalized and forced to safe binary', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-html-upper'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
    assert.equal(response.headers['Content-Type'], 'application/octet-stream');
    assert.equal(response.headers['Content-Disposition'], 'attachment; filename="own.png"');
});

test('safe raster mime keeps its validated type and inline disposition', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a1'), token: TEACHER_A });
    assert.equal(response.headers['Content-Type'], 'image/png');
    assert.equal(response.headers['Content-Disposition'], 'inline; filename="own.png"');
});

test('null mime value falls back instead of throwing', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-null-mime'), token: TEACHER_A });
    assert.equal(response.headers['Content-Type'], 'application/octet-stream');
    assert.equal(response.sendFile.called, true);
});

test('original_name with quotes and CRLF cannot break out of Content-Disposition', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-hostile-name'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    const disposition = response.headers['Content-Disposition'];
    assert.equal(disposition, 'inline; filename="ev_il__name.png"');
    assert.equal(/[\r\n]/.test(disposition), false);
});

test('original_name containing path separators is reduced to its basename', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-traversal-name'), token: TEACHER_A });
    assert.equal(response.headers['Content-Disposition'], 'inline; filename="passwd"');
});

test('null original_name degrades to an empty filename instead of throwing', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-null-name'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Disposition'], 'inline; filename=""');
});

test('non-Latin1 original_name downloads instead of a header-writer 500 (regression)', async () => {
    // original_name is the client-supplied upload filename. Pre-fix,
    // safeHeaderFilename kept the CJK code units and res.setHeader threw
    // ERR_INVALID_CHAR, so the handler's catch turned every download of that
    // file into a 500. The filename is now sanitized to header-safe bytes.
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-cjk-name'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
    const disposition = response.headers['Content-Disposition'];
    assert.doesNotThrow(() => validateHeaderValue('Content-Disposition', disposition));
    assert.equal(disposition, 'inline; filename="__.png"');
});

test('emoji original_name cannot make the header writer throw', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-emoji-name'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    assert.equal(response.sendFile.called, true);
    assert.doesNotThrow(() =>
        validateHeaderValue('Content-Disposition', response.headers['Content-Disposition']),
    );
});

test('latin1 original_name is preserved because Node accepts it in a header', async () => {
    const { router } = makeHarness();
    const response = await invokeRoute(router, { ...download('file-a-latin1-name'), token: TEACHER_A });
    assert.equal(response.statusCode, 200);
    const disposition = response.headers['Content-Disposition'];
    assert.doesNotThrow(() => validateHeaderValue('Content-Disposition', disposition));
    assert.equal(disposition, 'inline; filename="café.png"');
});

// ---------------------------------------------------------------------------
// Concurrency (behavioral)
// ---------------------------------------------------------------------------

test('parallel downloads of the same file stay tenant-scoped and independent', async () => {
    const { router, executed } = makeHarness();
    const [first, second] = await Promise.all([
        invokeRoute(router, { ...download('file-a1'), token: TEACHER_A }),
        invokeRoute(router, { ...download('file-a1'), token: TEACHER_A }),
    ]);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.sendFile.filePath, await fs.promises.realpath(ownA));
    assert.equal(second.sendFile.filePath, await fs.promises.realpath(ownA));
    assert.equal(executed.length, 2);
    for (const statement of executed) {
        assert.equal(statement.params.length, 8);
        assert.deepEqual(statement.params.slice(0, 3), ['file-a1', 'tenant-a', 'teacher-a']);
    }
});

test('parallel downloads by different tenants do not cross scopes', async () => {
    const { router } = makeHarness();
    const [fromA, fromB] = await Promise.all([
        invokeRoute(router, { ...download('file-a1'), token: TEACHER_A }),
        invokeRoute(router, { ...download('file-b1'), token: TEACHER_B }),
    ]);
    assert.equal(fromA.sendFile.filePath, await fs.promises.realpath(ownA));
    assert.equal(fromB.sendFile.filePath, await fs.promises.realpath(ownB));
});
