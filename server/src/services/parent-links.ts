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

import crypto from 'crypto';
import { normalizeEgyptianPhone } from '../security/phone';
import { normalizeId } from './announcements';
import { DeliveryNotConfiguredError, type IdentityOtpService } from '../security/identity-otp';

export const PARENT_LINK_PURPOSE = 'contact_verification';
export const PARENT_VIEW_TOKEN_VERSION = 'pv1';
export const PARENT_VIEW_TTL_SECONDS = 900;
export const MAX_PARENT_VIEW_TTL_SECONDS = 900;
export const MIN_PARENT_VIEW_SECRET_BYTES = 32;
export const MAX_PARENT_VIEW_TOKEN_LENGTH = 4096;

export type ParentLinkStatus = 'active' | 'revoked';

export interface ParentLinkRow {
    id: string;
    tenant_id: string;
    student_enrollment_id: string;
    parent_user_id: string;
    contact_hash: string;
    status: string;
    version: number;
    revoked_at: string | Date | null;
    revoked_by: string | null;
    created_at?: string | Date;
}

export interface StudentContactRow {
    id: string;
    tenant_id: string;
    name: string;
    phone: string | null;
    email: string | null;
    guardian_phone: string | null;
    parent_phone: string | null;
    is_active: number | boolean;
    approval_status: string | null;
    enrollment_status: string | null;
    enrollment_start_date: string | Date | null;
    enrollment_end_date: string | Date | null;
    user_id: string | null;
    group_id: string | null;
    grade_id: string | null;
    term: string | null;
}

export interface ParentViewTokenRecord {
    jti: string;
    link_id: string;
    tenant_id: string;
    student_enrollment_id: string;
    parent_user_id: string;
    issued_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    revoked_reason: string | null;
}

export interface ParentLinksStore {
    findStudentEnrollmentById(enrollmentId: string): Promise<StudentContactRow | null>;
    findLinkById(linkId: string): Promise<ParentLinkRow | null>;
    findLinkByIdScoped(tenantId: string, linkId: string): Promise<ParentLinkRow | null>;
    findLinksByParentUser(parentUserId: string): Promise<ParentLinkRow[]>;
    findActiveLink(tenantId: string, enrollmentId: string, parentUserId: string): Promise<ParentLinkRow | null>;
    insertLink(row: ParentLinkRow): Promise<void>;
    revokeLink(tenantId: string, linkId: string, actorUserId: string, now: Date): Promise<number>;
    insertViewToken(record: ParentViewTokenRecord): Promise<void>;
    findViewToken(jti: string): Promise<ParentViewTokenRecord | null>;
    revokeViewToken(jti: string, reason: string, now: Date): Promise<number>;
}

export interface ParentLinksDb {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface CanonicalContact {
    kind: 'phone' | 'email';
    value: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function canonicalContact(raw: unknown): CanonicalContact | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 254) return null;
    const phone = normalizeEgyptianPhone(trimmed);
    if (phone) return { kind: 'phone', value: phone };
    const email = trimmed.toLowerCase();
    return EMAIL_PATTERN.test(email) ? { kind: 'email', value: email } : null;
}

export interface ValidatedLinkRequest {
    studentEnrollmentId: string;
    contact: CanonicalContact;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseLinkRequestInput(body: unknown): ValidationResult<ValidatedLinkRequest> {
    const record = typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (!record) return { ok: false, error: 'Request body must be an object' };
    const studentEnrollmentId = normalizeId(record['student_enrollment_id'] ?? record['studentEnrollmentId']);
    if (!studentEnrollmentId) return { ok: false, error: 'A valid student_enrollment_id is required' };
    const contact = canonicalContact(record['contact']);
    if (!contact) return { ok: false, error: 'A valid phone or email contact is required' };
    return { ok: true, value: { studentEnrollmentId, contact } };
}

export interface ValidatedVerifyRequest {
    challengeId: string;
    code: string;
    studentEnrollmentId: string;
    contact: CanonicalContact;
}

export function parseVerifyInput(body: unknown): ValidationResult<ValidatedVerifyRequest> {
    const record = typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    if (!record) return { ok: false, error: 'Request body must be an object' };
    const challengeId = typeof record['challenge_id'] === 'string' ? record['challenge_id'].trim() : '';
    const code = typeof record['code'] === 'string' ? record['code'].trim() : '';
    const studentEnrollmentId = normalizeId(record['student_enrollment_id'] ?? record['studentEnrollmentId']);
    const contact = canonicalContact(record['contact']);
    if (!challengeId || !code) return { ok: false, error: 'A challenge_id and code are required' };
    if (!studentEnrollmentId) return { ok: false, error: 'A valid student_enrollment_id is required' };
    if (!contact) return { ok: false, error: 'A valid phone or email contact is required' };
    return { ok: true, value: { challengeId, code, studentEnrollmentId, contact } };
}

function toTime(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
}

export function isStudentEnrollmentActive(row: StudentContactRow | null, now: Date): boolean {
    if (!row) return false;
    if (row.is_active === 0 || row.is_active === false) return false;
    if (row.approval_status !== null && row.approval_status !== undefined && row.approval_status !== 'approved') return false;
    if (row.enrollment_status !== null && row.enrollment_status !== undefined && row.enrollment_status !== 'active') return false;
    const nowMs = now.getTime();
    const start = toTime(row.enrollment_start_date);
    const end = toTime(row.enrollment_end_date);
    if (start !== null && start > nowMs) return false;
    if (end !== null && end <= nowMs) return false;
    return true;
}

function studentMatchesContact(row: StudentContactRow, contact: CanonicalContact): boolean {
    if (contact.kind === 'email') {
        const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : null;
        return email !== null && email === contact.value;
    }
    for (const raw of [row.guardian_phone, row.parent_phone]) {
        const normalized = normalizeEgyptianPhone(raw);
        if (normalized && normalized === contact.value) return true;
    }
    return false;
}

export class ParentViewSecretUnavailableError extends Error {
    constructor() {
        super('Parent view secret is not configured');
        this.name = 'ParentViewSecretUnavailableError';
    }
}

export interface ParentViewClaims {
    jti: string;
    link_id: string;
    tenant_id: string;
    student_enrollment_id: string;
    parent_user_id: string;
    iat: number;
    exp: number;
}

function toBase64Url(input: Buffer): string {
    return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): Buffer {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + padding, 'base64');
}

function signatureFor(secret: string, payload: string): Buffer {
    return crypto.createHmac('sha256', secret).update(`${PARENT_VIEW_TOKEN_VERSION}.${payload}`).digest();
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export function parseParentViewClaims(value: unknown): ParentViewClaims | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const { jti, link_id, tenant_id, student_enrollment_id, parent_user_id } = record;
    if (typeof jti !== 'string' || typeof link_id !== 'string' || typeof tenant_id !== 'string'
        || typeof student_enrollment_id !== 'string' || typeof parent_user_id !== 'string') return null;
    const iat = Number(record['iat']);
    const exp = Number(record['exp']);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    return { jti, link_id, tenant_id, student_enrollment_id, parent_user_id, iat, exp };
}

export function signParentViewToken(secret: string, claims: ParentViewClaims): string {
    const payload = toBase64Url(Buffer.from(JSON.stringify(claims), 'utf8'));
    const signature = toBase64Url(signatureFor(secret, payload));
    return `${PARENT_VIEW_TOKEN_VERSION}.${payload}.${signature}`;
}

export type ParentViewTokenParseResult =
    | { ok: true; claims: ParentViewClaims }
    | { ok: false; reason: 'malformed' | 'invalid-signature' | 'unknown-claims' };

export function verifyParentViewToken(secret: unknown, token: unknown): ParentViewTokenParseResult {
    if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'malformed' };
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_PARENT_VIEW_TOKEN_LENGTH) {
        return { ok: false, reason: 'malformed' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PARENT_VIEW_TOKEN_VERSION || !parts[1] || !parts[2]) {
        return { ok: false, reason: 'malformed' };
    }
    let supplied: Buffer;
    try {
        supplied = fromBase64Url(parts[2]);
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!constantTimeEqual(signatureFor(secret, parts[1]), supplied)) {
        return { ok: false, reason: 'invalid-signature' };
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const claims = parseParentViewClaims(decoded);
    return claims ? { ok: true, claims } : { ok: false, reason: 'unknown-claims' };
}

export function normalizeParentViewTtl(ttlSeconds: unknown): number {
    const parsed = typeof ttlSeconds === 'number' ? Math.trunc(ttlSeconds) : Number.parseInt(String(ttlSeconds ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return PARENT_VIEW_TTL_SECONDS;
    return Math.min(MAX_PARENT_VIEW_TTL_SECONDS, parsed);
}

export type ParentLinkDenialReason = 'invalid-contact' | 'student-not-found' | 'contact-mismatch';

export type RequestLinkResult =
    | { kind: 'challenge'; challengeId: string; expiresAt: Date; resendAvailableAt: Date; contactHash: string }
    | { kind: 'already-linked'; link: ParentLinkRow }
    | { kind: 'denied'; reason: ParentLinkDenialReason };

export type VerifyLinkResult =
    | { kind: 'linked'; link: ParentLinkRow; token: string; expiresAt: Date }
    | { kind: 'already-linked'; link: ParentLinkRow; token: string; expiresAt: Date }
    | { kind: 'denied'; reason: ParentLinkDenialReason | 'invalid-input' | 'verification-failed' };

export type SessionTokenResult =
    | { kind: 'issued'; token: string; expiresAt: Date }
    | { kind: 'not-found' };

export interface ParentLinksService {
    requestLink(input: {
        parentId: string;
        studentEnrollmentId: string;
        contact: CanonicalContact;
        ip?: string | null;
    }): Promise<RequestLinkResult>;
    verifyLink(input: {
        parentId: string;
        challengeId: string;
        code: string;
        studentEnrollmentId: string;
        contact: CanonicalContact;
    }): Promise<VerifyLinkResult>;
    listLinks(parentUserId: string): Promise<ParentLinkRow[]>;
    getLinkById(linkId: string): Promise<ParentLinkRow | null>;
    revokeLink(link: ParentLinkRow, actorUserId: string): Promise<boolean>;
    issueSessionToken(tenantId: string, linkId: string, parentUserId: string): Promise<SessionTokenResult>;
}

export interface ParentLinksDeps {
    store: ParentLinksStore;
    otp?: IdentityOtpService;
    getSecret: () => string | undefined;
    now?: () => Date;
    idFactory?: () => string;
    transaction?: <T>(fn: (store: ParentLinksStore) => Promise<T>) => Promise<T>;
}

const LINK_COLUMNS = 'id, tenant_id, student_enrollment_id, parent_user_id, contact_hash, status, version, revoked_at, revoked_by, created_at';

function normalizeLinkStatus(value: unknown): ParentLinkStatus {
    return value === 'revoked' ? 'revoked' : 'active';
}

export function createParentLinksService(deps: ParentLinksDeps): ParentLinksService {
    const now = deps.now ?? (() => new Date());
    const idFactory = deps.idFactory ?? (() => crypto.randomUUID());
    const runAtomic = deps.transaction ?? (<T>(fn: (store: ParentLinksStore) => Promise<T>) => fn(deps.store));

    const mintToken = async (link: ParentLinkRow): Promise<{ token: string; expiresAt: Date }> => {
        const secret = deps.getSecret()?.trim();
        if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_PARENT_VIEW_SECRET_BYTES) {
            throw new ParentViewSecretUnavailableError();
        }
        const issuedAt = now();
        const expiresAt = new Date(issuedAt.getTime() + PARENT_VIEW_TTL_SECONDS * 1000);
        const claims: ParentViewClaims = {
            jti: idFactory(),
            link_id: link.id,
            tenant_id: link.tenant_id,
            student_enrollment_id: link.student_enrollment_id,
            parent_user_id: link.parent_user_id,
            iat: issuedAt.getTime(),
            exp: expiresAt.getTime(),
        };
        const token = signParentViewToken(secret, claims);
        await deps.store.insertViewToken({
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
            if (!otp) throw new DeliveryNotConfiguredError();
            const student = await deps.store.findStudentEnrollmentById(input.studentEnrollmentId);
            if (!student || !isStudentEnrollmentActive(student, now())) return { kind: 'denied', reason: 'student-not-found' };
            if (!studentMatchesContact(student, input.contact)) return { kind: 'denied', reason: 'contact-mismatch' };
            const existing = await deps.store.findActiveLink(student.tenant_id, student.id, input.parentId);
            if (existing) return { kind: 'already-linked', link: existing };
            const issued = await otp.issue({
                contact: input.contact.value,
                purpose: PARENT_LINK_PURPOSE,
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
            if (!otp) throw new DeliveryNotConfiguredError();
            const student = await deps.store.findStudentEnrollmentById(input.studentEnrollmentId);
            if (!student || !isStudentEnrollmentActive(student, now())) return { kind: 'denied', reason: 'student-not-found' };
            if (!studentMatchesContact(student, input.contact)) return { kind: 'denied', reason: 'contact-mismatch' };
            const tenantId = student.tenant_id;

            const verified = await otp.verify({
                challengeId: input.challengeId,
                code: input.code,
                contact: input.contact.value,
                purpose: PARENT_LINK_PURPOSE,
                tenantId,
                identityId: input.parentId,
            });
            if (verified.kind !== 'consumed') return { kind: 'denied', reason: 'verification-failed' };

            const claimed = await otp.assertConsumed({
                challengeId: input.challengeId,
                contact: input.contact.value,
                purpose: PARENT_LINK_PURPOSE,
                tenantId,
                identityId: input.parentId,
            });
            if (!claimed) return { kind: 'denied', reason: 'verification-failed' };

            const existing = await deps.store.findActiveLink(tenantId, student.id, input.parentId);
            if (existing) {
                const token = await mintToken(existing);
                return { kind: 'already-linked', link: existing, token: token.token, expiresAt: token.expiresAt };
            }

            const link: ParentLinkRow = {
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
            const minted = await runAtomic(async (store) => {
                await store.insertLink(link);
                const secret = deps.getSecret()?.trim();
                if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_PARENT_VIEW_SECRET_BYTES) {
                    throw new ParentViewSecretUnavailableError();
                }
                const issuedAt = now();
                const expiresAt = new Date(issuedAt.getTime() + PARENT_VIEW_TTL_SECONDS * 1000);
                const claims: ParentViewClaims = {
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
            const affected = await deps.store.revokeLink(link.tenant_id, link.id, actorUserId, now());
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

export type ParentViewDenialReason =
    | 'secret-unavailable'
    | 'malformed'
    | 'invalid-signature'
    | 'unknown-claims'
    | 'expired'
    | 'revoked-token'
    | 'revoked-link'
    | 'link-not-found'
    | 'tenant-mismatch'
    | 'enrollment-mismatch';

export type ParentViewVerification =
    | { ok: true; link: ParentLinkRow; claims: ParentViewClaims }
    | { ok: false; reason: ParentViewDenialReason };

export interface ParentViewVerifier {
    verify(token: unknown): Promise<ParentViewVerification>;
}

export interface ParentViewVerifierDeps {
    store: ParentLinksStore;
    getSecret: () => string | undefined;
    now?: () => Date;
}

export function createParentViewVerifier(deps: ParentViewVerifierDeps): ParentViewVerifier {
    const now = deps.now ?? (() => new Date());
    return {
        verify: async (token) => {
            const secret = deps.getSecret()?.trim();
            if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_PARENT_VIEW_SECRET_BYTES) {
                return { ok: false, reason: 'secret-unavailable' };
            }
            const parsed = verifyParentViewToken(secret, token);
            if (!parsed.ok) {
                return { ok: false, reason: parsed.reason };
            }
            const claims = parsed.claims;
            const nowMs = now().getTime();
            if (!Number.isFinite(claims.exp) || claims.exp <= nowMs) return { ok: false, reason: 'expired' };
            const record = await deps.store.findViewToken(claims.jti);
            if (!record) return { ok: false, reason: 'revoked-token' };
            if (record.revoked_at !== null && record.revoked_at !== undefined) {
                return { ok: false, reason: 'revoked-token' };
            }
            if (record.expires_at.getTime() <= nowMs) return { ok: false, reason: 'expired' };
            const link = await deps.store.findLinkByIdScoped(claims.tenant_id, claims.link_id);
            if (!link) return { ok: false, reason: 'link-not-found' };
            if (link.tenant_id !== claims.tenant_id) return { ok: false, reason: 'tenant-mismatch' };
            if (link.student_enrollment_id !== claims.student_enrollment_id) return { ok: false, reason: 'enrollment-mismatch' };
            if (link.parent_user_id !== claims.parent_user_id) return { ok: false, reason: 'enrollment-mismatch' };
            if (normalizeLinkStatus(link.status) !== 'active' || link.revoked_at !== null) {
                return { ok: false, reason: 'revoked-link' };
            }
            return { ok: true, link, claims };
        },
    };
}

export function createSqlParentLinksStore(db: ParentLinksDb): ParentLinksStore {
    const toIso = (value: unknown): string | null => {
        if (value === null || value === undefined) return null;
        const date = value instanceof Date ? value : new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T'));
        return Number.isFinite(date.getTime()) ? date.toISOString() : null;
    };

    return {
        findStudentEnrollmentById: async (enrollmentId) => db.queryOne<StudentContactRow>(
            `SELECT id, tenant_id, name, phone, email, guardian_phone, parent_phone, is_active,
                    approval_status, enrollment_status, enrollment_start_date, enrollment_end_date,
                    user_id, group_id, grade_id, term
             FROM students WHERE id = ? LIMIT 1`,
            [enrollmentId],
        ),

        findLinkById: async (linkId) => db.queryOne<ParentLinkRow>(
            `SELECT ${LINK_COLUMNS} FROM parent_links WHERE id = ? LIMIT 1`,
            [linkId],
        ),

        findLinkByIdScoped: async (tenantId, linkId) => db.queryOne<ParentLinkRow>(
            `SELECT ${LINK_COLUMNS} FROM parent_links WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [linkId, tenantId],
        ),

        findLinksByParentUser: async (parentUserId) => db.query<ParentLinkRow>(
            `SELECT ${LINK_COLUMNS} FROM parent_links WHERE parent_user_id = ? ORDER BY created_at DESC LIMIT 200`,
            [parentUserId],
        ),

        findActiveLink: async (tenantId, enrollmentId, parentUserId) => db.queryOne<ParentLinkRow>(
            `SELECT ${LINK_COLUMNS} FROM parent_links
             WHERE tenant_id = ? AND student_enrollment_id = ? AND parent_user_id = ? AND status = 'active' LIMIT 1`,
            [tenantId, enrollmentId, parentUserId],
        ),

        insertLink: async (row) => {
            await db.execute(
                `INSERT INTO parent_links
                    (id, tenant_id, student_enrollment_id, parent_user_id, contact_hash, status, version, revoked_at, revoked_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [row.id, row.tenant_id, row.student_enrollment_id, row.parent_user_id, row.contact_hash, row.status, row.version, row.revoked_at ?? null, row.revoked_by ?? null],
            );
        },

        revokeLink: async (tenantId, linkId, actorUserId, now) => {
            const result = await db.execute(
                `UPDATE parent_links
                 SET status = 'revoked', revoked_at = ?, revoked_by = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND tenant_id = ? AND status = 'active'`,
                [now, actorUserId, linkId, tenantId],
            );
            return Number(result.affectedRows ?? 0);
        },

        insertViewToken: async (record) => {
            await db.execute(
                `INSERT INTO parent_view_tokens
                    (jti, link_id, tenant_id, student_enrollment_id, parent_user_id, issued_at, expires_at, revoked_at, revoked_reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    record.jti, record.link_id, record.tenant_id, record.student_enrollment_id, record.parent_user_id,
                    record.issued_at, record.expires_at, record.revoked_at, record.revoked_reason,
                ],
            );
        },

        findViewToken: async (jti) => {
            const row = await db.queryOne<Record<string, unknown>>(
                `SELECT jti, link_id, tenant_id, student_enrollment_id, parent_user_id, issued_at, expires_at, revoked_at, revoked_reason
                 FROM parent_view_tokens WHERE jti = ? LIMIT 1`,
                [jti],
            );
            if (!row) return null;
            const expiresAt = toIso(row['expires_at']);
            if (expiresAt === null) return null;
            return {
                jti: String(row['jti']),
                link_id: String(row['link_id']),
                tenant_id: String(row['tenant_id']),
                student_enrollment_id: String(row['student_enrollment_id']),
                parent_user_id: String(row['parent_user_id']),
                issued_at: new Date(toIso(row['issued_at']) ?? Date.now()),
                expires_at: new Date(expiresAt),
                revoked_at: toIso(row['revoked_at']) === null ? null : new Date(toIso(row['revoked_at']) as string),
                revoked_reason: row['revoked_reason'] === null ? null : String(row['revoked_reason']),
            };
        },

        revokeViewToken: async (jti, reason, now) => {
            const result = await db.execute(
                `UPDATE parent_view_tokens SET revoked_at = ?, revoked_reason = ? WHERE jti = ? AND revoked_at IS NULL`,
                [now, reason, jti],
            );
            return Number(result.affectedRows ?? 0);
        },
    };
}
