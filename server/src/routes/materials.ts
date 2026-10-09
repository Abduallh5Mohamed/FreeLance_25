import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';
import https from 'https';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import { authenticateToken, optionalAuth, instructorScopeId, AuthRequest } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';

const router = Router();
router.use(optionalAuth);

// Material is editable by an instructor when it's linked to at least one of their groups
const materialInScope = async (materialId: string, scopeId: string): Promise<boolean> => {
    const row = await queryOne(
        `SELECT mg.material_id
         FROM material_groups mg
         INNER JOIN \`groups\` g ON mg.group_id = g.id
         WHERE mg.material_id = ? AND g.instructor_id = ?
         LIMIT 1`,
        [materialId, scopeId]
    );
    return !!row;
};

const areGroupsInScope = async (groupIds: any[], scopeId: string): Promise<boolean> => {
    if (!Array.isArray(groupIds) || groupIds.length === 0) return false;
    const rows = await query<any>(
        `SELECT COUNT(*) AS cnt FROM \`groups\` WHERE instructor_id = ? AND id IN (${groupIds.map(() => '?').join(',')})`,
        [scopeId, ...groupIds]
    );
    return rows[0]?.cnt === groupIds.length;
};

interface CourseMaterial {
    id: string;
    course_id: string;
    title: string;
    description?: string;
    material_type: 'pdf' | 'video' | 'presentation' | 'link' | 'other';
    file_url?: string;
    file_size?: number;
    duration_minutes?: number;
    display_order?: number;
    is_free: boolean;
    is_published: boolean;
    created_at?: Date;
    updated_at?: Date;
}

// Get all materials (with optional course filter)
router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { course_id } = req.query;
        const scopeId = instructorScopeId(req);

        let sql = `
            SELECT
                cm.*,
                c.name as course_name,
                c.subject as course_subject
            FROM course_materials cm
            LEFT JOIN courses c ON cm.course_id = c.id
            WHERE cm.is_published = TRUE
        `;
        const params: any[] = [];

        if (course_id && typeof course_id === 'string') {
            sql += ' AND cm.course_id = ?';
            params.push(course_id);
        }

        // Instructors only see materials linked to their groups (or ungrouped ones)
        if (scopeId) {
            sql += ` AND (NOT EXISTS (SELECT 1 FROM material_groups mgx WHERE mgx.material_id = cm.id)
                      OR EXISTS (SELECT 1 FROM material_groups mg2 INNER JOIN \`groups\` g2 ON mg2.group_id = g2.id
                                 WHERE mg2.material_id = cm.id AND g2.instructor_id = ?))`;
            params.push(scopeId);
        }
        if (req.user?.role === 'student') {
            if (!req.user.studentEnrollmentId || !req.user.groupId) return res.status(403).json({ error: 'Select an instructor workspace first' });
            sql += ` AND EXISTS (SELECT 1 FROM material_groups student_mg
                                 WHERE student_mg.material_id=cm.id AND student_mg.group_id=?)`;
            params.push(req.user.groupId);
        }

        sql += ' ORDER BY cm.display_order ASC, cm.created_at DESC';

        const materials = await query(sql, params);

        // Fetch group_ids for each material
        for (const material of materials) {
            const groups = await query(
                'SELECT group_id FROM material_groups WHERE material_id = ?',
                [material.id]
            );
            material.group_ids = groups.map((g: any) => g.group_id);
        }

        res.json(materials);
    } catch (error) {
        console.error('Get materials error:', error);
        res.status(500).json({ error: 'Failed to fetch materials' });
    }
});

// Get materials for a specific student based on their group
router.get('/student/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { userId } = req.params;
        if (req.user?.role !== 'student' || String(req.user.id) !== String(userId)
            || !req.user.studentEnrollmentId || !req.user.tenantId) {
            return res.status(403).json({ error: 'Student workspace access required' });
        }
        const student = await queryOne(
            `SELECT id,group_id,grade_id FROM students
             WHERE id=? AND user_id=? AND tenant_id=? AND is_active=TRUE AND approval_status='approved'`,
            [req.user.studentEnrollmentId, req.user.id, req.user.tenantId]
        );

        if (!student) {
            return res.json([]);
        }

        if (!student.group_id) {
            return res.json([]);
        }

        // Get all materials assigned to the student's group
        let sql = `
            SELECT DISTINCT
                cm.*,
                c.name as course_name,
                c.subject as course_subject
            FROM course_materials cm
            LEFT JOIN courses c ON cm.course_id = c.id
            INNER JOIN material_groups mg ON cm.id = mg.material_id
            WHERE cm.is_published = TRUE
                AND mg.group_id = ?
            ORDER BY cm.display_order ASC, cm.created_at DESC
        `;

        const materials = await query(sql, [student.group_id]);

        // Add group_ids to each material
        for (const material of materials) {
            const groups = await query(
                'SELECT group_id FROM material_groups WHERE material_id = ?',
                [material.id]
            );
            material.group_ids = groups.map((g: any) => g.group_id);
        }

        res.json(materials);
    } catch (error) {
        console.error('Get student materials error:', error);
        res.status(500).json({ error: 'Failed to fetch materials' });
    }
});

// Get material by ID
router.get('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        const material = await queryOne(
            `SELECT
                cm.*,
                c.name as course_name,
                c.subject as course_subject
            FROM course_materials cm
            LEFT JOIN courses c ON cm.course_id = c.id
            WHERE cm.id = ?`,
            [req.params.id]
        );

        if (!material) {
            return res.status(404).json({ error: 'Material not found' });
        }
        if (scopeId && !(await materialInScope(req.params.id, scopeId))) {
            return res.status(404).json({ error: 'Material not found' });
        }
        if (req.user?.role === 'student') {
            if (!req.user.groupId) return res.status(403).json({ error: 'Select an instructor workspace first' });
            const assigned = await queryOne('SELECT 1 FROM material_groups WHERE material_id=? AND group_id=?', [req.params.id, req.user.groupId]);
            if (!assigned) return res.status(404).json({ error: 'Material not found' });
        }

        res.json(material);
    } catch (error) {
        console.error('Get material error:', error);
        res.status(500).json({ error: 'Failed to fetch material' });
    }
});

// Create new material
router.post('/', requireTeachingWrite('materials'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        const {
            course_id,
            title,
            description,
            material_type,
            file_url,
            file_size,
            duration_minutes,
            display_order = 0,
            is_free = false,
            is_published = true,
            grade_id,
            group_ids
        } = req.body;

        if (!course_id || !title || !material_type) {
            return res.status(400).json({
                error: 'Course ID, title, and material type are required'
            });
        }

        // Instructors can only publish materials to their own groups
        if (scopeId && !(await areGroupsInScope(group_ids, scopeId))) {
            return res.status(403).json({ error: 'يجب ربط المادة بمجموعة من مجموعاتك فقط' });
        }

        // Video materials must reference an internally uploaded video.
        if (material_type === 'video' && (!file_url || !String(file_url).startsWith('video://'))) {
            return res.status(400).json({
                error: 'External video links are not allowed. Upload the video to the platform.'
            });
        }

        // Generate UUID for the new material
        const materialId = crypto.randomUUID();

        const result = await execute(
            `INSERT INTO course_materials
            (id, course_id, title, description, material_type, file_url, file_size,
             duration_minutes, display_order, is_free, is_published)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                materialId,
                course_id,
                title,
                description || null,
                material_type,
                file_url || null,
                file_size || null,
                duration_minutes || null,
                display_order,
                is_free,
                is_published
            ]
        );

        // Insert material-group relationships if group_ids provided
        if (group_ids && Array.isArray(group_ids) && group_ids.length > 0) {
            // Validate that all group_ids exist
            for (const groupId of group_ids) {
                const groupExists = await queryOne(
                    'SELECT id FROM `groups` WHERE id = ? AND is_active = TRUE',
                    [groupId]
                );

                if (!groupExists) {
                    console.warn(`Group ${groupId} not found or inactive, skipping...`);
                    continue;
                }

                await execute(
                    'INSERT INTO material_groups (material_id, group_id) VALUES (?, ?)',
                    [materialId, groupId]
                );
            }
        }

        const newMaterial = await queryOne(
            'SELECT * FROM course_materials WHERE id = ?',
            [materialId]
        );

        // Add grade_id and group_ids to response
        const materialWithGroups = {
            ...newMaterial,
            grade_id: grade_id || null,
            group_ids: group_ids || []
        };

        res.status(201).json(materialWithGroups);
    } catch (error: any) {
        console.error('Create material error:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage,
            sql: error.sql
        });
        res.status(500).json({
            error: 'Failed to create material',
            details: error.message
        });
    }
});

// Update material
router.put('/:id', requireTeachingWrite('materials'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        if (scopeId && !(await materialInScope(req.params.id, scopeId))) {
            return res.status(404).json({ error: 'Material not found' });
        }
        const {
            title,
            description,
            material_type,
            file_url,
            file_size,
            duration_minutes,
            display_order,
            is_free,
            is_published
        } = req.body;

        const existingMaterial = await queryOne<any>('SELECT material_type,file_url FROM course_materials WHERE id=?', [req.params.id]);
        const finalType = material_type ?? existingMaterial?.material_type;
        const finalUrl = file_url ?? existingMaterial?.file_url;
        if (finalType === 'video' && (!finalUrl || !String(finalUrl).startsWith('video://'))) {
            return res.status(400).json({ error: 'External video links are not allowed. Upload the video to the platform.' });
        }

        const result = await execute(
            `UPDATE course_materials
             SET title = COALESCE(?, title),
                 description = COALESCE(?, description),
                 material_type = COALESCE(?, material_type),
                 file_url = COALESCE(?, file_url),
                 file_size = COALESCE(?, file_size),
                 duration_minutes = COALESCE(?, duration_minutes),
                 display_order = COALESCE(?, display_order),
                 is_free = COALESCE(?, is_free),
                 is_published = COALESCE(?, is_published),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                title ?? null,
                description ?? null,
                material_type ?? null,
                file_url ?? null,
                file_size ?? null,
                duration_minutes ?? null,
                display_order ?? null,
                is_free ?? null,
                is_published ?? null,
                req.params.id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }

        const updatedMaterial = await queryOne(
            'SELECT * FROM course_materials WHERE id = ?',
            [req.params.id]
        );

        res.json(updatedMaterial);
    } catch (error) {
        console.error('Update material error:', error);
        res.status(500).json({ error: 'Failed to update material' });
    }
});

// Delete material (soft delete by unpublishing)
router.delete('/:id', requireTeachingWrite('materials'), async (req: AuthRequest, res: Response) => {
    try {
        const scopeId = instructorScopeId(req);
        if (scopeId && !(await materialInScope(req.params.id, scopeId))) {
            return res.status(404).json({ error: 'Material not found' });
        }
        const result = await execute(
            'UPDATE course_materials SET is_published = FALSE WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }

        res.json({ message: 'Material deleted successfully' });
    } catch (error) {
        console.error('Delete material error:', error);
        res.status(500).json({ error: 'Failed to delete material' });
    }
});

// Helper endpoint: Convert Google Drive sharing link to embeddable URL
router.post('/convert-drive-url', async (req: Request, res: Response) => {
    return res.status(410).json({ error: 'External video links are disabled. Upload videos to the platform.' });
    /* legacy document-link helper intentionally unreachable for video */
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Extract file ID from Google Drive URL
        // Supports formats:
        // - https://drive.google.com/file/d/FILE_ID/view
        // - https://drive.google.com/open?id=FILE_ID
        // - https://drive.google.com/uc?id=FILE_ID

        let fileId = null;

        const patterns = [
            /\/file\/d\/([a-zA-Z0-9_-]+)/,
            /[?&]id=([a-zA-Z0-9_-]+)/,
            /\/d\/([a-zA-Z0-9_-]+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                fileId = match[1];
                break;
            }
        }

        if (!fileId) {
            return res.status(400).json({
                error: 'Could not extract file ID from Google Drive URL'
            });
        }

        // Return embeddable URL
        const embedUrl = `https://drive.google.com/file/d/${fileId}/preview`;

        res.json({
            fileId,
            embedUrl,
            originalUrl: url
        });
    } catch (error) {
        console.error('Convert URL error:', error);
        res.status(500).json({ error: 'Failed to convert URL' });
    }
});

// Stream video from Google Drive
router.get('/stream/:fileId', async (req: Request, res: Response): Promise<void> => {
    res.status(410).json({ error: 'External video streaming is disabled. Upload videos to the platform.' });
    return;
    /* legacy implementation intentionally unreachable */
    try {
        const { fileId } = req.params;

        if (!fileId) {
            res.status(400).json({
                error: 'File ID is required'
            });
            return;
        }

        // Google Drive export URL for video streaming
        const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

        // Forward the request to Google Drive
        https.get(driveUrl, (response: IncomingMessage) => {
            // Set appropriate headers for video streaming
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
            res.setHeader('Content-Length', response.headers['content-length'] || '');
            res.setHeader('Accept-Ranges', 'bytes');

            // Allow CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

            response.pipe(res);
        }).on('error', (err: Error) => {
            console.error('Stream error:', err);
            res.status(500).json({ error: 'Failed to stream video' });
        });
    } catch (error) {
        console.error('Stream error:', error);
        res.status(500).json({ error: 'Failed to stream video' });
    }
});

// Get direct download URL for Google Drive files
router.post('/get-stream-url', async (req: Request, res: Response) => {
    return res.status(410).json({ error: 'External video stream URLs are disabled. Upload videos to the platform.' });
    /* legacy implementation intentionally unreachable */
    try {
        const { file_url } = req.body;

        if (!file_url) {
            return res.status(400).json({
                error: 'File URL is required'
            });
        }

        // Extract file ID
        let fileId = null;
        const patterns = [
            /\/file\/d\/([a-zA-Z0-9_-]+)/,
            /[?&]id=([a-zA-Z0-9_-]+)/,
            /\/d\/([a-zA-Z0-9_-]+)/
        ];

        for (const pattern of patterns) {
            const match = file_url.match(pattern);
            if (match && match[1]) {
                fileId = match[1];
                break;
            }
        }

        if (!fileId) {
            return res.status(400).json({
                error: 'Could not extract file ID from Google Drive URL'
            });
        }

        // Return streaming URL (our proxy endpoint)
        const streamUrl = `/api/materials/stream/${fileId}`;

        // Also return direct Google Drive export URL
        const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

        res.json({
            fileId,
            streamUrl,
            directUrl,
            originalUrl: file_url
        });
    } catch (error) {
        console.error('Get stream URL error:', error);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});

export default router;
