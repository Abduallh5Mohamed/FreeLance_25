import { openAsBlob } from 'node:fs';
import { execute, query } from '../db';

const API_BASE = process.env.VDOCIPHER_API_BASE || 'https://dev.vdocipher.com/api';

export interface VdoCipherUploadPayload {
    policy: string;
    key: string;
    'x-amz-signature': string;
    'x-amz-algorithm': string;
    'x-amz-date': string;
    'x-amz-credential': string;
    uploadLink: string;
}

export interface VdoCipherUploadSession {
    videoId: string;
    clientPayload: VdoCipherUploadPayload;
}

export interface VdoCipherVideoStatus {
    id: string;
    title?: string;
    status: string;
    length?: number;
    posters?: Array<{ width: number; height: number; posterUrl: string }>;
}

export interface VdoCipherPlayback {
    otp: string;
    playbackInfo: string;
}

function apiSecret(): string {
    const secret = process.env.VDOCIPHER_API_SECRET?.trim();
    if (!secret) throw new Error('VDOCIPHER_API_SECRET is not configured');
    return secret;
}

export function isManagedDrmEnabled(): boolean {
    return process.env.VIDEO_DRM_PROVIDER === 'vdocipher' && Boolean(process.env.VDOCIPHER_API_SECRET?.trim());
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
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
        let data: any = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
        if (!response.ok) {
            throw new Error(`VdoCipher request failed (${response.status}): ${data.message || data.error || 'unknown error'}`);
        }
        return data as T;
    } finally {
        clearTimeout(timeout);
    }
}

export async function createManagedUpload(title: string): Promise<VdoCipherUploadSession> {
    const folderId = process.env.VDOCIPHER_FOLDER_ID?.trim() || 'root';
    const query = new URLSearchParams({ title, folderId });
    return request<VdoCipherUploadSession>(`/videos?${query}`, { method: 'PUT' });
}

export async function uploadManagedFile(title: string, filePath: string, fileName: string): Promise<string> {
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
    form.append('file', await openAsBlob(filePath), fileName);

    const response = await fetch(payload.uploadLink, { method: 'POST', body: form });
    if (!response.ok) throw new Error(`VdoCipher file upload failed (${response.status})`);
    return session.videoId;
}

export async function getManagedVideoStatus(assetId: string): Promise<VdoCipherVideoStatus> {
    return request<VdoCipherVideoStatus>(`/videos/${encodeURIComponent(assetId)}`, { method: 'GET' });
}

export async function deleteManagedVideo(assetId: string): Promise<void> {
    const query = new URLSearchParams({ videos: assetId });
    await request(`/videos?${query}`, { method: 'DELETE' });
}

export async function createManagedPlayback(
    assetId: string,
    viewer: { id: string; name: string; phone?: string | null; email?: string | null },
): Promise<VdoCipherPlayback> {
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
    return request<VdoCipherPlayback>(`/videos/${encodeURIComponent(assetId)}/otp`, {
        method: 'POST',
        body: JSON.stringify({ ttl: 300, userId: viewer.id, annotate }),
    });
}

export function managedPlayerUrl(playback: VdoCipherPlayback): string {
    const query = new URLSearchParams({
        otp: playback.otp,
        playbackInfo: playback.playbackInfo,
        primaryColor: '7C3AED',
        ccLanguage: 'ar',
    });
    return `https://player.vdocipher.com/v2/?${query}`;
}

/** Periodic reconciliation so readiness does not depend on an uploader page staying open. */
export async function syncManagedDrmAssets(limit = 20): Promise<number> {
    if (!isManagedDrmEnabled()) return 0;
    const videos = await query<any>(
        `SELECT id,drm_asset_id,drm_preview_asset_id FROM videos
         WHERE delivery_provider='vdocipher' AND status IN ('uploading','processing')
           AND drm_preview_asset_id IS NOT NULL
           AND (drm_last_synced_at IS NULL OR drm_last_synced_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 SECOND))
         ORDER BY created_at ASC LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`
    );
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
            await execute(
                `UPDATE videos SET status=?,drm_status=?,preview_status=?,processing_progress=?,
                 duration_seconds=COALESCE(?,duration_seconds),drm_last_synced_at=UTC_TIMESTAMP() WHERE id=?`,
                [
                    failed ? 'failed' : ready ? 'ready' : 'processing',
                    fullStatus,
                    previewStatus === 'ready' ? 'ready' : previewStatus.includes('fail') ? 'failed' : 'pending',
                    ready ? 100 : 60,
                    full.length || null,
                    video.id,
                ]
            );
        } catch (error) {
            console.error(`[DRM] Failed to synchronize video ${video.id}:`, error);
        }
    }
    return videos.length;
}
