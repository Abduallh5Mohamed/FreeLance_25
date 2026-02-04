import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';

const router = Router();

// Get all meetings (for admin/teacher)
router.get('/', async (req: Request, res: Response) => {
    try {
        const meetings = await query(`
            SELECT 
                m.*,
                g.name as grade_name,
                gr.name as group_name,
                u.name as created_by_name
            FROM online_meetings m
            LEFT JOIN grades g ON m.grade_id = g.id
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            LEFT JOIN users u ON m.created_by = u.id
            ORDER BY m.scheduled_at DESC
        `);
        res.json(meetings);
    } catch (error) {
        console.error('Error fetching meetings:', error);
        res.status(500).json({ error: 'Failed to fetch meetings' });
    }
});

// Get meetings for a specific student (based on their grade and group)
router.get('/student/:studentId', async (req: Request, res: Response) => {
    try {
        const { studentId } = req.params;
        
        // First get the user's phone to find the student
        const user = await queryOne(`SELECT phone FROM users WHERE id = ?`, [studentId]);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Find student by phone
        const student = await queryOne(`
            SELECT s.grade_id, s.group_id 
            FROM students s 
            WHERE s.phone = ?
        `, [user.phone]);
        
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        
        // Get meetings for student's grade (and optionally their group)
        // Meeting is visible if:
        // 1. It matches the student's grade AND group_id is NULL (for all groups in that grade)
        // 2. It matches the student's grade AND group_id matches student's group
        const meetings = await query(`
            SELECT 
                m.*,
                g.name as grade_name,
                gr.name as group_name,
                u.name as created_by_name
            FROM online_meetings m
            LEFT JOIN grades g ON m.grade_id = g.id
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            LEFT JOIN users u ON m.created_by = u.id
            WHERE m.is_active = 1
            AND m.grade_id = ?
            AND (m.group_id IS NULL OR m.group_id = ?)
            AND m.scheduled_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
            ORDER BY m.scheduled_at ASC
        `, [student.grade_id, student.group_id]);
        
        res.json(meetings);
    } catch (error) {
        console.error('Error fetching student meetings:', error);
        res.status(500).json({ error: 'Failed to fetch meetings' });
    }
});

// Get single meeting
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const meeting = await queryOne(`
            SELECT 
                m.*,
                g.name as grade_name,
                gr.name as group_name,
                u.name as created_by_name
            FROM online_meetings m
            LEFT JOIN grades g ON m.grade_id = g.id
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            LEFT JOIN users u ON m.created_by = u.id
            WHERE m.id = ?
        `, [id]);
        
        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        
        res.json(meeting);
    } catch (error) {
        console.error('Error fetching meeting:', error);
        res.status(500).json({ error: 'Failed to fetch meeting' });
    }
});

// Create meeting
router.post('/', async (req: Request, res: Response) => {
    try {
        console.log('📅 Creating meeting, body:', JSON.stringify(req.body));
        
        const { 
            title, 
            description, 
            meeting_link, 
            meeting_type = 'zoom',
            meeting_password,
            grade_id, 
            group_id, 
            scheduled_at, 
            duration_minutes = 60,
            created_by 
        } = req.body;
        
        console.log('📅 Parsed fields:', { title, meeting_link, grade_id, scheduled_at, created_by });
        
        if (!title || !meeting_link || !grade_id || !scheduled_at || !created_by) {
            console.log('📅 Missing fields!', { title: !!title, meeting_link: !!meeting_link, grade_id: !!grade_id, scheduled_at: !!scheduled_at, created_by: !!created_by });
            return res.status(400).json({ 
                error: 'Missing required fields: title, meeting_link, grade_id, scheduled_at, created_by' 
            });
        }
        
        // Generate UUID
        const uuidResult = await queryOne('SELECT UUID() as uuid');
        const id = uuidResult.uuid;
        
        await execute(`
            INSERT INTO online_meetings 
            (id, title, description, meeting_link, meeting_type, meeting_password, grade_id, group_id, scheduled_at, duration_minutes, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, title, description || null, meeting_link, meeting_type, meeting_password || null, grade_id, group_id || null, scheduled_at, duration_minutes, created_by]);
        
        const meeting = await queryOne(`
            SELECT 
                m.*,
                g.name as grade_name,
                gr.name as group_name
            FROM online_meetings m
            LEFT JOIN grades g ON m.grade_id = g.id
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            WHERE m.id = ?
        `, [id]);
        
        res.status(201).json(meeting);
    } catch (error) {
        console.error('Error creating meeting:', error);
        res.status(500).json({ error: 'Failed to create meeting' });
    }
});

// Update meeting
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { 
            title, 
            description, 
            meeting_link, 
            meeting_type,
            meeting_password,
            grade_id, 
            group_id, 
            scheduled_at, 
            duration_minutes,
            is_active 
        } = req.body;
        
        await execute(`
            UPDATE online_meetings SET
                title = COALESCE(?, title),
                description = COALESCE(?, description),
                meeting_link = COALESCE(?, meeting_link),
                meeting_type = COALESCE(?, meeting_type),
                meeting_password = ?,
                grade_id = COALESCE(?, grade_id),
                group_id = ?,
                scheduled_at = COALESCE(?, scheduled_at),
                duration_minutes = COALESCE(?, duration_minutes),
                is_active = COALESCE(?, is_active)
            WHERE id = ?
        `, [title, description, meeting_link, meeting_type, meeting_password, grade_id, group_id, scheduled_at, duration_minutes, is_active, id]);
        
        const meeting = await queryOne(`
            SELECT 
                m.*,
                g.name as grade_name,
                gr.name as group_name
            FROM online_meetings m
            LEFT JOIN grades g ON m.grade_id = g.id
            LEFT JOIN \`groups\` gr ON m.group_id = gr.id
            WHERE m.id = ?
        `, [id]);
        
        res.json(meeting);
    } catch (error) {
        console.error('Error updating meeting:', error);
        res.status(500).json({ error: 'Failed to update meeting' });
    }
});

// Delete meeting
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await execute('DELETE FROM online_meetings WHERE id = ?', [id]);
        res.json({ message: 'Meeting deleted successfully' });
    } catch (error) {
        console.error('Error deleting meeting:', error);
        res.status(500).json({ error: 'Failed to delete meeting' });
    }
});

// Get groups by grade (for filtering)
router.get('/groups-by-grade/:gradeId', async (req: Request, res: Response) => {
    try {
        const { gradeId } = req.params;
        const groups = await query(`
            SELECT id, name FROM \`groups\` WHERE grade_id = ? ORDER BY name
        `, [gradeId]);
        res.json(groups);
    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

export default router;
