import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db';
import { v4 as uuidv4 } from 'uuid';
import {
    getPresignedUploadUrl,
    getSignedStreamUrl,
    getThumbnailUrl,
    initializeBuckets,
    BUCKETS
} from '../services/minio';
import { processVideo, deleteVideoFiles } from '../services/video-processor';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import {
    createManagedPlayback,
    createManagedUpload,
    deleteManagedVideo,
    getManagedVideoStatus,
    isManagedDrmEnabled,
    managedPlayerUrl,
} from '../services/vdocipher';

const router = Router();

// ============================================
// ENCRYPTION KEY ENDPOINT (Protected)
// ============================================

/**
 * Log security violation attempts
 * Called by frontend when suspicious activity is detected
 * Version 4.0 - Enhanced security logging with force logout support
 */
router.post('/security/log', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId, activityType, details } = req.body;
        const userId = req.user!.id;

        if (!userId || !videoId || !activityType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const logId = uuidv4();
        const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';

        // Enhanced logging with platform info
        const enhancedDetails = `${details || 'No details provided'} | IP: ${ipAddress}`;

        await execute(
            `INSERT INTO video_security_logs 
            (id, user_id, video_id, activity_type, ip_address, user_agent, details, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [logId, userId, videoId, activityType, ipAddress, userAgent, enhancedDetails]
        );

        // Log severity based on activity type
        const severeViolations = ['screenshot', 'screenrecord', 'devtools', 'alttab', 'focus_loss'];
        const severity = severeViolations.includes(activityType) ? '🚨 SEVERE' : '⚠️ Warning';
        
        console.log(`[Security] ${severity} - ${activityType} for user ${userId} on video ${videoId}`);
        console.log(`[Security] Details: ${enhancedDetails}`);
        console.log(`[Security] User-Agent: ${userAgent}`);

        // Count violations for this user
        const violationCount = await queryOne(
            `SELECT COUNT(*) as count FROM video_security_logs 
             WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
            [userId]
        );

        res.json({ 
            success: true, 
            logId,
            violationCount: violationCount?.count || 0,
            message: 'Violation logged'
        });

    } catch (error) {
        console.error('[Security] Logging error:', error);
        res.status(500).json({ error: 'Failed to log security event' });
    }
});

/**
 * Get security violations for a user (Admin endpoint)
 */
router.get('/security/violations/:userId', authenticateToken, requireRoles('admin'), async (req: Request, res: Response) => {
    try {
        const { userId } = req.params;
        const { limit = 50 } = req.query;

        const violations = await query(
            `SELECT * FROM video_security_logs 
             WHERE user_id = ? 
             ORDER BY created_at DESC 
             LIMIT ?`,
            [userId, parseInt(limit as string)]
        );

        const stats = await queryOne(
            `SELECT 
                COUNT(*) as total_violations,
                COUNT(DISTINCT video_id) as videos_affected,
                MAX(created_at) as last_violation
             FROM video_security_logs WHERE user_id = ?`,
            [userId]
        );

        res.json({ violations, stats });

    } catch (error) {
        console.error('[Security] Get violations error:', error);
        res.status(500).json({ error: 'Failed to get violations' });
    }
});

/**
 * Get all security violations (Admin dashboard)
 */
router.get('/security/all-violations', authenticateToken, requireRoles('admin'), async (req: Request, res: Response) => {
    try {
        const { limit = 100, hours = 24 } = req.query;

        const violations = await query(
            `SELECT vsl.*, u.name as user_name, u.phone as user_phone
             FROM video_security_logs vsl
             LEFT JOIN users u ON vsl.user_id = u.id
             WHERE vsl.created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
             ORDER BY vsl.created_at DESC
             LIMIT ?`,
            [parseInt(hours as string), parseInt(limit as string)]
        );

        const summary = await queryOne(
            `SELECT 
                COUNT(*) as total,
                COUNT(DISTINCT user_id) as unique_users,
                SUM(CASE WHEN activity_type IN ('screenshot', 'screenrecord') THEN 1 ELSE 0 END) as severe_count
             FROM video_security_logs 
             WHERE created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)`,
            [parseInt(hours as string)]
        );

        res.json({ violations, summary });

    } catch (error) {
        console.error('[Security] Get all violations error:', error);
        res.status(500).json({ error: 'Failed to get violations' });
    }
});

/**
 * Serve encryption key for HLS playback
 * This endpoint is called by the video player when playing encrypted HLS
 * Security: Only authenticated users with access can get the key
 */
router.get('/key/:videoId', authenticateToken, async (req: AuthRequest, res: Response) => {
    return res.status(410).json({ error: 'A live video session is required. Use /api/secure-video/key.' });
    /* legacy implementation intentionally unreachable */
    try {
        const { videoId } = req.params;
        const userId = req.user!.id;

        // Get video with encryption key
        const video = await queryOne(
            'SELECT id, encryption_key, is_encrypted FROM videos WHERE id = ?',
            [videoId]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (!video.is_encrypted || !video.encryption_key) {
            return res.status(400).json({ error: 'Video is not encrypted' });
        }

        const hasAccess = await checkVideoAccess(userId, video);
        if (!hasAccess) {
            return res.status(403).json({ error: 'No access to this video' });
        }

        // Convert hex key to binary
        const keyBuffer = Buffer.from(video.encryption_key, 'hex');

        // Send key as binary
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Length', keyBuffer.length.toString());
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        // Add CORS headers for HLS.js
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET');

        res.send(keyBuffer);

        console.log(`[Videos] Encryption key served for video ${videoId} to user ${userId}`);

    } catch (error) {
        console.error('[Videos] Key serving error:', error);
        res.status(500).json({ error: 'Failed to serve encryption key' });
    }
});

// ============================================
// UPLOAD ENDPOINTS (Teacher)
// ============================================

router.get('/drm/status', authenticateToken, (_req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        required: true,
        provider: 'encrypted-hls',
        configured: true,
        paid: false,
    });
});

/**
 * Initialize a new video upload
 * Returns presigned URL for direct browser-to-MinIO upload
 */
router.post('/upload/init', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const {
            course_id,
            lecture_id,
            material_id,
            title,
            description,
            file_name,
            file_size
        } = req.body;
        const uploaded_by = req.user!.id;

        // Validation
        if (!course_id || !title || !file_name || !uploaded_by) {
            return res.status(400).json({
                error: 'course_id, title, file_name, and uploaded_by are required'
            });
        }

        // Check file size limit (default 5GB)
        const maxSizeMB = parseInt(process.env.VIDEO_MAX_SIZE_MB || '5000');
        const fileSizeMB = file_size / (1024 * 1024);
        if (fileSizeMB > maxSizeMB) {
            return res.status(400).json({
                error: `File too large. Maximum size is ${maxSizeMB}MB`
            });
        }

        // Keep the platform UUID separate from the provider asset id so the
        // existing ownership and entitlement model remains unchanged.
        const videoId = uuidv4();

        // Get presigned upload URL
        const { uploadUrl, objectKey } = await getPresignedUploadUrl(
            videoId,
            file_name
        );

        // Create video record in database
        await execute(
            `INSERT INTO videos 
            (id, course_id, lecture_id, material_id, title, description, 
             file_size_bytes, original_key, uploaded_by, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
            [
                videoId,
                course_id,
                lecture_id || null,
                material_id || null,
                title,
                description || null,
                file_size,
                objectKey,
                uploaded_by
            ]
        );

        console.log(`[Videos] Initialized upload for video ${videoId}`);

        res.json({
            provider: 'minio',
            videoId,
            uploadUrl,
            objectKey,
            expiresIn: 3600, // 1 hour
            chunkSize: parseInt(process.env.VIDEO_CHUNK_SIZE_MB || '10') * 1024 * 1024
        });

    } catch (error) {
        console.error('[Videos] Upload init error:', error);
        res.status(500).json({ error: 'Failed to initialize upload' });
    }
});

/**
 * Complete upload and start processing
 * Called by frontend after successful upload to MinIO
 */
router.post('/upload/complete', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.body;

        if (!videoId) {
            return res.status(400).json({ error: 'videoId is required' });
        }

        // Verify video exists and is in uploading state
        const video = await queryOne<any>(
            'SELECT * FROM videos WHERE id = ? AND status = ? AND uploaded_by = ?',
            [videoId, 'uploading', req.user!.id]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found or already processed' });
        }

        if (video.delivery_provider === 'vdocipher') {
            return res.status(409).json({ error: 'Legacy managed videos must be uploaded again to encrypted HLS.' });
        }

        // Add to processing queue
        await execute(
            `INSERT INTO video_processing_queue (id, video_id, status, created_at)
            VALUES (?, ?, 'pending', NOW())
            ON DUPLICATE KEY UPDATE status = 'pending', created_at = NOW()`,
            [uuidv4(), videoId]
        );

        // Start processing in background (don't await)
        processVideoAsync(videoId);

        console.log(`[Videos] Upload complete for ${videoId}, processing started`);

        res.json({
            success: true,
            videoId,
            status: 'processing',
            message: 'Video upload complete. Processing started.'
        });

    } catch (error) {
        console.error('[Videos] Upload complete error:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
});

/**
 * Process video asynchronously
 */
async function processVideoAsync(videoId: string): Promise<void> {
    try {
        await processVideo(videoId);
    } catch (error) {
        console.error(`[Videos] Async processing failed for ${videoId}:`, error);
    }
}

/**
 * Get upload progress/status
 */
router.get('/upload/status/:videoId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne<any>(
            `SELECT id, title, status, processing_progress, processing_error, 
                    qualities_available, created_at, processed_at, delivery_provider,
                    drm_asset_id, drm_preview_asset_id, drm_status, drm_last_synced_at,
                    preview_status, duration_seconds
             FROM videos WHERE id = ? AND uploaded_by = ?`,
            [videoId, req.user!.id]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        res.json(video);

    } catch (error) {
        console.error('[Videos] Status check error:', error);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

/**
 * Cancel upload and delete associated files
 */
router.delete('/upload/cancel/:videoId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        // Get video info
        const video = await queryOne<any>(
            'SELECT * FROM videos WHERE id = ? AND uploaded_by = ?',
            [videoId, req.user!.id]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        try {
            await deleteVideoFiles(videoId);
            console.log(`[Videos] Deleted files for cancelled upload ${videoId}`);
        } catch (error) {
            console.error(`[Videos] Error deleting files for ${videoId}:`, error);
        }

        // Delete from processing queue
        await execute(
            'DELETE FROM video_processing_queue WHERE video_id = ?',
            [videoId]
        );

        // Delete video record
        await execute('DELETE FROM videos WHERE id = ?', [videoId]);

        console.log(`[Videos] Cancelled and deleted upload ${videoId}`);

        res.json({
            success: true,
            message: 'Upload cancelled and files deleted'
        });

    } catch (error) {
        console.error('[Videos] Cancel upload error:', error);
        res.status(500).json({ error: 'Failed to cancel upload' });
    }
});

/**
 * Recover stuck uploads - finds videos stuck at 'uploading' for more than 5 minutes
 * and triggers processing (processor will handle missing files gracefully)
 */
router.post('/upload/recover-stuck', authenticateToken, requireRoles('admin'), async (req: Request, res: Response) => {
    try {
        const stuckVideos = await query(
            `SELECT id FROM videos 
             WHERE status = 'uploading' AND delivery_provider = 'minio'
             AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)`,
            []
        );

        if (!stuckVideos || stuckVideos.length === 0) {
            return res.json({ recovered: 0, message: 'No stuck uploads found' });
        }

        let recovered = 0;
        for (const video of stuckVideos) {
            try {
                await execute(
                    `INSERT INTO video_processing_queue (id, video_id, status, created_at)
                    VALUES (?, ?, 'pending', NOW())
                    ON DUPLICATE KEY UPDATE status = 'pending', created_at = NOW()`,
                    [uuidv4(), video.id]
                );
                processVideoAsync(video.id);
                recovered++;
                console.log(`[Videos] Recovered stuck upload ${video.id}`);
            } catch (err) {
                console.error(`[Videos] Error recovering ${video.id}:`, err);
            }
        }

        res.json({ recovered, total: stuckVideos.length });

    } catch (error) {
        console.error('[Videos] Recover stuck error:', error);
        res.status(500).json({ error: 'Failed to recover stuck uploads' });
    }
});

// ============================================
// STREAMING ENDPOINTS (Student)
// ============================================

/**
 * Get secure streaming URL for a video
 * Verifies student has access before providing URL
 */
router.get('/stream/:videoId', authenticateToken, async (req: AuthRequest, res: Response) => {
    return res.status(410).json({ error: 'Direct stream URLs are disabled. Create a secure video session.' });
    /* legacy implementation intentionally unreachable */
    try {
        const { videoId } = req.params;
        const userId = req.user!.id;

        // Get video info
        const video = await queryOne(
            `SELECT v.*, c.name as course_name 
             FROM videos v
             LEFT JOIN courses c ON v.course_id = c.id
             WHERE v.id = ? AND v.status = 'ready'`,
            [videoId]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found or not ready' });
        }

        // Check if user has access (subscription check)
        const hasAccess = await checkVideoAccess(userId, video);
        if (!hasAccess) {
            return res.status(403).json({ error: 'No access to this video' });
        }

        if (process.env.VIDEO_DRM_REQUIRED === 'true' && video.delivery_provider !== 'vdocipher') {
            return res.status(409).json({
                error: 'This legacy video must be migrated to DRM before it can be played',
                code: 'DRM_MIGRATION_REQUIRED',
            });
        }

        if (video.delivery_provider === 'vdocipher') {
            if (!isManagedDrmEnabled() || !video.drm_asset_id) {
                return res.status(503).json({ error: 'DRM playback is temporarily unavailable', code: 'DRM_NOT_CONFIGURED' });
            }
            const viewer = await queryOne<any>('SELECT id,name,phone,email FROM users WHERE id=?', [userId]);
            const playback = await createManagedPlayback(video.drm_asset_id, {
                id: userId,
                name: viewer?.name || 'Platform viewer',
                phone: viewer?.phone,
                email: viewer?.email,
            });
            await execute(
                `INSERT INTO video_access_logs (video_id, user_id, ip_address, user_agent)
                 VALUES (?, ?, ?, ?)`,
                [videoId, userId, req.ip || 'unknown', req.get('User-Agent') || 'unknown']
            );
            res.set('Cache-Control', 'no-store, private');
            return res.json({
                provider: 'vdocipher',
                videoId,
                title: video.title,
                duration: video.duration_seconds,
                playerUrl: managedPlayerUrl(playback),
                expiresIn: 300,
            });
        }

        // Generate signed streaming URL
        // Check if HLS is available, otherwise use original
        let streamUrl;
        if (video.hls_key && video.hls_key !== video.original_key) {
            // Use HLS if processed
            streamUrl = await getSignedStreamUrl(videoId, 'playlist.m3u8');
        } else {
            // Use original file directly
            streamUrl = await getSignedStreamUrl(videoId, video.original_key, BUCKETS.ORIGINALS);
        }

        const thumbnailUrl = await getThumbnailUrl(videoId);

        // Log access
        await execute(
            `INSERT INTO video_access_logs (video_id, user_id, ip_address, user_agent)
             VALUES (?, ?, ?, ?)`,
            [
                videoId,
                userId,
                req.ip || 'unknown',
                req.get('User-Agent') || 'unknown'
            ]
        );

        // Parse qualities safely
        let qualities = [];
        if (video.qualities_available) {
            try {
                qualities = JSON.parse(video.qualities_available);
            } catch (e) {
                console.warn('[Videos] Invalid JSON in qualities_available:', video.qualities_available);
                qualities = ['original']; // Default to original
            }
        }

        res.json({
            videoId,
            title: video.title,
            description: video.description,
            duration: video.duration_seconds,
            qualities,
            streamUrl,
            thumbnailUrl,
            expiresIn: parseInt(process.env.SIGNED_URL_EXPIRY || '600')
        });

    } catch (error) {
        console.error('[Videos] Stream error:', error);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});

/**
 * Check if user has access to a video
 */
async function checkVideoAccess(userId: string, video: any): Promise<boolean> {
    // Get user info
    const user = await queryOne(
        'SELECT id, role, phone FROM users WHERE id = ?',
        [userId]
    );

    if (!user) return false;

    // Admins, teachers and staff have full access
    if (user.role === 'admin' || user.role === 'teacher' || user.role === 'staff') {
        return true;
    }

    // Instructors: can play videos they own (uploaded to their lecture)
    // or videos that were explicitly shared with them (approved video requests)
    if (user.role === 'instructor') {
        const lecture = await queryOne(
            `SELECT id, instructor_id FROM lectures
             WHERE video_url = CONCAT('video://', ?)
             LIMIT 1`,
            [video.id]
        );

        if (!lecture) return false;

        // Owner of the lecture containing this video
        if (String(lecture.instructor_id) === String(userId)) {
            return true;
        }

        // Approved share via instructor video requests
        const shared = await queryOne(
            `SELECT id FROM instructor_shared_lectures
             WHERE instructor_id = ? AND lecture_id = ?`,
            [userId, lecture.id]
        );

        return !!shared;
    }

    // For students, check if they belong to the same course
    const student = await queryOne(
        'SELECT id, group_id, grade_id, instructor_id FROM students WHERE phone = ? AND is_active = TRUE',
        [user.phone]
    );

    if (!student) return false;
    const permitted = await queryOne(
        `SELECT l.id FROM lectures l
         WHERE l.video_url=CONCAT('video://',?) AND (
           (l.is_published=1 AND (l.instructor_id IS NULL OR l.instructor_id=?)
             AND (l.grade_id=? OR l.group_id=?))
           OR EXISTS (
             SELECT 1 FROM instructor_shared_lectures sl
             JOIN instructor_shared_lecture_publications pub ON pub.shared_lecture_id=sl.id
             WHERE sl.lecture_id=l.id AND sl.instructor_id=? AND sl.is_published=1 AND pub.group_id=?
           )
         ) LIMIT 1`,
        [video.id, student.instructor_id, student.grade_id, student.group_id, student.instructor_id, student.group_id]
    );
    return !!permitted;
}

/**
 * Refresh streaming URL (for long videos)
 */
router.post('/stream/:videoId/refresh', authenticateToken, async (req: AuthRequest, res: Response) => {
    return res.status(410).json({ error: 'Direct stream URLs are disabled. Refresh the secure video session.' });
    /* legacy implementation intentionally unreachable */
    try {
        const { videoId } = req.params;
        const userId = req.user!.id;

        // Get video info
        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ? AND status = ?',
            [videoId, 'ready']
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Verify access
        const hasAccess = await checkVideoAccess(userId, video);
        if (!hasAccess) {
            return res.status(403).json({ error: 'No access to this video' });
        }

        // Generate new signed URL
        const streamUrl = await getSignedStreamUrl(videoId, 'playlist.m3u8');

        res.json({
            streamUrl,
            expiresIn: parseInt(process.env.SIGNED_URL_EXPIRY || '600')
        });

    } catch (error) {
        console.error('[Videos] Refresh stream error:', error);
        res.status(500).json({ error: 'Failed to refresh stream URL' });
    }
});

// ============================================
// MANAGEMENT ENDPOINTS
// ============================================

/**
 * Get all videos for a course
 */
router.get('/course/:courseId', async (req: Request, res: Response) => {
    try {
        const { courseId } = req.params;

        const videos = await query(
            `SELECT id, title, description, duration_seconds, status, 
                    processing_progress, qualities_available, 
                    created_at, processed_at
             FROM videos 
             WHERE course_id = ?
             ORDER BY created_at DESC`,
            [courseId]
        );

        // Add thumbnail URLs
        for (const video of videos) {
            if (video.status === 'ready') {
                video.thumbnailUrl = await getThumbnailUrl(video.id);
            }
        }

        res.json(videos);

    } catch (error) {
        console.error('[Videos] Get course videos error:', error);
        res.status(500).json({ error: 'Failed to get videos' });
    }
});

/**
 * Get single video details
 */
router.get('/:videoId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne(
            `SELECT v.id,v.course_id,v.lecture_id,v.material_id,v.title,v.description,v.duration_seconds,
                    v.status,v.processing_progress,v.qualities_available,v.preview_status,v.created_at,v.processed_at,
                    c.name as course_name
             FROM videos v
             LEFT JOIN courses c ON v.course_id = c.id
             WHERE v.id = ?`,
            [videoId]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (video.status === 'ready') {
            video.thumbnailUrl = await getThumbnailUrl(videoId);
        }

        res.json(video);

    } catch (error) {
        console.error('[Videos] Get video error:', error);
        res.status(500).json({ error: 'Failed to get video' });
    }
});

/**
 * Delete a video
 */
router.delete('/:videoId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        // Get video to check it exists
        const video = await queryOne('SELECT * FROM videos WHERE id = ? AND uploaded_by=?', [videoId, req.user!.id]);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        const referenced = await queryOne(`SELECT 1 referenced FROM lectures l
          WHERE l.video_url=CONCAT('video://',?) AND (
            EXISTS (SELECT 1 FROM instructor_shared_lectures sl WHERE sl.lecture_id=l.id)
            OR EXISTS (SELECT 1 FROM instructor_video_offers o WHERE o.lecture_id=l.id)
          ) LIMIT 1`, [videoId]);
        if (referenced) {
            await execute("UPDATE lectures SET archived_at=UTC_TIMESTAMP(),is_published=0 WHERE video_url=CONCAT('video://',?) AND instructor_id=?", [videoId, req.user!.id]);
            return res.json({ success: true, archived: true, message: 'Video archived; purchased access remains active' });
        }

        await deleteVideoFiles(videoId);

        // Delete from database (cascades to related tables)
        await execute('DELETE FROM videos WHERE id = ?', [videoId]);

        console.log(`[Videos] Deleted video ${videoId}`);

        res.json({ success: true, message: 'Video deleted' });

    } catch (error) {
        console.error('[Videos] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete video' });
    }
});

/**
 * Update video metadata
 */
router.put('/:videoId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;
        const { title, description } = req.body;

        await execute(
            'UPDATE videos SET title = ?, description = ? WHERE id = ? AND uploaded_by=?',
            [title, description || null, videoId, req.user!.id]
        );

        const video = await queryOne('SELECT * FROM videos WHERE id = ?', [videoId]);

        res.json(video);

    } catch (error) {
        console.error('[Videos] Update error:', error);
        res.status(500).json({ error: 'Failed to update video' });
    }
});

/**
 * Retry failed processing
 */
router.post('/:videoId/retry', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ? AND status = ? AND uploaded_by=?',
            [videoId, 'failed', req.user!.id]
        );

        if (!video) {
            return res.status(404).json({
                error: 'Video not found or not in failed state'
            });
        }

        // Reset status
        await execute(
            `UPDATE videos SET status = 'uploading', 
             processing_progress = 0, processing_error = NULL 
             WHERE id = ?`,
            [videoId]
        );

        // Re-queue for processing
        processVideoAsync(videoId);

        res.json({ success: true, message: 'Processing restarted' });

    } catch (error) {
        console.error('[Videos] Retry error:', error);
        res.status(500).json({ error: 'Failed to retry processing' });
    }
});

/**
 * Re-process a video (force)
 */
router.post('/:videoId/reprocess', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ? AND uploaded_by=?',
            [videoId, req.user!.id]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (video.delivery_provider === 'vdocipher') {
            return res.status(409).json({ error: 'Managed DRM videos are re-encoded by the provider and cannot be locally reprocessed' });
        }

        console.log(`[Videos] Force reprocessing video ${videoId}`);

        // Reset status
        await execute(
            `UPDATE videos SET status = 'processing', 
             processing_progress = 0, processing_error = NULL 
             WHERE id = ?`,
            [videoId]
        );

        // Re-queue for processing
        processVideoAsync(videoId);

        res.json({ success: true, message: 'Processing started' });

    } catch (error) {
        console.error('[Videos] Reprocess error:', error);
        res.status(500).json({ error: 'Failed to reprocess video' });
    }
});

/**
 * Placeholder thumbnail endpoint
 */
router.get('/placeholder-thumbnail', (req: Request, res: Response) => {
    // Return a simple placeholder SVG
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(`
        <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
            <rect fill="#1a1a2e" width="640" height="360"/>
            <polygon fill="#4a4a6a" points="280,120 280,240 380,180"/>
            <text x="320" y="300" text-anchor="middle" fill="#666" font-size="14">Video</text>
        </svg>
    `);
});

// ============================================
// ANALYTICS ENDPOINTS
// ============================================

/**
 * Get video analytics
 */
router.get('/:videoId/analytics', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;

        const stats = await queryOne(
            `SELECT 
                COUNT(*) as total_views,
                COUNT(DISTINCT user_id) as unique_viewers,
                AVG(watch_duration_seconds) as avg_watch_time
             FROM video_access_logs 
             WHERE video_id = ?`,
            [videoId]
        );

        const recentViews = await query(
            `SELECT DATE(accessed_at) as date, COUNT(*) as views
             FROM video_access_logs 
             WHERE video_id = ?
             AND accessed_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY DATE(accessed_at)
             ORDER BY date DESC`,
            [videoId]
        );

        res.json({
            ...stats,
            recentViews
        });

    } catch (error) {
        console.error('[Videos] Analytics error:', error);
        res.status(500).json({ error: 'Failed to get analytics' });
    }
});

export default router;
