/**
 * M4 A8 — certificates domain policy.
 */
import { randomBytes } from 'crypto';

export const CERTIFICATE_STATUSES = ['issued', 'revoked'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const MIN_ELIGIBILITY_SCORE = 0;
export const DEFAULT_ELIGIBILITY_THRESHOLD = 70;

export interface CertificateEligibilityInput {
    completedLessons?: number;
    totalLessons?: number;
    finalScore?: number | null;
    passingScore?: number | null;
    threshold?: number;
    allAssignmentsSubmitted?: boolean;
    allExamsPassed?: boolean;
}

export function isEligibleForCertificate(input: CertificateEligibilityInput): boolean {
    const threshold = input.threshold ?? input.passingScore ?? DEFAULT_ELIGIBILITY_THRESHOLD;
    const scoreOk = input.finalScore === null || input.finalScore === undefined
        ? true
        : (Number.isFinite(input.finalScore) && input.finalScore >= threshold);
    const lessonsOk = (input.totalLessons ?? 0) <= 0
        ? true
        : (input.completedLessons ?? 0) >= (input.totalLessons ?? 0);
    const assignmentsOk = input.allAssignmentsSubmitted === undefined ? true : input.allAssignmentsSubmitted;
    const examsOk = input.allExamsPassed === undefined ? true : input.allExamsPassed;
    return scoreOk && lessonsOk && assignmentsOk && examsOk;
}

export function evaluateCertificateEligibility(input: CertificateEligibilityInput): { eligible: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const threshold = input.threshold ?? input.passingScore ?? DEFAULT_ELIGIBILITY_THRESHOLD;
    if (input.finalScore !== null && input.finalScore !== undefined) {
        if (!Number.isFinite(input.finalScore) || input.finalScore < threshold) reasons.push('score_below_threshold');
    }
    if ((input.totalLessons ?? 0) > 0 && (input.completedLessons ?? 0) < (input.totalLessons ?? 0)) reasons.push('lessons_incomplete');
    if (input.allAssignmentsSubmitted === false) reasons.push('assignments_incomplete');
    if (input.allExamsPassed === false) reasons.push('exams_not_passed');
    return { eligible: reasons.length === 0, reasons };
}

export function generateVerificationId(bytes: number = 32): string {
    return randomBytes(bytes).toString('hex');
}

export function generateVerificationCode(): string {
    return generateVerificationId(16);
}

export function generateCertificateId(): string {
    return generateVerificationId(16);
}

export function isRevoked(status: string, revokedAt?: unknown): boolean {
    return status === 'revoked' || revokedAt !== null && revokedAt !== undefined;
}

export function canVerifyPublic(certificate: { status: string }): boolean {
    return true;
}

export interface PublicCertificateBranding {
    logoUrl?: string | null;
    primaryColor?: string | null;
    secondaryColor?: string | null;
    accentColor?: string | null;
    locale?: string | null;
}

export function publicCertificateFacts(cert: {
    verificationId: string;
    status: string;
    issuedAt: string | Date;
    courseName?: string | null;
    studentName?: string | null;
    tenantName?: string | null;
    finalScore?: number | null;
    branding?: PublicCertificateBranding | null;
}): Record<string, unknown> {
    // The public projection is deliberately minimal: the verification id, the
    // lifecycle status, when it was issued, the course/tenant display names and
    // the tenant branding needed to render it. Internal ids, enrollment ids and
    // issuer identities are never exposed.
    return {
        verification_id: cert.verificationId,
        status: cert.status,
        issued_at: cert.issuedAt instanceof Date ? cert.issuedAt.toISOString() : cert.issuedAt,
        course: cert.courseName ?? null,
        student: cert.studentName ?? null,
        tenant: cert.tenantName ?? null,
        final_score: cert.finalScore ?? null,
        branding: cert.branding ? {
            logo_url: cert.branding.logoUrl ?? null,
            primary_color: cert.branding.primaryColor ?? null,
            secondary_color: cert.branding.secondaryColor ?? null,
            accent_color: cert.branding.accentColor ?? null,
            locale: cert.branding.locale ?? null,
        } : null,
    };
}

// Aliases
export const checkEligibility = isEligibleForCertificate;
export const eligibleForCertificate = isEligibleForCertificate;
export const generateVerifyId = generateVerificationId;
export const createVerificationId = generateVerificationId;