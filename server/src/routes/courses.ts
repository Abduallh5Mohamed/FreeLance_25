import { Router, Response } from 'express';
import { query, queryOne, execute } from '../db';
import { AuthRequest, optionalAuth } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';

const router = Router();
router.use(optionalAuth);

export interface CourseCaller {
    role?: string;
    tenantId?: string | null;
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
 * - platform admin -> all tenants (audited admin surface)
 * - anonymous -> ownerless rows only (public discovery projection)
 * - authenticated non-admin without a tenant -> denied (fail closed)
 */
export function resolveCourseScope(user: CourseCaller | undefined): CourseScopeResult {
    if (!user) return { clause: ' AND tenant_id IS NULL', params: [] };
    if (typeof user.tenantId === 'string' && user.tenantId.length > 0) {
        return { clause: ' AND tenant_id=?', params: [user.tenantId] };
    }
    if (user.role === 'admin') return { clause: '', params: [] };
    return { denied: true };
}

// Get courses visible inside the current caller's teaching space.
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const scope = resolveCourseScope(req.user);
        if (isDeniedCourseScope(scope)) {
            return res.status(403).json({ error: 'An active tenant membership is required' });
        }
        const { limit, offset } = parseCoursePagination(req.query);
        const isPublic = !req.user;
        const columns = isPublic
            ? 'id,name,subject,description,grade,price,is_active'
            : '*';
        const courses = await query(
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
        const scope = resolveCourseScope(req.user);
        if (isDeniedCourseScope(scope)) {
            return res.status(403).json({ error: 'An active tenant membership is required' });
        }
        const isPublic = !req.user;
        const columns = isPublic
            ? 'id,name,subject,description,grade,price,is_active'
            : '*';
        const course = await queryOne(
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
router.post('/', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
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
        const idResult = await query<{ id: string }>('SELECT UUID() as id');
        const newId = idResult[0].id;

        await execute(
            `INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,grade,price)
             VALUES (?,?,?,?,?,?,?,?)`,
            [newId, tenantId, instructorId, validated.value.name, validated.value.subject, validated.value.description, validated.value.grade, validated.value.price]
        );

        const newCourse = await queryOne(
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
router.put('/:id', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        if (!id || id.length > 128) return res.status(404).json({ error: 'Course not found in your workspace' });
        const validated = validateCourseInput(req.body, true);
        if (!validated.ok) return res.status(400).json({ error: validated.error });

        const scope = resolveCourseScope(req.user);
        if (isDeniedCourseScope(scope)) {
            return res.status(403).json({ error: 'An active tenant membership is required' });
        }
        const result = await execute(
            `UPDATE courses SET name=?,subject=?,description=?,grade=?,price=? WHERE id=?${scope.clause}`,
            [validated.value.name, validated.value.subject, validated.value.description, validated.value.grade, validated.value.price, id, ...scope.params]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Course not found in your workspace' });

        const updatedCourse = await queryOne(
            `SELECT * FROM courses WHERE id=?${scope.clause}`,
            [id, ...scope.params]
        );

        res.json(updatedCourse);
    } catch (error) {
        console.error('Update course error:', error);
        res.status(500).json({ error: 'Failed to update course' });
    }
});

// Delete course
router.delete('/:id', requireTeachingWrite('courses'), async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        if (!id || id.length > 128) return res.status(404).json({ error: 'Course not found in your workspace' });

        const scope = resolveCourseScope(req.user);
        if (isDeniedCourseScope(scope)) {
            return res.status(403).json({ error: 'An active tenant membership is required' });
        }
        const result = await execute(
            `UPDATE courses SET is_active=FALSE WHERE id=?${scope.clause}`,
            [id, ...scope.params]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Course not found in your workspace' });

        res.json({ message: 'Course deleted successfully' });
    } catch (error) {
        console.error('Delete course error:', error);
        res.status(500).json({ error: 'Failed to delete course' });
    }
});

export default router;
