import { Router, Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { RowDataPacket } from 'mysql2';
import { getPool, query, queryOne, execute } from '../db';
import { AuthRequest, authenticateToken, optionalAuth, getJwtSecret } from '../middleware/auth';
import { resolveJwtLifetimeSeconds } from './auth';
import { rateLimit } from '../middleware/rate-limit';
import { normalizeEgyptianPhone, phoneLookupCandidates } from '../security/phone';
import { isSuperAdmin } from '../security/admin-permissions';
import {
    BranchAccessDecision,
    resolveBranchAccess,
} from '../security/branch-access';
import {
    DeliveryNotConfiguredError,
    IdentityOtpService,
    OtpChallengeRow,
    OtpThrottledError,
} from '../security/identity-otp';
import { createNotification } from '../utils/notifications';
import { recordAudit, snapshotRow } from '../security/audit';

const router = Router();
const pool = getPool();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const publicMessage = 'إذا كانت البيانات صحيحة فسيظهر الطلب للمدرس للمراجعة.';
const MAX_ENROLLMENT_COURSES = 50;
const MAX_ENROLLMENT_ID_LENGTH = 128;
const MAX_ENROLLMENT_NAME_LENGTH = 255;
const MAX_REJECTION_REASON_LENGTH = 1000;

type BodyRecord = Record<string, unknown>;

interface TenantRow extends RowDataPacket {
    id: string;
    business_name: string;
    owner_user_id: string;
}

interface InviteRow extends RowDataPacket {
    id: string;
    tenant_id: string;
    instructor_id: string;
    expires_at: string | Date;
    business_name: string;
    subject_type: string | null;
}

interface EnrollmentRequestRow extends RowDataPacket {
    id: string;
    tenant_id: string;
    instructor_id: string;
    user_id: string | null;
    student_name: string;
    phone: string;
    guardian_name: string;
    guardian_phone: string;
    password_hash: string | null;
    grade_id: string;
    group_id: string;
    requested_courses: string | string[] | null;
    status: string;
}

interface JoinGroupRow extends RowDataPacket {
    id: string;
    name: string;
    grade_id: string | null;
    course_id: string | null;
}

interface IdRow extends RowDataPacket { id: string; }
interface NameRow extends RowDataPacket { id: string; name: string; }
interface ExistingStudentRow extends RowDataPacket { id: string; phone: string; }

export interface ValidEnrollmentRequestInput {
    studentName: string;
    guardianName: string;
    phone: string;
    guardianPhone: string;
    password: string;
    gradeId: string;
    groupId: string;
    requestedCourses: string[];
}

type EnrollmentRequestValidation =
    | { ok: true; value: ValidEnrollmentRequestInput }
    | { ok: false; error: string };

const asBodyRecord = (value: unknown): BodyRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as BodyRecord
        : {};

const boundedText = (value: unknown, maxLength: number): string | null => {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text.length > 0 && text.length <= maxLength ? text : null;
};

const validId = (value: unknown): string | null => boundedText(value, MAX_ENROLLMENT_ID_LENGTH);

export function validateEnrollmentRequestInput(body: unknown, passwordRequired: boolean): EnrollmentRequestValidation {
    const record = asBodyRecord(body);
    const studentName = boundedText(record['student_name'], MAX_ENROLLMENT_NAME_LENGTH);
    const guardianName = boundedText(record['guardian_name'], MAX_ENROLLMENT_NAME_LENGTH);
    const phone = typeof record['phone'] === 'string' ? normalizeEgyptianPhone(record['phone']) : null;
    const guardianPhone = typeof record['guardian_phone'] === 'string' ? normalizeEgyptianPhone(record['guardian_phone']) : null;
    const gradeId = validId(record['grade_id']);
    const groupId = validId(record['group_id']);
    const password = typeof record['password'] === 'string' ? record['password'] : '';
    const rawCourses = record['requested_courses'];
    const requestedCourses: string[] = [];

    if (!studentName || !guardianName || !phone || !guardianPhone || !gradeId || !groupId) {
        return { ok: false, error: 'All student, guardian, grade and group fields are required' };
    }
    if (passwordRequired && (password.length < 10 || password.length > 128)) {
        return { ok: false, error: 'Password must be between 10 and 128 characters' };
    }
    if (rawCourses !== undefined) {
        if (!Array.isArray(rawCourses) || rawCourses.length > MAX_ENROLLMENT_COURSES) {
            return { ok: false, error: 'Requested courses must contain at most 50 course IDs' };
        }
        for (const courseId of rawCourses) {
            const boundedId = validId(courseId);
            if (!boundedId) return { ok: false, error: 'Requested course IDs must be valid strings' };
            requestedCourses.push(boundedId);
        }
    }

    return {
        ok: true,
        value: {
            studentName,
            guardianName,
            phone,
            guardianPhone,
            password,
            gradeId,
            groupId,
            requestedCourses: Array.from(new Set(requestedCourses)),
        },
    };
}

export function validateEnrollmentRejectionReason(value: unknown): string | null {
    const reason = boundedText(value, MAX_REJECTION_REASON_LENGTH);
    return reason && reason.length >= 3 ? reason : null;
}

export function parseRequestedCourseIds(value: unknown): string[] | null {
    let parsed: unknown = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value) as unknown;
        } catch {
            return null;
        }
    }
    if (parsed === null || parsed === undefined) return [];
    if (!Array.isArray(parsed) || parsed.length > MAX_ENROLLMENT_COURSES) return null;
    const ids: string[] = [];
    for (const item of parsed) {
        const id = validId(item);
        if (!id) return null;
        ids.push(id);
    }
    return Array.from(new Set(ids));
}

async function instructorTenant(instructorId: string, tenantId: string) {
    return queryOne<TenantRow>(
        `SELECT t.id,t.business_name,t.owner_user_id FROM tenants t
         WHERE t.owner_user_id=? AND t.id=? AND t.status='active' LIMIT 1`, [instructorId, tenantId]
    );
}

async function validInvite(token: string) {
    if (!/^[0-9a-f]{64}$/i.test(token)) return null;
    return queryOne<InviteRow>(
        `SELECT i.id,i.tenant_id,i.instructor_id,i.expires_at,t.business_name,t.subject_type
         FROM student_enrollment_invites i INNER JOIN tenants t ON t.id=i.tenant_id
         WHERE i.token_hash=? AND i.revoked_at IS NULL AND i.expires_at>UTC_TIMESTAMP()
           AND t.status='active' AND t.owner_user_id=i.instructor_id LIMIT 1`, [digest(token)]
    );
}

// Instructor creates a new opaque 30-day join link and revokes older links.
router.post('/invites/rotate', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenantId = req.user.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
    const tenant = await instructorTenant(req.user.id, tenantId);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute(
            'UPDATE student_enrollment_invites SET revoked_at=UTC_TIMESTAMP() WHERE instructor_id=? AND tenant_id=? AND revoked_at IS NULL',
            [req.user.id, tenant.id]
        );
        await connection.execute(
            `INSERT INTO student_enrollment_invites (id,tenant_id,instructor_id,token_hash,expires_at)
             VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 DAY))`,
            [id, tenant.id, req.user.id, digest(token)]
        );
        await connection.execute(
            `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
             VALUES (?,?,?,?,?,?,?)`,
            [randomUUID(), req.user.id, tenant.id, 'student.invite.rotated', 'student_enrollment_invite', id, JSON.stringify({ expires_in_days: 30 })]
        );
        await connection.commit();
        res.status(201).json({ id, token, expires_in_days: 30 });
    } catch (error) {
        await connection.rollback();
        console.error('Rotate student invite error:', error);
        res.status(500).json({ error: 'Failed to create invitation' });
    } finally { connection.release(); }
});

router.get('/invites/current', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenantId = req.user.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
    const tenant = await instructorTenant(req.user.id, tenantId);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const invite = await queryOne<IdRow & { expires_at: string | Date; created_at: string | Date }>(
        `SELECT id,expires_at,created_at FROM student_enrollment_invites
         WHERE instructor_id=? AND tenant_id=? AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP()
         ORDER BY created_at DESC LIMIT 1`, [req.user.id, tenant.id]
    );
    res.json(invite || null);
});

// Safe public metadata. No phones, ids of users, counts, or inactive records.
router.get('/join/:token', rateLimit('student-join-view', 60, 15 * 60_000), async (req, res) => {
    const invite = await validInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation is invalid or expired' });
    const groups = await query<JoinGroupRow>(
        `SELECT g.id,g.name,g.grade_id,g.course_id FROM \`groups\` g
         WHERE g.instructor_id=? AND g.is_active=1
           AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=? AND t.owner_user_id=g.instructor_id AND t.status='active')
           AND ((g.course_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM courses c WHERE c.id=g.course_id AND c.tenant_id=? AND c.is_active=1
                )) OR (g.course_id IS NULL AND (
                    SELECT COUNT(*) FROM tenants t2 WHERE t2.owner_user_id=g.instructor_id AND t2.status='active'
                )=1))
         ORDER BY g.name LIMIT 250`, [invite.instructor_id, invite.tenant_id, invite.tenant_id]
    );
    const gradeIds = Array.from(new Set(groups.map(g => g.grade_id).filter((id): id is string => typeof id === 'string' && id.length > 0)));
    const courseIds = Array.from(new Set(groups.map(g => g.course_id).filter((id): id is string => typeof id === 'string' && id.length > 0)));
    const grades = gradeIds.length ? await query<NameRow>(
        `SELECT id,name FROM grades WHERE is_active=1 AND id IN (${gradeIds.map(() => '?').join(',')}) ORDER BY display_order`, gradeIds
    ) : [];
    const courses = courseIds.length ? await query<NameRow & { grade: string | null }>(
        `SELECT id,name,grade FROM courses WHERE tenant_id=? AND is_active=1 AND id IN (${courseIds.map(() => '?').join(',')}) ORDER BY name`,
        [invite.tenant_id, ...courseIds]
    ) : [];
    res.set('Cache-Control', 'no-store');
    res.json({ business_name: invite.business_name, subject_type: invite.subject_type, expires_at: invite.expires_at, grades, groups, courses });
});

// ---------------------------------------------------------------------------
// Contact verification (OTP) for the public join flow. No SMS/email/WhatsApp
// provider is approved yet, so delivery is deliberately null: issuance fails
// closed with 503 instead of mocking success or returning a code.
// ---------------------------------------------------------------------------
const otpServiceDeps = {
    insertChallenge: async (row: OtpChallengeRow) => {
        await execute(
            `INSERT INTO identity_otp_challenges
             (id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at,created_ip)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [row.id, row.contact_hash, row.purpose, row.tenant_id, row.identity_id, row.code_hash,
                row.attempts, row.max_attempts, row.resend_available_at, row.expires_at, row.consumed_at, row.submitted_at ?? null, row.created_ip]
        );
    },
    findChallengeById: async (id: string) => queryOne<OtpChallengeRow>(
        `SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at
         FROM identity_otp_challenges WHERE id=?`, [id]
    ),
    findLatestActiveChallenge: async (contactHash: string, purpose: string, tenantId: string | null) => queryOne<OtpChallengeRow>(
        `SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at
         FROM identity_otp_challenges
         WHERE contact_hash=? AND purpose=? AND (tenant_id <=> ?) AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP()
         ORDER BY created_at DESC LIMIT 1`,
        [contactHash, purpose, tenantId]
    ),
    incrementAttempts: async (id: string) => {
        await execute('UPDATE identity_otp_challenges SET attempts=attempts+1 WHERE id=?', [id]);
    },
    consumeChallenge: async (id: string, now: Date) => {
        const result = await execute(
            'UPDATE identity_otp_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL', [now, id]);
        return Number(result.affectedRows || 0);
    },
    consumeSubmission: async (id: string, now: Date) => {
        const result = await execute(
            'UPDATE identity_otp_challenges SET submitted_at=? WHERE id=? AND consumed_at IS NOT NULL AND submitted_at IS NULL', [now, id]);
        return Number(result.affectedRows || 0);
    },
    countRecentChallenges: async (contactHash: string, purpose: string, since: Date) => {
        const row = await queryOne<RowDataPacket & { total: number }>(
            'SELECT COUNT(*) AS total FROM identity_otp_challenges WHERE contact_hash=? AND purpose=? AND created_at>=?',
            [contactHash, purpose, since]
        );
        return Number(row?.total || 0);
    },
};

/**
 * Built lazily: the HMAC key comes from the runtime environment, and a
 * missing key must fail closed at request time (503) instead of throwing at
 * module load and taking the whole router down.
 */
export function getOtpService(): IdentityOtpService | null {
    const key = process.env.OTP_HMAC_SECRET;
    if (!key || Buffer.byteLength(key, 'utf8') < 32) return null;
    return new IdentityOtpService(otpServiceDeps, key, null);
}

router.post('/join/:token/contact-otp', rateLimit('student-join-otp', 5, 15 * 60_000), async (req, res) => {
    const invite = await validInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation is invalid or expired' });
    const service = getOtpService();
    if (!service) return res.status(503).json({ error: 'Contact verification is not available yet' });
    const body = asBodyRecord(req.body);
    const phone = typeof body.phone === 'string' ? normalizeEgyptianPhone(body.phone) : null;
    if (!phone) return res.status(400).json({ error: 'A valid phone number is required' });
    try {
        const issued = await service.issue({
            contact: phone,
            purpose: 'enrollment_join',
            tenantId: invite.tenant_id,
            ip: req.ip,
        });
        // The code itself is only handed to the delivery adapter; the HTTP
        // response never contains it.
        return res.status(202).json({
            challenge_id: issued.challengeId,
            expires_in: Math.max(0, Math.round((issued.expiresAt.getTime() - Date.now()) / 1000)),
            resend_in: Math.max(0, Math.round((issued.resendAvailableAt.getTime() - Date.now()) / 1000)),
        });
    } catch (error) {
        if (error instanceof DeliveryNotConfiguredError) {
            return res.status(503).json({ error: 'Contact verification is not available yet' });
        }
        if (error instanceof OtpThrottledError) {
            return res.status(429).json({ error: 'Please wait before requesting another code', retry_after: error.retryAfterSeconds });
        }
        throw error;
    }
});

router.post('/join/:token/contact-otp/verify', rateLimit('student-join-otp-verify', 12, 15 * 60_000), async (req, res) => {
    const invite = await validInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation is invalid or expired' });
    const service = getOtpService();
    if (!service) return res.status(503).json({ error: 'Contact verification is not available yet' });
    const body = asBodyRecord(req.body);
    const challengeId = typeof body.challenge_id === 'string' ? body.challenge_id.trim() : '';
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const phone = typeof body.phone === 'string' ? normalizeEgyptianPhone(body.phone) : null;
    if (!challengeId || !code || !phone) return res.status(400).json({ error: 'Verification input is invalid' });
    const result = await service.verify({
        challengeId,
        code,
        contact: phone,
        purpose: 'enrollment_join',
        tenantId: invite.tenant_id,
    });
    if (result.kind !== 'consumed') return res.status(400).json({ error: 'Verification failed' });
    return res.json({ verified: true });
});

router.post('/join/:token/requests', rateLimit('student-join-submit', 8, 60 * 60_000), optionalAuth, async (req: AuthRequest, res: Response) => {    const invite = await validInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invitation is invalid or expired' });
    if (req.user && req.user.role !== 'student') return res.status(403).json({ error: 'Only students can join an instructor' });
    const validated = validateEnrollmentRequestInput(req.body, !req.user);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const { studentName, guardianName, phone, guardianPhone, password, gradeId, groupId, requestedCourses } = validated.value;
    if (req.user?.role === 'student' && normalizeEgyptianPhone(req.user.phone) !== phone) {
        return res.status(400).json({ error: 'Use the phone number of the signed-in student account' });
    }
    // S2: a join request is only accepted after this contact was verified by a
    // consumed, purpose/tenant/contact-bound OTP challenge. The challenge id
    // is a reference, never proof: the consumed row is re-checked server-side.
    const otpChallengeValue = asBodyRecord(req.body)['otp_challenge_id'];
    const otpChallengeId = typeof otpChallengeValue === 'string' ? otpChallengeValue.trim() : '';
    if (!otpChallengeId) return res.status(403).json({ error: 'Contact verification required' });
    const otpService = getOtpService();
    const contactVerified = otpService ? await otpService.assertConsumed({
        challengeId: otpChallengeId,
        contact: phone,
        purpose: 'enrollment_join',
        tenantId: invite.tenant_id,
    }) : false;
    if (!contactVerified) return res.status(403).json({ error: 'Contact verification required' });
    const group = await queryOne<JoinGroupRow>(
        `SELECT g.id,g.grade_id,g.course_id FROM \`groups\` g
         WHERE g.id=? AND g.instructor_id=? AND g.is_active=1
           AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=? AND t.owner_user_id=g.instructor_id AND t.status='active')
           AND ((g.course_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM courses c WHERE c.id=g.course_id AND c.tenant_id=? AND c.is_active=1
                )) OR (g.course_id IS NULL AND (
                    SELECT COUNT(*) FROM tenants t2 WHERE t2.owner_user_id=g.instructor_id AND t2.status='active'
                )=1))`,
        [groupId, invite.instructor_id, invite.tenant_id, invite.tenant_id]
    );
    if (!group || String(group.grade_id || '') !== gradeId) return res.status(400).json({ error: 'Invalid grade or group' });

    const candidates = phoneLookupCandidates(phone);
    const placeholders = candidates.map(() => '?').join(',');
    const existing = candidates.length ? await queryOne<ExistingStudentRow>(
        `SELECT id,phone FROM users WHERE role='student' AND phone IN (${placeholders}) LIMIT 1`, candidates
    ) : null;
    if (existing && req.user?.id !== existing.id) {
        // Deliberately do not reveal that the supplied phone already exists.
        return res.status(202).json({ message: publicMessage });
    }
    const userId = existing?.id || (req.user?.role === 'student' ? req.user.id : null);
    if (userId) {
        const already = await queryOne<IdRow>(
            'SELECT id FROM students WHERE tenant_id=? AND user_id=? AND is_active=1', [invite.tenant_id, userId]
        );
        if (already) return res.status(202).json({ message: publicMessage });
    }
    const pending = await queryOne<IdRow>(
        `SELECT id FROM student_enrollment_requests WHERE tenant_id=? AND phone=? AND status='pending'`,
        [invite.tenant_id, phone]
    );
    if (pending) return res.status(202).json({ message: publicMessage });
    const passwordHash = userId ? null : await bcrypt.hash(password, 12);
    await execute(
        `INSERT INTO student_enrollment_requests
         (id,tenant_id,instructor_id,invite_id,user_id,student_name,phone,guardian_name,guardian_phone,password_hash,grade_id,group_id,requested_courses)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), invite.tenant_id, invite.instructor_id, invite.id, userId, studentName, phone, guardianName,
            guardianPhone, passwordHash, gradeId, groupId, JSON.stringify(requestedCourses)]
    );
    await createNotification({
        user_id: invite.instructor_id,
        user_type: 'instructor',
        title: 'طلب تسجيل طالب جديد',
        message: `أرسل ${studentName} طلب انضمام وينتظر موافقتك.`,
        type: 'general',
        link: '/instructor-students',
    });
    res.status(202).json({ message: publicMessage });
});

router.get('/requests', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenantId = req.user.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
    const tenant = await instructorTenant(req.user.id, tenantId);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const rows = await query<RowDataPacket & {
        id: string; student_name: string; phone: string; guardian_name: string; guardian_phone: string;
        grade_id: string; group_id: string; requested_courses: string; status: string;
        rejection_reason: string | null; created_at: string | Date; grade_name: string; group_name: string;
    }>(
        `SELECT r.id,r.student_name,r.phone,r.guardian_name,r.guardian_phone,r.grade_id,r.group_id,
                r.requested_courses,r.status,r.rejection_reason,r.created_at,g.name grade_name,grp.name group_name
         FROM student_enrollment_requests r
         INNER JOIN grades g ON g.id=r.grade_id
         INNER JOIN \`groups\` grp ON grp.id=r.group_id AND grp.instructor_id=r.instructor_id
         WHERE r.tenant_id=? AND r.instructor_id=?
         ORDER BY (r.status='pending') DESC,r.created_at DESC LIMIT 250`, [tenant.id, req.user.id]
    );
    res.json(rows);
});

router.post('/requests/:id/approve', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenantId = req.user.tenantId;
    const requestId = validId(req.params.id);
    if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
    if (!requestId) return res.status(404).json({ error: 'Pending request not found' });
    const tenant = await instructorTenant(req.user.id, tenantId);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute<RowDataPacket[]>(
            `SELECT id,tenant_id,instructor_id,user_id,student_name,phone,guardian_name,guardian_phone,password_hash,
                    grade_id,group_id,requested_courses,status
             FROM student_enrollment_requests
             WHERE id=? AND tenant_id=? AND instructor_id=? FOR UPDATE`,
            [requestId, tenant.id, req.user.id]
        );
        const request = rows[0] as EnrollmentRequestRow | undefined;
        if (!request) { await connection.rollback(); return res.status(404).json({ error: 'Pending request not found' }); }
        if (request.status === 'approved' && request.user_id) {
            const [approvedRows] = await connection.execute<RowDataPacket[]>(
                'SELECT id FROM students WHERE tenant_id=? AND user_id=? LIMIT 1 FOR UPDATE', [tenant.id, request.user_id]
            );
            const existingEnrollment = approvedRows[0] as IdRow | undefined;
            await connection.rollback();
            if (!existingEnrollment) return res.status(404).json({ error: 'Pending request not found' });
            return res.json({ status: 'approved', student_enrollment_id: existingEnrollment.id });
        }
        if (request.status !== 'pending') {
            await connection.rollback();
            return res.status(404).json({ error: 'Pending request not found' });
        }

        const body = asBodyRecord(req.body);
        const gradeId = body['grade_id'] === undefined ? request.grade_id : validId(body['grade_id']);
        const groupId = body['group_id'] === undefined ? request.group_id : validId(body['group_id']);
        const requestedCourses = body['requested_courses'] === undefined
            ? parseRequestedCourseIds(request.requested_courses)
            : parseRequestedCourseIds(body['requested_courses']);
        if (!gradeId || !groupId || !requestedCourses) {
            await connection.rollback();
            return res.status(400).json({ error: 'Invalid grade, group or requested courses' });
        }
        const [groups] = await connection.execute<RowDataPacket[]>(
            `SELECT grp.id,grp.grade_id FROM \`groups\` grp
             WHERE grp.id=? AND grp.instructor_id=? AND grp.is_active=1
               AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=? AND t.owner_user_id=grp.instructor_id AND t.status='active')
               AND ((grp.course_id IS NOT NULL AND EXISTS (
                        SELECT 1 FROM courses c WHERE c.id=grp.course_id AND c.tenant_id=? AND c.is_active=1
                    )) OR (grp.course_id IS NULL AND (
                        SELECT COUNT(*) FROM tenants t2 WHERE t2.owner_user_id=grp.instructor_id AND t2.status='active'
                    )=1))`,
            [groupId, req.user.id, tenant.id, tenant.id]
        );
        const group = groups[0] as (RowDataPacket & { id: string; grade_id: string | null }) | undefined;
        if (!group || String(group.grade_id || '') !== gradeId) {
            await connection.rollback(); return res.status(400).json({ error: 'Invalid grade or group' });
        }

        let userId = request.user_id;
        if (!userId) {
            const candidates = phoneLookupCandidates(request.phone);
            const [users] = await connection.execute<RowDataPacket[]>(
                `SELECT id FROM users WHERE role='student' AND phone IN (${candidates.map(() => '?').join(',')}) LIMIT 1 FOR UPDATE`, candidates
            );
            const existingUser = users[0] as IdRow | undefined;
            if (existingUser) userId = existingUser.id;
            else {
                userId = randomUUID();
                await connection.execute(
                    `INSERT INTO users (id,phone,password_hash,name,role,is_active,phone_verified) VALUES (?,?,?,?, 'student',1,0)`,
                    [userId, request.phone, request.password_hash, request.student_name]
                );
            }
        }
        const [existingRows] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM students WHERE tenant_id=? AND user_id=? LIMIT 1 FOR UPDATE', [tenant.id, userId]
        );
        const existingEnrollment = existingRows[0] as IdRow | undefined;
        if (existingEnrollment) {
            await connection.execute(
                `UPDATE student_enrollment_requests SET status='approved',user_id=?,password_hash=NULL,decided_by=?,decided_at=UTC_TIMESTAMP()
                 WHERE id=? AND tenant_id=? AND instructor_id=? AND status='pending'`,
                [userId, req.user.id, request.id, tenant.id, req.user.id]
            );
            await connection.commit();
            return res.json({ status: 'approved', student_enrollment_id: existingEnrollment.id });
        }

        const studentId = randomUUID();
        const barcode = `STU${randomBytes(12).toString('hex')}`.toUpperCase().slice(0, 25);
        await connection.execute(
            `INSERT INTO students
             (id,user_id,tenant_id,instructor_id,name,phone,guardian_name,guardian_phone,grade_id,group_id,barcode,password_hash,approval_status,is_offline,is_active)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'approved',0,1)`,
            [studentId, userId, tenant.id, req.user.id, request.student_name, request.phone, request.guardian_name,
                request.guardian_phone, gradeId, groupId, barcode, null]
        );
        for (const courseId of requestedCourses) {
            const [validCourses] = await connection.execute<RowDataPacket[]>(
                `SELECT c.id FROM courses c
                 INNER JOIN \`groups\` g ON g.course_id=c.id AND g.id=? AND g.instructor_id=? AND g.is_active=1
                 WHERE c.id=? AND c.tenant_id=? AND c.is_active=1 LIMIT 1`,
                [groupId, req.user.id, courseId, tenant.id]
            );
            if (validCourses[0]) await connection.execute(
                'INSERT IGNORE INTO student_courses (id,student_id,course_id) VALUES (?,?,?)', [randomUUID(), studentId, courseId]
            );
        }
        await connection.execute(
            `UPDATE student_enrollment_requests SET status='approved',user_id=?,password_hash=NULL,grade_id=?,group_id=?,decided_by=?,decided_at=UTC_TIMESTAMP()
             WHERE id=? AND tenant_id=? AND instructor_id=? AND status='pending'`,
            [userId, gradeId, groupId, req.user.id, request.id, tenant.id, req.user.id]
        );
        await connection.execute(
            `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
             VALUES (?,?,?,?,?,?,?)`,
            [randomUUID(), req.user.id, tenant.id, 'student.enrollment.approved', 'student', studentId, JSON.stringify({ user_id: userId, group_id: groupId })]
        );
        await connection.commit();
        res.json({ status: 'approved', student_enrollment_id: studentId });
    } catch (error) {
        await connection.rollback();
        console.error('Approve enrollment error:', error);
        res.status(500).json({ error: 'Failed to approve enrollment' });
    } finally { connection.release(); }
});

router.post('/requests/:id/reject', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenantId = req.user.tenantId;
    const requestId = validId(req.params.id);
    const reason = validateEnrollmentRejectionReason(asBodyRecord(req.body)['reason']);
    if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
    if (!requestId) return res.status(404).json({ error: 'Pending request not found' });
    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });
    const tenant = await instructorTenant(req.user.id, tenantId);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const result = await execute(
        `UPDATE student_enrollment_requests SET status='rejected',rejection_reason=?,password_hash=NULL,
         decided_by=?,decided_at=UTC_TIMESTAMP()
         WHERE id=? AND tenant_id=? AND instructor_id=? AND status='pending'`,
        [reason, req.user.id, requestId, tenant.id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Pending request not found' });
    await execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), req.user.id, tenant.id, 'student.enrollment.rejected', 'student_enrollment_request', requestId, JSON.stringify({ reason })]
    );
    res.json({ status: 'rejected' });
});

router.get('/spaces', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'student') return res.status(403).json({ error: 'Student access required' });
    const spaces = await query<RowDataPacket & {
        student_enrollment_id: string; tenant_id: string; business_name: string; grade_id: string | null;
        group_id: string | null; grade_name: string | null; group_name: string | null;
        branch_id: string | null; branch_scope: string | null;
    }>(
        `SELECT s.id student_enrollment_id,s.tenant_id,t.business_name,s.grade_id,s.group_id,
                g.name grade_name,grp.name group_name,grp.branch_id,grp.branch_scope
         FROM students s INNER JOIN tenants t ON t.id=s.tenant_id AND t.status='active'
         LEFT JOIN grades g ON g.id=s.grade_id
         LEFT JOIN \`groups\` grp ON grp.id=s.group_id AND grp.instructor_id=s.instructor_id
         WHERE s.user_id=? AND s.is_active=1 AND s.approval_status='approved' ORDER BY t.business_name`, [req.user.id]
    );
    res.json(spaces);
});

/**
 * Branch lookups for the workspace-select path. The injected shape keeps the
 * hermetic tests on the real handler; the router wiring below uses these
 * production lookups, which tolerate a pre-migration missing table exactly
 * like the staff token_version fallback (a missing table means "no branch
 * model yet"; any other database error propagates and fails closed).
 */
export const createBranchAccessDeps = (lookup: <T = any>(sql: string, params?: any[]) => Promise<T | null>) => ({
    findBranchById: async (branchId: string) => {
        try {
            return lookup<RowDataPacket & { id: string; tenant_id: string; status: string; version: number }>(
                'SELECT id, tenant_id, status, version FROM branches WHERE id = ?', [branchId]);
        } catch (error) {
            if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') return null;
            throw error;
        }
    },
    findMembership: async (branchId: string, userId: string) => {
        try {
            return lookup<RowDataPacket & { id: string; branch_id: string; user_id: string; role: string; status: string; version: number }>(
                'SELECT id, branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ?',
                [branchId, userId]);
        } catch (error) {
            if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') return null;
            throw error;
        }
    },
});

/**
 * Student workspace selection. Exported over an injected lookup so the real
 * issuance path (selected-enrollment/tenant/token-version claims and the
 * capped JWT lifetime) is exercised by hermetic tests through the same
 * handler the production route uses; the router below wires the real lookup.
 */
export const createStudentWorkspaceSelectHandler = (deps: {
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
    branchAccess?: {
        findBranchById(branchId: string): Promise<{ id: string; tenant_id: string; status: string; version: number } | null>;
        findMembership(branchId: string, userId: string): Promise<{ id: string; branch_id: string; user_id: string; role: string; status: string; version: number } | null>;
    };
}) =>
    async (req: AuthRequest, res: Response) => {
        if (req.user?.role !== 'student') return res.status(403).json({ error: 'Student access required' });
        const enrollmentId = validId(req.params.enrollmentId);
        if (!enrollmentId) return res.status(404).json({ error: 'Student workspace not found' });
        const enrollment = await deps.queryOne<RowDataPacket & {
            id: string; tenant_id: string; instructor_id: string; group_id: string | null; grade_id: string | null;
        }>(
            `SELECT s.id,s.tenant_id,s.instructor_id,s.group_id,s.grade_id FROM students s INNER JOIN tenants t ON t.id=s.tenant_id
             WHERE s.id=? AND s.user_id=? AND s.is_active=1 AND s.approval_status='approved' AND t.status='active'
               AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
               AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
               AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())`,
            [enrollmentId, req.user.id]
        );
        if (!enrollment) return res.status(404).json({ error: 'Student workspace not found' });
        // S1: when a branch selector is supplied it is validated against the
        // server-side branch model for THIS principal and tenant. The selector
        // is a request, never evidence of membership; denials use the same
        // generic response as an unknown workspace so nothing is enumerated.
        const branchDecision: BranchAccessDecision | { kind: 'no-branch-context' } = deps.branchAccess
            ? await resolveBranchAccess(
                {
                    findBranchById: deps.branchAccess.findBranchById,
                    findMembership: deps.branchAccess.findMembership,
                },
                {
                    principalUserId: req.user.id,
                    principalTenantId: enrollment.tenant_id,
                    branchId: (req.body ?? {}).branch_id,
                })
            : { kind: 'no-branch-context' };
        if (branchDecision.kind === 'denied' || branchDecision.kind === 'ambiguous') {
            return res.status(403).json({ error: 'Workspace not available' });
        }
        // A branch selector is only valid when the enrollment's own group is
        // branch-owned by that exact branch. A legacy/unassigned or tenant
        // group can never be turned into a branch context by a selector, and
        // a group in another branch is denied rather than silently accepted.
        if (branchDecision.kind === 'allowed' && branchDecision.branchId) {
            const group = enrollment.group_id
                ? await deps.queryOne<RowDataPacket & { branch_id: string | null; branch_scope: string | null }>(
                    'SELECT branch_id, branch_scope FROM `groups` WHERE id = ?',
                    [enrollment.group_id],
                )
                : null;
            if (!group || group.branch_scope !== 'branch' || group.branch_id !== branchDecision.branchId) {
                return res.status(403).json({ error: 'Workspace not available' });
            }
        }
        // Same capped validated lifetime resolver as every other issuance
        // path so a malformed or oversized JWT_EXPIRES_IN cannot mint an
        // effectively non-expiring student workspace session.
        const branchClaims = branchDecision.kind === 'allowed' && branchDecision.branchId
            ? {
                branch_id: branchDecision.branchId,
                branch_membership_version: Number(branchDecision.membershipVersion ?? 0),
            }
            : {};
        const token = jwt.sign({ id: req.user.id, email: req.user.email, phone: req.user.phone, role: 'student',
            tenant_id: enrollment.tenant_id, student_enrollment_id: enrollment.id, instructor_id: enrollment.instructor_id,
            group_id: enrollment.group_id, grade_id: enrollment.grade_id,
            tv: Number(req.user.tokenVersion || 0),
            // Carry only the authenticated server principal session, never request data.
            ...(req.user.sessionId ? { sid: req.user.sessionId } : {}),
            ...branchClaims,
            type: 'student_scoped' }, getJwtSecret(),
            { expiresIn: resolveJwtLifetimeSeconds(process.env.JWT_EXPIRES_IN) } as jwt.SignOptions);
        res.json({ token, tenant_id: enrollment.tenant_id, student_enrollment_id: enrollment.id,
            branch_id: branchDecision.kind === 'allowed' ? branchDecision.branchId : null });
    };

router.post('/spaces/:enrollmentId/select', authenticateToken,
    createStudentWorkspaceSelectHandler({ queryOne, branchAccess: createBranchAccessDeps(queryOne) }));

/**
 * C8/C10 enrollment lifecycle mutation (term/month association, explicit
 * start/end dates, revoke/reactivate). The server clock is the only authority on
 * dates and status; every client-supplied amount/price/paymentstatus/date is
 * ignored by construction, so no payment field can ever grant paid access.
 * Mutations are audited with before/after. Exported over injected deps so the
 * real handler runs under hermetic tests through the same router.
 */
export interface EnrollmentLifecycleDeps {
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
    execute: (sql: string, params?: any[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    transaction?: <T>(fn: (tx: EnrollmentLifecycleDeps) => Promise<T>) => Promise<T>;
    /**
     * Server-side workspace resolver for the calling instructor. Injected so the
     * real handler runs hermetically under tests; production falls back to the
     * module-level `instructorTenant` (real DB). Never trusts a client claim.
     */
    resolveTenant?: (instructorId: string, tenantId: string) => Promise<{ id: string; business_name: string; owner_user_id: string } | null>;
}

const ENROLLMENT_STATUSES = new Set(['active', 'revoked', 'expired']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

/** Normalize a validated/stored enrollment date to `YYYY-MM-DD HH:MM:SS`. */
function comparableEnrollmentDate(value: string | Date | null): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        return Number.isFinite(value.getTime())
            ? value.toISOString().slice(0, 19).replace('T', ' ')
            : null;
    }
    const text = value.trim();
    if (!text) return null;
    if (text.length === 10) return `${text} 00:00:00`;
    return text.replace('T', ' ').slice(0, 19);
}

/**
 * The stored window is half-open `[start, end)`. A partial update is merged
 * with the stored row before writing, so the *merged* pair — not only the
 * request payload — must be checked: otherwise a single-field update can
 * produce `start >= end`, which no read predicate can ever satisfy.
 */
export function enrollmentWindowIsValid(
    start: string | Date | null,
    end: string | Date | null,
): boolean {
    const normalizedStart = comparableEnrollmentDate(start);
    const normalizedEnd = comparableEnrollmentDate(end);
    if (normalizedStart === null || normalizedEnd === null) return true;
    return normalizedStart < normalizedEnd;
}

export function validateEnrollmentLifecycleInput(body: unknown): {
    ok: true; value: { term: string | null; startDate: string | null; endDate: string | null; status: string | null };
} | { ok: false; error: string } {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const term = typeof record['term'] === 'string' ? record['term'].trim() : '';
    const startDate = typeof record['enrollment_start_date'] === 'string' ? record['enrollment_start_date'] : null;
    const endDate = typeof record['enrollment_end_date'] === 'string' ? record['enrollment_end_date'] : null;
    const status = typeof record['enrollment_status'] === 'string' ? record['enrollment_status'] : null;
    if (term.length > 60) return { ok: false, error: 'Term must be at most 60 characters' };
    if (status && !ENROLLMENT_STATUSES.has(status)) {
        return { ok: false, error: 'enrollment_status must be active, revoked or expired' };
    }
    for (const [label, value] of [['enrollment_start_date', startDate], ['enrollment_end_date', endDate]] as const) {
        if (value !== null && !ISO_DATE.test(value)) {
            return { ok: false, error: `${label} must be an ISO date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)` };
        }
        if (value !== null) {
            const utc = new Date(value.length === 10 ? `${value}T00:00:00Z` : `${value.replace(' ', 'T')}Z`);
            if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value.slice(0, 10)) {
                return { ok: false, error: `${label} must be a valid UTC calendar date` };
            }
        }
    }
    if (startDate && endDate && startDate >= endDate) {
        return { ok: false, error: 'Enrollment date window must have a start before its exclusive end' };
    }
    return { ok: true, value: { term: term || null, startDate, endDate, status } };
}

export const createEnrollmentLifecycleHandler = (deps: EnrollmentLifecycleDeps) => {
    const runAtomic = deps.transaction
        ? (deps.transaction as <R>(fn: (tx: EnrollmentLifecycleDeps) => Promise<R>) => Promise<R>)
        : (<R>(fn: (tx: EnrollmentLifecycleDeps) => Promise<R>): Promise<R> => fn(deps));
    return async (req: AuthRequest, res: Response) => {
        if (!req.user || req.user.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
        const user = req.user;
        const tenantId = user.tenantId;
        const studentId = validId(req.params.id);
        if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
        if (!studentId) return res.status(404).json({ error: 'Enrollment not found' });
        const resolveTenant = deps.resolveTenant ?? instructorTenant;
        const tenant = await resolveTenant(user.id, tenantId);
        if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
        const validated = validateEnrollmentLifecycleInput(req.body);
        if (!validated.ok) return res.status(400).json({ error: validated.error });
        try {
            const result = await runAtomic(async (tx) => {
                const existing = await tx.queryOne<{
                    id: string; tenant_id: string; instructor_id: string; approval_status: string;
                    enrollment_status: string | null; term: string | null;
                    enrollment_start_date: string | null; enrollment_end_date: string | null;
                }>(
                    `SELECT id,tenant_id,instructor_id,approval_status,enrollment_status,term,enrollment_start_date,enrollment_end_date
                     FROM students WHERE id=? AND tenant_id=? AND instructor_id=? FOR UPDATE`,
                    [studentId, tenant.id, user.id]
                );
                if (!existing) return { notFound: true as const };
                const newStatus = validated.value.status ?? existing.enrollment_status;
                const newValue = {
                    term: validated.value.term ?? existing.term,
                    enrollment_start_date: validated.value.startDate ?? existing.enrollment_start_date,
                    enrollment_end_date: validated.value.endDate ?? existing.enrollment_end_date,
                    enrollment_status: newStatus,
                };
                // Validate the EFFECTIVE window after merging the partial update
                // with the stored row. Rejecting here (before the UPDATE and the
                // audit) keeps an inverted [start,end) window from ever being
                // persisted, which would make the enrollment permanently
                // ineffective while looking "active".
                if (!enrollmentWindowIsValid(newValue.enrollment_start_date, newValue.enrollment_end_date)) {
                    return { invalidWindow: true as const };
                }
                await tx.execute(
                    `UPDATE students
                     SET term=COALESCE(?, term),
                         enrollment_start_date=COALESCE(?, enrollment_start_date),
                         enrollment_end_date=COALESCE(?, enrollment_end_date),
                         enrollment_status=COALESCE(?, enrollment_status)
                     WHERE id=? AND tenant_id=? AND instructor_id=?`,
                    [validated.value.term, validated.value.startDate, validated.value.endDate, newStatus, studentId, tenant.id, user.id]
                );
                await recordAudit(tx.execute, {
                    actorUserId: user.id,
                    tenantId: tenant.id,
                    action: 'enrollment.lifecycle',
                    resourceType: 'student',
                    resourceId: studentId,
                    oldValue: snapshotRow(existing),
                    newValue: snapshotRow(newValue),
                });
                return { notFound: false as const, newStatus };
            });
            if ('invalidWindow' in result) {
                return res.status(400).json({ error: 'Enrollment date window must have a start before its exclusive end' });
            }
            if (result.notFound) return res.status(404).json({ error: 'Enrollment not found' });
            res.json({ status: 'ok', enrollment_status: result.newStatus });
        } catch (error) {
            console.error('Enrollment lifecycle error:', error);
            res.status(500).json({ error: 'Failed to update enrollment' });
        }
    };
};

const realEnrollmentTransaction = async <T>(fn: (tx: EnrollmentLifecycleDeps) => Promise<T>): Promise<T> => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const tx: EnrollmentLifecycleDeps = {
            queryOne: <T = any>(sql: string, params?: any[]): Promise<T | null> =>
                (connection.query as unknown as (s: string, p?: any[]) => Promise<[any[], any]>)(
                    sql, params,
                ).then(([rows]) => (rows as T[])[0] ?? null),
            execute: (sql: string, params?: any[]) =>
                (connection.execute as unknown as (s: string, p?: any[]) => Promise<[any, any]>)(
                    sql, params,
                ).then(([header]) => {
                    const h = header as { insertId?: number; affectedRows?: number };
                    return { insertId: h.insertId ?? 0, affectedRows: h.affectedRows ?? 0 };
                }),
        };
        const result = await fn(tx);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

router.put('/:id/lifecycle', authenticateToken,
    createEnrollmentLifecycleHandler({ queryOne, execute, transaction: realEnrollmentTransaction }));

// Privacy-preserving reset request, routed by the instructor's invite token.
router.post('/join/:token/password-reset', rateLimit('student-password-reset', 5, 60 * 60_000), async (req, res) => {
    const invite = await validInvite(req.params.token);
    const phoneValue = asBodyRecord(req.body)['phone'];
    const phone = typeof phoneValue === 'string' ? normalizeEgyptianPhone(phoneValue) : null;
    if (invite && phone) {
        const candidates = phoneLookupCandidates(phone);
        const enrollment = await queryOne<RowDataPacket & { id: string; user_id: string }>(
            `SELECT s.id,s.user_id FROM students s
             INNER JOIN tenants t ON t.id=s.tenant_id AND t.status='active'
             WHERE s.tenant_id=? AND s.phone IN (${candidates.map(() => '?').join(',')})
               AND s.is_active=1 AND s.approval_status='approved' LIMIT 1`, [invite.tenant_id, ...candidates]
        );
        if (enrollment) {
            const pending = await queryOne<IdRow>(
                `SELECT id FROM student_password_reset_requests WHERE tenant_id=? AND user_id=? AND status='pending'`,
                [invite.tenant_id, enrollment.user_id]
            );
            if (!pending) await execute(
                `INSERT INTO student_password_reset_requests (id,tenant_id,user_id,student_enrollment_id) VALUES (?,?,?,?)`,
                [randomUUID(), invite.tenant_id, enrollment.user_id, enrollment.id]
            );
        }
    }
    res.status(202).json({ message: 'إذا كان الحساب موجودًا فسيصل طلب الاسترجاع إلى المدرس.' });
});

router.get('/password-resets', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenantId = req.user.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
    const tenant = await instructorTenant(req.user.id, tenantId);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const rows = await query<RowDataPacket & {
        id: string; status: string; created_at: string | Date; name: string; phone: string;
    }>(
        `SELECT r.id,r.status,r.created_at,s.name,s.phone FROM student_password_reset_requests r
         INNER JOIN students s ON s.id=r.student_enrollment_id AND s.tenant_id=r.tenant_id AND s.user_id=r.user_id
         WHERE r.tenant_id=? ORDER BY r.created_at DESC LIMIT 100`, [tenant.id]
    );
    res.json(rows);
});

router.post('/password-resets/:id/approve', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'instructor') return res.status(403).json({ error: 'Instructor access required' });
    const tenantId = req.user.tenantId;
    const requestId = validId(req.params.id);
    if (!tenantId) return res.status(403).json({ error: 'An active tenant membership is required' });
    if (!requestId) return res.status(404).json({ error: 'Pending reset request not found' });
    const tenant = await instructorTenant(req.user.id, tenantId);
    if (!tenant) return res.status(409).json({ error: 'Active instructor workspace required' });
    const rawToken = randomBytes(32).toString('hex');
    const result = await execute(
        `UPDATE student_password_reset_requests SET status='approved',reset_token_hash=?,reset_expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE),
         decided_by=?,decided_at=UTC_TIMESTAMP()
         WHERE id=? AND tenant_id=? AND status='pending'
           AND EXISTS (SELECT 1 FROM students s WHERE s.id=student_password_reset_requests.student_enrollment_id
             AND s.tenant_id=student_password_reset_requests.tenant_id AND s.user_id=student_password_reset_requests.user_id AND s.is_active=1)`,
        [digest(rawToken), req.user.id, requestId, tenant.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Pending reset request not found' });
    await execute(
        `INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,new_value)
         VALUES (?,?,?,?,?,?,?)`,
        [randomUUID(), req.user.id, tenant.id, 'student.password_reset.approved', 'student_password_reset_request', requestId, JSON.stringify({ expires_in_minutes: 15 })]
    );
    res.json({ reset_token: rawToken, expires_in_minutes: 15 });
});

router.post('/password-resets/complete', rateLimit('student-password-complete', 8, 60 * 60_000), async (req, res) => {
    const body = asBodyRecord(req.body);
    const token = typeof body['token'] === 'string' ? body['token'].trim() : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    if (!/^[0-9a-f]{64}$/i.test(token) || password.length < 10 || password.length > 128) {
        return res.status(400).json({ error: 'Invalid reset data' });
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [rows] = await connection.execute<RowDataPacket[]>(
            `SELECT r.id,r.user_id,r.tenant_id FROM student_password_reset_requests r
             INNER JOIN tenants t ON t.id=r.tenant_id AND t.status='active'
             INNER JOIN students s ON s.id=r.student_enrollment_id AND s.tenant_id=r.tenant_id AND s.user_id=r.user_id AND s.is_active=1
             WHERE r.reset_token_hash=? AND r.status='approved' AND r.reset_expires_at>UTC_TIMESTAMP() FOR UPDATE`,
            [digest(token)]
        );
        const reset = rows[0] as (RowDataPacket & { id: string; user_id: string; tenant_id: string }) | undefined;
        if (!reset) { await connection.rollback(); return res.status(400).json({ error: 'Reset code is invalid or expired' }); }
        const hash = await bcrypt.hash(password, 12);
        const [userUpdate] = await connection.execute(
            'UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=?', [hash, reset.user_id]
        );
        if ((userUpdate as { affectedRows: number }).affectedRows !== 1) {
            await connection.rollback();
            return res.status(400).json({ error: 'Reset code is invalid or expired' });
        }
        const [resetUpdate] = await connection.execute(
            `UPDATE student_password_reset_requests SET status='used',reset_token_hash=NULL,used_at=UTC_TIMESTAMP()
             WHERE id=? AND tenant_id=? AND user_id=? AND status='approved' AND reset_token_hash=?`,
            [reset.id, reset.tenant_id, reset.user_id, digest(token)]
        );
        if ((resetUpdate as { affectedRows: number }).affectedRows !== 1) {
            await connection.rollback();
            return res.status(400).json({ error: 'Reset code is invalid or expired' });
        }
        await connection.commit();
        res.json({ success: true });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: 'Failed to reset password' });
    } finally { connection.release(); }
});

// Platform-support review queue for legacy rows that could not be linked safely.
router.get('/backfill-reviews', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Platform admin access required' });
    try {
        if (!await isSuperAdmin(req.user.id)) return res.status(403).json({ error: 'Platform admin access required' });
    } catch {
        return res.status(503).json({ error: 'Platform admin authorization unavailable' });
    }
    const rows = await query<RowDataPacket & {
        id: string; student_id: string; reason: string; status: string; created_at: string | Date;
        name: string; phone: string; user_id: string | null; tenant_id: string; instructor_id: string; group_id: string | null;
    }>(
        `SELECT r.id,r.student_id,r.reason,r.status,r.created_at,s.name,s.phone,s.user_id,s.tenant_id,s.instructor_id,s.group_id
         FROM student_enrollment_backfill_reviews r INNER JOIN students s ON s.id=r.student_id
         WHERE r.status='pending' ORDER BY r.created_at LIMIT 250`
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows);
});

router.post('/backfill-reviews/:id/resolve', authenticateToken, async (req: AuthRequest, res: Response) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Platform admin access required' });
    try {
        if (!await isSuperAdmin(req.user.id)) return res.status(403).json({ error: 'Platform admin access required' });
    } catch {
        return res.status(503).json({ error: 'Platform admin authorization unavailable' });
    }
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Review not found' });
    return res.status(410).json({ error: 'Legacy identity assignment is disabled until a server-side adjudication workflow is available' });
});

export async function cleanupEnrollmentPrivacyData(): Promise<void> {
    await execute(`UPDATE student_enrollment_requests SET status='expired',password_hash=NULL
                   WHERE status='pending' AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)`);
    await execute(`DELETE FROM student_enrollment_requests WHERE status IN ('rejected','expired')
                   AND updated_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)`);
    await execute(`UPDATE student_password_reset_requests SET status='expired',reset_token_hash=NULL
                   WHERE status IN ('pending','approved') AND created_at<DATE_SUB(UTC_TIMESTAMP(),INTERVAL 30 DAY)`);
}

export default router;
