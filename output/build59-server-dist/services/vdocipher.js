"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isManagedDrmEnabled = isManagedDrmEnabled;
exports.createManagedUpload = createManagedUpload;
exports.uploadManagedFile = uploadManagedFile;
exports.getManagedVideoStatus = getManagedVideoStatus;
exports.deleteManagedVideo = deleteManagedVideo;
exports.createManagedPlayback = createManagedPlayback;
exports.managedPlayerUrl = managedPlayerUrl;
exports.syncManagedDrmAssets = syncManagedDrmAssets;
const node_fs_1 = require("node:fs");
const db_1 = require("../db");
const API_BASE = process.env.VDOCIPHER_API_BASE || 'https://dev.vdocipher.com/api';
function apiSecret() {
    const secret = process.env.VDOCIPHER_API_SECRET?.trim();
    if (!secret)
        throw new Error('VDOCIPHER_API_SECRET is not configured');
    return secret;
}
function isManagedDrmEnabled() {
    return process.env.VIDEO_DRM_PROVIDER === 'vdocipher' && Boolean(process.env.VDOCIPHER_API_SECRET?.trim());
}
async function request(path, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(`${API_BASE}${path}`, {
            ...init,
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                Authorization: `Apisecret ${apiSecret()}`,
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                ...init.headers,
            },
        });
        const raw = await response.text();
        let data = {};
        try {
            data = raw ? JSON.parse(raw) : {};
        }
        catch {
            data = { message: raw };
        }
        if (!response.ok) {
            throw new Error(`VdoCipher request failed (${response.status}): ${data.message || data.error || 'unknown error'}`);
        }
        return data;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function createManagedUpload(title) {
    const folderId = process.env.VDOCIPHER_FOLDER_ID?.trim() || 'root';
    const query = new URLSearchParams({ title, folderId });
    return request(`/videos?${query}`, { method: 'PUT' });
}
async function uploadManagedFile(title, filePath, fileName) {
    const session = await createManagedUpload(title);
    const payload = session.clientPayload;
    const form = new FormData();
    form.append('policy', payload.policy);
    form.append('key', payload.key);
    form.append('x-amz-signature', payload['x-amz-signature']);
    form.append('x-amz-algorithm', payload['x-amz-algorithm']);
    form.append('x-amz-date', payload['x-amz-date']);
    form.append('x-amz-credential', payload['x-amz-credential']);
    form.append('success_action_status', '201');
    form.append('success_action_redirect', '');
    form.append('file', await (0, node_fs_1.openAsBlob)(filePath), fileName);
    const response = await fetch(payload.uploadLink, { method: 'POST', body: form });
    if (!response.ok)
        throw new Error(`VdoCipher file upload failed (${response.status})`);
    return session.videoId;
}
async function getManagedVideoStatus(assetId) {
    return request(`/videos/${encodeURIComponent(assetId)}`, { method: 'GET' });
}
async function deleteManagedVideo(assetId) {
    const query = new URLSearchParams({ videos: assetId });
    await request(`/videos?${query}`, { method: 'DELETE' });
}
async function createManagedPlayback(assetId, viewer) {
    const watermarkText = [viewer.name, viewer.phone, viewer.email, `ID:${viewer.id}`].filter(Boolean).join(' • ');
    const annotate = JSON.stringify([
        {
            type: 'rtext',
            text: watermarkText,
            alpha: '0.55',
            color: '0xFFFFFF',
            size: '14',
            interval: '5000',
            skip: '3000',
        },
    ]);
    return request(`/videos/${encodeURIComponent(assetId)}/otp`, {
        method: 'POST',
        body: JSON.stringify({ ttl: 300, userId: viewer.id, annotate }),
    });
}
function managedPlayerUrl(playback) {
    const query = new URLSearchParams({
        otp: playback.otp,
        playbackInfo: playback.playbackInfo,
        primaryColor: '7C3AED',
        ccLanguage: 'ar',
    });
    return `https://player.vdocipher.com/v2/?${query}`;
}
/** Periodic reconciliation so readiness does not depend on an uploader page staying open. */
async function syncManagedDrmAssets(limit = 20) {
    if (!isManagedDrmEnabled())
        return 0;
    const videos = await (0, db_1.query)(`SELECT id,drm_asset_id,drm_preview_asset_id FROM videos
         WHERE delivery_provider='vdocipher' AND status IN ('uploading','processing')
           AND drm_preview_asset_id IS NOT NULL
           AND (drm_last_synced_at IS NULL OR drm_last_synced_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 SECOND))
         ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`);
    for (const video of videos) {
        try {
            const [full, preview] = await Promise.all([
                getManagedVideoStatus(video.drm_asset_id),
                getManagedVideoStatus(video.drm_preview_asset_id),
            ]);
            const fullStatus = String(full.status || '').toLowerCase();
            const previewStatus = String(preview.status || '').toLowerCase();
            const failed = fullStatus.includes('fail') || previewStatus.includes('fail');
            const ready = fullStatus === 'ready' && previewStatus === 'ready';
            await (0, db_1.execute)(`UPDATE videos SET status=?,drm_status=?,preview_status=?,processing_progress=?,
                 duration_seconds=COALESCE(?,duration_seconds),drm_last_synced_at=UTC_TIMESTAMP() WHERE id=?`, [
                failed ? 'failed' : ready ? 'ready' : 'processing',
                fullStatus,
                previewStatus === 'ready' ? 'ready' : previewStatus.includes('fail') ? 'failed' : 'pending',
                ready ? 100 : 60,
                full.length || null,
                video.id,
            ]);
        }
        catch (error) {
            console.error(`[DRM] Failed to synchronize video ${video.id}:`, error);
        }
    }
    return videos.length;
}
