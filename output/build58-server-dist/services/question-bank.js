"use strict";
/**
 * M4 A1 — reusable, tenant-owned question bank domain policy.
 *
 * Pure, deterministic, I/O-free. This module only normalizes/validates question
 * content, models the append-only version chain and decides version
 * immutability. Scope (tenant/branch), authority and storage are composed by
 * the route layer; nothing here reads a request or a clock.
 *
 * Question kinds:
 *  - `single_choice`   exactly one correct option.
 *  - `multiple_choice` one or more correct options.
 *  - `true_false`      no options; the correct answer is the literal boolean.
 *  - `essay`           no machine-checkable answer; manual grading only.
 *
 * Versioning: a question's content is append-only. Every edit records a new
 * immutable version; a version that is referenced by a PUBLISHED exam can never
 * be mutated or replaced by an in-place edit. `isVersionLocked` is the single
 * immutability decision and fails closed when usage provenance is missing.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUESTION_EXPORT_FORMAT_VERSION = exports.MAX_POINTS = exports.MAX_IMPORT_QUESTIONS = exports.MAX_TAG_LENGTH = exports.MAX_TAGS = exports.MIN_OPTIONS = exports.MAX_OPTIONS = exports.MAX_OPTION_LENGTH = exports.MAX_EXPLANATION_LENGTH = exports.MAX_QUESTION_TEXT = exports.QUESTION_BRANCH_SCOPES = exports.QUESTION_KINDS = void 0;
exports.normalizeId = normalizeId;
exports.normalizeQuestionKind = normalizeQuestionKind;
exports.normalizeBranchScope = normalizeBranchScope;
exports.normalizeTags = normalizeTags;
exports.validateQuestionInput = validateQuestionInput;
exports.isVersionLocked = isVersionLocked;
exports.buildQuestionVisibilityFilter = buildQuestionVisibilityFilter;
exports.validateQuestionImportPayload = validateQuestionImportPayload;
exports.QUESTION_KINDS = ['single_choice', 'multiple_choice', 'true_false', 'essay'];
exports.QUESTION_BRANCH_SCOPES = ['tenant', 'branch'];
exports.MAX_QUESTION_TEXT = 10000;
exports.MAX_EXPLANATION_LENGTH = 5000;
exports.MAX_OPTION_LENGTH = 1000;
exports.MAX_OPTIONS = 50;
exports.MIN_OPTIONS = 2;
exports.MAX_TAGS = 20;
exports.MAX_TAG_LENGTH = 48;
exports.MAX_IMPORT_QUESTIONS = 200;
exports.MAX_POINTS = 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Bounded opaque id (question/branch). Returns null when malformed. */
function normalizeId(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return ID_PATTERN.test(trimmed) ? trimmed : null;
}
function normalizeQuestionKind(value) {
    if (typeof value !== 'string')
        return null;
    return exports.QUESTION_KINDS.includes(value) ? value : null;
}
function normalizeBranchScope(value) {
    if (typeof value !== 'string')
        return null;
    return exports.QUESTION_BRANCH_SCOPES.includes(value)
        ? value
        : null;
}
/**
 * Normalize a tag list: an absent value is `[]`; every tag is trimmed,
 * lower-cased and de-duplicated preserving order; the list is bounded in both
 * count and length. A non-array, non-string entry, empty tag or over-long tag
 * is rejected (`null`) so arbitrary content cannot be smuggled through tags.
 */
function normalizeTags(value) {
    if (value === undefined || value === null || value === '')
        return [];
    if (!Array.isArray(value))
        return null;
    if (value.length > exports.MAX_TAGS)
        return null;
    const seen = new Set();
    const tags = [];
    for (const entry of value) {
        if (typeof entry !== 'string')
            return null;
        const tag = entry.trim().toLowerCase();
        if (!tag || tag.length > exports.MAX_TAG_LENGTH)
            return null;
        if (seen.has(tag))
            continue;
        seen.add(tag);
        tags.push(tag);
    }
    return tags;
}
function normalizePoints(value) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > exports.MAX_POINTS)
        return null;
    const scaled = parsed * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9)
        return null;
    return Math.round(scaled) / 100;
}
function normalizeChoiceOptions(value) {
    if (!Array.isArray(value))
        return { options: [], error: 'options are required for a choice question' };
    if (value.length < exports.MIN_OPTIONS || value.length > exports.MAX_OPTIONS) {
        return { options: [], error: `options must contain between ${exports.MIN_OPTIONS} and ${exports.MAX_OPTIONS} entries` };
    }
    const options = [];
    for (const entry of value) {
        if (typeof entry !== 'string')
            return { options: [], error: 'every option must be a string' };
        const option = entry.trim();
        if (!option || option.length > exports.MAX_OPTION_LENGTH) {
            return { options: [], error: 'every option must be non-empty and bounded' };
        }
        options.push(option);
    }
    if (new Set(options).size !== options.length)
        return { options: [], error: 'options must be unique' };
    return { options };
}
function normalizeCorrectAnswers(value) {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value))
        return null;
    const answers = [];
    for (const entry of value) {
        if (typeof entry !== 'string')
            return null;
        answers.push(entry.trim());
    }
    return answers;
}
/**
 * Validate a question create/edit payload. The answer key is type-checked
 * against the options so a choice question can never be stored with a correct
 * answer that is not one of its options, and a true/false question can never
 * carry an arbitrary free-text key.
 */
function validateQuestionInput(body) {
    const record = isRecord(body) ? body : {};
    const questionText = typeof record['question_text'] === 'string' ? record['question_text'].trim() : '';
    if (!questionText)
        return { ok: false, error: 'question_text is required' };
    if (questionText.length > exports.MAX_QUESTION_TEXT) {
        return { ok: false, error: `question_text must be at most ${exports.MAX_QUESTION_TEXT} characters` };
    }
    const questionType = normalizeQuestionKind(record['question_type']);
    if (!questionType) {
        return { ok: false, error: 'question_type must be single_choice, multiple_choice, true_false or essay' };
    }
    const points = normalizePoints(record['points'] ?? 1);
    if (points === null)
        return { ok: false, error: 'points must be a positive number up to two decimals' };
    const explanationRaw = record['explanation'];
    let explanation = null;
    if (explanationRaw !== undefined && explanationRaw !== null && explanationRaw !== '') {
        if (typeof explanationRaw !== 'string')
            return { ok: false, error: 'explanation must be a string' };
        const trimmed = explanationRaw.trim();
        if (trimmed.length > exports.MAX_EXPLANATION_LENGTH) {
            return { ok: false, error: `explanation must be at most ${exports.MAX_EXPLANATION_LENGTH} characters` };
        }
        explanation = trimmed || null;
    }
    const tags = normalizeTags(record['tags']);
    if (tags === null)
        return { ok: false, error: `tags must be at most ${exports.MAX_TAGS} bounded strings` };
    const branchScope = normalizeBranchScope(record['branch_scope'] ?? 'tenant');
    if (!branchScope)
        return { ok: false, error: 'branch_scope must be tenant or branch' };
    let branchId = null;
    if (branchScope === 'branch') {
        branchId = normalizeId(record['branch_id']);
        if (!branchId)
            return { ok: false, error: 'branch_id is required for a branch question' };
    }
    else if (record['branch_id'] !== undefined && record['branch_id'] !== null && record['branch_id'] !== '') {
        return { ok: false, error: 'a tenant question must not target a branch' };
    }
    const rawAnswers = normalizeCorrectAnswers(record['correct_answers']);
    if (questionType === 'single_choice' || questionType === 'multiple_choice') {
        if (rawAnswers === null)
            return { ok: false, error: 'correct_answers must be a list of strings' };
        const { options, error } = normalizeChoiceOptions(record['options']);
        if (error)
            return { ok: false, error };
        if (rawAnswers.length === 0)
            return { ok: false, error: 'correct_answers is required for a choice question' };
        if (new Set(rawAnswers).size !== rawAnswers.length) {
            return { ok: false, error: 'correct_answers must be unique' };
        }
        if (!rawAnswers.every((answer) => options.includes(answer))) {
            return { ok: false, error: 'every correct answer must be one of the options' };
        }
        if (questionType === 'single_choice' && rawAnswers.length !== 1) {
            return { ok: false, error: 'a single_choice question must have exactly one correct answer' };
        }
        return {
            ok: true,
            value: { questionType, questionText, options, correctAnswers: rawAnswers, points, explanation, tags, branchScope, branchId },
        };
    }
    if (questionType === 'true_false') {
        if (record['options'] !== undefined && Array.isArray(record['options']) && record['options'].length > 0) {
            return { ok: false, error: 'a true_false question must not define options' };
        }
        const raw = record['correct_answers'];
        const single = Array.isArray(raw) ? raw[0] : raw;
        const normalized = typeof single === 'boolean' ? String(single) : (typeof single === 'string' ? single.trim().toLowerCase() : '');
        if (normalized !== 'true' && normalized !== 'false') {
            return { ok: false, error: 'a true_false question needs a true or false correct answer' };
        }
        return {
            ok: true,
            value: { questionType, questionText, options: [], correctAnswers: [normalized], points, explanation, tags, branchScope, branchId },
        };
    }
    // essay
    if (record['options'] !== undefined && Array.isArray(record['options']) && record['options'].length > 0) {
        return { ok: false, error: 'an essay question must not define options' };
    }
    return {
        ok: true,
        value: { questionType, questionText, options: [], correctAnswers: [], points, explanation, tags, branchScope, branchId },
    };
}
/**
 * Immutability of a question version. A version referenced by at least one
 * PUBLISHED exam is locked. Empty/unknown usage provenance never unlocks:
 * callers must supply the real usages (a missing lookup is a failure, not an
 * implicit "unused").
 */
function isVersionLocked(usages) {
    return usages.some((usage) => usage.examPublished);
}
/**
 * Row-level visibility for a staff list/read: a tenant owner sees every
 * question in the tenant; a branch-scoped instructor sees tenant-level
 * questions plus their own branch; an instructor with no proven branch sees
 * tenant-level questions only. Deny by default.
 */
function buildQuestionVisibilityFilter(viewer) {
    if (viewer.isOwner)
        return { sql: '1=1', params: [] };
    if (viewer.branchId) {
        return {
            sql: `(branch_scope='tenant' OR (branch_scope='branch' AND branch_id=?))`,
            params: [viewer.branchId],
        };
    }
    return { sql: `branch_scope='tenant'`, params: [] };
}
exports.QUESTION_EXPORT_FORMAT_VERSION = 1;
/**
 * Validate an import payload. Only the `questions` array is read; any
 * `tenant_id`/`branch_id` embedded per entry is ignored for scope (the route
 * forces the verified principal's tenant) while the content is validated with
 * the same rules as a create. Bounded count so an import cannot be used as a
 * bulk-write amplification.
 */
function validateQuestionImportPayload(body) {
    const record = isRecord(body) ? body : {};
    const raw = record['questions'];
    if (!Array.isArray(raw) || raw.length === 0)
        return { ok: false, error: 'questions must be a non-empty list' };
    if (raw.length > exports.MAX_IMPORT_QUESTIONS) {
        return { ok: false, error: `at most ${exports.MAX_IMPORT_QUESTIONS} questions may be imported at once` };
    }
    const questions = [];
    for (let index = 0; index < raw.length; index += 1) {
        const validated = validateQuestionInput(raw[index]);
        if (!validated.ok)
            return { ok: false, error: `question ${index + 1}: ${validated.error}` };
        questions.push(validated.value);
    }
    return { ok: true, value: questions };
}
