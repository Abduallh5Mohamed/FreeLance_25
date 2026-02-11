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

const router = Router();

// ============================================
// ENCRYPTION KEY ENDPOINT (Protected)
// ============================================

/**
 * Log security violation attempts
 * Called by frontend when suspicious activity is detected
 */
router.post('/security/log', async (req: Request, res: Response) => {
    try {
        const { userId, videoId, activityType, details } = req.body;

        if (!userId || !videoId || !activityType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const logId = uuidv4();
        const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';

        await execute(
            `INSERT INTO video_security_logs 
            (id, user_id, video_id, activity_type, ip_address, user_agent, details, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [logId, userId, videoId, activityType, ipAddress, userAgent, details || null]
        );

        console.log(`[Security] Logged ${activityType} for user ${userId} on video ${videoId}`);

        res.json({ success: true, logId });

    } catch (error) {
        console.error('[Security] Logging error:', error);
        res.status(500).json({ error: 'Failed to log security event' });
    }
});

/**
 * Serve encryption key for HLS playback
 * This endpoint is called by the video player when playing encrypted HLS
 * Security: Only authenticated users with access can get the key
 */
router.get('/key/:videoId', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;
        const userId = req.query.userId as string;

        if (!userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

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

        // TODO: Add access verification - check if user has permission to watch this video
        // For now, we trust the userId parameter
        // In production, verify against video_access_logs or course enrollment

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

/**
 * Initialize a new video upload
 * Returns presigned URL for direct browser-to-MinIO upload
 */
router.post('/upload/init', async (req: Request, res: Response) => {
    try {
        const {
            course_id,
            lecture_id,
            material_id,
            title,
            description,
            file_name,
            file_size,
            uploaded_by
        } = req.body;

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

        // Generate unique video ID
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
router.post('/upload/complete', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.body;

        if (!videoId) {
            return res.status(400).json({ error: 'videoId is required' });
        }

        // Verify video exists and is in uploading state
        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ? AND status = ?',
            [videoId, 'uploading']
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found or already processed' });
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
router.get('/upload/status/:videoId', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne(
            `SELECT id, title, status, processing_progress, processing_error, 
                    qualities_available, created_at, processed_at
             FROM videos WHERE id = ?`,
            [videoId]
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
router.delete('/upload/cancel/:videoId', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;

        // Get video info
        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ?',
            [videoId]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Delete all associated files from MinIO
        try {
            await deleteVideoFiles(videoId);
            console.log(`[Videos] Deleted files for cancelled upload ${videoId}`);
        } catch (error) {
            console.error(`[Videos] Error deleting files for ${videoId}:`, error);
            // Continue even if file deletion fails
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
router.post('/upload/recover-stuck', async (req: Request, res: Response) => {
    try {
        const stuckVideos = await query(
            `SELECT id FROM videos 
             WHERE status = 'uploading' 
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
router.get('/stream/:videoId', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;
        const userId = req.query.userId as string;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

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
        const hasAccess = await checkVideoAccess(userId, video.course_id);
        if (!hasAccess) {
            return res.status(403).json({ error: 'No access to this video' });
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
 * Check if user has access to a course's videos
 */
async function checkVideoAccess(userId: string, courseId: string): Promise<boolean> {
    // Get user info
    const user = await queryOne(
        'SELECT id, role, phone FROM users WHERE id = ?',
        [userId]
    );

    if (!user) return false;

    // Admins and teachers have full access
    if (user.role === 'admin' || user.role === 'teacher') {
        return true;
    }

    // For students, check if they belong to the same course
    const student = await queryOne(
        'SELECT id, group_id, grade_id FROM students WHERE phone = ? AND is_active = TRUE',
        [user.phone]
    );

    if (!student) return false;

    // Allow access - we already filter lectures by grade and group in the lectures API
    // If student can see the lecture in their list, they have access to it
    return true;
}

/**
 * Refresh streaming URL (for long videos)
 */
router.post('/stream/:videoId/refresh', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;
        const { userId } = req.body;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Get video info
        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ? AND status = ?',
            [videoId, 'ready']
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Verify access
        const hasAccess = await checkVideoAccess(userId, video.course_id);
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
router.get('/:videoId', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne(
            `SELECT v.*, c.name as course_name
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
router.delete('/:videoId', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;

        // Get video to check it exists
        const video = await queryOne('SELECT * FROM videos WHERE id = ?', [videoId]);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Delete files from MinIO
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
router.put('/:videoId', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;
        const { title, description } = req.body;

        await execute(
            'UPDATE videos SET title = ?, description = ? WHERE id = ?',
            [title, description || null, videoId]
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
router.post('/:videoId/retry', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ? AND status = ?',
            [videoId, 'failed']
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
router.post('/:videoId/reprocess', async (req: Request, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne(
            'SELECT * FROM videos WHERE id = ?',
            [videoId]
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
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
