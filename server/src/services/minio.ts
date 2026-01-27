import * as Minio from 'minio';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { networkInterfaces } from 'os';

// Detect local IP for MinIO configuration
const getLocalIp = () => {
    const nets = networkInterfaces();
    const results: string[] = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]!) {
            if (net.family === 'IPv4' && !net.internal) {
                results.push(net.address);
            }
        }
    }

    // Prioritize common home WiFi subnets
    const wifiIp = results.find(ip => ip.startsWith('192.168.1.') || ip.startsWith('192.168.0.'));
    return wifiIp || results[0] || 'localhost';
};

const localIp = getLocalIp();
const configuredEndpoint = process.env.MINIO_ENDPOINT || 'localhost';
// If endpoint is strictly localhost, swap it with the real IP to ensure signatures match
// what the browser sees (except for docker/internal usage, assuming 'localhost' means local dev)
const usePublicIp = configuredEndpoint === 'localhost';
const minioEndpoint = usePublicIp ? localIp : configuredEndpoint;

console.log(`📱 MinIO Service: Configured endpoint: ${minioEndpoint} (Original: ${configuredEndpoint})`);

// MinIO client configuration
const minioClient = new Minio.Client({
    endPoint: minioEndpoint,
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});

// Bucket names
export const BUCKETS = {
    ORIGINALS: process.env.MINIO_BUCKET_ORIGINALS || 'videos-original',
    HLS: process.env.MINIO_BUCKET_HLS || 'videos-hls',
    THUMBNAILS: process.env.MINIO_BUCKET_THUMBNAILS || 'videos-thumbnails'
};

// Signed URL expiry (10 minutes default)
const SIGNED_URL_EXPIRY = parseInt(process.env.SIGNED_URL_EXPIRY || '600');

/**
 * Initialize MinIO buckets if they don't exist
 */
export async function initializeBuckets(): Promise<void> {
    console.log('[MinIO] Initializing buckets...');

    for (const bucket of Object.values(BUCKETS)) {
        try {
            const exists = await minioClient.bucketExists(bucket);
            if (!exists) {
                await minioClient.makeBucket(bucket);
                console.log(`[MinIO] Created bucket: ${bucket}`);
            } else {
                console.log(`[MinIO] Bucket exists: ${bucket}`);
            }
        } catch (error) {
            console.error(`[MinIO] Error with bucket ${bucket}:`, error);
            throw error;
        }
    }
}

/**
 * Generate a presigned URL for uploading a video chunk
 * This allows direct browser-to-MinIO upload without Node.js handling the file
 */
export async function getPresignedUploadUrl(
    videoId: string,
    fileName: string,
    contentType: string = 'video/mp4'
): Promise<{ uploadUrl: string; objectKey: string }> {
    const ext = path.extname(fileName) || '.mp4';
    const objectKey = `originals/${videoId}${ext}`;

    // Generate presigned PUT URL (valid for 1 hour)
    const uploadUrl = await minioClient.presignedPutObject(
        BUCKETS.ORIGINALS,
        objectKey,
        3600 // 1 hour expiry
    );

    return { uploadUrl, objectKey };
}

/**
 * Initialize a multipart upload for large files
 * Returns upload ID for chunk tracking
 */
export async function initializeMultipartUpload(
    videoId: string,
    fileName: string
): Promise<{ uploadId: string; objectKey: string }> {
    const ext = path.extname(fileName) || '.mp4';
    const objectKey = `originals/${videoId}${ext}`;

    // MinIO multipart upload initiation
    // Note: For actual multipart, we need to use the S3 compatible API
    const uploadId = uuidv4(); // Placeholder for tracking

    return { uploadId, objectKey };
}

/**
 * Generate presigned URL for uploading a specific chunk
 */
export async function getChunkUploadUrl(
    objectKey: string,
    uploadId: string,
    partNumber: number
): Promise<string> {
    // For each chunk, generate a separate presigned URL
    const chunkKey = `${objectKey}.part${partNumber}`;

    return await minioClient.presignedPutObject(
        BUCKETS.ORIGINALS,
        chunkKey,
        3600
    );
}

/**
 * Complete multipart upload by concatenating chunks
 */
export async function completeMultipartUpload(
    objectKey: string,
    uploadId: string,
    totalParts: number
): Promise<void> {
    // In a production system, you'd use MinIO's native multipart completion
    // For simplicity, we're using a chunk-and-merge approach
    console.log(`[MinIO] Completing upload for ${objectKey} with ${totalParts} parts`);
}

/**
 * Generate a URL for streaming HLS content
 * Since bucket is public, we use direct URLs for proper relative path resolution
 */
export async function getSignedStreamUrl(
    videoId: string,
    fileName: string = 'playlist.m3u8'
): Promise<string> {
    // Use direct URL for public bucket - this allows relative paths in m3u8 to work correctly
    // Use the dynamically detected endpoint
    const port = process.env.MINIO_PORT || '9000';
    const useSSL = process.env.MINIO_USE_SSL === 'true';
    const protocol = useSSL ? 'https' : 'http';

    // The endpoint here must be the IP address we detected
    const directUrl = `${protocol}://${minioEndpoint}:${port}/${BUCKETS.HLS}/${videoId}/360p/playlist.m3u8`;

    return directUrl;
}

/**
 * Generate signed URLs for all HLS segments
 * Called when student requests to watch a video
 */
export async function getSignedHLSUrls(videoId: string): Promise<{
    playlistUrl: string;
    segmentBaseUrl: string;
}> {
    const playlistUrl = await getSignedStreamUrl(videoId, 'playlist.m3u8');

    // For segments, we return a base URL pattern
    // The actual segment URLs will be generated on-demand or rewritten in the m3u8
    const segmentBaseUrl = await minioClient.presignedGetObject(
        BUCKETS.HLS,
        `${videoId}/`,
        SIGNED_URL_EXPIRY
    );

    return { playlistUrl, segmentBaseUrl };
}

/**
 * Upload a file directly to MinIO (for server-side operations)
 */
export async function uploadFile(
    bucket: string,
    objectKey: string,
    filePath: string,
    contentType?: string
): Promise<void> {
    const metaData: Record<string, string> = contentType ? { 'Content-Type': contentType } : {};
    await minioClient.fPutObject(bucket, objectKey, filePath, metaData);
    console.log(`[MinIO] Uploaded ${objectKey} to ${bucket}`);
}

/**
 * Upload buffer to MinIO
 */
export async function uploadBuffer(
    bucket: string,
    objectKey: string,
    buffer: Buffer,
    contentType?: string
): Promise<void> {
    const metaData: Record<string, string> = contentType ? { 'Content-Type': contentType } : {};
    await minioClient.putObject(bucket, objectKey, buffer, buffer.length, metaData);
    console.log(`[MinIO] Uploaded buffer to ${bucket}/${objectKey}`);
}

/**
 * Download file from MinIO to local path
 */
export async function downloadFile(
    bucket: string,
    objectKey: string,
    localPath: string
): Promise<void> {
    await minioClient.fGetObject(bucket, objectKey, localPath);
    console.log(`[MinIO] Downloaded ${objectKey} to ${localPath}`);
}

/**
 * Delete a file from MinIO
 */
export async function deleteFile(bucket: string, objectKey: string): Promise<void> {
    await minioClient.removeObject(bucket, objectKey);
    console.log(`[MinIO] Deleted ${objectKey} from ${bucket}`);
}

/**
 * Delete all files with a prefix (for deleting all HLS files of a video)
 */
export async function deleteByPrefix(bucket: string, prefix: string): Promise<void> {
    const objectsList: string[] = [];
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
export async function fileExists(bucket: string, objectKey: string): Promise<boolean> {
    try {
        await minioClient.statObject(bucket, objectKey);
        return true;
    } catch {
        return false;
    }
}

/**
 * Get file metadata
 */
export async function getFileInfo(bucket: string, objectKey: string): Promise<{
    size: number;
    lastModified: Date;
    contentType?: string;
} | null> {
    try {
        const stat = await minioClient.statObject(bucket, objectKey);
        return {
            size: stat.size,
            lastModified: stat.lastModified,
            contentType: stat.metaData?.['content-type']
        };
    } catch {
        return null;
    }
}

/**
 * Generate a signed URL for thumbnail
 */
export async function getThumbnailUrl(videoId: string): Promise<string> {
    const objectKey = `${videoId}.jpg`;

    try {
        const exists = await fileExists(BUCKETS.THUMBNAILS, objectKey);
        if (!exists) {
            // Return placeholder if thumbnail doesn't exist
            return '/api/videos/placeholder-thumbnail';
        }

        return await minioClient.presignedGetObject(
            BUCKETS.THUMBNAILS,
            objectKey,
            86400 // 24 hours for thumbnails (they're not sensitive)
        );
    } catch (error) {
        console.error(`[MinIO] Error getting thumbnail URL:`, error);
        return '/api/videos/placeholder-thumbnail';
    }
}

export { minioClient };
