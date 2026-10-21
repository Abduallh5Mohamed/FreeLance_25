/**
 * M8 Q3 — tenant-safe search routes.
 *
 * Audience + permission model (deny by default):
 *  - Every path requires authentication and a server-derived tenant; a
 *    client-supplied tenant/branch is never evidence of scope.
 *  - A student viewer (role 'student') searches ONLY her own tenant through
 *    buildStudent* queries: published courses she is enrolled in, published
 *    lessons of those courses, and published announcements in her audience.
 *    The question bank is never offered to a student (403).
 *  - A staff viewer must be the verified tenant OWNER (owner-only title
 *    search, per S10 instructor content isolation) and may search every
 *    status of her own tenant, including the question bank.
 *  - All tenant/visibility/publication/enrollment/branch gates live in the
 *    generated SQL (server/src/services/search.ts) and are applied by MySQL
 *    BEFORE any candidate row is loaded for ranking, so unpublished or
 *    foreign titles cannot leak. The normalized title filter is also applied
 *    in SQL, so the candidate cap bounds matching rows and the deterministic
 *    `ORDER BY <id>` keeps the capped window (and pagination) stable.
 *    Ranking/pagination then run over the already-visible candidates only,
 *    under hard caps; a capped result set is reported as `truncated: true`
 *    instead of presenting `total` as a global count.
 *  - Query length, page number and page size are capped; the branch filter
 *    is pattern-validated. Invalid input is 400, unexpected failures 500.
 *
 * This module exports `createSearchRouter(deps)`; it is intentionally not
 * mounted anywhere by this task. The production student resolver is exported
 * as `createStudentViewerResolver(db)` so tests drive the REAL resolver over an
 * injected data-access layer instead of a mirrored fake. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
    SEARCH_CANDIDATE_CAP,
    SEARCH_HIT_TITLE_CAP,
    buildStaffSearchQuery,
    buildStudentAnnouncementQuery,
    buildStudentSearchQuery,
    normalizeSearchText,
    paginateHits,
    parseSearchPagination,
    toSearchHits,
    validateBranchFilter,
    validateSearchQuery,
} from '../services/search';
import type { CandidateRow, SearchKind, StudentSearchKind } from '../services/search';

export interface SearchDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface SearchDeps {
    db: SearchDataAccess;
    authenticate: RequestHandler;
    /** Server-owned active authority of the principal inside the selected tenant. */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /**
     * Server-resolved student workspace: the active, approved enrollment of
     * the principal plus the branch proven through her group (or null).
     */
    resolveStudentViewer: (userId: string, tenantId: string) => Promise<StudentViewer | null>;
}

export interface StudentViewer {
    /**
     * `users.id` of the enrolled student. The service filters `se.user_id`, so
     * this must be the user identity — never the `students.id` row id.
     */
    studentUserId: string;
    branchId: string | null;
}

const STAFF_KINDS = new Set<string>(['courses', 'lessons', 'announcements', 'question_bank']);
const STUDENT_KINDS = new Set<string>(['courses', 'lessons', 'announcements']);
const DEFAULT_KIND = 'courses';

const isSearchKind = (kind: string): kind is SearchKind => STAFF_KINDS.has(kind);
const isStudentSearchKind = (kind: string): kind is StudentSearchKind => STUDENT_KINDS.has(kind);

export const createSearchRouter = (deps: SearchDeps): Router => {
    const router = Router();
    const { db } = deps;

    router.use(deps.authenticate);

    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) {
                res.status(401).json({ error: 'Authentication required' });
                return;
            }
            const tenantId = user.tenantId;
            if (!tenantId) {
                res.status(403).json({ error: 'An active tenant workspace is required' });
                return;
            }
            const query = validateSearchQuery(req.query.q);
            if (!query.ok) return res.status(400).json({ error: query.error });
            const pagination = parseSearchPagination(req.query as Record<string, unknown>);
            if (!pagination) return res.status(400).json({ error: 'Invalid pagination' });
            const rawKind = req.query.kind;
            const kind = rawKind === undefined ? DEFAULT_KIND : rawKind;
            if (typeof kind !== 'string' || (!isSearchKind(kind) && !isStudentSearchKind(kind))) {
                return res.status(400).json({ error: 'Invalid search kind' });
            }
            let branchId: string | null = null;
            if (req.query.branch_id !== undefined) {
                const branch = validateBranchFilter(req.query.branch_id);
                if (!branch.ok) return res.status(400).json({ error: branch.error });
                branchId = branch.value;
            }
            const normalizedQuery = normalizeSearchText(query.value);

            if (user.role === 'student') {
                if (!isStudentSearchKind(kind)) {
                    return res.status(403).json({ error: 'Students cannot search the question bank' });
                }
                const viewer = await deps.resolveStudentViewer(user.id, tenantId);
                if (!viewer) {
                    return res.status(404).json({ error: 'Student workspace not found' });
                }
                const built = kind === 'announcements'
                    ? buildStudentAnnouncementQuery({
                        tenantId,
                        studentBranchId: viewer.branchId,
                        normalizedQuery,
                    })
                    : buildStudentSearchQuery({
                        kind,
                        tenantId,
                        studentUserId: viewer.studentUserId,
                        normalizedQuery,
                    });
                const rows = await db.query<CandidateRow>(built.sql, built.params);
                const hits = toSearchHits(kind, rows, normalizedQuery, SEARCH_HIT_TITLE_CAP);
                return res.json(paginateHits(hits, pagination, rows.length >= SEARCH_CANDIDATE_CAP));
            }

            const authority = await deps.loadActiveTenantAuthority(user.id, tenantId);
            if (!authority || authority.authority !== 'owner') {
                return res.status(403).json({ error: 'Tenant owner authority required' });
            }
            if (!isSearchKind(kind)) {
                return res.status(400).json({ error: 'Invalid search kind' });
            }
            const built = buildStaffSearchQuery({ kind, tenantId, branchId, normalizedQuery });
            const rows = await db.query<CandidateRow>(built.sql, built.params);
            const hits = toSearchHits(kind, rows, normalizedQuery, SEARCH_HIT_TITLE_CAP);
            res.json(paginateHits(hits, pagination, rows.length >= SEARCH_CANDIDATE_CAP));
        } catch (error) {
            console.error('Search error:', error);
            res.status(500).json({ error: 'Failed to run the search' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real tenant authority. */

const TENANT_AUTHORITY_SQL = `
    SELECT 'owner' AS authority
    FROM tenants t
    WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
    UNION ALL
    SELECT m.role_key AS authority
    FROM tenant_memberships m
    INNER JOIN tenants t ON t.id = m.tenant_id
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
      AND t.status = 'active' AND u.is_active = 1
      AND m.role_key IN ('owner','instructor')
    LIMIT 1
`;

/**
 * Resolve the student's workspace from the server-side enrollment row.
 *
 * `students.id` is the enrollment-row primary key; `students.user_id` is the
 * `users.id` foreign key. The service filters `se.user_id`, so the projected
 * and returned identity must be `s.user_id`: selecting `s.id` bound the row id
 * into `se.user_id = ?` and silently matched zero rows whenever the two ids
 * differed.
 */
const STUDENT_VIEWER_SQL = `
    SELECT s.user_id, s.tenant_id, grp.branch_id, grp.branch_scope
    FROM students s LEFT JOIN \`groups\` grp ON grp.id = s.group_id
    WHERE s.user_id=? AND s.tenant_id=? AND s.is_active=1 AND s.approval_status='approved'
      AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
      AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
      AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
    LIMIT 1
`;

interface StudentViewerRow {
    user_id: string;
    tenant_id: string;
    branch_id: string | null;
    branch_scope: string | null;
}

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: SearchDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
};

/**
 * Build the production student-viewer resolver over an injected data-access
 * layer. Tests drive THIS function with the real service; production passes
 * the pool-backed adapter. `grp` still supplies the branch refinement.
 */
export const createStudentViewerResolver = (db: SearchDataAccess) =>
    async (userId: string, tenantId: string): Promise<StudentViewer | null> => {
        const row = await db.queryOne<StudentViewerRow>(STUDENT_VIEWER_SQL, [userId, tenantId]);
        if (!row) return null;
        return {
            studentUserId: row.user_id,
            branchId: row.branch_scope === 'branch' ? row.branch_id : null,
        };
    };

export default createSearchRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    resolveStudentViewer: createStudentViewerResolver(productionDb),
});
