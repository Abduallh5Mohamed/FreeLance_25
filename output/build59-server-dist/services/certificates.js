"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVerificationId = exports.generateVerifyId = exports.eligibleForCertificate = exports.checkEligibility = exports.DEFAULT_ELIGIBILITY_THRESHOLD = exports.MIN_ELIGIBILITY_SCORE = exports.CERTIFICATE_STATUSES = void 0;
exports.isEligibleForCertificate = isEligibleForCertificate;
exports.evaluateCertificateEligibility = evaluateCertificateEligibility;
exports.generateVerificationId = generateVerificationId;
exports.generateVerificationCode = generateVerificationCode;
exports.generateCertificateId = generateCertificateId;
exports.isRevoked = isRevoked;
exports.canVerifyPublic = canVerifyPublic;
exports.publicCertificateFacts = publicCertificateFacts;
/**
 * M4 A8 — certificates domain policy.
 */
const crypto_1 = require("crypto");
exports.CERTIFICATE_STATUSES = ['issued', 'revoked'];
exports.MIN_ELIGIBILITY_SCORE = 0;
exports.DEFAULT_ELIGIBILITY_THRESHOLD = 70;
function isEligibleForCertificate(input) {
    const threshold = input.threshold ?? input.passingScore ?? exports.DEFAULT_ELIGIBILITY_THRESHOLD;
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
function evaluateCertificateEligibility(input) {
    const reasons = [];
    const threshold = input.threshold ?? input.passingScore ?? exports.DEFAULT_ELIGIBILITY_THRESHOLD;
    if (input.finalScore !== null && input.finalScore !== undefined) {
        if (!Number.isFinite(input.finalScore) || input.finalScore < threshold)
            reasons.push('score_below_threshold');
    }
    if ((input.totalLessons ?? 0) > 0 && (input.completedLessons ?? 0) < (input.totalLessons ?? 0))
        reasons.push('lessons_incomplete');
    if (input.allAssignmentsSubmitted === false)
        reasons.push('assignments_incomplete');
    if (input.allExamsPassed === false)
        reasons.push('exams_not_passed');
    return { eligible: reasons.length === 0, reasons };
}
function generateVerificationId(bytes = 32) {
    return (0, crypto_1.randomBytes)(bytes).toString('hex');
}
function generateVerificationCode() {
    return generateVerificationId(16);
}
function generateCertificateId() {
    return generateVerificationId(16);
}
function isRevoked(status, revokedAt) {
    return status === 'revoked' || revokedAt !== null && revokedAt !== undefined;
}
function canVerifyPublic(certificate) {
    return true;
}
function publicCertificateFacts(cert) {
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
        // The raw numeric score is an internal academic record and is never
        // projected to an anonymous verifier. The key is retained (always null)
        // so the public response shape stays stable for existing clients.
        final_score: null,
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
exports.checkEligibility = isEligibleForCertificate;
exports.eligibleForCertificate = isEligibleForCertificate;
exports.generateVerifyId = generateVerificationId;
exports.createVerificationId = generateVerificationId;
