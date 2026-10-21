/**
 * M8 Q3 — tenant-safe catalog/admin search.
 *
 * Pure, deterministic, clock-free core. The route layer composes it with the
 * verified principal and the server-resolved tenant authority; this module
 * never reads an HTTP request and never performs I/O.
 *
 * Tenant/permission model (deny by default, enforced IN SQL before any
 * candidate row is ever loaded):
 *  - Every generated statement pins `tenant_id = ?` to the server-derived
 *    tenant; a client-supplied tenant is never evidence of scope.
 *  - A student viewer sees only published content of courses she is enrolled
 *    in (an EXISTS check over student_courses/students evaluated inside the
 *    same SQL), published announcements for her own audience, and never the
 *    question bank. Unpublished/foreign titles are therefore impossible to
 *    leak because the rows are never loaded at all.
 *  - A staff viewer must be the verified tenant OWNER (owner-only title search,
 *    per S10 instructor content isolation) and sees all statuses of her own
 *    tenant only.
 *  - An optional branch refinement is validated INSIDE the SQL (the branch
 *    must exist, be active and belong to the same tenant); rows tied to other
 *    branches are dropped together with tenant-level rows remaining visible.
 *
 * Arabic query normalization is applied in JavaScript (bit-exact handling of
 * Unicode); the SQL-side visibility filters run BEFORE candidates are loaded,
 * and matching/ranking runs over those (already visible) candidates only.
 *
 * Candidate recall: the title filter is pushed into SQL as well. Every
 * normalized query token becomes an escaped `LIKE` predicate over a SQL
 * expression that mirrors `normalizeSearchText` (MySQL 8 `REGEXP_REPLACE` for
 * the diacritic ranges, `REPLACE` for the letter folds, `LOWER` for ASCII
 * case). The SQL predicate is a strict superset of the JavaScript normalized
 * substring match, so the candidate cap bounds *matching* rows instead of an
 * arbitrary unordered table prefix; JavaScript still decides the exact match
 * and score. Every candidate statement ends with `ORDER BY <id> ASC`, so the
 * capped window — and therefore pagination — is deterministic.
 *
 * Limitations: at most SEARCH_CANDIDATE_CAP matching rows are ranked, so a
 * broader search reports `truncated: true` and `total` is a lower bound, never
 * a global count. The prefilter scans the tenant-visible rows; a persisted
 * normalized-title column plus index is the proposed follow-up (see
 * docs/streams/server/SEARCH-RECALL-20261019.md).
 *
 * Hard caps: query length, query token count, page size, page number and
 * per-kind candidate loads are all bounded by exported constants.
 *
 * Token bound: every normalized query token adds its own `LIKE` predicate, so
 * character length alone does not bound statement amplification (100 single
 * letters separated by spaces would be 50 predicates). `SEARCH_QUERY_MAX_TOKENS`
 * bounds the predicate count. A query over the bound is REJECTED by
 * `validateSearchQuery` (400 at the route) and the SQL builders throw instead
 * of truncating: no token is ever silently dropped, because a dropped token
 * would silently widen the result set.
 */

export const SEARCH_QUERY_MAX_LENGTH = 100;
/**
 * Maximum number of whitespace-separated tokens in a normalized query. Each
 * token costs one `LIKE` predicate over the mirrored normalization expression;
 * 8 keeps the statement bounded while still covering multi-word titles.
 */
export const SEARCH_QUERY_MAX_TOKENS = 8;
export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_PAGE_DEFAULT = 10;
export const SEARCH_PAGE_SIZE_CAP = 25;
export const SEARCH_PAGE_MAX = 100;
export const SEARCH_CANDIDATE_CAP = 500;
/** Bounds the title-length tiebreak added to a hit score (keeps scores stable). */
export const SEARCH_HIT_TITLE_CAP = 255;
/** LIKE escape character; keeps `%`, `_` and the escape itself literal. */
export const SEARCH_LIKE_ESCAPE = '!';

const SEARCH_STAFF_KINDS = ['courses', 'lessons', 'announcements', 'question_bank'] as const;
const SEARCH_STUDENT_KINDS = ['courses', 'lessons', 'announcements'] as const;

export type SearchKind = (typeof SEARCH_STAFF_KINDS)[number];
export type StudentSearchKind = (typeof SEARCH_STUDENT_KINDS)[number];

const BRANCH_ID_MAX_LENGTH = 64;
const BRANCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Query normalization (Arabic-aware)
// ---------------------------------------------------------------------------

/**
 * Combining harakat, small letters, tatweel and superscript alef. The same
 * ranges feed the JavaScript regex and the SQL prefilter, so both sides strip
 * exactly the same characters.
 */
const ARABIC_DIACRITIC_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x0610, 0x061a],
    [0x064b, 0x0652],
    [0x0640, 0x0640],
    [0x0670, 0x0670],
    [0x06d6, 0x06ed],
];

/**
 * Canonical Arabic letter variants:
 *  - alef-Yaa/wasla variants (أ إ آ ٱ) -> bare alef (ا)
 *  - final yaa / alef maksura (ى) and yaa with hamza (ئ) -> dotted yaa (ي)
 *  - taa marbuta (ة) -> haa (ه)
 */
const ARABIC_ALEF_VARIANT_CHARS = ['\u0623', '\u0625', '\u0622', '\u0671'];
const ARABIC_YAA_VARIANT_CHARS = ['\u0649', '\u0626'];
const ARABIC_TAA_MARBUTA_CHARS = ['\u0629'];

const expandCodePointRanges = (ranges: ReadonlyArray<readonly [number, number]>): string[] => {
    const characters: string[] = [];
    for (const [start, end] of ranges) {
        for (let code = start; code <= end; code += 1) characters.push(String.fromCharCode(code));
    }
    return characters;
};

/** Escape the characters that are special inside a `[...]` class (JS and ICU). */
const escapeCharacterClass = (character: string): string =>
    character === '\\' || character === ']' || character === '^' || character === '-'
        ? `\\${character}`
        : character;

const characterClass = (characters: readonly string[]): string =>
    `[${characters.map(escapeCharacterClass).join('')}]`;

const ARABIC_DIACRITIC_CHARS = expandCodePointRanges(ARABIC_DIACRITIC_RANGES);
const ARABIC_DIACRITICS = new RegExp(characterClass(ARABIC_DIACRITIC_CHARS), 'g');
const ARABIC_ALEF_VARIANTS = new RegExp(characterClass(ARABIC_ALEF_VARIANT_CHARS), 'g');
const ARABIC_YAA_VARIANTS = new RegExp(characterClass(ARABIC_YAA_VARIANT_CHARS), 'g');
const ARABIC_TAA_MARBUTA = new RegExp(characterClass(ARABIC_TAA_MARBUTA_CHARS), 'g');

/**
 * Normalize a title/query into the canonical comparison form: Arabic
 * diacritics/tatweel stripped, alef/yaa/taa-marbuta variants folded, ASCII
 * case-folded, whitespace collapsed. Both the query AND every candidate
 * title go through this exact function before matching.
 */
export function normalizeSearchText(value: string): string {
    return value
        .replace(ARABIC_DIACRITICS, '')
        .replace(ARABIC_ALEF_VARIANTS, '\u0627')
        .replace(ARABIC_YAA_VARIANTS, '\u064A')
        .replace(ARABIC_TAA_MARBUTA, '\u0647')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Count the predicates a normalized query expands to: `appendTitlePrefilter`
 * splits on the single spaces `normalizeSearchText` leaves behind.
 */
export function countSearchTokens(normalizedQuery: string): number {
    return normalizedQuery.split(' ').filter((token) => token.length > 0).length;
}

export type SearchQueryValidation =
    | { ok: true; value: string }
    | { ok: false; error: string };

export function validateSearchQuery(raw: unknown): SearchQueryValidation {
    if (typeof raw !== 'string') return { ok: false, error: 'q must be a string' };
    const trimmed = raw.trim();
    if (trimmed.length < SEARCH_QUERY_MIN_LENGTH) {
        return { ok: false, error: `q must be at least ${SEARCH_QUERY_MIN_LENGTH} characters` };
    }
    if (trimmed.length > SEARCH_QUERY_MAX_LENGTH) {
        return { ok: false, error: `q must be at most ${SEARCH_QUERY_MAX_LENGTH} characters` };
    }
    if (countSearchTokens(normalizeSearchText(trimmed)) > SEARCH_QUERY_MAX_TOKENS) {
        return { ok: false, error: `q must contain at most ${SEARCH_QUERY_MAX_TOKENS} words` };
    }
    return { ok: true, value: trimmed };
}

export interface SearchPagination {
    page: number;
    limit: number;
}

export function parseSearchPagination(raw: Record<string, unknown>): SearchPagination | null {
    const pageRaw = raw['page'];
    const limitRaw = raw['limit'];
    if (pageRaw === undefined && limitRaw === undefined) {
        return { page: 1, limit: SEARCH_PAGE_DEFAULT };
    }
    const page = typeof pageRaw === 'string' && /^[0-9]+$/.test(pageRaw) ? Number(pageRaw) : pageRaw === undefined ? 1 : NaN;
    const limit = typeof limitRaw === 'string' && /^[0-9]+$/.test(limitRaw)
        ? Number(limitRaw)
        : limitRaw === undefined ? SEARCH_PAGE_DEFAULT : NaN;
    if (!Number.isInteger(page) || page < 1 || page > SEARCH_PAGE_MAX) return null;
    if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_PAGE_SIZE_CAP) return null;
    return { page, limit };
}

export type BranchFilterValidation =
    | { ok: true; value: string }
    | { ok: false; error: string };

export function validateBranchFilter(raw: unknown): BranchFilterValidation {
    if (typeof raw !== 'string') return { ok: false, error: 'branch_id must be a string' };
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > BRANCH_ID_MAX_LENGTH || !BRANCH_ID_PATTERN.test(trimmed)) {
        return { ok: false, error: 'branch_id is invalid' };
    }
    return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// SQL prefilter: the title match is evaluated by MySQL before the cap, so
// unrelated rows no longer consume the candidate budget.
// ---------------------------------------------------------------------------

/** Escape LIKE metacharacters so a token is matched as a literal substring. */
export const escapeLikeToken = (token: string): string =>
    token.replace(/[!%_]/g, (character) => `${SEARCH_LIKE_ESCAPE}${character}`);

const sqlReplaceAll = (expression: string, characters: readonly string[], replacement: string): string =>
    characters.reduce(
        (current, character) => `REPLACE(${current}, '${character}', '${replacement}')`,
        expression,
    );

/**
 * SQL mirror of `normalizeSearchText` for one column: MySQL 8 ICU regex strips
 * the same diacritic ranges, REPLACE folds the same letter variants and LOWER
 * case-folds ASCII. Internal whitespace is not collapsed here; the per-token
 * prefilter below does not depend on it.
 */
const normalizedTitleSql = (titleExpression: string): string =>
    `LOWER(${sqlReplaceAll(
        sqlReplaceAll(
            sqlReplaceAll(
                `REGEXP_REPLACE(${titleExpression}, '${characterClass(ARABIC_DIACRITIC_CHARS)}', '')`,
                ARABIC_ALEF_VARIANT_CHARS,
                '\u0627',
            ),
            ARABIC_YAA_VARIANT_CHARS,
            '\u064A',
        ),
        ARABIC_TAA_MARBUTA_CHARS,
        '\u0647',
    )})`;

/**
 * Append the title prefilter to a candidate statement. Every token of the
 * normalized query must appear in the SQL-normalized title; a normalized
 * substring match implies each of its tokens appears, so the predicate can
 * only widen the candidate set — JavaScript still applies the exact match and
 * score. Tokens are bound parameters and LIKE metacharacters are escaped, so
 * user input cannot alter the statement.
 */
const appendTitlePrefilter = (
    sql: string,
    params: unknown[],
    titleExpression: string,
    normalizedQuery: string,
): string => {
    const tokens = normalizedQuery.split(' ').filter((token) => token.length > 0);
    if (tokens.length > SEARCH_QUERY_MAX_TOKENS) {
        // Explicit, never silent: dropping a token would widen the result set
        // and truncating the query is forbidden by contract. The route rejects
        // this earlier with a 400; this guard protects direct builder callers.
        throw new RangeError(
            `normalized query has ${tokens.length} tokens; the bound is ${SEARCH_QUERY_MAX_TOKENS}`,
        );
    }
    if (tokens.length === 0) {
        // A query that normalizes to nothing can never match (matchScore
        // returns 0), so no candidate row needs to be loaded.
        return `${sql} AND 1 = 0`;
    }
    const normalizedTitle = normalizedTitleSql(titleExpression);
    let filtered = sql;
    for (const token of tokens) {
        params.push(`%${escapeLikeToken(token)}%`);
        filtered += ` AND ${normalizedTitle} LIKE ? ESCAPE '${SEARCH_LIKE_ESCAPE}'`;
    }
    return filtered;
};

// ---------------------------------------------------------------------------
// SQL builders. The tenant/branch/visibility/publication/enrollment gates are
// part of the WHERE clause, evaluated by MySQL BEFORE any row is handed to the
// application for ranking.
// ---------------------------------------------------------------------------

/** Branch refinement applied to announcements and the question bank. */
const BRANCH_SCOPE_FRAGMENT =
    ' AND (BRANCH_ALIAS.branch_id IS NULL OR BRANCH_ALIAS.branch_id = ?)' +
    ' AND EXISTS (SELECT 1 FROM branches br2 WHERE br2.id = ? AND br2.tenant_id = ? AND br2.status = \u0027active\u0027)';

const branchFragment = (alias: string, branchId: string): string =>
    BRANCH_SCOPE_FRAGMENT.replace(/BRANCH_ALIAS/g, alias);

/** Lessons share the branch refinement through lectures.group_id -> groups. */
const LESSON_BRANCH_FRAGMENT =
    ' AND (l.group_id IS NULL' +
    ' OR EXISTS (SELECT 1 FROM `groups` lg WHERE lg.id = l.group_id AND lg.branch_id IS NULL)' +
    ' OR EXISTS (SELECT 1 FROM `groups` lg2 INNER JOIN branches lb2 ON lb2.id = lg2.branch_id' +
    '     WHERE lg2.id = l.group_id AND lg2.branch_id = ? AND lb2.tenant_id = ? AND lb2.status = \u0027active\u0027))';

interface CandidateSource {
    /** SELECT projecting `entity_id`/`title` with the tenant gates pinned. */
    select: string;
    /** Expression projected as `title`; the SQL prefilter uses the same one. */
    title: string;
    /** Unique column that makes the capped candidate window deterministic. */
    id: string;
}

const STAFF_SOURCES: Record<SearchKind, CandidateSource> = {
    courses: {
        select: 'SELECT c.id AS entity_id, c.name AS title FROM courses c' +
            ' WHERE c.tenant_id = ? AND c.is_active = 1',
        title: 'c.name',
        id: 'c.id',
    },
    lessons: {
        select: 'SELECT l.id AS entity_id, l.title FROM lectures l' +
            ' INNER JOIN courses c ON c.id = l.course_id' +
            ' WHERE c.tenant_id = ? AND c.is_active = 1 AND l.archived_at IS NULL',
        title: 'l.title',
        id: 'l.id',
    },
    announcements: {
        select: 'SELECT a.id AS entity_id, a.title FROM announcements a' +
            ' WHERE a.tenant_id = ?',
        title: 'a.title',
        id: 'a.id',
    },
    question_bank: {
        select: 'SELECT qb.id AS entity_id, LEFT(qb.question_text, 120) AS title FROM question_bank_questions qb' +
            ' WHERE qb.tenant_id = ? AND qb.archived_at IS NULL',
        title: 'LEFT(qb.question_text, 120)',
        id: 'qb.id',
    },
};

export interface BuiltSearchQuery {
    sql: string;
    params: unknown[];
}

export interface StaffSearchQueryOptions {
    kind: SearchKind;
    tenantId: string;
    branchId: string | null;
    /** Query already folded by `normalizeSearchText`; never raw user input. */
    normalizedQuery: string;
}

/**
 * Tenant-owner (staff) candidate query. Never loads rows of another tenant;
 * retracted/draft rows stay visible to the owner inside their own tenant.
 */
export function buildStaffSearchQuery(opts: StaffSearchQueryOptions): BuiltSearchQuery {
    const source = STAFF_SOURCES[opts.kind];
    const params: unknown[] = [opts.tenantId];
    let sql = source.select;
    if (opts.branchId) {
        if (opts.kind === 'announcements' || opts.kind === 'question_bank') {
            const alias = opts.kind === 'announcements' ? 'a' : 'qb';
            sql += branchFragment(alias, opts.branchId);
            params.push(opts.branchId, opts.branchId, opts.tenantId);
        } else if (opts.kind === 'lessons') {
            sql += LESSON_BRANCH_FRAGMENT;
            params.push(opts.branchId, opts.tenantId);
        }
    }
    sql = appendTitlePrefilter(sql, params, source.title, opts.normalizedQuery);
    sql += ` ORDER BY ${source.id} ASC LIMIT ${SEARCH_CANDIDATE_CAP}`;
    return { sql, params };
}

/** Enrollment gate evaluated in SQL for every course-scoped student row. */
const STUDENT_ENROLLMENT_FRAGMENT =
    ' AND EXISTS (SELECT 1 FROM student_courses sc' +
    ' INNER JOIN students se ON se.id = sc.student_id' +
    ' WHERE sc.course_id = c.id AND sc.status = \u0027active\u0027' +
    ' AND se.user_id = ? AND se.tenant_id = ?' +
    ' AND se.is_active = 1 AND se.approval_status = \u0027approved\u0027' +
    ' AND (se.enrollment_status IS NULL OR se.enrollment_status = \u0027active\u0027)' +
    ' AND (se.enrollment_start_date IS NULL OR se.enrollment_start_date <= UTC_TIMESTAMP())' +
    ' AND (se.enrollment_end_date IS NULL OR se.enrollment_end_date > UTC_TIMESTAMP()))';

const STUDENT_SOURCES: Record<Exclude<StudentSearchKind, 'announcements'>, CandidateSource> = {
    courses: {
        select: 'SELECT c.id AS entity_id, c.name AS title FROM courses c' +
            ' WHERE c.tenant_id = ? AND c.is_active = 1' + STUDENT_ENROLLMENT_FRAGMENT,
        title: 'c.name',
        id: 'c.id',
    },
    lessons: {
        select: 'SELECT l.id AS entity_id, l.title FROM lectures l' +
            ' INNER JOIN courses c ON c.id = l.course_id' +
            ' WHERE c.tenant_id = ? AND c.is_active = 1 AND l.is_published = 1 AND l.archived_at IS NULL' +
            STUDENT_ENROLLMENT_FRAGMENT,
        title: 'l.title',
        id: 'l.id',
    },
};

export interface StudentAnnouncementQueryOptions {
    tenantId: string;
    studentBranchId: string | null;
    normalizedQuery: string;
}

/**
 * Student announcement candidate query. Announcements are audience-gated to
 * the server-resolved viewer branch; a viewer without a proven branch only
 * receives tenant-wide rows.
 */
export function buildStudentAnnouncementQuery(opts: StudentAnnouncementQueryOptions): BuiltSearchQuery {
    const params: unknown[] = [opts.tenantId];
    let sql = 'SELECT a.id AS entity_id, a.title FROM announcements a' +
        ' WHERE a.tenant_id = ? AND a.status = \u0027published\u0027';
    if (opts.studentBranchId) {
        sql += ' AND (a.audience = \u0027tenant\u0027 OR (a.audience = \u0027branch\u0027 AND a.branch_id = ?))';
        params.push(opts.studentBranchId);
    } else {
        sql += ' AND a.audience = \u0027tenant\u0027';
    }
    sql = appendTitlePrefilter(sql, params, 'a.title', opts.normalizedQuery);
    sql += ` ORDER BY a.id ASC LIMIT ${SEARCH_CANDIDATE_CAP}`;
    return { sql, params };
}

export interface StudentSearchQueryOptions {
    kind: Exclude<StudentSearchKind, 'announcements'>;
    tenantId: string;
    studentUserId: string;
    normalizedQuery: string;
}

/**
 * Student candidate query. Unpublished lessons and courses outside the
 * student's enrollment are filtered by MySQL, so their titles never leave the
 * database.
 */
export function buildStudentSearchQuery(opts: StudentSearchQueryOptions): BuiltSearchQuery {
    // Both course kinds share the same parameter order: tenant pin on the
    // course, then student id + tenant pin inside the enrollment EXISTS.
    const source = STUDENT_SOURCES[opts.kind];
    const params: unknown[] = [opts.tenantId, opts.studentUserId, opts.tenantId];
    const sql = appendTitlePrefilter(source.select, params, source.title, opts.normalizedQuery);
    return { sql: `${sql} ORDER BY ${source.id} ASC LIMIT ${SEARCH_CANDIDATE_CAP}`, params };
}

// ---------------------------------------------------------------------------
// Ranking over the (already visibility-filtered) candidates.
// ---------------------------------------------------------------------------

export interface SearchHit {
    kind: SearchKind | StudentSearchKind;
    id: string;
    title: string;
    score: number;
}

export interface CandidateRow {
    entity_id?: unknown;
    title?: unknown;
}

/** 3 = normalized equality, 2 = prefix, 1 = substring. Non-matching = 0. */
export const matchScore = (title: string, query: string): number => {
    const normalized = normalizeSearchText(title);
    const normalizedQuery = normalizeSearchText(query);
    if (!normalized || !normalizedQuery) return 0;
    if (normalized === normalizedQuery) return 3;
    if (normalized.startsWith(normalizedQuery)) return 2;
    if (normalized.includes(normalizedQuery)) return 1;
    return 0;
};

export function toSearchHits<T extends CandidateRow>(
    kind: SearchKind | StudentSearchKind,
    rows: readonly T[],
    normalizedQuery: string,
    hitTitleLimit: number,
): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const row of rows) {
        const id = typeof row.entity_id === 'string' ? row.entity_id : null;
        const title = typeof row.title === 'string' ? row.title : null;
        if (!id || title === null) continue;
        const score = matchScore(title, normalizedQuery);
        if (score === 0) continue;
        hits.push({ kind, id, title, score: score * 1000 + Math.min(title.length, hitTitleLimit) });
    }
    return hits;
}

export interface SearchPage {
    results: SearchHit[];
    /**
     * Ranked hits inside the candidate cap. When `truncated` is true this is a
     * lower bound of the real match count, never a global total.
     */
    total: number;
    page: number;
    limit: number;
    /** True when the candidate cap was reached and more matches may exist. */
    truncated: boolean;
}

/** Code-point comparison: stable across locales, unlike localeCompare. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byRank = (a: SearchHit, b: SearchHit): number => {
    if (a.score !== b.score) return b.score - a.score;
    const byTitle = compareText(a.title, b.title);
    return byTitle !== 0 ? byTitle : compareText(a.id, b.id);
};

export function paginateHits(
    hits: readonly SearchHit[],
    pagination: SearchPagination,
    truncated = false,
): SearchPage {
    const sorted = [...hits].sort(byRank);
    const start = (pagination.page - 1) * pagination.limit;
    return {
        results: sorted.slice(start, start + pagination.limit),
        total: sorted.length,
        page: pagination.page,
        limit: pagination.limit,
        truncated,
    };
}
