"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MATERIAL_FILE_SOURCE_COLUMNS = exports.MATERIAL_PDF_MAX_BYTES = void 0;
exports.materialPdfEvidence = materialPdfEvidence;
exports.createMaterialFileDeliveryService = createMaterialFileDeliveryService;
const crypto_1 = require("crypto");
exports.MATERIAL_PDF_MAX_BYTES = 10 * 1024 * 1024;
const fail = (status, error, code) => ({ ok: false, status, body: { error, ...(code ? { code } : {}) } });
const unavailable = () => fail(503, 'Private material file delivery unavailable', 'MATERIAL_FILE_UNAVAILABLE');
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const hash = /^[a-f\d]{64}$/i;
exports.MATERIAL_FILE_SOURCE_COLUMNS = ['id', 'material_id', 'tenant_id', 'course_id', 'object_key', 'object_version', 'sha256', 'size_bytes',
    'mime_type', 'status', 'scan_status', 'scanned_object_version', 'scanned_sha256', 'scan_engine', 'scan_policy_version', 'scanned_at'];
const rawVersion = (x) => {
    if (typeof x === 'string')
        return Buffer.byteLength(x) > 0 && Buffer.byteLength(x) <= 255 ? x : null;
    if (Buffer.isBuffer(x) && x.length > 0 && x.length <= 255) {
        const text = x.toString('utf8');
        return Buffer.from(text, 'utf8').equals(x) ? text : null;
    }
    return null;
};
/** Shared exact evidence predicate for metadata offers and final binary delivery. */
function materialPdfEvidence(row, scope, config) {
    if (typeof config?.reader?.read !== 'function' || !config.trustedScanner?.engine || !config.trustedScanner.policyVersion || !row
        || String(row.tenant_id) !== scope.tenantId || String(row.course_id).toLowerCase() !== scope.courseId.toLowerCase())
        return null;
    const version = rawVersion(row.object_version), scannedVersion = rawVersion(row.scanned_object_version);
    const canonical = [row.tenant_id, row.course_id, row.material_id, row.id].map(value => String(value).toLowerCase());
    if (!canonical.every(value => /^[a-z0-9_-]{1,64}$/.test(value)) || !uuid.test(String(row.id)) || !uuid.test(String(row.material_id)))
        return null;
    if (row.object_key !== `catalog-materials/${canonical.join('/')}.pdf` || row.status !== 'active' || row.scan_status !== 'clean' || row.mime_type !== 'application/pdf'
        || !version || version !== scannedVersion || !hash.test(String(row.sha256)) || !hash.test(String(row.scanned_sha256))
        || String(row.sha256).toLowerCase() !== String(row.scanned_sha256).toLowerCase()
        || row.scan_engine !== config.trustedScanner.engine || row.scan_policy_version !== config.trustedScanner.policyVersion
        || !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 5 || Number(row.size_bytes) > exports.MATERIAL_PDF_MAX_BYTES
        || !Number.isFinite(Number(row.scanned_at_epoch)) || Number(row.scanned_at_epoch) <= 0
        || !Number.isFinite(Number(row.now_epoch)) || Number(row.scanned_at_epoch) > Number(row.now_epoch))
        return null;
    return { id: String(row.id), materialId: String(row.material_id), objectKey: row.object_key, objectVersion: version, sha256: String(row.sha256).toLowerCase(),
        size: Number(row.size_bytes), scanEngine: row.scan_engine, scanPolicy: row.scan_policy_version, scannedAt: Number(row.scanned_at_epoch) };
}
/** Read-only service. Runtime owns two preparation/response leases, no global provider. */
function createMaterialFileDeliveryService(deps) {
    let leases = 0;
    return async (input) => {
        if (leases >= 2)
            return fail(503, 'Material file service busy', 'MATERIAL_FILE_BUSY');
        leases++;
        let released = false;
        const release = () => { if (!released) {
            released = true;
            leases--;
        } };
        const controller = new AbortController();
        const cancel = () => controller.abort();
        input.signal?.addEventListener('abort', cancel, { once: true });
        if (input.signal?.aborted)
            controller.abort();
        const timer = setTimeout(cancel, deps.config?.timeoutMs ?? 5000);
        const cancelled = new Promise((_, reject) => {
            if (controller.signal.aborted)
                reject(new Error('cancelled'));
            else
                controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
        // Cancellation may occur during SQL, before a reader is awaited.
        void cancelled.catch(() => { });
        let delivered = false;
        const snapshot = async () => {
            let connection = null;
            let begun = false, destroyed = false;
            try {
                connection = await deps.getConnection();
                await connection.beginTransaction();
                begun = true;
                const authority = await input.authorize(connection);
                if (authority.status !== 200)
                    return fail(authority.status, authority.body.error, authority.body.code);
                const visible = authority.body.contents?.find((row) => String(row.content_id).toLowerCase() === input.contentId.toLowerCase());
                if (!visible)
                    return fail(404, 'Lesson content not found');
                if (visible.material_type !== 'pdf' || !deps.config?.reader || !deps.config.trustedScanner?.engine || !deps.config.trustedScanner.policyVersion)
                    return unavailable();
                const [columns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_material_files' LIMIT 32`);
                if (!exports.MATERIAL_FILE_SOURCE_COLUMNS.every(name => columns.some(row => row.column_name === name)))
                    return unavailable();
                const [rows] = await connection.execute(`SELECT f.id,f.material_id,f.tenant_id,f.course_id,f.object_key,f.object_version,f.sha256,f.size_bytes,
                  f.mime_type,f.status,f.scan_status,f.scanned_object_version,f.scanned_sha256,f.scan_engine,f.scan_policy_version,
                  UNIX_TIMESTAMP(f.scanned_at) AS scanned_at_epoch,UNIX_TIMESTAMP() AS now_epoch
           FROM course_lesson_contents b INNER JOIN course_materials m ON m.id=b.material_id
           INNER JOIN course_material_files f ON f.material_id=m.id
           WHERE b.id=? AND b.lesson_id=? AND m.course_id=? AND m.is_published=1 AND m.material_type='pdf'
             AND f.course_id=m.course_id AND f.tenant_id=? LIMIT 2`, [input.contentId, input.lessonId, input.courseId, input.tenantId]);
                if (rows.length !== 1)
                    return unavailable();
                return materialPdfEvidence(rows[0], input, deps.config) ?? unavailable();
            }
            catch {
                return unavailable();
            }
            finally {
                if (connection) {
                    if (begun) {
                        try {
                            await connection.rollback();
                        }
                        catch {
                            destroyed = true;
                        }
                    }
                    else
                        destroyed = true;
                    if (destroyed) {
                        try {
                            connection.destroy();
                        }
                        catch { /* discarded */ }
                    }
                    else {
                        try {
                            connection.release();
                        }
                        catch { /* already released */ }
                    }
                    // A failed rollback must not allow verified data to reach the reader/response.
                    if (destroyed)
                        throw new Error('Unconfirmed material transaction state');
                }
            }
        };
        try {
            const proof = await snapshot();
            if ('ok' in proof)
                return proof;
            if (controller.signal.aborted)
                return unavailable();
            const source = await Promise.race([deps.config.reader.read({ objectKey: proof.objectKey, objectVersion: proof.objectVersion, signal: controller.signal }), cancelled]);
            const iterator = source[Symbol.asyncIterator]();
            const chunks = [];
            let length = 0, chunkCount = 0;
            try {
                while (true) {
                    const next = await Promise.race([iterator.next(), cancelled]);
                    if (next.done)
                        break;
                    if (!(next.value instanceof Uint8Array))
                        throw new Error('Invalid private file bytes');
                    if (++chunkCount > 16384)
                        throw new Error('Excessive private file chunk count');
                    length += next.value.byteLength;
                    if (length > proof.size || length > exports.MATERIAL_PDF_MAX_BYTES)
                        throw new Error('Private file overrun');
                    // Copy: a provider may reuse its chunk buffer before the next yield.
                    chunks.push(Buffer.from(next.value));
                }
            }
            finally {
                if (iterator.return)
                    void Promise.resolve(iterator.return()).catch(() => { });
            }
            const bytes = Buffer.concat(chunks, length);
            if (length !== proof.size || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
                || (0, crypto_1.createHash)('sha256').update(bytes).digest('hex') !== proof.sha256)
                return unavailable();
            // Fresh transaction after storage I/O: recheck enrollment, lesson, material,
            // branch and exact source proof before handing any bytes to HTTP.
            const finalProof = await snapshot();
            if ('ok' in finalProof)
                return finalProof;
            if (JSON.stringify(finalProof) !== JSON.stringify(proof))
                return fail(409, 'Material file changed; request it again', 'MATERIAL_FILE_CHANGED');
            if (controller.signal.aborted)
                return unavailable();
            delivered = true;
            return { ok: true, bytes, fileId: proof.id, release };
        }
        catch {
            return unavailable();
        }
        finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', cancel);
            controller.abort();
            if (!delivered)
                release();
        }
    };
}
