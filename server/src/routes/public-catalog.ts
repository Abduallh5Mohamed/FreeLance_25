/**
 * M2-22 — anonymous, read-only published-course discovery.
 *
 * A SEPARATE router (mounted at `/api/public` in `src/index.ts`) so the private
 * course surface is never widened by this batch: `src/routes/courses.ts` keeps
 * its own mounts, its own scope and its own authority, and this module cannot
 * reach a private column by accident because it never shares a statement with
 * it.
 *
 * What it serves:
 *   * `GET /courses?q&limit&cursor` — one bounded page of PUBLISHED, ACTIVE
 *     courses across the platform, keyset-ordered by course id;
 *   * `GET /courses/:courseId` — the same fixed projection for exactly one
 *     published, active course.
 *
 * What it is not:
 *   * it is not an access grant. Nothing here enrolls a student, admits a
 *     caller to a course, or exposes a lesson, unit, material, file, video,
 *     exam, group, student, instructor, contact, price, payment, subscription,
 *     membership count or internal status. Publication is a DISCOVERY flag;
 *   * it is not a private read. The projection is FIXED and assembled column by
 *     column — no row is ever spread, so a future column cannot leak by
 *     default;
 *   * it does not schedule anything. There is no publish-at, expiry, delivery
 *     window or timezone policy: `published_at` is not even projected here.
 *
 * Authority is the ABSENCE of it: every statement pins
 * `c.publication_state='published' AND c.is_active=TRUE` AND an `active`
 * tenant. A draft, an archived course, a suspended or archived academy and a
 * course of a non-existent tenant are all the SAME 404 with the same body, so
 * the endpoint cannot be used to probe which unpublished courses exist.
 *
 * The principal, if one is presented, is deliberately IGNORED: a signed-in
 * caller sees byte-identical results to an anonymous one, so no private field
 * can appear merely because the caller happened to be authenticated.
 */
import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db';

const router = Router();

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const PUBLIC_PAGE_DEFAULT = 24;
const PUBLIC_PAGE_MAX = 60;

/** A search term is bounded so no page can be widened into a full table scan. */
const SEARCH_TERM_MAX = 100;

/**
 * The fixed TEN-field public projection.
 *
 * `description` is bounded to 600 characters by the STATEMENT, so the bound
 * holds even if a row was written before this batch by a path that stored a
 * longer TEXT value. The two branding labels and the accent colour are the
 * already-accepted M2-B06 fields, unchanged and NOT re-interpreted: a NULL
 * label still means "inherit the existing presentation".
 *
 * `c.tenant_id` is deliberately NOT selected: the tenant identity exposed here
 * is `t.id` from the JOIN, so a course row whose `tenant_id` does not resolve to
 * an active tenant can never contribute a tenant id.
 */
const PUBLIC_COURSE_PROJECTION =
    'c.id AS course_id,c.name,c.subject,SUBSTRING(c.description,1,600) AS description,c.grade,' +
    't.id AS tenant_id,t.business_name,b.display_name_ar,b.display_name_en,b.accent_color';

const PUBLIC_COURSE_FROM =
    ' FROM courses c' +
    " JOIN tenants t ON t.id=c.tenant_id AND t.status='active'" +
    ' LEFT JOIN tenant_branding b ON b.tenant_id=t.id';

const PUBLIC_COURSE_FILTER = " WHERE c.publication_state='published' AND c.is_active=TRUE";

const PUBLIC_LIST_SQL =
    `SELECT ${PUBLIC_COURSE_PROJECTION}${PUBLIC_COURSE_FROM}${PUBLIC_COURSE_FILTER}` +
    " AND (c.name LIKE ? ESCAPE '!' OR COALESCE(c.subject,'') LIKE ? ESCAPE '!')" +
    ' AND c.id>? ORDER BY c.id ASC LIMIT ?';

const PUBLIC_LIST_SQL_UNSEARCHED =
    `SELECT ${PUBLIC_COURSE_PROJECTION}${PUBLIC_COURSE_FROM}${PUBLIC_COURSE_FILTER}` +
    ' AND c.id>? ORDER BY c.id ASC LIMIT ?';

const PUBLIC_DETAIL_SQL =
    `SELECT ${PUBLIC_COURSE_PROJECTION}${PUBLIC_COURSE_FROM}${PUBLIC_COURSE_FILTER}` +
    ' AND c.id=? LIMIT 1';

/** `null` stays `null`; anything else is the stored string. No coercion. */
const nullableString = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);

/**
 * The fixed TEN-field public DTO.
 *
 * `accent_color` is re-checked against the accepted canonical form: a value
 * that is not `#RRGGBB` uppercase is reported as `null` ("inherit") rather than
 * handed to the page as a color it would render verbatim.
 */
const ACCENT_CANONICAL_PATTERN = /^#[0-9A-F]{6}$/;

const publicCourseDto = (row: any) => {
    const accent = nullableString(row.accent_color);
    return {
        course_id: String(row.course_id),
        name: String(row.name),
        subject: nullableString(row.subject),
        description: nullableString(row.description),
        grade: nullableString(row.grade),
        tenant_id: String(row.tenant_id),
        business_name: String(row.business_name),
        display_name_ar: nullableString(row.display_name_ar),
        display_name_en: nullableString(row.display_name_en),
        accent_color: accent !== null && ACCENT_CANONICAL_PATTERN.test(accent) ? accent : null,
    };
};

/** Opaque page position. It encodes a POSITION (the last course id), never authority. */
const encodeCursor = (id: string): string =>
    Buffer.from(id, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const decodeCursor = (raw: unknown): string | null => {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
    try {
        const id = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return UUID_PATTERN.test(id) ? id : null;
    } catch {
        return null;
    }
};

/** The bounded page size: 1..60, default 24. Anything else is a 400. */
const parseLimit = (raw: unknown): number | null => {
    if (raw === undefined) return PUBLIC_PAGE_DEFAULT;
    if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) return null;
    const limit = Number(raw);
    if (limit < 1 || limit > PUBLIC_PAGE_MAX) return null;
    return limit;
};

/**
 * The optional search term: trimmed, 1..100 characters.
 *
 * An EMPTY or whitespace-only term is the same as no term (the unfiltered
 * bounded page), because "search for nothing" is not a different query. A
 * non-string or an over-long term is a 400 rather than a silently truncated
 * search.
 */
const parseSearchTerm = (raw: unknown): { ok: true; term: string | null } | { ok: false } => {
    if (raw === undefined) return { ok: true, term: null };
    if (typeof raw !== 'string') return { ok: false };
    const term = raw.trim();
    if (term.length === 0) return { ok: true, term: null };
    if (term.length > SEARCH_TERM_MAX) return { ok: false };
    return { ok: true, term };
};

/**
 * Escapes the LIKE metacharacters with `!` so a caller searching for `100%` or
 * `a_b` matches those literal characters instead of becoming a wildcard that
 * widens the scan.
 */
const escapeLikeTerm = (term: string): string => term.replace(/[!%_]/g, (character) => `!${character}`);

/**
 * `GET /api/public/courses`
 *
 * Anonymous. No credential is required and none is consulted.
 */
router.get('/courses', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');

    const limit = parseLimit(req.query?.limit);
    if (limit === null) return res.status(400).json({ error: 'Invalid public course list limit' });

    const rawCursor = req.query?.cursor;
    const cursorId = rawCursor === undefined ? '' : decodeCursor(rawCursor);
    if (cursorId === null) return res.status(400).json({ error: 'Invalid public course list cursor' });

    const search = parseSearchTerm(req.query?.q);
    if (!search.ok) return res.status(400).json({ error: 'Invalid public course search term' });

    try {
        const rows = search.term === null
            ? await query<any>(PUBLIC_LIST_SQL_UNSEARCHED, [cursorId, limit + 1])
            : await query<any>(PUBLIC_LIST_SQL, [
                `%${escapeLikeTerm(search.term)}%`,
                `%${escapeLikeTerm(search.term)}%`,
                cursorId,
                limit + 1,
            ]);

        const page = rows ?? [];
        const hasMore = page.length > limit;
        const visible = hasMore ? page.slice(0, limit) : page;
        return res.json({
            courses: visible.map(publicCourseDto),
            next_cursor: hasMore && visible.length > 0
                ? encodeCursor(String(visible[visible.length - 1].course_id))
                : null,
        });
    } catch (error) {
        console.error('Public course list error:', error);
        return res.status(500).json({ error: 'Failed to load public courses' });
    }
});

/**
 * `GET /api/public/courses/:courseId`
 *
 * Anonymous. A malformed id, a draft, an archived course, a course of a
 * suspended academy and an absent course are all the SAME 404 body.
 */
router.get('/courses/:courseId', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');

    const courseId = String(req.params?.courseId ?? '');
    if (!UUID_PATTERN.test(courseId)) return res.status(404).json({ error: 'Course not found' });

    try {
        const row = await queryOne<any>(PUBLIC_DETAIL_SQL, [courseId]);
        if (!row) return res.status(404).json({ error: 'Course not found' });
        return res.json({ course: publicCourseDto(row) });
    } catch (error) {
        console.error('Public course detail error:', error);
        return res.status(500).json({ error: 'Failed to load public course' });
    }
});

export default router;
