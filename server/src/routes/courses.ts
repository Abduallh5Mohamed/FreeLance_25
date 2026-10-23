import { Router, RequestHandler, Response } from 'express';
import { query, queryOne, execute, getPool } from '../db';
import { randomUUID } from 'crypto';
import type { PoolConnection } from 'mysql2/promise';
import { AuthRequest, optionalAuth } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import { isSuperAdmin } from '../security/admin-permissions';
import { recordAudit, snapshotRow } from '../security/audit';

export interface CoursesRouteDependencies {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
    optionalAuth: RequestHandler;
    requireTeachingWrite: typeof requireTeachingWrite;
    isSuperAdmin: typeof isSuperAdmin;
}

const defaultDependencies: CoursesRouteDependencies = {
    query, queryOne, execute, optionalAuth, requireTeachingWrite, isSuperAdmin,
};

export interface CourseCaller {
    id?: string;
    role?: string;
    tenantId?: string | null;
    studentEnrollmentId?: string;
}

export type CourseScopeResult =
    | { clause: string; params: string[] }
    | { denied: true };

export const isDeniedCourseScope = (scope: CourseScopeResult): scope is { denied: true } =>
    'denied' in scope;

const MAX_COURSE_LIMIT = 100;
const DEFAULT_COURSE_LIMIT = 50;

/** Parse `limit`/`offset` (or `page`/`pageSize`) with hard caps. Never throws. */
export function parseCoursePagination(input: unknown): { limit: number; offset: number } {
    const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const toInt = (value: unknown): number | null => {
        if (typeof value === 'number' && Number.isInteger(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            if (Number.isInteger(parsed)) return parsed;
        }
        return null;
    };
    let limit = toInt(record['limit'] ?? record['pageSize']) ?? DEFAULT_COURSE_LIMIT;
    if (limit < 1) limit = 1;
    if (limit > MAX_COURSE_LIMIT) limit = MAX_COURSE_LIMIT;
    const page = toInt(record['page']);
    const rawOffset = toInt(record['offset']);
    let offset: number;
    if (page !== null && page >= 1) {
        offset = (page - 1) * limit;
    } else {
        offset = rawOffset ?? 0;
    }
    if (offset < 0) offset = 0;
    if (offset > 100000) offset = 100000;
    return { limit, offset };
}

export interface ValidCourseInput {
    name: string;
    subject: string | null;
    description: string | null;
    grade: string | null;
    price: number;
}

type CourseValidation = { ok: true; value: ValidCourseInput } | { ok: false; error: string };

const toTrimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function validatePrice(input: unknown): number | null {
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string' && input.trim() !== '') {
        const parsed = Number(input);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

/** Shared create/update validation. `requireSubject` keeps PUT semantics strict. */
export function validateCourseInput(body: unknown, requireSubject: boolean): CourseValidation {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const name = toTrimmed(record['name']);
    const subjectRaw = toTrimmed(record['subject']);
    if (!name || name.length > 255) {
        return { ok: false, error: 'Course name is required (1-255 characters)' };
    }
    if ((requireSubject && !subjectRaw) || subjectRaw.length > 100) {
        return { ok: false, error: 'Valid course name and subject are required' };
    }
    const descriptionRaw = typeof record['description'] === 'string' ? record['description'].trim() : '';
    if (descriptionRaw.length > 5000) {
        return { ok: false, error: 'Description must be at most 5000 characters' };
    }
    const gradeRaw = toTrimmed(record['grade']);
    if (gradeRaw.length > 100) {
        return { ok: false, error: 'Grade must be at most 100 characters' };
    }
    const priceInput = record['price'] ?? 0;
    const price = validatePrice(priceInput);
    if (price === null || price < 0 || price > 1000000) {
        return { ok: false, error: 'Price must be a number between 0 and 1000000' };
    }
    return {
        ok: true,
        value: {
            name,
            subject: subjectRaw || null,
            description: descriptionRaw || null,
            grade: gradeRaw || null,
            price,
        },
    };
}

/**
 * Tenant scope resolved only from the server-derived principal.
 * - tenant member -> exactly that tenant (deny cross-tenant by construction)
 * - anonymous -> ownerless rows only (public discovery projection)
 * - authenticated principal without a tenant -> denied; platform-wide reads
 *   require a separately verified super-admin record.
 */
export function resolveCourseScope(user: CourseCaller | undefined): CourseScopeResult {
    if (!user) return { clause: ' AND tenant_id IS NULL', params: [] };
    if (typeof user.tenantId === 'string' && user.tenantId.length > 0) {
        return { clause: ' AND tenant_id=?', params: [user.tenantId] };
    }
    return { denied: true };
}

const managementPredicate = (courseAlias: string): string => `
    AND (
        EXISTS (
            SELECT 1 FROM tenant_memberships course_membership
            INNER JOIN tenants course_tenant ON course_tenant.id=course_membership.tenant_id
            INNER JOIN users course_user ON course_user.id=course_membership.user_id
            WHERE course_membership.user_id=? AND course_membership.tenant_id=${courseAlias}.tenant_id
              AND course_membership.status='active' AND course_tenant.status='active' AND course_user.is_active=1
              AND (course_membership.role_key='owner'
                   OR (course_membership.role_key='instructor' AND ${courseAlias}.instructor_id=?))
        )
        OR EXISTS (
            SELECT 1 FROM tenants course_owner_tenant
            INNER JOIN users course_owner ON course_owner.id=course_owner_tenant.owner_user_id AND course_owner.is_active=1
            WHERE course_owner_tenant.id=${courseAlias}.tenant_id
              AND course_owner_tenant.owner_user_id=? AND course_owner_tenant.status='active'
        )
    )`;

export function resolveCourseManagementScope(user: CourseCaller | undefined): CourseScopeResult {
    if (!user?.id || typeof user.tenantId !== 'string' || user.tenantId.length === 0) return { denied: true };
    return {
        clause: ` AND courses.tenant_id=?${managementPredicate('courses')}`,
        params: [user.tenantId, user.id, user.id, user.id],
    };
}

async function resolveStudentCourseScope(
    user: CourseCaller,
    dependencies: CoursesRouteDependencies,
): Promise<CourseScopeResult> {
    if (!user.id || !user.tenantId || !user.studentEnrollmentId) return { denied: true };
    const enrollment = await dependencies.queryOne(
        `SELECT s.id FROM students s
         INNER JOIN tenants t ON t.id=s.tenant_id AND t.status='active'
         INNER JOIN users u ON u.id=s.user_id AND u.is_active=1
         WHERE s.id=? AND s.user_id=? AND s.tenant_id=? AND s.is_active=1
           AND s.approval_status='approved' LIMIT 1`,
        [user.studentEnrollmentId, user.id, user.tenantId]
    );
    return enrollment
        ? { clause: ' AND courses.tenant_id=?', params: [user.tenantId] }
        : { denied: true };
}

function createCourseWriteGuard(dependencies: CoursesRouteDependencies): RequestHandler {
    const membershipGuard = dependencies.requireTeachingWrite('courses');
    return async (req: AuthRequest, res: Response, next) => {
        const user = req.user;
        if (!user || user.role !== 'instructor' || !user.tenantId || user.billingOnly) {
            await Promise.resolve(membershipGuard(req, res, next));
            return;
        }
        try {
            const owner = await dependencies.queryOne(
                `SELECT t.id FROM tenants t
                 INNER JOIN users u ON u.id=t.owner_user_id AND u.is_active=1
                 WHERE t.id=? AND t.owner_user_id=? AND t.status='active'
                   AND (t.legacy_compat=1 OR EXISTS (
                        SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id=t.id
                          AND s.status IN ('active','grace_period','past_due')
                          AND s.starts_at<=UTC_TIMESTAMP()
                          AND DATE_ADD(s.period_ends_at,INTERVAL 4 DAY)>UTC_TIMESTAMP()
                   )) LIMIT 1`,
                [user.tenantId, user.id]
            );
            if (owner) {
                next();
                return;
            }
            await Promise.resolve(membershipGuard(req, res, next));
        } catch (error: unknown) {
            console.error('Course owner authorization failed:', error);
            res.status(503).json({ error: 'Teaching access unavailable' });
        }
    };
}

async function resolveCourseReadScope(
    user: CourseCaller | undefined,
    dependencies: CoursesRouteDependencies,
): Promise<CourseScopeResult> {
    if (!user) return resolveCourseScope(user);
    if (user.role === 'admin' && user.id && await dependencies.isSuperAdmin(user.id)) {
        return { clause: '', params: [] };
    }
    if (user.role === 'student') return resolveStudentCourseScope(user, dependencies);
    return resolveCourseManagementScope(user);
}

export function createCoursesRouter(dependencies: CoursesRouteDependencies = defaultDependencies) {
    const router = Router();
    router.use(dependencies.optionalAuth);

    // Get courses visible inside the current caller's teaching space.
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveCourseReadScope(req.user, dependencies);
            if (isDeniedCourseScope(scope)) {
                return res.status(403).json({ error: 'An active tenant membership is required' });
            }
            const { limit, offset } = parseCoursePagination(req.query);
            const safeProjection = !req.user || req.user.role === 'student';
            const columns = safeProjection
                ? 'id,name,subject,description,grade,price,is_active'
                : '*';
            const courses = await dependencies.query(
                `SELECT ${columns} FROM courses WHERE is_active=TRUE${scope.clause} ORDER BY name LIMIT ? OFFSET ?`,
                [...scope.params, String(limit), String(offset)]
            );
            res.json(courses);
        } catch (error) {
            console.error('Get courses error:', error);
            res.status(500).json({ error: 'Failed to fetch courses' });
        }
    });

    // Get course by ID
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const id = String(req.params.id || '');
            if (!id || id.length > 128) return res.status(404).json({ error: 'Course not found' });
            const scope = await resolveCourseReadScope(req.user, dependencies);
            if (isDeniedCourseScope(scope)) {
                return res.status(403).json({ error: 'An active tenant membership is required' });
            }
            const safeProjection = !req.user || req.user.role === 'student';
            const columns = safeProjection
                ? 'id,name,subject,description,grade,price,is_active'
                : '*';
            const course = await dependencies.queryOne(
                `SELECT ${columns} FROM courses WHERE id=? AND is_active=TRUE${scope.clause}`,
                [id, ...scope.params]
            );

            if (!course) {
                return res.status(404).json({ error: 'Course not found' });
            }

            res.json(course);
        } catch (error) {
            console.error('Get course error:', error);
            res.status(500).json({ error: 'Failed to fetch course' });
        }
    });

    // Create new course
    router.post('/', createCourseWriteGuard(dependencies), async (req: AuthRequest, res: Response) => {
        try {
            const validated = validateCourseInput(req.body, false);
            if (!validated.ok) return res.status(400).json({ error: validated.error });

            let tenantId: string | null = null;
            let instructorId: string | null = null;
            if (req.user?.tenantId && ['instructor', 'teacher', 'staff'].includes(req.user.role)) {
                tenantId = req.user.tenantId;
                instructorId = req.user.id;
            } else {
                return res.status(403).json({ error: 'An active tenant membership is required' });
            }

            // Generate UUID for the new course
            const idResult = await dependencies.query<{ id: string }>('SELECT UUID() as id');
            const newId = idResult[0].id;

            await dependencies.execute(
                `INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,grade,price)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [newId, tenantId, instructorId, validated.value.name, validated.value.subject, validated.value.description, validated.value.grade, validated.value.price]
            );

            await recordAudit(dependencies.execute, {
                actorUserId: req.user?.id ?? null,
                tenantId,
                action: 'course.create',
                resourceType: 'course',
                resourceId: newId,
                newValue: snapshotRow(validated.value),
            }).catch((auditError) => console.error('Course create audit failed:', auditError));

            const newCourse = await dependencies.queryOne(
                'SELECT * FROM courses WHERE id=? AND tenant_id=?',
                [newId, tenantId]
            );

            res.status(201).json(newCourse);
        } catch (error) {
            console.error('Create course error:', error);
            res.status(500).json({ error: 'Failed to create course' });
        }
    });

    // Update course
    router.put('/:id', createCourseWriteGuard(dependencies), async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            if (!id || id.length > 128) return res.status(404).json({ error: 'Course not found in your workspace' });
            const validated = validateCourseInput(req.body, true);
            if (!validated.ok) return res.status(400).json({ error: validated.error });

            const scope = resolveCourseManagementScope(req.user);
            if (isDeniedCourseScope(scope)) {
                return res.status(403).json({ error: 'An active tenant membership is required' });
            }
            const ownedCourse = await dependencies.queryOne(
                `SELECT * FROM courses WHERE courses.id=?${scope.clause}`,
                [id, ...scope.params]
            );
            if (!ownedCourse) return res.status(404).json({ error: 'Course not found in your workspace' });
            const result = await dependencies.execute(
                `UPDATE courses SET name=?,subject=?,description=?,grade=?,price=? WHERE id=?${scope.clause}`,
                [validated.value.name, validated.value.subject, validated.value.description, validated.value.grade, validated.value.price, id, ...scope.params]
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Course not found in your workspace' });

            await recordAudit(dependencies.execute, {
                actorUserId: req.user?.id ?? null,
                tenantId: req.user?.tenantId ?? null,
                action: 'course.update',
                resourceType: 'course',
                resourceId: id,
                oldValue: snapshotRow(ownedCourse),
                newValue: snapshotRow(validated.value),
            }).catch((auditError) => console.error('Course update audit failed:', auditError));

            const updatedCourse = await dependencies.queryOne(
                `SELECT * FROM courses WHERE courses.id=?${scope.clause}`,
                [id, ...scope.params]
            );

            res.json(updatedCourse);
        } catch (error) {
            console.error('Update course error:', error);
            res.status(500).json({ error: 'Failed to update course' });
        }
    });

    // Delete course
    router.delete('/:id', createCourseWriteGuard(dependencies), async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            if (!id || id.length > 128) return res.status(404).json({ error: 'Course not found in your workspace' });

            const scope = resolveCourseManagementScope(req.user);
            if (isDeniedCourseScope(scope)) {
                return res.status(403).json({ error: 'An active tenant membership is required' });
            }
            const ownedCourse = await dependencies.queryOne(
                `SELECT * FROM courses WHERE courses.id=?${scope.clause}`,
                [id, ...scope.params]
            );
            if (!ownedCourse) return res.status(404).json({ error: 'Course not found in your workspace' });
            const result = await dependencies.execute(
                `UPDATE courses SET is_active=FALSE WHERE id=?${scope.clause}`,
                [id, ...scope.params]
            );
            if (!result.affectedRows) return res.status(404).json({ error: 'Course not found in your workspace' });

            await recordAudit(dependencies.execute, {
                actorUserId: req.user?.id ?? null,
                tenantId: req.user?.tenantId ?? null,
                action: 'course.archive',
                resourceType: 'course',
                resourceId: id,
                oldValue: snapshotRow(ownedCourse),
                newValue: { is_active: false },
            }).catch((auditError) => console.error('Course archive audit failed:', auditError));

            res.json({ message: 'Course deleted successfully' });
        } catch (error) {
            console.error('Delete course error:', error);
            res.status(500).json({ error: 'Failed to delete course' });
        }
    });

    return router;
}

const router = createCoursesRouter();
// ---------------------------------------------------------------------------
// M2-22 — explicit course publication (private, audited, transactional)
//
// An explicit publish/unpublish for ONE active course of the server-selected
// tenant. The five legacy handlers above are deliberately UNTOUCHED: they keep
// their mounts, their scope and their response shapes, and none of them reads
// or writes `publication_state`. In particular the legacy `PUT /:id` cannot
// change publication, because it only writes name/subject/description/grade/
// price — publication has exactly ONE write path, the route below.
//
// Publication is a DISCOVERY flag and nothing else. It enrolls no student,
// grants no content access, exposes no lesson, unit, file or material, charges
// no price, creates no account and sends nothing. It also is not derived from
// `is_active`: archiving a published course withdraws it from public discovery
// (the public read requires BOTH) without rewriting its publication record.
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The only two states a client may ask for. `unpublished` is not a state. */
const WRITABLE_PUBLICATION_STATES: ReadonlySet<string> = new Set(['draft', 'published']);

const PUBLICATION_ALLOWED_KEYS: ReadonlySet<string> = new Set(['publication_state']);

/** Authority revalidation on the same connection, inside the transaction. */
const MEMBER_LOCK_SELECT =
    'SELECT m.role_key,u.is_active AS caller_active,t.status AS tenant_status ' +
    'FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id ' +
    "WHERE m.user_id=? AND m.tenant_id=? AND m.status='active' LIMIT 1 FOR UPDATE";

/**
 * Locks the target course inside the selected tenant.
 *
 * `is_active=TRUE` is part of the lock, so an ARCHIVED course is one 404 for
 * publication — it is already absent from the management surface and from
 * public discovery, so there is no publication transition to make on it.
 *
 * The tenant qualification is the same one the accepted legacy `PUT`/`DELETE`
 * use (`courses.tenant_id = <selected tenant>`), so publication authority is
 * exactly as wide as the course-edit authority that already exists: any active
 * teaching member of the selected tenant, never a cross-tenant caller. No
 * instructor-level narrowing is invented here, because the accepted course
 * write path does not have one either.
 *
 * `published_at` is projected as an EPOCH, never as a driver datetime: the pool
 * is configured with `timezone: '+02:00'`, so a raw TIMESTAMP value would be
 * re-interpreted on the client side and every serialized instant would shift.
 */
const COURSE_LOCK_SELECT =
    'SELECT c.id,c.name,c.publication_state,UNIX_TIMESTAMP(c.published_at) AS published_at_epoch ' +
    'FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=TRUE FOR UPDATE';

const COURSE_PUBLISH_SQL =
    "UPDATE courses SET publication_state='published'," +
    'published_at=COALESCE(published_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP ' +
    'WHERE id=? AND tenant_id=? AND is_active=TRUE';

const COURSE_UNPUBLISH_SQL =
    "UPDATE courses SET publication_state='draft',published_at=NULL,updated_at=CURRENT_TIMESTAMP " +
    'WHERE id=? AND tenant_id=? AND is_active=TRUE';

const COURSE_PUBLICATION_READ_SQL =
    'SELECT c.id,c.name,c.publication_state,UNIX_TIMESTAMP(c.published_at) AS published_at_epoch ' +
    'FROM courses c WHERE c.id=? AND c.tenant_id=? AND c.is_active=TRUE LIMIT 1';

const AUDIT_SQL =
    'INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value) VALUES (?,?,?,?,?,?,?,?)';

interface MembershipRow { role_key: string; caller_active: number | boolean; tenant_status: string }

const isTeachingMember = (row: MembershipRow | undefined): boolean =>
    !!row &&
    (row.role_key === 'owner' || row.role_key === 'instructor') &&
    Number(row.caller_active) === 1 &&
    row.tenant_status === 'active';

/** Epoch seconds -> UTC ISO-8601, or `null`. Never a wall-time guess. */
const publicationStamp = (epoch: unknown): string | null => {
    if (epoch === null || epoch === undefined) return null;
    const seconds = Number(epoch);
    if (!Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000).toISOString();
};

/**
 * The fixed THREE-field publication projection. `tenant_id`, `instructor_id`,
 * price, counters and every other column stay server-side and are never
 * spread into a response.
 */
const publicationDto = (row: any) => ({
    course_id: String(row.id),
    publication_state: String(row.publication_state),
    published_at: publicationStamp(row.published_at_epoch),
});

type PublicationParse =
    | { ok: true; state: 'draft' | 'published' }
    | { ok: false; error: string };

/**
 * Strict canonical payload: EXACTLY `{ publication_state }`, whose value is
 * `draft` or `published`.
 *
 * Nothing else is accepted — no `tenant_id`, no `instructor_id`, no `is_active`,
 * no `published_at`, no price. A caller therefore cannot back-date a
 * publication, cannot publish another tenant's course by naming a tenant, and
 * cannot smuggle an unrelated course column through this route.
 */
function parsePublicationBody(body: unknown): PublicationParse {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Invalid publication payload' };
    }
    const obj = body as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
        if (!PUBLICATION_ALLOWED_KEYS.has(key)) {
            return { ok: false, error: 'Invalid publication payload' };
        }
    }
    if (!('publication_state' in obj)) {
        return { ok: false, error: 'Invalid publication payload' };
    }
    const state = obj.publication_state;
    if (typeof state !== 'string' || !WRITABLE_PUBLICATION_STATES.has(state)) {
        return { ok: false, error: 'Invalid publication state' };
    }
    return { ok: true, state: state as 'draft' | 'published' };
}

/**
 * `PUT /api/courses/:id/publication`
 *
 * Body: exactly `{ "publication_state": "draft" | "published" }`.
 *
 * Publishes or withdraws ONE active course of the server-selected tenant:
 *  - authority (active membership, active user, active tenant, teaching role)
 *    and the target course are re-verified on ONE connection inside ONE
 *    transaction, each read locked `FOR UPDATE`;
 *  - a transition that changes nothing is a TRUTHFUL no-op: nothing is written,
 *    nothing is audited and the current stored projection is returned, so a
 *    retried publish never re-stamps `published_at`;
 *  - a confirmed transition writes the two publication columns and exactly ONE
 *    sanitized audit event, committed together;
 *  - an uncertain commit destroys the connection and never claims a rollback.
 */
router.put('/:id/publication', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const courseId = String(req.params?.id ?? '');
    if (!UUID_PATTERN.test(courseId)) return res.status(404).json({ error: 'Course not found' });

    const tenantId = req.user?.tenantId;
    const callerId = req.user?.id;
    if (!tenantId || !callerId) {
        return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
    }

    const parsed = parsePublicationBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const nextState = parsed.state;

    let connection: PoolConnection | null = null;
    let started = false;
    let commitAttempted = false;
    let disposal: 'release' | 'destroy' = 'release';

    const rollbackOrDiscard = async (): Promise<void> => {
        try { await connection!.rollback(); }
        catch { disposal = 'destroy'; }
    };

    try {
        connection = await getPool().getConnection();
        await connection.beginTransaction();
        started = true;

        const [memberRows] = await connection.execute<any[]>(MEMBER_LOCK_SELECT, [callerId, tenantId]);
        if (!isTeachingMember((memberRows as MembershipRow[])[0])) {
            await rollbackOrDiscard();
            return res.status(403).json({ error: 'Teaching access is not active for the selected tenant' });
        }

        const member = (memberRows as MembershipRow[])[0];
        // Keep the stricter shared branch's instructor ownership boundary.
        const ownCourseOnly = member.role_key === 'instructor';
        const courseLock = ownCourseOnly ? COURSE_LOCK_SELECT.replace(' FOR UPDATE', ' AND c.instructor_id=? FOR UPDATE') : COURSE_LOCK_SELECT;
        const [courseRows] = await connection.execute<any[]>(courseLock, ownCourseOnly ? [courseId, tenantId, callerId] : [courseId, tenantId]);
        const current = (courseRows as any[])[0];
        if (!current) {
            await rollbackOrDiscard();
            return res.status(404).json({ error: 'Course not found' });
        }

        const currentState = String(current.publication_state);
        if (currentState === nextState) {
            // Truthful no-op: write nothing, audit nothing, answer with the
            // current stored projection (and the ORIGINAL published_at).
            await rollbackOrDiscard();
            return res.json(publicationDto(current));
        }

        const [updateResult] = await connection.execute<any[]>(
            nextState === 'published' ? COURSE_PUBLISH_SQL : COURSE_UNPUBLISH_SQL,
            [courseId, tenantId],
        );
        if (Number((updateResult as any)?.affectedRows) !== 1) {
            await rollbackOrDiscard();
            return res.status(409).json({ error: 'Course was modified concurrently' });
        }

        // Exactly ONE sanitized audit event, committed with the write. The event
        // records WHO changed WHICH course into WHICH publication state. It
        // carries no name, description, price, student, lesson, file or
        // contact value, because this route changes none of them.
        await connection.execute(AUDIT_SQL, [
            randomUUID(),
            callerId,
            tenantId,
            nextState === 'published' ? 'course.published' : 'course.unpublished',
            'course',
            courseId,
            JSON.stringify({ publication_state: currentState }),
            JSON.stringify({ publication_state: nextState }),
        ]);

        // The row is read back inside the same transaction, so the response is
        // the stored projection including the SERVER publication instant.
        const [readRows] = await connection.execute<any[]>(COURSE_PUBLICATION_READ_SQL, [courseId, tenantId]);
        const updated = (readRows as any[])[0];
        if (!updated) {
            await rollbackOrDiscard();
            return res.status(500).json({ error: 'Failed to update course publication' });
        }

        commitAttempted = true;
        await connection.commit();
        return res.json(publicationDto(updated));
    } catch (error) {
        if (commitAttempted) {
            disposal = 'destroy';
            console.error('Course publication error after commit attempt (persistence uncertain):', error);
        } else if (started) {
            await rollbackOrDiscard();
            console.error('Course publication error:', error);
        } else {
            disposal = 'destroy';
            console.error('Course publication error before transaction start:', error);
        }
        return res.status(500).json({ error: 'Failed to update course publication' });
    } finally {
        if (connection) {
            if (disposal === 'destroy') { try { connection.destroy(); } catch { /* gone */ } }
            else { try { connection.release(); } catch { /* released */ } }
        }
    }
});



export default router;
