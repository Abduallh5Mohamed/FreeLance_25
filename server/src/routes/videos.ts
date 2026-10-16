import { Router, Request, Response } from 'express';
import path from 'path';
import { createHash } from 'crypto';
import type { Readable } from 'stream';
import mysql from 'mysql2/promise';
import { query, queryOne, execute } from '../db';
import { v4 as uuidv4 } from 'uuid';
import {
    getFileInfo,
    getSignedStreamUrl,
    getThumbnailUrl,
    initializeBuckets,
    putObjectStream,
    BUCKETS
} from '../services/minio';
import { processVideo, deleteVideoFiles } from '../services/video-processor';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { isSuperAdmin, getAdminPermissions, requireAdminPermission } from '../security/admin-permissions';
import {
    createSqlVideoAccessRepository,
    evaluateVideoAccess,
    type VideoAccessRepository,
} from '../security/video-access-policy';
import {
    createManagedPlayback,
    createManagedUpload,
    deleteManagedVideo,
    getManagedVideoStatus,
    isManagedDrmEnabled,
    managedPlayerUrl,
} from '../services/vdocipher';

/**
 * Platform capability key for cross-tenant video security administration.
 * The migrations seed no security.* key beyond the verified super_admin
 * role, so the capability check is the effective policy; deny-by-default
 * for bare role claims.
 */
const PLATFORM_SECURITY_PERMISSION = 'security.manage';

/**
 * Verified platform capability, resolved server-side (active super_admin or a
 * seeded permission key). Never consults a JWT role claim. Built from the
 * pre-existing admin-permissions exports only.
 */
const hasVerifiedPlatformCapability = async (userId: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes(PLATFORM_SECURITY_PERMISSION);
};

/**
 * Production SQL repository for the pure access policy, built over the
 * pool-backed helpers this router already uses (the policy module itself
 * carries no eager service import). The same verified reads authorize
 * playback in secure-video.ts and metadata here.
 */
const videoAccessRepository = createSqlVideoAccessRepository({
    queryOne,
    hasPlatformCapability: (userId) => hasVerifiedPlatformCapability(userId),
});

/**
 * Reads the course-management policy needs. Production reuses the access
 * policy's own SQL repository (identical verified authority reads — no
 * second copy of the membership/owner SQL); tests inject isolated fixtures
 * against the real decision code.
 */
export interface CourseManagementPolicyReader {
    loadCourse: (courseId: string) => Promise<{ tenant_id: string | null; instructor_id: string | null } | null>;
    /** ACTIVE authority in a tenant: verified owner row, or active teaching membership (owner/instructor). */
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    /** Verified platform capability (active super_admin or a seeded permission key). */
    hasPlatformCapability: (userId: string) => Promise<boolean>;
}

const courseManagementReader: CourseManagementPolicyReader = {
    loadCourse: (courseId) => videoAccessRepository.loadCourse(courseId),
    loadActiveTenantAuthority: (userId, tenantId) =>
        videoAccessRepository.loadActiveTenantAuthority(userId, tenantId),
    hasPlatformCapability: (userId) => hasVerifiedPlatformCapability(userId),
};

/**
 * Course management visibility (deny-by-default): the verified platform
 * capability, or — inside the caller's server-derived selected workspace —
 * ACTIVE authority in the course's tenant plus exact ownership: the
 * assigned course instructor, or the verified tenant owner. A stale
 * assignment without live authority, a bare membership without ownership,
 * another tenant, or an unselected workspace grants nothing.
 */
export const canManageCourse = async (
    user: NonNullable<AuthRequest['user']>,
    courseId: string,
    reader: CourseManagementPolicyReader = courseManagementReader,
): Promise<boolean> => {
    if (await reader.hasPlatformCapability(user.id)) return true;

    const course = await reader.loadCourse(courseId);
    if (!course || !course.tenant_id) return false;

    // The server-derived selected workspace (auth middleware) must BE the
    // course's tenant; another owned membership or a request value never
    // stands in for the selection.
    if (!user.tenantId || String(user.tenantId) !== String(course.tenant_id)) return false;

    const authority = await reader.loadActiveTenantAuthority(user.id, course.tenant_id);
    if (!authority) return false;

    // Exact ownership: the assigned course instructor, or the verified
    // tenant owner (ownership — a mere teaching member without a
    // per-course grant stays denied).
    if (course.instructor_id && String(course.instructor_id) === String(user.id)) return true;
    return authority.authority === 'owner';
};

/**
 * Video metadata visibility (deny-by-default): delegates to the production
 * access policy with the authenticated, server-derived scope — ACTIVE
 * per-resource teacher authority (uploader / own lecture / assigned course
 * in a live tenant), the verified tenant owner, a verified instructor
 * license, or the server-selected student enrollment (in-scope lecture,
 * verified share publication, or an EXACT purchased-lecture license). An
 * uploader id without live authority, a stale assignment, a phone match,
 * or a bare instructor_shared_lectures row never grants metadata.
 */
export const canViewVideo = async (
    user: NonNullable<AuthRequest['user']>,
    videoId: string,
    repository: VideoAccessRepository = videoAccessRepository,
): Promise<boolean> =>
    evaluateVideoAccess(
        user.id,
        videoId,
        { tenantId: user.tenantId, studentEnrollmentId: user.studentEnrollmentId },
        repository,
    );

/**
 * Analytics visibility (deny-by-default): analytics is MANAGEMENT data —
 * the verified platform capability, or ACTIVE course management of the
 * video's course. Viewer access never grants it: student content viewing,
 * an EXACT purchased cross-tenant lecture license (which may see only the
 * exact video metadata), or a lecture relationship without course
 * management all stay denied.
 */
export const canViewVideoAnalytics = async (
    user: NonNullable<AuthRequest['user']>,
    video: { course_id: string | null },
    reader: CourseManagementPolicyReader = courseManagementReader,
): Promise<boolean> => {
    // Verified platform capability remains separate from course scope.
    if (await reader.hasPlatformCapability(user.id)) return true;
    // Management is anchored on the video's course; a course-less video has
    // no management surface (fail closed).
    if (!video.course_id) return false;
    return canManageCourse(user, video.course_id, reader);
};

/**
 * Reads required by the course-upload policy. Production wires them over the
 * pool; tests inject isolated fixtures.
 */
export interface CourseUploadPolicyReader {
    loadCourse: (courseId: string) => Promise<{ id: string; tenant_id: string | null; instructor_id: string | null } | null>;
    loadActiveTeachingMembership: (userId: string, tenantId: string) => Promise<{ role_key: string } | null>;
    loadTenantOwner: (tenantId: string, userId: string) => Promise<{ id: string } | null>;
};

/** Membership role keys that carry the verified video-upload capability. */
export const VIDEO_UPLOAD_ROLE_KEYS = ['owner', 'instructor'] as const;

/**
 * Verified course-upload policy (server-side, deny-by-default):
 *  1. the course exists and is attached to a tenant;
 *  2. the caller holds an ACTIVE membership in that tenant with a teaching
 *     role_key (tenant_memberships + active tenant + active user). A JWT role
 *     claim never satisfies this — the upload capability itself is verified;
 *  3. and the caller owns the course (assigned instructor) or owns the tenant.
 *
 * Explicit per-course delegation is not modeled in the current schema (the
 * migrations contain no delegation table), so it cannot be honored yet: a
 * tenant member without course ownership stays denied until such a table is
 * explicitly approved.
 */
export const evaluateCourseUploadPolicy = async (
    user: { id: string },
    courseId: string,
    reader: CourseUploadPolicyReader,
): Promise<'allowed' | 'forbidden' | 'course_not_found'> => {
    const course = await reader.loadCourse(courseId);
    if (!course) return 'course_not_found';
    if (!course.tenant_id) return 'forbidden';

    const membership = await reader.loadActiveTeachingMembership(user.id, course.tenant_id);
    if (!membership || !VIDEO_UPLOAD_ROLE_KEYS.includes(membership.role_key as typeof VIDEO_UPLOAD_ROLE_KEYS[number])) {
        return 'forbidden';
    }

    if (course.instructor_id && String(course.instructor_id) === String(user.id)) return 'allowed';

    const tenantOwner = await reader.loadTenantOwner(course.tenant_id, user.id);
    return tenantOwner ? 'allowed' : 'forbidden';
};

const courseUploadPolicyReader: CourseUploadPolicyReader = {
    loadCourse: (courseId) => queryOne<{ id: string; tenant_id: string | null; instructor_id: string | null }>(
        'SELECT id, tenant_id, instructor_id FROM courses WHERE id = ?', [courseId]),
    loadActiveTeachingMembership: (userId, tenantId) => queryOne<{ role_key: string }>(
        `SELECT m.role_key
         FROM tenant_memberships m
         INNER JOIN tenants t ON t.id = m.tenant_id
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
           AND t.status = 'active' AND u.is_active = 1
           AND m.role_key IN ('owner','instructor')`,
        [userId, tenantId]),
    loadTenantOwner: (tenantId, userId) => queryOne<{ id: string }>(
        `SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active'`,
        [tenantId, userId]),
};

// ============================================
// PRIVATE UPLOAD CONTRACT (server-mediated bytes)
// ============================================

/**
 * Original uploads live under this prefix. The exact object key is always
 * generated by the server and bound to the platform video id — the browser
 * never receives a storage URL, presigned or otherwise.
 */
export const UPLOAD_OBJECT_KEY_PREFIX = 'originals/';

/** Upload extensions accepted by the platform, mapped to their content type. */
export const UPLOAD_EXTENSION_CONTENT_TYPES = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
} as const;

export type UploadExtension = keyof typeof UPLOAD_EXTENSION_CONTENT_TYPES;

export const UPLOAD_ALLOWED_EXTENSIONS = Object.keys(UPLOAD_EXTENSION_CONTENT_TYPES) as UploadExtension[];

export const UPLOAD_ALLOWED_CONTENT_TYPES: readonly string[] = Object.values(UPLOAD_EXTENSION_CONTENT_TYPES);

/** An in-progress upload older than this lifetime is expired and denied. */
export const DEFAULT_UPLOAD_SESSION_TTL_MINUTES = 60;

export const uploadSessionTtlMinutes = (): number => {
    const parsed = parseInt(process.env.VIDEO_UPLOAD_TTL_MINUTES || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UPLOAD_SESSION_TTL_MINUTES;
};

export const maxUploadSizeBytes = (): number =>
    Math.max(1, parseInt(process.env.VIDEO_MAX_SIZE_MB || '5000', 10)) * 1024 * 1024;

/** Server-side object key for an upload: `originals/<videoId><ext>`. */
export const uploadObjectKey = (videoId: string, extension: string): string =>
    `${UPLOAD_OBJECT_KEY_PREFIX}${videoId}${extension}`;

/**
 * Allowlisted extension for a client file name (deny-by-default: anything
 * outside the platform allowlist is rejected, never coerced).
 */
export const normalizeUploadExtension = (fileName: unknown): UploadExtension | null => {
    if (typeof fileName !== 'string' || fileName.length === 0) return null;
    const ext = path.extname(fileName).toLowerCase();
    return (UPLOAD_ALLOWED_EXTENSIONS as readonly string[]).includes(ext) ? (ext as UploadExtension) : null;
};

/**
 * A stored object key is resource-bound only when it is exactly the server key
 * for this video id under the originals prefix — a forged key, a foreign
 * resource, or any extra path segment fails this check.
 */
export const isResourceBoundUploadKey = (videoId: string, objectKey: string | null | undefined): boolean => {
    if (typeof objectKey !== 'string') return false;
    if (!objectKey.startsWith(`${UPLOAD_OBJECT_KEY_PREFIX}${videoId}.`)) return false;
    const extension = objectKey.slice(`${UPLOAD_OBJECT_KEY_PREFIX}${videoId}.`.length);
    return extension.length > 0 && !extension.includes('/');
};

/**
 * Resolves the content type of an in-flight upload: a declared type must be
 * allowlisted; when the browser declares none, the server falls back to the
 * allowlist mapping of the server-derived object extension.
 */
export const resolveUploadContentType = (headerType: string | undefined, extension: string): string | null => {
    const declared = (headerType ?? '').split(';')[0].trim().toLowerCase();
    if (declared) {
        return UPLOAD_ALLOWED_CONTENT_TYPES.includes(declared) ? declared : null;
    }
    return UPLOAD_EXTENSION_CONTENT_TYPES[extension.toLowerCase() as UploadExtension] ?? null;
};

/** In-progress upload session, bound to creator, tenant and resource. */
export interface UploadSessionRow {
    id: string;
    course_id: string;
    tenant_id: string | null;
    uploaded_by: string;
    original_key: string | null;
    file_size_bytes: number | string | null;
    status: string;
    created_at: Date;
    delivery_provider: string | null;
}

const asByteCount = (value: number | string | null): number | null => {
    if (value === null) return null;
    const parsed = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(parsed) ? parsed : null;
};

export interface UploadContentRequestInput {
    contentTypeHeader: string | undefined;
    contentLengthHeader: string | undefined;
    now: Date;
    maxSizeBytes: number;
    ttlMinutes: number;
}

export type UploadContentDecision =
    | { outcome: 'allowed'; objectKey: string; contentType: string; sizeBytes: number }
    | { outcome: 'expired' }
    | { outcome: 'unsupported_type' }
    | { outcome: 'invalid_size' }
    | { outcome: 'too_large' }
    | { outcome: 'invalid_key' };

/**
 * Decides whether byte transfer may start for an in-progress upload. Every
 * input is server state or a request header; the caller identity and tenant
 * binding are already enforced by the scoped session load.
 */
export const evaluateUploadContentRequest = (
    video: UploadSessionRow,
    input: UploadContentRequestInput,
): UploadContentDecision => {
    if (!isResourceBoundUploadKey(video.id, video.original_key)) return { outcome: 'invalid_key' };

    if (input.now.getTime() - video.created_at.getTime() > input.ttlMinutes * 60_000) {
        return { outcome: 'expired' };
    }

    const extension = path.extname(video.original_key!).toLowerCase();
    const contentType = resolveUploadContentType(input.contentTypeHeader, extension);
    if (!contentType) return { outcome: 'unsupported_type' };

    const declaredSize = asByteCount(video.file_size_bytes);
    if (declaredSize === null || declaredSize <= 0) return { outcome: 'invalid_size' };
    const ceiling = Math.min(declaredSize, input.maxSizeBytes);

    if (input.contentLengthHeader !== undefined) {
        const declaredLength = Number(input.contentLengthHeader);
        if (!Number.isFinite(declaredLength) || declaredLength <= 0) return { outcome: 'invalid_size' };
        if (declaredLength > ceiling) return { outcome: 'too_large' };
        return { outcome: 'allowed', objectKey: video.original_key!, contentType, sizeBytes: declaredLength };
    }

    return { outcome: 'allowed', objectKey: video.original_key!, contentType, sizeBytes: declaredSize };
};

export interface StoredUploadObject {
    size: number | string;
}

export type UploadCompletionDecision =
    | { outcome: 'allowed' }
    | { outcome: 'object_missing' }
    | { outcome: 'size_mismatch' }
    | { outcome: 'invalid_key' };

/**
 * Finalization is verified against storage before any processing claim: the
 * stored object must exist under the exact server-derived key with exactly
 * the declared size. Wrong tenant, forged key and replay never reach this
 * point because the session load is already scoped to creator + tenant.
 */
export const evaluateUploadCompletion = (
    video: UploadSessionRow,
    stored: StoredUploadObject | null,
): UploadCompletionDecision => {
    if (!isResourceBoundUploadKey(video.id, video.original_key)) return { outcome: 'invalid_key' };
    if (!stored) return { outcome: 'object_missing' };

    const storedSize = asByteCount(stored.size);
    const declaredSize = asByteCount(video.file_size_bytes);
    if (storedSize === null || declaredSize === null || storedSize <= 0 || storedSize !== declaredSize) {
        return { outcome: 'size_mismatch' };
    }
    return { outcome: 'allowed' };
};

/** Reads for the upload session lookup. Production wires them over the pool; tests inject fixtures. */
export interface UploadSessionReader {
    loadInProgressUpload: (videoId: string, userId: string, tenantId: string) => Promise<UploadSessionRow | null>;
}

export const createSqlUploadSessionReader = (deps: {
    queryOne: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
}): UploadSessionReader => ({
    loadInProgressUpload: (videoId, userId, tenantId) => deps.queryOne<UploadSessionRow>(
        `SELECT id, course_id, tenant_id, uploaded_by, original_key, file_size_bytes,
                status, created_at, delivery_provider
         FROM videos
         WHERE id = ? AND tenant_id = ? AND uploaded_by = ? AND status = 'uploading'`,
        [videoId, tenantId, userId],
    ),
});

const uploadSessionReader = createSqlUploadSessionReader({ queryOne });

/** Storage reads for finalization. Production reads MinIO; tests inject fakes. */
export interface UploadStorageVerifier {
    statOriginal: (objectKey: string) => Promise<StoredUploadObject | null>;
}

const uploadStorageVerifier: UploadStorageVerifier = {
    statOriginal: (objectKey) => getFileInfo(BUCKETS.ORIGINALS, objectKey),
};

/** API-relative path of the authenticated byte-transfer endpoint. */
export const uploadContentPath = (videoId: string): string => `/videos/upload/${videoId}/content`;

export interface UploadInitContract {
    provider: 'minio';
    videoId: string;
    uploadUrl: string;
    uploadMethod: 'PUT';
    authenticated: true;
    objectKey: string;
    expiresIn: number;
}

/**
 * The contract handed to the browser: bytes flow through the authenticated
 * API to a server-derived object key. It carries no storage URL of any kind.
 */
export const buildUploadInitContract = (
    videoId: string,
    objectKey: string,
    ttlMinutes: number,
): UploadInitContract => ({
    provider: 'minio',
    videoId,
    uploadUrl: uploadContentPath(videoId),
    uploadMethod: 'PUT',
    authenticated: true,
    objectKey,
    expiresIn: ttlMinutes * 60,
});

// ============================================
// CROSS-PROCESS UPLOAD SERIALIZATION + ATOMIC FINALIZATION
// ============================================

/**
 * MySQL named-lock name for one exact tenant/video pair. Hashing keeps the
 * name inside MySQL's 64-character limit while staying deterministic across
 * processes: the DATABASE holds the lock, so no process-local map can
 * bypass the serialization.
 */
export const uploadLockName = (tenantId: string, videoId: string): string =>
    `m1-upload-${createHash('sha256').update(`${tenantId}\n${videoId}`).digest('hex').slice(0, 32)}`;

/**
 * How long a second operation waits for the upload lock before it is denied.
 * A contended transfer/completion is a client-visible 409; the browser
 * complete retry re-attempts with backoff.
 */
export const UPLOAD_LOCK_TIMEOUT_SECONDS = 10;

/**
 * The dedicated connection that holds the named lock for one upload
 * operation — and the same connection the finalization transaction runs on,
 * so the lock covers claim + enqueue atomically.
 */
export interface UploadLockConnection {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number }>;
    beginTransaction: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
    release: () => Promise<void>;
    /** Closes the connection outright; MySQL frees its named locks with the session. */
    destroy?: () => Promise<void>;
}

export interface UploadLockHandle {
    connection: UploadLockConnection;
    release: () => Promise<void>;
}

export interface UploadLockManager {
    acquire: (tenantId: string, videoId: string) => Promise<UploadLockHandle | null>;
}

/**
 * Closes a lock connection outright. Used whenever a connection may still own
 * a named lock or is otherwise suspect: pooling it could hand a later
 * operation a session that already holds the lock. Adapters without destroy()
 * fall back to release(); a failure to close is swallowed because the session
 * (and its lock) is gone either way.
 */
const destroyUploadLockConnection = async (connection: UploadLockConnection): Promise<void> => {
    try {
        if (connection.destroy) {
            await connection.destroy();
        } else {
            await connection.release();
        }
    } catch {
        // The connection is gone; its named lock died with it.
    }
};

/**
 * Cross-process mutual exclusion over MySQL named locks: one dedicated
 * connection per critical section. Two requests, two workers, or two
 * processes never interleave byte transfer and finalization for the same
 * tenant/video. The lock dies with its connection, so a crashed holder
 * cannot deadlock the upload — MySQL releases it immediately.
 */
export const createSqlUploadLockManager = (deps: {
    acquireConnection: () => Promise<UploadLockConnection>;
    timeoutSeconds?: number;
}): UploadLockManager => ({
    acquire: async (tenantId: string, videoId: string): Promise<UploadLockHandle | null> => {
        const name = uploadLockName(tenantId, videoId);
        const timeout = deps.timeoutSeconds ?? UPLOAD_LOCK_TIMEOUT_SECONDS;
        const connection = await deps.acquireConnection();
        try {
            const rows = await connection.query<{ acquired: number }>(
                'SELECT GET_LOCK(?, ?) AS acquired',
                [name, timeout],
            );
            if (Number(rows[0]?.acquired) !== 1) {
                // Denied: the connection is healthy and holds nothing.
                await connection.release();
                return null;
            }
            return {
                connection,
                release: async (): Promise<void> => {
                    try {
                        await connection.query('SELECT RELEASE_LOCK(?)', [name]);
                        await connection.release();
                    } catch (error) {
                        // RELEASE_LOCK failed: this session may STILL own the
                        // named lock. Returning it to a pool would hand the next
                        // operation a connection already holding the lock;
                        // closing the session makes MySQL free it with the
                        // connection. Teardown failure must not fail an upload
                        // whose critical section already committed.
                        console.error('[Videos] Upload lock release failed; destroying the lock connection:', error);
                        await destroyUploadLockConnection(connection);
                    }
                },
            };
        } catch (error) {
            // The GET_LOCK round-trip itself failed: the connection is suspect
            // and may own the lock — never return it to a pool.
            await destroyUploadLockConnection(connection);
            throw error;
        }
    },
});

/**
 * A mysql2/promise pooled connection as the lock manager needs it. Keeping
 * the raw shape here lets the production wiring be exercised against injected
 * pools in tests and keeps the manager itself storage-agnostic.
 */
export interface UploadLockRawConnection {
    query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
    execute: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
    beginTransaction: () => Promise<void>;
    commit: () => Promise<void>;
    rollback: () => Promise<void>;
    release: () => void;
    destroy: () => void;
}

/** Maps a raw pooled connection onto the lock manager's connection contract. */
export const toUploadLockConnection = (connection: UploadLockRawConnection): UploadLockConnection => ({
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
        const [rows] = await connection.query(sql, params);
        return rows as unknown as T[];
    },
    execute: async (sql: string, params?: unknown[]) => {
        const [result] = await connection.execute(sql, params);
        return { affectedRows: (result as { affectedRows?: number }).affectedRows ?? 0 };
    },
    beginTransaction: () => connection.beginTransaction(),
    commit: () => connection.commit(),
    rollback: () => connection.rollback(),
    release: async () => {
        connection.release();
    },
    destroy: async () => {
        connection.destroy();
    },
});

/**
 * Builds a lock manager over ANY pool exposing getConnection(). Binding it
 * to a dedicated pool keeps held lock connections out of the shared request
 * pool entirely; the timeout is per critical section (a contended upload
 * waits, a contended processing run gives up immediately).
 */
export const createUploadLockManagerFromPool = (
    pool: {
        getConnection: () => Promise<UploadLockRawConnection>;
    },
    options: { timeoutSeconds?: number } = {},
): UploadLockManager =>
    createSqlUploadLockManager({
        acquireConnection: async () => toUploadLockConnection(await pool.getConnection()),
        timeoutSeconds: options.timeoutSeconds,
    });

/**
 * Size of the dedicated upload-lock pool. The shared request pool is capped
 * at 10 connections: if lock holders drew from it, every holder waiting on
 * its in-lock reads (session reload, authority recheck) would compete with
 * all other requests for the same slots and could stall the whole API. The
 * lock pool is separate and small — a contended extra acquisition queues on
 * this pool, never on request traffic.
 */
export const UPLOAD_LOCK_POOL_SIZE = 4;

let uploadLockPool: mysql.Pool | null = null;

/** The dedicated pool every production lock connection is drawn from. */
export const getUploadLockPool = (): mysql.Pool => {
    if (!uploadLockPool) {
        uploadLockPool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
            database: process.env.DB_NAME || 'Freelance',
            port: parseInt(process.env.DB_PORT || '3306', 10),
            waitForConnections: true,
            queueLimit: 0,
            connectionLimit: UPLOAD_LOCK_POOL_SIZE,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            charset: 'utf8mb4',
            timezone: '+02:00',
        });
        console.log(`[Videos] Upload lock pool created (${UPLOAD_LOCK_POOL_SIZE} connections, separate from the request pool)`);
    }
    return uploadLockPool;
};

/** Closes the dedicated lock pool (graceful shutdown / tests). */
export const closeUploadLockPool = async (): Promise<void> => {
    if (uploadLockPool) {
        const pool = uploadLockPool;
        uploadLockPool = null;
        await pool.end();
    }
};

/** Production lock manager over the DEDICATED lock pool (never the request pool). */
const sqlUploadLockManager = createUploadLockManagerFromPool({
    getConnection: () => getUploadLockPool().getConnection(),
});

/** The authenticated principal of an upload operation. */
export interface UploadPrincipal {
    id: string;
    tenantId?: string | null;
}

/**
 * Live re-authorization of an in-flight upload, run INSIDE the serialization
 * lock immediately before bytes are written and again inside the completion
 * critical section: the session must still be within its TTL, the selected
 * workspace must still be the course's tenant, and the caller must still
 * hold CURRENT course upload authority. A permission revoked after init,
 * or an expired session, denies before anything is written or claimed.
 */
export const recheckUploadAuthority = async (
    video: UploadSessionRow,
    user: UploadPrincipal,
    now: Date,
    reader: CourseUploadPolicyReader,
): Promise<'allowed' | 'expired' | 'forbidden'> => {
    if (now.getTime() - video.created_at.getTime() > uploadSessionTtlMinutes() * 60_000) {
        return 'expired';
    }

    const course = await reader.loadCourse(video.course_id);
    if (!course || !course.tenant_id) return 'forbidden';
    // The selected workspace must be the course's tenant; the session row is
    // already tenant-scoped to the principal, so this catches course/tenant drift.
    if (video.tenant_id && String(video.tenant_id) !== String(course.tenant_id)) return 'forbidden';

    const policy = await evaluateCourseUploadPolicy({ id: user.id }, video.course_id, reader);
    return policy === 'allowed' ? 'allowed' : 'forbidden';
};

export type UploadTransferOutcome =
    | { outcome: 'stored'; videoId: string; objectKey: string; sizeBytes: number }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
    | { outcome: 'expired' }
    | { outcome: 'forbidden' }
    | { outcome: 'unsupported_type' }
    | { outcome: 'invalid_size' }
    | { outcome: 'too_large' }
    | { outcome: 'invalid_key' }
    | { outcome: 'storage_failed' };

export interface UploadTransferDeps {
    loadInProgressUpload: UploadSessionReader['loadInProgressUpload'];
    acquireUploadLock: UploadLockManager['acquire'];
    transferBytes: (objectKey: string, stream: Readable, sizeBytes: number, contentType: string) => Promise<void>;
    recheckAuthority: (video: UploadSessionRow, user: UploadPrincipal, now: Date) => Promise<'allowed' | 'expired' | 'forbidden'>;
}

/**
 * Byte transfer, serialized cross-process per exact tenant/video:
 *  1. the session is loaded scoped to creator + tenant + in-progress;
 *  2. the transfer is authorized (TTL, type, size, resource-bound key);
 *  3. the DB named lock is acquired — a contended transfer is denied, never queued;
 *  4. INSIDE the lock the session is re-loaded: a finalization that committed
 *     while we waited turns this PUT into a late write, denied here;
 *  5. TTL and live course authority are re-checked before any byte;
 *  6. only then do the bytes stream, and the lock is released on every path.
 */
export const runUploadByteTransfer = async (
    videoId: string,
    user: UploadPrincipal,
    stream: Readable,
    headers: { contentType?: string; contentLength?: string },
    now: Date,
    deps: UploadTransferDeps,
): Promise<UploadTransferOutcome> => {
    const video = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
    if (!video) return { outcome: 'not_found' };

    const decision = evaluateUploadContentRequest(video, {
        contentTypeHeader: headers.contentType,
        contentLengthHeader: headers.contentLength,
        now,
        maxSizeBytes: maxUploadSizeBytes(),
        ttlMinutes: uploadSessionTtlMinutes(),
    });
    if (decision.outcome !== 'allowed') return { outcome: decision.outcome };

    const lock = await deps.acquireUploadLock(video.tenant_id ?? user.tenantId ?? '', videoId);
    if (!lock) return { outcome: 'busy' };

    try {
        // Fresh session inside the critical section: a finalization that
        // committed while this transfer waited for the lock must deny the
        // late bytes instead of overwriting finalized content.
        const current = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
        if (!current) return { outcome: 'not_found' };

        const authority = await deps.recheckAuthority(current, user, now);
        if (authority === 'expired') return { outcome: 'expired' };
        if (authority === 'forbidden') return { outcome: 'forbidden' };

        try {
            await deps.transferBytes(decision.objectKey, stream, decision.sizeBytes, decision.contentType);
        } catch (error) {
            console.error('[Videos] Byte transfer failed inside the upload lock:', error);
            return { outcome: 'storage_failed' };
        }
        return { outcome: 'stored', videoId, objectKey: decision.objectKey, sizeBytes: decision.sizeBytes };
    } finally {
        await lock.release();
    }
};

export type UploadCompletionOutcome =
    | { outcome: 'completed'; videoId: string }
    | { outcome: 'invalid_request' }
    | { outcome: 'not_found' }
    | { outcome: 'busy' }
    | { outcome: 'expired' }
    | { outcome: 'forbidden' }
    | { outcome: 'legacy_managed' }
    | { outcome: 'object_missing' }
    | { outcome: 'size_mismatch' }
    | { outcome: 'invalid_key' }
    | { outcome: 'enqueue_failed' };

export interface UploadCompletionDeps {
    loadInProgressUpload: UploadSessionReader['loadInProgressUpload'];
    acquireUploadLock: UploadLockManager['acquire'];
    statOriginal: UploadStorageVerifier['statOriginal'];
    recheckAuthority: (video: UploadSessionRow, user: UploadPrincipal, now: Date) => Promise<'allowed' | 'expired' | 'forbidden'>;
    /** Claims the session and enqueues the job as ONE transaction on the lock's connection. */
    claimAndEnqueue: (connection: UploadLockConnection) => (video: UploadSessionRow, user: UploadPrincipal) => Promise<'claimed' | 'already_finalized'>;
    startProcessing: (videoId: string, tenantId: string) => void;
}

/**
 * Claims the session and enqueues its processing job as ONE transaction on
 * the dedicated lock connection. If the enqueue fails, the rollback restores
 * 'uploading' and the upload stays retryable — the video is never left
 * 'processing' with no queued job.
 */
export const claimAndEnqueueOnConnection = (connection: UploadLockConnection) => async (
    video: UploadSessionRow,
    user: UploadPrincipal,
): Promise<'claimed' | 'already_finalized'> => {
    const tenantId = user.tenantId ?? video.tenant_id ?? '';
    await connection.beginTransaction();
    try {
        const claim = await connection.execute(
            `UPDATE videos SET status = 'processing'
             WHERE id = ? AND tenant_id = ? AND uploaded_by = ? AND status = 'uploading'`,
            [video.id, tenantId, video.uploaded_by],
        );
        if (claim.affectedRows !== 1) {
            await connection.rollback();
            return 'already_finalized';
        }
        await connection.execute(
            `INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
             VALUES (?, ?, ?, 'pending', NOW())
             ON DUPLICATE KEY UPDATE status = 'pending', created_at = NOW()`,
            [uuidv4(), video.id, tenantId],
        );
        await connection.commit();
        return 'claimed';
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error('[Videos] Rollback after a failed claim+enqueue failed:', rollbackError);
        }
        throw error;
    }
};

/**
 * Finalization, serialized cross-process per exact tenant/video:
 *  1. the session is loaded scoped to creator + tenant + in-progress;
 *  2. the lock is acquired — a completion racing an in-flight transfer is
 *     denied (409) instead of claiming bytes that are still arriving;
 *  3. INSIDE the lock: the session is re-loaded (replay/race denied), TTL and
 *     live course authority are re-checked, and storage is verified (key,
 *     existence, exact size);
 *  4. claim + queue insert commit as ONE transaction on the SAME dedicated
 *     connection that holds the lock; a failed enqueue rolls back, so the
 *     session stays 'uploading' and the upload remains retryable;
 *  5. the lock is always released; processing starts only after the commit.
 */
export const runUploadCompletion = async (
    videoId: unknown,
    user: UploadPrincipal,
    now: Date,
    deps: UploadCompletionDeps,
): Promise<UploadCompletionOutcome> => {
    if (typeof videoId !== 'string' || videoId.length === 0) return { outcome: 'invalid_request' };

    const video = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
    if (!video) return { outcome: 'not_found' };
    if (video.delivery_provider === 'vdocipher') return { outcome: 'legacy_managed' };

    const lock = await deps.acquireUploadLock(video.tenant_id ?? user.tenantId ?? '', videoId);
    if (!lock) return { outcome: 'busy' };

    try {
        const current = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
        if (!current) return { outcome: 'not_found' };

        const authority = await deps.recheckAuthority(current, user, now);
        if (authority === 'expired') return { outcome: 'expired' };
        if (authority === 'forbidden') return { outcome: 'forbidden' };

        const stored = await deps.statOriginal(current.original_key ?? '');
        const completion = evaluateUploadCompletion(current, stored);
        if (completion.outcome !== 'allowed') return { outcome: completion.outcome };

        try {
            const claim = await deps.claimAndEnqueue(lock.connection)(current, user);
            if (claim === 'already_finalized') return { outcome: 'not_found' };
        } catch (error) {
            // The transaction rolled back: the session is still 'uploading'
            // with its bytes intact, so the client can retry completion.
            console.error('[Videos] Upload claim + enqueue transaction failed:', error);
            return { outcome: 'enqueue_failed' };
        }
    } finally {
        await lock.release();
    }

    // Background processing starts only after the claim+enqueue commit.
    deps.startProcessing(videoId, user.tenantId ?? video.tenant_id ?? '');
    return { outcome: 'completed', videoId };
};

// ============================================
// PROCESSING JOB LIFECYCLE (the single protected execution path)
// ============================================

/**
 * ONE execution path for every processing run in the platform: upload
 * completion, startup recovery, the periodic queue consumer, admin recovery,
 * and the user retry/reprocess routes. A run is:
 *  - tenant-verified against BOTH the queue row and the video row
 *    (exact match, non-null, deny inconsistent rows);
 *  - excluded cross-process by a MySQL named lock — a per-process Set
 *    cannot see a second server process, so it alone is insufficient;
 *  - claimed atomically on the queue row (pending, or a stale 'processing'
 *    row whose claimant died — the lock proves liveness before takeover);
 *  - bounded by in-process concurrency, and never started during shutdown;
 *  - settled on EVERY terminal path, so the queue row and the video row
 *    always end consistent (completed/failed), never a stranded 'pending'.
 */

/**
 * Size of the dedicated processing-lock pool. A processing run holds its
 * lock connection for the WHOLE job (minutes of transcoding), so it must
 * draw from neither the 10-slot request pool (would stall the API behind
 * one long job) nor the small upload-lock pool. Sized for the bounded
 * concurrency plus one recovery probe.
 */
export const PROCESSING_LOCK_POOL_SIZE = 3;

/**
 * How long a queue row may sit in 'processing' before recovery treats the
 * previous claimant as dead. The run's named lock is the authoritative
 * liveness check (a dead holder's session releases it immediately); this
 * horizon only stops the sweep from probing locks for rows claimed a
 * moment ago — including the crash window between claim and lock.
 */
export const DEFAULT_PROCESSING_LEASE_MINUTES = 60;

export const processingLeaseMinutes = (): number => {
    const parsed = parseInt(process.env.VIDEO_PROCESSING_LEASE_MINUTES || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROCESSING_LEASE_MINUTES;
};

/** Bounded in-process concurrency for processing runs. */
export const DEFAULT_PROCESSING_CONCURRENCY = 2;

export const videoProcessingConcurrency = (): number => {
    const parsed = parseInt(process.env.VIDEO_PROCESSING_CONCURRENCY || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROCESSING_CONCURRENCY;
};

/** Queue consumer cadence: committed rows are eventually consumed even if a startup sweep failed. */
export const DEFAULT_VIDEO_QUEUE_POLL_SECONDS = 60;

export const videoQueuePollSeconds = (): number => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_POLL_SECONDS || '', 10);
    return Number.isFinite(parsed) && parsed >= 5 ? parsed : DEFAULT_VIDEO_QUEUE_POLL_SECONDS;
};

/** Upper bound on queue rows handled per sweep — never launch everything at once. */
export const DEFAULT_VIDEO_QUEUE_BATCH_SIZE = 10;

export const videoQueueBatchSize = (): number => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_BATCH_SIZE || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VIDEO_QUEUE_BATCH_SIZE;
};

/** Retry policy for a transient queue READ failure (backoff = base * 2^(attempt-1)). */
export const DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS = 3;
export const DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS = 1000;

export const videoQueueLoadAttempts = (): number => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_LOAD_ATTEMPTS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS;
};

export const videoQueueLoadBackoffMs = (): number => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_LOAD_BACKOFF_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS;
};

let processingLockPool: mysql.Pool | null = null;

/** The dedicated pool every processing-lock connection is drawn from. */
export const getProcessingLockPool = (): mysql.Pool => {
    if (!processingLockPool) {
        processingLockPool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
            database: process.env.DB_NAME || 'Freelance',
            port: parseInt(process.env.DB_PORT || '3306', 10),
            waitForConnections: true,
            queueLimit: 0,
            connectionLimit: PROCESSING_LOCK_POOL_SIZE,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            charset: 'utf8mb4',
            timezone: '+02:00',
        });
        console.log(`[Videos] Processing lock pool created (${PROCESSING_LOCK_POOL_SIZE} connections, separate from the request and upload-lock pools)`);
    }
    return processingLockPool;
};

/** Closes the dedicated processing-lock pool (graceful shutdown / tests). */
export const closeProcessingLockPool = async (): Promise<void> => {
    if (processingLockPool) {
        const pool = processingLockPool;
        processingLockPool = null;
        await pool.end();
    }
};

/**
 * Production processing lock manager over the DEDICATED processing-lock
 * pool. Timeout 0: a contended run means another process is already
 * executing THIS video — denying is the safe answer, never a queue.
 */
const sqlProcessingLockManager = createUploadLockManagerFromPool(
    { getConnection: () => getProcessingLockPool().getConnection() },
    { timeoutSeconds: 0 },
);

/** Stable-ish identifier of the executing worker, recorded on the queue row. */
export const videoProcessingWorkerId = (): string =>
    `wb-${process.pid}-${createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8)}`;

/** A queue row plus its video row, as the protected path needs them. */
export interface VideoJobRow {
    videoId: string;
    tenantId: string;
    queueStatus: 'pending' | 'processing' | 'completed' | 'failed';
    videoStatus: string;
}

export interface VideoJobRunDeps {
    /** Loads queue+video rows under EXACT tenant matching; null when they are missing or inconsistent. */
    loadJob: (videoId: string, tenantId: string) => Promise<VideoJobRow | null>;
    acquireProcessingLock: UploadLockManager['acquire'];
    /** Atomically claims the row (pending, or stale processing) for this worker. */
    claimJob: (videoId: string, workerId: string) => Promise<boolean>;
    /** Settles the queue row to a terminal state consistent with the video row. */
    settleJob: (videoId: string, outcome: VideoJobSettleOutcome) => Promise<void>;
    runProcessing: (videoId: string, tenantId: string) => Promise<void>;
    workerId: string;
}

export type VideoJobSettleOutcome =
    | { settled: 'completed' }
    | { settled: 'failed'; error: string };

export type VideoJobOutcome =
    | 'processed'
    | 'processing_failed'
    | 'already_settled'
    | 'locked'
    | 'no_job'
    | 'video_not_processing';

const settleVideoJob = async (
    deps: VideoJobRunDeps,
    videoId: string,
    outcome: VideoJobSettleOutcome,
): Promise<void> => {
    try {
        await deps.settleJob(videoId, outcome);
    } catch (error) {
        // A settle failure must never crash the worker or mask the run
        // result: the next sweep re-settles once the row is stale.
        console.error(`[Videos] Failed to settle processing job ${videoId} as ${outcome.settled}:`, error);
    }
};

/**
 * The protected processing run. Order matters:
 *  1. tenant/video/job ownership is re-verified from the DATABASE (exact
 *     non-null tenant match between the queue row and the video row) — a
 *     forged or drifted tenant is denied before anything runs;
 *  2. idempotency guards: a settled row, or a video that already reached
 *     ready/failed, is never re-run (a ready video has no original left);
 *  3. the cross-process named lock is acquired — a second process,
 *     or a second pass in another process, is denied here;
 *  4. only THEN is the row claimed, the processor invoked, and the row
 *     settled — inside the lock, with the lock released on every path.
 */
export const runVideoProcessingJob = async (
    videoId: string,
    tenantId: string,
    deps: VideoJobRunDeps,
): Promise<VideoJobOutcome> => {
    if (!tenantId) return 'no_job';

    const job = await deps.loadJob(videoId, tenantId);
    if (!job) return 'no_job';

    if (job.queueStatus === 'completed' || job.queueStatus === 'failed') return 'already_settled';

    if (job.videoStatus === 'ready') {
        // The run finished but its settle was lost: settle without re-running.
        await settleVideoJob(deps, videoId, { settled: 'completed' });
        return 'already_settled';
    }
    if (job.videoStatus === 'failed') {
        await settleVideoJob(deps, videoId, { settled: 'failed', error: 'video row is failed; job settled from the video state' });
        return 'already_settled';
    }
    if (job.videoStatus !== 'processing') return 'video_not_processing';

    // Cross-process exclusion: a live run in another process holds this.
    const lock = await deps.acquireProcessingLock(job.tenantId, videoId);
    if (!lock) return 'locked';

    try {
        // We hold the lock, so no live claimant exists for this video: a
        // 'processing' row here is either a fresh legitimate claim or a
        // claimant that died between its claim and its lock. Re-stamping is
        // the takeover; pending rows are the normal case.
        const claimed = await deps.claimJob(videoId, deps.workerId);
        if (!claimed) return 'no_job';

        try {
            await deps.runProcessing(videoId, job.tenantId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await settleVideoJob(deps, videoId, { settled: 'failed', error: message });
            return 'processing_failed';
        }

        await settleVideoJob(deps, videoId, { settled: 'completed' });
        return 'processed';
    } finally {
        await lock.release();
    }
};

/** Production job loader: exact tenant matching, both rows non-null. */
export const createSqlVideoJobLoader = (deps: {
    queryOne: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
}) => async (videoId: string, tenantId: string): Promise<VideoJobRow | null> => {
    if (!tenantId) return null;
    const row = await deps.queryOne<{
        queue_status: VideoJobRow['queueStatus'];
        video_status: string;
    }>(
        `SELECT q.status AS queue_status, v.status AS video_status
         FROM video_processing_queue q
         INNER JOIN videos v ON v.id = q.video_id
         WHERE q.video_id = ?
           AND q.tenant_id IS NOT NULL
           AND v.tenant_id IS NOT NULL
           AND q.tenant_id = v.tenant_id
           AND q.tenant_id = ?`,
        [videoId, tenantId],
    );
    if (!row) return null;
    return { videoId, tenantId, queueStatus: row.queue_status, videoStatus: row.video_status };
};

/** Production claim: takes the row for this worker, normalizing staleness. */
export const createSqlVideoJobClaim = (deps: {
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number }>;
}) => async (videoId: string, workerId: string): Promise<boolean> => {
    const result = await deps.execute(
        `UPDATE video_processing_queue
         SET status = 'processing', started_at = NOW(), worker_id = ?
         WHERE video_id = ? AND status IN ('pending', 'processing')`,
        [workerId, videoId],
    );
    return result.affectedRows === 1;
};

/** Production settler: terminal states only, never clobbering a settled row. */
export const createSqlVideoJobSettler = (deps: {
    execute: (sql: string, params?: unknown[]) => Promise<{ affectedRows: number }>;
}) => async (videoId: string, outcome: VideoJobSettleOutcome): Promise<void> => {
    if (outcome.settled === 'completed') {
        await deps.execute(
            `UPDATE video_processing_queue
             SET status = 'completed', completed_at = NOW(), error_message = NULL, worker_id = NULL
             WHERE video_id = ? AND status <> 'completed'`,
            [videoId],
        );
        return;
    }
    await deps.execute(
        `UPDATE video_processing_queue
         SET status = 'failed', completed_at = NOW(), error_message = ?, worker_id = NULL
         WHERE video_id = ? AND status <> 'failed'`,
        [outcome.error.slice(0, 1000), videoId],
    );
};

const videoJobRunDeps: VideoJobRunDeps = {
    loadJob: createSqlVideoJobLoader({ queryOne }),
    acquireProcessingLock: sqlProcessingLockManager.acquire,
    claimJob: createSqlVideoJobClaim({ execute }),
    settleJob: createSqlVideoJobSettler({ execute }),
    runProcessing: (videoId, tenantId) => processVideo(videoId, tenantId),
    workerId: videoProcessingWorkerId(),
};

/**
 * In-flight + concurrency guard for THIS process. Cross-process exclusion
 * is the named lock inside runVideoProcessingJob; this guard keeps a single
 * process from stacking duplicate runs and bounds how many transcodes run
 * at once. Jobs that arrive while saturated are simply left in the queue:
 * the periodic consumer picks them up.
 */
const inFlightVideoProcessing = new Set<string>();
let activeVideoProcessing = 0;
let videoProcessingShuttingDown = false;

export const isVideoProcessingShutdown = (): boolean => videoProcessingShuttingDown;

/** Blocks new processing runs; in-flight runs continue until they settle. */
export const requestVideoProcessingShutdown = (): void => {
    videoProcessingShuttingDown = true;
};

export const inFlightVideoProcessingCount = (): number => inFlightVideoProcessing.size;

export type VideoJobStartOutcome =
    | 'started'
    | 'already_running'
    | 'saturated'
    | 'shutting_down';

const startVideoProcessing = (videoId: string, tenantId: string): VideoJobStartOutcome => {
    if (videoProcessingShuttingDown) return 'shutting_down';
    if (inFlightVideoProcessing.has(videoId)) return 'already_running';
    if (activeVideoProcessing >= videoProcessingConcurrency()) return 'saturated';

    activeVideoProcessing++;
    inFlightVideoProcessing.add(videoId);
    void runVideoProcessingJob(videoId, tenantId, videoJobRunDeps)
        .catch((error) => {
            // runVideoProcessingJob contains its own failures; reaching here
            // means an adapter-level fault. The row stays claimable for a
            // later sweep.
            console.error(`[Videos] Protected processing run failed for ${videoId}:`, error);
        })
        .finally(() => {
            inFlightVideoProcessing.delete(videoId);
            activeVideoProcessing--;
        });
    return 'started';
};

/** Production wiring for the authenticated byte-transfer endpoint. */
const uploadTransferDeps: UploadTransferDeps = {
    loadInProgressUpload: uploadSessionReader.loadInProgressUpload,
    acquireUploadLock: sqlUploadLockManager.acquire,
    transferBytes: (objectKey, stream, sizeBytes, contentType) =>
        putObjectStream(BUCKETS.ORIGINALS, objectKey, stream, sizeBytes, contentType),
    recheckAuthority: (video, user, now) => recheckUploadAuthority(video, user, now, courseUploadPolicyReader),
};

/** Production wiring for the finalization endpoint. */
const uploadCompletionDeps: UploadCompletionDeps = {
    loadInProgressUpload: uploadSessionReader.loadInProgressUpload,
    acquireUploadLock: sqlUploadLockManager.acquire,
    statOriginal: uploadStorageVerifier.statOriginal,
    recheckAuthority: (video, user, now) => recheckUploadAuthority(video, user, now, courseUploadPolicyReader),
    claimAndEnqueue: claimAndEnqueueOnConnection,
    startProcessing: startVideoProcessing,
};

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
router.get('/security/violations/:userId', authenticateToken, requireAdminPermission(PLATFORM_SECURITY_PERMISSION), async (req: Request, res: Response) => {
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
router.get('/security/all-violations', authenticateToken, requireAdminPermission(PLATFORM_SECURITY_PERMISSION), async (req: Request, res: Response) => {
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
 * Returns the private upload contract: authenticated byte transfer through
 * this API to a server-generated object key (no storage URL reaches the browser)
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
            file_size,
            content_type
        } = req.body;
        const uploaded_by = req.user!.id;
        const tenantId = req.user!.tenantId;

        // Validation
        if (!course_id || !title || !file_name || !uploaded_by || !tenantId) {
            return res.status(400).json({
                error: 'course_id, title, file_name, and uploaded_by are required'
            });
        }

        // Verified upload policy: active teaching membership in the course's
        // tenant (upload capability) + course ownership or tenant ownership.
        // Deny-by-default for students, unassistable members, and members of
        // other tenants.
        const uploadPolicy = await evaluateCourseUploadPolicy(req.user!, course_id, courseUploadPolicyReader);
        if (uploadPolicy === 'course_not_found') {
            return res.status(404).json({ error: 'Course not found' });
        }
        if (uploadPolicy === 'forbidden') {
            return res.status(403).json({ error: 'Video upload is not permitted for this course' });
        }

        // Constrain size and type server-side before allocating anything:
        // the declared size must be a positive byte count within the platform
        // limit, and the file extension must be allowlisted.
        const maxSizeBytes = maxUploadSizeBytes();
        const declaredSize = asByteCount(typeof file_size === 'string' ? Number(file_size) : file_size);
        if (declaredSize === null || declaredSize <= 0 || declaredSize > maxSizeBytes) {
            return res.status(400).json({
                error: `File size must be a positive number up to ${Math.floor(maxSizeBytes / (1024 * 1024))}MB`
            });
        }

        const extension = normalizeUploadExtension(file_name);
        if (!extension) {
            return res.status(400).json({
                error: `Unsupported file extension. Allowed: ${UPLOAD_ALLOWED_EXTENSIONS.join(', ')}`
            });
        }

        if (content_type !== undefined && content_type !== null) {
            const declaredType = String(content_type).split(';')[0].trim().toLowerCase();
            if (!UPLOAD_ALLOWED_CONTENT_TYPES.includes(declaredType)) {
                return res.status(400).json({ error: 'Unsupported content type' });
            }
        }

        // Keep the platform UUID separate from the provider asset id so the
        // existing ownership and entitlement model remains unchanged.
        const videoId = uuidv4();

        // The exact object key is generated here, on the server, bound to the
        // video id; the client never proposes or receives a storage path.
        const objectKey = uploadObjectKey(videoId, extension);

        // Create video record in database
        await execute(
            `INSERT INTO videos
            (id, course_id, tenant_id, lecture_id, material_id, title, description,
             file_size_bytes, original_key, uploaded_by, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
            [
                videoId,
                course_id,
                tenantId,
                lecture_id || null,
                material_id || null,
                title,
                description || null,
                declaredSize,
                objectKey,
                uploaded_by
            ]
        );

        const ttlMinutes = uploadSessionTtlMinutes();
        console.log(`[Videos] Initialized private upload for video ${videoId}`);

        res.json(buildUploadInitContract(videoId, objectKey, ttlMinutes));

    } catch (error) {
        console.error('[Videos] Upload init error:', error);
        res.status(500).json({ error: 'Failed to initialize upload' });
    }
});

/**
 * Private byte transfer for an in-progress upload.
 * The request body is streamed through the authenticated API into the exact
 * server-derived object key — there is no anonymous storage PUT and no
 * presigned URL is ever handed to the browser.
 */
router.put('/upload/:videoId/content', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        const outcome = await runUploadByteTransfer(
            videoId,
            { id: req.user!.id, tenantId: req.user!.tenantId },
            req,
            {
                contentType: req.headers['content-type'],
                contentLength: req.headers['content-length'],
            },
            new Date(),
            uploadTransferDeps,
        );

        switch (outcome.outcome) {
            case 'stored':
                console.log(`[Videos] Received ${outcome.sizeBytes} bytes for video ${videoId}`);
                return res.status(201).json({
                    success: true,
                    videoId: outcome.videoId,
                    objectKey: outcome.objectKey,
                    sizeBytes: outcome.sizeBytes,
                });
            case 'not_found':
                return res.status(404).json({ error: 'Upload session not found' });
            case 'busy':
                return res.status(409).json({ error: 'Another transfer for this upload is in progress. Retry after it finishes.' });
            case 'expired':
                return res.status(410).json({ error: 'Upload session expired. Start a new upload.' });
            case 'forbidden':
                return res.status(403).json({ error: 'Upload permission was revoked or is no longer valid' });
            case 'unsupported_type':
                return res.status(415).json({ error: 'Unsupported video content type' });
            case 'invalid_size':
            case 'too_large':
                return res.status(413).json({ error: 'Uploaded bytes exceed the allowed size' });
            case 'invalid_key':
                return res.status(409).json({ error: 'Upload target does not match this video' });
            case 'storage_failed':
                return res.status(502).json({ error: 'Failed to store uploaded video' });
        }
    } catch (error) {
        console.error('[Videos] Byte transfer error:', error);
        res.status(502).json({ error: 'Failed to store uploaded video' });
    }
});

/**
 * Complete upload and start processing
 * Called by frontend after the byte transfer succeeded
 */
router.post('/upload/complete', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const outcome = await runUploadCompletion(
            req.body?.videoId,
            { id: req.user!.id, tenantId: req.user!.tenantId },
            new Date(),
            uploadCompletionDeps,
        );

        switch (outcome.outcome) {
            case 'completed':
                console.log(`[Videos] Upload complete for ${outcome.videoId}, processing started`);
                return res.json({
                    success: true,
                    videoId: outcome.videoId,
                    status: 'processing',
                    message: 'Video upload complete. Processing started.'
                });
            case 'invalid_request':
                return res.status(400).json({ error: 'videoId is required' });
            case 'not_found':
                return res.status(404).json({ error: 'Video not found or already processed' });
            case 'busy':
                return res.status(409).json({ error: 'Another operation for this upload is in progress. Retry shortly.' });
            case 'expired':
                return res.status(410).json({ error: 'Upload session expired. Start a new upload.' });
            case 'forbidden':
                return res.status(403).json({ error: 'Upload permission was revoked or is no longer valid' });
            case 'legacy_managed':
                return res.status(409).json({ error: 'Legacy managed videos must be uploaded again to encrypted HLS.' });
            case 'object_missing':
                return res.status(409).json({ error: 'Uploaded file was not received. Restart the upload.' });
            case 'size_mismatch':
                return res.status(409).json({ error: 'Uploaded file size does not match the declared size' });
            case 'invalid_key':
                return res.status(409).json({ error: 'Uploaded object does not match this video' });
            case 'enqueue_failed':
                // The transaction rolled back: the session is still 'uploading'
                // with its bytes intact, so the client may retry completion.
                return res.status(500).json({ error: 'Failed to start processing. The upload is still retryable.' });
        }
    } catch (error) {
        console.error('[Videos] Upload complete error:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
});

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
             FROM videos WHERE id = ? AND tenant_id = ? AND uploaded_by = ?`,
            [videoId, req.user!.tenantId, req.user!.id]
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
            // Tenant context is required and verified inside the processor.
            await deleteVideoFiles(videoId, video.tenant_id ?? undefined);
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
 * Recover stuck PROCESSING (admin, verified platform capability).
 *
 * Only videos parked in 'processing' (a worker died mid-run) or settled
 * 'failed' (an explicit operator retry) are candidates, and only past the
 * stuck threshold. Videos still 'uploading' are LIVE uploads: re-queueing
 * them would race the byte transfer and could process truncated bytes, so
 * they are counted and left untouched. Every recovery re-opens the job row
 * and goes through the same protected execution path — the named lock
 * excludes a live run elsewhere before anything restarts.
 */
router.post('/upload/recover-stuck', authenticateToken, requireAdminPermission(PLATFORM_SECURITY_PERMISSION), async (req: Request, res: Response) => {
    try {
        const stuckVideos = await query<{ id: string; tenant_id: string; status: string }>(
            `SELECT id, tenant_id, status FROM videos
             WHERE tenant_id IS NOT NULL AND status IN ('processing', 'failed') AND delivery_provider = 'minio'
               AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
             LIMIT ?`,
            [videoQueueBatchSize()]
        );

        const liveUploads = await queryOne<{ total: number }>(
            `SELECT COUNT(*) AS total FROM videos
             WHERE tenant_id IS NOT NULL AND status = 'uploading' AND delivery_provider = 'minio'`,
            []
        );

        if (!stuckVideos || stuckVideos.length === 0) {
            return res.json({
                recovered: 0,
                message: 'No stuck processing videos found',
                liveUploadsLeftAlone: liveUploads?.total ?? 0,
            });
        }

        let recovered = 0;
        for (const video of stuckVideos) {
            try {
                // Re-arm the video (a failed video must sit in 'processing'
                // to be re-run) and re-open its job row. A row a live run
                // elsewhere is executing is reset to 'pending' and settled
                // by that run — the lock still prevents a second pass.
                await execute(
                    `UPDATE videos SET status = 'processing', processing_progress = 0, processing_error = NULL
                     WHERE id = ? AND tenant_id = ?`,
                    [video.id, video.tenant_id]
                );
                await execute(
                    `INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
                     VALUES (?, ?, ?, 'pending', NOW())
                     ON DUPLICATE KEY UPDATE status = 'pending', started_at = NULL, completed_at = NULL, error_message = NULL, worker_id = NULL`,
                    [uuidv4(), video.id, video.tenant_id]
                );
                const outcome = startVideoProcessing(video.id, video.tenant_id);
                if (outcome !== 'shutting_down') recovered++;
                console.log(`[Videos] Recovered stuck video ${video.id} (${outcome})`);
            } catch (err) {
                console.error(`[Videos] Error recovering ${video.id}:`, err);
            }
        }

        res.json({
            recovered,
            total: stuckVideos.length,
            liveUploadsLeftAlone: liveUploads?.total ?? 0,
        });

    } catch (error) {
        console.error('[Videos] Recover stuck error:', error);
        res.status(500).json({ error: 'Failed to recover stuck videos' });
    }
});

// ============================================
// PROCESSING QUEUE RECONCILIATION (the post-restart consumer)
// ============================================

/**
 * One committed queue row that still owes a processing run: the claim+enqueue
 * transaction committed, then the process died (or the in-process run was lost
 * to a restart) before the video left 'processing'.
 */
export interface PendingVideoJob {
    videoId: string;
    tenantId: string;
}

export interface VideoQueueReconciliationDeps {
    loadPendingJobs: () => Promise<PendingVideoJob[]>;
    isProcessing: (videoId: string) => boolean;
    /**
     * The protected starter. Returns the start outcome; a `void` return
     * (test doubles) is treated as 'started'. 'saturated'/'shutting_down'
     * stop the sweep — the remaining rows wait for the next cycle.
     */
    startProcessing: (videoId: string, tenantId: string) => VideoJobStartOutcome | void;
}

/**
 * Feeds every stranded queue row to the processor. This is the consumer that
 * makes video_processing_queue durable across restarts: the claim+enqueue
 * transaction commits the row, and this reconciliation (run at startup, and
 * on a cadence) picks it up when the original in-process run is gone. A
 * single failure never aborts the sweep, and a load failure is contained so
 * reconciliation can never crash startup. The sweep is bounded: it stops at
 * the batch size (loader LIMIT) and at in-process concurrency saturation.
 */
export const reconcileVideoProcessingQueue = async (
    deps: VideoQueueReconciliationDeps,
): Promise<{ requeued: string[] }> => {
    const requeued: string[] = [];
    let pending: PendingVideoJob[];
    try {
        pending = await deps.loadPendingJobs();
    } catch (error) {
        console.error('[Videos] Pending processing job load failed:', error);
        return { requeued };
    }
    for (const job of pending) {
        if (deps.isProcessing(job.videoId)) continue; // an in-flight run owns it
        try {
            const outcome = deps.startProcessing(job.videoId, job.tenantId);
            if (outcome === 'saturated' || outcome === 'shutting_down') break;
            if (outcome === 'already_running') continue;
            requeued.push(job.videoId);
        } catch (error) {
            console.error(`[Videos] Failed to requeue processing for ${job.videoId}:`, error);
        }
    }
    return { requeued };
};

/**
 * Production pending-job reader: rows that still owe a processing run —
 * 'pending' rows (committed claim+enqueue whose run was lost to a restart),
 * and 'processing' rows whose started_at predates the lease horizon (the
 * claimant died; the named-lock check inside the run proves liveness before
 * any takeover). EXACT tenant matching is part of the read: both tenants
 * non-null and equal, so an inconsistent row can never be claimed. Bounded
 * by the configured batch size. Injected over `run` so the emitted SQL can
 * be exercised without a database.
 */
export const createPendingVideoJobLoader = (
    run: (sql: string, params?: unknown[]) => Promise<{ video_id: string; tenant_id: string | null }[]>,
    options: { leaseMinutes?: number; batchSize?: number } = {},
) => async (): Promise<PendingVideoJob[]> => {
    const leaseMinutes = options.leaseMinutes ?? processingLeaseMinutes();
    const batchSize = options.batchSize ?? videoQueueBatchSize();
    const rows = await run(
        `SELECT q.video_id, q.tenant_id
         FROM video_processing_queue q
         INNER JOIN videos v ON v.id = q.video_id
         WHERE q.status IN ('pending', 'processing')
           AND v.status = 'processing'
           AND v.delivery_provider = 'minio'
           AND q.tenant_id IS NOT NULL
           AND v.tenant_id IS NOT NULL
           AND q.tenant_id = v.tenant_id
           AND (q.status = 'pending' OR q.started_at IS NULL OR q.started_at < DATE_SUB(NOW(), INTERVAL ? MINUTE))
         ORDER BY q.created_at
         LIMIT ?`,
        [leaseMinutes, batchSize],
    );
    return rows.map((row) => ({ videoId: row.video_id, tenantId: row.tenant_id ?? '' }));
};

/**
 * Retries a transient queue READ with exponential backoff; the read must
 * not be silently lost — the committed rows stay owed to a run. Injectable
 * load/sleep keep it exercisable without a database.
 */
export const loadPendingJobsWithRetry = async (
    load: () => Promise<PendingVideoJob[]>,
    options: {
        attempts?: number;
        backoffMs?: number;
        sleep?: (ms: number) => Promise<void>;
    } = {},
): Promise<PendingVideoJob[]> => {
    const attempts = options.attempts ?? videoQueueLoadAttempts();
    const backoffMs = options.backoffMs ?? videoQueueLoadBackoffMs();
    const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await load();
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                await sleep(backoffMs * 2 ** (attempt - 1));
            }
        }
    }
    throw lastError;
};

/**
 * One full recovery sweep: a retrying read followed by the contained
 * reconciliation. `loadFailed` distinguishes "queue drained" from "queue
 * unreadable" — the periodic consumer keeps retrying either way.
 */
export const startVideoQueueReconciliation = async (): Promise<{ requeued: string[]; loadFailed: boolean }> => {
    let jobs: PendingVideoJob[];
    try {
        jobs = await loadPendingJobsWithRetry(() => createPendingVideoJobLoader(query)());
    } catch (error) {
        console.error('[Videos] Pending processing job load failed after retries:', error);
        return { requeued: [], loadFailed: true };
    }
    const result = await reconcileVideoProcessingQueue({
        loadPendingJobs: async () => jobs,
        isProcessing: (videoId) => inFlightVideoProcessing.has(videoId),
        startProcessing: startVideoProcessing,
    });
    return { ...result, loadFailed: false };
};

export interface VideoQueueConsumerHandle {
    /** Runs one sweep now; a no-op during shutdown. */
    sweep: () => Promise<{ requeued: string[]; loadFailed: boolean }>;
    /** Starts the periodic consumer; the first sweep runs immediately. */
    start: () => void;
    /** Stops the periodic consumer; in-flight runs settle on their own. */
    stop: () => void;
}

/**
 * The single periodic consumer: after a restart, and then on a cadence,
 * every committed queue row that still owes a run is fed through the same
 * protected execution path as the upload-completion path. The timer is
 * unref'd (it never holds the process open) and stops cleanly on shutdown.
 * The sweep is injectable so the cadence itself is testable hermetically.
 */
export const scheduleVideoQueueConsumer = (options: {
    intervalMs?: number;
    sweep?: () => Promise<{ requeued: string[]; loadFailed: boolean }>;
} = {}): VideoQueueConsumerHandle => {
    let timer: NodeJS.Timeout | null = null;
    const runSweep = options.sweep;
    const intervalMs = options.intervalMs ?? videoQueuePollSeconds() * 1000;

    const sweep = async (): Promise<{ requeued: string[]; loadFailed: boolean }> => {
        if (videoProcessingShuttingDown) return { requeued: [], loadFailed: false };
        return runSweep ? runSweep() : startVideoQueueReconciliation();
    };

    const tick = (): void => {
        void sweep().catch((error) => {
            console.error('[Videos] Queue consumer sweep failed:', error);
        });
    };

    return {
        sweep,
        start: (): void => {
            if (timer) return;
            tick();
            timer = setInterval(tick, intervalMs);
            timer.unref();
        },
        stop: (): void => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
};

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

    // Platform-wide capability is verified server-side (active super_admin or
    // a seeded permission key). A bare role claim never satisfies it.
    if (await hasVerifiedPlatformCapability(userId)) return true;

    // Uploader of this video keeps access to their own upload.
    if (video.uploaded_by && String(video.uploaded_by) === String(userId)) return true;

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
router.get('/course/:courseId', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { courseId } = req.params;

        // Course management data: ACTIVE course management inside the
        // caller's server-derived selected workspace, or the verified
        // platform capability. A stale assignment, a bare membership,
        // another workspace, or a course_id guess grants nothing.
        if (!(await canManageCourse(req.user!, courseId))) {
            return res.status(403).json({ error: 'No access to this course' });
        }

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

        // Deny-by-default: metadata (course linkage, status, DRM state) never
        // leaks to callers without an entitlement decided by the production
        // access policy with the server-derived scope.
        if (!(await canViewVideo(req.user!, videoId))) {
            return res.status(403).json({ error: 'No access to this video' });
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

        // Tenant context is required and verified inside the processor.
        await deleteVideoFiles(videoId, video.tenant_id ?? undefined);

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
            'SELECT * FROM videos WHERE id = ? AND tenant_id=? AND status = ? AND uploaded_by=?',
            [videoId, req.user!.tenantId, 'failed', req.user!.id]
        );

        if (!video) {
            return res.status(404).json({
                error: 'Video not found or not in failed state'
            });
        }

        // Re-arm the video and re-open its job row: the protected run
        // requires a committed job row and a 'processing' video, and it
        // re-verifies tenant ownership against both rows before anything
        // executes.
        await execute(
            `UPDATE videos SET status = 'processing',
             processing_progress = 0, processing_error = NULL
             WHERE id = ? AND tenant_id=? AND uploaded_by=?`,
            [videoId, req.user!.tenantId, req.user!.id]
        );
        await execute(
            `INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
             VALUES (?, ?, ?, 'pending', NOW())
             ON DUPLICATE KEY UPDATE status = 'pending', started_at = NULL, completed_at = NULL, error_message = NULL, worker_id = NULL`,
            [uuidv4(), videoId, req.user!.tenantId]
        );

        // Re-queue for processing through the protected path
        const outcome = startVideoProcessing(videoId, req.user!.tenantId!);

        res.json({ success: true, message: 'Processing restarted', jobOutcome: outcome });

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
            'SELECT * FROM videos WHERE id = ? AND tenant_id=? AND uploaded_by=?',
            [videoId, req.user!.tenantId, req.user!.id]
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
             WHERE id = ? AND tenant_id=?`,
            [videoId, req.user!.tenantId]
        );

        // Re-open the job row so the protected run has a committed job
        await execute(
            `INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
             VALUES (?, ?, ?, 'pending', NOW())
             ON DUPLICATE KEY UPDATE status = 'pending', started_at = NULL, completed_at = NULL, error_message = NULL, worker_id = NULL`,
            [uuidv4(), videoId, req.user!.tenantId]
        );

        // Re-queue for processing through the protected path
        const outcome = startVideoProcessing(videoId, req.user!.tenantId!);

        res.json({ success: true, message: 'Processing started', jobOutcome: outcome });

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
router.get('/:videoId/analytics', authenticateToken, async (req: AuthRequest, res: Response) => {
    try {
        const { videoId } = req.params;

        const video = await queryOne('SELECT id, course_id, uploaded_by FROM videos WHERE id = ?', [videoId]);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Analytics is management data: active course management or the
        // verified platform capability only — viewer access (student viewing
        // or an exact purchased lecture license) never grants it.
        if (!(await canViewVideoAnalytics(req.user!, video))) {
            return res.status(403).json({ error: 'No access to this video' });
        }

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
