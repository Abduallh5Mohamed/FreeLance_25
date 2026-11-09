"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.videoProcessingWorkerId = exports.closeProcessingLockPool = exports.getProcessingLockPool = exports.videoQueueLoadBackoffMs = exports.videoQueueLoadAttempts = exports.DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS = exports.DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS = exports.videoQueueBatchSize = exports.DEFAULT_VIDEO_QUEUE_BATCH_SIZE = exports.videoQueuePollSeconds = exports.DEFAULT_VIDEO_QUEUE_POLL_SECONDS = exports.videoProcessingConcurrency = exports.DEFAULT_PROCESSING_CONCURRENCY = exports.processingLeaseMinutes = exports.DEFAULT_PROCESSING_LEASE_MINUTES = exports.PROCESSING_LOCK_POOL_SIZE = exports.runUploadCompletion = exports.claimAndEnqueueOnConnection = exports.runUploadByteTransfer = exports.recheckUploadAuthority = exports.closeUploadLockPool = exports.getUploadLockPool = exports.UPLOAD_LOCK_POOL_SIZE = exports.createUploadLockManagerFromPool = exports.toUploadLockConnection = exports.createSqlUploadLockManager = exports.UPLOAD_LOCK_TIMEOUT_SECONDS = exports.uploadLockName = exports.buildUploadTransferContract = exports.buildUploadInitContract = exports.uploadContentPath = exports.createSqlUploadSessionReader = exports.evaluateUploadCompletion = exports.evaluateUploadContentRequest = exports.resolveUploadContentType = exports.isResourceBoundUploadKey = exports.normalizeUploadExtension = exports.uploadObjectKey = exports.maxUploadSizeBytes = exports.uploadSessionTtlMinutes = exports.DEFAULT_UPLOAD_SESSION_TTL_MINUTES = exports.UPLOAD_ALLOWED_CONTENT_TYPES = exports.UPLOAD_ALLOWED_EXTENSIONS = exports.UPLOAD_EXTENSION_CONTENT_TYPES = exports.UPLOAD_OBJECT_KEY_PREFIX = exports.evaluateCourseUploadPolicy = exports.VIDEO_UPLOAD_ROLE_KEYS = exports.canViewVideoAnalytics = exports.canViewVideo = exports.canManageCourse = void 0;
exports.updateVideoMetadataForUploader = exports.scheduleVideoQueueConsumer = exports.startVideoQueueReconciliation = exports.loadPendingJobsWithRetry = exports.createPendingVideoJobLoader = exports.reconcileVideoProcessingQueue = exports.inFlightVideoProcessingCount = exports.requestVideoProcessingShutdown = exports.isVideoProcessingShutdown = exports.createSqlVideoJobSettler = exports.createSqlVideoJobClaim = exports.createSqlVideoJobLoader = exports.runVideoProcessingJob = void 0;
const express_1 = require("express");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const promise_1 = __importDefault(require("mysql2/promise"));
const db_1 = require("../db");
const uuid_1 = require("uuid");
const minio_1 = require("../services/minio");
const video_processor_1 = require("../services/video-processor");
const auth_1 = require("../middleware/auth");
const admin_permissions_1 = require("../security/admin-permissions");
const resource_branch_1 = require("../security/resource-branch");
const video_access_policy_1 = require("../security/video-access-policy");
const vdocipher_1 = require("../services/vdocipher");
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
const hasVerifiedPlatformCapability = async (userId) => {
    if (await (0, admin_permissions_1.isSuperAdmin)(userId))
        return true;
    return (await (0, admin_permissions_1.getAdminPermissions)(userId)).includes(PLATFORM_SECURITY_PERMISSION);
};
/**
 * Production SQL repository for the pure access policy, built over the
 * pool-backed helpers this router already uses (the policy module itself
 * carries no eager service import). The same verified reads authorize
 * playback in secure-video.ts and metadata here.
 */
const videoAccessRepository = (0, video_access_policy_1.createSqlVideoAccessRepository)({
    queryOne: db_1.queryOne,
    hasPlatformCapability: (userId) => hasVerifiedPlatformCapability(userId),
});
const courseManagementReader = {
    loadCourse: (courseId) => videoAccessRepository.loadCourse(courseId),
    loadActiveTenantAuthority: (userId, tenantId) => videoAccessRepository.loadActiveTenantAuthority(userId, tenantId),
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
const canManageCourse = async (user, courseId, reader = courseManagementReader) => {
    if (await reader.hasPlatformCapability(user.id))
        return true;
    const course = await reader.loadCourse(courseId);
    if (!course || !course.tenant_id)
        return false;
    // The server-derived selected workspace (auth middleware) must BE the
    // course's tenant; another owned membership or a request value never
    // stands in for the selection.
    if (!user.tenantId || String(user.tenantId) !== String(course.tenant_id))
        return false;
    const authority = await reader.loadActiveTenantAuthority(user.id, course.tenant_id);
    if (!authority)
        return false;
    // Exact ownership: the assigned course instructor, or the verified
    // tenant owner (ownership — a mere teaching member without a
    // per-course grant stays denied).
    if (course.instructor_id && String(course.instructor_id) === String(user.id))
        return true;
    return authority.authority === 'owner';
};
exports.canManageCourse = canManageCourse;
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
const canViewVideo = async (user, videoId, repository = videoAccessRepository) => (0, video_access_policy_1.evaluateVideoAccess)(user.id, videoId, { tenantId: user.tenantId, studentEnrollmentId: user.studentEnrollmentId }, repository);
exports.canViewVideo = canViewVideo;
/**
 * Analytics visibility (deny-by-default): analytics is MANAGEMENT data —
 * the verified platform capability, or ACTIVE course management of the
 * video's course. Viewer access never grants it: student content viewing,
 * an EXACT purchased cross-tenant lecture license (which may see only the
 * exact video metadata), or a lecture relationship without course
 * management all stay denied.
 */
const canViewVideoAnalytics = async (user, video, reader = courseManagementReader) => {
    // Verified platform capability remains separate from course scope.
    if (await reader.hasPlatformCapability(user.id))
        return true;
    // Management is anchored on the video's course; a course-less video has
    // no management surface (fail closed).
    if (!video.course_id)
        return false;
    return (0, exports.canManageCourse)(user, video.course_id, reader);
};
exports.canViewVideoAnalytics = canViewVideoAnalytics;
/**
 * Resource-derived branch decision for a video. The branch comes from the
 * trusted lecture/material/course parent chain; a course-only video is
 * explicitly tenant-level. Ambiguous ownership and dangling parents deny.
 */
const enforceVideoBranch = async (req, res, videoId, requestedBranchId) => {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return false;
    }
    const decision = await (0, resource_branch_1.resolveResourceBranchAccess)((0, resource_branch_1.getResourceBranchDeps)(), (0, resource_branch_1.principalFromAuthUser)(req.user), { resourceType: 'video', resourceId: videoId, requestedBranchId });
    if (decision.kind !== 'allowed') {
        const denial = (0, resource_branch_1.resourceBranchDenial)(decision);
        res.status(denial.status).json(denial.body);
        return false;
    }
    return true;
};
/** Boolean form used to filter a list; never widens the existing policy. */
const videoBranchAllowed = async (user, videoId) => {
    const decision = await (0, resource_branch_1.resolveResourceBranchAccess)((0, resource_branch_1.getResourceBranchDeps)(), (0, resource_branch_1.principalFromAuthUser)(user), { resourceType: 'video', resourceId: videoId });
    return decision.kind === 'allowed';
};
;
/** Membership role keys that carry the verified video-upload capability. */
exports.VIDEO_UPLOAD_ROLE_KEYS = ['owner', 'instructor'];
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
const evaluateCourseUploadPolicy = async (user, courseId, reader) => {
    const course = await reader.loadCourse(courseId);
    if (!course)
        return 'course_not_found';
    if (!course.tenant_id)
        return 'forbidden';
    const membership = await reader.loadActiveTeachingMembership(user.id, course.tenant_id);
    if (!membership || !exports.VIDEO_UPLOAD_ROLE_KEYS.includes(membership.role_key)) {
        return 'forbidden';
    }
    if (course.instructor_id && String(course.instructor_id) === String(user.id))
        return 'allowed';
    const tenantOwner = await reader.loadTenantOwner(course.tenant_id, user.id);
    return tenantOwner ? 'allowed' : 'forbidden';
};
exports.evaluateCourseUploadPolicy = evaluateCourseUploadPolicy;
const courseUploadPolicyReader = {
    loadCourse: (courseId) => (0, db_1.queryOne)('SELECT id, tenant_id, instructor_id FROM courses WHERE id = ?', [courseId]),
    loadActiveTeachingMembership: (userId, tenantId) => (0, db_1.queryOne)(`SELECT m.role_key
         FROM tenant_memberships m
         INNER JOIN tenants t ON t.id = m.tenant_id
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
           AND t.status = 'active' AND u.is_active = 1
           AND m.role_key IN ('owner','instructor')`, [userId, tenantId]),
    loadTenantOwner: (tenantId, userId) => (0, db_1.queryOne)(`SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active'`, [tenantId, userId]),
};
// ============================================
// PRIVATE UPLOAD CONTRACT (server-mediated bytes)
// ============================================
/**
 * Original uploads live under this prefix. The exact object key is always
 * generated by the server and bound to the platform video id — the browser
 * never receives a storage URL, presigned or otherwise.
 */
exports.UPLOAD_OBJECT_KEY_PREFIX = 'originals/';
/** Upload extensions accepted by the platform, mapped to their content type. */
exports.UPLOAD_EXTENSION_CONTENT_TYPES = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
};
exports.UPLOAD_ALLOWED_EXTENSIONS = Object.keys(exports.UPLOAD_EXTENSION_CONTENT_TYPES);
exports.UPLOAD_ALLOWED_CONTENT_TYPES = Object.values(exports.UPLOAD_EXTENSION_CONTENT_TYPES);
/** An in-progress upload older than this lifetime is expired and denied. */
exports.DEFAULT_UPLOAD_SESSION_TTL_MINUTES = 60;
const uploadSessionTtlMinutes = () => {
    const parsed = parseInt(process.env.VIDEO_UPLOAD_TTL_MINUTES || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : exports.DEFAULT_UPLOAD_SESSION_TTL_MINUTES;
};
exports.uploadSessionTtlMinutes = uploadSessionTtlMinutes;
const maxUploadSizeBytes = () => Math.max(1, parseInt(process.env.VIDEO_MAX_SIZE_MB || '5000', 10)) * 1024 * 1024;
exports.maxUploadSizeBytes = maxUploadSizeBytes;
/** Server-side object key for an upload: `originals/<videoId><ext>`. */
const uploadObjectKey = (videoId, extension) => `${exports.UPLOAD_OBJECT_KEY_PREFIX}${videoId}${extension}`;
exports.uploadObjectKey = uploadObjectKey;
/**
 * Allowlisted extension for a client file name (deny-by-default: anything
 * outside the platform allowlist is rejected, never coerced).
 */
const normalizeUploadExtension = (fileName) => {
    if (typeof fileName !== 'string' || fileName.length === 0)
        return null;
    const ext = path_1.default.extname(fileName).toLowerCase();
    return exports.UPLOAD_ALLOWED_EXTENSIONS.includes(ext) ? ext : null;
};
exports.normalizeUploadExtension = normalizeUploadExtension;
/**
 * A stored object key is resource-bound only when it is exactly the server key
 * for this video id under the originals prefix — a forged key, a foreign
 * resource, or any extra path segment fails this check.
 */
const isResourceBoundUploadKey = (videoId, objectKey) => {
    if (typeof objectKey !== 'string')
        return false;
    if (!objectKey.startsWith(`${exports.UPLOAD_OBJECT_KEY_PREFIX}${videoId}.`))
        return false;
    const extension = objectKey.slice(`${exports.UPLOAD_OBJECT_KEY_PREFIX}${videoId}.`.length);
    return extension.length > 0 && !extension.includes('/');
};
exports.isResourceBoundUploadKey = isResourceBoundUploadKey;
/**
 * Resolves the content type of an in-flight upload: a declared type must be
 * allowlisted; when the browser declares none, the server falls back to the
 * allowlist mapping of the server-derived object extension.
 */
const resolveUploadContentType = (headerType, extension) => {
    const declared = (headerType ?? '').split(';')[0].trim().toLowerCase();
    if (declared) {
        return exports.UPLOAD_ALLOWED_CONTENT_TYPES.includes(declared) ? declared : null;
    }
    return exports.UPLOAD_EXTENSION_CONTENT_TYPES[extension.toLowerCase()] ?? null;
};
exports.resolveUploadContentType = resolveUploadContentType;
const asByteCount = (value) => {
    if (value === null)
        return null;
    const parsed = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(parsed) ? parsed : null;
};
/**
 * Decides whether byte transfer may start for an in-progress upload. Every
 * input is server state or a request header; the caller identity and tenant
 * binding are already enforced by the scoped session load.
 */
const evaluateUploadContentRequest = (video, input) => {
    if (!(0, exports.isResourceBoundUploadKey)(video.id, video.original_key))
        return { outcome: 'invalid_key' };
    if (input.now.getTime() - video.created_at.getTime() > input.ttlMinutes * 60000) {
        return { outcome: 'expired' };
    }
    const extension = path_1.default.extname(video.original_key).toLowerCase();
    const contentType = (0, exports.resolveUploadContentType)(input.contentTypeHeader, extension);
    if (!contentType)
        return { outcome: 'unsupported_type' };
    const declaredSize = asByteCount(video.file_size_bytes);
    if (declaredSize === null || declaredSize <= 0)
        return { outcome: 'invalid_size' };
    const ceiling = Math.min(declaredSize, input.maxSizeBytes);
    if (input.contentLengthHeader !== undefined) {
        const declaredLength = Number(input.contentLengthHeader);
        if (!Number.isFinite(declaredLength) || declaredLength <= 0)
            return { outcome: 'invalid_size' };
        if (declaredLength > ceiling)
            return { outcome: 'too_large' };
        return { outcome: 'allowed', objectKey: video.original_key, contentType, sizeBytes: declaredLength };
    }
    return { outcome: 'allowed', objectKey: video.original_key, contentType, sizeBytes: declaredSize };
};
exports.evaluateUploadContentRequest = evaluateUploadContentRequest;
/**
 * Finalization is verified against storage before any processing claim: the
 * stored object must exist under the exact server-derived key with exactly
 * the declared size. Wrong tenant, forged key and replay never reach this
 * point because the session load is already scoped to creator + tenant.
 */
const evaluateUploadCompletion = (video, stored) => {
    if (!(0, exports.isResourceBoundUploadKey)(video.id, video.original_key))
        return { outcome: 'invalid_key' };
    if (!stored)
        return { outcome: 'object_missing' };
    const storedSize = asByteCount(stored.size);
    const declaredSize = asByteCount(video.file_size_bytes);
    if (storedSize === null || declaredSize === null || storedSize <= 0 || storedSize !== declaredSize) {
        return { outcome: 'size_mismatch' };
    }
    return { outcome: 'allowed' };
};
exports.evaluateUploadCompletion = evaluateUploadCompletion;
const createSqlUploadSessionReader = (deps) => ({
    loadInProgressUpload: (videoId, userId, tenantId) => deps.queryOne(`SELECT id, course_id, tenant_id, uploaded_by, original_key, file_size_bytes,
                status, created_at, delivery_provider
         FROM videos
         WHERE id = ? AND tenant_id = ? AND uploaded_by = ? AND status = 'uploading'`, [videoId, tenantId, userId]),
});
exports.createSqlUploadSessionReader = createSqlUploadSessionReader;
const uploadSessionReader = (0, exports.createSqlUploadSessionReader)({ queryOne: db_1.queryOne });
const uploadStorageVerifier = {
    statOriginal: (objectKey) => (0, minio_1.getFileInfo)(minio_1.BUCKETS.ORIGINALS, objectKey),
};
/** API-relative path of the authenticated byte-transfer endpoint. */
const uploadContentPath = (videoId) => `/videos/upload/${videoId}/content`;
exports.uploadContentPath = uploadContentPath;
/**
 * The contract handed to the browser: bytes flow through the authenticated
 * API to a server-derived object key. It carries no storage URL of any kind.
 */
const buildUploadInitContract = (videoId, objectKey, ttlMinutes) => ({
    provider: 'minio',
    videoId,
    uploadUrl: (0, exports.uploadContentPath)(videoId),
    uploadMethod: 'PUT',
    authenticated: true,
    objectKey,
    expiresIn: ttlMinutes * 60,
});
exports.buildUploadInitContract = buildUploadInitContract;
const buildUploadTransferContract = (videoId, objectKey, sizeBytes) => ({ success: true, videoId, objectKey, sizeBytes });
exports.buildUploadTransferContract = buildUploadTransferContract;
// ============================================
// CROSS-PROCESS UPLOAD SERIALIZATION + ATOMIC FINALIZATION
// ============================================
/**
 * MySQL named-lock name for one exact tenant/video pair. Hashing keeps the
 * name inside MySQL's 64-character limit while staying deterministic across
 * processes: the DATABASE holds the lock, so no process-local map can
 * bypass the serialization.
 */
const uploadLockName = (tenantId, videoId) => `m1-upload-${(0, crypto_1.createHash)('sha256').update(`${tenantId}\n${videoId}`).digest('hex').slice(0, 32)}`;
exports.uploadLockName = uploadLockName;
/**
 * How long a second operation waits for the upload lock before it is denied.
 * A contended transfer/completion is a client-visible 409; the browser
 * complete retry re-attempts with backoff.
 */
exports.UPLOAD_LOCK_TIMEOUT_SECONDS = 10;
/**
 * Closes a lock connection outright. Used whenever a connection may still own
 * a named lock or is otherwise suspect: pooling it could hand a later
 * operation a session that already holds the lock. Adapters without destroy()
 * fall back to release(); a failure to close is swallowed because the session
 * (and its lock) is gone either way.
 */
const destroyUploadLockConnection = async (connection) => {
    try {
        if (connection.destroy) {
            await connection.destroy();
        }
        else {
            await connection.release();
        }
    }
    catch {
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
const createSqlUploadLockManager = (deps) => ({
    acquire: async (tenantId, videoId) => {
        const name = (0, exports.uploadLockName)(tenantId, videoId);
        const timeout = deps.timeoutSeconds ?? exports.UPLOAD_LOCK_TIMEOUT_SECONDS;
        const connection = await deps.acquireConnection();
        try {
            const rows = await connection.query('SELECT GET_LOCK(?, ?) AS acquired', [name, timeout]);
            if (Number(rows[0]?.acquired) !== 1) {
                // Denied: the connection is healthy and holds nothing.
                await connection.release();
                return null;
            }
            return {
                connection,
                release: async () => {
                    try {
                        await connection.query('SELECT RELEASE_LOCK(?)', [name]);
                        await connection.release();
                    }
                    catch (error) {
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
        }
        catch (error) {
            // The GET_LOCK round-trip itself failed: the connection is suspect
            // and may own the lock — never return it to a pool.
            await destroyUploadLockConnection(connection);
            throw error;
        }
    },
});
exports.createSqlUploadLockManager = createSqlUploadLockManager;
/** Maps a raw pooled connection onto the lock manager's connection contract. */
const toUploadLockConnection = (connection) => ({
    query: async (sql, params) => {
        const [rows] = await connection.query(sql, params);
        return rows;
    },
    execute: async (sql, params) => {
        const [result] = await connection.execute(sql, params);
        const affectedRows = result.affectedRows;
        if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
            throw new Error('video upload-lock execute did not report a usable affected-row count');
        }
        return { affectedRows };
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
exports.toUploadLockConnection = toUploadLockConnection;
/**
 * Builds a lock manager over ANY pool exposing getConnection(). Binding it
 * to a dedicated pool keeps held lock connections out of the shared request
 * pool entirely; the timeout is per critical section (a contended upload
 * waits, a contended processing run gives up immediately).
 */
const createUploadLockManagerFromPool = (pool, options = {}) => (0, exports.createSqlUploadLockManager)({
    acquireConnection: async () => (0, exports.toUploadLockConnection)(await pool.getConnection()),
    timeoutSeconds: options.timeoutSeconds,
});
exports.createUploadLockManagerFromPool = createUploadLockManagerFromPool;
/**
 * Size of the dedicated upload-lock pool. The shared request pool is capped
 * at 10 connections: if lock holders drew from it, every holder waiting on
 * its in-lock reads (session reload, authority recheck) would compete with
 * all other requests for the same slots and could stall the whole API. The
 * lock pool is separate and small — a contended extra acquisition queues on
 * this pool, never on request traffic.
 */
exports.UPLOAD_LOCK_POOL_SIZE = 4;
let uploadLockPool = null;
/** The dedicated pool every production lock connection is drawn from. */
const getUploadLockPool = () => {
    if (!uploadLockPool) {
        uploadLockPool = promise_1.default.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
            database: process.env.DB_NAME || 'Freelance',
            port: parseInt(process.env.DB_PORT || '3306', 10),
            waitForConnections: true,
            queueLimit: 0,
            connectionLimit: exports.UPLOAD_LOCK_POOL_SIZE,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            charset: 'utf8mb4',
            timezone: '+02:00',
        });
        console.log(`[Videos] Upload lock pool created (${exports.UPLOAD_LOCK_POOL_SIZE} connections, separate from the request pool)`);
    }
    return uploadLockPool;
};
exports.getUploadLockPool = getUploadLockPool;
/** Closes the dedicated lock pool (graceful shutdown / tests). */
const closeUploadLockPool = async () => {
    if (uploadLockPool) {
        const pool = uploadLockPool;
        uploadLockPool = null;
        await pool.end();
    }
};
exports.closeUploadLockPool = closeUploadLockPool;
/** Production lock manager over the DEDICATED lock pool (never the request pool). */
const sqlUploadLockManager = (0, exports.createUploadLockManagerFromPool)({
    getConnection: () => (0, exports.getUploadLockPool)().getConnection(),
});
/**
 * Live re-authorization of an in-flight upload, run INSIDE the serialization
 * lock immediately before bytes are written and again inside the completion
 * critical section: the session must still be within its TTL, the selected
 * workspace must still be the course's tenant, and the caller must still
 * hold CURRENT course upload authority. A permission revoked after init,
 * or an expired session, denies before anything is written or claimed.
 */
const recheckUploadAuthority = async (video, user, now, reader) => {
    if (now.getTime() - video.created_at.getTime() > (0, exports.uploadSessionTtlMinutes)() * 60000) {
        return 'expired';
    }
    const course = await reader.loadCourse(video.course_id);
    if (!course || !course.tenant_id)
        return 'forbidden';
    // The selected workspace must be the course's tenant; the session row is
    // already tenant-scoped to the principal, so this catches course/tenant drift.
    if (video.tenant_id && String(video.tenant_id) !== String(course.tenant_id))
        return 'forbidden';
    const policy = await (0, exports.evaluateCourseUploadPolicy)({ id: user.id }, video.course_id, reader);
    return policy === 'allowed' ? 'allowed' : 'forbidden';
};
exports.recheckUploadAuthority = recheckUploadAuthority;
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
const runUploadByteTransfer = async (videoId, user, stream, headers, now, deps) => {
    const video = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
    if (!video)
        return { outcome: 'not_found' };
    const decision = (0, exports.evaluateUploadContentRequest)(video, {
        contentTypeHeader: headers.contentType,
        contentLengthHeader: headers.contentLength,
        now,
        maxSizeBytes: (0, exports.maxUploadSizeBytes)(),
        ttlMinutes: (0, exports.uploadSessionTtlMinutes)(),
    });
    if (decision.outcome !== 'allowed')
        return { outcome: decision.outcome };
    const lock = await deps.acquireUploadLock(video.tenant_id ?? user.tenantId ?? '', videoId);
    if (!lock)
        return { outcome: 'busy' };
    try {
        // Fresh session inside the critical section: a finalization that
        // committed while this transfer waited for the lock must deny the
        // late bytes instead of overwriting finalized content.
        const current = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
        if (!current)
            return { outcome: 'not_found' };
        const authority = await deps.recheckAuthority(current, user, now);
        if (authority === 'expired')
            return { outcome: 'expired' };
        if (authority === 'forbidden')
            return { outcome: 'forbidden' };
        try {
            await deps.transferBytes(decision.objectKey, stream, decision.sizeBytes, decision.contentType);
        }
        catch (error) {
            console.error('[Videos] Byte transfer failed inside the upload lock:', error);
            return { outcome: 'storage_failed' };
        }
        return { outcome: 'stored', videoId, objectKey: decision.objectKey, sizeBytes: decision.sizeBytes };
    }
    finally {
        await lock.release();
    }
};
exports.runUploadByteTransfer = runUploadByteTransfer;
/**
 * Claims the session and enqueues its processing job as ONE transaction on
 * the dedicated lock connection. If the enqueue fails, the rollback restores
 * 'uploading' and the upload stays retryable — the video is never left
 * 'processing' with no queued job.
 */
const claimAndEnqueueOnConnection = (connection) => async (video, user) => {
    const tenantId = user.tenantId ?? video.tenant_id ?? '';
    await connection.beginTransaction();
    try {
        const claim = await connection.execute(`UPDATE videos SET status = 'processing'
             WHERE id = ? AND tenant_id = ? AND uploaded_by = ? AND status = 'uploading'`, [video.id, tenantId, video.uploaded_by]);
        if (claim.affectedRows !== 1) {
            await connection.rollback();
            return 'already_finalized';
        }
        await connection.execute(`INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
             VALUES (?, ?, ?, 'pending', NOW())
             ON DUPLICATE KEY UPDATE status = 'pending', created_at = NOW()`, [(0, uuid_1.v4)(), video.id, tenantId]);
        await connection.commit();
        return 'claimed';
    }
    catch (error) {
        try {
            await connection.rollback();
        }
        catch (rollbackError) {
            console.error('[Videos] Rollback after a failed claim+enqueue failed:', rollbackError);
        }
        throw error;
    }
};
exports.claimAndEnqueueOnConnection = claimAndEnqueueOnConnection;
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
const runUploadCompletion = async (videoId, user, now, deps) => {
    if (typeof videoId !== 'string' || videoId.length === 0)
        return { outcome: 'invalid_request' };
    const video = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
    if (!video)
        return { outcome: 'not_found' };
    if (video.delivery_provider === 'vdocipher')
        return { outcome: 'legacy_managed' };
    const lock = await deps.acquireUploadLock(video.tenant_id ?? user.tenantId ?? '', videoId);
    if (!lock)
        return { outcome: 'busy' };
    try {
        const current = await deps.loadInProgressUpload(videoId, user.id, user.tenantId ?? '');
        if (!current)
            return { outcome: 'not_found' };
        const authority = await deps.recheckAuthority(current, user, now);
        if (authority === 'expired')
            return { outcome: 'expired' };
        if (authority === 'forbidden')
            return { outcome: 'forbidden' };
        const stored = await deps.statOriginal(current.original_key ?? '');
        const completion = (0, exports.evaluateUploadCompletion)(current, stored);
        if (completion.outcome !== 'allowed')
            return { outcome: completion.outcome };
        try {
            const claim = await deps.claimAndEnqueue(lock.connection)(current, user);
            if (claim === 'already_finalized')
                return { outcome: 'not_found' };
        }
        catch (error) {
            // The transaction rolled back: the session is still 'uploading'
            // with its bytes intact, so the client can retry completion.
            console.error('[Videos] Upload claim + enqueue transaction failed:', error);
            return { outcome: 'enqueue_failed' };
        }
    }
    finally {
        await lock.release();
    }
    // Background processing starts only after the claim+enqueue commit.
    deps.startProcessing(videoId, user.tenantId ?? video.tenant_id ?? '');
    return { outcome: 'completed', videoId };
};
exports.runUploadCompletion = runUploadCompletion;
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
exports.PROCESSING_LOCK_POOL_SIZE = 3;
/**
 * How long a queue row may sit in 'processing' before recovery treats the
 * previous claimant as dead. The run's named lock is the authoritative
 * liveness check (a dead holder's session releases it immediately); this
 * horizon only stops the sweep from probing locks for rows claimed a
 * moment ago — including the crash window between claim and lock.
 */
exports.DEFAULT_PROCESSING_LEASE_MINUTES = 60;
const processingLeaseMinutes = () => {
    const parsed = parseInt(process.env.VIDEO_PROCESSING_LEASE_MINUTES || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : exports.DEFAULT_PROCESSING_LEASE_MINUTES;
};
exports.processingLeaseMinutes = processingLeaseMinutes;
/** Bounded in-process concurrency for processing runs. */
exports.DEFAULT_PROCESSING_CONCURRENCY = 2;
const videoProcessingConcurrency = () => {
    const parsed = parseInt(process.env.VIDEO_PROCESSING_CONCURRENCY || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : exports.DEFAULT_PROCESSING_CONCURRENCY;
};
exports.videoProcessingConcurrency = videoProcessingConcurrency;
/** Queue consumer cadence: committed rows are eventually consumed even if a startup sweep failed. */
exports.DEFAULT_VIDEO_QUEUE_POLL_SECONDS = 60;
const videoQueuePollSeconds = () => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_POLL_SECONDS || '', 10);
    return Number.isFinite(parsed) && parsed >= 5 ? parsed : exports.DEFAULT_VIDEO_QUEUE_POLL_SECONDS;
};
exports.videoQueuePollSeconds = videoQueuePollSeconds;
/** Upper bound on queue rows handled per sweep — never launch everything at once. */
exports.DEFAULT_VIDEO_QUEUE_BATCH_SIZE = 10;
const videoQueueBatchSize = () => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_BATCH_SIZE || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : exports.DEFAULT_VIDEO_QUEUE_BATCH_SIZE;
};
exports.videoQueueBatchSize = videoQueueBatchSize;
/** Retry policy for a transient queue READ failure (backoff = base * 2^(attempt-1)). */
exports.DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS = 3;
exports.DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS = 1000;
const videoQueueLoadAttempts = () => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_LOAD_ATTEMPTS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : exports.DEFAULT_VIDEO_QUEUE_LOAD_ATTEMPTS;
};
exports.videoQueueLoadAttempts = videoQueueLoadAttempts;
const videoQueueLoadBackoffMs = () => {
    const parsed = parseInt(process.env.VIDEO_QUEUE_LOAD_BACKOFF_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : exports.DEFAULT_VIDEO_QUEUE_LOAD_BACKOFF_MS;
};
exports.videoQueueLoadBackoffMs = videoQueueLoadBackoffMs;
let processingLockPool = null;
/** The dedicated pool every processing-lock connection is drawn from. */
const getProcessingLockPool = () => {
    if (!processingLockPool) {
        processingLockPool = promise_1.default.createPool({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
            database: process.env.DB_NAME || 'Freelance',
            port: parseInt(process.env.DB_PORT || '3306', 10),
            waitForConnections: true,
            queueLimit: 0,
            connectionLimit: exports.PROCESSING_LOCK_POOL_SIZE,
            enableKeepAlive: true,
            keepAliveInitialDelay: 0,
            charset: 'utf8mb4',
            timezone: '+02:00',
        });
        console.log(`[Videos] Processing lock pool created (${exports.PROCESSING_LOCK_POOL_SIZE} connections, separate from the request and upload-lock pools)`);
    }
    return processingLockPool;
};
exports.getProcessingLockPool = getProcessingLockPool;
/** Closes the dedicated processing-lock pool (graceful shutdown / tests). */
const closeProcessingLockPool = async () => {
    if (processingLockPool) {
        const pool = processingLockPool;
        processingLockPool = null;
        await pool.end();
    }
};
exports.closeProcessingLockPool = closeProcessingLockPool;
/**
 * Production processing lock manager over the DEDICATED processing-lock
 * pool. Timeout 0: a contended run means another process is already
 * executing THIS video — denying is the safe answer, never a queue.
 */
const sqlProcessingLockManager = (0, exports.createUploadLockManagerFromPool)({ getConnection: () => (0, exports.getProcessingLockPool)().getConnection() }, { timeoutSeconds: 0 });
/** Stable-ish identifier of the executing worker, recorded on the queue row. */
const videoProcessingWorkerId = () => `wb-${process.pid}-${(0, crypto_1.createHash)('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 8)}`;
exports.videoProcessingWorkerId = videoProcessingWorkerId;
const settleVideoJob = async (deps, videoId, outcome) => {
    try {
        await deps.settleJob(videoId, outcome);
    }
    catch (error) {
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
const runVideoProcessingJob = async (videoId, tenantId, deps) => {
    if (!tenantId)
        return 'no_job';
    const job = await deps.loadJob(videoId, tenantId);
    if (!job)
        return 'no_job';
    if (job.queueStatus === 'completed' || job.queueStatus === 'failed')
        return 'already_settled';
    if (job.videoStatus === 'ready') {
        // The run finished but its settle was lost: settle without re-running.
        await settleVideoJob(deps, videoId, { settled: 'completed' });
        return 'already_settled';
    }
    if (job.videoStatus === 'failed') {
        await settleVideoJob(deps, videoId, { settled: 'failed', error: 'video row is failed; job settled from the video state' });
        return 'already_settled';
    }
    if (job.videoStatus !== 'processing')
        return 'video_not_processing';
    // Cross-process exclusion: a live run in another process holds this.
    const lock = await deps.acquireProcessingLock(job.tenantId, videoId);
    if (!lock)
        return 'locked';
    try {
        // We hold the lock, so no live claimant exists for this video: a
        // 'processing' row here is either a fresh legitimate claim or a
        // claimant that died between its claim and its lock. Re-stamping is
        // the takeover; pending rows are the normal case.
        const claimed = await deps.claimJob(videoId, deps.workerId);
        if (!claimed)
            return 'no_job';
        try {
            await deps.runProcessing(videoId, job.tenantId);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await settleVideoJob(deps, videoId, { settled: 'failed', error: message });
            return 'processing_failed';
        }
        await settleVideoJob(deps, videoId, { settled: 'completed' });
        return 'processed';
    }
    finally {
        await lock.release();
    }
};
exports.runVideoProcessingJob = runVideoProcessingJob;
/** Production job loader: exact tenant matching, both rows non-null. */
const createSqlVideoJobLoader = (deps) => async (videoId, tenantId) => {
    if (!tenantId)
        return null;
    const row = await deps.queryOne(`SELECT q.status AS queue_status, v.status AS video_status
         FROM video_processing_queue q
         INNER JOIN videos v ON v.id = q.video_id
         WHERE q.video_id = ?
           AND q.tenant_id IS NOT NULL
           AND v.tenant_id IS NOT NULL
           AND q.tenant_id = v.tenant_id
           AND q.tenant_id = ?`, [videoId, tenantId]);
    if (!row)
        return null;
    return { videoId, tenantId, queueStatus: row.queue_status, videoStatus: row.video_status };
};
exports.createSqlVideoJobLoader = createSqlVideoJobLoader;
/** Production claim: takes the row for this worker, normalizing staleness. */
const createSqlVideoJobClaim = (deps) => async (videoId, workerId) => {
    const result = await deps.execute(`UPDATE video_processing_queue
         SET status = 'processing', started_at = NOW(), worker_id = ?
         WHERE video_id = ? AND status IN ('pending', 'processing')`, [workerId, videoId]);
    return result.affectedRows === 1;
};
exports.createSqlVideoJobClaim = createSqlVideoJobClaim;
/** Production settler: terminal states only, never clobbering a settled row. */
const createSqlVideoJobSettler = (deps) => async (videoId, outcome) => {
    if (outcome.settled === 'completed') {
        await deps.execute(`UPDATE video_processing_queue
             SET status = 'completed', completed_at = NOW(), error_message = NULL, worker_id = NULL
             WHERE video_id = ? AND status <> 'completed'`, [videoId]);
        return;
    }
    await deps.execute(`UPDATE video_processing_queue
         SET status = 'failed', completed_at = NOW(), error_message = ?, worker_id = NULL
         WHERE video_id = ? AND status <> 'failed'`, [outcome.error.slice(0, 1000), videoId]);
};
exports.createSqlVideoJobSettler = createSqlVideoJobSettler;
const videoJobRunDeps = {
    loadJob: (0, exports.createSqlVideoJobLoader)({ queryOne: db_1.queryOne }),
    acquireProcessingLock: sqlProcessingLockManager.acquire,
    claimJob: (0, exports.createSqlVideoJobClaim)({ execute: db_1.execute }),
    settleJob: (0, exports.createSqlVideoJobSettler)({ execute: db_1.execute }),
    runProcessing: (videoId, tenantId) => (0, video_processor_1.processVideo)(videoId, tenantId),
    workerId: (0, exports.videoProcessingWorkerId)(),
};
/**
 * In-flight + concurrency guard for THIS process. Cross-process exclusion
 * is the named lock inside runVideoProcessingJob; this guard keeps a single
 * process from stacking duplicate runs and bounds how many transcodes run
 * at once. Jobs that arrive while saturated are simply left in the queue:
 * the periodic consumer picks them up.
 */
const inFlightVideoProcessing = new Set();
let activeVideoProcessing = 0;
let videoProcessingShuttingDown = false;
const isVideoProcessingShutdown = () => videoProcessingShuttingDown;
exports.isVideoProcessingShutdown = isVideoProcessingShutdown;
/** Blocks new processing runs; in-flight runs continue until they settle. */
const requestVideoProcessingShutdown = () => {
    videoProcessingShuttingDown = true;
};
exports.requestVideoProcessingShutdown = requestVideoProcessingShutdown;
const inFlightVideoProcessingCount = () => inFlightVideoProcessing.size;
exports.inFlightVideoProcessingCount = inFlightVideoProcessingCount;
const startVideoProcessing = (videoId, tenantId) => {
    if (videoProcessingShuttingDown)
        return 'shutting_down';
    if (inFlightVideoProcessing.has(videoId))
        return 'already_running';
    if (activeVideoProcessing >= (0, exports.videoProcessingConcurrency)())
        return 'saturated';
    activeVideoProcessing++;
    inFlightVideoProcessing.add(videoId);
    void (0, exports.runVideoProcessingJob)(videoId, tenantId, videoJobRunDeps)
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
const uploadTransferDeps = {
    loadInProgressUpload: uploadSessionReader.loadInProgressUpload,
    acquireUploadLock: sqlUploadLockManager.acquire,
    transferBytes: (objectKey, stream, sizeBytes, contentType) => (0, minio_1.putObjectStream)(minio_1.BUCKETS.ORIGINALS, objectKey, stream, sizeBytes, contentType),
    recheckAuthority: (video, user, now) => (0, exports.recheckUploadAuthority)(video, user, now, courseUploadPolicyReader),
};
/** Production wiring for the finalization endpoint. */
const uploadCompletionDeps = {
    loadInProgressUpload: uploadSessionReader.loadInProgressUpload,
    acquireUploadLock: sqlUploadLockManager.acquire,
    statOriginal: uploadStorageVerifier.statOriginal,
    recheckAuthority: (video, user, now) => (0, exports.recheckUploadAuthority)(video, user, now, courseUploadPolicyReader),
    claimAndEnqueue: exports.claimAndEnqueueOnConnection,
    startProcessing: startVideoProcessing,
};
const router = (0, express_1.Router)();
// ============================================
// ENCRYPTION KEY ENDPOINT (Protected)
// ============================================
/**
 * Log security violation attempts
 * Called by frontend when suspicious activity is detected
 * Version 4.0 - Enhanced security logging with force logout support
 */
router.post('/security/log', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId, activityType, details } = req.body;
        const userId = req.user.id;
        if (!userId || !videoId || !activityType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const logId = (0, uuid_1.v4)();
        const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';
        // Enhanced logging with platform info
        const enhancedDetails = `${details || 'No details provided'} | IP: ${ipAddress}`;
        await (0, db_1.execute)(`INSERT INTO video_security_logs
            (id, user_id, video_id, activity_type, ip_address, user_agent, details, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`, [logId, userId, videoId, activityType, ipAddress, userAgent, enhancedDetails]);
        // Log severity based on activity type
        const severeViolations = ['screenshot', 'screenrecord', 'devtools', 'alttab', 'focus_loss'];
        const severity = severeViolations.includes(activityType) ? '🚨 SEVERE' : '⚠️ Warning';
        console.log(`[Security] ${severity} - ${activityType} for user ${userId} on video ${videoId}`);
        console.log(`[Security] Details: ${enhancedDetails}`);
        console.log(`[Security] User-Agent: ${userAgent}`);
        // Count violations for this user
        const violationCount = await (0, db_1.queryOne)(`SELECT COUNT(*) as count FROM video_security_logs
             WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)`, [userId]);
        res.json({
            success: true,
            logId,
            violationCount: violationCount?.count || 0,
            message: 'Violation logged'
        });
    }
    catch (error) {
        console.error('[Security] Logging error:', error);
        res.status(500).json({ error: 'Failed to log security event' });
    }
});
/**
 * Parse a request query parameter as a positive, in-range integer. Invalid,
 * non-integer, zero, negative, or out-of-range values fall back to `fallback`
 * instead of reaching a SQL `LIMIT` / `INTERVAL` binding as `NaN` or an
 * unbounded number.
 */
function parsePositiveIntParam(value, fallback, max) {
    const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    if (!Number.isInteger(n) || n < 1 || n > max)
        return fallback;
    return n;
}
/**
 * Get security violations for a user (Admin endpoint)
 */
router.get('/security/violations/:userId', auth_1.authenticateToken, (0, admin_permissions_1.requireAdminPermission)(PLATFORM_SECURITY_PERMISSION), async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50 } = req.query;
        const violations = await (0, db_1.query)(`SELECT * FROM video_security_logs
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ?`, [userId, parsePositiveIntParam(limit, 50, 1000)]);
        const stats = await (0, db_1.queryOne)(`SELECT
                COUNT(*) as total_violations,
                COUNT(DISTINCT video_id) as videos_affected,
                MAX(created_at) as last_violation
             FROM video_security_logs WHERE user_id = ?`, [userId]);
        res.json({ violations, stats });
    }
    catch (error) {
        console.error('[Security] Get violations error:', error);
        res.status(500).json({ error: 'Failed to get violations' });
    }
});
/**
 * Get all security violations (Admin dashboard)
 */
router.get('/security/all-violations', auth_1.authenticateToken, (0, admin_permissions_1.requireAdminPermission)(PLATFORM_SECURITY_PERMISSION), async (req, res) => {
    try {
        const { limit = 100, hours = 24 } = req.query;
        const violations = await (0, db_1.query)(`SELECT vsl.*, u.name as user_name, u.phone as user_phone
             FROM video_security_logs vsl
             LEFT JOIN users u ON vsl.user_id = u.id
             WHERE vsl.created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
             ORDER BY vsl.created_at DESC
             LIMIT ?`, [parsePositiveIntParam(hours, 24, 8760), parsePositiveIntParam(limit, 100, 1000)]);
        const summary = await (0, db_1.queryOne)(`SELECT
                COUNT(*) as total,
                COUNT(DISTINCT user_id) as unique_users,
                SUM(CASE WHEN activity_type IN ('screenshot', 'screenrecord') THEN 1 ELSE 0 END) as severe_count
             FROM video_security_logs
             WHERE created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)`, [parsePositiveIntParam(hours, 24, 8760)]);
        res.json({ violations, summary });
    }
    catch (error) {
        console.error('[Security] Get all violations error:', error);
        res.status(500).json({ error: 'Failed to get violations' });
    }
});
/**
 * Serve encryption key for HLS playback
 * This endpoint is called by the video player when playing encrypted HLS
 * Security: Only authenticated users with access can get the key
 */
router.get('/key/:videoId', auth_1.authenticateToken, async (req, res) => {
    return res.status(410).json({ error: 'A live video session is required. Use /api/secure-video/key.' });
    /* legacy implementation intentionally unreachable */
    try {
        const { videoId } = req.params;
        const userId = req.user.id;
        // Get video with encryption key
        const video = await (0, db_1.queryOne)('SELECT id, encryption_key, is_encrypted FROM videos WHERE id = ?', [videoId]);
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
    }
    catch (error) {
        console.error('[Videos] Key serving error:', error);
        res.status(500).json({ error: 'Failed to serve encryption key' });
    }
});
// ============================================
// UPLOAD ENDPOINTS (Teacher)
// ============================================
router.get('/drm/status', auth_1.authenticateToken, (_req, res) => {
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
router.post('/upload/init', auth_1.authenticateToken, async (req, res) => {
    try {
        const { course_id, lecture_id, material_id, title, description, file_name, file_size, content_type } = req.body;
        const uploaded_by = req.user.id;
        const tenantId = req.user.tenantId;
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
        const uploadPolicy = await (0, exports.evaluateCourseUploadPolicy)(req.user, course_id, courseUploadPolicyReader);
        if (uploadPolicy === 'course_not_found') {
            return res.status(404).json({ error: 'Course not found' });
        }
        if (uploadPolicy === 'forbidden') {
            return res.status(403).json({ error: 'Video upload is not permitted for this course' });
        }
        // Constrain size and type server-side before allocating anything:
        // the declared size must be a positive byte count within the platform
        // limit, and the file extension must be allowlisted.
        const maxSizeBytes = (0, exports.maxUploadSizeBytes)();
        const declaredSize = asByteCount(typeof file_size === 'string' ? Number(file_size) : file_size);
        if (declaredSize === null || declaredSize <= 0 || declaredSize > maxSizeBytes) {
            return res.status(400).json({
                error: `File size must be a positive number up to ${Math.floor(maxSizeBytes / (1024 * 1024))}MB`
            });
        }
        const extension = (0, exports.normalizeUploadExtension)(file_name);
        if (!extension) {
            return res.status(400).json({
                error: `Unsupported file extension. Allowed: ${exports.UPLOAD_ALLOWED_EXTENSIONS.join(', ')}`
            });
        }
        if (content_type !== undefined && content_type !== null) {
            const declaredType = String(content_type).split(';')[0].trim().toLowerCase();
            if (!exports.UPLOAD_ALLOWED_CONTENT_TYPES.includes(declaredType)) {
                return res.status(400).json({ error: 'Unsupported content type' });
            }
        }
        // Keep the platform UUID separate from the provider asset id so the
        // existing ownership and entitlement model remains unchanged.
        const videoId = (0, uuid_1.v4)();
        // The exact object key is generated here, on the server, bound to the
        // video id; the client never proposes or receives a storage path.
        const objectKey = (0, exports.uploadObjectKey)(videoId, extension);
        // The ownership mirror (`videos.lecture_id` / `videos.material_id`) is a
        // real write-time link, so the referenced parent must be proven from
        // server rows to belong to the SAME workspace as the video being
        // created (the video is written with the caller's server-selected
        // tenant). A foreign or unprovable reference is refused before the row
        // exists; the body value is never trusted as proof.
        if (lecture_id) {
            const targetLecture = await (0, db_1.queryOne)(`SELECT c.tenant_id AS tenant_id
                 FROM lectures l
                 INNER JOIN courses c ON c.id = l.course_id
                 WHERE l.id = ?`, [lecture_id]);
            if (!targetLecture) {
                return res.status(404).json({ error: 'Lecture not found' });
            }
            if (targetLecture.tenant_id == null || String(targetLecture.tenant_id) !== String(tenantId)) {
                return res.status(403).json({ error: 'Lecture is outside this workspace' });
            }
        }
        if (material_id) {
            const targetMaterial = await (0, db_1.queryOne)(`SELECT c.tenant_id AS tenant_id
                 FROM course_materials cm
                 INNER JOIN courses c ON c.id = cm.course_id
                 WHERE cm.id = ?`, [material_id]);
            if (!targetMaterial) {
                return res.status(404).json({ error: 'Material not found' });
            }
            if (targetMaterial.tenant_id == null || String(targetMaterial.tenant_id) !== String(tenantId)) {
                return res.status(403).json({ error: 'Material is outside this workspace' });
            }
        }
        // Create video record in database
        await (0, db_1.execute)(`INSERT INTO videos
            (id, course_id, tenant_id, lecture_id, material_id, title, description,
             file_size_bytes, original_key, uploaded_by, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`, [
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
        ]);
        const ttlMinutes = (0, exports.uploadSessionTtlMinutes)();
        console.log(`[Videos] Initialized private upload for video ${videoId}`);
        res.json((0, exports.buildUploadInitContract)(videoId, objectKey, ttlMinutes));
    }
    catch (error) {
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
router.put('/upload/:videoId/content', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        const outcome = await (0, exports.runUploadByteTransfer)(videoId, { id: req.user.id, tenantId: req.user.tenantId }, req, {
            contentType: req.headers['content-type'],
            contentLength: req.headers['content-length'],
        }, new Date(), uploadTransferDeps);
        switch (outcome.outcome) {
            case 'stored':
                console.log(`[Videos] Received ${outcome.sizeBytes} bytes for video ${videoId}`);
                return res.status(201).json((0, exports.buildUploadTransferContract)(outcome.videoId, outcome.objectKey, outcome.sizeBytes));
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
    }
    catch (error) {
        console.error('[Videos] Byte transfer error:', error);
        res.status(502).json({ error: 'Failed to store uploaded video' });
    }
});
/**
 * Complete upload and start processing
 * Called by frontend after the byte transfer succeeded
 */
router.post('/upload/complete', auth_1.authenticateToken, async (req, res) => {
    try {
        const outcome = await (0, exports.runUploadCompletion)(req.body?.videoId, { id: req.user.id, tenantId: req.user.tenantId }, new Date(), uploadCompletionDeps);
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
    }
    catch (error) {
        console.error('[Videos] Upload complete error:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
});
/**
 * Get upload progress/status
 */
router.get('/upload/status/:videoId', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        const video = await (0, db_1.queryOne)(`SELECT id, title, status, processing_progress, processing_error,
                    qualities_available, created_at, processed_at, delivery_provider,
                    drm_asset_id, drm_preview_asset_id, drm_status, drm_last_synced_at,
                    preview_status, duration_seconds
             FROM videos WHERE id = ? AND tenant_id = ? AND uploaded_by = ?`, [videoId, req.user.tenantId, req.user.id]);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        res.json(video);
    }
    catch (error) {
        console.error('[Videos] Status check error:', error);
        res.status(500).json({ error: 'Failed to get status' });
    }
});
/**
 * Cancel upload and delete associated files
 */
router.delete('/upload/cancel/:videoId', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        // Get video info
        const video = await (0, db_1.queryOne)('SELECT * FROM videos WHERE id = ? AND uploaded_by = ?', [videoId, req.user.id]);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        try {
            // Tenant context is required and verified inside the processor.
            await (0, video_processor_1.deleteVideoFiles)(videoId, video.tenant_id ?? undefined);
            console.log(`[Videos] Deleted files for cancelled upload ${videoId}`);
        }
        catch (error) {
            console.error(`[Videos] Error deleting files for ${videoId}:`, error);
        }
        // Delete from processing queue
        await (0, db_1.execute)('DELETE FROM video_processing_queue WHERE video_id = ?', [videoId]);
        // Delete video record
        await (0, db_1.execute)('DELETE FROM videos WHERE id = ?', [videoId]);
        console.log(`[Videos] Cancelled and deleted upload ${videoId}`);
        res.json({
            success: true,
            message: 'Upload cancelled and files deleted'
        });
    }
    catch (error) {
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
router.post('/upload/recover-stuck', auth_1.authenticateToken, (0, admin_permissions_1.requireAdminPermission)(PLATFORM_SECURITY_PERMISSION), async (req, res) => {
    try {
        const stuckVideos = await (0, db_1.query)(`SELECT id, tenant_id, status FROM videos
             WHERE tenant_id IS NOT NULL AND status IN ('processing', 'failed') AND delivery_provider = 'minio'
               AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
             LIMIT ?`, [(0, exports.videoQueueBatchSize)()]);
        const liveUploads = await (0, db_1.queryOne)(`SELECT COUNT(*) AS total FROM videos
             WHERE tenant_id IS NOT NULL AND status = 'uploading' AND delivery_provider = 'minio'`, []);
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
                await (0, db_1.execute)(`UPDATE videos SET status = 'processing', processing_progress = 0, processing_error = NULL
                     WHERE id = ? AND tenant_id = ?`, [video.id, video.tenant_id]);
                await (0, db_1.execute)(`INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
                     VALUES (?, ?, ?, 'pending', NOW())
                     ON DUPLICATE KEY UPDATE status = 'pending', started_at = NULL, completed_at = NULL, error_message = NULL, worker_id = NULL`, [(0, uuid_1.v4)(), video.id, video.tenant_id]);
                const outcome = startVideoProcessing(video.id, video.tenant_id);
                if (outcome !== 'shutting_down')
                    recovered++;
                console.log(`[Videos] Recovered stuck video ${video.id} (${outcome})`);
            }
            catch (err) {
                console.error(`[Videos] Error recovering ${video.id}:`, err);
            }
        }
        res.json({
            recovered,
            total: stuckVideos.length,
            liveUploadsLeftAlone: liveUploads?.total ?? 0,
        });
    }
    catch (error) {
        console.error('[Videos] Recover stuck error:', error);
        res.status(500).json({ error: 'Failed to recover stuck videos' });
    }
});
/**
 * Feeds every stranded queue row to the processor. This is the consumer that
 * makes video_processing_queue durable across restarts: the claim+enqueue
 * transaction commits the row, and this reconciliation (run at startup, and
 * on a cadence) picks it up when the original in-process run is gone. A
 * single failure never aborts the sweep, and a load failure is contained so
 * reconciliation can never crash startup. The sweep is bounded: it stops at
 * the batch size (loader LIMIT) and at in-process concurrency saturation.
 */
const reconcileVideoProcessingQueue = async (deps) => {
    const requeued = [];
    let pending;
    try {
        pending = await deps.loadPendingJobs();
    }
    catch (error) {
        console.error('[Videos] Pending processing job load failed:', error);
        return { requeued };
    }
    for (const job of pending) {
        if (deps.isProcessing(job.videoId))
            continue; // an in-flight run owns it
        try {
            const outcome = deps.startProcessing(job.videoId, job.tenantId);
            if (outcome === 'saturated' || outcome === 'shutting_down')
                break;
            if (outcome === 'already_running')
                continue;
            requeued.push(job.videoId);
        }
        catch (error) {
            console.error(`[Videos] Failed to requeue processing for ${job.videoId}:`, error);
        }
    }
    return { requeued };
};
exports.reconcileVideoProcessingQueue = reconcileVideoProcessingQueue;
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
const createPendingVideoJobLoader = (run, options = {}) => async () => {
    const leaseMinutes = options.leaseMinutes ?? (0, exports.processingLeaseMinutes)();
    const batchSize = options.batchSize ?? (0, exports.videoQueueBatchSize)();
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
        throw new RangeError('Video queue batch size must be a positive safe integer');
    }
    const rows = await run(`SELECT q.video_id, q.tenant_id
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
    // mysql2 binds JavaScript numbers as DOUBLE; MySQL 8 rejects that
    // parameter type in LIMIT. A validated decimal string stays bound
    // and is accepted as the integer LIMIT value by the server.
    [leaseMinutes, String(batchSize)]);
    return rows.map((row) => ({ videoId: row.video_id, tenantId: row.tenant_id ?? '' }));
};
exports.createPendingVideoJobLoader = createPendingVideoJobLoader;
/**
 * Retries a transient queue READ with exponential backoff; the read must
 * not be silently lost — the committed rows stay owed to a run. Injectable
 * load/sleep keep it exercisable without a database.
 */
const loadPendingJobsWithRetry = async (load, options = {}) => {
    const attempts = options.attempts ?? (0, exports.videoQueueLoadAttempts)();
    const backoffMs = options.backoffMs ?? (0, exports.videoQueueLoadBackoffMs)();
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await load();
        }
        catch (error) {
            lastError = error;
            if (attempt < attempts) {
                await sleep(backoffMs * 2 ** (attempt - 1));
            }
        }
    }
    throw lastError;
};
exports.loadPendingJobsWithRetry = loadPendingJobsWithRetry;
/**
 * One full recovery sweep: a retrying read followed by the contained
 * reconciliation. `loadFailed` distinguishes "queue drained" from "queue
 * unreadable" — the periodic consumer keeps retrying either way.
 */
const startVideoQueueReconciliation = async () => {
    let jobs;
    try {
        jobs = await (0, exports.loadPendingJobsWithRetry)(() => (0, exports.createPendingVideoJobLoader)(db_1.query)());
    }
    catch (error) {
        console.error('[Videos] Pending processing job load failed after retries:', error);
        return { requeued: [], loadFailed: true };
    }
    const result = await (0, exports.reconcileVideoProcessingQueue)({
        loadPendingJobs: async () => jobs,
        isProcessing: (videoId) => inFlightVideoProcessing.has(videoId),
        startProcessing: startVideoProcessing,
    });
    return { ...result, loadFailed: false };
};
exports.startVideoQueueReconciliation = startVideoQueueReconciliation;
/**
 * The single periodic consumer: after a restart, and then on a cadence,
 * every committed queue row that still owes a run is fed through the same
 * protected execution path as the upload-completion path. The timer is
 * unref'd (it never holds the process open) and stops cleanly on shutdown.
 * The sweep is injectable so the cadence itself is testable hermetically.
 */
const scheduleVideoQueueConsumer = (options = {}) => {
    let timer = null;
    const runSweep = options.sweep;
    const intervalMs = options.intervalMs ?? (0, exports.videoQueuePollSeconds)() * 1000;
    const sweep = async () => {
        if (videoProcessingShuttingDown)
            return { requeued: [], loadFailed: false };
        return runSweep ? runSweep() : (0, exports.startVideoQueueReconciliation)();
    };
    const tick = () => {
        void sweep().catch((error) => {
            console.error('[Videos] Queue consumer sweep failed:', error);
        });
    };
    return {
        sweep,
        start: () => {
            if (timer)
                return;
            tick();
            timer = setInterval(tick, intervalMs);
            timer.unref();
        },
        stop: () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
};
exports.scheduleVideoQueueConsumer = scheduleVideoQueueConsumer;
// ============================================
// STREAMING ENDPOINTS (Student)
// ============================================
/**
 * Get secure streaming URL for a video
 * Verifies student has access before providing URL
 */
router.get('/stream/:videoId', auth_1.authenticateToken, async (req, res) => {
    return res.status(410).json({ error: 'Direct stream URLs are disabled. Create a secure video session.' });
    /* legacy implementation intentionally unreachable */
    try {
        const { videoId } = req.params;
        const userId = req.user.id;
        // Get video info
        const video = await (0, db_1.queryOne)(`SELECT v.*, c.name as course_name
             FROM videos v
             LEFT JOIN courses c ON v.course_id = c.id
             WHERE v.id = ? AND v.status = 'ready'`, [videoId]);
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
            if (!(0, vdocipher_1.isManagedDrmEnabled)() || !video.drm_asset_id) {
                return res.status(503).json({ error: 'DRM playback is temporarily unavailable', code: 'DRM_NOT_CONFIGURED' });
            }
            const viewer = await (0, db_1.queryOne)('SELECT id,name,phone,email FROM users WHERE id=?', [userId]);
            const playback = await (0, vdocipher_1.createManagedPlayback)(video.drm_asset_id, {
                id: userId,
                name: viewer?.name || 'Platform viewer',
                phone: viewer?.phone,
                email: viewer?.email,
            });
            await (0, db_1.execute)(`INSERT INTO video_access_logs (video_id, user_id, ip_address, user_agent)
                 VALUES (?, ?, ?, ?)`, [videoId, userId, req.ip || 'unknown', req.get('User-Agent') || 'unknown']);
            res.set('Cache-Control', 'no-store, private');
            return res.json({
                provider: 'vdocipher',
                videoId,
                title: video.title,
                duration: video.duration_seconds,
                playerUrl: (0, vdocipher_1.managedPlayerUrl)(playback),
                expiresIn: 300,
            });
        }
        // Generate signed streaming URL
        // Check if HLS is available, otherwise use original
        let streamUrl;
        if (video.hls_key && video.hls_key !== video.original_key) {
            // Use HLS if processed
            streamUrl = await (0, minio_1.getSignedStreamUrl)(videoId, 'playlist.m3u8');
        }
        else {
            // Use original file directly
            streamUrl = await (0, minio_1.getSignedStreamUrl)(videoId, video.original_key, minio_1.BUCKETS.ORIGINALS);
        }
        const thumbnailUrl = await (0, minio_1.getThumbnailUrl)(videoId);
        // Log access
        await (0, db_1.execute)(`INSERT INTO video_access_logs (video_id, user_id, ip_address, user_agent)
             VALUES (?, ?, ?, ?)`, [
            videoId,
            userId,
            req.ip || 'unknown',
            req.get('User-Agent') || 'unknown'
        ]);
        // Parse qualities safely
        let qualities = [];
        if (video.qualities_available) {
            try {
                qualities = JSON.parse(video.qualities_available);
            }
            catch (e) {
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
    }
    catch (error) {
        console.error('[Videos] Stream error:', error);
        res.status(500).json({ error: 'Failed to get stream URL' });
    }
});
/**
 * Check if user has access to a video
 */
async function checkVideoAccess(userId, video) {
    // Get user info
    const user = await (0, db_1.queryOne)('SELECT id, role, phone FROM users WHERE id = ?', [userId]);
    if (!user)
        return false;
    // Platform-wide capability is verified server-side (active super_admin or
    // a seeded permission key). A bare role claim never satisfies it.
    if (await hasVerifiedPlatformCapability(userId))
        return true;
    // Uploader of this video keeps access to their own upload.
    if (video.uploaded_by && String(video.uploaded_by) === String(userId))
        return true;
    // Instructors: can play videos they own (uploaded to their lecture)
    // or videos that were explicitly shared with them (approved video requests)
    if (user.role === 'instructor') {
        const lecture = await (0, db_1.queryOne)(`SELECT id, instructor_id FROM lectures
             WHERE video_url = CONCAT('video://', ?)
             LIMIT 1`, [video.id]);
        if (!lecture)
            return false;
        // Owner of the lecture containing this video
        if (String(lecture.instructor_id) === String(userId)) {
            return true;
        }
        // Approved share via instructor video requests
        const shared = await (0, db_1.queryOne)(`SELECT id FROM instructor_shared_lectures
             WHERE instructor_id = ? AND lecture_id = ?`, [userId, lecture.id]);
        return !!shared;
    }
    // For students, check if they belong to the same course
    const student = await (0, db_1.queryOne)('SELECT id, group_id, grade_id, instructor_id FROM students WHERE phone = ? AND is_active = TRUE', [user.phone]);
    if (!student)
        return false;
    const permitted = await (0, db_1.queryOne)(`SELECT l.id FROM lectures l
         WHERE l.video_url=CONCAT('video://',?) AND (
           (l.is_published=1 AND (l.instructor_id IS NULL OR l.instructor_id=?)
             AND (l.grade_id=? OR l.group_id=?))
           OR EXISTS (
             SELECT 1 FROM instructor_shared_lectures sl
             JOIN instructor_shared_lecture_publications pub ON pub.shared_lecture_id=sl.id
             WHERE sl.lecture_id=l.id AND sl.instructor_id=? AND sl.is_published=1 AND pub.group_id=?
           )
         ) LIMIT 1`, [video.id, student.instructor_id, student.grade_id, student.group_id, student.instructor_id, student.group_id]);
    return !!permitted;
}
/**
 * Refresh streaming URL (for long videos)
 */
router.post('/stream/:videoId/refresh', auth_1.authenticateToken, async (req, res) => {
    return res.status(410).json({ error: 'Direct stream URLs are disabled. Refresh the secure video session.' });
    /* legacy implementation intentionally unreachable */
    try {
        const { videoId } = req.params;
        const userId = req.user.id;
        // Get video info
        const video = await (0, db_1.queryOne)('SELECT * FROM videos WHERE id = ? AND status = ?', [videoId, 'ready']);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        // Verify access
        const hasAccess = await checkVideoAccess(userId, video);
        if (!hasAccess) {
            return res.status(403).json({ error: 'No access to this video' });
        }
        // Generate new signed URL
        const streamUrl = await (0, minio_1.getSignedStreamUrl)(videoId, 'playlist.m3u8');
        res.json({
            streamUrl,
            expiresIn: parseInt(process.env.SIGNED_URL_EXPIRY || '600')
        });
    }
    catch (error) {
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
router.get('/course/:courseId', auth_1.authenticateToken, async (req, res) => {
    try {
        const { courseId } = req.params;
        // Course management data: ACTIVE course management inside the
        // caller's server-derived selected workspace, or the verified
        // platform capability. A stale assignment, a bare membership,
        // another workspace, or a course_id guess grants nothing.
        if (!(await (0, exports.canManageCourse)(req.user, courseId))) {
            return res.status(403).json({ error: 'No access to this course' });
        }
        const courseVideos = await (0, db_1.query)(`SELECT id, title, description, duration_seconds, status,
                    processing_progress, qualities_available,
                    created_at, processed_at
             FROM videos
             WHERE course_id = ?
             ORDER BY created_at DESC`, [courseId]);
        // Course management is tenant-level, but an individual video may be
        // branch-owned. Filter each row through the same central decision so
        // this list never becomes a branch-side channel.
        const videos = [];
        for (const video of courseVideos) {
            if (await videoBranchAllowed(req.user, video.id))
                videos.push(video);
        }
        // Add thumbnail URLs
        for (const video of videos) {
            if (video.status === 'ready') {
                video.thumbnailUrl = await (0, minio_1.getThumbnailUrl)(video.id);
            }
        }
        res.json(videos);
    }
    catch (error) {
        console.error('[Videos] Get course videos error:', error);
        res.status(500).json({ error: 'Failed to get videos' });
    }
});
/**
 * Get single video details
 */
router.get('/:videoId', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        const video = await (0, db_1.queryOne)(`SELECT v.id,v.course_id,v.lecture_id,v.material_id,v.title,v.description,v.duration_seconds,
                    v.status,v.processing_progress,v.qualities_available,v.preview_status,v.created_at,v.processed_at,
                    c.name as course_name
             FROM videos v
             LEFT JOIN courses c ON v.course_id = c.id
             WHERE v.id = ?`, [videoId]);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        // Deny-by-default: metadata (course linkage, status, DRM state) never
        // leaks to callers without an entitlement decided by the production
        // access policy with the server-derived scope.
        if (!(await (0, exports.canViewVideo)(req.user, videoId))) {
            return res.status(403).json({ error: 'No access to this video' });
        }
        if (!(await enforceVideoBranch(req, res, videoId, req.query?.branch_id)))
            return;
        if (video.status === 'ready') {
            video.thumbnailUrl = await (0, minio_1.getThumbnailUrl)(videoId);
        }
        res.json(video);
    }
    catch (error) {
        console.error('[Videos] Get video error:', error);
        res.status(500).json({ error: 'Failed to get video' });
    }
});
/**
 * Delete a video
 */
router.delete('/:videoId', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        // Get video to check it exists
        const video = await (0, db_1.queryOne)('SELECT * FROM videos WHERE id = ? AND uploaded_by=?', [videoId, req.user.id]);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        if (!(await enforceVideoBranch(req, res, videoId, req.body?.branch_id)))
            return;
        const referenced = await (0, db_1.queryOne)(`SELECT 1 referenced FROM lectures l
          WHERE l.video_url=CONCAT('video://',?) AND (
            EXISTS (SELECT 1 FROM instructor_shared_lectures sl WHERE sl.lecture_id=l.id)
            OR EXISTS (SELECT 1 FROM instructor_video_offers o WHERE o.lecture_id=l.id)
          ) LIMIT 1`, [videoId]);
        if (referenced) {
            await (0, db_1.execute)("UPDATE lectures SET archived_at=UTC_TIMESTAMP(),is_published=0 WHERE video_url=CONCAT('video://',?) AND instructor_id=?", [videoId, req.user.id]);
            return res.json({ success: true, archived: true, message: 'Video archived; purchased access remains active' });
        }
        // Tenant context is required and verified inside the processor.
        await (0, video_processor_1.deleteVideoFiles)(videoId, video.tenant_id ?? undefined);
        // Delete from database (cascades to related tables)
        await (0, db_1.execute)('DELETE FROM videos WHERE id = ?', [videoId]);
        console.log(`[Videos] Deleted video ${videoId}`);
        res.json({ success: true, message: 'Video deleted' });
    }
    catch (error) {
        console.error('[Videos] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete video' });
    }
});
const updateVideoMetadataForUploader = async (videoId, user, title, description, deps = { execute: db_1.execute, queryOne: db_1.queryOne }) => {
    if (!user.tenantId)
        return null;
    await deps.execute('UPDATE videos SET title = ?, description = ? WHERE id = ? AND tenant_id = ? AND uploaded_by = ?', [title, description || null, videoId, user.tenantId, user.id]);
    const video = await deps.queryOne(`SELECT id, course_id, lecture_id, material_id, title, description, duration_seconds,
                status, processing_progress, qualities_available, preview_status, created_at, processed_at
         FROM videos
         WHERE id = ? AND tenant_id = ? AND uploaded_by = ?`, [videoId, user.tenantId, user.id]);
    if (!video)
        return null;
    return {
        id: video.id,
        course_id: video.course_id,
        lecture_id: video.lecture_id,
        material_id: video.material_id,
        title: video.title,
        description: video.description,
        duration_seconds: video.duration_seconds,
        status: video.status,
        processing_progress: video.processing_progress,
        qualities_available: video.qualities_available,
        preview_status: video.preview_status,
        created_at: video.created_at,
        processed_at: video.processed_at,
    };
};
exports.updateVideoMetadataForUploader = updateVideoMetadataForUploader;
/**
 * Update video metadata
 */
router.put('/:videoId', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        const { title, description } = req.body;
        if (!(await enforceVideoBranch(req, res, videoId, req.body?.branch_id)))
            return;
        const video = await (0, exports.updateVideoMetadataForUploader)(videoId, req.user, title, description);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        res.json(video);
    }
    catch (error) {
        console.error('[Videos] Update error:', error);
        res.status(500).json({ error: 'Failed to update video' });
    }
});
/**
 * Retry failed processing
 */
router.post('/:videoId/retry', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        const video = await (0, db_1.queryOne)('SELECT * FROM videos WHERE id = ? AND tenant_id=? AND status = ? AND uploaded_by=?', [videoId, req.user.tenantId, 'failed', req.user.id]);
        if (!video) {
            return res.status(404).json({
                error: 'Video not found or not in failed state'
            });
        }
        if (!(await enforceVideoBranch(req, res, videoId, req.body?.branch_id)))
            return;
        // Re-arm the video and re-open its job row: the protected run
        // requires a committed job row and a 'processing' video, and it
        // re-verifies tenant ownership against both rows before anything
        // executes.
        await (0, db_1.execute)(`UPDATE videos SET status = 'processing',
             processing_progress = 0, processing_error = NULL
             WHERE id = ? AND tenant_id=? AND uploaded_by=?`, [videoId, req.user.tenantId, req.user.id]);
        await (0, db_1.execute)(`INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
             VALUES (?, ?, ?, 'pending', NOW())
             ON DUPLICATE KEY UPDATE status = 'pending', started_at = NULL, completed_at = NULL, error_message = NULL, worker_id = NULL`, [(0, uuid_1.v4)(), videoId, req.user.tenantId]);
        // Re-queue for processing through the protected path
        const outcome = startVideoProcessing(videoId, req.user.tenantId);
        res.json({ success: true, message: 'Processing restarted', jobOutcome: outcome });
    }
    catch (error) {
        console.error('[Videos] Retry error:', error);
        res.status(500).json({ error: 'Failed to retry processing' });
    }
});
/**
 * Re-process a video (force)
 */
router.post('/:videoId/reprocess', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        const video = await (0, db_1.queryOne)('SELECT * FROM videos WHERE id = ? AND tenant_id=? AND uploaded_by=?', [videoId, req.user.tenantId, req.user.id]);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        if (!(await enforceVideoBranch(req, res, videoId, req.body?.branch_id)))
            return;
        if (video.delivery_provider === 'vdocipher') {
            return res.status(409).json({ error: 'Managed DRM videos are re-encoded by the provider and cannot be locally reprocessed' });
        }
        console.log(`[Videos] Force reprocessing video ${videoId}`);
        // Reset status
        await (0, db_1.execute)(`UPDATE videos SET status = 'processing',
             processing_progress = 0, processing_error = NULL
             WHERE id = ? AND tenant_id=?`, [videoId, req.user.tenantId]);
        // Re-open the job row so the protected run has a committed job
        await (0, db_1.execute)(`INSERT INTO video_processing_queue (id, video_id, tenant_id, status, created_at)
             VALUES (?, ?, ?, 'pending', NOW())
             ON DUPLICATE KEY UPDATE status = 'pending', started_at = NULL, completed_at = NULL, error_message = NULL, worker_id = NULL`, [(0, uuid_1.v4)(), videoId, req.user.tenantId]);
        // Re-queue for processing through the protected path
        const outcome = startVideoProcessing(videoId, req.user.tenantId);
        res.json({ success: true, message: 'Processing started', jobOutcome: outcome });
    }
    catch (error) {
        console.error('[Videos] Reprocess error:', error);
        res.status(500).json({ error: 'Failed to reprocess video' });
    }
});
/**
 * Placeholder thumbnail endpoint
 */
router.get('/placeholder-thumbnail', (req, res) => {
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
router.get('/:videoId/analytics', auth_1.authenticateToken, async (req, res) => {
    try {
        const { videoId } = req.params;
        const video = await (0, db_1.queryOne)('SELECT id, course_id, uploaded_by FROM videos WHERE id = ?', [videoId]);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        // Analytics is management data: active course management or the
        // verified platform capability only — viewer access (student viewing
        // or an exact purchased lecture license) never grants it.
        if (!(await (0, exports.canViewVideoAnalytics)(req.user, video))) {
            return res.status(403).json({ error: 'No access to this video' });
        }
        if (!(await enforceVideoBranch(req, res, videoId, req.query?.branch_id)))
            return;
        const stats = await (0, db_1.queryOne)(`SELECT
                COUNT(*) as total_views,
                COUNT(DISTINCT user_id) as unique_viewers,
                AVG(watch_duration_seconds) as avg_watch_time
             FROM video_access_logs
             WHERE video_id = ?`, [videoId]);
        const recentViews = await (0, db_1.query)(`SELECT DATE(accessed_at) as date, COUNT(*) as views
             FROM video_access_logs
             WHERE video_id = ?
             AND accessed_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY DATE(accessed_at)
             ORDER BY date DESC`, [videoId]);
        res.json({
            ...stats,
            recentViews
        });
    }
    catch (error) {
        console.error('[Videos] Analytics error:', error);
        res.status(500).json({ error: 'Failed to get analytics' });
    }
});
exports.default = router;
