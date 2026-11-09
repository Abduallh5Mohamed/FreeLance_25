"use strict";
/**
 * M4 A3 — deterministic MCQ auto-grading policy.
 *
 * Pure, deterministic, I/O-free. This module turns a snapshot question set plus
 * a student's answers into an immutable per-question award. It never reads a
 * request, a clock, a database or an environment variable, so the same input
 * always produces the exact same result (the regrade idempotency guarantee).
 *
 * Scoring contract (documented for operators):
 *  - Every point value is a non-negative decimal with at most two decimals
 *    (`DECIMAL(6,2)`); all arithmetic is performed on INTEGER hundredths so
 *    floating point drift can never change a grade.
 *  - `single_choice` / `true_false` are all-or-nothing: an exact answer earns
 *    the full question points, a blank answer earns 0, and a wrong answer earns
 *    0 unless negative marking is enabled.
 *  - `multiple_choice` is all-or-nothing by default; with `partialCredit` the
 *    award is `points * (correctSelected - wrongSelected) / totalCorrect`,
 *    floored to hundredths and clamped to `[0, points]`.
 *  - `negativeMarking` (optional) deducts `round(points * negativeFraction)`
 *    from a fully wrong answer. It only applies when `partialCredit` is off, so
 *    a partially correct multi-select answer is never penalised below 0.
 *  - `essay` is never machine-graded: it is reported as `autoGraded: false` and
 *    forces the attempt into the `pending_review` manual-grading queue.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SCORING_POLICY = exports.GRADING_POLICY_VERSION = void 0;
exports.toHundredths = toHundredths;
exports.formatHundredths = formatHundredths;
exports.normalizeScoringPolicy = normalizeScoringPolicy;
exports.gradeAttempt = gradeAttempt;
exports.computeGradingFingerprint = computeGradingFingerprint;
exports.shouldApplyRegrade = shouldApplyRegrade;
exports.normalizeAnswerMap = normalizeAnswerMap;
const crypto_1 = require("crypto");
exports.GRADING_POLICY_VERSION = 1;
exports.DEFAULT_SCORING_POLICY = Object.freeze({
    negativeMarking: false,
    negativeFraction: 0,
    partialCredit: false,
});
const OBJECTIVE_KINDS = ['single_choice', 'multiple_choice', 'true_false'];
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Convert a point value (number or decimal string) to integer hundredths. Only
 * non-negative values with at most two decimals are accepted; anything else
 * (NaN, Infinity, negatives, three-decimal values) returns null so callers can
 * fail closed instead of storing a corrupted grade.
 */
function toHundredths(value) {
    if (typeof value !== 'number' && typeof value !== 'string')
        return null;
    if (typeof value === 'string') {
        if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))
            return null;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0)
        return null;
    const scaled = Math.round(numeric * 100);
    if (!Number.isSafeInteger(scaled) || Math.abs(numeric * 100 - scaled) > 1e-7)
        return null;
    return scaled;
}
/** Render integer hundredths back to a canonical two-decimal string. */
function formatHundredths(value) {
    const sign = value < 0 ? '-' : '';
    const magnitude = Math.abs(Math.round(value));
    return `${sign}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`;
}
/**
 * Normalize a scoring policy. An absent value yields the safe default (no
 * negative marking, no partial credit). An explicit but malformed policy is
 * rejected so a typo can never silently change a weighting.
 */
function normalizeScoringPolicy(value) {
    if (value === undefined || value === null || value === '')
        return { ...exports.DEFAULT_SCORING_POLICY };
    if (!isRecord(value))
        return null;
    const negativeMarkingRaw = value['negativeMarking'] ?? value['negative_marking'];
    const negativeFractionRaw = value['negativeFraction'] ?? value['negative_fraction'];
    const partialRaw = value['partialCredit'] ?? value['partial_credit'];
    let negativeMarking = false;
    if (negativeMarkingRaw !== undefined && negativeMarkingRaw !== null) {
        if (typeof negativeMarkingRaw !== 'boolean')
            return null;
        negativeMarking = negativeMarkingRaw;
    }
    let negativeFraction = 0;
    if (negativeFractionRaw !== undefined && negativeFractionRaw !== null && negativeFractionRaw !== '') {
        const parsed = typeof negativeFractionRaw === 'number' ? negativeFractionRaw : Number(negativeFractionRaw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1)
            return null;
        const scaled = Math.round(parsed * 100);
        if (Math.abs(parsed * 100 - scaled) > 1e-7)
            return null;
        negativeFraction = scaled / 100;
    }
    if (negativeMarking && negativeFraction <= 0)
        return null;
    let partialCredit = false;
    if (partialRaw !== undefined && partialRaw !== null) {
        if (typeof partialRaw !== 'boolean')
            return null;
        partialCredit = partialRaw;
    }
    return { negativeMarking, negativeFraction, partialCredit };
}
function normalizeSingleAnswer(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Number.isInteger(value) ? String(value) : String(value);
    }
    if (typeof value === 'boolean')
        return String(value);
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed.toLowerCase();
    }
    return null;
}
function normalizeMultiAnswer(value) {
    const entries = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
    const normalized = [];
    for (const entry of entries) {
        const single = normalizeSingleAnswer(entry);
        if (single === null)
            return null;
        if (!normalized.includes(single))
            normalized.push(single);
    }
    return normalized;
}
function equalSet(a, b) {
    if (a.length !== b.length)
        return false;
    return a.every((entry) => b.includes(entry));
}
function penaltyHundredths(pointsHundredths, policy) {
    return Math.min(pointsHundredths, Math.round(pointsHundredths * policy.negativeFraction));
}
function gradeQuestion(question, response, policy) {
    const ref = question.ref;
    if (question.questionType === 'essay') {
        return { ref, awardedHundredths: null, isCorrect: null, autoGraded: false };
    }
    if (!OBJECTIVE_KINDS.includes(question.questionType)) {
        // An unknown kind can never be auto-graded safely; route to manual review.
        return { ref, awardedHundredths: null, isCorrect: null, autoGraded: false };
    }
    const pointsHundredths = toHundredths(question.points);
    if (pointsHundredths === null) {
        return { ref, awardedHundredths: null, isCorrect: null, autoGraded: false };
    }
    const correctAnswers = question.correctAnswers
        .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
        .filter((entry) => entry !== '');
    if (question.questionType === 'multiple_choice') {
        const chosen = normalizeMultiAnswer(response);
        if (chosen === null || chosen.length === 0) {
            return { ref, awardedHundredths: 0, isCorrect: false, autoGraded: true };
        }
        if (equalSet(chosen, correctAnswers)) {
            return { ref, awardedHundredths: pointsHundredths, isCorrect: true, autoGraded: true };
        }
        if (policy.partialCredit && correctAnswers.length > 0) {
            const correctSelected = chosen.filter((entry) => correctAnswers.includes(entry)).length;
            const wrongSelected = chosen.length - correctSelected;
            const raw = Math.floor((pointsHundredths * (correctSelected - wrongSelected)) / correctAnswers.length);
            const clamped = Math.max(0, Math.min(pointsHundredths, raw));
            return { ref, awardedHundredths: clamped, isCorrect: false, autoGraded: true };
        }
        if (policy.negativeMarking) {
            return { ref, awardedHundredths: -penaltyHundredths(pointsHundredths, policy), isCorrect: false, autoGraded: true };
        }
        return { ref, awardedHundredths: 0, isCorrect: false, autoGraded: true };
    }
    // single_choice / true_false
    const chosen = normalizeSingleAnswer(response);
    if (chosen === null) {
        return { ref, awardedHundredths: 0, isCorrect: false, autoGraded: true };
    }
    const expected = correctAnswers.length === 1 ? correctAnswers[0] : undefined;
    if (expected !== undefined && chosen === expected) {
        return { ref, awardedHundredths: pointsHundredths, isCorrect: true, autoGraded: true };
    }
    if (policy.negativeMarking) {
        return { ref, awardedHundredths: -penaltyHundredths(pointsHundredths, policy), isCorrect: false, autoGraded: true };
    }
    return { ref, awardedHundredths: 0, isCorrect: false, autoGraded: true };
}
/**
 * Grade an attempt from its snapshot questions only. Questions are processed in
 * ascending `position` order and the answer map is read by the snapshot row
 * reference, so a caller can never inject an out-of-snapshot question or a
 * re-ordered answer key.
 */
function gradeAttempt(questions, answers, policy) {
    const ordered = [...questions].sort((a, b) => a.position - b.position);
    const graded = [];
    let autoScoreHundredths = 0;
    let manualRequired = false;
    for (const question of ordered) {
        const result = gradeQuestion(question, answers[question.ref], policy);
        if (!result.autoGraded)
            manualRequired = true;
        if (result.awardedHundredths !== null)
            autoScoreHundredths += result.awardedHundredths;
        graded.push(result);
    }
    return { autoScoreHundredths, manualRequired, questions: graded };
}
function canonicalAnswer(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalAnswer(entry)).sort((a, b) => String(a).localeCompare(String(b)));
    }
    if (isRecord(value)) {
        const sorted = {};
        for (const key of Object.keys(value).sort())
            sorted[key] = canonicalAnswer(value[key]);
        return sorted;
    }
    return value ?? null;
}
/**
 * Deterministic fingerprint of the exact grading input. Two runs over the same
 * snapshot, answers and policy always hash identically, which lets the route
 * detect a no-op regrade without re-applying an award.
 */
function computeGradingFingerprint(input) {
    const questions = [...input.questions]
        .sort((a, b) => a.position - b.position)
        .map((question) => ({
        ref: question.ref,
        position: question.position,
        questionType: question.questionType,
        points: question.points,
        correctAnswers: [...question.correctAnswers],
    }));
    const answers = {};
    for (const key of Object.keys(input.answers).sort())
        answers[key] = canonicalAnswer(input.answers[key]);
    const canonical = JSON.stringify({
        v: exports.GRADING_POLICY_VERSION,
        versionId: input.versionId,
        policy: input.policy,
        questions,
        answers,
    });
    return (0, crypto_1.createHash)('sha256').update(canonical).digest('hex');
}
/**
 * Regrade decision: an award is (re)applied only when the fingerprint changed.
 * A missing previous fingerprint (first grading) always applies. This is the
 * single "no double-apply" gate.
 */
function shouldApplyRegrade(existingFingerprint, nextFingerprint) {
    return existingFingerprint !== nextFingerprint;
}
/** Normalize a client answer map to an own-property record (prototype-safe). */
function normalizeAnswerMap(value) {
    if (!isRecord(value))
        return {};
    const result = {};
    for (const key of Object.keys(value)) {
        if (key.startsWith('__'))
            continue;
        result[key] = value[key];
    }
    return result;
}
