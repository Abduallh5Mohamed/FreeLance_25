"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectMaterialPdf = collectMaterialPdf;
exports.createMaterialFileIngestionService = createMaterialFileIngestionService;
const crypto_1 = require("crypto");
const material_file_delivery_1 = require("./material-file-delivery");
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const sha = (bytes) => (0, crypto_1.createHash)('sha256').update(bytes).digest('hex');
const version = (value) => {
    if (typeof value === 'string')
        return Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 255 ? value : null;
    if (!Buffer.isBuffer(value) || !value.length || value.length > 255)
        return null;
    const text = value.toString('utf8');
    return Buffer.from(text).equals(value) ? text : null;
};
const requiredColumns = ['id', 'material_id', 'tenant_id', 'course_id', 'object_key', 'object_version', 'sha256', 'size_bytes', 'mime_type', 'status',
    'scan_status', 'scanned_object_version', 'scanned_sha256', 'scan_engine', 'scan_policy_version', 'scanned_at', 'upload_request_id', 'uploaded_by', 'upload_status'];
class Stop extends Error {
    constructor(result) {
        super(result.body.error);
        this.result = result;
    }
}
const stop = (status, error, code) => { throw new Stop({ status, body: { error, code } }); };
const unavailable = () => stop(503, 'Material file upload unavailable', 'MATERIAL_FILE_UPLOAD_UNAVAILABLE');
const dto = (row) => ({ file_id: String(row.id), material_id: String(row.material_id), size_bytes: Number(row.size_bytes),
    upload_status: row.upload_status, scan_status: row.scan_status, source_status: row.status });
/** Both HTTP input and private readback are bounded; no file bytes reach logs/audit. */
async function collectMaterialPdf(source, signal) {
    const chunks = [];
    let size = 0, count = 0;
    let cancel;
    const aborted = new Promise((_, reject) => { cancel = () => reject(new Error('cancelled')); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted)
        cancel(); });
    void aborted.catch(() => { });
    const iterator = source[Symbol.asyncIterator]();
    try {
        while (true) {
            const next = await Promise.race([iterator.next(), aborted]);
            if (next.done)
                break;
            if (!(next.value instanceof Uint8Array) || ++count > 16384)
                throw Error('Invalid PDF stream');
            size += next.value.byteLength;
            if (size > material_file_delivery_1.MATERIAL_PDF_MAX_BYTES)
                stop(413, 'PDF exceeds upload limit', 'MATERIAL_FILE_TOO_LARGE');
            chunks.push(Buffer.from(next.value));
        }
        const bytes = Buffer.concat(chunks, size);
        if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
            stop(415, 'Expected PDF bytes', 'MATERIAL_FILE_TYPE');
        return bytes;
    }
    finally {
        signal.removeEventListener('abort', cancel);
        if (iterator.return)
            void Promise.resolve(iterator.return()).catch(() => { });
    }
}
function createMaterialFileIngestionService(deps) {
    let active = 0;
    const storeReady = () => typeof deps.config?.store?.putOnce === 'function' && typeof deps.config.store.read === 'function';
    const scannerReady = () => typeof deps.config?.scanner?.scan === 'function' && [deps.config.scanner.engine, deps.config.scanner.policyVersion].every(value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value));
    const withRow = async (authorize, lock, work) => {
        let connection = null, begun = false, open = false, committing = false, destroy = false;
        const rollback = async () => { open = false; try {
            await connection.rollback();
        }
        catch {
            destroy = true;
            unavailable();
        } };
        try {
            connection = await deps.getConnection();
            await connection.beginTransaction();
            begun = open = true;
            const authority = await authorize(connection, lock);
            if ('status' in authority)
                throw new Stop(authority);
            const [columns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_material_files' LIMIT 32`);
            if (!requiredColumns.every(name => columns.some(row => row.column_name === name)))
                unavailable();
            const [rows] = await connection.execute(`SELECT f.id,f.material_id,f.tenant_id,f.course_id,f.object_key,f.object_version,f.sha256,f.size_bytes,
        f.mime_type,f.status,f.scan_status,f.scanned_object_version,f.scanned_sha256,f.scan_engine,f.scan_policy_version,
        f.upload_request_id,f.uploaded_by,f.upload_status FROM course_material_files f WHERE f.material_id=? LIMIT 2${lock ? ' FOR UPDATE' : ''}`, [authority.materialId]);
            if (rows.length > 1)
                stop(409, 'Material file requires repair', 'MATERIAL_FILE_CONFLICT');
            const row = rows[0] ?? null;
            if (row && (String(row.tenant_id) !== authority.tenantId || String(row.course_id).toLowerCase() !== authority.courseId.toLowerCase()))
                stop(409, 'Material file requires repair', 'MATERIAL_FILE_CONFLICT');
            if (row && (!uuid.test(String(row.id)) || !uuid.test(String(row.material_id)) || !Number.isSafeInteger(Number(row.size_bytes))
                || Number(row.size_bytes) < 5 || Number(row.size_bytes) > material_file_delivery_1.MATERIAL_PDF_MAX_BYTES || row.mime_type !== 'application/pdf'
                || !/^[a-f\d]{64}$/.test(row.sha256) || !['reserved', 'stored', 'complete'].includes(row.upload_status)
                || !['pending', 'clean', 'rejected'].includes(row.scan_status) || !['active', 'revoked'].includes(row.status)
                || row.object_key !== `catalog-materials/${[authority.tenantId, authority.courseId, authority.materialId, row.id].map(value => String(value).toLowerCase()).join('/')}.pdf`)) {
                stop(409, 'Material file requires repair', 'MATERIAL_FILE_CONFLICT');
            }
            const result = await work(connection, authority, row);
            if (result.write) {
                committing = true;
                await connection.commit();
                open = false;
            }
            else
                await rollback();
            return result.value;
        }
        catch (error) {
            if (committing) {
                destroy = true;
                stop(503, 'Material file persistence uncertain; reconcile before retry', 'PERSISTENCE_UNCERTAIN');
            }
            if (!begun && connection)
                destroy = true;
            if (open)
                await rollback();
            if (error instanceof Stop)
                throw error;
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY')
                stop(409, 'Upload request conflicts', 'MATERIAL_FILE_CONFLICT');
            return unavailable();
        }
        finally {
            if (connection) {
                try {
                    if (destroy)
                        connection.destroy();
                    else
                        connection.release();
                }
                catch { /* already disposed */ }
            }
        }
    };
    const audit = async (connection, scope, row, action, previous) => {
        const safe = (x) => x === null ? null : JSON.stringify({ file_id: x.id, material_id: scope.materialId, upload_status: x.upload_status, scan_status: x.scan_status, source_status: x.status });
        const [result] = await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
      VALUES (?,?,?,?,?,?,?,?)`, [(0, crypto_1.randomUUID)(), scope.actorId, scope.tenantId, action, 'course_material_file', row.id, safe(previous), safe(row)]);
        if (Number(result.affectedRows) !== 1)
            throw Error('Audit not recorded');
    };
    const status = async (authorize) => {
        try {
            return await withRow(authorize, false, async (_connection, scope, row) => ({ write: false, value: { status: 200,
                    body: { file: row ? dto(row) : null, capabilities: { upload: storeReady(), scan: storeReady() && scannerReady() },
                        retry_request_id: row && row.status === 'active' && row.upload_status !== 'complete' && row.uploaded_by === scope.actorId
                            && typeof row.upload_request_id === 'string' && uuid.test(row.upload_request_id) ? row.upload_request_id : null } } }));
        }
        catch (error) {
            return error instanceof Stop ? error.result : { status: 503, body: { error: 'Material file upload unavailable', code: 'MATERIAL_FILE_UPLOAD_UNAVAILABLE' } };
        }
    };
    const revoke = async (authorize) => {
        try {
            return await withRow(authorize, true, async (connection, scope, row) => {
                if (!row)
                    stop(404, 'Material file not found', 'MATERIAL_FILE_NOT_FOUND');
                if (row.status === 'revoked')
                    return { write: false, value: { status: 200, body: { file: dto(row), unchanged: true } } };
                const next = { ...row, status: 'revoked' };
                const [result] = await connection.execute(`UPDATE course_material_files SET status='revoked' WHERE id=? AND tenant_id=? AND course_id=? AND material_id=? AND status='active'`, [row.id, scope.tenantId, scope.courseId, scope.materialId]);
                if (Number(result.affectedRows) !== 1)
                    throw Error('Source revocation failed');
                await audit(connection, scope, next, 'course_material_file.revoke', row);
                return { write: true, value: { status: 200, body: { file: dto(next), unchanged: false } } };
            });
        }
        catch (error) {
            return error instanceof Stop ? error.result : { status: 503, body: { error: 'Material file revocation unavailable', code: 'MATERIAL_FILE_REVOKE_UNAVAILABLE' } };
        }
    };
    const upload = async (input) => {
        if (!uuid.test(input.requestId))
            return { status: 400, body: { error: 'Invalid upload request id', code: 'MATERIAL_FILE_REQUEST' } };
        if (active >= 2)
            return { status: 503, body: { error: 'Material file upload busy', code: 'MATERIAL_FILE_UPLOAD_BUSY' } };
        active++;
        const controller = new AbortController(), cancel = () => controller.abort();
        input.signal?.addEventListener('abort', cancel, { once: true });
        if (input.signal?.aborted)
            controller.abort();
        const timer = setTimeout(cancel, deps.config?.timeoutMs ?? 30000);
        const cancelled = new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); if (controller.signal.aborted)
            reject(Error('cancelled')); });
        void cancelled.catch(() => { });
        const wait = (promise) => Promise.race([promise, cancelled]);
        try {
            await withRow(input.authorize, false, async () => { if (!storeReady())
                unavailable(); return { value: undefined, write: false }; });
            const bytes = await wait(input.readPayload(controller.signal));
            if (!Buffer.isBuffer(bytes) || bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
                stop(415, 'Expected PDF bytes', 'MATERIAL_FILE_TYPE');
            if (bytes.length > material_file_delivery_1.MATERIAL_PDF_MAX_BYTES)
                stop(413, 'PDF exceeds upload limit', 'MATERIAL_FILE_TOO_LARGE');
            const digest = sha(bytes), requestId = input.requestId.toLowerCase();
            const reserved = await withRow(input.authorize, true, async (connection, scope, previous) => {
                if (previous) {
                    if (String(previous.upload_request_id).toLowerCase() !== requestId || previous.uploaded_by !== scope.actorId
                        || previous.sha256 !== digest || Number(previous.size_bytes) !== bytes.length || previous.status !== 'active') {
                        stop(409, 'Material source exists or request payload changed', 'MATERIAL_FILE_CONFLICT');
                    }
                    return { value: { row: previous, scope, created: false }, write: false };
                }
                const fileId = (0, crypto_1.randomUUID)(), segments = [scope.tenantId, scope.courseId, scope.materialId, fileId].map(value => value.toLowerCase());
                if (!segments.every(value => /^[a-z0-9_-]{1,64}$/.test(value)))
                    unavailable();
                const row = { id: fileId, material_id: scope.materialId, tenant_id: scope.tenantId, course_id: scope.courseId,
                    object_key: `catalog-materials/${segments.join('/')}.pdf`, object_version: Buffer.alloc(0), sha256: digest, size_bytes: bytes.length,
                    mime_type: 'application/pdf', status: 'active', scan_status: 'pending', upload_status: 'reserved', upload_request_id: requestId, uploaded_by: scope.actorId };
                const [result] = await connection.execute(`INSERT INTO course_material_files
          (id,material_id,tenant_id,course_id,object_key,object_version,sha256,size_bytes,mime_type,status,scan_status,upload_request_id,uploaded_by,upload_status)
          VALUES (?,?,?,?,?,?,?,?,?,'active','pending',?,?,'reserved')`, [row.id, row.material_id, row.tenant_id, row.course_id, row.object_key, row.object_version, digest, bytes.length, row.mime_type, requestId, scope.actorId]);
                if (Number(result.affectedRows) !== 1)
                    throw Error('Reservation failed');
                await audit(connection, scope, row, 'course_material_file.reserve', null);
                return { value: { row, scope, created: true }, write: true };
            });
            const guard = (scope, row) => {
                if (!row || row.id !== reserved.row.id || row.upload_request_id !== requestId || row.uploaded_by !== scope.actorId
                    || row.sha256 !== digest || Number(row.size_bytes) !== bytes.length || row.status !== 'active'
                    || scope.materialId !== reserved.scope.materialId || scope.tenantId !== reserved.scope.tenantId || scope.courseId !== reserved.scope.courseId) {
                    stop(409, 'Material file changed', 'MATERIAL_FILE_CONFLICT');
                }
            };
            let row = reserved.row;
            if (row.scan_status === 'rejected')
                stop(422, 'Material file rejected', 'MATERIAL_FILE_REJECTED');
            if (row.upload_status === 'complete' && row.scan_status === 'clean')
                return { status: 200, body: { file: dto(row), unchanged: true } };
            if (controller.signal.aborted)
                unavailable();
            let objectVersion = version(row.object_version);
            if (row.upload_status === 'reserved') {
                const stored = await wait(deps.config.store.putOnce({ objectKey: row.object_key, bytes, sha256: digest, signal: controller.signal }));
                objectVersion = version(stored.objectVersion);
            }
            if (!objectVersion)
                return unavailable();
            const storedBytes = await wait(collectMaterialPdf(await wait(deps.config.store.read({ objectKey: row.object_key, objectVersion, signal: controller.signal })), controller.signal));
            if (storedBytes.length !== bytes.length || sha(storedBytes) !== digest)
                unavailable();
            row = await withRow(input.authorize, true, async (connection, scope, current) => {
                guard(scope, current);
                if (current.upload_status === 'stored' || current.upload_status === 'complete') {
                    if (version(current.object_version) !== objectVersion)
                        stop(409, 'Material version changed', 'MATERIAL_FILE_CONFLICT');
                    return { value: current, write: false };
                }
                const next = { ...current, object_version: Buffer.from(objectVersion), upload_status: 'stored' };
                const [result] = await connection.execute(`UPDATE course_material_files SET object_version=?,upload_status='stored' WHERE id=?`, [next.object_version, current.id]);
                if (Number(result.affectedRows) !== 1)
                    throw Error('Stored transition failed');
                await audit(connection, scope, next, 'course_material_file.stored', current);
                return { value: next, write: true };
            });
            const scanner = deps.config.scanner;
            if (!scanner || !scannerReady())
                return { status: 202, body: { file: dto(row), unchanged: false } };
            let verdict;
            try {
                verdict = await wait(scanner.scan({ bytes: Buffer.from(storedBytes), sha256: digest, objectVersion, signal: controller.signal }));
            }
            catch {
                return { status: 202, body: { file: dto(row), unchanged: false } };
            }
            if (!verdict || verdict.sha256 !== digest || verdict.objectVersion !== objectVersion || !['clean', 'infected'].includes(verdict.verdict)) {
                return { status: 202, body: { file: dto(row), unchanged: false } };
            }
            row = await withRow(input.authorize, true, async (connection, scope, current) => {
                guard(scope, current);
                if (version(current.object_version) !== objectVersion || !['stored', 'complete'].includes(current.upload_status))
                    stop(409, 'Material version changed', 'MATERIAL_FILE_CONFLICT');
                // A rejection is terminal; a concurrent clean result cannot promote it.
                if (current.scan_status === 'rejected' || current.scan_status === 'clean' && verdict.verdict === 'clean')
                    return { value: current, write: false };
                const next = { ...current, upload_status: 'complete', scan_status: verdict.verdict === 'clean' ? 'clean' : 'rejected' };
                const [result] = await connection.execute(`UPDATE course_material_files SET upload_status='complete',scan_status=?,
          scanned_object_version=?,scanned_sha256=?,scan_engine=?,scan_policy_version=?,scanned_at=CURRENT_TIMESTAMP WHERE id=?`, [next.scan_status, Buffer.from(objectVersion), digest, scanner.engine, scanner.policyVersion, current.id]);
                if (Number(result.affectedRows) !== 1)
                    throw Error('Scan transition failed');
                await audit(connection, scope, next, 'course_material_file.scan', current);
                return { value: next, write: true };
            });
            if (row.scan_status === 'rejected')
                stop(422, 'Material file rejected', 'MATERIAL_FILE_REJECTED');
            return { status: reserved.created ? 201 : 200, body: { file: dto(row), unchanged: false } };
        }
        catch (error) {
            return error instanceof Stop ? error.result : { status: 503, body: { error: 'Material upload interrupted; reconcile before retry', code: 'MATERIAL_FILE_UPLOAD_UNAVAILABLE' } };
        }
        finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', cancel);
            controller.abort();
            active--;
        }
    };
    return { status, upload, revoke };
}
