"use strict";
/**
 * M6 P1/P2 parent-student verified linking and scoped read-view tokens.
 *
 * A parent proves control of the contact registered for a student with a
 * single-use OTP challenge. The OTP lifecycle is delegated to the shared
 * identity-otp service so the semantics are identical to enrollment: one-time
 * submission, expiry, contact/tenant/identity binding and attempt caps. A link
 * row is created only after that proof, and only then is a short-lived scoped
 * read token issued.
 *
 * The read token is HMAC-signed with a dedicated secret (PARENT_VIEW_SECRET,
 * at least 32 bytes), bound to link id + tenant + enrollment + parent, and
 * accepted only by the read-only parent-views routes. It fails closed (503)
 * when the secret is unavailable and is denied immediately when the link or
 * token is revoked.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParentViewSecretUnavailableError = exports.MAX_PARENT_VIEW_TOKEN_LENGTH = exports.MIN_PARENT_VIEW_SECRET_BYTES = exports.MAX_PARENT_VIEW_TTL_SECONDS = exports.PARENT_VIEW_TTL_SECONDS = exports.PARENT_VIEW_TOKEN_VERSION = exports.PARENT_LINK_PURPOSE = void 0;
exports.canonicalContact = canonicalContact;
exports.parseLinkRequestInput = parseLinkRequestInput;
exports.parseVerifyInput = parseVerifyInput;
exports.isStudentEnrollmentActive = isStudentEnrollmentActive;
exports.parseParentViewClaims = parseParentViewClaims;
exports.signParentViewToken = signParentViewToken;
exports.verifyParentViewToken = verifyParentViewToken;
exports.normalizeParentViewTtl = normalizeParentViewTtl;
exports.createParentLinksService = createParentLinksService;
exports.createParentViewVerifier = createParentViewVerifier;
exports.createSqlParentLinksStore = createSqlParentLinksStore;
const crypto_1 = __importDefault(require("crypto"));
const phone_1 = require("../security/phone");
const audit_1 = require("../security/audit");
const announcements_1 = require("./announcements");
const identity_otp_1 = require("../security/identity-otp");
exports.PARENT_LINK_PURPOSE = 'contact_verification';
exports.PARENT_VIEW_TOKEN_VERSION = 'pv1';
exports.PARENT_VIEW_TTL_SECONDS = 900;
exports.MAX_PARENT_VIEW_TTL_SECONDS = 900;
exports.MIN_PARENT_VIEW_SECRET_BYTES = 32;
exports.MAX_PARENT_VIEW_TOKEN_LENGTH = 4096;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function canonicalContact(raw) {
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 254)
        return null;
    const phone = (0, phone_1.normalizeEgyptianPhone)(trimmed);
    if (phone)
        return { kind: 'phone', value: phone };
    const email = trimmed.toLowerCase();
    return EMAIL_PATTERN.test(email) ? { kind: 'email', value: email } : null;
}
function parseLinkRequestInput(body) {
    const record = typeof body === 'object' && body !== null && !Array.isArray(body)
        ? body
        : null;
    if (!record)
        return { ok: false, error: 'Request body must be an object' };
    const studentEnrollmentId = (0, announcements_1.normalizeId)(record['student_enrollment_id'] ?? record['studentEnrollmentId']);
    if (!studentEnrollmentId)
        return { ok: false, error: 'A valid student_enrollment_id is required' };
    const contact = canonicalContact(record['contact']);
    if (!contact)
        return { ok: false, error: 'A valid phone or email contact is required' };
    return { ok: true, value: { studentEnrollmentId, contact } };
}
function parseVerifyInput(body) {
    const record = typeof body === 'object' && body !== null && !Array.isArray(body)
        ? body
        : null;
    if (!record)
        return { ok: false, error: 'Request body must be an object' };
    const challengeId = typeof record['challenge_id'] === 'string' ? record['challenge_id'].trim() : '';
    const code = typeof record['code'] === 'string' ? record['code'].trim() : '';
    const studentEnrollmentId = (0, announcements_1.normalizeId)(record['student_enrollment_id'] ?? record['studentEnrollmentId']);
    const contact = canonicalContact(record['contact']);
    if (!challengeId || !code)
        return { ok: false, error: 'A challenge_id and code are required' };
    if (!studentEnrollmentId)
        return { ok: false, error: 'A valid student_enrollment_id is required' };
    if (!contact)
        return { ok: false, error: 'A valid phone or email contact is required' };
    return { ok: true, value: { challengeId, code, studentEnrollmentId, contact } };
}
function toTime(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
}
function isStudentEnrollmentActive(row, now) {
    if (!row)
        return false;
    if (row.is_active === 0 || row.is_active === false)
        return false;
    if (row.approval_status !== null && row.approval_status !== undefined && row.approval_status !== 'approved')
        return false;
    if (row.enrollment_status !== null && row.enrollment_status !== undefined && row.enrollment_status !== 'active')
        return false;
    const nowMs = now.getTime();
    const start = toTime(row.enrollment_start_date);
    const end = toTime(row.enrollment_end_date);
    if (start !== null && start > nowMs)
        return false;
    if (end !== null && end <= nowMs)
        return false;
    return true;
}
function studentMatchesContact(row, contact) {
    if (contact.kind === 'email') {
        const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : null;
        return email !== null && email === contact.value;
    }
    for (const raw of [row.guardian_phone, row.parent_phone]) {
        const normalized = (0, phone_1.normalizeEgyptianPhone)(raw);
        if (normalized && normalized === contact.value)
            return true;
    }
    return false;
}
class ParentViewSecretUnavailableError extends Error {
    constructor() {
        super('Parent view secret is not configured');
        this.name = 'ParentViewSecretUnavailableError';
    }
}
exports.ParentViewSecretUnavailableError = ParentViewSecretUnavailableError;
function toBase64Url(input) {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(input) {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}
function signatureFor(secret, payload) {
    return crypto_1.default.createHmac('sha256', secret).update(`${exports.PARENT_VIEW_TOKEN_VERSION}.${payload}`).digest();
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
function parseParentViewClaims(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const record = value;
    const { jti, link_id, tenant_id, student_enrollment_id, parent_user_id } = record;
    if (typeof jti !== 'string' || typeof link_id !== 'string' || typeof tenant_id !== 'string'
        || typeof student_enrollment_id !== 'string' || typeof parent_user_id !== 'string')
        return null;
    const iat = Number(record['iat']);
    const exp = Number(record['exp']);
    if (!Number.isFinite(iat) || !Number.isFinite(exp))
        return null;
    return { jti, link_id, tenant_id, student_enrollment_id, parent_user_id, iat, exp };
}
function signParentViewToken(secret, claims) {
    const payload = toBase64Url(Buffer.from(JSON.stringify(claims), 'utf8'));
    const signature = toBase64Url(signatureFor(secret, payload));
    return `${exports.PARENT_VIEW_TOKEN_VERSION}.${payload}.${signature}`;
}
function verifyParentViewToken(secret, token) {
    if (typeof secret !== 'string' || secret.length === 0)
        return { ok: false, reason: 'malformed' };
    if (typeof token !== 'string' || token.length === 0 || token.length > exports.MAX_PARENT_VIEW_TOKEN_LENGTH) {
        return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== exports.PARENT_VIEW_TOKEN_VERSION || !parts[1] || !parts[2]) {
        return { ok: false, reason: 'malformed' };
    }
    let supplied;
    try {
        supplied = fromBase64Url(parts[2]);
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!constantTimeEqual(signatureFor(secret, parts[1]), supplied)) {
        return { ok: false, reason: 'invalid-signature' };
    }
    let decoded;
    try {
        decoded = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
    }
    catch {
        return { ok: false, reason: 'malformed' };
    }
    const claims = parseParentViewClaims(decoded);
    return claims ? { ok: true, claims } : { ok: false, reason: 'unknown-claims' };
}
function normalizeParentViewTtl(ttlSeconds) {
    const parsed = typeof ttlSeconds === 'number' ? Math.trunc(ttlSeconds) : Number.parseInt(String(ttlSeconds ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return exports.PARENT_VIEW_TTL_SECONDS;
    return Math.min(exports.MAX_PARENT_VIEW_TTL_SECONDS, parsed);
}
const LINK_COLUMNS = 'id, tenant_id, student_enrollment_id, parent_user_id, contact_hash, status, version, revoked_at, revoked_by, created_at';
function normalizeLinkStatus(value) {
    return value === 'revoked' ? 'revoked' : 'active';
}
function createParentLinksService(deps) {
    const now = deps.now ?? (() => new Date());
    const idFactory = deps.idFactory ?? (() => crypto_1.default.randomUUID());
    const runAtomic = deps.transaction
        ?? ((fn) => fn(deps.store, deps.execute));
    const mintToken = async (link, store = deps.store) => {
        const secret = deps.getSecret()?.trim();
        if (!secret || Buffer.byteLength(secret, 'utf8') < exports.MIN_PARENT_VIEW_SECRET_BYTES) {
            throw new ParentViewSecretUnavailableError();
        }
        const issuedAt = now();
        const expiresAt = new Date(issuedAt.getTime() + exports.PARENT_VIEW_TTL_SECONDS * 1000);
        const claims = {
            jti: idFactory(),
            link_id: link.id,
            tenant_id: link.tenant_id,
            student_enrollment_id: link.student_enrollment_id,
            parent_user_id: link.parent_user_id,
            iat: issuedAt.getTime(),
            exp: expiresAt.getTime(),
        };
        const token = signParentViewToken(secret, claims);
        await store.insertViewToken({
            jti: claims.jti,
            link_id: link.id,
            tenant_id: link.tenant_id,
            student_enrollment_id: link.student_enrollment_id,
            parent_user_id: link.parent_user_id,
            issued_at: issuedAt,
            expires_at: expiresAt,
            revoked_at: null,
            revoked_reason: null,
        });
        return { token, expiresAt };
    };
    return {
        requestLink: async (input) => {
            const otp = deps.otp;
            if (!otp)
                throw new identity_otp_1.DeliveryNotConfiguredError();
            const student = await deps.store.findStudentEnrollmentById(input.studentEnrollmentId);
            if (!student || !isStudentEnrollmentActive(student, now()))
                return { kind: 'denied', reason: 'student-not-found' };
            if (!studentMatchesContact(student, input.contact))
                return { kind: 'denied', reason: 'contact-mismatch' };
            const existing = await deps.store.findActiveLink(student.tenant_id, student.id, input.parentId);
            if (existing)
                return { kind: 'already-linked', link: existing };
            const issued = await otp.issue({
                contact: input.contact.value,
                purpose: exports.PARENT_LINK_PURPOSE,
                tenantId: student.tenant_id,
                identityId: input.parentId,
                ip: input.ip ?? null,
            });
            return {
                kind: 'challenge',
                challengeId: issued.challengeId,
                expiresAt: issued.expiresAt,
                resendAvailableAt: issued.resendAvailableAt,
                contactHash: otp.contactHash(input.contact.value),
            };
        },
        verifyLink: async (input) => {
            const otp = deps.otp;
            if (!otp)
                throw new identity_otp_1.DeliveryNotConfiguredError();
            const student = await deps.store.findStudentEnrollmentById(input.studentEnrollmentId);
            if (!student || !isStudentEnrollmentActive(student, now()))
                return { kind: 'denied', reason: 'student-not-found' };
            if (!studentMatchesContact(student, input.contact))
                return { kind: 'denied', reason: 'contact-mismatch' };
            const tenantId = student.tenant_id;
            const verified = await otp.verify({
                challengeId: input.challengeId,
                code: input.code,
                contact: input.contact.value,
                purpose: exports.PARENT_LINK_PURPOSE,
                tenantId,
                identityId: input.parentId,
            });
            if (verified.kind !== 'consumed')
                return { kind: 'denied', reason: 'verification-failed' };
            const claimed = await otp.assertConsumed({
                challengeId: input.challengeId,
                contact: input.contact.value,
                purpose: exports.PARENT_LINK_PURPOSE,
                tenantId,
                identityId: input.parentId,
            });
            if (!claimed)
                return { kind: 'denied', reason: 'verification-failed' };
            const existing = await deps.store.findActiveLink(tenantId, student.id, input.parentId);
            if (existing) {
                // The token mint and its audit row share one transaction: an
                // audit failure must not leave an unaudited view token behind.
                const minted = await runAtomic(async (store, txExecute) => {
                    const token = await mintToken(existing, store);
                    const exec = txExecute ?? deps.execute;
                    if (exec) {
                        await (0, audit_1.recordAudit)(exec, {
                            actorUserId: input.parentId,
                            tenantId: existing.tenant_id,
                            action: 'parent_link.verified',
                            resourceType: 'parent_link',
                            resourceId: existing.id,
                        });
                    }
                    return token;
                });
                return { kind: 'already-linked', link: existing, token: minted.token, expiresAt: minted.expiresAt };
            }
            const link = {
                id: idFactory(),
                tenant_id: tenantId,
                student_enrollment_id: student.id,
                parent_user_id: input.parentId,
                contact_hash: otp.contactHash(input.contact.value),
                status: 'active',
                version: 0,
                revoked_at: null,
                revoked_by: null,
            };
            const minted = await runAtomic(async (store, txExecute) => {
                await store.insertLink(link);
                const secret = deps.getSecret()?.trim();
                if (!secret || Buffer.byteLength(secret, 'utf8') < exports.MIN_PARENT_VIEW_SECRET_BYTES) {
                    throw new ParentViewSecretUnavailableError();
                }
                const issuedAt = now();
                const expiresAt = new Date(issuedAt.getTime() + exports.PARENT_VIEW_TTL_SECONDS * 1000);
                const claims = {
                    jti: idFactory(),
                    link_id: link.id,
                    tenant_id: link.tenant_id,
                    student_enrollment_id: link.student_enrollment_id,
                    parent_user_id: link.parent_user_id,
                    iat: issuedAt.getTime(),
                    exp: expiresAt.getTime(),
                };
                await store.insertViewToken({
                    jti: claims.jti,
                    link_id: link.id,
                    tenant_id: link.tenant_id,
                    student_enrollment_id: link.student_enrollment_id,
                    parent_user_id: link.parent_user_id,
                    issued_at: issuedAt,
                    expires_at: expiresAt,
                    revoked_at: null,
                    revoked_reason: null,
                });
                const exec = txExecute ?? deps.execute;
                if (exec) {
                    await (0, audit_1.recordAudit)(exec, {
                        actorUserId: input.parentId,
                        tenantId: link.tenant_id,
                        action: 'parent_link.verified',
                        resourceType: 'parent_link',
                        resourceId: link.id,
                    });
                }
                return { token: signParentViewToken(secret, claims), expiresAt };
            });
            return {
                kind: 'linked',
                link,
                token: minted.token,
                expiresAt: minted.expiresAt,
            };
        },
        listLinks: async (parentUserId) => deps.store.findLinksByParentUser(parentUserId),
        getLinkById: async (linkId) => deps.store.findLinkById(linkId),
        revokeLink: async (link, actorUserId) => {
            const affected = await runAtomic(async (store, txExecute) => {
                const result = await store.revokeLink(link.tenant_id, link.id, actorUserId, now());
                if (result > 0) {
                    const exec = txExecute ?? deps.execute;
                    if (exec) {
                        await (0, audit_1.recordAudit)(exec, {
                            actorUserId,
                            tenantId: link.tenant_id,
                            action: 'parent_link.revoked',
                            resourceType: 'parent_link',
                            resourceId: link.id,
                        });
                    }
                }
                return result;
            });
            return affected > 0;
        },
        issueSessionToken: async (tenantId, linkId, parentUserId) => {
            const link = await deps.store.findLinkByIdScoped(tenantId, linkId);
            if (!link || link.parent_user_id !== parentUserId || normalizeLinkStatus(link.status) !== 'active') {
                return { kind: 'not-found' };
            }
            const token = await mintToken(link);
            return { kind: 'issued', token: token.token, expiresAt: token.expiresAt };
        },
    };
}
function createParentViewVerifier(deps) {
    const now = deps.now ?? (() => new Date());
    return {
        verify: async (token) => {
            const secret = deps.getSecret()?.trim();
            if (!secret || Buffer.byteLength(secret, 'utf8') < exports.MIN_PARENT_VIEW_SECRET_BYTES) {
                return { ok: false, reason: 'secret-unavailable' };
            }
            const parsed = verifyParentViewToken(secret, token);
            if (!parsed.ok) {
                return { ok: false, reason: parsed.reason };
            }
            const claims = parsed.claims;
            const nowMs = now().getTime();
            if (!Number.isFinite(claims.exp) || claims.exp <= nowMs)
                return { ok: false, reason: 'expired' };
            const record = await deps.store.findViewToken(claims.jti);
            if (!record)
                return { ok: false, reason: 'revoked-token' };
            if (record.revoked_at !== null && record.revoked_at !== undefined) {
                return { ok: false, reason: 'revoked-token' };
            }
            if (record.expires_at.getTime() <= nowMs)
                return { ok: false, reason: 'expired' };
            const link = await deps.store.findLinkByIdScoped(claims.tenant_id, claims.link_id);
            if (!link)
                return { ok: false, reason: 'link-not-found' };
            if (link.tenant_id !== claims.tenant_id)
                return { ok: false, reason: 'tenant-mismatch' };
            if (link.student_enrollment_id !== claims.student_enrollment_id)
                return { ok: false, reason: 'enrollment-mismatch' };
            if (link.parent_user_id !== claims.parent_user_id)
                return { ok: false, reason: 'enrollment-mismatch' };
            if (normalizeLinkStatus(link.status) !== 'active' || link.revoked_at !== null) {
                return { ok: false, reason: 'revoked-link' };
            }
            return { ok: true, link, claims };
        },
    };
}
function createSqlParentLinksStore(db) {
    const toIso = (value) => {
        if (value === null || value === undefined)
            return null;
        const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };
    return {
        findStudentEnrollmentById: async (enrollmentId) => db.queryOne(`SELECT id, tenant_id, name, phone, email, guardian_phone, parent_phone, is_active,
                    approval_status, enrollment_status, enrollment_start_date, enrollment_end_date,
                    user_id, group_id, grade_id, term
             FROM students WHERE id = ? LIMIT 1`, [enrollmentId]),
        findLinkById: async (linkId) => db.queryOne(`SELECT ${LINK_COLUMNS} FROM parent_links WHERE id = ? LIMIT 1`, [linkId]),
        findLinkByIdScoped: async (tenantId, linkId) => db.queryOne(`SELECT ${LINK_COLUMNS} FROM parent_links WHERE id = ? AND tenant_id = ? LIMIT 1`, [linkId, tenantId]),
        findLinksByParentUser: async (parentUserId) => db.query(`SELECT ${LINK_COLUMNS} FROM parent_links WHERE parent_user_id = ? ORDER BY created_at DESC LIMIT 200`, [parentUserId]),
        findActiveLink: async (tenantId, enrollmentId, parentUserId) => db.queryOne(`SELECT ${LINK_COLUMNS} FROM parent_links
             WHERE tenant_id = ? AND student_enrollment_id = ? AND parent_user_id = ? AND status = 'active' LIMIT 1`, [tenantId, enrollmentId, parentUserId]),
        insertLink: async (row) => {
            await db.execute(`INSERT INTO parent_links
                    (id, tenant_id, student_enrollment_id, parent_user_id, contact_hash, status, version, revoked_at, revoked_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.tenant_id, row.student_enrollment_id, row.parent_user_id, row.contact_hash, row.status, row.version, row.revoked_at ?? null, row.revoked_by ?? null]);
        },
        revokeLink: async (tenantId, linkId, actorUserId, now) => {
            const result = await db.execute(`UPDATE parent_links
                 SET status = 'revoked', revoked_at = ?, revoked_by = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND tenant_id = ? AND status = 'active'`, [now, actorUserId, linkId, tenantId]);
            return Number(result.affectedRows ?? 0);
        },
        insertViewToken: async (record) => {
            await db.execute(`INSERT INTO parent_view_tokens
                    (jti, link_id, tenant_id, student_enrollment_id, parent_user_id, issued_at, expires_at, revoked_at, revoked_reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                record.jti, record.link_id, record.tenant_id, record.student_enrollment_id, record.parent_user_id,
                record.issued_at, record.expires_at, record.revoked_at, record.revoked_reason,
            ]);
        },
        findViewToken: async (jti) => {
            const row = await db.queryOne(`SELECT jti, link_id, tenant_id, student_enrollment_id, parent_user_id, issued_at, expires_at, revoked_at, revoked_reason
                 FROM parent_view_tokens WHERE jti = ? LIMIT 1`, [jti]);
            if (!row)
                return null;
            const expiresAt = toIso(row['expires_at']);
            if (expiresAt === null)
                return null;
            return {
                jti: String(row['jti']),
                link_id: String(row['link_id']),
                tenant_id: String(row['tenant_id']),
                student_enrollment_id: String(row['student_enrollment_id']),
                parent_user_id: String(row['parent_user_id']),
                issued_at: new Date(toIso(row['issued_at']) ?? Date.now()),
                expires_at: new Date(expiresAt),
                revoked_at: toIso(row['revoked_at']) === null ? null : new Date(toIso(row['revoked_at'])),
                revoked_reason: row['revoked_reason'] === null ? null : String(row['revoked_reason']),
            };
        },
        revokeViewToken: async (jti, reason, now) => {
            const result = await db.execute(`UPDATE parent_view_tokens SET revoked_at = ?, revoked_reason = ? WHERE jti = ? AND revoked_at IS NULL`, [now, reason, jti]);
            return Number(result.affectedRows ?? 0);
        },
    };
}
