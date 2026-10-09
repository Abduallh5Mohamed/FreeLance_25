import { Router, Response } from 'express';
import { query, queryOne, execute } from '../db';
import { AuthRequest, optionalAuth } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';

const router = Router();
router.use(optionalAuth);

// Get all courses
const courseScope = (req: AuthRequest): { clause: string; params: string[] } => {
    if (req.user?.tenantId) return { clause: ' AND tenant_id=?', params: [req.user.tenantId] };
    if (req.user?.role === 'admin') return { clause: '', params: [] };
    return { clause: ' AND tenant_id IS NULL', params: [] };
};

// Get courses visible inside the current caller's teaching space.
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const scope = courseScope(req);
        const courses = await query(
            `SELECT * FROM courses WHERE is_active=TRUE${scope.clause} ORDER BY name`, scope.params
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
        const scope = courseScope(req);
        const course = await queryOne(
            `SELECT * FROM courses WHERE id=? AND is_active=TRUE${scope.clause}`,
            [req.params.id, ...scope.params]
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
        const { name, subject, description, grade, price = 0 } = req.body;
        const normalizedName = String(name || '').trim();
        const normalizedSubject = String(subject || '').trim();

        if (!normalizedName || normalizedName.length > 255 || normalizedSubject.length > 100) {
            return res.status(400).json({ error: 'Course name is required' });
        }

        let tenantId: string | null = null;
        let instructorId: string | null = null;
        if (req.user?.tenantId && ['instructor', 'teacher', 'staff'].includes(req.user.role)) {
            tenantId = req.user.tenantId;
            instructorId = req.user.id;
        } else {
            return res.status(403).json({ error: 'An active tenant membership is required' });
        }

        // Generate UUID for the new course
        const idResult = await query<{id: string}>('SELECT UUID() as id');
        const newId = idResult[0].id;

        await execute(
            `INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,grade,price)
             VALUES (?,?,?,?,?,?,?,?)`,
            [newId, tenantId, instructorId, normalizedName, normalizedSubject || null, description || null, grade || null, price]
        );

        const newCourse = await queryOne(
            'SELECT * FROM courses WHERE id = ?',
            [newId]
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
        const { name, subject, description, grade, price } = req.body;
        const { id } = req.params;
        const normalizedName = String(name || '').trim();
        const normalizedSubject = String(subject || '').trim();
        if (!normalizedName || normalizedName.length > 255 || normalizedSubject.length > 100) {
            return res.status(400).json({ error: 'Valid course name and subject are required' });
        }

        const scope = courseScope(req);
        const result = await execute(
            `UPDATE courses SET name=?,subject=?,description=?,grade=?,price=? WHERE id=?${scope.clause}`,
            [normalizedName, normalizedSubject || null, description || null, grade || null, price || 0, id, ...scope.params]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Course not found in your workspace' });

        const updatedCourse = await queryOne(
            'SELECT * FROM courses WHERE id = ?',
            [id]
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

        const scope = courseScope(req);
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
