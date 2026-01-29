import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import {
    downloadFile,
    uploadFile,
    deleteFile,
    BUCKETS
} from './minio';
import { execute, queryOne } from '../db';

// Set FFmpeg paths if specified in environment
if (process.env.FFMPEG_PATH) {
    ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}
if (process.env.FFPROBE_PATH) {
    ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
}

// Temporary directory for processing
const TEMP_DIR = process.env.VIDEO_TEMP_DIR || '/tmp/video-processing';
const FFMPEG_THREADS = parseInt(process.env.FFMPEG_THREADS || '2');
const HLS_SEGMENT_DURATION = parseInt(process.env.HLS_SEGMENT_DURATION || '10');

// AES-128 Encryption settings
const ENABLE_ENCRYPTION = process.env.ENABLE_VIDEO_ENCRYPTION !== 'false'; // Enabled by default
const ENCRYPTION_KEY_URL = process.env.ENCRYPTION_KEY_URL || '/api/videos/key'; // URL where key is served

// Quality presets (optimized for educational content)
interface QualityPreset {
    name: string;
    height: number;
    videoBitrate: string;
    audioBitrate: string;
    maxrate: string;
    bufsize: string;
}

const QUALITY_PRESETS: QualityPreset[] = [
    {
        name: '360p',
        height: 360,
        videoBitrate: '800k',
        audioBitrate: '96k',
        maxrate: '856k',
        bufsize: '1200k'
    },
    {
        name: '720p',
        height: 720,
        videoBitrate: '2500k',
        audioBitrate: '128k',
        maxrate: '2700k',
        bufsize: '3500k'
    }
];

/**
 * Ensure temp directory exists
 */
async function ensureTempDir(): Promise<void> {
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true });
    }
}

/**
 * Get video metadata using ffprobe
 */
export async function getVideoMetadata(filePath: string): Promise<{
    duration: number;
    width: number;
    height: number;
    codec: string;
    bitrate: number;
}> {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }

            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const format = metadata.format;

            resolve({
                duration: Math.floor(format.duration || 0),
                width: videoStream?.width || 1920,
                height: videoStream?.height || 1080,
                codec: videoStream?.codec_name || 'unknown',
                bitrate: Math.floor((format.bit_rate || 0) / 1000) // kbps
            });
        });
    });
}

/**
 * Generate thumbnail from video
 */
export async function generateThumbnail(
    videoPath: string,
    outputPath: string,
    timestamp: string = '00:00:05'
): Promise<void> {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: [timestamp],
                filename: path.basename(outputPath),
                folder: path.dirname(outputPath),
                size: '640x360'
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });
}

/**
 * Convert video to HLS format with multiple quality levels
 * Now with AES-128 encryption support!
 */
export async function convertToHLS(
    videoId: string,
    inputPath: string,
    outputDir: string,
    onProgress?: (progress: number) => void,
    encryptionKeyInfo?: string
): Promise<string[]> {
    const qualities: string[] = [];

    // Get original video metadata to determine which qualities to generate
    const metadata = await getVideoMetadata(inputPath);

    // Filter presets based on source video height
    const applicablePresets = QUALITY_PRESETS.filter(p => p.height <= metadata.height);

    // If source is smaller than 360p, just use source
    if (applicablePresets.length === 0) {
        applicablePresets.push(QUALITY_PRESETS[0]); // Use 360p settings
    }

    let processedQualities = 0;

    for (const preset of applicablePresets) {
        const qualityDir = path.join(outputDir, preset.name);
        await fs.mkdir(qualityDir, { recursive: true });

        await new Promise<void>((resolve, reject) => {
            const outputPlaylist = path.join(qualityDir, 'playlist.m3u8');

            // Build output options
            const outputOptions = [
                // Video encoding
                '-c:v libx264',
                '-preset medium',
                '-profile:v main',
                `-vf scale=-2:${preset.height}`,
                `-b:v ${preset.videoBitrate}`,
                `-maxrate ${preset.maxrate}`,
                `-bufsize ${preset.bufsize}`,

                // Audio encoding
                '-c:a aac',
                `-b:a ${preset.audioBitrate}`,
                '-ar 44100',

                // HLS options
                '-f hls',
                `-hls_time ${HLS_SEGMENT_DURATION}`,
                '-hls_playlist_type vod',
                '-hls_segment_filename', path.join(qualityDir, 'segment_%03d.ts'),

                // Threading
                `-threads ${FFMPEG_THREADS}`,

                // Optimize for streaming
                '-movflags +faststart',
                '-g 48',
                '-keyint_min 48',

                // Force pixel format for compatibility
                '-pix_fmt yuv420p'
            ];

            // Add encryption if key info is provided
            if (encryptionKeyInfo && ENABLE_ENCRYPTION) {
                outputOptions.push('-hls_key_info_file', encryptionKeyInfo);
                console.log(`[FFmpeg] Encryption enabled for ${preset.name}`);
            }

            ffmpeg(inputPath)
                .outputOptions(outputOptions)
                .output(outputPlaylist)
                .on('progress', (progress) => {
                    if (onProgress && progress.percent) {
                        // Calculate overall progress across all qualities
                        const qualityProgress = (processedQualities / applicablePresets.length) * 100;
                        const currentProgress = (progress.percent / applicablePresets.length);
                        onProgress(Math.floor(qualityProgress + currentProgress));
                    }
                })
                .on('end', () => {
                    qualities.push(preset.name);
                    processedQualities++;
                    console.log(`[FFmpeg] Completed ${preset.name} for video ${videoId}`);
                    resolve();
                })
                .on('error', (err) => {
                    console.error(`[FFmpeg] Error processing ${preset.name}:`, err);
                    reject(err);
                })
                .run();
        });
    }

    // Generate master playlist
    await generateMasterPlaylist(outputDir, qualities);

    return qualities;
}

/**
 * Generate master HLS playlist that references all quality levels
 */
async function generateMasterPlaylist(outputDir: string, qualities: string[]): Promise<void> {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

    for (const quality of qualities) {
        const preset = QUALITY_PRESETS.find(p => p.name === quality);
        if (preset) {
            const bandwidth = parseInt(preset.videoBitrate) * 1000;
            lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${getResolution(preset.height)}`);
            lines.push(`${quality}/playlist.m3u8`);
        }
    }

    const masterPlaylistPath = path.join(outputDir, 'playlist.m3u8');
    await fs.writeFile(masterPlaylistPath, lines.join('\n'));
    console.log(`[FFmpeg] Generated master playlist at ${masterPlaylistPath}`);
}

function getResolution(height: number): string {
    const aspectRatio = 16 / 9;
    const width = Math.floor(height * aspectRatio);
    return `${width}x${height}`;
}

/**
 * Generate AES-128 encryption key and key info file for HLS
 */
async function generateEncryptionKey(videoId: string, outputDir: string): Promise<{
    keyPath: string;
    keyInfoPath: string;
    keyHex: string;
    ivHex: string;
}> {
    // Generate random 16-byte key
    const key = crypto.randomBytes(16);
    const keyHex = key.toString('hex');
    
    // Generate random IV
    const iv = crypto.randomBytes(16);
    const ivHex = iv.toString('hex');
    
    // Save key file
    const keyPath = path.join(outputDir, 'encryption.key');
    await fs.writeFile(keyPath, key);
    
    // Create key info file for FFmpeg
    // Format: key URL\nkey file path\nIV (optional)
    const apiBase = process.env.API_BASE_URL || 'http://localhost:3001';
    const keyUrl = `${apiBase}/api/videos/key/${videoId}`;
    const keyInfoContent = `${keyUrl}\n${keyPath}\n${ivHex}`;
    const keyInfoPath = path.join(outputDir, 'enc.keyinfo');
    await fs.writeFile(keyInfoPath, keyInfoContent);
    
    console.log(`[Encryption] Generated AES-128 key for video ${videoId}`);
    
    return { keyPath, keyInfoPath, keyHex, ivHex };
}

/**
 * Process a video: download, convert to HLS, upload to MinIO
 * In dev mode without FFmpeg, just mark as ready with original URL
 */
export async function processVideo(videoId: string): Promise<void> {
    console.log(`[VideoProcessor] Starting processing for video ${videoId}`);

    // Check if FFmpeg is available
    const ffmpegAvailable = await checkFfmpegAvailable();
    
    if (!ffmpegAvailable) {
        console.log(`[VideoProcessor] FFmpeg not available - using simple upload mode`);
        await processVideoSimple(videoId);
        return;
    }

    await ensureTempDir();
    const workDir = path.join(TEMP_DIR, videoId);
    await fs.mkdir(workDir, { recursive: true });

    try {
        // Update status to processing
        await execute(
            'UPDATE videos SET status = ?, processing_progress = ? WHERE id = ?',
            ['processing', 0, videoId]
        );

        // Get video info from database
        const video = await queryOne('SELECT * FROM videos WHERE id = ?', [videoId]);
        if (!video) {
            throw new Error(`Video ${videoId} not found in database`);
        }

        // Download original from MinIO
        const originalPath = path.join(workDir, 'original.mp4');
        console.log(`[VideoProcessor] Downloading original video...`);
        await downloadFile(BUCKETS.ORIGINALS, video.original_key, originalPath);

        // Get metadata
        const metadata = await getVideoMetadata(originalPath);
        console.log(`[VideoProcessor] Video metadata:`, metadata);

        // Update duration in database
        await execute(
            'UPDATE videos SET duration_seconds = ?, processing_progress = ? WHERE id = ?',
            [metadata.duration, 10, videoId]
        );

        // Generate thumbnail
        const thumbnailPath = path.join(workDir, 'thumbnail.jpg');
        console.log(`[VideoProcessor] Generating thumbnail...`);
        await generateThumbnail(originalPath, thumbnailPath);

        // Upload thumbnail to MinIO
        const thumbnailKey = `${videoId}.jpg`;
        await uploadFile(BUCKETS.THUMBNAILS, thumbnailKey, thumbnailPath, 'image/jpeg');
        await execute(
            'UPDATE videos SET thumbnail_key = ?, processing_progress = ? WHERE id = ?',
            [thumbnailKey, 20, videoId]
        );

        // Convert to HLS
        const hlsDir = path.join(workDir, 'hls');
        await fs.mkdir(hlsDir, { recursive: true });

        // Generate encryption key if encryption is enabled
        let encryptionKeyInfo: string | undefined;
        let encryptionData: { keyHex: string; ivHex: string } | undefined;
        
        if (ENABLE_ENCRYPTION) {
            console.log(`[VideoProcessor] Generating encryption key...`);
            const encryption = await generateEncryptionKey(videoId, workDir);
            encryptionKeyInfo = encryption.keyInfoPath;
            encryptionData = { keyHex: encryption.keyHex, ivHex: encryption.ivHex };
        }

        console.log(`[VideoProcessor] Converting to HLS${ENABLE_ENCRYPTION ? ' with AES-128 encryption' : ''}...`);
        const qualities = await convertToHLS(videoId, originalPath, hlsDir, async (progress) => {
            // Progress from 20% to 90% during conversion
            const adjustedProgress = 20 + (progress * 0.7);
            await execute(
                'UPDATE videos SET processing_progress = ? WHERE id = ?',
                [Math.floor(adjustedProgress), videoId]
            );
        }, encryptionKeyInfo);

        // Upload HLS files to MinIO
        console.log(`[VideoProcessor] Uploading HLS files to MinIO...`);
        await uploadHLSFiles(videoId, hlsDir);

        // Update database with final info (including encryption key if encrypted)
        const updateQuery = encryptionData 
            ? `UPDATE videos SET 
                status = ?, 
                processing_progress = 100,
                hls_key = ?,
                qualities_available = ?,
                encryption_key = ?,
                encryption_iv = ?,
                is_encrypted = 1,
                processed_at = NOW()
            WHERE id = ?`
            : `UPDATE videos SET 
                status = ?, 
                processing_progress = 100,
                hls_key = ?,
                qualities_available = ?,
                processed_at = NOW()
            WHERE id = ?`;
        
        const updateParams = encryptionData
            ? ['ready', `${videoId}/playlist.m3u8`, JSON.stringify(qualities), encryptionData.keyHex, encryptionData.ivHex, videoId]
            : ['ready', `${videoId}/playlist.m3u8`, JSON.stringify(qualities), videoId];

        await execute(updateQuery, updateParams);

        console.log(`[VideoProcessor] Completed processing for video ${videoId}${ENABLE_ENCRYPTION ? ' (encrypted)' : ''}`);

    } catch (error) {
        console.error(`[VideoProcessor] Error processing video ${videoId}:`, error);

        await execute(
            'UPDATE videos SET status = ?, processing_error = ? WHERE id = ?',
            ['failed', error instanceof Error ? error.message : 'Unknown error', videoId]
        );

        throw error;
    } finally {
        // Cleanup temp files
        try {
            await fs.rm(workDir, { recursive: true, force: true });
            console.log(`[VideoProcessor] Cleaned up temp directory for ${videoId}`);
        } catch (cleanupError) {
            console.error(`[VideoProcessor] Error cleaning up:`, cleanupError);
        }
    }
}

/**
 * Upload all HLS files to MinIO
 */
async function uploadHLSFiles(videoId: string, hlsDir: string): Promise<void> {
    const files = await getAllFiles(hlsDir);

    for (const file of files) {
        const relativePath = path.relative(hlsDir, file);
        const objectKey = `${videoId}/${relativePath.replace(/\\/g, '/')}`;

        const contentType = file.endsWith('.m3u8')
            ? 'application/x-mpegURL'
            : 'video/mp2t';

        await uploadFile(BUCKETS.HLS, objectKey, file, contentType);
    }

    console.log(`[VideoProcessor] Uploaded ${files.length} HLS files for video ${videoId}`);
}

/**
 * Recursively get all files in a directory
 */
async function getAllFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await getAllFiles(fullPath));
        } else {
            files.push(fullPath);
        }
    }

    return files;
}

/**
 * Delete all processed files for a video
 */
export async function deleteVideoFiles(videoId: string): Promise<void> {
    const video = await queryOne('SELECT * FROM videos WHERE id = ?', [videoId]);

    if (video) {
        // Delete original
        if (video.original_key) {
            try {
                await deleteFile(BUCKETS.ORIGINALS, video.original_key);
            } catch (e) {
                console.warn(`[VideoProcessor] Could not delete original:`, e);
            }
        }

        // Delete thumbnail
        if (video.thumbnail_key) {
            try {
                await deleteFile(BUCKETS.THUMBNAILS, video.thumbnail_key);
            } catch (e) {
                console.warn(`[VideoProcessor] Could not delete thumbnail:`, e);
            }
        }

        // Delete HLS files (using prefix)
        try {
            const { deleteByPrefix } = await import('./minio');
            await deleteByPrefix(BUCKETS.HLS, `${videoId}/`);
        } catch (e) {
            console.warn(`[VideoProcessor] Could not delete HLS files:`, e);
        }
    }
}

/**
 * Check if FFmpeg is available
 */
async function checkFfmpegAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            ffmpeg.getAvailableFormats((err, formats) => {
                if (err) {
                    console.log('[VideoProcessor] FFmpeg check failed:', err.message);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        } catch (e) {
            resolve(false);
        }
    });
}

/**
 * Simple video processing without FFmpeg
 * Just marks the video as ready using the original file
 */
async function processVideoSimple(videoId: string): Promise<void> {
    console.log(`[VideoProcessor] Simple processing for video ${videoId}`);

    try {
        // Update status to processing
        await execute(
            'UPDATE videos SET status = ?, processing_progress = ? WHERE id = ?',
            ['processing', 50, videoId]
        );

        // Get video info from database
        const video = await queryOne('SELECT * FROM videos WHERE id = ?', [videoId]);
        if (!video) {
            throw new Error(`Video ${videoId} not found in database`);
        }

        // Mark as ready without HLS conversion
        // The original file will be used for playback
        await execute(
            `UPDATE videos SET 
                status = ?, 
                processing_progress = 100,
                hls_key = ?,
                qualities_available = ?,
                processed_at = NOW()
            WHERE id = ?`,
            [
                'ready',
                video.original_key, // Use original as playback source
                JSON.stringify(['original']),
                videoId
            ]
        );

        console.log(`[VideoProcessor] Simple processing completed for video ${videoId}`);

    } catch (error) {
        console.error(`[VideoProcessor] Error in simple processing for video ${videoId}:`, error);

        await execute(
            'UPDATE videos SET status = ?, processing_error = ? WHERE id = ?',
            ['error', error instanceof Error ? error.message : 'Unknown error', videoId]
        );

        throw error;
    }
}

// Export for use in queue workers
export default {
    processVideo,
    getVideoMetadata,
    generateThumbnail,
    convertToHLS,
    deleteVideoFiles
};
