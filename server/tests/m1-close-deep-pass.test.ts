import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import type { AttendanceDataAccess, AttendanceRouterDeps } from '../src/routes/attendance';
import type { ExamResultsDataAccess, ExamResultsRouterDeps } from '../src/routes/exam-results';
import type { ManualGradingDataAccess, ManualGradingRouterDeps } from '../src/routes/manual-grading';
import type { PaymentRequestsDataAccess, PaymentRequestsRouterDeps } from '../src/routes/payment-requests';

const routeFactoriesPromise = (async () => {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
        const [attendance, examResults, manualGrading, paymentRequests] = await Promise.all([
            import('../src/routes/attendance'),
            import('../src/routes/exam-results'),
            import('../src/routes/manual-grading'),
            import('../src/routes/payment-requests'),
        ]);
        return { attendance, examResults, manualGrading, paymentRequests };
    } finally {
        console.log = originalLog;
    }
})();

interface Principal {
    id: string;
    role: string;
    tenantId?: string;
}

interface RouteLayer {
    route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: RequestHandler }>;
    };
}

const passThrough: RequestHandler = (_req, _res, next) => next();

const findHandler = (router: Router, method: string, path: string): RequestHandler => {
    const layers = (router as unknown as { stack: RouteLayer[] }).stack;
    const layer = layers.find((candidate) =>
        candidate.route?.path === path && candidate.route.methods[method.toLowerCase()],
    );
    assert.ok(layer?.route, `Missing ${method} ${path} route`);
    const last = layer.route.stack.at(-1);
    assert.ok(last, `Missing handler for ${method} ${path}`);
    return last.handle;
};

const invoke = async (
    router: Router,
    method: string,
    path: string,
    principal: Principal,
    options: { body?: unknown; query?: Record<string, unknown>; params?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> => {
    const req = Object.assign(Object.create(null) as object, {
        user: principal,
        body: options.body ?? {},
        query: options.query ?? {},
        params: options.params ?? {},
    }) as unknown as Request;
    const result: { status: number; body: unknown } = { status: 200, body: undefined };
    const res = {
        status(code: number) {
            result.status = code;
            return this;
        },
        json(body: unknown) {
            result.body = body;
            return this;
        },
    } as unknown as Response;
    const handler = findHandler(router, method, path) as unknown as (
        request: Request,
        response: Response,
        next: NextFunction,
    ) => Promise<unknown>;
    await handler(req, res, () => undefined);
    return result;
};

test('attendance absent notifications stay inside the selected group tenant', async () => {
    const studentQueries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    let notifications = 0;
    const db = {
        query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            studentQueries.push({ sql, params });
            return [];
        },
        queryOne: async <T>(sql: string): Promise<T | null> => {
            if (sql.includes('FROM `groups` g')) return { id: 'group-1' } as T;
            return null;
        },
        execute: async () => ({ affectedRows: 0 }),
    } as unknown as AttendanceDataAccess;
    const deps: AttendanceRouterDeps = {
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        notify: { sendWhatsAppMessage: async () => { notifications += 1; return { success: true }; } },
        hasVerifiedPlatformCapability: async () => false,
    };

    const result = await invoke(
        (await routeFactoriesPromise).attendance.createAttendanceRouter(deps),
        'POST',
        '/notify-absent',
        { id: 'teacher-1', role: 'teacher', tenantId: 'tenant-1' },
        { body: { group_id: 'group-1', date: '2026-10-17' } },
    );

    assert.equal(result.status, 404);
    assert.equal(notifications, 0);
    assert.equal(studentQueries.length, 1);
    assert.match(studentQueries[0].sql, /group_id = \?/);
    assert.match(studentQueries[0].sql, /tenant_id = \?/);
    assert.deepEqual(studentQueries[0].params, ['group-1', 'tenant-1']);
});

test('exam-results instructor reads are tenant-scoped and bare admin role is denied', async () => {
    const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const db = {
        query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            statements.push({ sql, params });
            return [];
        },
        queryOne: async <T>(): Promise<T | null> => null,
    } as unknown as ExamResultsDataAccess;
    const deps: ExamResultsRouterDeps = {
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        isPlatformAdmin: async () => false,
        hasActiveInstructorMembership: async () => true,
    };
    const router = (await routeFactoriesPromise).examResults.createExamResultsRouter(deps);

    const instructorResult = await invoke(router, 'GET', '/', {
        id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1',
    });
    assert.equal(instructorResult.status, 200);
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /s\.tenant_id = \?/);
    assert.deepEqual(statements[0].params, ['tenant-1', 'teacher-1', 'teacher-1', 'tenant-1', 'teacher-1', 'tenant-1']);

    const denied = await invoke(router, 'GET', '/', { id: 'role-only-admin', role: 'admin' });
    assert.equal(denied.status, 403);
    assert.equal(statements.length, 1);
});

test('exam-results student route rejects a caller-supplied foreign student identity', async () => {
    let resultReads = 0;
    const db = {
        query: async <T>(sql: string): Promise<T[]> => {
            if (sql.includes('SELECT id FROM students')) return [];
            resultReads += 1;
            return [];
        },
        queryOne: async <T>(): Promise<T | null> => null,
    } as unknown as ExamResultsDataAccess;
    const router = (await routeFactoriesPromise).examResults.createExamResultsRouter({
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        isPlatformAdmin: async () => false,
    });
    const result = await invoke(router, 'GET', '/student/:studentId', {
        id: 'student-user-1', role: 'student', tenantId: 'tenant-1',
    }, { params: { studentId: 'student-user-1' } });

    assert.equal(result.status, 404);
    assert.equal(resultReads, 0);
});

test('exam-results joins the enrollment FK exactly and preserves user identity in student results', async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const db = {
        query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            if (sql.includes('SELECT id FROM students')) return [{ id: 'enrollment-a' } as T];
            statements.push({ sql, params });
            return [];
        },
        queryOne: async <T>(): Promise<T | null> => null,
    } as unknown as ExamResultsDataAccess;
    const router = (await routeFactoriesPromise).examResults.createExamResultsRouter({
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        isPlatformAdmin: async () => false,
    });
    const result = await invoke(router, 'GET', '/student/:studentId', {
        id: 'student-user-1', role: 'student', tenantId: 'tenant-1',
    }, { params: { studentId: 'student-user-1' } });

    assert.equal(result.status, 200);
    assert.equal(statements.length, 1);
    assert.match(statements[0].sql, /INNER JOIN students s ON s\.id = er\.student_id/);
    assert.match(statements[0].sql, /INNER JOIN students s ON s\.id = ea\.student_id/);
    assert.match(statements[0].sql, /s\.user_id AS student_id/);
    assert.doesNotMatch(statements[0].sql, /sx\.id = er\.student_id OR sx\.user_id = er\.student_id/);
    assert.deepEqual(statements[0].params, ['enrollment-a', 'tenant-1', 'enrollment-a', 'tenant-1']);
});

test('exam-results self selector stays inside selected tenant and ignores colliding enrollment IDs', async () => {
    const resultQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const enrollments = [
        { id: 'own-a', user_id: 'user-1', tenant_id: 'tenant-a' },
        { id: 'own-b', user_id: 'user-1', tenant_id: 'tenant-b' },
        { id: 'user-1', user_id: 'different-user', tenant_id: 'tenant-a' },
    ];
    const db = {
        query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            if (sql.includes('SELECT id FROM students')) {
                if (sql.includes('WHERE user_id = ?')) {
                    assert.deepEqual(params, ['user-1', 'tenant-a']);
                    return enrollments.filter((row) => row.user_id === params[0] && row.tenant_id === params[1])
                        .map(({ id }) => ({ id } as T));
                }
                if (sql.includes('WHERE id = ?')) {
                    assert.equal(params?.[1], 'user-1');
                    assert.equal(params?.[2], 'tenant-a');
                    return enrollments.filter((row) => row.id === params[0]
                        && row.user_id === params[1] && row.tenant_id === params[2])
                        .map(({ id }) => ({ id } as T));
                }
            }
            resultQueries.push({ sql, params });
            return [];
        },
        queryOne: async <T>(): Promise<T | null> => null,
    } as unknown as ExamResultsDataAccess;
    const router = (await routeFactoriesPromise).examResults.createExamResultsRouter({
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        isPlatformAdmin: async () => false,
    });
    const principal = { id: 'user-1', role: 'student', tenantId: 'tenant-a' };

    const byUser = await invoke(router, 'GET', '/student/:studentId', principal, {
        params: { studentId: 'user-1' },
    });
    assert.equal(byUser.status, 200);
    assert.deepEqual(resultQueries[0].params, ['own-a', 'tenant-a', 'own-a', 'tenant-a']);
    assert.doesNotMatch(resultQueries[0].sql, /s\.id = \? OR s\.user_id = \?/);

    const byEnrollment = await invoke(router, 'GET', '/student/:studentId', principal, {
        params: { studentId: 'own-a' },
    });
    assert.equal(byEnrollment.status, 200);
    assert.deepEqual(resultQueries[1].params, ['own-a', 'tenant-a', 'own-a', 'tenant-a']);

    const foreignTenantEnrollment = await invoke(router, 'GET', '/student/:studentId', principal, {
        params: { studentId: 'own-b' },
    });
    assert.equal(foreignTenantEnrollment.status, 403);
    const forgedEnrollment = await invoke(router, 'GET', '/student/:studentId', principal, {
        params: { studentId: 'enrollment-collision' },
    });
    assert.equal(forgedEnrollment.status, 403);
    assert.equal(resultQueries.length, 2);
});

test('manual grading rejects role-only admin and foreign questions, then accepts validated scores', async () => {
    let transactions = 0;
    const writes: Array<{ sql: string; params?: unknown[] }> = [];
    const student = {
        id: 'student-enrollment-1',
        user_id: 'student-user-1',
        tenant_id: 'tenant-1',
        grade_id: 'grade-1',
        group_id: 'group-1',
    };
    const tx = {
        query: async <T>(): Promise<T[]> => [{ id: 'question-1', points: 10 } as T],
        queryOne: async <T>(sql: string): Promise<T | null> => {
            if (sql.includes('FROM students WHERE id = ?')) return { id: student.id } as T;
            if (sql.includes('SELECT eg.exam_id')) return { exam_id: 'exam-1' } as T;
            if (sql.includes('FROM exam_attempts ea')) {
                return { id: 'attempt-1', status: 'pending_review', score: 10 } as T;
            }
            if (sql.includes('FROM exams WHERE id = ?')) return { total_marks: 100, passing_marks: 50 } as T;
            return null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            writes.push({ sql, params });
            return { affectedRows: 1 };
        },
    };
    const db = {
        query: tx.query,
        queryOne: async <T>(): Promise<T | null> => null,
        execute: tx.execute,
        withTransaction: async <T>(work: (adapter: Pick<ManualGradingDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>) => {
            transactions += 1;
            return work(tx);
        },
    } as unknown as ManualGradingDataAccess;
    const deps: ManualGradingRouterDeps = {
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        isPlatformAdmin: async () => false,
        hasActiveInstructorMembership: async () => true,
    };
    const router = (await routeFactoriesPromise).manualGrading.createManualGradingRouter(deps);

    const roleOnlyAdmin = await invoke(router, 'POST', '/submit', {
        id: 'role-only-admin', role: 'admin', tenantId: 'tenant-1',
    }, {
        body: { exam_id: 'exam-1', student_id: 'student-enrollment-1', essay_scores: {}, total_score: 10 },
    });
    assert.equal(roleOnlyAdmin.status, 403);
    assert.equal(transactions, 0);

    const foreignQuestion = await invoke(router, 'POST', '/submit', {
        id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1',
    }, {
        body: {
            exam_id: 'exam-1',
            student_id: 'student-enrollment-1',
            essay_scores: { 'foreign-question': 5 },
            total_score: 15,
        },
    });
    assert.equal(foreignQuestion.status, 400);
    assert.equal(transactions, 1);
    assert.equal(writes.length, 0);

    const validGrade = await invoke(router, 'POST', '/submit', {
        id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1',
    }, {
        body: {
            exam_id: 'exam-1',
            student_id: 'student-enrollment-1',
            essay_scores: { 'question-1': { score: 5, feedback: 'Reviewed' } },
            total_score: 15,
        },
    });
    assert.equal(validGrade.status, 200);
    assert.equal((validGrade.body as { total_score: number }).total_score, 15);
    assert.equal(transactions, 2);
    assert.equal(writes.length, 3);
    const resultUpdate = writes.find(({ sql }) => sql.includes('UPDATE exam_results'));
    assert.equal(resultUpdate?.params?.[2], 'teacher-1');
});

test('manual grading transaction adapter commits on success and releases its connection', async () => {
    const events: string[] = [];
    const connection = {
        beginTransaction: async () => { events.push('begin'); },
        execute: async () => { events.push('execute'); return [[], {}]; },
        commit: async () => { events.push('commit'); },
        rollback: async () => { events.push('rollback'); },
        release: () => { events.push('release'); },
        destroy: () => { events.push('destroy'); throw new Error('destroy failed'); },
    };
    const module = (await routeFactoriesPromise).manualGrading;
    const adapter = module.createManualGradingTransactionAdapter(() => ({
        getConnection: async () => connection,
    }) as unknown as Parameters<typeof module.createManualGradingTransactionAdapter>[0] extends () => infer P ? P : never);

    await adapter(async (tx) => { await tx.execute('UPDATE x'); return 'ok'; });
    assert.deepEqual(events, ['begin', 'execute', 'commit', 'release']);
});

test('manual grading adapter rolls back execute failure and releases after recovery', async () => {
    const events: string[] = [];
    const executeError = new Error('execute failed');
    const connection = {
        beginTransaction: async () => { events.push('begin'); },
        execute: async () => { events.push('execute'); throw executeError; },
        commit: async () => { events.push('commit'); },
        rollback: async () => { events.push('rollback'); },
        release: () => { events.push('release'); },
        destroy: () => { events.push('destroy'); },
    };
    const module = (await routeFactoriesPromise).manualGrading;
    const adapter = module.createManualGradingTransactionAdapter(() => ({
        getConnection: async () => connection,
    }) as unknown as Parameters<typeof module.createManualGradingTransactionAdapter>[0] extends () => infer P ? P : never);

    await assert.rejects(adapter(async (tx) => { await tx.execute('UPDATE x'); }), (error) => error === executeError);
    assert.deepEqual(events, ['begin', 'execute', 'rollback', 'release']);
});

test('manual grading adapter releases when begin fails without starting a transaction', async () => {
    const events: string[] = [];
    const beginError = new Error('begin failed');
    const connection = {
        beginTransaction: async () => { events.push('begin'); throw beginError; },
        execute: async () => [[], {}],
        commit: async () => { events.push('commit'); },
        rollback: async () => { events.push('rollback'); },
        release: () => { events.push('release'); },
        destroy: () => { events.push('destroy'); },
    };
    const module = (await routeFactoriesPromise).manualGrading;
    const adapter = module.createManualGradingTransactionAdapter(() => ({
        getConnection: async () => connection,
    }) as unknown as Parameters<typeof module.createManualGradingTransactionAdapter>[0] extends () => infer P ? P : never);

    await assert.rejects(adapter(async () => 'unused'), (error) => error === beginError);
    assert.deepEqual(events, ['begin', 'release']);
});

test('manual grading rollback failure destroys the connection and preserves the original failure', async () => {
    const events: string[] = [];
    const primaryError = new Error('write failed');
    const connection = {
        beginTransaction: async () => { events.push('begin'); },
        execute: async () => [[], {}],
        commit: async () => { events.push('commit'); },
        rollback: async () => { events.push('rollback'); throw new Error('rollback failed'); },
        release: () => { events.push('release'); },
        destroy: () => { events.push('destroy'); },
    };
    const module = (await routeFactoriesPromise).manualGrading;
    const adapter = module.createManualGradingTransactionAdapter(() => ({
        getConnection: async () => connection,
    }) as unknown as Parameters<typeof module.createManualGradingTransactionAdapter>[0] extends () => infer P ? P : never);

    await assert.rejects(adapter(async () => { throw primaryError; }), (error) => error === primaryError);
    assert.deepEqual(events, ['begin', 'rollback', 'destroy']);
});

test('manual grading adapter rolls back commit failure and releases only after a successful rollback', async () => {
    const events: string[] = [];
    const commitError = new Error('commit failed');
    const connection = {
        beginTransaction: async () => { events.push('begin'); },
        execute: async () => [[], {}],
        commit: async () => { events.push('commit'); throw commitError; },
        rollback: async () => { events.push('rollback'); },
        release: () => { events.push('release'); },
        destroy: () => { events.push('destroy'); },
    };
    const module = (await routeFactoriesPromise).manualGrading;
    const adapter = module.createManualGradingTransactionAdapter(() => ({
        getConnection: async () => connection,
    }) as unknown as Parameters<typeof module.createManualGradingTransactionAdapter>[0] extends () => infer P ? P : never);

    await assert.rejects(adapter(async () => 'result'), (error) => error === commitError);
    assert.deepEqual(events, ['begin', 'commit', 'rollback', 'release']);
});

test('manual grading refuses a missing transaction adapter before attempting grading writes', async () => {
    const db = {
        query: async <T>(): Promise<T[]> => [],
        queryOne: async <T>(): Promise<T | null> => null,
        execute: async () => ({ affectedRows: 1 }),
    } as unknown as ManualGradingDataAccess;
    const router = (await routeFactoriesPromise).manualGrading.createManualGradingRouter({
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        hasActiveInstructorMembership: async () => true,
        isPlatformAdmin: async () => false,
    });
    const result = await invoke(router, 'POST', '/submit', {
        id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1',
    }, { body: { exam_id: 'exam-1', student_id: 'student-1', essay_scores: {}, total_score: 0 } });

    assert.equal(result.status, 503);
});

test('manual grading default membership lookup denies a tenant claim with no active membership row', async () => {
    const lookups: string[] = [];
    const db = {
        query: async <T>(): Promise<T[]> => [],
        queryOne: async <T>(sql: string): Promise<T | null> => { lookups.push(sql); return null; },
        execute: async () => ({ affectedRows: 0 }),
        withTransaction: async <T>(work: (adapter: Pick<ManualGradingDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>) => work(db),
    } as unknown as ManualGradingDataAccess;
    const router = (await routeFactoriesPromise).manualGrading.createManualGradingRouter({
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
    });
    const result = await invoke(router, 'GET', '/pending', {
        id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1',
    }, { query: { grade_id: 'grade-1' } });

    assert.equal(result.status, 403);
    assert.equal(lookups.length, 1);
    assert.match(lookups[0], /tenant_memberships/);
    assert.match(lookups[0], /m\.status = 'active'/);
    assert.match(lookups[0], /m\.role_key IN \('owner','instructor'\)/);
});

test('manual grading rejects ambiguous legacy user IDs within the selected tenant', async () => {
    const lookupSql: string[] = [];
    const writes: string[] = [];
    const tx = {
        query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
            lookupSql.push(sql);
            assert.deepEqual(params, ['student-user-1', 'tenant-1']);
            return [{ id: 'enrollment-1' }, { id: 'enrollment-2' }] as T[];
        },
        queryOne: async <T>(): Promise<T | null> => null,
        execute: async (sql: string) => { writes.push(sql); return { affectedRows: 1 }; },
    };
    const db = {
        query: tx.query,
        queryOne: tx.queryOne,
        execute: tx.execute,
        withTransaction: async <T>(work: (adapter: Pick<ManualGradingDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>) => work(tx),
    } as unknown as ManualGradingDataAccess;
    const router = (await routeFactoriesPromise).manualGrading.createManualGradingRouter({
        db,
        authenticate: passThrough,
        optionalAuthenticate: passThrough,
        isPlatformAdmin: async () => false,
        hasActiveInstructorMembership: async () => true,
    });
    const result = await invoke(router, 'POST', '/submit', {
        id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1',
    }, {
        body: { exam_id: 'exam-1', student_id: 'student-user-1', essay_scores: {}, total_score: 0 },
    });

    assert.equal(result.status, 404);
    assert.equal(lookupSql.length, 1);
    assert.match(lookupSql[0], /user_id = \? AND is_active = 1 AND tenant_id = \?/);
    assert.deepEqual(writes, []);
});

test('payment requests reject fractional cents and persist accepted amounts as exact decimals', async () => {
    let inserts = 0;
    const insertedParams: unknown[][] = [];
    const db = {
        query: async <T>(): Promise<T[]> => [],
        queryOne: async <T>(sql: string): Promise<T | null> => {
            if (sql.includes('FROM students WHERE id=? AND tenant_id=?')) {
                return { id: 'student-1', user_id: 'student-user-1', name: 'Student', phone: null, email: null, grade_id: 'grade-1', group_id: 'group-1' } as T;
            }
            if (sql.includes('FROM grades WHERE id=?')) return { id: 'grade-1', name: 'Grade' } as T;
            if (sql.includes('FROM `groups` g')) return { id: 'group-1', name: 'Group' } as T;
            if (sql.includes('SELECT owner_user_id')) return { owner_user_id: 'owner-1' } as T;
            return null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            inserts += 1;
            if (sql.includes('INSERT INTO payment_requests')) insertedParams.push(params ?? []);
            return { affectedRows: 1 };
        },
        withTransaction: async <T>(work: (adapter: Pick<PaymentRequestsDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>) => work(db),
    } as unknown as PaymentRequestsDataAccess;
    const deps: PaymentRequestsRouterDeps = {
        db,
        authenticate: passThrough,
        authorize: passThrough,
        hasVerifiedPlatformFinanceAccess: async () => false,
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
    };
    const router = (await routeFactoriesPromise).paymentRequests.createPaymentRequestsRouter(deps);
    const principal = { id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1' };
    const body = { student_id: 'student-1', grade_id: 'grade-1', group_id: 'group-1' };

    const invalid = await invoke(router, 'POST', '/', principal, { body: { ...body, amount: '12.345' } });
    assert.equal(invalid.status, 400);
    assert.equal(inserts, 0);

    const accepted = await invoke(router, 'POST', '/', principal, { body: { ...body, amount: '12.3' } });
    assert.equal(accepted.status, 201);
    assert.equal(inserts, 2);
    assert.equal(insertedParams.length, 1);
    assert.equal(insertedParams[0][10], '12.30');
});

test('payment approval posts exact cents once and rejects a repeated transition', async () => {
    let requestStatus = 'pending';
    const writes: Array<{ sql: string; params?: unknown[] }> = [];
    const tx = {
        query: async <T>(): Promise<T[]> => [],
        queryOne: async <T>(sql: string): Promise<T | null> => {
            if (sql.includes('FROM payment_requests')) {
                return {
                    id: 'request-1', tenant_id: 'tenant-1', status: requestStatus,
                    amount: '12.34', student_id: 'student-1', grade_id: 'grade-1',
                    grade_name: 'Grade', group_id: 'group-1', group_name: 'Group',
                    payment_method: 'cash', notes: null,
                } as T;
            }
            if (sql.includes('FROM students s') && sql.includes('s.tenant_id=?')) {
                return {
                    id: 'student-1', user_id: 'student-user-1', name: 'Student',
                    phone: null, guardian_phone: null, grade_id: 'grade-1', group_id: 'group-1',
                } as T;
            }
            return null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            writes.push({ sql, params });
            if (sql.includes('UPDATE payment_requests SET status')) requestStatus = 'approved';
            return { affectedRows: 1 };
        },
    };
    const db = {
        query: tx.query,
        queryOne: async <T>(): Promise<T | null> => null,
        execute: tx.execute,
        withTransaction: async <T>(work: (adapter: Pick<PaymentRequestsDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>) => work(tx),
    } as unknown as PaymentRequestsDataAccess;
    const router = (await routeFactoriesPromise).paymentRequests.createPaymentRequestsRouter({
        db,
        authenticate: passThrough,
        authorize: passThrough,
        hasVerifiedPlatformFinanceAccess: async () => false,
        loadActiveTenantAuthority: async () => ({ authority: 'instructor' }),
    });
    const principal = { id: 'teacher-1', role: 'instructor', tenantId: 'tenant-1' };

    const approved = await invoke(router, 'POST', '/:id/approve', principal, { params: { id: 'request-1' } });
    assert.equal(approved.status, 200);
    assert.equal(writes.filter(({ sql }) => sql.includes('INSERT INTO student_fees')).length, 1);
    assert.equal(writes.find(({ sql }) => sql.includes('INSERT INTO student_fees'))?.params?.[9], '12.34');
    assert.equal(writes.find(({ sql }) => sql.includes('INSERT INTO revenues'))?.params?.[1], '12.34');

    const repeated = await invoke(router, 'POST', '/:id/approve', principal, { params: { id: 'request-1' } });
    assert.equal(repeated.status, 400);
    assert.equal(writes.filter(({ sql }) => sql.includes('INSERT INTO student_fees')).length, 1);
    assert.equal(writes.filter(({ sql }) => sql.includes('INSERT INTO revenues')).length, 1);
});

test('payment permission lookup failures fail closed before reading requests', async () => {
    let reads = 0;
    const db = {
        query: async <T>(): Promise<T[]> => { reads += 1; return []; },
        queryOne: async <T>(): Promise<T | null> => null,
        execute: async () => ({ affectedRows: 0 }),
        withTransaction: async <T>(work: (adapter: Pick<PaymentRequestsDataAccess, 'query' | 'queryOne' | 'execute'>) => Promise<T>) => work(db),
    } as unknown as PaymentRequestsDataAccess;
    const router = (await routeFactoriesPromise).paymentRequests.createPaymentRequestsRouter({
        db,
        authenticate: passThrough,
        authorize: passThrough,
        hasVerifiedPlatformFinanceAccess: async () => { throw new Error('fixture lookup failure'); },
        loadActiveTenantAuthority: async () => null,
    });

    const originalError = console.error;
    console.error = () => undefined;
    try {
        const result = await invoke(router, 'GET', '/', { id: 'role-only-admin', role: 'admin', tenantId: 'tenant-1' });
        assert.equal(result.status, 503);
        assert.equal(reads, 0);
    } finally {
        console.error = originalError;
    }
});
