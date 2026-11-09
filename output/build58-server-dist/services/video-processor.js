"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isVideoInTenantScope = void 0;
exports.getVideoMetadata = getVideoMetadata;
exports.generateThumbnail = generateThumbnail;
exports.generatePreview = generatePreview;
exports.convertToHLS = convertToHLS;
exports.processVideo = processVideo;
exports.deleteVideoFiles = deleteVideoFiles;
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
const ffprobe_static_1 = __importDefault(require("ffprobe-static"));
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const fs_1 = require("fs");
const crypto_1 = __importDefault(require("crypto"));
const minio_1 = require("./minio");
const db_1 = require("../db");
// Set FFmpeg paths if specified in environment
const ffmpegBinary = process.env.FFMPEG_PATH || ffmpeg_static_1.default;
const ffprobeBinary = process.env.FFPROBE_PATH || ffprobe_static_1.default.path;
if (ffmpegBinary)
    fluent_ffmpeg_1.default.setFfmpegPath(ffmpegBinary);
if (ffprobeBinary)
    fluent_ffmpeg_1.default.setFfprobePath(ffprobeBinary);
// Temporary directory for processing
const TEMP_DIR = process.env.VIDEO_TEMP_DIR || '/tmp/video-processing';
const FFMPEG_THREADS = parseInt(process.env.FFMPEG_THREADS || '2');
const HLS_SEGMENT_DURATION = parseInt(process.env.HLS_SEGMENT_DURATION || '10');
// AES-128 Encryption settings
const ENABLE_ENCRYPTION = true;
const escapeDrawtext = (value) => value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 120);
const QUALITY_PRESETS = [
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
async function ensureTempDir() {
    if (!(0, fs_1.existsSync)(TEMP_DIR)) {
        (0, fs_1.mkdirSync)(TEMP_DIR, { recursive: true });
    }
}
/**
 * Get video metadata using ffprobe
 */
async function getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
        fluent_ffmpeg_1.default.ffprobe(filePath, (err, metadata) => {
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
async function generateThumbnail(videoPath, outputPath, timestamp = '00:00:05') {
    return new Promise((resolve, reject) => {
        (0, fluent_ffmpeg_1.default)(videoPath)
            .screenshots({
            timestamps: [timestamp],
            filename: path_1.default.basename(outputPath),
            folder: path_1.default.dirname(outputPath),
            size: '640x360'
        })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
    });
}
/** Create a physically separate, non-seekable-beyond-limit MP4 preview. */
async function generatePreview(inputPath, outputPath, durationSeconds) {
    return new Promise((resolve, reject) => {
        (0, fluent_ffmpeg_1.default)(inputPath)
            .setDuration(Math.max(1, Math.min(600, Math.floor(durationSeconds))))
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions(['-movflags +faststart', '-preset veryfast', '-crf 25', `-threads ${FFMPEG_THREADS}`])
            .output(outputPath)
            .on('end', () => resolve())
            .on('error', reject)
            .run();
    });
}
/**
 * Convert video to HLS format with multiple quality levels
 * Now with AES-128 encryption support!
 */
async function convertToHLS(videoId, inputPath, outputDir, onProgress, encryptionKeyInfo, watermarkOwner = 'INSTRUCTOR') {
    const qualities = [];
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
        const qualityDir = path_1.default.join(outputDir, preset.name);
        await promises_1.default.mkdir(qualityDir, { recursive: true });
        await new Promise((resolve, reject) => {
            const outputPlaylist = path_1.default.join(qualityDir, 'playlist.m3u8');
            // Build output options
            const outputOptions = [
                // Video encoding
                '-c:v libx264',
                '-preset medium',
                '-profile:v main',
                `-vf scale=-2:${preset.height},drawtext=text='ELQAED • ${escapeDrawtext(watermarkOwner)}':x=w-tw-20:y=h-th-20:fontsize=18:fontcolor=white@0.35:box=1:boxcolor=black@0.15`,
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
                '-hls_segment_filename', path_1.default.join(qualityDir, 'segment_%03d.ts'),
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
            (0, fluent_ffmpeg_1.default)(inputPath)
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
async function generateMasterPlaylist(outputDir, qualities) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const quality of qualities) {
        const preset = QUALITY_PRESETS.find(p => p.name === quality);
        if (preset) {
            const bandwidth = parseInt(preset.videoBitrate) * 1000;
            lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${getResolution(preset.height)}`);
            lines.push(`${quality}/playlist.m3u8`);
        }
    }
    const masterPlaylistPath = path_1.default.join(outputDir, 'playlist.m3u8');
    await promises_1.default.writeFile(masterPlaylistPath, lines.join('\n'));
    console.log(`[FFmpeg] Generated master playlist at ${masterPlaylistPath}`);
}
function getResolution(height) {
    const aspectRatio = 16 / 9;
    const width = Math.floor(height * aspectRatio);
    return `${width}x${height}`;
}
/**
 * Generate AES-128 encryption key and key info file for HLS
 */
async function generateEncryptionKey(videoId, outputDir) {
    // Generate random 16-byte key
    const key = crypto_1.default.randomBytes(16);
    const keyHex = key.toString('hex');
    // Generate random IV
    const iv = crypto_1.default.randomBytes(16);
    const ivHex = iv.toString('hex');
    // Save key file
    const keyPath = path_1.default.join(outputDir, 'encryption.key');
    await promises_1.default.writeFile(keyPath, key);
    // Create key info file for FFmpeg
    // Format: key URL\nkey file path\nIV (optional)
    const apiBase = process.env.API_BASE_URL || 'http://localhost:3001';
    const keyUrl = `${apiBase}/api/videos/key/${videoId}`;
    const keyInfoContent = `${keyUrl}\n${keyPath}\n${ivHex}`;
    const keyInfoPath = path_1.default.join(outputDir, 'enc.keyinfo');
    await promises_1.default.writeFile(keyInfoPath, keyInfoContent);
    console.log(`[Encryption] Generated AES-128 key for video ${videoId}`);
    return { keyPath, keyInfoPath, keyHex, ivHex };
}
/**
 * Process a video: download, convert to encrypted HLS, upload to private storage.
 * FFmpeg is mandatory; the original file is never used as a playback fallback.
 */
async function processVideo(videoId, tenantId) {
    console.log(`[VideoProcessor] Starting processing for video ${videoId}`);
    const video = await (0, db_1.queryOne)(`SELECT v.*,COALESCE(t.business_name,u.name,'INSTRUCTOR') watermark_owner
         FROM videos v LEFT JOIN users u ON u.id=v.uploaded_by
         LEFT JOIN tenants t ON t.id=v.tenant_id
         WHERE v.id=? AND v.tenant_id=?`, [videoId, tenantId]);
    if (!video)
        throw new Error(`Video ${videoId} is outside the requested tenant`);
    // Check if FFmpeg is available
    const ffmpegAvailable = await checkFfmpegAvailable();
    if (!ffmpegAvailable)
        throw new Error('FFmpeg is required: original videos are never exposed for playback');
    await ensureTempDir();
    const workDir = path_1.default.join(TEMP_DIR, videoId);
    await promises_1.default.mkdir(workDir, { recursive: true });
    try {
        // Update status to processing only after the tenant-owned row is verified.
        await (0, db_1.execute)('UPDATE videos SET status = ?, processing_progress = ? WHERE id = ? AND tenant_id = ?', ['processing', 0, videoId, tenantId]);
        // Download original from MinIO
        const originalPath = path_1.default.join(workDir, 'original.mp4');
        console.log(`[VideoProcessor] Downloading original video...`);
        await (0, minio_1.downloadFile)(minio_1.BUCKETS.ORIGINALS, video.original_key, originalPath);
        // Get metadata
        const metadata = await getVideoMetadata(originalPath);
        console.log(`[VideoProcessor] Video metadata:`, metadata);
        // Update duration in database
        await (0, db_1.execute)('UPDATE videos SET duration_seconds = ?, processing_progress = ? WHERE id = ? AND tenant_id = ?', [metadata.duration, 10, videoId, tenantId]);
        // Generate thumbnail
        const thumbnailPath = path_1.default.join(workDir, 'thumbnail.jpg');
        console.log(`[VideoProcessor] Generating thumbnail...`);
        await generateThumbnail(originalPath, thumbnailPath);
        // Upload thumbnail to MinIO
        const thumbnailKey = `${videoId}.jpg`;
        await (0, minio_1.uploadFile)(minio_1.BUCKETS.THUMBNAILS, thumbnailKey, thumbnailPath, 'image/jpeg');
        await (0, db_1.execute)('UPDATE videos SET thumbnail_key = ?, processing_progress = ? WHERE id = ? AND tenant_id = ?', [thumbnailKey, 20, videoId, tenantId]);
        // Generate a real standalone preview. It never contains media beyond
        // the first ten minutes, unlike a client-side playback restriction.
        const previewDuration = Math.max(1, Math.min(600, metadata.duration || 600));
        const previewPath = path_1.default.join(workDir, 'preview.mp4');
        try {
            await generatePreview(originalPath, previewPath, previewDuration);
            await (0, db_1.execute)(`UPDATE videos SET preview_duration_seconds=?,preview_status='pending' WHERE id=? AND tenant_id=?`, [previewDuration, videoId, tenantId]);
        }
        catch (previewError) {
            await (0, db_1.execute)("UPDATE videos SET preview_status='failed' WHERE id=? AND tenant_id=?", [videoId, tenantId]);
            throw new Error(`Secure preview generation failed: ${previewError instanceof Error ? previewError.message : String(previewError)}`);
        }
        // Convert to HLS
        const hlsDir = path_1.default.join(workDir, 'hls');
        await promises_1.default.mkdir(hlsDir, { recursive: true });
        // Generate encryption key if encryption is enabled
        let encryptionKeyInfo;
        let encryptionData;
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
            await (0, db_1.execute)('UPDATE videos SET processing_progress = ? WHERE id = ? AND tenant_id = ?', [Math.floor(adjustedProgress), videoId, tenantId]);
        }, encryptionKeyInfo, video.watermark_owner);
        // Upload HLS files to MinIO
        console.log(`[VideoProcessor] Uploading HLS files to MinIO...`);
        await uploadHLSFiles(videoId, hlsDir);
        // The ten-minute preview is a physically separate encrypted HLS asset.
        const previewHlsDir = path_1.default.join(workDir, 'preview-hls');
        await promises_1.default.mkdir(previewHlsDir, { recursive: true });
        await convertToHLS(videoId, previewPath, previewHlsDir, undefined, encryptionKeyInfo, video.watermark_owner);
        await uploadHLSFiles(videoId, previewHlsDir, 'preview');
        await (0, db_1.execute)(`UPDATE videos SET preview_key=?,preview_status='ready' WHERE id=? AND tenant_id=?`, [`${videoId}/preview/playlist.m3u8`, videoId, tenantId]);
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
            WHERE id = ? AND tenant_id = ?`
            : `UPDATE videos SET
                status = ?,
                processing_progress = 100,
                hls_key = ?,
                qualities_available = ?,
                processed_at = NOW()
            WHERE id = ? AND tenant_id = ?`;
        const updateParams = encryptionData
            ? ['ready', `${videoId}/playlist.m3u8`, JSON.stringify(qualities), encryptionData.keyHex, encryptionData.ivHex, videoId, tenantId]
            : ['ready', `${videoId}/playlist.m3u8`, JSON.stringify(qualities), videoId, tenantId];
        await (0, db_1.execute)(updateQuery, updateParams);
        // Playback is only through encrypted HLS. The uploaded source is removed
        // after the encrypted rendition and preview have been stored.
        await (0, minio_1.deleteFile)(minio_1.BUCKETS.ORIGINALS, video.original_key);
        await (0, db_1.execute)("UPDATE videos SET original_key=NULL,delivery_provider='minio' WHERE id=? AND tenant_id=?", [videoId, tenantId]);
        console.log(`[VideoProcessor] Completed processing for video ${videoId}${ENABLE_ENCRYPTION ? ' (encrypted)' : ''}`);
    }
    catch (error) {
        console.error(`[VideoProcessor] Error processing video ${videoId}:`, error);
        await (0, db_1.execute)('UPDATE videos SET status = ?, processing_error = ? WHERE id = ? AND tenant_id = ?', ['failed', (error instanceof Error ? error.message : 'Unknown error').slice(0, 500), videoId, tenantId]);
        throw error;
    }
    finally {
        // Cleanup temp files
        try {
            await promises_1.default.rm(workDir, { recursive: true, force: true });
            console.log(`[VideoProcessor] Cleaned up temp directory for ${videoId}`);
        }
        catch (cleanupError) {
            console.error(`[VideoProcessor] Error cleaning up:`, cleanupError);
        }
    }
}
/**
 * Upload all HLS files to MinIO
 */
async function uploadHLSFiles(videoId, hlsDir, subdirectory = '') {
    const files = await getAllFiles(hlsDir);
    for (const file of files) {
        const relativePath = path_1.default.relative(hlsDir, file);
        const prefix = subdirectory ? `${videoId}/${subdirectory}` : videoId;
        const objectKey = `${prefix}/${relativePath.replace(/\\/g, '/')}`;
        const contentType = file.endsWith('.m3u8')
            ? 'application/x-mpegURL'
            : 'video/mp2t';
        await (0, minio_1.uploadFile)(minio_1.BUCKETS.HLS, objectKey, file, contentType);
    }
    console.log(`[VideoProcessor] Uploaded ${files.length} HLS files for video ${videoId}`);
}
/**
 * Recursively get all files in a directory
 */
async function getAllFiles(dir) {
    const files = [];
    const entries = await promises_1.default.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await getAllFiles(fullPath));
        }
        else {
            files.push(fullPath);
        }
    }
    return files;
}
/**
 * Delete all processed files for a video
 */
/**
 * Pure tenant-scope predicate for video rows: a caller tenant is in scope
 * only when it is present and equals the row's tenant.
 */
const isVideoInTenantScope = (videoTenantId, callerTenantId) => Boolean(callerTenantId) && String(videoTenantId) === String(callerTenantId);
exports.isVideoInTenantScope = isVideoInTenantScope;
/**
 * Delete a video's storage objects. Tenant context is REQUIRED and verified:
 * the row must belong to the caller's tenant before any storage object is
 * removed, so a bare video id can never delete another tenant's media.
 */
async function deleteVideoFiles(videoId, tenantId) {
    const video = tenantId
        ? await (0, db_1.queryOne)('SELECT * FROM videos WHERE id = ? AND tenant_id = ?', [videoId, tenantId])
        : null;
    if (!video) {
        console.warn(`[VideoProcessor] Refusing to delete files for ${videoId}: no row within the caller's tenant scope`);
        return;
    }
    // Delete original
    if (video.original_key) {
        try {
            await (0, minio_1.deleteFile)(minio_1.BUCKETS.ORIGINALS, video.original_key);
        }
        catch (e) {
            console.warn(`[VideoProcessor] Could not delete original:`, e);
        }
    }
    // Delete thumbnail
    if (video.thumbnail_key) {
        try {
            await (0, minio_1.deleteFile)(minio_1.BUCKETS.THUMBNAILS, video.thumbnail_key);
        }
        catch (e) {
            console.warn(`[VideoProcessor] Could not delete thumbnail:`, e);
        }
    }
    if (video.preview_key) {
        try {
            await (0, minio_1.deleteFile)(minio_1.BUCKETS.PREVIEWS, video.preview_key);
        }
        catch (e) {
            console.warn(`[VideoProcessor] Could not delete preview:`, e);
        }
    }
    // Delete HLS files (using prefix)
    try {
        const { deleteByPrefix } = await Promise.resolve().then(() => __importStar(require('./minio')));
        await deleteByPrefix(minio_1.BUCKETS.HLS, `${videoId}/`);
    }
    catch (e) {
        console.warn(`[VideoProcessor] Could not delete HLS files:`, e);
    }
}
/**
 * Check if FFmpeg is available
 */
async function checkFfmpegAvailable() {
    return new Promise((resolve) => {
        try {
            fluent_ffmpeg_1.default.getAvailableFormats((err, formats) => {
                if (err) {
                    console.log('[VideoProcessor] FFmpeg check failed:', err.message);
                    resolve(false);
                }
                else {
                    resolve(true);
                }
            });
        }
        catch (e) {
            resolve(false);
        }
    });
}
// Export for use in queue workers
exports.default = {
    processVideo,
    getVideoMetadata,
    generateThumbnail,
    convertToHLS,
    deleteVideoFiles
};
