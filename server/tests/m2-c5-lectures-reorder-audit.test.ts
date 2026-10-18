import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import { Router } from 'express';
import { AuthRequest, createAuthenticateToken, createOptionalAuth } from '../src/middleware/auth';
import {
    createLectureRouter,
    planLectureReorder,
} from '../src/routes/lectures';
import {
    createCoursesRouter,
} from '../src/routes/courses';
import {
    createMaterialsRouter,
} from '../src/routes/materials';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';
import {
    ExecutedStatement,
    TEST_SECRET,
    makeFakeDataAccess,
    makeRepository,
    tokenFor,
    teachingWriteStandIn,
    invokeRoute,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

// ---------------------------------------------------------------------------
// Pure unit: planLectureReorder (no I/O)
// ---------------------------------------------------------------------------

test('planLectureReorder rejects empty / non-array input', () => {
    assert.equal(planLectureReorder([{ id: 'a' }], null).ok, false);
    assert.equal(planLectureReorder([{ id: 'a' }], []).ok, false);
    assert.equal(planLectureReorder([{ id: 'a' }], 'nope' as unknown).ok, false);
});

test('planLectureReorder rejects non-string / duplicate ids', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    assert.equal(planLectureReorder(existing, [1, 'a']).ok, false);
    assert.equal(planLectureReorder(existing, ['a', 'a']).status, 409);
});

test('planLectureReorder rejects ids not part of the course (forged/conflicting)', () => {
    const r = planLectureReorder([{ id: 'a' }, { id: 'b' }], ['a', 'x']);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
});

test('planLectureReorder rejects partial lists (stale)', () => {
    const r = planLectureReorder([{ id: 'a' }, { id: 'b' }], ['a']);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
});

test('planLectureReorder returns 1-based display_order for a complete, ordered set', () => {
    const r = planLectureReorder([{ id: 'a' }, { id: 'b' }], ['b', 'a']);
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.deepEqual(r.assignments, [
            { id: 'b', display_order: 1 },
            { id: 'a', display_order: 2 },
        ]);
    }
});

// ---------------------------------------------------------------------------
// Lecture reorder route (C5 catalog ordering, atomic via injected transaction)
// ---------------------------------------------------------------------------

const INSTRUCTOR_A = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });

const lectureReorderFixture = () => {
    const users = {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        'instructor-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: {
            'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
        },
        memberships: {
            'instructor-a': [{ tenant_id: 'tenant-a' }],
            'instructor-b': [{ tenant_id: 'tenant-b' }],
        },
    });
    return repository;
};

const buildLectureRouter = (
    responder: (sql: string, params: unknown[]) => unknown[] | null,
    branchAccess = tenantScopeBranchDeps((_type, _id) => 'tenant-a'),
) => {
    const db = makeFakeDataAccess((sql, params) => {
        const rows = responder(sql, params);
        if (process.env.M2_DEBUG) console.error('[reorder-sql]', sql.replace(/\s+/g, ' ').trim(), JSON.stringify(params));
        return rows;
    });
    const repository = lectureReorderFixture();
    const deps = {
        db,
        optionalAuthenticate: createOptionalAuth(repository) as Parameters<typeof createLectureRouter>[0]['optionalAuthenticate'],
        authenticate: createAuthenticateToken(repository) as Parameters<typeof createLectureRouter>[0]['authenticate'],
        requireTeachingWriteAccess: teachingWriteStandIn,
        branchAccess,
        transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db),
    };
    return { router: createLectureRouter(deps), executed: db.executed };
};

const isCourseOwnedQuery = (sql: string) => sql.includes('SELECT id FROM courses WHERE id=? AND instructor_id=?');
const isExistingLecturesQuery = (sql: string) => sql.includes('SELECT id FROM lectures WHERE course_id=? AND instructor_id=?');
const isReorderUpdate = (sql: string) => sql.includes('UPDATE lectures SET display_order=? WHERE id=? AND course_id=?');

test('reorder: instructor reorders own course and the sequence is persisted + audited', async () => {
    const { router, executed } = buildLectureRouter((sql) => {
        if (isCourseOwnedQuery(sql)) return [{ id: 'course-a' }];
        if (isExistingLecturesQuery(sql)) return [{ id: 'lecture-a-pub' }, { id: 'lecture-a-draft' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/reorder', token: INSTRUCTOR_A,
        body: { course_id: 'course-a', ordered_ids: ['lecture-a-draft', 'lecture-a-pub'] },
    });
    assert.equal(response.statusCode, 200);
    const updates = executed.filter((e) => isReorderUpdate(e.sql));
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0].params, [1, 'lecture-a-draft', 'course-a']);
    assert.deepEqual(updates[1].params, [2, 'lecture-a-pub', 'course-a']);
    const audit = executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === 'lecture.reorder');
    assert.ok(audit, 'lecture.reorder audit recorded');
});

test('reorder: partial list is rejected with 409 and no write occurs', async () => {
    const { router, executed } = buildLectureRouter((sql) => {
        if (isCourseOwnedQuery(sql)) return [{ id: 'course-a' }];
        if (isExistingLecturesQuery(sql)) return [{ id: 'lecture-a-pub' }, { id: 'lecture-a-draft' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/reorder', token: INSTRUCTOR_A,
        body: { course_id: 'course-a', ordered_ids: ['lecture-a-pub'] },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(executed.some((e) => isReorderUpdate(e.sql)), false);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO audit_events')), false);
});

test('reorder: duplicate id in list is rejected with 409', async () => {
    const { router } = buildLectureRouter((sql) => {
        if (isCourseOwnedQuery(sql)) return [{ id: 'course-a' }];
        if (isExistingLecturesQuery(sql)) return [{ id: 'lecture-a-pub' }, { id: 'lecture-a-draft' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/reorder', token: INSTRUCTOR_A,
        body: { course_id: 'course-a', ordered_ids: ['lecture-a-pub', 'lecture-a-pub'] },
    });
    assert.equal(response.statusCode, 409);
});

test('reorder: an id not part of the course is rejected with 409 (no foreign/forged id)', async () => {
    const { router } = buildLectureRouter((sql) => {
        if (isCourseOwnedQuery(sql)) return [{ id: 'course-a' }];
        if (isExistingLecturesQuery(sql)) return [{ id: 'lecture-a-pub' }, { id: 'lecture-a-draft' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/reorder', token: INSTRUCTOR_A,
        body: { course_id: 'course-a', ordered_ids: ['lecture-a-pub', 'lecture-b-pub'] },
    });
    assert.equal(response.statusCode, 409);
});

test('reorder: course in another tenant is 404 with no write (workspace boundary)', async () => {
    const { router, executed } = buildLectureRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/reorder', token: INSTRUCTOR_A,
        body: { course_id: 'course-b', ordered_ids: ['lecture-a-pub', 'lecture-a-draft'] },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(executed.some((e) => isReorderUpdate(e.sql)), false);
});

test('reorder: anonymous is denied 401 before any data access', async () => {
    const { router, executed } = buildLectureRouter(() => []);
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/reorder', body: { course_id: 'course-a', ordered_ids: ['x'] },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('reorder: every lecture is branch-authorized before any order write', async () => {
    const branchAccess = {
        loadResourceScope: async (_type: 'lecture', id: string) => ({
            resourceType: 'lecture' as const, resourceId: id, tenantId: 'tenant-a',
            scope: 'branch' as const, branchId: 'branch-b',
        }),
        findBranch: async () => ({ id: 'branch-b', tenant_id: 'tenant-a', status: 'active', version: 1 }),
        findMembership: async () => null,
        isTenantOwner: async () => false,
        hasPlatformCapability: async () => false,
    };
    const { router, executed } = buildLectureRouter((sql) => {
        if (isCourseOwnedQuery(sql)) return [{ id: 'course-a' }];
        if (isExistingLecturesQuery(sql)) return [{ id: 'lecture-a-pub' }, { id: 'lecture-a-draft' }];
        return [];
    }, branchAccess);
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/reorder', token: INSTRUCTOR_A,
        body: { course_id: 'course-a', ordered_ids: ['lecture-a-draft', 'lecture-a-pub'] },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(executed.some((e) => isReorderUpdate(e.sql)), false);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO audit_events')), false);
});

test('archived lecture cannot be republished or changed through PUT /:id', async () => {
    const { router, executed } = buildLectureRouter((sql) => {
        if (sql.includes('SELECT l.id, l.instructor_id, l.video_url, l.archived_at')) {
            return [{ id: 'lecture-archived', instructor_id: 'instructor-a', video_url: 'video://old', archived_at: '2026-10-01 00:00:00' }];
        }
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/lecture-archived', token: INSTRUCTOR_A,
        body: { is_published: true, title: 'Republished' },
    });
    assert.equal(response.statusCode, 410);
    assert.equal(executed.some((e) => e.kind === 'execute' && e.sql.includes('UPDATE lectures')), false);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO audit_events')), false);
});

test('lecture archive and its audit are issued through the same transaction data seam', async () => {
    const { router, executed } = buildLectureRouter((sql) => {
        if (sql.includes('SELECT l.id, l.archived_at')) return [{ id: 'lecture-live', archived_at: null }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'DELETE', url: '/lecture-live', token: INSTRUCTOR_A,
    });
    assert.equal(response.statusCode, 200);
    const archiveIndex = executed.findIndex((e) => e.kind === 'execute' && e.sql.includes('archived_at = CURRENT_TIMESTAMP'));
    const auditIndex = executed.findIndex((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === 'lecture.archive');
    assert.ok(archiveIndex >= 0);
    assert.ok(auditIndex > archiveIndex, 'archive audit follows the state change in the shared transaction seam');
});

test('lecture update and its audit are issued through the same transaction data seam', async () => {
    const { router, executed } = buildLectureRouter((sql) => {
        if (sql.includes('SELECT l.id, l.instructor_id, l.video_url, l.archived_at')) {
            return [{ id: 'lecture-live', instructor_id: 'instructor-a', video_url: 'video://old', archived_at: null }];
        }
        if (sql.includes('SELECT l.*')) return [{ id: 'lecture-live', title: 'Updated' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/lecture-live', token: INSTRUCTOR_A,
        body: { title: 'Updated' },
    });
    assert.equal(response.statusCode, 200);
    const updateIndex = executed.findIndex((e) => e.kind === 'execute' && e.sql.includes('UPDATE lectures'));
    const auditIndex = executed.findIndex((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === 'lecture.update');
    assert.ok(updateIndex >= 0);
    assert.ok(auditIndex > updateIndex, 'update audit follows the state change in the shared transaction seam');
});

test('lecture create and its audit are issued through the same transaction data seam', async () => {
    const { router, executed } = buildLectureRouter((sql) => {
        if (sql.includes('SELECT id FROM courses WHERE id = ? AND tenant_id = ?')) return [{ id: 'course-a' }];
        if (sql.includes('SELECT * FROM lectures WHERE id = ?')) return [{ id: 'lecture-new' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: INSTRUCTOR_A,
        body: { course_id: 'course-a', title: 'Lesson', video_url: 'video://lesson', price: 5 },
    });
    assert.equal(response.statusCode, 201);
    const insertIndex = executed.findIndex((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO lectures'));
    const auditIndex = executed.findIndex((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === 'lecture.create');
    assert.ok(insertIndex >= 0);
    assert.ok(auditIndex > insertIndex, 'create audit follows insertion in the shared transaction seam');
});

// ---------------------------------------------------------------------------
// GET /student/:userId hardening (C10: revoked / expired enrollment denied)
// ---------------------------------------------------------------------------

const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enrollment-a' });
const STUDENT_B = tokenFor({ id: 'student-b', role: 'student', tv: 0, student_enrollment_id: 'enrollment-b' });

const buildStudentListRouter = (studentsResponder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const db = makeFakeDataAccess(studentsResponder);
    const users = {
        'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
        'student-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
    };
    const repository = makeRepository(users, {
        enrollments: {
            'student-a': [{ id: 'enrollment-a', tenant_id: 'tenant-a', instructor_id: 'instructor-a', group_id: 'group-a', grade_id: 'grade-a' }],
            'student-b': [{ id: 'enrollment-b', tenant_id: 'tenant-b', instructor_id: 'instructor-b', group_id: 'group-b', grade_id: 'grade-b' }],
        },
    });
    const deps = {
        db,
        optionalAuthenticate: createOptionalAuth(repository) as Parameters<typeof createLectureRouter>[0]['optionalAuthenticate'],
        authenticate: createAuthenticateToken(repository) as Parameters<typeof createLectureRouter>[0]['authenticate'],
        requireTeachingWriteAccess: teachingWriteStandIn,
        branchAccess: tenantScopeBranchDeps((_type, _id) => 'tenant-a'),
    };
    return { router: createLectureRouter(deps), executed: db.executed };
};

const isStudentLookup = (sql: string) => sql.includes('FROM students WHERE phone = ?');

test('student list: anonymous is 401 with no data access', async () => {
    const { router, executed } = buildStudentListRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('student list: a student cannot read another student workspace (forged id) -> 403', async () => {
    const { router, executed } = buildStudentListRouter(() => []);
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-b', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.length, 0);
});

test('student list: the entitlement query enforces approved + active + non-expired at the data layer', async () => {
    const { router, executed } = buildStudentListRouter((sql) => {
        if (sql.includes('SELECT id, phone, role FROM users WHERE id = ?')) return [{ id: 'student-a', phone: '0100000001', role: 'student' }];
        if (isStudentLookup(sql)) {
            assert.ok(sql.includes("approval_status = 'approved'"), 'approved filter present');
            assert.ok(sql.includes("enrollment_status IS NULL OR enrollment_status = 'active'"), 'active status filter present');
            assert.ok(sql.includes('enrollment_end_date > UTC_TIMESTAMP()'), 'expiry filter present');
            return [{ id: 'enrollment-a', name: 'Student A', phone: '0100000001', group_id: 'group-a', grade_id: 'grade-a', instructor_id: 'instructor-a' }];
        }
        if (sql.includes('sl.lecture_id=l.id')) return [];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
});

test('student list: revoked/expired enrollment resolves to empty (defense-in-depth deny)', async () => {
    // The hardening clause is what enforces this; hermetically we script the
    // lookup to return [] (the DB would filter a revoked/expired row) and prove
    // the route yields an empty list rather than leaking content.
    const { router, executed } = buildStudentListRouter((sql) => {
        if (sql.includes('SELECT id, phone, role FROM users WHERE id = ?')) return [{ id: 'student-a', phone: '0100000001', role: 'student' }];
        if (isStudentLookup(sql)) return [];
        return [];
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/student/student-a', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, []);
    assert.ok(executed.some((e) => e.sql.includes("approval_status = 'approved'")));
});

// ---------------------------------------------------------------------------
// C5 catalog mutation audit: courses (create/update/delete) + materials (archive)
// ---------------------------------------------------------------------------

const COURSES_INSTRUCTOR = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });
const MATERIALS_INSTRUCTOR = tokenFor({ id: 'instructor-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });

const buildCoursesRouter = (responder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const db = makeFakeDataAccess(responder);
    const users = {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
        memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] },
    });
    const router = createCoursesRouter({
        query: db.query,
        queryOne: db.queryOne,
        execute: db.execute,
        optionalAuth: createOptionalAuth(repository),
        requireTeachingWrite: () => teachingWriteStandIn,
        isSuperAdmin: async () => false,
    });
    return { router, executed: db.executed };
};

const auditAction = (executed: ExecutedStatement[], action: string): ExecutedStatement | undefined =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

test('courses: creating a course writes an audit event (course.create)', async () => {
    const { router, executed } = buildCoursesRouter((sql) => {
        if (sql.includes('SELECT UUID()')) return [{ id: 'course-new' }];
        if (sql.includes('SELECT t.id FROM tenants t')) return [{ id: 'tenant-a' }];
        if (sql.includes('SELECT * FROM courses WHERE id=? AND tenant_id=?')) return [{ id: 'course-new', tenant_id: 'tenant-a', instructor_id: 'instructor-a', name: 'Math', is_active: 1 }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: COURSES_INSTRUCTOR,
        body: { name: 'Math', subject: 'Mathematics', grade: 'G1', price: 10 },
    });
    assert.equal(response.statusCode, 201);
    assert.ok(auditAction(executed, 'course.create'), 'course.create audit present');
});

test('courses: updating a course writes an audit event (course.update)', async () => {
    const { router, executed } = buildCoursesRouter((sql) => {
        if (sql.includes('SELECT t.id FROM tenants t')) return [{ id: 'tenant-a' }];
        if (sql.includes('SELECT * FROM courses WHERE courses.id=?')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', name: 'Math', is_active: 1 }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/course-1', token: COURSES_INSTRUCTOR,
        body: { name: 'Math 2', subject: 'Mathematics', grade: 'G2', price: 20 },
    });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(executed, 'course.update'), 'course.update audit present');
});

test('courses: archiving a course writes an audit event (course.archive)', async () => {
    const { router, executed } = buildCoursesRouter((sql) => {
        if (sql.includes('SELECT t.id FROM tenants t')) return [{ id: 'tenant-a' }];
        if (sql.includes('SELECT * FROM courses WHERE courses.id=?')) return [{ id: 'course-1', tenant_id: 'tenant-a', instructor_id: 'instructor-a', name: 'Math', is_active: 1 }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'DELETE', url: '/course-1', token: COURSES_INSTRUCTOR,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(executed, 'course.archive'), 'course.archive audit present');
});

const buildMaterialsRouter = (responder: (sql: string, params: unknown[]) => unknown[] | null) => {
    const db = makeFakeDataAccess(responder);
    const users = {
        'instructor-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
    };
    const repository = makeRepository(users, {
        instructorAccounts: { 'instructor-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
        memberships: { 'instructor-a': [{ tenant_id: 'tenant-a' }] },
    });
    const router = createMaterialsRouter({
        db,
        authenticate: createAuthenticateToken(repository),
        optionalAuthenticate: createOptionalAuth(repository),
        requireTeachingWriteAccess: teachingWriteStandIn,
        hasVerifiedPlatformCapability: async () => false,
        branchAccess: tenantScopeBranchDeps((_t, _id) => 'tenant-a'),
    });
    return { router, executed: db.executed };
};

test('materials: archiving (soft-delete) a material writes an audit event (material.archive)', async () => {
    const { router, executed } = buildMaterialsRouter((sql) => {
        if (sql.includes('SELECT c.tenant_id') && sql.includes('FROM course_materials cm')) return [{ tenant_id: 'tenant-a' }];
        if (sql.includes('SELECT mg.material_id') && sql.includes('FROM material_groups mg')) return [{ material_id: 'mat-1' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'DELETE', url: '/mat-1', token: MATERIALS_INSTRUCTOR,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(auditAction(executed, 'material.archive'), 'material.archive audit present');
});

test('materials: creating a material writes an audit event (material.create) when groups resolve in scope', async () => {
    const { router, executed } = buildMaterialsRouter((sql) => {
        if (sql.includes('SELECT tenant_id FROM courses WHERE id = ?')) return [{ tenant_id: 'tenant-a' }];
        if (sql.includes('SELECT COUNT(*) AS cnt FROM `groups` g')) return [{ cnt: 1 }];
        if (sql.includes('SELECT id, branch_id, branch_scope FROM `groups`')) return [{ id: 'group-a', branch_id: null, branch_scope: 'tenant' }];
        if (sql.includes('FROM `groups` g')) return [{ id: 'group-a', branch_id: null, branch_scope: 'tenant' }];
        if (sql.includes('SELECT id FROM `groups` WHERE id = ? AND is_active = TRUE')) return [{ id: 'group-a' }];
        if (sql.includes('SELECT * FROM course_materials WHERE id = ?')) return [{ id: 'mat-new' }];
        return [];
    });
    const response = await invokeRoute(router, {
        method: 'POST', url: '/', token: MATERIALS_INSTRUCTOR,
        body: {
            course_id: 'course-a', title: 'Worksheet', material_type: 'pdf',
            file_url: 'https://example.com/w.pdf', group_ids: ['group-a'],
        },
    });
    assert.equal(response.statusCode, 201);
    assert.ok(auditAction(executed, 'material.create'), 'material.create audit present');
});
