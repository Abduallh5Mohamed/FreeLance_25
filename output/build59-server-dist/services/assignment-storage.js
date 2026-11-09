"use strict";
/**
 * Server-owned object-metadata adapter for private assignment submissions.
 *
 * This module is the only place that talks to the object store for the
 * assignment lifecycle. It deliberately does NOT own the MinIO client: the
 * production adapter lazily imports the existing configured client in
 * `services/minio.ts`, so importing this module (or the assignments router) in
 * tests never opens a connection and never reads credentials. Tests inject a
 * fake `AssignmentObjectStore` instead.
 *
 * Security properties enforced here (the route composes the policy):
 *  - the object key is parsed back into server facts and must match the
 *    tenant/assignment/enrollment/submission exactly;
 *  - object metadata is read from storage, never from the request;
 *  - only a bounded prefix (<= MAX_SIGNATURE_PREFIX_BYTES) is read, so a
 *    submission is never fully downloaded or buffered for validation;
 *  - upload authorization is a short-lived, private target bound to the exact
 *    key: a signed POST policy with a content-length range when the store
 *    supports one, otherwise a presigned PUT (whose body length a SigV4 PUT
 *    cannot bind, so the route reports that honestly). The caller never
 *    receives a bucket policy or a public object URL.
 *  - a stored object is only "ready" when the store reports a version (ETag +
 *    size); an adapter that cannot express one fails closed.
 *  - a quarantine cleanup destroys **exactly the version that was scanned**, and
 *    only when the adapter declares that it can enforce the precondition. A
 *    mutable-key delete is never substituted for it: the key can be rewritten
 *    between the last stat and the delete, and the delete would then destroy
 *    bytes no scanner ever saw.
 *
 * No network call is made at module load. No new provider or package is used.
 */
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMinioAssignmentObjectStore = exports.supportsExactVersionRemoval = exports.runBoundedScan = exports.ScanTimeoutError = exports.MAX_SCAN_TIMEOUT_MS = exports.MIN_SCAN_TIMEOUT_MS = exports.DEFAULT_SCAN_TIMEOUT_MS = exports.assignmentBucket = exports.MAX_UPLOAD_URL_TTL_SECONDS = exports.MIN_UPLOAD_URL_TTL_SECONDS = exports.DEFAULT_UPLOAD_URL_TTL_SECONDS = exports.MAX_SIGNATURE_PREFIX_BYTES = void 0;
exports.boundObjectVersion = boundObjectVersion;
exports.objectVersion = objectVersion;
exports.scanTimeoutMs = scanTimeoutMs;
exports.removeScannedObjectVersion = removeScannedObjectVersion;
exports.parseSubmissionStorageKey = parseSubmissionStorageKey;
exports.verifySubmissionStorageKey = verifySubmissionStorageKey;
exports.expectedContentType = expectedContentType;
exports.normalizeContentType = normalizeContentType;
exports.verifyObjectSignature = verifyObjectSignature;
exports.uploadAuthorizationTtlSeconds = uploadAuthorizationTtlSeconds;
/** Bounded prefix used for magic-byte validation (never a full download). */
exports.MAX_SIGNATURE_PREFIX_BYTES = 4096;
/** Default upload authorization lifetime; the route clamps to this window. */
exports.DEFAULT_UPLOAD_URL_TTL_SECONDS = 300;
exports.MIN_UPLOAD_URL_TTL_SECONDS = 60;
exports.MAX_UPLOAD_URL_TTL_SECONDS = 600;
/** Bucket that must be provisioned private before deployment. */
const assignmentBucket = () => process.env.MINIO_BUCKET_ASSIGNMENTS || 'assignment-submissions';
exports.assignmentBucket = assignmentBucket;
/**
 * Bind metadata to one immutable object version. Returns null when the adapter
 * cannot express a version (no ETag, no positive integer size), which the
 * caller must treat as "not verifiable" and fail closed — never as "verified".
 *
 * The ETag is OPAQUE and is preserved BYTE-FOR-BYTE. It is not trimmed, not
 * case-folded, and has no quotes stripped.
 *
 * Trimming collapsed two distinct identities into one: `"e"` and `"e "` differ
 * only by a trailing space, which is exactly what `utf8mb4_bin` PAD SPACE
 * collation treats as EQUAL and what the exact NO PAD storage contract treats as
 * DIFFERENT. A padded provider ETag therefore produced a bound version whose
 * string matched the unpadded one, and an exact-version delete precondition
 * built from it could match — and destroy — the wrong bytes. No provider
 * contract in this lane proves that a trimmed ETag denotes the same object, so
 * no canonicalization is applied here; the raw string is the identity.
 */
function boundObjectVersion(metadata) {
    if (!metadata)
        return null;
    // Raw, untrimmed. An empty string still fails closed; whitespace around a
    // real ETag is part of that ETag, not decoration to remove.
    const etag = typeof metadata.etag === 'string' ? metadata.etag : '';
    if (!etag)
        return null;
    // Safe integer, not merely integer: `Number.isInteger(2**53)` is true, and
    // an unsafe size is not a representable byte count — distinct real sizes
    // would collide on one double and the version string would be untrustworthy.
    if (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes <= 0)
        return null;
    return { version: `${etag}:${metadata.sizeBytes}`, etag, sizeBytes: metadata.sizeBytes };
}
/** The canonical version string, or null when the adapter cannot express one. */
function objectVersion(metadata) {
    return boundObjectVersion(metadata)?.version ?? null;
}
/* ------------------------------------------------------------------------- */
/* Bounded scanner execution                                                 */
/* ------------------------------------------------------------------------- */
/** Default wall-clock bound for one scan; the route clamps a configured value. */
exports.DEFAULT_SCAN_TIMEOUT_MS = 30000;
exports.MIN_SCAN_TIMEOUT_MS = 1000;
exports.MAX_SCAN_TIMEOUT_MS = 120000;
/** Clamp a configured scanner timeout into the bounded window. */
function scanTimeoutMs(configured) {
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
        return exports.DEFAULT_SCAN_TIMEOUT_MS;
    }
    return Math.min(exports.MAX_SCAN_TIMEOUT_MS, Math.max(exports.MIN_SCAN_TIMEOUT_MS, Math.trunc(configured)));
}
/**
 * A scanner that exceeded the wall-clock bound. Treated exactly like an
 * unavailable scanner: the caller answers fail-closed and the submission
 * stays retryable, never clean.
 */
class ScanTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Malware scan exceeded the ${timeoutMs} ms bound`);
        this.name = 'ScanTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}
exports.ScanTimeoutError = ScanTimeoutError;
/**
 * Run one scan under a hard wall-clock bound. The timer is always cleared, so
 * a fast verdict never leaves a pending timer behind; a hanging, looping or
 * resource-exhausting adapter fails closed with ScanTimeoutError instead of
 * holding the request open.
 */
const runBoundedScan = async (scanner, input, timeoutMs = exports.DEFAULT_SCAN_TIMEOUT_MS) => {
    let timer;
    try {
        return await Promise.race([
            scanner.scan(input),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new ScanTimeoutError(timeoutMs)), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
};
exports.runBoundedScan = runBoundedScan;
/**
 * Whether this adapter has *demonstrably* declared an exact-version delete.
 * Both the flag and the implementation are required: a flag without a method
 * proves nothing, and a method without the flag is not a claim the adapter
 * stands behind.
 */
const supportsExactVersionRemoval = (store) => store.capabilities?.conditionalDelete === true
    && typeof store.removeObjectVersion === 'function';
exports.supportsExactVersionRemoval = supportsExactVersionRemoval;
/**
 * Delete exactly the object version that was scanned, and never anything else.
 *
 * A mutable-key delete here would be a correctness bug, not a cleanup: between
 * the last stat and the delete the key can be rewritten by a concurrent upload,
 * and the delete would then destroy bytes no scanner ever looked at. When the
 * adapter cannot enforce an exact-version precondition this function does
 * **not** fall back to `removeObject` — it answers `unsupported`, and the caller
 * must keep the row non-readable and report the cleanup as pending.
 */
async function removeScannedObjectVersion(store, input, onError) {
    if (!(0, exports.supportsExactVersionRemoval)(store))
        return 'unsupported';
    try {
        return await store.removeObjectVersion(input);
    }
    catch (error) {
        if (onError) {
            try {
                onError(error);
            }
            catch {
                // An observability hook must never change the outcome.
            }
        }
        return 'failed';
    }
}
/* ------------------------------------------------------------------------- */
/* Object key binding                                                        */
/* ------------------------------------------------------------------------- */
const KEY_SEGMENT = '[A-Za-z0-9_-]{1,64}';
const KEY_PATTERN = new RegExp(`^tenants/(${KEY_SEGMENT})/assignments/(${KEY_SEGMENT})/(${KEY_SEGMENT})/(${KEY_SEGMENT})\\.([a-z0-9]{1,16})$`);
const MAX_STORAGE_KEY_LENGTH = 255;
/**
 * Parse the canonical submission key. Returns null for any other shape, so a
 * forged/foreign key can never be treated as a valid binding.
 */
function parseSubmissionStorageKey(key) {
    if (typeof key !== 'string' || key.length > MAX_STORAGE_KEY_LENGTH)
        return null;
    const match = KEY_PATTERN.exec(key);
    if (!match)
        return null;
    return {
        tenantId: match[1],
        assignmentId: match[2],
        enrollmentId: match[3],
        submissionId: match[4],
        fileExtension: match[5],
    };
}
/**
 * Verify that a persisted key is exactly the key the server would generate for
 * these facts. The extension comparison is case-insensitive; every identifier
 * segment must match verbatim.
 */
function verifySubmissionStorageKey(key, expected) {
    const parsed = parseSubmissionStorageKey(key);
    if (!parsed)
        return false;
    return parsed.tenantId === expected.tenantId
        && parsed.assignmentId === expected.assignmentId
        && parsed.enrollmentId === expected.enrollmentId
        && parsed.submissionId === expected.submissionId
        && parsed.fileExtension === expected.fileExtension.toLowerCase();
}
/* ------------------------------------------------------------------------- */
/* Content-type and magic-byte policy                                        */
/* ------------------------------------------------------------------------- */
const EXPECTED_CONTENT_TYPES = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain',
};
const ZIP_SIGNATURES = [
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];
const MAGIC_SIGNATURES = {
    pdf: [Buffer.from('%PDF-', 'ascii')],
    png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    jpg: [Buffer.from([0xff, 0xd8, 0xff])],
    jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
    zip: ZIP_SIGNATURES,
    docx: ZIP_SIGNATURES,
    doc: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
};
/** Expected MIME type for a supported extension, or null when unverifiable. */
function expectedContentType(extension) {
    return EXPECTED_CONTENT_TYPES[extension.toLowerCase()] ?? null;
}
/** Strip parameters and normalise case for a stored content-type. */
function normalizeContentType(value) {
    if (typeof value !== 'string')
        return null;
    const base = value.split(';')[0]?.trim().toLowerCase();
    return base ? base : null;
}
const startsWithAny = (prefix, signatures) => signatures.some((signature) => prefix.length >= signature.length
    && prefix.subarray(0, signature.length).equals(signature));
/**
 * A text file has no magic bytes. The bounded prefix must be NUL-free and
 * decodable UTF-8 (trailing bytes may be a truncated multi-byte sequence, so
 * up to three trailing bytes are trimmed before a strict decode).
 */
function verifyTextPrefix(prefix) {
    if (prefix.includes(0))
        return { ok: false, reason: 'signature_mismatch' };
    for (let trim = 0; trim <= 3 && trim < prefix.length; trim += 1) {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, prefix.length - trim));
            return { ok: true };
        }
        catch {
            // Try a shorter prefix: the range read may cut a multi-byte glyph.
        }
    }
    return { ok: false, reason: 'signature_mismatch' };
}
/**
 * Validate a bounded object prefix against the extension's signature. An
 * extension outside the verifiable set is rejected (fail closed): a custom
 * assignment type needs a dedicated verifier before it can be finalized.
 */
function verifyObjectSignature(extension, prefix) {
    const normalized = extension.toLowerCase();
    if (normalized === 'txt')
        return verifyTextPrefix(prefix);
    const signatures = MAGIC_SIGNATURES[normalized];
    if (!signatures)
        return { ok: false, reason: 'unsupported_type' };
    const minimum = Math.min(...signatures.map((signature) => signature.length));
    if (prefix.length < minimum)
        return { ok: false, reason: 'insufficient_bytes' };
    return startsWithAny(prefix, signatures)
        ? { ok: true }
        : { ok: false, reason: 'signature_mismatch' };
}
/** Clamp a configured authorization lifetime into the short-lived window. */
function uploadAuthorizationTtlSeconds(configured) {
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
        return exports.DEFAULT_UPLOAD_URL_TTL_SECONDS;
    }
    return Math.min(exports.MAX_UPLOAD_URL_TTL_SECONDS, Math.max(exports.MIN_UPLOAD_URL_TTL_SECONDS, Math.trunc(configured)));
}
/* ------------------------------------------------------------------------- */
/* Production adapter over the existing configured MinIO client              */
/* ------------------------------------------------------------------------- */
const isMissingObjectError = (error) => {
    if (typeof error !== 'object' || error === null)
        return false;
    const code = error.code;
    return code === 'NoSuchKey' || code === 'NotFound';
};
const metadataContentType = (metadata) => {
    if (!metadata)
        return null;
    for (const [name, value] of Object.entries(metadata)) {
        if (name.toLowerCase() === 'content-type') {
            return typeof value === 'string' ? value : String(value);
        }
    }
    return null;
};
/**
 * Build the production adapter. The MinIO module is imported lazily on first
 * use: constructing the router must not require credentials or a connection,
 * and hermetic tests never call these methods (they inject a fake store).
 */
const createMinioAssignmentObjectStore = (bucket = (0, exports.assignmentBucket)()) => {
    const loadMinio = async () => Promise.resolve().then(() => __importStar(require('./minio')));
    return {
        statObject: async (objectKey) => {
            const { minioClient } = await loadMinio();
            try {
                const stat = await minioClient.statObject(bucket, objectKey);
                return {
                    sizeBytes: stat.size,
                    contentType: metadataContentType(stat.metaData),
                    etag: stat.etag ?? null,
                    lastModified: stat.lastModified ?? null,
                };
            }
            catch (error) {
                if (isMissingObjectError(error))
                    return null;
                throw error;
            }
        },
        readPrefix: async (objectKey, maxBytes) => {
            const limit = Math.min(Math.max(1, Math.trunc(maxBytes)), exports.MAX_SIGNATURE_PREFIX_BYTES);
            const { minioClient } = await loadMinio();
            const stream = await minioClient.getPartialObject(bucket, objectKey, 0, limit);
            const chunks = [];
            let total = 0;
            for await (const chunk of stream) {
                if (total >= limit)
                    break;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                const remaining = limit - total;
                const slice = buffer.subarray(0, remaining);
                chunks.push(slice);
                total += slice.length;
                if (total >= limit) {
                    const destroyable = stream;
                    destroyable.destroy?.();
                    break;
                }
            }
            return Buffer.concat(chunks, total);
        },
        createUploadUrl: async ({ objectKey, expiresInSeconds }) => {
            const { minioClient } = await loadMinio();
            return minioClient.presignedPutObject(bucket, objectKey, expiresInSeconds);
        },
        /**
         * A signed POST policy with a content-length range. Unlike a presigned
         * PUT, the store itself refuses a body above `maxBytes`, so the
         * assignment maximum is enforced before the object is admitted rather
         * than only re-checked after the upload. The policy is still
         * short-lived and bound to the exact server-generated key and type.
         */
        createUploadAuthorization: async ({ objectKey, contentType, expiresInSeconds, maxBytes }) => {
            const { minioClient } = await loadMinio();
            const policy = minioClient.newPostPolicy();
            policy.setBucket(bucket);
            policy.setKey(objectKey);
            policy.setContentType(contentType);
            policy.setContentLengthRange(1, maxBytes);
            policy.setExpires(new Date(Date.now() + expiresInSeconds * 1000));
            const { postURL, formData } = await minioClient.presignedPostPolicy(policy);
            return {
                method: 'POST',
                url: postURL,
                fields: Object.fromEntries(Object.entries(formData).map(([name, value]) => [name, String(value)])),
                maxBytesEnforced: true,
            };
        },
        removeObject: async (objectKey) => {
            const { minioClient } = await loadMinio();
            await minioClient.removeObject(bucket, objectKey);
        },
        /**
         * Honest declaration: this adapter **cannot** delete a specific object
         * version. `removeObject` addresses the key, not a version, and the
         * MinIO/S3 DELETE verb has no ETag precondition; the optional
         * `versionId` form only addresses a bucket *version*, which this
         * adapter neither provisions nor can prove (the bucket is created
         * unversioned by `initializeBuckets`). Declaring `true` here would let a
         * quarantine cleanup destroy a concurrent replacement, so it stays
         * `false` and the worker falls back to a pending quarantine.
         */
        capabilities: { conditionalDelete: false },
    };
};
exports.createMinioAssignmentObjectStore = createMinioAssignmentObjectStore;
