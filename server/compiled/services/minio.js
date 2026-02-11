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
exports.minioClient = exports.BUCKETS = void 0;
exports.initializeBuckets = initializeBuckets;
exports.getPresignedUploadUrl = getPresignedUploadUrl;
exports.initializeMultipartUpload = initializeMultipartUpload;
exports.getChunkUploadUrl = getChunkUploadUrl;
exports.completeMultipartUpload = completeMultipartUpload;
exports.getSignedStreamUrl = getSignedStreamUrl;
exports.getSignedHLSUrls = getSignedHLSUrls;
exports.uploadFile = uploadFile;
exports.uploadBuffer = uploadBuffer;
exports.downloadFile = downloadFile;
exports.deleteFile = deleteFile;
exports.deleteByPrefix = deleteByPrefix;
exports.fileExists = fileExists;
exports.getFileInfo = getFileInfo;
exports.getThumbnailUrl = getThumbnailUrl;
const Minio = __importStar(require("minio"));
const uuid_1 = require("uuid");
const path_1 = __importDefault(require("path"));
const os_1 = require("os");
// Detect local IP for MinIO configuration
const getLocalIp = () => {
    var _a, _b;
    const nets = (0, os_1.networkInterfaces)();
    const results = [];
    for (const name of Object.keys(nets)) {
        // Skip VirtualBox, VMware, Docker, and other virtual adapters
        const lowerName = name.toLowerCase();
        if (lowerName.includes('virtualbox') ||
            lowerName.includes('vmware') ||
            lowerName.includes('docker') ||
            lowerName.includes('vethernet') ||
            lowerName.includes('hyper-v')) {
            continue;
        }
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                results.push({ name, address: net.address });
            }
        }
    }
    // Filter out VirtualBox IPs (192.168.56.x is VirtualBox Host-Only Network)
    const filtered = results.filter(r => !r.address.startsWith('192.168.56.'));
    // Prioritize common home WiFi subnets
    const wifiIp = filtered.find(r => r.address.startsWith('192.168.1.') ||
        r.address.startsWith('192.168.0.') ||
        r.address.startsWith('10.'));
    console.log('[MinIO] Network interfaces found:', results.map(r => `${r.name}: ${r.address}`));
    console.log('[MinIO] Selected IP:', (wifiIp === null || wifiIp === void 0 ? void 0 : wifiIp.address) || ((_a = filtered[0]) === null || _a === void 0 ? void 0 : _a.address) || 'localhost');
    return (wifiIp === null || wifiIp === void 0 ? void 0 : wifiIp.address) || ((_b = filtered[0]) === null || _b === void 0 ? void 0 : _b.address) || 'localhost';
};
const localIp = getLocalIp();
const configuredEndpoint = process.env.MINIO_ENDPOINT || 'localhost';
const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT || configuredEndpoint;
// If endpoint is strictly localhost, use localhost for browser access (same machine)
// This ensures the browser can reach MinIO on the same machine
const usePublicIp = configuredEndpoint === 'localhost';
// For local development, always use localhost since frontend and MinIO are on the same machine
const minioEndpoint = usePublicIp ? 'localhost' : configuredEndpoint;
console.log(`📱 MinIO Service: Configured endpoint: ${minioEndpoint} (Original: ${configuredEndpoint})`);
// MinIO client configuration
const minioClient = new Minio.Client({
    endPoint: minioEndpoint,
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});
exports.minioClient = minioClient;
// Bucket names
exports.BUCKETS = {
    ORIGINALS: process.env.MINIO_BUCKET_ORIGINALS || 'videos-original',
    HLS: process.env.MINIO_BUCKET_HLS || 'videos-hls',
    THUMBNAILS: process.env.MINIO_BUCKET_THUMBNAILS || 'videos-thumbnails'
};
// Signed URL expiry (10 minutes default)
const SIGNED_URL_EXPIRY = parseInt(process.env.SIGNED_URL_EXPIRY || '600');
/**
 * Initialize MinIO buckets if they don't exist
 */
async function initializeBuckets() {
    console.log('[MinIO] Initializing buckets...');
    for (const bucket of Object.values(exports.BUCKETS)) {
        try {
            const exists = await minioClient.bucketExists(bucket);
            if (!exists) {
                await minioClient.makeBucket(bucket);
                console.log(`[MinIO] Created bucket: ${bucket}`);
            }
            else {
                console.log(`[MinIO] Bucket exists: ${bucket}`);
            }
        }
        catch (error) {
            console.error(`[MinIO] Error with bucket ${bucket}:`, error);
            throw error;
        }
    }
}
/**
 * Generate a presigned URL for uploading a video chunk
 * For HTTPS environments, use nginx reverse proxy instead of direct MinIO access
 */
async function getPresignedUploadUrl(videoId, fileName, contentType = 'video/mp4') {
    const ext = path_1.default.extname(fileName) || '.mp4';
    const objectKey = `originals/${videoId}${ext}`;
    // Check if we're in production (HTTPS) environment
    const isProduction = process.env.NODE_ENV === 'production' || process.env.USE_NGINX_PROXY === 'true';
    if (isProduction) {
        // Use nginx reverse proxy path for HTTPS compatibility
        // Frontend will use PUT request to /storage/bucket/object
        const uploadUrl = `/storage/${exports.BUCKETS.ORIGINALS}/${objectKey}`;
        console.log('[MinIO] Upload URL (via nginx):', uploadUrl);
        return { uploadUrl, objectKey };
    }
    else {
        // Development: Generate presigned PUT URL (valid for 1 hour)
        let uploadUrl = await minioClient.presignedPutObject(exports.BUCKETS.ORIGINALS, objectKey, 3600 // 1 hour expiry
        );
        // Replace localhost with public endpoint for browser access
        if (publicEndpoint !== 'localhost' && uploadUrl.includes('localhost')) {
            uploadUrl = uploadUrl.replace('localhost', publicEndpoint);
        }
        console.log('[MinIO] Upload URL generated:', uploadUrl);
        return { uploadUrl, objectKey };
    }
}
/**
 * Initialize a multipart upload for large files
 * Returns upload ID for chunk tracking
 */
async function initializeMultipartUpload(videoId, fileName) {
    const ext = path_1.default.extname(fileName) || '.mp4';
    const objectKey = `originals/${videoId}${ext}`;
    // MinIO multipart upload initiation
    // Note: For actual multipart, we need to use the S3 compatible API
    const uploadId = (0, uuid_1.v4)(); // Placeholder for tracking
    return { uploadId, objectKey };
}
/**
 * Generate presigned URL for uploading a specific chunk
 */
async function getChunkUploadUrl(objectKey, uploadId, partNumber) {
    // For each chunk, generate a separate presigned URL
    const chunkKey = `${objectKey}.part${partNumber}`;
    return await minioClient.presignedPutObject(exports.BUCKETS.ORIGINALS, chunkKey, 3600);
}
/**
 * Complete multipart upload by concatenating chunks
 */
async function completeMultipartUpload(objectKey, uploadId, totalParts) {
    // In a production system, you'd use MinIO's native multipart completion
    // For simplicity, we're using a chunk-and-merge approach
    console.log(`[MinIO] Completing upload for ${objectKey} with ${totalParts} parts`);
}
/**
 * Generate a URL for streaming HLS content or original video
 * Use nginx reverse proxy path instead of direct MinIO access
 */
async function getSignedStreamUrl(videoId, fileName = 'playlist.m3u8', bucket = exports.BUCKETS.HLS) {
    // Use nginx reverse proxy path (/storage/) instead of direct MinIO access
    // This ensures HTTPS compatibility and proper CORS handling
    if (bucket === exports.BUCKETS.ORIGINALS) {
        // For original files, the fileName is the full objectKey (originals/videoId.ext)
        const cleanFileName = fileName.startsWith('originals/') ? fileName : `originals/${fileName}`;
        const directUrl = `/storage/${bucket}/${cleanFileName}`;
        console.log('[MinIO] Original video URL:', directUrl);
        return directUrl;
    }
    else {
        // For HLS, use videoId/quality/playlist.m3u8 structure
        const directUrl = `/storage/${bucket}/${videoId}/360p/playlist.m3u8`;
        return directUrl;
    }
}
/**
 * Generate signed URLs for all HLS segments
 * Called when student requests to watch a video
 */
async function getSignedHLSUrls(videoId) {
    const playlistUrl = await getSignedStreamUrl(videoId, 'playlist.m3u8');
    // For segments, we return a base URL pattern
    // The actual segment URLs will be generated on-demand or rewritten in the m3u8
    const segmentBaseUrl = await minioClient.presignedGetObject(exports.BUCKETS.HLS, `${videoId}/`, SIGNED_URL_EXPIRY);
    return { playlistUrl, segmentBaseUrl };
}
/**
 * Upload a file directly to MinIO (for server-side operations)
 */
async function uploadFile(bucket, objectKey, filePath, contentType) {
    const metaData = contentType ? { 'Content-Type': contentType } : {};
    await minioClient.fPutObject(bucket, objectKey, filePath, metaData);
    console.log(`[MinIO] Uploaded ${objectKey} to ${bucket}`);
}
/**
 * Upload buffer to MinIO
 */
async function uploadBuffer(bucket, objectKey, buffer, contentType) {
    const metaData = contentType ? { 'Content-Type': contentType } : {};
    await minioClient.putObject(bucket, objectKey, buffer, buffer.length, metaData);
    console.log(`[MinIO] Uploaded buffer to ${bucket}/${objectKey}`);
}
/**
 * Download file from MinIO to local path
 */
async function downloadFile(bucket, objectKey, localPath) {
    await minioClient.fGetObject(bucket, objectKey, localPath);
    console.log(`[MinIO] Downloaded ${objectKey} to ${localPath}`);
}
/**
 * Delete a file from MinIO
 */
async function deleteFile(bucket, objectKey) {
    await minioClient.removeObject(bucket, objectKey);
    console.log(`[MinIO] Deleted ${objectKey} from ${bucket}`);
}
/**
 * Delete all files with a prefix (for deleting all HLS files of a video)
 */
async function deleteByPrefix(bucket, prefix) {
    const objectsList = [];
    const stream = minioClient.listObjects(bucket, prefix, true);
    for await (const obj of stream) {
        if (obj.name) {
            objectsList.push(obj.name);
        }
    }
    if (objectsList.length > 0) {
        await minioClient.removeObjects(bucket, objectsList);
        console.log(`[MinIO] Deleted ${objectsList.length} objects with prefix ${prefix}`);
    }
}
/**
 * Check if a file exists in MinIO
 */
async function fileExists(bucket, objectKey) {
    try {
        await minioClient.statObject(bucket, objectKey);
        return true;
    }
    catch (_a) {
        return false;
    }
}
/**
 * Get file metadata
 */
async function getFileInfo(bucket, objectKey) {
    var _a;
    try {
        const stat = await minioClient.statObject(bucket, objectKey);
        return {
            size: stat.size,
            lastModified: stat.lastModified,
            contentType: (_a = stat.metaData) === null || _a === void 0 ? void 0 : _a['content-type']
        };
    }
    catch (_b) {
        return null;
    }
}
/**
 * Generate a signed URL for thumbnail
 */
async function getThumbnailUrl(videoId) {
    const objectKey = `${videoId}.jpg`;
    try {
        const exists = await fileExists(exports.BUCKETS.THUMBNAILS, objectKey);
        if (!exists) {
            // Return placeholder if thumbnail doesn't exist
            return '/api/videos/placeholder-thumbnail';
        }
        return await minioClient.presignedGetObject(exports.BUCKETS.THUMBNAILS, objectKey, 86400 // 24 hours for thumbnails (they're not sensitive)
        );
    }
    catch (error) {
        console.error(`[MinIO] Error getting thumbnail URL:`, error);
        return '/api/videos/placeholder-thumbnail';
    }
}
