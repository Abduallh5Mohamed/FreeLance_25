"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCatalogVideoSelectors = parseCatalogVideoSelectors;
exports.parseCatalogVideoContext = parseCatalogVideoContext;
exports.createCatalogPlaybackAuthority = createCatalogPlaybackAuthority;
const crypto_1 = require("crypto");
const student_lesson_videos_1 = require("./student-lesson-videos");
const login_session_sql_1 = require("../security/login-session-sql");
const login_session_1 = require("../security/login-session");
// These selectors identify a reference only. Identity and access come from
// the authenticated principal and fresh server reads, never from the body.
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const identity = (x) => typeof x === 'string' && !!x && x.length <= 36 && x.trim() === x;
const integer = (x) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const exact = (x, keys) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(x, k));
function parseCatalogVideoSelectors(x) {
    if (!exact(x, ['course_id', 'lesson_id', 'content_id']) || ![x.course_id, x.lesson_id, x.content_id].every(uuid))
        throw Error('Invalid catalog selectors');
    return { course_id: String(x.course_id).toLowerCase(), lesson_id: String(x.lesson_id).toLowerCase(), content_id: String(x.content_id).toLowerCase() };
}
function parseCatalogVideoContext(raw) {
    const x = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!exact(x, ['courseId', 'lessonId', 'contentId', 'userId', 'tenantId', 'enrollmentId', 'loginSessionId', 'tokenVersion', 'branchId', 'branchMembershipVersion', 'sourceFingerprint'])
        || ![x.courseId, x.lessonId, x.contentId].every(uuid) || ![x.userId, x.tenantId, x.enrollmentId].every(identity) || !(0, login_session_1.validSessionId)(x.loginSessionId) || !integer(x.tokenVersion)
        || !(x.branchId === null && x.branchMembershipVersion === null || uuid(x.branchId) && integer(x.branchMembershipVersion)) || typeof x.sourceFingerprint !== 'string' || !/^([a-f\d]{64})$/.test(x.sourceFingerprint))
        throw Error('Invalid catalog context');
    return { courseId: String(x.courseId), lessonId: String(x.lessonId), contentId: String(x.contentId), userId: String(x.userId), tenantId: String(x.tenantId), enrollmentId: String(x.enrollmentId), loginSessionId: x.loginSessionId, tokenVersion: x.tokenVersion, branchId: x.branchId, branchMembershipVersion: x.branchMembershipVersion, sourceFingerprint: x.sourceFingerprint };
}
function createCatalogPlaybackAuthority(deps) {
    // Every invocation owns a new snapshot. Never reuse issuance proof for a
    // later delivery, or return a proof when transaction cleanup is uncertain.
    const read = async (work) => {
        const connection = await deps.getConnection();
        let opened = false, discard = false;
        try {
            await connection.beginTransaction();
            opened = true;
            return await work(connection);
        }
        finally {
            if (opened) {
                try {
                    await connection.rollback();
                }
                catch {
                    discard = true;
                }
            }
            else
                discard = true;
            if (discard)
                connection.destroy();
            else
                connection.release();
            if (discard && opened)
                throw Error('Catalog proof transaction unavailable');
        }
    };
    const ready = async (connection) => {
        const [columns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='video_sessions' AND COLUMN_NAME='catalog_context' LIMIT 1`);
        const [tables] = await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('video_sessions','login_sessions','video_security_consents') LIMIT 3`);
        if (!columns.some(row => row.column_name === 'catalog_context') || !['video_sessions', 'login_sessions', 'video_security_consents'].every(name => tables.some(row => row.table_name === name && row.engine === 'InnoDB')))
            throw Error('Catalog session schema unavailable');
        const [primary] = await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('video_sessions','login_sessions') AND INDEX_NAME='PRIMARY' LIMIT 4`);
        if (!['video_sessions', 'login_sessions'].every(name => { const rows = primary.filter(row => row.table_name === name); return rows.length === 1 && rows[0].column_name === 'id' && Number(rows[0].seq_in_index) === 1; }))
            throw Error('Catalog session primary unavailable');
    };
    const prove = async (connection, principal, selectors) => {
        if (principal.role !== 'student' || principal.identitySource === 'staff' || !principal.tenantId || !principal.studentEnrollmentId || !(0, login_session_1.validSessionId)(principal.sessionId) || !integer(principal.tokenVersion))
            return null;
        const store = (0, login_session_sql_1.createLoginSessionSqlStore)({ queryOne: async (sql, values) => { const [rows] = await connection.execute(sql, values); return rows[0] ?? null; }, execute: async () => { throw Error('Read-only login session check'); } });
        if (!(0, login_session_1.isLoginSessionLive)(await store.find(principal.sessionId, principal.id), { id: principal.sessionId, userId: principal.id, identitySource: 'users', tokenVersion: principal.tokenVersion }, deps.now()))
            return null;
        const [consents] = await connection.execute('SELECT id FROM video_security_consents WHERE user_id=? AND terms_version=? LIMIT 1', [principal.id, deps.termsVersion]);
        if (!consents[0])
            return null;
        const proof = await (0, student_lesson_videos_1.proveStudentCatalogVideo)(connection, { userId: principal.id, tenantId: principal.tenantId, enrollmentId: principal.studentEnrollmentId }, selectors.course_id, selectors.lesson_id, selectors.content_id, principal);
        if (!proof.ok)
            return null;
        const [sources] = await connection.execute(`SELECT id,is_encrypted,hls_key,original_key,encryption_key,UNIX_TIMESTAMP(updated_at) AS revision FROM videos WHERE id=? AND course_id=? AND tenant_id=? AND status='ready' LIMIT 1`, [proof.video.video_id, proof.courseId, proof.scope.tenantId]);
        const source = sources[0];
        if (!source || source.id !== proof.video.video_id || ![1, true, '1'].includes(source.is_encrypted) || source.hls_key !== `${source.id}/playlist.m3u8` || typeof source.original_key !== 'string' || !source.original_key || source.original_key === source.hls_key || typeof source.encryption_key !== 'string' || !/^([a-f\d]{32})$/i.test(source.encryption_key) || !Number.isFinite(Number(source.revision)) || Number(source.revision) <= 0)
            return null;
        // Bind the session to source metadata without persisting its secrets.
        // This is not an object-byte digest or a provider version guarantee.
        const sourceFingerprint = (0, crypto_1.createHash)('sha256').update(JSON.stringify([source.id, source.hls_key, source.original_key, source.encryption_key.toLowerCase(), Number(source.revision)])).digest('hex');
        const context = parseCatalogVideoContext({ courseId: proof.courseId, lessonId: proof.lessonId, contentId: proof.video.content_id, userId: proof.scope.userId, tenantId: proof.scope.tenantId, enrollmentId: proof.scope.enrollmentId, loginSessionId: principal.sessionId, tokenVersion: principal.tokenVersion, branchId: principal.branchId ?? null, branchMembershipVersion: principal.branchId ? principal.branchMembershipVersion ?? null : null, sourceFingerprint });
        return { videoId: proof.video.video_id, context };
    };
    return {
        resolve: (principal, selectors) => read(async (connection) => { await ready(connection); return prove(connection, principal, parseCatalogVideoSelectors(selectors)); }),
        check: session => read(async (connection) => {
            if (!session.catalogContext || session.previewOnly)
                return false;
            await ready(connection);
            const cached = parseCatalogVideoContext(session.catalogContext);
            if (cached.userId !== session.userId || cached.tenantId !== session.tenantId || cached.enrollmentId !== session.studentEnrollmentId)
                return false;
            const [rows] = await connection.execute('SELECT catalog_context FROM video_sessions WHERE id=? AND user_id=? AND video_id=? AND is_active=1 LIMIT 1', [session.sessionId, session.userId, session.videoId]);
            const row = rows[0];
            if (!row || JSON.stringify(parseCatalogVideoContext(row.catalog_context)) !== JSON.stringify(cached))
                return false;
            const current = await prove(connection, { id: cached.userId, email: null, phone: null, role: 'student', identitySource: 'users', tenantId: cached.tenantId, studentEnrollmentId: cached.enrollmentId, sessionId: cached.loginSessionId, tokenVersion: cached.tokenVersion, ...(cached.branchId ? { branchId: cached.branchId, branchMembershipVersion: cached.branchMembershipVersion } : {}) }, { course_id: cached.courseId, lesson_id: cached.lessonId, content_id: cached.contentId });
            return !!current && current.videoId === session.videoId && JSON.stringify(current.context) === JSON.stringify(cached);
        }),
        hasBindings: videoId => read(async (connection) => {
            const [columns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_lesson_videos' LIMIT 8`);
            if (!columns.length)
                return false;
            if (!['id', 'lesson_id', 'video_id', 'display_order'].every(name => columns.some(row => row.column_name === name)))
                throw Error('Invalid catalog binding schema');
            const [rows] = await connection.execute('SELECT id FROM course_lesson_videos WHERE video_id=? LIMIT 1', [videoId]);
            return rows.length > 0;
        }),
    };
}
