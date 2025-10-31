import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';
import https from 'https';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';

const router = Router();

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
router.get('/', async (req: Request, res: Response) => {
    try {
        const { course_id } = req.query;

        let sql = `
            SELECT 
                cm.*,
                c.name as course_name,
                c.subject as course_subject
            FROM course_materials cm
            LEFT JOIN courses c ON cm.course_id = c.id
            WHERE cm.is_published = TRUE
        `;
        const params: string[] = [];

        if (course_id && typeof course_id === 'string') {
            sql += ' AND cm.course_id = ?';
            params.push(course_id);
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

// Get material by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
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

        res.json(material);
    } catch (error) {
        console.error('Get material error:', error);
        res.status(500).json({ error: 'Failed to fetch material' });
    }
});

// Create new material
router.post('/', async (req: Request, res: Response) => {
    try {
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

        // For video type, file_url is required (Google Drive link)
        if (material_type === 'video' && !file_url) {
            return res.status(400).json({
                error: 'Video URL is required for video materials'
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
router.put('/:id', async (req: Request, res: Response) => {
    try {
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
router.delete('/:id', async (req: Request, res: Response) => {
    try {
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

