"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const https_1 = __importDefault(require("https"));
const crypto_1 = __importDefault(require("crypto"));
const router = (0, express_1.Router)();
// Get all materials (with optional course filter)
router.get('/', async (req, res) => {
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
        const params = [];
        if (course_id && typeof course_id === 'string') {
            sql += ' AND cm.course_id = ?';
            params.push(course_id);
        }
        sql += ' ORDER BY cm.display_order ASC, cm.created_at DESC';
        const materials = await (0, db_1.query)(sql, params);
        // Fetch group_ids for each material
        for (const material of materials) {
            const groups = await (0, db_1.query)('SELECT group_id FROM material_groups WHERE material_id = ?', [material.id]);
            material.group_ids = groups.map((g) => g.group_id);
        }
        res.json(materials);
    }
    catch (error) {
        console.error('Get materials error:', error);
        res.status(500).json({ error: 'Failed to fetch materials' });
    }
});
// Get materials for a specific student based on their group
router.get('/student/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        // First check if there's a student record with this user_id
        // or if this is directly a student id
        let student = await (0, db_1.queryOne)('SELECT id, group_id FROM students WHERE id = ? AND is_active = TRUE', [userId]);
        // If not found by id, try to find by user_id from users table
        if (!student) {
            const userRecord = await (0, db_1.queryOne)('SELECT student_id FROM users WHERE id = ? AND role = "student"', [userId]);
            if (userRecord && userRecord.student_id) {
                student = await (0, db_1.queryOne)('SELECT id, group_id FROM students WHERE id = ? AND is_active = TRUE', [userRecord.student_id]);
            }
        }
        if (!student) {
            console.log(`Student not found for user/student id: ${userId}`);
            return res.json([]);
        }
        if (!student.group_id) {
            console.log(`Student ${userId} has no group assigned`);
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
        const materials = await (0, db_1.query)(sql, [student.group_id]);
        // Add group_ids to each material
        for (const material of materials) {
            const groups = await (0, db_1.query)('SELECT group_id FROM material_groups WHERE material_id = ?', [material.id]);
            material.group_ids = groups.map((g) => g.group_id);
        }
        res.json(materials);
    }
    catch (error) {
        console.error('Get student materials error:', error);
        res.status(500).json({ error: 'Failed to fetch materials' });
    }
});
// Get material by ID
router.get('/:id', async (req, res) => {
    try {
        const material = await (0, db_1.queryOne)(`SELECT 
                cm.*,
                c.name as course_name,
                c.subject as course_subject
            FROM course_materials cm
            LEFT JOIN courses c ON cm.course_id = c.id
            WHERE cm.id = ?`, [req.params.id]);
        if (!material) {
            return res.status(404).json({ error: 'Material not found' });
        }
        res.json(material);
    }
    catch (error) {
        console.error('Get material error:', error);
        res.status(500).json({ error: 'Failed to fetch material' });
    }
});
// Create new material
router.post('/', async (req, res) => {
    try {
        const { course_id, title, description, material_type, file_url, file_size, duration_minutes, display_order = 0, is_free = false, is_published = true, grade_id, group_ids } = req.body;
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
        const materialId = crypto_1.default.randomUUID();
        const result = await (0, db_1.execute)(`INSERT INTO course_materials 
            (id, course_id, title, description, material_type, file_url, file_size, 
             duration_minutes, display_order, is_free, is_published) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
        ]);
        // Insert material-group relationships if group_ids provided
        if (group_ids && Array.isArray(group_ids) && group_ids.length > 0) {
            // Validate that all group_ids exist
            for (const groupId of group_ids) {
                const groupExists = await (0, db_1.queryOne)('SELECT id FROM `groups` WHERE id = ? AND is_active = TRUE', [groupId]);
                if (!groupExists) {
                    console.warn(`Group ${groupId} not found or inactive, skipping...`);
                    continue;
                }
                await (0, db_1.execute)('INSERT INTO material_groups (material_id, group_id) VALUES (?, ?)', [materialId, groupId]);
            }
        }
        const newMaterial = await (0, db_1.queryOne)('SELECT * FROM course_materials WHERE id = ?', [materialId]);
        // Add grade_id and group_ids to response
        const materialWithGroups = {
            ...newMaterial,
            grade_id: grade_id || null,
            group_ids: group_ids || []
        };
        res.status(201).json(materialWithGroups);
    }
    catch (error) {
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
router.put('/:id', async (req, res) => {
    try {
        const { title, description, material_type, file_url, file_size, duration_minutes, display_order, is_free, is_published } = req.body;
        const result = await (0, db_1.execute)(`UPDATE course_materials 
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
             WHERE id = ?`, [
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
        ]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }
        const updatedMaterial = await (0, db_1.queryOne)('SELECT * FROM course_materials WHERE id = ?', [req.params.id]);
        res.json(updatedMaterial);
    }
    catch (error) {
        console.error('Update material error:', error);
        res.status(500).json({ error: 'Failed to update material' });
    }
});
// Delete material (soft delete by unpublishing)
router.delete('/:id', async (req, res) => {
    try {
        const result = await (0, db_1.execute)('UPDATE course_materials SET is_published = FALSE WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Material not found' });
        }
        res.json({ message: 'Material deleted successfully' });
    }
    catch (error) {
        console.error('Delete material error:', error);
        res.status(500).json({ error: 'Failed to delete material' });
    }
});
// Helper endpoint: Convert Google Drive sharing link to embeddable URL
router.post('/convert-drive-url', async (req, res) => {
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
    }
    catch (error) {
        console.error('Convert URL error:', error);
        res.status(500).json({ error: 'Failed to convert URL' });
    }
});
// Stream video from Google Drive
router.get('/stream/:fileId', async (req, res) => {
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
        https_1.default.get(driveUrl, (response) => {
            // Set appropriate headers for video streaming
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
            res.setHeader('Content-Length', response.headers['content-length'] || '');
            res.setHeader('Accept-Ranges', 'bytes');
            // Allow CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            response.pipe(res);
        }).on('error', (err) => {
            console.error('Stream error:', err);
            res.status(500).json({ error: 'Failed to stream video' });
        });
    }
    catch (error) {
        console.error('Stream error:', error);
        res.status(500).json({ error: 'Failed to stream video' });
    }
});
// Get direct download URL for Google Drive files
router.post('/get-stream-url', async (req, res) => {
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
    }
    catch (error) {
        console.error('Get stream URL error:', error);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});
exports.default = router;
