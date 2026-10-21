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

/** Bounded prefix used for magic-byte validation (never a full download). */
export const MAX_SIGNATURE_PREFIX_BYTES = 4096;

/** Default upload authorization lifetime; the route clamps to this window. */
export const DEFAULT_UPLOAD_URL_TTL_SECONDS = 300;
export const MIN_UPLOAD_URL_TTL_SECONDS = 60;
export const MAX_UPLOAD_URL_TTL_SECONDS = 600;

/** Bucket that must be provisioned private before deployment. */
export const assignmentBucket = (): string =>
    process.env.MINIO_BUCKET_ASSIGNMENTS || 'assignment-submissions';

export interface AssignmentObjectMetadata {
    sizeBytes: number;
    /** Stored `Content-Type` metadata, if the store reports one. */
    contentType: string | null;
    etag: string | null;
    lastModified: Date | null;
}

/**
 * The exact identity of one stored object version, as facts rather than as a
 * formatted string: an exact-version delete needs the ETag and the size
 * separately, and a caller must never have to parse a composite key back apart.
 */
export interface BoundObjectVersion {
    /** `etag:size` — the canonical identity of the version. */
    version: string;
    etag: string;
    sizeBytes: number;
}

/**
 * Bind metadata to one immutable object version. Returns null when the adapter
 * cannot express a version (no ETag, no positive integer size), which the
 * caller must treat as "not verifiable" and fail closed — never as "verified".
 */
export function boundObjectVersion(metadata: AssignmentObjectMetadata | null): BoundObjectVersion | null {
    if (!metadata) return null;
    const etag = typeof metadata.etag === 'string' ? metadata.etag.trim() : '';
    if (!etag) return null;
    if (!Number.isInteger(metadata.sizeBytes) || metadata.sizeBytes <= 0) return null;
    return { version: `${etag}:${metadata.sizeBytes}`, etag, sizeBytes: metadata.sizeBytes };
}

/** The canonical version string, or null when the adapter cannot express one. */
export function objectVersion(metadata: AssignmentObjectMetadata | null): string | null {
    return boundObjectVersion(metadata)?.version ?? null;
}

export interface UploadUrlInput {
    objectKey: string;
    contentType: string;
    expiresInSeconds: number;
}

/**
 * A signed upload target whose admission size the store enforces itself.
 * `maxBytesEnforced` is true only when the store signed a content-length
 * range into the authorization; the route must never claim enforcement for a
 * target that cannot express one.
 */
export interface SignedUploadAuthorization {
    method: 'PUT' | 'POST';
    url: string;
    /** Multipart form fields for a signed POST policy (absent for a PUT). */
    fields?: Record<string, string>;
    maxBytesEnforced: boolean;
}

export interface SignedUploadInput extends UploadUrlInput {
    /** Hard upper bound the authorization must refuse above, when supported. */
    maxBytes: number;
}


/* ------------------------------------------------------------------------- */
/* Malware scanner contract                                                  */
/* ------------------------------------------------------------------------- */

export interface MalwareScanInput {
    objectKey: string;
    sizeBytes: number;
    contentType: string | null;
    extension: string;
    /**
     * ETag of the exact object version the server stat'ed before scanning.
     * A scanner must bind its read (and its verdict) to this version: a
     * verdict for any other object version is meaningless, because the
     * caller re-verifies the ETag after scanning (see the finalize flow).
     */
    etag: string | null;
}

/**
 * A verified scanner adapter. The route treats an absent scanner as
 * `pending_scan` (fail closed) and never derives a verdict from the file
 * extension. `failed` means the scanner could not produce a verdict; the
 * submission stays retryable rather than being recorded as clean.
 */
export type MalwareScanVerdict =
    | { verdict: 'clean' }
    | { verdict: 'infected'; signature?: string }
    | { verdict: 'failed'; reason: string };

export interface MalwareScanner {
    scan(input: MalwareScanInput): Promise<MalwareScanVerdict>;
}

/* ------------------------------------------------------------------------- */
/* Bounded scanner execution                                                 */
/* ------------------------------------------------------------------------- */

/** Default wall-clock bound for one scan; the route clamps a configured value. */
export const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
export const MIN_SCAN_TIMEOUT_MS = 1_000;
export const MAX_SCAN_TIMEOUT_MS = 120_000;

/** Clamp a configured scanner timeout into the bounded window. */
export function scanTimeoutMs(configured?: number): number {
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
        return DEFAULT_SCAN_TIMEOUT_MS;
    }
    return Math.min(MAX_SCAN_TIMEOUT_MS, Math.max(MIN_SCAN_TIMEOUT_MS, Math.trunc(configured)));
}

/**
 * A scanner that exceeded the wall-clock bound. Treated exactly like an
 * unavailable scanner: the caller answers fail-closed and the submission
 * stays retryable, never clean.
 */
export class ScanTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`Malware scan exceeded the ${timeoutMs} ms bound`);
        this.name = 'ScanTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Run one scan under a hard wall-clock bound. The timer is always cleared, so
 * a fast verdict never leaves a pending timer behind; a hanging, looping or
 * resource-exhausting adapter fails closed with ScanTimeoutError instead of
 * holding the request open.
 */
export const runBoundedScan = async (
    scanner: MalwareScanner,
    input: MalwareScanInput,
    timeoutMs: number = DEFAULT_SCAN_TIMEOUT_MS,
): Promise<MalwareScanVerdict> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            scanner.scan(input),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new ScanTimeoutError(timeoutMs)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

/**
 * What the store answered for an exact-version delete. The store itself is the
 * only party that can decide this: it compares the precondition against the
 * live object and refuses the delete when the version has moved on.
 */
export type ObjectVersionRemoval =
    /** The named version was destroyed. */
    | 'removed'
    /** Nothing exists at the key any more. */
    | 'already_absent'
    /** The key now holds a different version; nothing was destroyed. */
    | 'version_replaced';

/**
 * The outcome of a quarantine cleanup attempt, including the cases where the
 * store was never asked. `unsupported` and `failed` both mean the scanned bytes
 * may still exist: they are *pending*, never reported as cleaned up.
 */
export type QuarantineCleanup = ObjectVersionRemoval | 'unsupported' | 'failed';

/** What an exact-version delete must name: the key *and* the version. */
export interface ExactVersionRemovalInput {
    objectKey: string;
    etag: string;
    sizeBytes: number;
}

/**
 * What an adapter can prove about its delete. Declared, never inferred: a
 * capability that is absent must not be simulated, because a mutable-key delete
 * cannot distinguish the scanned bytes from a concurrent replacement.
 */
export interface AssignmentObjectStoreCapabilities {
    /**
     * True only when `removeObjectVersion` is implemented **and** the underlying
     * store refuses the delete unless the object still matches the named
     * version. An adapter that can only delete by key must declare `false`.
     */
    conditionalDelete: boolean;
}

/**
 * The object-store surface the assignment lifecycle depends on. Every method
 * is injectable so the route can be exercised hermetically.
 */
export interface AssignmentObjectStore {
    /** Metadata for an existing object, or null when it does not exist. */
    statObject(objectKey: string): Promise<AssignmentObjectMetadata | null>;
    /** At most `maxBytes` from the start of the object. */
    readPrefix(objectKey: string, maxBytes: number): Promise<Buffer>;
    /** Short-lived private presigned PUT URL for the exact key. */
    createUploadUrl(input: UploadUrlInput): Promise<string>;
    /**
     * Optional stronger capability: an authorization the store itself refuses
     * above `maxBytes` (a signed content-length range). A store that cannot
     * express one must omit this method; the route then falls back to a
     * presigned PUT and reports `max_bytes_enforced: false`, because a SigV4
     * presigned PUT cannot bind the body length.
     */
    createUploadAuthorization?(input: SignedUploadInput): Promise<SignedUploadAuthorization>;
    /**
     * Best-effort removal of the object currently at the key. This is a
     * **mutable-key** delete: it destroys whatever is there when it runs. It is
     * therefore only used for admission rejections of an object that has no
     * verdict, and never for a quarantine cleanup — see
     * `removeScannedObjectVersion`.
     */
    removeObject(objectKey: string): Promise<void>;
    /** Declared delete capabilities. Absent ⇒ nothing beyond `removeObject`. */
    capabilities?: AssignmentObjectStoreCapabilities;
    /**
     * Optional exact-version delete. Present only when the store can enforce the
     * precondition; the adapter must answer `version_replaced` rather than
     * deleting when the object no longer matches `etag`/`sizeBytes`.
     */
    removeObjectVersion?(input: ExactVersionRemovalInput): Promise<ObjectVersionRemoval>;
}

/**
 * Whether this adapter has *demonstrably* declared an exact-version delete.
 * Both the flag and the implementation are required: a flag without a method
 * proves nothing, and a method without the flag is not a claim the adapter
 * stands behind.
 */
export const supportsExactVersionRemoval = (store: AssignmentObjectStore): boolean =>
    store.capabilities?.conditionalDelete === true
    && typeof store.removeObjectVersion === 'function';

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
export async function removeScannedObjectVersion(
    store: AssignmentObjectStore,
    input: ExactVersionRemovalInput,
    onError?: (error: unknown) => void,
): Promise<QuarantineCleanup> {
    if (!supportsExactVersionRemoval(store)) return 'unsupported';
    try {
        return await store.removeObjectVersion!(input);
    } catch (error) {
        if (onError) {
            try {
                onError(error);
            } catch {
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
const KEY_PATTERN = new RegExp(
    `^tenants/(${KEY_SEGMENT})/assignments/(${KEY_SEGMENT})/(${KEY_SEGMENT})/(${KEY_SEGMENT})\\.([a-z0-9]{1,16})$`,
);
const MAX_STORAGE_KEY_LENGTH = 255;

export interface SubmissionStorageKeyFacts {
    tenantId: string;
    assignmentId: string;
    enrollmentId: string;
    submissionId: string;
    fileExtension: string;
}

/**
 * Parse the canonical submission key. Returns null for any other shape, so a
 * forged/foreign key can never be treated as a valid binding.
 */
export function parseSubmissionStorageKey(key: string): SubmissionStorageKeyFacts | null {
    if (typeof key !== 'string' || key.length > MAX_STORAGE_KEY_LENGTH) return null;
    const match = KEY_PATTERN.exec(key);
    if (!match) return null;
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
export function verifySubmissionStorageKey(key: string, expected: SubmissionStorageKeyFacts): boolean {
    const parsed = parseSubmissionStorageKey(key);
    if (!parsed) return false;
    return parsed.tenantId === expected.tenantId
        && parsed.assignmentId === expected.assignmentId
        && parsed.enrollmentId === expected.enrollmentId
        && parsed.submissionId === expected.submissionId
        && parsed.fileExtension === expected.fileExtension.toLowerCase();
}

/* ------------------------------------------------------------------------- */
/* Content-type and magic-byte policy                                        */
/* ------------------------------------------------------------------------- */

const EXPECTED_CONTENT_TYPES: Readonly<Record<string, string>> = {
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

const MAGIC_SIGNATURES: Readonly<Record<string, readonly Buffer[]>> = {
    pdf: [Buffer.from('%PDF-', 'ascii')],
    png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    jpg: [Buffer.from([0xff, 0xd8, 0xff])],
    jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
    zip: ZIP_SIGNATURES,
    docx: ZIP_SIGNATURES,
    doc: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
};

/** Expected MIME type for a supported extension, or null when unverifiable. */
export function expectedContentType(extension: string): string | null {
    return EXPECTED_CONTENT_TYPES[extension.toLowerCase()] ?? null;
}

/** Strip parameters and normalise case for a stored content-type. */
export function normalizeContentType(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const base = value.split(';')[0]?.trim().toLowerCase();
    return base ? base : null;
}

export type SignatureFailure =
    | 'unsupported_type'
    | 'insufficient_bytes'
    | 'signature_mismatch';

export type SignatureVerdict =
    | { ok: true }
    | { ok: false; reason: SignatureFailure };

const startsWithAny = (prefix: Buffer, signatures: readonly Buffer[]): boolean =>
    signatures.some((signature) => prefix.length >= signature.length
        && prefix.subarray(0, signature.length).equals(signature));

/**
 * A text file has no magic bytes. The bounded prefix must be NUL-free and
 * decodable UTF-8 (trailing bytes may be a truncated multi-byte sequence, so
 * up to three trailing bytes are trimmed before a strict decode).
 */
function verifyTextPrefix(prefix: Buffer): SignatureVerdict {
    if (prefix.includes(0)) return { ok: false, reason: 'signature_mismatch' };
    for (let trim = 0; trim <= 3 && trim < prefix.length; trim += 1) {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, prefix.length - trim));
            return { ok: true };
        } catch {
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
export function verifyObjectSignature(extension: string, prefix: Buffer): SignatureVerdict {
    const normalized = extension.toLowerCase();
    if (normalized === 'txt') return verifyTextPrefix(prefix);
    const signatures = MAGIC_SIGNATURES[normalized];
    if (!signatures) return { ok: false, reason: 'unsupported_type' };
    const minimum = Math.min(...signatures.map((signature) => signature.length));
    if (prefix.length < minimum) return { ok: false, reason: 'insufficient_bytes' };
    return startsWithAny(prefix, signatures)
        ? { ok: true }
        : { ok: false, reason: 'signature_mismatch' };
}

/** Clamp a configured authorization lifetime into the short-lived window. */
export function uploadAuthorizationTtlSeconds(configured?: number): number {
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
        return DEFAULT_UPLOAD_URL_TTL_SECONDS;
    }
    return Math.min(MAX_UPLOAD_URL_TTL_SECONDS, Math.max(MIN_UPLOAD_URL_TTL_SECONDS, Math.trunc(configured)));
}

/* ------------------------------------------------------------------------- */
/* Production adapter over the existing configured MinIO client              */
/* ------------------------------------------------------------------------- */

const isMissingObjectError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return code === 'NoSuchKey' || code === 'NotFound';
};

const metadataContentType = (metadata: Record<string, string | number> | undefined): string | null => {
    if (!metadata) return null;
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
export const createMinioAssignmentObjectStore = (
    bucket: string = assignmentBucket(),
): AssignmentObjectStore => {
    const loadMinio = async (): Promise<typeof import('./minio')> => import('./minio');

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
            } catch (error) {
                if (isMissingObjectError(error)) return null;
                throw error;
            }
        },

        readPrefix: async (objectKey, maxBytes) => {
            const limit = Math.min(Math.max(1, Math.trunc(maxBytes)), MAX_SIGNATURE_PREFIX_BYTES);
            const { minioClient } = await loadMinio();
            const stream = await minioClient.getPartialObject(bucket, objectKey, 0, limit);
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of stream) {
                if (total >= limit) break;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
                const remaining = limit - total;
                const slice = buffer.subarray(0, remaining);
                chunks.push(slice);
                total += slice.length;
                if (total >= limit) {
                    const destroyable = stream as unknown as { destroy?: () => void };
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
                fields: Object.fromEntries(
                    Object.entries(formData).map(([name, value]) => [name, String(value)]),
                ),
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
