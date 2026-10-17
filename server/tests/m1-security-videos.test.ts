import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoMetadataResponse, VideoMetadataUpdateDependencies } from '../src/routes/videos';

process.env.MINIO_ACCESS_KEY ??= 'workbuddy-test-access';
process.env.MINIO_SECRET_KEY ??= 'workbuddy-test-secret';

const routeModule = (async () => {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
        return await import('../src/routes/videos');
    } finally {
        console.log = originalLog;
    }
})();

type StoredVideo = VideoMetadataResponse & {
    tenant_id: string;
    uploaded_by: string;
    encryption_key: string;
    original_key: string;
    hls_path: string;
};

const createVideo = (): StoredVideo => ({
    id: 'video-1',
    tenant_id: 'tenant-a',
    uploaded_by: 'uploader-a',
    course_id: 'course-1',
    lecture_id: 'lecture-1',
    material_id: null,
    title: 'Old title',
    description: 'Old description',
    duration_seconds: 120,
    status: 'ready',
    processing_progress: 100,
    qualities_available: ['720p'],
    preview_status: 'ready',
    created_at: new Date('2026-01-01T00:00:00Z'),
    processed_at: new Date('2026-01-01T00:01:00Z'),
    encryption_key: 'private-hls-key',
    original_key: 'originals/video-1.mp4',
    hls_path: 'private/hls/video-1',
});

const createDependencies = (video: StoredVideo): {
    deps: VideoMetadataUpdateDependencies;
    statements: Array<{ sql: string; params: unknown[] }>;
} => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const deps: VideoMetadataUpdateDependencies = {
        execute: async (sql, params = []) => {
            statements.push({ sql, params });
            const [title, description, videoId, tenantId, userId] = params;
            if (videoId === video.id && tenantId === video.tenant_id && userId === video.uploaded_by) {
                video.title = String(title);
                video.description = description as string | null;
            }
        },
        queryOne: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
            statements.push({ sql, params });
            const [videoId, tenantId, userId] = params;
            return videoId === video.id && tenantId === video.tenant_id && userId === video.uploaded_by
                ? video as unknown as T
                : null;
        },
    };
    return { deps, statements };
};

test('metadata update returns a safe projection to the uploader only', async () => {
    const { updateVideoMetadataForUploader } = await routeModule;
    const video = createVideo();
    const { deps, statements } = createDependencies(video);
    const response = await updateVideoMetadataForUploader(
        video.id,
        { id: video.uploaded_by, tenantId: video.tenant_id },
        'Updated title',
        'Updated description',
        deps,
    );

    assert.equal(response?.title, 'Updated title');
    assert.equal(response?.description, 'Updated description');
    assert.deepEqual(Object.keys(response ?? {}).sort(), [
        'course_id', 'created_at', 'description', 'duration_seconds', 'id', 'lecture_id',
        'material_id', 'preview_status', 'processed_at', 'processing_progress',
        'qualities_available', 'status', 'title',
    ].sort());
    assert.equal('encryption_key' in (response ?? {}), false);
    assert.equal('original_key' in (response ?? {}), false);
    assert.equal('hls_path' in (response ?? {}), false);
    assert.match(statements[0].sql, /WHERE id = \? AND tenant_id = \? AND uploaded_by = \?$/);
    assert.match(statements[1].sql, /WHERE id = \? AND tenant_id = \? AND uploaded_by = \?$/);
    assert.deepEqual(statements[0].params, [
        'Updated title', 'Updated description', video.id, video.tenant_id, video.uploaded_by,
    ]);
});

test('metadata update denies another uploader and a cross-tenant caller', async () => {
    const { updateVideoMetadataForUploader } = await routeModule;
    const video = createVideo();
    const { deps } = createDependencies(video);

    assert.equal(await updateVideoMetadataForUploader(
        video.id,
        { id: 'other-user', tenantId: video.tenant_id },
        'Unauthorized title',
        null,
        deps,
    ), null);
    assert.equal(await updateVideoMetadataForUploader(
        video.id,
        { id: video.uploaded_by, tenantId: 'tenant-b' },
        'Cross-tenant title',
        null,
        deps,
    ), null);
    assert.equal(video.title, 'Old title');
});

test('metadata update denies users without a selected tenant and propagates database failures', async () => {
    const { updateVideoMetadataForUploader } = await routeModule;
    const video = createVideo();
    const { deps, statements } = createDependencies(video);
    assert.equal(await updateVideoMetadataForUploader(
        video.id,
        { id: video.uploaded_by, tenantId: null },
        'No-tenant title',
        null,
        deps,
    ), null);
    assert.equal(statements.length, 0);

    const failingDeps: VideoMetadataUpdateDependencies = {
        execute: async () => { throw new Error('database unavailable'); },
        queryOne: async <T>(): Promise<T | null> => {
            assert.fail('query must not run after update failure');
        },
    };
    await assert.rejects(
        updateVideoMetadataForUploader(video.id, { id: video.uploaded_by, tenantId: video.tenant_id }, 'New title', null, failingDeps),
        /database unavailable/,
    );
});

test('upload responses preserve the existing object-key and expiration contract', async () => {
    const { buildUploadInitContract, buildUploadTransferContract } = await routeModule;
    const objectKey = 'originals/video-1.mp4';
    const init = buildUploadInitContract('video-1', objectKey, 60);
    const transfer = buildUploadTransferContract('video-1', objectKey, 2048);

    assert.deepEqual(init, {
        provider: 'minio',
        videoId: 'video-1',
        uploadUrl: '/videos/upload/video-1/content',
        uploadMethod: 'PUT',
        authenticated: true,
        objectKey,
        expiresIn: 3600,
    });
    assert.deepEqual(transfer, { success: true, videoId: 'video-1', objectKey, sizeBytes: 2048 });
});
