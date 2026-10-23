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
 *  - Selectors are never accepted unless the server applies them: `branch_id`
 *    is rejected for `kind=courses` (no branch column in its candidate
 *    statement) and for a student viewer (whose branch is derived from her
 *    enrollment). A student whose active enrollments resolve to different
 *    branch scopes is denied instead of being assigned to the first one.
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
    supportsBranchFilter,
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

/**
 * The student's active enrollment resolved to more than one branch scope.
 *
 * A student may hold several active enrollment rows (one per group, or a
 * tenant-wide row plus a branch row). There is no "first" enrollment that is
 * more true than the others, so picking one would scope the announcement
 * search to an arbitrary branch: a branch-B announcement could be served to a
 * branch-A viewer, or hidden from a viewer who belongs to both. Ambiguity is a
 * denial, never a first-row selection.
 */
export class StudentScopeAmbiguousError extends Error {
    readonly code = 'student_scope_ambiguous';
    constructor() {
        super('The student workspace resolves to more than one branch scope');
    }
}

/**
 * Log a stable label plus the driver's error code, never the raw error.
 *
 * A MySQL driver error carries `sql`, `sqlMessage` and the bound parameters of
 * the failing statement, so logging the object writes the caller's search terms
 * and tenant identifiers into the server log. The HTTP response is a fixed
 * string for the same reason: an unexpected failure is reported as a failure,
 * not as a description of the query.
 */
const logSearchFailure = (label: string, error: unknown): void => {
    const code = typeof error === 'object' && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    console.error(label, typeof code === 'string' ? code : 'unclassified');
};

export const createSearchRouter = (deps: SearchDeps): Router => {
    const router = Router();
    const { db } = deps;

    router.use(deps.authenticate);
    // Per-principal payloads that may name unpublished or tenant-private
    // titles: no shared or browser cache may retain them, on any status code.
    router.use((_req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

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
                if (branchId !== null) {
                    // The viewer's branch is server-derived from her enrollment
                    // row. Accepting a client branch here would mean answering
                    // with a filter the server never applied.
                    return res.status(400).json({ error: 'branch_id is not a client selector for student search' });
                }
                let viewer: StudentViewer | null;
                try {
                    viewer = await deps.resolveStudentViewer(user.id, tenantId);
                } catch (error) {
                    if (error instanceof StudentScopeAmbiguousError) {
                        return res.status(403).json({ error: 'The student workspace resolves to more than one branch scope' });
                    }
                    throw error;
                }
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
            if (branchId !== null && !supportsBranchFilter(kind)) {
                // `courses` carries no branch refinement in its candidate
                // statement. Silently ignoring the selector would return
                // tenant-wide rows to a caller that asked for one branch.
                return res.status(400).json({ error: 'branch_id is not supported for this search kind' });
            }
            const built = buildStaffSearchQuery({ kind, tenantId, branchId, normalizedQuery });
            const rows = await db.query<CandidateRow>(built.sql, built.params);
            const hits = toSearchHits(kind, rows, normalizedQuery, SEARCH_HIT_TITLE_CAP);
            res.json(paginateHits(hits, pagination, rows.length >= SEARCH_CANDIDATE_CAP));
        } catch (error) {
            logSearchFailure('Search error:', error);
            res.status(500).json({ error: 'Failed to run the search' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real tenant authority. */

/**
 * Resolve the principal's authority inside the selected tenant.
 *
 * `UNION ALL ... LIMIT 1` without an ORDER BY returns whichever row MySQL
 * happens to produce first, so an owner who also holds an `instructor`
 * membership row could be denied as "instructor" on one request and admitted as
 * "owner" on the next. The outer ORDER BY makes the strongest authority win
 * deterministically; it can only ever raise the answer to `owner`, never widen
 * it beyond the two roles the WHERE clause already admits.
 */
const TENANT_AUTHORITY_SQL = `
    SELECT authority FROM (
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
    ) AS authority_rows
    ORDER BY (authority = 'owner') DESC
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
 *
 * The query deliberately returns up to TWO DISTINCT scope rows instead of one.
 * A student can hold more than one active enrollment (per group, or a
 * tenant-wide row plus a branch row); `LIMIT 1` would then hand the caller an
 * arbitrary branch scope. Two distinct rows are a denial, not a choice.
 */
const STUDENT_VIEWER_SQL = `
    SELECT DISTINCT s.user_id, s.tenant_id, grp.branch_id, grp.branch_scope
    FROM students s LEFT JOIN \`groups\` grp ON grp.id = s.group_id
    WHERE s.user_id=? AND s.tenant_id=? AND s.is_active=1 AND s.approval_status='approved'
      AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
      AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
      AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
    ORDER BY grp.branch_scope, grp.branch_id
    LIMIT 2
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
 *
 * Returns `null` when the principal has no active approved enrollment inside
 * the selected tenant, and throws `StudentScopeAmbiguousError` when the
 * enrollments disagree about the branch scope. There is no tie-break: a
 * branch-A viewer must never receive branch-B announcements because her
 * enrollment rows happened to be read in a particular order.
 */
export const createStudentViewerResolver = (db: SearchDataAccess) =>
    async (userId: string, tenantId: string): Promise<StudentViewer | null> => {
        const rows = await db.query<StudentViewerRow>(STUDENT_VIEWER_SQL, [userId, tenantId]);
        if (rows.length === 0) return null;
        if (rows.length > 1) throw new StudentScopeAmbiguousError();
        const row = rows[0];
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
