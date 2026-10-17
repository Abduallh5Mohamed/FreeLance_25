import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import type { RequestHandler } from 'express';
import { createRequireTeachingWrite } from '../src/middleware/teaching-access';

const dotenvModule = require('dotenv') as { config: () => unknown };
dotenvModule.config = () => ({});
const mysqlModule = require('mysql2/promise') as { createPool: (...args: unknown[]) => unknown };
mysqlModule.createPool = () => ({
    getConnection: async () => { throw new Error('Database access is disabled in this test'); },
    execute: async () => { throw new Error('Database access is disabled in this test'); },
});
const originalLog = console.log;
console.log = () => {};
const coursePolicy = require('../src/routes/courses') as typeof import('../src/routes/courses');
const enrollmentPolicy = require('../src/routes/student-enrollment') as typeof import('../src/routes/student-enrollment');
const invitationHandlers = require('../src/routes/tenant-invitations') as typeof import('../src/routes/tenant-invitations');
console.log = originalLog;

const source = (name: string) => readFileSync(join(__dirname, '..', 'src', 'routes', name), 'utf8');
const courses = source('courses.ts');
const enrollment = source('student-enrollment.ts');
const invitations = source('tenant-invitations.ts');

function routeBlock(file: string, marker: string): string {
    const start = file.indexOf(marker);
    assert.notEqual(start, -1, `Missing route ${marker}`);
    const nextRoute = file.indexOf('\nrouter.', start + marker.length);
    return file.slice(start, nextRoute === -1 ? file.length : nextRoute);
}

function responseRecorder() {
    let statusCode = 200;
    let body: unknown;
    const response = {
        status(code: number) { statusCode = code; return response; },
        json(value: unknown) { body = value; return response; },
    } as unknown as Response;
    return { response, statusCode: () => statusCode, body: () => body };
}

test('course helpers reject missing tenant scope and cap untrusted pagination and input', () => {
    assert.deepEqual(coursePolicy.resolveCourseScope(undefined), { clause: ' AND tenant_id IS NULL', params: [] });
    assert.deepEqual(coursePolicy.resolveCourseScope({ role: 'admin' }), { denied: true });
    assert.deepEqual(coursePolicy.resolveCourseScope({ role: 'instructor', tenantId: 'tenant-a' }), {
        clause: ' AND tenant_id=?', params: ['tenant-a'],
    });
    assert.deepEqual(coursePolicy.parseCoursePagination({ limit: '1000', offset: '999999' }), { limit: 100, offset: 100000 });
    assert.deepEqual(coursePolicy.parseCoursePagination({ page: '3', pageSize: '20' }), { limit: 20, offset: 40 });
    assert.equal(coursePolicy.validateCourseInput({ name: 'x'.repeat(256), price: 0 }, false).ok, false);
});

test('enrollment validators reject malformed and oversized request data', () => {
    const valid = {
        student_name: 'Student One', guardian_name: 'Guardian One', phone: '01012345678', guardian_phone: '01098765432',
        password: 'long-enough-password', grade_id: 'grade-a', group_id: 'group-a', requested_courses: ['course-a', 'course-a'],
    };
    const result = enrollmentPolicy.validateEnrollmentRequestInput(valid, true);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.requestedCourses, ['course-a']);
    assert.equal(enrollmentPolicy.validateEnrollmentRequestInput({ ...valid, student_name: 'x'.repeat(256) }, true).ok, false);
    assert.equal(enrollmentPolicy.validateEnrollmentRequestInput({ ...valid, requested_courses: ['x'.repeat(129)] }, true).ok, false);
    assert.equal(enrollmentPolicy.validateEnrollmentRequestInput({ ...valid, requested_courses: Array(51).fill('course-a') }, true).ok, false);
    assert.equal(enrollmentPolicy.validateEnrollmentRequestInput({ ...valid, password: 'short' }, true).ok, false);
    assert.equal(enrollmentPolicy.validateEnrollmentRequestInput(null, true).ok, false);
    assert.deepEqual(enrollmentPolicy.parseRequestedCourseIds('["course-a","course-a"]'), ['course-a']);
    assert.equal(enrollmentPolicy.parseRequestedCourseIds('{"id":"course-a"}'), null);
    assert.equal(enrollmentPolicy.parseRequestedCourseIds('not-json'), null);
    assert.equal(enrollmentPolicy.validateEnrollmentRejectionReason('x'.repeat(1001)), null);
});

test('tenant invitation redeem handler rejects malformed input before calling injected services', async () => {
    let serviceCalls = 0;
    const handler = invitationHandlers.createRedeemHandler({
        hashPassword: async (password) => `hash:${password}`,
        consumeInvitation: async () => { serviceCalls += 1; return 'redeemed'; },
    });
    for (const body of [
        { token: 4, password: 'long-enough-password' },
        { token: 'f'.repeat(63), password: 'long-enough-password' },
        { token: 'f'.repeat(64), password: 'short' },
        { token: 'f'.repeat(64), password: 'x'.repeat(129) },
        null,
    ]) {
        const recorder = responseRecorder();
        await handler({ body } as Request, recorder.response);
        assert.equal(recorder.statusCode(), 400);
    }
    assert.equal(serviceCalls, 0);
});

test('tenant invitation redeem handler maps invalid, suspended, and service failure outcomes safely', async () => {
    const cases = [
        { result: 'invalid' as const, status: 404 },
        { result: 'suspended' as const, status: 403 },
        { result: 'redeemed' as const, status: 200 },
    ];
    for (const item of cases) {
        let tokenHash = '';
        const handler = invitationHandlers.createRedeemHandler({
            hashPassword: async () => 'fake-password-hash',
            consumeInvitation: async (value) => { tokenHash = value; return item.result; },
        });
        const recorder = responseRecorder();
        await handler({ body: { token: 'a'.repeat(64), password: 'a-secure-password' } } as Request, recorder.response);
        assert.equal(recorder.statusCode(), item.status);
        assert.notEqual(tokenHash, 'a'.repeat(64));
        assert.doesNotMatch(JSON.stringify(recorder.body()), /password-hash|token_hash|a-secure-password/);
    }

    const originalError = console.error;
    console.error = () => {};
    try {
        const handler = invitationHandlers.createRedeemHandler({
            hashPassword: async () => 'fake-password-hash',
            consumeInvitation: async () => { throw new Error('private failure detail'); },
        });
        const recorder = responseRecorder();
        await handler({ body: { token: 'b'.repeat(64), password: 'a-secure-password' } } as Request, recorder.response);
        assert.equal(recorder.statusCode(), 500);
        assert.doesNotMatch(JSON.stringify(recorder.body()), /private failure detail|fake-password-hash/);
    } finally {
        console.error = originalError;
    }
});

test('course scope denies an authenticated principal without a selected tenant', () => {
    const scope = courses.slice(courses.indexOf('export function resolveCourseScope'), courses.indexOf('// Get courses'));
    assert.match(scope, /if \(!user\) return \{ clause: ' AND tenant_id IS NULL'/);
    assert.match(scope, /return \{ denied: true \}/);
    assert.doesNotMatch(scope, /user\.role === 'admin'.*clause: ''/);
    assert.match(scope, /user\.role === 'admin'.*await dependencies\.isSuperAdmin\(user\.id\)/s);
});

test('course list is bounded and scoped; unscoped platform reads require verified super-admin authority', () => {
    const list = routeBlock(courses, "router.get('/',");
    assert.match(list, /await resolveCourseReadScope\(req\.user, dependencies\)/);
    assert.match(list, /parseCoursePagination\(req\.query\)/);
    assert.match(list, /WHERE is_active=TRUE\$\{scope\.clause\}/);
    assert.match(list, /\[\.\.\.scope\.params, String\(limit\), String\(offset\)\]/);
    assert.match(courses, /MAX_COURSE_LIMIT = 100/);
});

test('course by-id read rejects unresolved callers and applies the same tenant predicate', () => {
    const byId = routeBlock(courses, "router.get('/:id',");
    assert.match(byId, /id\.length > 128/);
    assert.match(byId, /await resolveCourseReadScope\(req\.user, dependencies\)/);
    assert.match(byId, /WHERE id=\? AND is_active=TRUE\$\{scope\.clause\}/);
    assert.match(byId, /return res\.status\(404\)/);
});

test('course create derives tenant and instructor from the verified principal', () => {
    const create = routeBlock(courses, "router.post('/',");
    assert.match(create, /createCourseWriteGuard\(dependencies\)/);
    assert.match(create, /req\.user\.tenantId/);
    assert.match(create, /req\.user\.id/);
    assert.match(create, /INSERT INTO courses \(id,tenant_id,instructor_id/);
    assert.doesNotMatch(create, /req\.body\.tenant_id|req\.body\.instructor_id/);
    assert.match(courses, /dependencies\.requireTeachingWrite\('courses'\)/);
});

test('course update and delete constrain both mutations and follow-up reads to the selected tenant', () => {
    const update = routeBlock(courses, "router.put('/:id',");
    const remove = routeBlock(courses, "router.delete('/:id',");
    assert.match(update, /createCourseWriteGuard\(dependencies\)/);
    assert.match(update, /WHERE id=\?\$\{scope\.clause\}/);
    assert.match(update, /if \(!result\.affectedRows\)/);
    assert.match(update, /SELECT \* FROM courses WHERE courses\.id=\?\$\{scope\.clause\}/);
    assert.match(remove, /createCourseWriteGuard\(dependencies\)/);
    assert.match(remove, /SET is_active=FALSE WHERE id=\?\$\{scope\.clause\}/);
    assert.match(remove, /if \(!result\.affectedRows\)/);
});

function makeTeachingRepository(roleKey: 'owner' | 'instructor' | null) {
    return {
        loadSelectedTenantMembership: async () => roleKey ? {
            role_key: roleKey,
            user_is_active: 1,
            tenant_status: 'active',
            tenant_legacy_compat: 1,
            subscription_entitles: 0,
        } : null,
        loadStaffPagePermissions: async () => null,
    };
}

function makeCourseRouterFixture(options: {
    courseOwnerId: string;
    membershipRole: 'owner' | 'instructor' | null;
    directTenantOwner?: boolean;
    studentEnrollment?: { id: string; tenantId: string; active: boolean; approved: boolean };
}) {
    const reads: Array<{ sql: string; params: unknown[] }> = [];
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const principalId = 'teacher-x';
    const repository = makeTeachingRepository(options.membershipRole);
    const guard = createRequireTeachingWrite('courses', repository);
    const router = coursePolicy.createCoursesRouter({
        query: (async (sql: string, params: unknown[] = []) => {
            reads.push({ sql, params });
            if (sql.includes('SELECT id,name,subject,description,grade,price,is_active FROM courses')) {
                return [{ id: 'course-x', name: 'Course', subject: 'Math', description: 'Public details', grade: 'G1', price: 10, is_active: 1 }];
            }
            return [];
        }) as never,
        queryOne: (async (sql: string, params: unknown[] = []) => {
            reads.push({ sql, params });
            if (sql.includes('SELECT t.id FROM tenants t')) {
                return options.directTenantOwner ? { id: 'tenant-a' } : null;
            }
            if (sql.includes('FROM students s')) {
                const [enrollmentId, userId, tenantId] = params;
                const enrollment = options.studentEnrollment;
                return enrollment && enrollment.id === enrollmentId && enrollment.tenantId === tenantId &&
                    enrollment.active && enrollment.approved && userId === principalId ? { id: enrollmentId } : null;
            }
            if (sql.includes('SELECT * FROM courses WHERE courses.id=')) {
                const [courseId, tenantId, membershipUserId, ownerUserId, directOwnerId] = params;
                const allowed = courseId === 'course-x' && tenantId === 'tenant-a' &&
                    membershipUserId === principalId && ownerUserId === principalId &&
                    (options.directTenantOwner && directOwnerId === principalId ||
                        options.membershipRole === 'owner' ||
                        (options.membershipRole === 'instructor' && options.courseOwnerId === principalId));
                return allowed ? {
                    id: 'course-x', tenant_id: 'tenant-a', instructor_id: options.courseOwnerId,
                    name: 'Course', subject: 'Math', description: 'Original description', grade: 'G1', price: 10,
                } : null;
            }
            if (sql.includes('SELECT id,name,subject,description,grade,price,is_active FROM courses')) {
                return { id: 'course-x', name: 'Course', subject: 'Math', description: 'Public details', grade: 'G1', price: 10, is_active: 1 };
            }
            return null;
        }) as never,
        execute: (async (sql: string, params: unknown[] = []) => {
            writes.push({ sql, params });
            return { affectedRows: 1 };
        }) as never,
        optionalAuth: ((_req, _res, next) => next()) as RequestHandler,
        requireTeachingWrite: () => guard,
        isSuperAdmin: async () => false,
    });
    return { router, reads, writes, principalId };
}

async function executeCourseRoute(
    router: ReturnType<typeof coursePolicy.createCoursesRouter>,
    method: 'put' | 'delete' | 'post-create' | 'get-list' | 'get-one',
    body: unknown,
    user = { id: 'teacher-x', role: 'instructor', tenantId: 'tenant-a' } as {
        id: string; role: string; tenantId: string; studentEnrollmentId?: string;
    },
) {
    type RouteLayer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } };
    const layers = (router as unknown as { stack: RouteLayer[] }).stack;
    const httpMethod = method.startsWith('get') ? 'get' : method === 'post-create' ? 'post' : method;
    const routePath = method === 'get-list' || method === 'post-create' ? '/' : '/:id';
    const layer = layers.find(candidate => candidate.route?.path === routePath && candidate.route.methods[httpMethod]);
    assert.ok(layer?.route, `Missing ${httpMethod.toUpperCase()} ${routePath} route`);
    const req = {
        method: httpMethod.toUpperCase(),
        params: { id: 'course-x' },
        body,
        query: {},
        headers: {},
        user,
    } as unknown as import('../src/middleware/auth').AuthRequest;
    let status = 200;
    let responseBody: unknown;
    const res = {
        status(code: number) { status = code; return res; },
        json(value: unknown) { responseBody = value; return res; },
    } as unknown as Response;
    const handlers = layer.route.stack.map(item => item.handle);
    const invoke = async (index: number): Promise<void> => {
        const handler = handlers[index];
        if (!handler) return;
        let nextPromise: Promise<void> | undefined;
        await Promise.resolve(handler(req, res, error => {
            if (error) throw error;
            nextPromise = invoke(index + 1);
        }));
        if (nextPromise) await nextPromise;
    };
    await invoke(0);
    return { status, body: responseBody };
}

test('course management executes real routes with live row ownership and membership predicates', async () => {
    for (const method of ['put', 'delete'] as const) {
        const foreign = makeCourseRouterFixture({ courseOwnerId: 'teacher-y', membershipRole: 'instructor' });
        const denied = await executeCourseRoute(foreign.router, method, {
            name: 'Tampered', subject: 'Math', tenant_id: 'tenant-b',
        });
        assert.equal(denied.status, 404);
        assert.equal(foreign.writes.length, 0, `${method} must perform no mutation for another instructor's row`);
        const foreignLookup = foreign.reads.find(read => read.sql.includes('SELECT * FROM courses WHERE courses.id='));
        assert.ok(foreignLookup);
        assert.deepEqual(foreignLookup.params, ['course-x', 'tenant-a', 'teacher-x', 'teacher-x', 'teacher-x']);
        assert.match(foreignLookup.sql, /courses\.tenant_id=\?/);
        assert.match(foreignLookup.sql, /course_membership\.status='active'/);
        assert.match(foreignLookup.sql, /course_membership\.role_key='owner'/);
        assert.match(foreignLookup.sql, /course_membership\.role_key='instructor' AND courses\.instructor_id=\?/);
        assert.match(foreignLookup.sql, /course_owner_tenant\.owner_user_id=\?/);

        const own = makeCourseRouterFixture({ courseOwnerId: 'teacher-x', membershipRole: 'instructor' });
        const ownAllowed = await executeCourseRoute(own.router, method, {
            name: 'Instructor own edit', subject: 'Math', tenant_id: 'tenant-b',
        });
        assert.equal(ownAllowed.status, 200);
        assert.equal(own.writes.filter(write => write.sql.startsWith('UPDATE courses')).length, 1);
        assert.equal(own.writes.filter(write => write.sql.includes('INSERT INTO audit_events')).length, 1);
        assert.deepEqual(own.reads.find(read => read.sql.includes('SELECT * FROM courses WHERE courses.id='))?.params,
            ['course-x', 'tenant-a', 'teacher-x', 'teacher-x', 'teacher-x']);

        const owner = makeCourseRouterFixture({ courseOwnerId: 'teacher-y', membershipRole: 'owner' });
        const allowed = await executeCourseRoute(owner.router, method, {
            name: 'Owner edit', subject: 'Math', tenant_id: 'tenant-b',
        });
        assert.equal(allowed.status, 200);
        const ownerMutation = owner.writes.find(write => write.sql.startsWith(method === 'put' ? 'UPDATE courses SET' : 'UPDATE courses SET is_active'));
        const ownerAudit = owner.writes.find(write => write.sql.includes('INSERT INTO audit_events'));
        assert.ok(ownerMutation, 'authorized owner performs exactly the requested course mutation');
        assert.ok(ownerAudit, 'successful course mutation writes an audit event');
        assert.equal(owner.writes.filter(write => write.sql.startsWith('UPDATE courses')).length, 1);
        assert.equal(owner.writes.filter(write => write.sql.includes('INSERT INTO audit_events')).length, 1);
        assert.deepEqual(ownerMutation.params, method === 'put'
            ? ['Owner edit', 'Math', null, null, 0, 'course-x', 'tenant-a', 'teacher-x', 'teacher-x', 'teacher-x']
            : ['course-x', 'tenant-a', 'teacher-x', 'teacher-x', 'teacher-x']);
        assert.match(ownerMutation.sql, /course_membership\.status='active'/);
        assert.match(ownerMutation.sql, /course_membership\.role_key='owner'/);
        assert.doesNotMatch(ownerMutation.params.join('|'), /tenant-b/);
        assert.deepEqual(ownerAudit.params.slice(1, 6), ['teacher-x', 'tenant-a', method === 'put' ? 'course.update' : 'course.archive', 'course', 'course-x']);
        assert.deepEqual(JSON.parse(String(ownerAudit.params[6])), {
            id: 'course-x', tenant_id: 'tenant-a', instructor_id: 'teacher-y',
            name: 'Course', subject: 'Math', description: 'Original description', grade: 'G1', price: 10,
        });
        assert.deepEqual(JSON.parse(String(ownerAudit.params[7])), method === 'put'
            ? { name: 'Owner edit', subject: 'Math', description: null, grade: null, price: 0 }
            : { is_active: false });
    }
});

test('course mutation route rejects revoked membership before any lookup or write', async () => {
    for (const method of ['put', 'delete'] as const) {
        const revoked = makeCourseRouterFixture({ courseOwnerId: 'teacher-x', membershipRole: null });
        const result = await executeCourseRoute(revoked.router, method, { name: 'Revoked edit', subject: 'Math' });
        assert.equal(result.status, 403);
        assert.equal(revoked.reads.filter(read => read.sql.includes('SELECT courses.id FROM courses')).length, 0);
        assert.equal(revoked.writes.length, 0);
    }
});

test('course catalogue preserves verified student reads with safe projection and selected enrollment binding', async () => {
    const student = makeCourseRouterFixture({
        courseOwnerId: 'teacher-y', membershipRole: null,
        studentEnrollment: { id: 'enrollment-a', tenantId: 'tenant-a', active: true, approved: true },
    });
    const principal = {
        id: 'teacher-x', role: 'student', tenantId: 'tenant-a', studentEnrollmentId: 'enrollment-a',
    };
    for (const route of ['get-list', 'get-one'] as const) {
        const result = await executeCourseRoute(student.router, route, { tenant_id: 'tenant-b' }, principal);
        assert.equal(result.status, 200);
        const enrollmentRead = student.reads.find(read => read.sql.includes('FROM students s'));
        assert.ok(enrollmentRead);
        assert.deepEqual(enrollmentRead.params, ['enrollment-a', 'teacher-x', 'tenant-a']);
        const courseRead = student.reads.find(read => read.sql.includes('SELECT id,name,subject,description,grade,price,is_active FROM courses'));
        assert.ok(courseRead);
        assert.match(courseRead.sql, /courses\.tenant_id=\?/);
        assert.doesNotMatch(courseRead.sql, /SELECT \*|password_hash|instructor_id|tenant_id,|token_hash/);
        assert.doesNotMatch(JSON.stringify(result.body), /password_hash|instructor_id|tenant_id|token_hash/);
        assert.ok(!student.writes.length, 'student catalogue reads never write');
    }
    const studentWrite = await executeCourseRoute(student.router, 'post-create', {
        name: 'Attempted course', subject: 'Math', tenant_id: 'tenant-a',
    }, principal);
    assert.equal(studentWrite.status, 403);
    assert.equal(student.writes.length, 0);

    const invalidEnrollments = [
        { id: 'enrollment-a', tenantId: 'tenant-a', active: false, approved: true },
        { id: 'enrollment-b', tenantId: 'tenant-b', active: true, approved: true },
    ];
    for (const enrollment of invalidEnrollments) {
        const fixture = makeCourseRouterFixture({
            courseOwnerId: 'teacher-y', membershipRole: null, studentEnrollment: enrollment,
        });
        const denied = await executeCourseRoute(fixture.router, 'get-list', {}, {
            id: 'teacher-x', role: 'student', tenantId: 'tenant-a', studentEnrollmentId: enrollment.id,
        });
        assert.equal(denied.status, 403);
        assert.equal(fixture.reads.filter(read => read.sql.includes('FROM courses')).length, 0);
        assert.equal(fixture.writes.length, 0);
    }
});

test('verified tenant owner without duplicate membership can manage courses', async () => {
    const directOwner = makeCourseRouterFixture({
        courseOwnerId: 'teacher-y', membershipRole: null, directTenantOwner: true,
    });
    const result = await executeCourseRoute(directOwner.router, 'delete', {});
    assert.equal(result.status, 200);
    assert.equal(directOwner.writes.filter(write => write.sql.startsWith('UPDATE courses SET is_active')).length, 1);
    assert.equal(directOwner.writes.filter(write => write.sql.includes('INSERT INTO audit_events')).length, 1);
    const directOwnerMutation = directOwner.writes.find(write => write.sql.startsWith('UPDATE courses SET is_active'))!;
    const directOwnerAudit = directOwner.writes.find(write => write.sql.includes('INSERT INTO audit_events'))!;
    assert.deepEqual(directOwner.reads[0].params, ['tenant-a', 'teacher-x']);
    assert.deepEqual(directOwnerMutation.params, ['course-x', 'tenant-a', 'teacher-x', 'teacher-x', 'teacher-x']);
    assert.deepEqual(directOwnerAudit.params.slice(1, 6), ['teacher-x', 'tenant-a', 'course.archive', 'course', 'course-x']);
});

test('enrollment invite rotation is tied to the selected active tenant', () => {
    const rotate = routeBlock(enrollment, "router.post('/invites/rotate'");
    assert.match(rotate, /authenticateToken/);
    assert.match(rotate, /req\.user\.tenantId/);
    assert.match(rotate, /instructorTenant\(req\.user\.id, tenantId\)/);
    assert.match(rotate, /WHERE instructor_id=\? AND tenant_id=\? AND revoked_at IS NULL/);
    assert.match(rotate, /VALUES \(\?,\?,\?,\?,DATE_ADD/);
});

test('current enrollment invite lookup is tenant-scoped and expires old tokens', () => {
    const current = routeBlock(enrollment, "router.get('/invites/current'");
    assert.match(current, /authenticateToken/);
    assert.match(current, /WHERE instructor_id=\? AND tenant_id=\?/);
    assert.match(current, /expires_at>UTC_TIMESTAMP\(\)/);
    assert.match(current, /LIMIT 1/);
});

test('public enrollment metadata validates tenant-bound invite and caps related records', () => {
    const metadata = routeBlock(enrollment, "router.get('/join/:token'");
    assert.match(metadata, /validInvite\(req\.params\.token\)/);
    assert.match(metadata, /LIMIT 250/);
    assert.match(metadata, /t\.id=\? AND t\.owner_user_id=g\.instructor_id/);
    assert.match(metadata, /c\.tenant_id=\?/);
    assert.match(metadata, /Cache-Control', 'no-store'/);
});

test('join request rejects invalid callers and bounded input while duplicate submissions stay idempotent', () => {
    const request = routeBlock(enrollment, "router.post('/join/:token/requests'");
    assert.match(request, /validInvite\(req\.params\.token\)/);
    assert.match(request, /req\.user\.role !== 'student'/);
    assert.match(request, /validateEnrollmentRequestInput\(req\.body, !req\.user\)/);
    assert.match(request, /WHERE tenant_id=\? AND phone=\? AND status='pending'/);
    assert.match(request, /if \(pending\) return res\.status\(202\)/);
    assert.match(request, /id,tenant_id,instructor_id,invite_id,user_id/);
});

test('instructor request listing uses active selected tenant and a fixed result cap', () => {
    const list = routeBlock(enrollment, "router.get('/requests'");
    assert.match(list, /authenticateToken/);
    assert.match(list, /instructorTenant\(req\.user\.id, tenantId\)/);
    assert.match(list, /WHERE r\.tenant_id=\? AND r\.instructor_id=\?/);
    assert.match(list, /LIMIT 250/);
    assert.doesNotMatch(list, /password_hash/);
});

test('approval is tenant-bound, validates optional selections, and treats duplicate approval idempotently', () => {
    const approve = routeBlock(enrollment, "router.post('/requests/:id/approve'");
    assert.match(approve, /WHERE id=\? AND tenant_id=\? AND instructor_id=\? FOR UPDATE/);
    assert.match(approve, /request\.status === 'approved'/);
    assert.match(approve, /WHERE tenant_id=\? AND user_id=\? LIMIT 1 FOR UPDATE/);
    assert.match(approve, /requestedCourses\)/);
    assert.match(approve, /c\.tenant_id=\?/);
    assert.match(approve, /password_hash,approval_status/);
    assert.match(approve, /SET status='approved',user_id=\?,password_hash=NULL/);
    assert.match(approve, /WHERE id=\? AND tenant_id=\? AND instructor_id=\? AND status='pending'/);
});

test('rejection validates reason length and updates only a pending request in the selected tenant', () => {
    const reject = routeBlock(enrollment, "router.post('/requests/:id/reject'");
    assert.match(reject, /validateEnrollmentRejectionReason/);
    assert.match(reject, /WHERE id=\? AND tenant_id=\? AND instructor_id=\? AND status='pending'/);
    assert.match(reject, /reason, req\.user\.id, requestId, tenant\.id/);
    assert.match(enrollment, /MAX_REJECTION_REASON_LENGTH = 1000/);
});

test('student spaces and selection expose only the authenticated student’s enrollments', () => {
    const spaces = routeBlock(enrollment, "router.get('/spaces'");
    // The select route now delegates to the exported handler factory (so the
    // real issuance path is exercised by hermetic tests); the identity and
    // tenant scope assertions therefore apply to the handler body.
    const select = enrollment.slice(
        enrollment.indexOf('createStudentWorkspaceSelectHandler = (deps:'),
        enrollment.indexOf("router.post('/spaces/:enrollmentId/select'"));
    assert.match(spaces, /s\.user_id=\?/);
    assert.match(spaces, /s\.approval_status='approved'/);
    assert.match(spaces, /t\.status='active'/);
    assert.doesNotMatch(spaces, /password_hash|guardian_phone/);
    assert.match(select, /validId\(req\.params\.enrollmentId\)/);
    assert.match(select, /s\.id=\? AND s\.user_id=\?/);
    assert.match(select, /t\.status='active'/);
});

test('password-reset request is privacy-preserving and bound to the invite tenant', () => {
    const request = routeBlock(enrollment, "router.post('/join/:token/password-reset'");
    assert.match(request, /validInvite\(req\.params\.token\)/);
    assert.match(request, /s\.tenant_id=\?/);
    assert.match(request, /t\.status='active'/);
    assert.match(request, /student_password_reset_requests WHERE tenant_id=\? AND user_id=\?/);
    assert.match(request, /res\.status\(202\)/);
});

test('password-reset listing and approval require the instructor’s selected tenant', () => {
    const list = routeBlock(enrollment, "router.get('/password-resets'");
    const approve = routeBlock(enrollment, "router.post('/password-resets/:id/approve'");
    assert.match(list, /WHERE r\.tenant_id=\?/);
    assert.match(list, /s\.tenant_id=r\.tenant_id AND s\.user_id=r\.user_id/);
    assert.match(list, /LIMIT 100/);
    assert.match(approve, /validId\(req\.params\.id\)/);
    assert.match(approve, /WHERE id=\? AND tenant_id=\? AND status='pending'/);
    assert.match(approve, /s\.tenant_id=student_password_reset_requests\.tenant_id/);
});

test('password-reset completion checks expiry and tenant enrollment, then consumes the token once', () => {
    const complete = routeBlock(enrollment, "router.post('/password-resets/complete'");
    assert.match(complete, /t\.id=r\.tenant_id AND t\.status='active'/);
    assert.match(complete, /s\.id=r\.student_enrollment_id AND s\.tenant_id=r\.tenant_id AND s\.user_id=r\.user_id/);
    assert.match(complete, /r\.reset_expires_at>UTC_TIMESTAMP\(\) FOR UPDATE/);
    assert.match(complete, /status='used',reset_token_hash=NULL/);
});

test('legacy backfill review reads require verified platform super-admin authority', () => {
    const list = routeBlock(enrollment, "router.get('/backfill-reviews'");
    const resolve = routeBlock(enrollment, "router.post('/backfill-reviews/:id/resolve'");
    assert.match(list, /await isSuperAdmin\(req\.user\.id\)/);
    assert.match(list, /LIMIT 250/);
    assert.match(resolve, /await isSuperAdmin\(req\.user\.id\)/);
    assert.match(resolve, /return res\.status\(410\)/);
});

test('tenant invitation redemption validates input and atomically consumes an unexpired tenant-bound token', () => {
    assert.match(invitations, /i\.used_at IS NULL AND i\.expires_at>UTC_TIMESTAMP\(\)/);
    assert.match(invitations, /INNER JOIN tenants t ON t\.id=i\.tenant_id AND t\.status='active'/);
    assert.match(invitations, /WHERE id=\? AND tenant_id=\? AND user_id=\? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP\(\)/);
    assert.match(invitations, /INVITATION_TOKEN_PATTERN\.test\(token\)/);
    assert.match(invitations, /password\.length < INVITATION_PASSWORD_MIN_LENGTH/);
    assert.match(invitations, /if \(result === 'invalid'\)/);
    assert.match(invitations, /if \(result === 'suspended'\)/);
    assert.doesNotMatch(invitations, /res\.json\(\{[^}]*password_hash|res\.json\(\{[^}]*token_hash/);
});
