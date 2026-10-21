import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import jwt from 'jsonwebtoken';
import type { NextFunction, RequestHandler, Response } from 'express';
import { AuthRequest, createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import type { PrincipalRepository } from '../src/security/principal-repository';
import {
    createLectureRouter,
    type LectureDataAccess,
    type LectureRouterDeps,
} from '../src/routes/lectures';
import {
    createMaterialsRouter,
    type MaterialsDataAccess,
    type MaterialsRouterDeps,
} from '../src/routes/materials';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';

/**
 * M1 video-link binding suite (behavioral, hermetic).
 *
 * Drives the production lecture and material routers through their injected
 * data seam: the real handlers, the real `video://` binding decision and the
 * real playback authorization policy (createSqlVideoAccessRepository +
 * evaluateVideoAccess) run over fixture rows. No database, network, Docker or
 * service is contacted.
 *
 * Evidence classes:
 *  - behavioral: the handler's own decision (status code, and whether the
 *    INSERT/UPDATE reached the data layer);
 *  - decision-boundary: the exact SQL text/params the handler executed, e.g.
 *    that the video row read is a locking read (`FOR UPDATE`) inside the
 *    write transaction.
 *
 * Concurrency (case 8) is PROVISIONAL by construction: there is no unique
 * constraint on the association (I2), so the only in-code guarantee is
 * check-then-write inside a transaction that locks the `videos` row. The
 * harness below serializes transactions the way InnoDB serializes two
 * `SELECT ... FOR UPDATE` readers of the same row; that proves the handler's
 * ordering logic, NOT that a live database cannot interleave. The SQL
 * assertion on `FOR UPDATE` is the second half of that evidence.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface VideoRow {
    id: string;
    tenant_id: string | null;
    course_id: string | null;
    uploaded_by: string | null;
}

interface LectureRow {
    id: string; course_id: string; grade_id: string | null; group_id: string | null;
    instructor_id: string | null; title: string; video_url: string;
    price: number | null; is_free: number; is_published: number; display_order: number;
    archived_at: string | null;
}

interface MaterialRow {
    id: string; course_id: string; title: string; material_type: string;
    file_url: string | null; is_published: number;
}

interface Fixtures {
    users: Record<string, { is_active: number; token_version: number; suspension_active: number; phone: string }>;
    instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships: Record<string, Array<{ tenant_id: string }>>;
    tenants: Record<string, { id: string; status: string; owner_user_id: string }>;
    courses: Record<string, { id: string; tenant_id: string | null; instructor_id: string | null; is_active: number }>;
    groups: Record<string, { id: string; instructor_id: string; course_id: string }>;
    videos: Record<string, VideoRow>;
    lectures: Record<string, LectureRow>;
    materials: Record<string, MaterialRow>;
    materialGroups: Array<{ material_id: string; group_id: string }>;
}

const makeFixtures = (): Fixtures => ({
    users: {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000011' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000012' },
        'instructor-c': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000013' },
        'platform-operator': { is_active: 1, token_version: 0, suspension_active: 0, phone: '0100000098' },
    },
    instructorAccounts: {
        'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        'instructor-c': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
    },
    memberships: {
        'instructor-a': [{ tenant_id: 'tenant-a' }],
        'instructor-b': [{ tenant_id: 'tenant-b' }],
        // Same tenant as instructor-a, but no grant on instructor-a's video.
        'instructor-c': [{ tenant_id: 'tenant-a' }],
    },
    tenants: {
        'tenant-a': { id: 'tenant-a', status: 'active', owner_user_id: 'instructor-a' },
        'tenant-b': { id: 'tenant-b', status: 'active', owner_user_id: 'instructor-b' },
    },
    courses: {
        'course-a': { id: 'course-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', is_active: 1 },
        'course-b': { id: 'course-b', tenant_id: 'tenant-b', instructor_id: 'instructor-b', is_active: 1 },
        // A course with no provable tenant: a destination whose tenant cannot
        // be proven must be denied, never widened to the actor's tenant.
        'course-legacy': { id: 'course-legacy', tenant_id: null, instructor_id: 'instructor-a', is_active: 1 },
    },
    groups: {
        'group-a': { id: 'group-a', instructor_id: 'instructor-a', course_id: 'course-a' },
        'group-b': { id: 'group-b', instructor_id: 'instructor-b', course_id: 'course-b' },
    },
    videos: {
        // Free to bind: uploaded by the caller inside its own tenant.
        'video-own': { id: 'video-own', tenant_id: 'tenant-a', course_id: 'course-a', uploaded_by: 'instructor-a' },
        'video-own-2': { id: 'video-own-2', tenant_id: 'tenant-a', course_id: 'course-a', uploaded_by: 'instructor-a' },
        // Another workspace's upload.
        'video-foreign': { id: 'video-foreign', tenant_id: 'tenant-b', course_id: 'course-b', uploaded_by: 'instructor-b' },
        // Legacy row with no tenant of its own: the tenant is the course's.
        'video-legacy': { id: 'video-legacy', tenant_id: null, course_id: 'course-a', uploaded_by: 'instructor-a' },
        // Already bound to a lecture.
        'video-bound-lecture': { id: 'video-bound-lecture', tenant_id: 'tenant-a', course_id: 'course-a', uploaded_by: 'instructor-a' },
        // Already bound to a material.
        'video-bound-material': { id: 'video-bound-material', tenant_id: 'tenant-a', course_id: 'course-a', uploaded_by: 'instructor-a' },
        // Tenant-b video a verified platform operator may bind into tenant-b.
        'video-platform': { id: 'video-platform', tenant_id: 'tenant-b', course_id: 'course-b', uploaded_by: 'instructor-b' },
        // Declared authorities disagree: its own tenant is A, its course's is B.
        'video-conflict': { id: 'video-conflict', tenant_id: 'tenant-a', course_id: 'course-b', uploaded_by: 'instructor-a' },
        // No declared authority proves a tenant at all.
        'video-unproven': { id: 'video-unproven', tenant_id: null, course_id: null, uploaded_by: 'instructor-a' },
        // Legacy row embedded by two lessons: an ambiguous parent grants nothing.
        'video-ambiguous': { id: 'video-ambiguous', tenant_id: 'tenant-a', course_id: 'course-a', uploaded_by: 'instructor-a' },
        // Currently bound to the cross-destination lecture below (update source).
        'video-cross-dest': { id: 'video-cross-dest', tenant_id: 'tenant-a', course_id: 'course-a', uploaded_by: 'instructor-a' },
    },
    lectures: {
        'lecture-existing': {
            id: 'lecture-existing', course_id: 'course-a', grade_id: null, group_id: null,
            instructor_id: 'instructor-a', title: 'Existing', video_url: 'video://video-bound-lecture',
            price: 10, is_free: 0, is_published: 1, display_order: 0, archived_at: null,
        },
        'lecture-other': {
            id: 'lecture-other', course_id: 'course-a', grade_id: null, group_id: null,
            instructor_id: 'instructor-a', title: 'Other', video_url: 'video://video-unbound-other',
            price: 10, is_free: 0, is_published: 1, display_order: 1, archived_at: null,
        },
        // Owned by instructor-a but sitting in a tenant-b course: the update
        // path must prove the destination from this row, not from the actor.
        'lecture-cross-dest': {
            id: 'lecture-cross-dest', course_id: 'course-b', grade_id: null, group_id: null,
            instructor_id: 'instructor-a', title: 'Cross destination', video_url: 'video://video-cross-dest',
            price: 10, is_free: 0, is_published: 1, display_order: 2, archived_at: null,
        },
        'lecture-amb-1': {
            id: 'lecture-amb-1', course_id: 'course-a', grade_id: null, group_id: null,
            instructor_id: 'instructor-a', title: 'Ambiguous one', video_url: 'video://video-ambiguous',
            price: 10, is_free: 0, is_published: 1, display_order: 3, archived_at: null,
        },
        'lecture-amb-2': {
            id: 'lecture-amb-2', course_id: 'course-a', grade_id: null, group_id: null,
            instructor_id: 'instructor-a', title: 'Ambiguous two', video_url: 'video://video-ambiguous',
            price: 10, is_free: 0, is_published: 1, display_order: 4, archived_at: null,
        },
    },
    materials: {
        'material-existing': {
            id: 'material-existing', course_id: 'course-a', title: 'Existing material',
            material_type: 'video', file_url: 'video://video-bound-material', is_published: 1,
        },
        'material-plain': {
            id: 'material-plain', course_id: 'course-a', title: 'Plain material',
            material_type: 'pdf', file_url: null, is_published: 1,
        },
    },
    materialGroups: [
        { material_id: 'material-existing', group_id: 'group-a' },
        { material_id: 'material-plain', group_id: 'group-a' },
    ],
});

const makeRepository = (f: Fixtures): PrincipalRepository => ({
    findUsersIdentity: async (id) => {
        const row = f.users[id];
        if (!row) return null;
        return { is_active: row.is_active, token_version: row.token_version, suspension_active: row.suspension_active };
    },
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id) => f.instructorAccounts[id] ?? null,
    findStudentEnrollments: async () => [],
    findActiveTenantMemberships: async (id) => f.memberships[id] ?? [],
});

// ---------------------------------------------------------------------------
// Fixture SQL adapter: answers the exact query shapes the routers issue.
// ---------------------------------------------------------------------------

interface ExecutedStatement { sql: string; params: unknown[] }

const makeDb = (f: Fixtures, executed: ExecutedStatement[], throwOnSql?: (sql: string) => boolean) => {
    const videoById = (id: unknown): VideoRow | undefined =>
        typeof id === 'string' ? f.videos[id] : undefined;

    /** Legacy single-row parent read (the pre-fix SQL) is emulated as MySQL's LIMIT 1. */
    const firstLectureForVideo = (videoId: unknown): LectureRow | undefined =>
        Object.values(f.lectures).find((l) => l.video_url === `video://${String(videoId)}`);

    const lecturesForVideo = (videoId: unknown): LectureRow[] =>
        Object.values(f.lectures).filter((l) => l.video_url === `video://${String(videoId)}`);

    const respond = (sql: string, params: unknown[]): unknown[] => {
        if (throwOnSql?.(sql)) throw new Error('simulated database failure');

        // --- binding validation -------------------------------------------------
        if (sql.includes('FROM videos WHERE id = ? FOR UPDATE')) {
            const video = videoById(params[0]);
            return video ? [{ ...video }] : [];
        }
        if (sql.includes('FROM videos WHERE id = ?')) {
            const video = videoById(params[0]);
            return video ? [{ ...video }] : [];
        }
        if (sql.includes('FROM lectures l')) {
            // Lecture read/preflight scoped by instructor or course tenant.
            const lecture = f.lectures[String(params[0])];
            if (!lecture) return [];
            if (sql.includes('l.instructor_id = ?') && lecture.instructor_id !== params[1]) return [];
            if (sql.includes('c.tenant_id = ?') && f.courses[lecture.course_id]?.tenant_id !== params[1]) return [];
            return [{ ...lecture }];
        }
        if (sql.includes('FROM lectures WHERE video_url = ?')) {
            // Conflict probe: any other parent row for the same URL.
            const url = String(params[0]);
            const exclude = params.length > 1 ? String(params[1]) : null;
            const hit = Object.values(f.lectures)
                .filter((l) => l.video_url === url && l.id !== exclude)
                .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
            return hit ? [{ id: hit.id }] : [];
        }
        if (sql.includes('FROM course_materials WHERE file_url = ?')) {
            const url = String(params[0]);
            const exclude = params.length > 1 ? String(params[1]) : null;
            const hit = Object.values(f.materials)
                .filter((m) => m.file_url === url && m.id !== exclude)
                .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
            return hit ? [{ id: hit.id }] : [];
        }

        // --- playback policy (createSqlVideoAccessRepository) --------------------
        if (sql.includes('FROM users WHERE id = ?')) {
            const row = f.users[String(params[0])];
            return row ? [{ id: params[0], role: 'instructor', phone: row.phone, is_active: row.is_active }] : [];
        }
        if (sql.includes('UNION ALL') && sql.includes('tenant_memberships')) {
            const [tenantId, ownerUserId, memberUserId, memberTenantId] = params as string[];
            const tenant = f.tenants[String(tenantId)];
            if (!tenant || tenant.status !== 'active') return [];
            if (tenant.owner_user_id === ownerUserId) return [{ authority: 'owner' }];
            const membership = (f.memberships[memberUserId] ?? []).find((m) => m.tenant_id === memberTenantId);
            return membership ? [{ authority: 'instructor' }] : [];
        }
        if (sql.includes('candidate_count')) {
            // Ambiguity-aware parent resolution: the count is computed by the
            // SQL itself, so this fixture only mirrors the WHERE semantics.
            const videoId = params[0];
            const rows = lecturesForVideo(videoId);
            if (rows.length === 1) return [{ candidate_count: 1, ...rows[0] }];
            return [{ candidate_count: rows.length, id: null, instructor_id: null, grade_id: null, group_id: null, is_published: 0, archived_at: null }];
        }
        if (sql.includes('video_url = CONCAT')) {
            // Pre-fix single-row parent read.
            const lecture = firstLectureForVideo(params[0]);
            return lecture ? [{ ...lecture }] : [];
        }
        if (sql.includes('FROM instructor_shared_lectures') && sql.includes('sl.instructor_id = ?')) {
            return [];
        }
        if (sql.includes('FROM courses WHERE id = ? AND tenant_id = ?')) {
            const course = f.courses[String(params[0])];
            return course && course.tenant_id === params[1] ? [{ id: course.id }] : [];
        }
        if (sql.includes('SELECT tenant_id FROM courses WHERE id = ?')) {
            const course = f.courses[String(params[0])];
            return course ? [{ tenant_id: course.tenant_id }] : [];
        }
        if (sql.includes('SELECT instructor_id, tenant_id, is_active FROM courses WHERE id = ?')) {
            const course = f.courses[String(params[0])];
            return course ? [{ instructor_id: course.instructor_id, tenant_id: course.tenant_id, is_active: course.is_active }] : [];
        }

        // --- destination tenant proof (read inside the write transaction) ------
        if (sql.includes('SELECT course_id FROM lectures WHERE id = ?')) {
            const lecture = f.lectures[String(params[0])];
            return lecture ? [{ course_id: lecture.course_id }] : [];
        }
        if (sql.includes('SELECT course_id FROM course_materials WHERE id = ?')) {
            const material = f.materials[String(params[0])];
            return material ? [{ course_id: material.course_id }] : [];
        }

        // --- lectures ------------------------------------------------------------
        if (sql.includes('INSERT INTO lectures')) {
            const [id, course_id, grade_id, group_id, instructor_id, title, , video_url, , price, display_order, is_free, is_published] =
                params as [string, string, string | null, string | null, string | null, string, null, string, null, number | null, number, number, number];
            f.lectures[id] = {
                id, course_id, grade_id, group_id, instructor_id, title, video_url,
                price, display_order, is_free, is_published, archived_at: null,
            };
            return [];
        }
        if (sql.includes('SELECT * FROM lectures WHERE id = ?')) {
            const lecture = f.lectures[String(params[0])];
            return lecture ? [{ ...lecture }] : [];
        }
        if (sql.includes('UPDATE lectures') && sql.includes('COALESCE(?, title)')) {
            const lecture = f.lectures[String(params[8])];
            if (lecture) {
                const values = params.slice(0, 8);
                const columns = ['title', 'description', 'video_url', 'duration_minutes', 'price', 'display_order', 'is_free', 'is_published'];
                columns.forEach((column, index) => {
                    if (values[index] != null) {
                        (lecture as unknown as Record<string, unknown>)[column] = values[index];
                    }
                });
            }
            return [];
        }
        if (sql.includes('FROM instructor_shared_lectures WHERE lecture_id=?')) {
            return [];
        }

        // --- materials -----------------------------------------------------------
        if (sql.includes('SELECT id, branch_id, branch_scope FROM `groups`')) {
            return (params as string[])
                .filter((id) => Boolean(f.groups[id]))
                .map((id) => ({ id, branch_id: null, branch_scope: 'tenant' }));
        }
        if (sql.includes('COUNT(*) AS cnt')) {
            const [scopeId, tenantId, ...groupIds] = params as [string, string, ...string[]];
            const cnt = groupIds.filter((id) =>
                f.groups[id]?.instructor_id === scopeId
                && f.courses[f.groups[id]?.course_id ?? '']?.tenant_id === tenantId).length;
            return [{ cnt }];
        }
        if (sql.includes('SELECT c.tenant_id')) {
            const material = f.materials[String(params[0])];
            if (!material) return [];
            return [{ tenant_id: f.courses[material.course_id]?.tenant_id ?? null }];
        }
        if (sql.includes('SELECT mg.material_id')) {
            const [materialId, scopeId, tenantId] = params as [string, string, string];
            const linked = f.materialGroups.some((mg) =>
                mg.material_id === materialId
                && f.groups[mg.group_id]?.instructor_id === scopeId
                && f.courses[f.groups[mg.group_id]?.course_id ?? '']?.tenant_id === tenantId);
            return linked ? [{ material_id: materialId }] : [];
        }
        if (sql.includes('SELECT material_type,file_url FROM course_materials WHERE id=?')) {
            const material = f.materials[String(params[0])];
            return material ? [{ material_type: material.material_type, file_url: material.file_url }] : [];
        }
        if (sql.includes('INSERT INTO course_materials')) {
            const [id, course_id, title, , material_type, file_url] =
                params as [string, string, string, string | null, string, string | null];
            f.materials[id] = {
                id, course_id, title, material_type, file_url: file_url ?? null, is_published: 1,
            };
            return [];
        }
        if (sql.includes('UPDATE course_materials') && sql.includes('COALESCE(?, title)')) {
            const material = f.materials[String(params[9])];
            if (material) {
                const values = params.slice(0, 9);
                const columns = ['title', 'description', 'material_type', 'file_url', 'file_size', 'duration_minutes', 'display_order', 'is_free', 'is_published'];
                columns.forEach((column, index) => {
                    if (values[index] != null) {
                        (material as unknown as Record<string, unknown>)[column] = values[index];
                    }
                });
            }
            return [];
        }
        if (sql.includes('SELECT * FROM course_materials WHERE id = ?')) {
            const material = f.materials[String(params[0])];
            return material ? [{ ...material }] : [];
        }
        if (sql.includes('SELECT id FROM `groups` WHERE id = ? AND is_active = TRUE')) {
            return f.groups[String(params[0])] ? [{ id: params[0] }] : [];
        }
        return [];
    };

    const query: LectureDataAccess['query'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        return respond(sql, params) as T[];
    };
    const queryOne: LectureDataAccess['queryOne'] = async <T>(sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        const rows = respond(sql, params);
        return (rows.length > 0 ? rows[0] : null) as T | null;
    };
    const execute: LectureDataAccess['execute'] = async (sql: string, params: unknown[] = []) => {
        executed.push({ sql, params });
        respond(sql, params);
        return { affectedRows: 1, insertId: 0 };
    };
    return { query, queryOne, execute };
};

/**
 * Stand-in for requireTeachingWrite(...): replicates only its authentication
 * precondition. Entitlement checks live in middleware/teaching-access.ts
 * (outside this task's allowedPaths) and are not exercised here.
 */
const teachingWriteStandIn: RequestHandler = (req, res, next) => {
    if (!(req as AuthRequest).user) {
        (res as Response).status(401).json({ error: 'Authentication required' });
        return;
    }
    next();
};

/**
 * Serialize transaction bodies the way InnoDB serializes two locking readers of
 * the same `videos` row. This is a harness model of the lock, not proof of it.
 */
const serializedTransactions = () => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => undefined);
        return run;
    };
};

const makeHarness = (options: {
    fixtures?: Fixtures;
    throwOnSql?: (sql: string) => boolean;
    /** Verified platform capability, as production resolves it from server rows. */
    platformCapable?: (userId: string) => boolean;
} = {}) => {
    const fixtures = options.fixtures ?? makeFixtures();
    const executed: ExecutedStatement[] = [];
    const db = makeDb(fixtures, executed, options.throwOnSql);
    const repository = makeRepository(fixtures);
    const serialize = serializedTransactions();

    const lectureDeps: LectureRouterDeps = {
        db,
        optionalAuthenticate: createOptionalAuth(repository) as RequestHandler,
        authenticate: createAuthenticateToken(repository) as RequestHandler,
        requireTeachingWriteAccess: teachingWriteStandIn,
        transaction: <T>(fn: (tx: LectureDataAccess) => Promise<T>) => serialize(() => fn(db)),
        branchAccess: tenantScopeBranchDeps((type, id) => {
            if (type !== 'lecture') return null;
            const lecture = fixtures.lectures[id];
            return lecture ? fixtures.courses[lecture.course_id]?.tenant_id ?? null : null;
        }),
        hasVerifiedPlatformCapability: async (userId) => options.platformCapable?.(userId) ?? false,
    };

    const materialDeps: MaterialsRouterDeps = {
        db,
        authenticate: createAuthenticateToken(repository) as RequestHandler,
        optionalAuthenticate: createOptionalAuth(repository) as RequestHandler,
        requireTeachingWriteAccess: teachingWriteStandIn,
        hasVerifiedPlatformCapability: async (userId) => options.platformCapable?.(userId) ?? false,
        transaction: <T>(fn: (tx: MaterialsDataAccess) => Promise<T>) => serialize(() => fn(db)),
        branchAccess: tenantScopeBranchDeps((type, id) => {
            if (type !== 'material') return null;
            const material = fixtures.materials[id];
            return material ? fixtures.courses[material.course_id]?.tenant_id ?? null : null;
        }),
    };

    return {
        lectures: createLectureRouter(lectureDeps),
        materials: createMaterialsRouter(materialDeps),
        executed,
        fixtures,
    };
};

// ---------------------------------------------------------------------------
// Route invocation
// ---------------------------------------------------------------------------

interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
}

interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
}

const invokeRoute = async (router: unknown, request: RouteRequest): Promise<CapturedResponse> => {
    const response: CapturedResponse = {
        status(code: number) { response.statusCode = code; return response; },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
    };
    const req = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);
const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0 });
const INSTRUCTOR_B = tokenFor({ id: 'instructor-b', role: 'instructor', tv: 0 });
const INSTRUCTOR_C = tokenFor({ id: 'instructor-c', role: 'instructor', tv: 0 });

const errorCodeOf = (response: CapturedResponse): unknown =>
    (response.body as { code?: unknown } | undefined)?.code;

const writeStatements = (executed: ExecutedStatement[]): ExecutedStatement[] =>
    executed.filter((statement) => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement.sql));

const lectureCreateBody = (videoUrl: string) => ({
    course_id: 'course-a',
    title: 'New lecture',
    video_url: videoUrl,
    price: 10,
});

const materialCreateBody = (fileUrl: string) => ({
    course_id: 'course-a',
    title: 'New video material',
    material_type: 'video',
    file_url: fileUrl,
    group_ids: ['group-a'],
});

// ---------------------------------------------------------------------------
// 1 — allow: an existing video of the caller's own tenant
// ---------------------------------------------------------------------------

test('allow: a lecture may link an existing video of the caller tenant (201)', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-own'),
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO lectures'));
    assert.ok(insert, 'lecture INSERT executed');
    assert.equal(insert!.params[7], 'video://video-own');
    // Decision boundary: existence/tenant is read with a locking read inside
    // the write transaction, so a concurrent binding of the same video waits.
    const lockRead = executed.find((e) => e.sql.includes('FROM videos WHERE id = ? FOR UPDATE'));
    assert.ok(lockRead, 'video row is read FOR UPDATE');
    assert.deepEqual(lockRead!.params, ['video-own']);
});

test('allow: the tenant of a legacy video row falls back to its course tenant', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-legacy'),
    });
    assert.equal(response.statusCode, 201);
    assert.ok(executed.some((e) => e.sql.includes('SELECT tenant_id FROM courses WHERE id = ?')));
});

// ---------------------------------------------------------------------------
// 2/3 — existence and tenant boundary
// ---------------------------------------------------------------------------

test('deny: an unknown video id is 404 and nothing is written', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-missing'),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(errorCodeOf(response), 'VIDEO_NOT_FOUND');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: a video of another tenant is 403 and nothing is written', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-foreign'),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_FOREIGN_TENANT');
    assert.equal(writeStatements(executed).length, 0);
});

// ---------------------------------------------------------------------------
// 4/5 — conflicting binding
// ---------------------------------------------------------------------------

test('deny: a video already linked to another lecture is 409 (no silent rebind)', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-bound-lecture'),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCodeOf(response), 'VIDEO_ALREADY_BOUND');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: a video already linked to a material is 409', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-bound-material'),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCodeOf(response), 'VIDEO_ALREADY_BOUND');
    assert.equal(writeStatements(executed).length, 0);
});

// ---------------------------------------------------------------------------
// 6 — fail closed on an unverifiable read
// ---------------------------------------------------------------------------

test('failure: a read error during validation rejects the write (503, fail closed)', async () => {
    const { lectures, executed } = makeHarness({
        throwOnSql: (sql) => sql.includes('FROM videos WHERE id = ? FOR UPDATE'),
    });
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-own'),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(errorCodeOf(response), 'VIDEO_BINDING_UNVERIFIABLE');
    assert.equal(writeStatements(executed).length, 0);
});

// ---------------------------------------------------------------------------
// 7 — the pre-existing external-link contract
// ---------------------------------------------------------------------------

test('deny: an https:// link keeps the pre-existing 400 and never reaches the video read', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('https://cdn.example.com/x.mp4'),
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.body as { error?: string }).error,
        'External video links are not allowed. Upload the video to the platform.');
    assert.equal(executed.filter((e) => e.sql.includes('FROM videos WHERE id =')).length, 0);
    assert.equal(writeStatements(executed).length, 0);
});

// ---------------------------------------------------------------------------
// 8 — concurrency (provisional: harness-serialized, see header)
// ---------------------------------------------------------------------------

test('concurrency: two simultaneous binds of the same video yield one 201 and one 409', async () => {
    const { lectures, executed } = makeHarness();
    const body = lectureCreateBody('video://video-own-2');
    const [first, second] = await Promise.all([
        invokeRoute(lectures, { method: 'POST', url: '/', token: INSTRUCTOR_A, body }),
        invokeRoute(lectures, { method: 'POST', url: '/', token: INSTRUCTOR_A, body }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort((a, b) => Number(a) - Number(b));
    assert.deepEqual(statuses, [201, 409]);
    const inserts = executed.filter((e) => e.sql.includes('INSERT INTO lectures'));
    assert.equal(inserts.length, 1, 'exactly one binding write reaches the data layer');
});

// ---------------------------------------------------------------------------
// Material side: same decision, same codes
// ---------------------------------------------------------------------------

test('allow: a video material may link an existing video of the caller tenant (201)', async () => {
    const { materials, executed } = makeHarness();
    const response = await invokeRoute(materials, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: materialCreateBody('video://video-own'),
    });
    assert.equal(response.statusCode, 201);
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO course_materials')));
});

test('deny: a material cannot link a video of another tenant (403)', async () => {
    const { materials, executed } = makeHarness();
    const response = await invokeRoute(materials, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: materialCreateBody('video://video-foreign'),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_FOREIGN_TENANT');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: a material cannot link a video already bound to a lecture (409)', async () => {
    const { materials, executed } = makeHarness();
    const response = await invokeRoute(materials, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: materialCreateBody('video://video-bound-lecture'),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCodeOf(response), 'VIDEO_ALREADY_BOUND');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: an unknown video id on the material path is 404', async () => {
    const { materials } = makeHarness();
    const response = await invokeRoute(materials, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: materialCreateBody('video://video-missing'),
    });
    assert.equal(response.statusCode, 404);
    assert.equal(errorCodeOf(response), 'VIDEO_NOT_FOUND');
});

test('allow: updating a material to a free video rebinds after validation (200)', async () => {
    const { materials, executed } = makeHarness();
    const response = await invokeRoute(materials, {
        method: 'PUT', url: '/material-existing', token: INSTRUCTOR_A, body: { file_url: 'video://video-own' },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(executed.some((e) => e.sql.includes('UPDATE course_materials')));
});

test('deny: updating a material to a video bound elsewhere is 409', async () => {
    const { materials, executed } = makeHarness();
    const response = await invokeRoute(materials, {
        method: 'PUT', url: '/material-plain', token: INSTRUCTOR_A,
        body: { material_type: 'video', file_url: 'video://video-bound-lecture' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCodeOf(response), 'VIDEO_ALREADY_BOUND');
    assert.equal(writeStatements(executed).length, 0);
});

// ---------------------------------------------------------------------------
// Lecture update path
// ---------------------------------------------------------------------------

test('allow: an update may move a lecture onto a free video of its tenant (200)', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'PUT', url: '/lecture-other', token: INSTRUCTOR_A, body: { video_url: 'video://video-own' },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(executed.some((e) => e.sql.includes('UPDATE lectures')));
});

test('deny: an update onto a video bound to another lecture is 409', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'PUT', url: '/lecture-other', token: INSTRUCTOR_A, body: { video_url: 'video://video-bound-lecture' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCodeOf(response), 'VIDEO_ALREADY_BOUND');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: an update onto a video of another tenant is 403', async () => {
    const { lectures } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'PUT', url: '/lecture-other', token: INSTRUCTOR_A, body: { video_url: 'video://video-foreign' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_FOREIGN_TENANT');
});

test('an update that leaves the existing binding untouched does not re-validate it', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'PUT', url: '/lecture-existing', token: INSTRUCTOR_A, body: { title: 'Renamed' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(executed.filter((e) => e.sql.includes('FROM videos WHERE id =')).length, 0,
        'an unchanged video_url is not a new association');
});

test('deny: a same-tenant actor without a grant on the video is 403 VIDEO_UNAUTHORIZED', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_C, body: lectureCreateBody('video://video-own'),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_UNAUTHORIZED');
    assert.equal(writeStatements(executed).length, 0);
});

test('a foreign-tenant instructor cannot bind a video through the lecture route (403)', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_B, body: lectureCreateBody('video://video-own'),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(writeStatements(executed).length, 0);
});

// ---------------------------------------------------------------------------
// 9 — target-resource tenant equality (capability never relaxes it)
//
// The destination tenant is proven from the destination resource's own course
// row inside the write transaction; the video tenant from the video's declared
// authorities. `destinationTenant === videoTenant` is required exactly, for
// every actor.
// ---------------------------------------------------------------------------

const PLATFORM_OPERATOR = tokenFor({ id: 'platform-operator', role: 'admin', tv: 0 });
const platformOperatorCapability = {
    platformCapable: (userId: string) => userId === 'platform-operator',
};

test('allow: a verified platform operator may bind a video within the same resource tenant (201)', async () => {
    const { lectures, executed } = makeHarness(platformOperatorCapability);
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: PLATFORM_OPERATOR,
        body: { course_id: 'course-b', title: 'Platform lecture', video_url: 'video://video-platform', price: 10 },
    });
    assert.equal(response.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO lectures'));
    assert.ok(insert, 'lecture INSERT executed');
    assert.equal(insert!.params[1], 'course-b');
    assert.equal(insert!.params[7], 'video://video-platform');
});

test('deny: a verified platform operator cannot bind a video across resource tenants (403, no write)', async () => {
    const { lectures, executed } = makeHarness(platformOperatorCapability);
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: PLATFORM_OPERATOR,
        body: { course_id: 'course-b', title: 'Cross tenant', video_url: 'video://video-own', price: 10 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_TARGET_TENANT_MISMATCH');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: an update re-proves the destination tenant from the lecture row (403, no UPDATE)', async () => {
    // The lecture is owned by the actor but sits in a tenant-b course, so the
    // destination tenant is read from the row — never from the actor or body.
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'PUT', url: '/lecture-cross-dest', token: INSTRUCTOR_A,
        body: { video_url: 'video://video-own' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_TARGET_TENANT_MISMATCH');
    assert.equal(writeStatements(executed).length, 0);
    assert.ok(executed.some((e) => e.sql.includes('SELECT course_id FROM lectures WHERE id = ?')),
        'the destination course is read from the lecture row inside the transaction');
});

test('deny: a video whose own tenant and course tenant disagree is 409 VIDEO_TENANT_CONFLICT', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-conflict'),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(errorCodeOf(response), 'VIDEO_TENANT_CONFLICT');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: a video with no provable tenant is 403 VIDEO_TENANT_UNPROVEN', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-unproven'),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_TENANT_UNPROVEN');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: a destination course with no provable tenant is 403 VIDEO_TENANT_UNPROVEN', async () => {
    // Only the platform path can reach this: the tenant-scoped course pre-check
    // already refuses a tenant-less course for an ordinary actor.
    const { lectures, executed } = makeHarness(platformOperatorCapability);
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: PLATFORM_OPERATOR,
        body: { course_id: 'course-legacy', title: 'Tenant-less destination', video_url: 'video://video-own', price: 10 },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_TENANT_UNPROVEN');
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: a legacy video embedded by two lessons is refused (403, no write)', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-ambiguous'),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response), 'VIDEO_UNAUTHORIZED');
    assert.equal(writeStatements(executed).length, 0);
});

// ---------------------------------------------------------------------------
// 10 — canonical `video://` reference (one rule, 400 before any mutation)
// ---------------------------------------------------------------------------

const NON_CANONICAL_REFERENCES: Array<[string, string]> = [
    ['leading whitespace', 'video:// video-own'],
    ['trailing whitespace', 'video://video-own '],
    ['surrounding whitespace', 'video:// video-own '],
    ['whitespace-only id', 'video://   '],
    ['internal whitespace', 'video://video own'],
];

for (const [label, reference] of NON_CANONICAL_REFERENCES) {
    test(`deny: a lecture create with ${label} is 400 with no write statement`, async () => {
        const { lectures, executed } = makeHarness();
        const response = await invokeRoute(lectures, {
            method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody(reference),
        });
        assert.equal(response.statusCode, 400);
        assert.equal(writeStatements(executed).length, 0, `${label}: no write statement`);
    });
}

test('deny: a material create rejects every non-canonical reference with 400 and no write', async () => {
    for (const [label, reference] of NON_CANONICAL_REFERENCES) {
        const { materials, executed } = makeHarness();
        const response = await invokeRoute(materials, {
            method: 'POST', url: '/', token: INSTRUCTOR_A, body: materialCreateBody(reference),
        });
        assert.equal(response.statusCode, 400, `${label}: 400`);
        assert.equal(writeStatements(executed).length, 0, `${label}: no write statement`);
    }
});

test('deny: a lecture update to a non-canonical reference is 400 with no UPDATE', async () => {
    const { lectures, executed } = makeHarness();
    const response = await invokeRoute(lectures, {
        method: 'PUT', url: '/lecture-other', token: INSTRUCTOR_A, body: { video_url: 'video:// video-own' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(writeStatements(executed).length, 0);
});

test('deny: a material update to a non-canonical reference is 400 with no UPDATE', async () => {
    const { materials, executed } = makeHarness();
    const response = await invokeRoute(materials, {
        method: 'PUT', url: '/material-existing', token: INSTRUCTOR_A, body: { file_url: 'video://video-own ' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(writeStatements(executed).length, 0);
});

test('canonical: the exact canonical reference is persisted and found by the conflict probe', async () => {
    const { lectures, executed } = makeHarness();
    const first = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-own'),
    });
    assert.equal(first.statusCode, 201);
    const insert = executed.find((e) => e.sql.includes('INSERT INTO lectures'));
    assert.equal(insert!.params[7], 'video://video-own', 'the canonical string is what gets stored');
    const probe = executed.find((e) => e.sql.includes('FROM lectures WHERE video_url = ?'));
    assert.ok(probe, 'the conflict probe ran');
    assert.equal(probe!.params[0], 'video://video-own', 'the probe compares the canonical string');

    const second = await invokeRoute(lectures, {
        method: 'POST', url: '/', token: INSTRUCTOR_A, body: lectureCreateBody('video://video-own'),
    });
    assert.equal(second.statusCode, 409);
    assert.equal(errorCodeOf(second), 'VIDEO_ALREADY_BOUND');
});
