import { Router, RequestHandler, Response } from 'express';
import { query, queryOne, execute } from '../db';
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
export default router;
