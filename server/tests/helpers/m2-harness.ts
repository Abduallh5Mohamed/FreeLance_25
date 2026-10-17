/**
 * Shared hermetic test harness for the M2 identity/catalog/enrollment work.
 *
 * Every factory under test is driven through its REAL exported route builder
 * with injected seams: a scripted SQL adapter, the REAL auth middleware over an
 * injected principal repository, and a teaching-write stand-in. No database,
 * network, Docker image or real service is contacted; src/db.ts never creates a
 * pool because no production query runs (db.ts only runs dotenv.config() at
 * import, and there is no .env in the test working directory).
 */
import assert from 'node:assert/strict';
import type { NextFunction, RequestHandler, Response } from 'express';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, createAuthenticateToken, createOptionalAuth } from '../../src/middleware/auth';
import type { PrincipalRepository } from '../../src/security/principal-repository';

export const TEST_SECRET = 'm2-test-only-secret-with-sufficient-length-0123456789';

export interface ExecutedStatement {
    sql: string;
    params: unknown[];
    kind: 'query' | 'queryOne' | 'execute';
}

export interface FakeDataAccess {
    query: <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = any>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    executed: ExecutedStatement[];
}

/**
 * Build a scripted data access. `responder` returns the rows (or null) for a
 * given SQL + params; every call is logged to `executed` so tests can assert
 * both behavioral outcomes and decision-boundary SQL (gates that MySQL applies
 * at row level are asserted via the exact SQL text + bindings the real handler
 * emitted, since no live database filters rows).
 */
export const makeFakeDataAccess = (
    responder: (sql: string, params: unknown[]) => unknown[] | null,
): FakeDataAccess => {
    const executed: ExecutedStatement[] = [];
    const query = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => {
        executed.push({ sql, params, kind: 'query' });
        return (responder(sql, params) ?? []) as T[];
    };
    const queryOne = async <T = any>(sql: string, params: unknown[] = []): Promise<T | null> => {
        executed.push({ sql, params, kind: 'queryOne' });
        const rows = responder(sql, params) ?? [];
        return (rows[0] ?? null) as T | null;
    };
    const execute = async (
        sql: string,
        params: unknown[] = [],
    ): Promise<{ insertId?: number; affectedRows?: number }> => {
        executed.push({ sql, params, kind: 'execute' });
        return { affectedRows: 1, insertId: 0 };
    };
    return { query, queryOne, execute, executed };
};

export interface UsersFixture {
    is_active: number;
    token_version: number;
    suspension_active: number;
    role?: string;
}

export interface RepositoryOptions {
    instructorAccounts?: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
    memberships?: Record<string, Array<{ tenant_id: string }>>;
    enrollments?: Record<string, Array<Record<string, unknown>>>;
}

export const makeRepository = (
    users: Record<string, UsersFixture>,
    opts: RepositoryOptions = {},
): PrincipalRepository => ({
    findUsersIdentity: async (id) => (users[id] ? { ...users[id] } : null),
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id) => opts.instructorAccounts?.[id] ?? null,
    findStudentEnrollments: async (id) => (opts.enrollments?.[id] ?? []) as never,
    findActiveTenantMemberships: async (id) =>
        (opts.memberships?.[id] ?? []) as never,
    findBranchSession: async () => null,
    isTenantOwner: async () => false,
});

export const tokenFor = (claims: Record<string, unknown>): string => jwt.sign(claims, TEST_SECRET);

/** Replicates only the authentication precondition of requireTeachingWrite. */
export const teachingWriteStandIn: RequestHandler = (req, res, next) => {
    if (!(req as AuthRequest).user) {
        (res as Response).status(401).json({ error: 'Authentication required' });
        return;
    }
    next();
};

export interface RouteRequest {
    method: string;
    url: string;
    token?: string | null;
    body?: unknown;
    query?: Record<string, string>;
}

export interface CapturedResponse {
    statusCode?: number;
    body?: unknown;
    headers?: Record<string, string>;
    status(code: number): CapturedResponse;
    json(payload: unknown): CapturedResponse;
    set(header: string, value: string): CapturedResponse;
}

/**
 * Invoke an Express router as a function with a minimal fake request/response.
 * Express does not await async handlers, so we poll (bounded) until the fake
 * response settles, matching the established M1 materials test pattern.
 */
export const invokeRoute = async (
    router: Router,
    request: RouteRequest,
): Promise<CapturedResponse> => {
    const headers: Record<string, string> = {};
    const response: CapturedResponse = {
        status(code: number) {
            response.statusCode = code;
            return response;
        },
        json(payload: unknown) {
            if (response.statusCode === undefined) response.statusCode = 200;
            response.body = payload;
            return response;
        },
        set(header: string, value: string) {
            headers[header.toLowerCase()] = value;
            response.headers = headers;
            return response;
        },
    };
    const req: any = {
        method: request.method,
        url: request.url,
        originalUrl: request.url,
        headers: request.token ? { authorization: `Bearer ${request.token}` } : {},
        body: request.body ?? {},
        query: request.query ?? {},
    };
    await (router as unknown as (r: unknown, s: unknown, n: NextFunction) => Promise<void>)(
        req,
        response,
        () => {},
    );
    const deadline = Date.now() + 5000;
    while (response.statusCode === undefined && response.body === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

export const findExecuted = (executed: ExecutedStatement[], fragment: string): ExecutedStatement | undefined =>
    executed.find((e) => e.sql.includes(fragment));

export const assertNoWrite = (executed: ExecutedStatement[]): void => {
    for (const statement of executed) {
        if (statement.kind === 'execute') {
            assert.ok(!/\bINSERT\b/i.test(statement.sql), `unexpected INSERT: ${statement.sql}`);
            assert.ok(!/\bUPDATE\b/i.test(statement.sql), `unexpected UPDATE: ${statement.sql}`);
            assert.ok(!/\bDELETE\b/i.test(statement.sql), `unexpected DELETE: ${statement.sql}`);
        }
    }
};
