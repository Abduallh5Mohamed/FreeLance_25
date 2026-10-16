import { Router, RequestHandler, Response } from 'express';
import path from 'path';
import { promises as fs } from 'fs';
import { queryOne } from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';

/**
 * Media row reachable only through the authority predicate below: the
 * caller's selected tenant AND an exact-uploader or parent-resource
 * participant relationship. Ids are CHAR(36) and the metadata columns are
 * NOT NULL in the schema, but the metadata is still validated before it
 * reaches a response header because upload clients supply it through
 * multipart parsing.
 */
export interface TenantMediaFileRow {
    storage_path: string;
    mime_type: string;
    original_name: string;
}

/**
 * Data-access seam for the download lookup. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 */
export interface FileDownloadDataAccess {
    queryOne: <T>(sql: string, params?: unknown[]) => Promise<T | null>;
}

/**
 * Server-owned authority lookup for a tenant media row.
 *
 * Tenant membership alone is NOT private-object authority: any authenticated
 * member of the tenant (e.g. an unrelated student) can otherwise download
 * every stored attachment, receipt, or exam image by id. The row is therefore
 * returned only for its exact uploader or for a participant/entitled party of
 * a parent resource that references the file through a relation the server
 * itself wrote:
 *
 *  - messages.image_url: the private participants are the message's own
 *    sender_id / receiver_id (chat attachments, written by
 *    POST /api/messages/upload-image).
 *  - exam_questions.question_image: the owning instructor of the exam
 *    (exam_groups -> groups.instructor_id) and a student who has an attempt
 *    on that exam (exam_attempts.student_id) — the same audiences the exam
 *    question routes themselves serve.
 *  - premium_lecture_payments.receipt_image_url: the instructor who owns the
 *    lecture's group (premium_lectures.group_id -> groups.instructor_id),
 *    the same scope the payment review routes use. The paying student is
 *    the row's uploader.
 *
 * Every participant id is a users.id the middleware resolved server-side; no
 * client-supplied identifier participates in the decision. A relation that
 * cannot be proven from server-written columns fails closed (the row is not
 * returned, so the answer is the same 404 as a missing id), and no
 * tenant-wide grant is inferred.
 */
const AUTHORIZED_TENANT_MEDIA_LOOKUP_SQL = `
    SELECT f.storage_path, f.mime_type, f.original_name
    FROM tenant_media_files f
    WHERE f.id=? AND f.tenant_id=?
      AND (
        f.uploaded_by=?
        OR EXISTS (
            SELECT 1 FROM messages m
            WHERE m.image_url = CONCAT('/api/files/', f.id, '/download')
              AND (m.sender_id = ? OR m.receiver_id = ?)
        )
        OR EXISTS (
            SELECT 1
            FROM exam_questions q
            INNER JOIN exam_groups eg ON eg.exam_id = q.exam_id
            INNER JOIN \`groups\` g ON g.id = eg.group_id
            WHERE q.question_image = CONCAT('/api/files/', f.id, '/download')
              AND g.instructor_id = ?
        )
        OR EXISTS (
            SELECT 1
            FROM exam_questions q
            INNER JOIN exam_attempts a ON a.exam_id = q.exam_id
            WHERE q.question_image = CONCAT('/api/files/', f.id, '/download')
              AND a.student_id = ?
        )
        OR EXISTS (
            SELECT 1
            FROM premium_lecture_payments p
            INNER JOIN premium_lectures pl ON pl.id = p.premium_lecture_id
            INNER JOIN \`groups\` g ON g.id = pl.group_id
            WHERE p.receipt_image_url = CONCAT('/api/files/', f.id, '/download')
              AND g.instructor_id = ?
        )
      )
`;

/**
 * Injectable seams for the files router. The default export binds the
 * production SQL adapter, the real authentication middleware, and the
 * server-resolved upload root. Tests inject fixtures through this boundary
 * instead of bypassing production authorization.
 */
export interface FilesRouterDeps {
    db: FileDownloadDataAccess;
    /** Production binds the real authenticateToken; tests bind the same middleware over an injected principal repository. */
    authenticate: RequestHandler;
    /** Canonical upload root; every served path must resolve inside it. */
    storageRoot: string;
}

const DEFAULT_MIME_TYPE = 'application/octet-stream';
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/**
 * Content types a browser treats as active document content. An
 * authenticated chat origin is still an origin: an uploaded HTML or SVG
 * attachment served inline becomes markup and script executing under the
 * reader's session, so these types are never echoed back. They are answered
 * as a safe binary download with an attachment disposition instead.
 */
const ACTIVE_CONTENT_TYPES: readonly string[] = [
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
];

const normalizeMimeType = (mimeType: unknown): string | null =>
    typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : null;

/** True when the stored type is active document content (HTML/SVG family). */
const isActiveContentType = (mimeType: unknown): boolean => {
    const normalized = normalizeMimeType(mimeType);
    return normalized !== null && ACTIVE_CONTENT_TYPES.includes(normalized);
};

/**
 * Content-Type reaches a response header straight from database metadata, so
 * only a well-formed, non-active media type is echoed. An empty, overlong,
 * malformed, or active (HTML/SVG) value falls back to a binary download
 * instead of throwing inside Node's header writer (which would surface as a
 * 500), smuggling an exotic header value, or executing uploaded markup.
 */
const safeMimeType = (mimeType: unknown): string => {
    if (typeof mimeType !== 'string') return DEFAULT_MIME_TYPE;
    const trimmed = mimeType.trim();
    if (trimmed.length === 0 || trimmed.length > 150 || !MIME_TYPE_PATTERN.test(trimmed)) {
        return DEFAULT_MIME_TYPE;
    }
    if (ACTIVE_CONTENT_TYPES.includes(trimmed.toLowerCase())) return DEFAULT_MIME_TYPE;
    return trimmed;
};

/**
 * The Content-Disposition filename derives from the uploader-supplied
 * original name: only the basename survives, and every character Node's
 * header writer rejects - control characters and anything above latin1 - is
 * replaced, together with the double quote that would otherwise break out of
 * the quoted filename. A non-Latin1 upload name (e.g. an Arabic or CJK
 * receipt filename) would otherwise make res.setHeader throw
 * ERR_INVALID_CHAR, turning every download of that file into a 500. A
 * missing or non-string name degrades to an empty filename instead of
 * throwing.
 */
const safeHeaderFilename = (originalName: unknown): string =>
    (typeof originalName === 'string' ? path.basename(originalName) : '').replace(
        /[^\x20-\x7e\x80-\xff]|"/g,
        '_',
    );

/**
 * Comparison key that agrees with the kernel's view of a path. The uploads
 * tree lives on a filesystem that is case-insensitive on Windows, so a bare
 * case-sensitive string comparison would disagree with that filesystem.
 */
const compareKey = (absolutePath: string): string =>
    process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;

/** True when `target` resolves strictly inside `root`; the root itself is not a servable file. */
const isInsideRoot = (root: string, target: string): boolean => {
    const relative = path.relative(compareKey(root), compareKey(target));
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Realpath of the deepest existing ancestor of `absolutePath`, with the
 * remaining (not yet created) segments re-appended. Links on the resolved
 * prefix are followed, so a link inside the uploads root that targets an
 * outside directory is exposed by its real location. Returns null when no
 * ancestor exists or resolution fails for another reason; an unresolvable
 * path is never served (fail closed).
 */
const canonicalizeDeepestExisting = async (absolutePath: string): Promise<string | null> => {
    let current = absolutePath;
    const pendingSegments: string[] = [];
    for (;;) {
        try {
            const resolved = await fs.realpath(current);
            return pendingSegments.length > 0
                ? path.join(resolved, ...pendingSegments.reverse())
                : resolved;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
            const parent = path.dirname(current);
            if (parent === current) return null;
            pendingSegments.push(path.basename(current));
            current = parent;
        }
    }
};

/**
 * Resolve a database storage path to a canonical absolute path that is
 * provably inside the uploads root, or null when it is not.
 *
 * storage_path is untrusted input: writers store it relative to the server
 * cwd (e.g. `uploads/questions/x.png`), but any writer - or a corrupted or
 * hostile row - can store an absolute path, `..` segments, a path through a
 * link, or an empty value. A lexical prefix check alone is not containment:
 * it cannot see through links and it disagrees with a case-insensitive
 * Windows filesystem. The target is therefore canonicalized with realpath
 * before the containment decision, and the canonical path is what gets
 * served.
 */
const resolveWithinStorageRoot = async (
    storageRoot: string,
    storagePath: unknown,
): Promise<string | null> => {
    if (typeof storagePath !== 'string' || storagePath.trim().length === 0) return null;

    let canonicalRoot: string;
    try {
        canonicalRoot = await fs.realpath(storageRoot);
    } catch {
        // No readable uploads root means nothing is servable at all.
        return null;
    }

    const canonicalTarget = await canonicalizeDeepestExisting(
        path.resolve(process.cwd(), storagePath),
    );
    if (!canonicalTarget || !isInsideRoot(canonicalRoot, canonicalTarget)) return null;
    return canonicalTarget;
};

export const createFilesRouter = (deps: FilesRouterDeps): Router => {
    const router = Router();

    router.get('/:fileId/download', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const tenantId = req.user?.tenantId;
            const callerId = req.user?.id;
            if (!tenantId || !callerId) {
                return res.status(403).json({ error: 'Tenant membership required' });
            }

            // Tenant membership is server-derived from the authenticated
            // principal and the authority predicate is evaluated in SQL by
            // the server, with the caller id bound as a parameter: an
            // unrelated same-tenant principal, a foreign tenant, and an
            // unknown id are all indistinguishable (404).
            const file = await deps.db.queryOne<TenantMediaFileRow>(
                AUTHORIZED_TENANT_MEDIA_LOOKUP_SQL,
                [req.params.fileId, tenantId, callerId, callerId, callerId, callerId, callerId, callerId],
            );
            if (!file) return res.status(404).json({ error: 'File not found' });

            const absolutePath = await resolveWithinStorageRoot(deps.storageRoot, file.storage_path);
            if (!absolutePath) return res.status(404).json({ error: 'File not found' });

            // Active document content (HTML/SVG) is answered as a safe binary
            // download with an attachment disposition; it must never render
            // inline under the authenticated origin. Every other validated
            // type keeps the inline disposition.
            const activeContent = isActiveContentType(file.mime_type);
            res.setHeader('Content-Type', safeMimeType(file.mime_type));
            res.setHeader(
                'Content-Disposition',
                `${activeContent ? 'attachment' : 'inline'}; filename="${safeHeaderFilename(file.original_name)}"`,
            );
            res.setHeader('Cache-Control', 'private, no-store');
            // User-supplied bytes must never be reinterpreted by a browser
            // as a different type than the one declared above.
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.sendFile(absolutePath, error => {
                if (error && !res.headersSent) {
                    const code = (error as NodeJS.ErrnoException).code;
                    res.status(code === 'ENOENT' ? 404 : 500).end();
                }
            });
        } catch (error) {
            console.error('[Files] Tenant download failed:', error);
            return res.status(500).json({ error: 'File download failed' });
        }
    });

    return router;
};

export default createFilesRouter({
    db: { queryOne },
    authenticate: authenticateToken,
    storageRoot: path.resolve(process.cwd(), 'uploads'),
});
