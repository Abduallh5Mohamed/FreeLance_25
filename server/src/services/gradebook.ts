/**
 * M4 A6 — gradebook domain policy.
 *
 * Also owns the pure identity/validation rules for a grade that is written by a
 * source item (an assignment submission or a finalized exam attempt) instead of
 * a free manual entry. A source-linked grade is addressed by a deterministic
 * row id derived from the exact `(tenant, enrollment, course, item type, item)`
 * tuple, so a repeated request targets the same row instead of appending a
 * duplicate. That is a pure function; the SQL upsert itself belongs to the
 * route that owns the transaction.
 */
import { createHash } from 'node:crypto';

export const GRADING_MODES = ['points', 'weighted'] as const;
export type GradingMode = (typeof GRADING_MODES)[number];
export const ROUNDING_MODES = ['half_up', 'half_even', 'none'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];
export const SCORE_ITEM_TYPES = ['exam', 'assignment', 'manual', 'lesson'] as const;
export type ScoreItemType = (typeof SCORE_ITEM_TYPES)[number];
export const MAX_CATEGORY_NAME = 120;
export const MAX_CATEGORIES = 50;
export const MAX_WEIGHT = 1000;
export const MAX_SCORE = 1e9;
/** Fixed-point scale for scores (matches `DECIMAL(12,4)` storage). */
export const GRADE_SCALE = 10000;
/** Fixed-point scale used while resolving percentages. */
export const PERCENT_SCALE = 1_000_000;
export const DEFAULT_ROUNDING_DECIMALS = 2;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function normalizeId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return ID_PATTERN.test(trimmed) ? trimmed : null;
}
export function normalizeGradingMode(value: unknown): GradingMode | null {
    if (typeof value !== 'string') return null;
    return (GRADING_MODES as readonly string[]).includes(value) ? (value as GradingMode) : null;
}
export function normalizeRoundingMode(value: unknown): RoundingMode | null {
    if (value === undefined || value === null || value === '') return 'half_up';
    if (typeof value !== 'string') return null;
    return (ROUNDING_MODES as readonly string[]).includes(value) ? (value as RoundingMode) : null;
}
export interface GradeCategory { id: string; name: string; weight: number; }
export interface ValidatedGradebookPolicy { mode: GradingMode; passingScore: number | null; rounding: RoundingMode; categories: GradeCategory[]; }
function normalizeWeight(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_WEIGHT) return null;
    const scaled = parsed * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9) return null;
    return Math.round(scaled) / 100;
}
function normalizeCategory(value: unknown, index: number): GradeCategory | null {
    if (!isRecord(value)) return null;
    const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
    if (!name || name.length > MAX_CATEGORY_NAME) return null;
    const id = value['id'] === undefined || value['id'] === null || value['id'] === ''
        ? `cat-${index + 1}`
        : normalizeId(value['id']);
    if (!id) return null;
    const weight = normalizeWeight(value['weight'] ?? 0);
    if (weight === null) return null;
    return { id, name, weight };
}
export function validateGradebookPolicy(body: unknown): ValidationResult<ValidatedGradebookPolicy> {
    const record = isRecord(body) ? body : {};
    const mode = normalizeGradingMode(record['mode'] ?? 'points');
    if (!mode) return { ok: false, error: 'mode must be points or weighted' };
    const rounding = normalizeRoundingMode(record['rounding']);
    if (rounding === null) return { ok: false, error: 'rounding must be half_up, half_even or none' };
    let passingScore: number | null = null;
    if (record['passing_score'] !== undefined && record['passing_score'] !== null && record['passing_score'] !== '') {
        const parsed = typeof record['passing_score'] === 'number' ? record['passing_score'] : Number(record['passing_score']);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return { ok: false, error: 'passing_score must be a number between 0 and 100' };
        passingScore = Math.round(parsed * 100) / 100;
    }
    let categories: GradeCategory[] = [];
    if (record['categories'] !== undefined && record['categories'] !== null && record['categories'] !== '') {
        if (!Array.isArray(record['categories'])) return { ok: false, error: 'categories must be a list' };
        if (record['categories'].length > MAX_CATEGORIES) return { ok: false, error: `at most ${MAX_CATEGORIES} categories` };
        const seen = new Set<string>();
        for (let i = 0; i < record['categories'].length; i += 1) {
            const cat = normalizeCategory(record['categories'][i], i);
            if (!cat) return { ok: false, error: `category ${i + 1} is invalid` };
            if (seen.has(cat.id)) return { ok: false, error: 'category ids must be unique' };
            seen.add(cat.id);
            categories.push(cat);
        }
    }
    if (mode === 'weighted') {
        if (categories.length === 0) return { ok: false, error: 'weighted mode requires at least one category' };
        const totalWeight = categories.reduce((sum, c) => sum + c.weight, 0);
        if (totalWeight > 0 && Math.abs(totalWeight - 100) > 1e-6) return { ok: false, error: 'weighted category weights must sum to 100' };
    }
    return { ok: true, value: { mode, passingScore, rounding, categories } };
}
export interface ScoreEntry { categoryId?: string | null; score: number; maxScore: number; weight?: number | null; itemType?: ScoreItemType | null; itemId?: string | null; }
export interface CalculatedGrade { earned: number; possible: number; percent: number; rounded: number; passed: boolean | null; mode: GradingMode; }
function roundHalfUp(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor + Number.EPSILON * (value >= 0 ? 1 : -1)) / factor;
}
function roundHalfEven(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    const scaled = value * factor;
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    if (Math.abs(diff - 0.5) < 1e-9) return (floor % 2 === 0 ? floor : floor + 1) / factor;
    return Math.round(scaled) / factor;
}
function applyRounding(value: number, mode: RoundingMode, decimals: number): number {
    if (mode === 'none') return value;
    if (mode === 'half_even') return roundHalfEven(value, decimals);
    return roundHalfUp(value, decimals);
}
/**
 * Convert a value to a fixed-point integer at `scale` decimals, rounding half
 * away from zero. Returns null for anything that cannot be represented exactly
 * within JavaScript's safe-integer range, so a pathological input is skipped
 * instead of silently corrupting the grade with float drift.
 */
function toFixedInteger(value: number, scale: number): number | null {
    if (!Number.isFinite(value)) return null;
    const scaled = Math.round(value * scale);
    return Number.isSafeInteger(scaled) ? scaled : null;
}
/** Half-up integer division; the denominator is assumed positive. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= 0n) return 0n;
    const sign = numerator < 0n ? -1n : 1n;
    const magnitude = numerator < 0n ? -numerator : numerator;
    return sign * ((magnitude + denominator / 2n) / denominator);
}
/**
 * Legacy weighted percentage: each entry contributes its own weight. Preserved
 * for courses with no category policy and for uncategorized score records.
 */
function weightedEntryPercent(entries: readonly ScoreEntry[]): bigint {
    let num = 0n;
    let den = 0n;
    for (const entry of entries) {
        const score = toFixedInteger(entry.score, GRADE_SCALE);
        const maxScore = toFixedInteger(entry.maxScore, GRADE_SCALE);
        const weightRaw = entry.weight === null || entry.weight === undefined ? 1 : entry.weight;
        const weight = toFixedInteger(weightRaw, GRADE_SCALE);
        if (score === null || maxScore === null || maxScore <= 0 || weight === null || weight < 0) continue;
        const pct = divideRoundHalfUp(BigInt(score) * 100n * BigInt(PERCENT_SCALE), BigInt(maxScore));
        num += pct * BigInt(weight);
        den += BigInt(weight);
    }
    return den > 0n ? divideRoundHalfUp(num, den) : 0n;
}
/**
 * Category-weighted percentage for the category weights defined by the stored
 * policy. Every valid score is folded into its category first, then each
 * non-empty category contributes its own weight. Categories with no valid
 * scores are excluded from the denominator. Returns null when no weighted
 * category has scores, which callers use to preserve legacy entry weighting.
 */
function weightedCategoryPercent(entries: readonly ScoreEntry[], categories: readonly GradeCategory[]): bigint | null {
    const weightedCategoryIds = new Set(categories.filter((category) => category.weight > 0).map((category) => category.id));
    if (weightedCategoryIds.size === 0) return null;
    const totals = new Map<string, { earned: bigint; possible: bigint }>();
    for (const entry of entries) {
        if (!entry.categoryId || !weightedCategoryIds.has(entry.categoryId)) continue;
        const score = toFixedInteger(entry.score, GRADE_SCALE);
        const maxScore = toFixedInteger(entry.maxScore, GRADE_SCALE);
        if (score === null || maxScore === null || maxScore <= 0) continue;
        const total = totals.get(entry.categoryId) ?? { earned: 0n, possible: 0n };
        total.earned += BigInt(score);
        total.possible += BigInt(maxScore);
        totals.set(entry.categoryId, total);
    }
    let num = 0n;
    let den = 0n;
    for (const category of categories) {
        if (category.weight <= 0) continue;
        const total = totals.get(category.id);
        if (!total || total.possible <= 0n) continue;
        const weight = toFixedInteger(category.weight, GRADE_SCALE);
        if (weight === null || weight <= 0) continue;
        const pct = divideRoundHalfUp(total.earned * 100n * BigInt(PERCENT_SCALE), total.possible);
        num += pct * BigInt(weight);
        den += BigInt(weight);
    }
    return den > 0n ? divideRoundHalfUp(num, den) : null;
}
/**
 * Recompute a grade from stored score entries.
 *
 * All arithmetic runs on fixed-point integers (scores at `GRADE_SCALE`, the
 * resolved percentage at `PERCENT_SCALE`) implemented over `BigInt`, so the
 * same entries always recompute to the exact same value regardless of the
 * floating-point representation of the inputs. The single final rounding to
 * `DEFAULT_ROUNDING_DECIMALS` uses the caller's rounding mode.
 */
export function calculateGrade(entries: readonly ScoreEntry[], policy: { mode?: GradingMode; rounding?: RoundingMode; passingScore?: number | null; categories?: readonly GradeCategory[] } = {}): CalculatedGrade {
    const mode: GradingMode = policy.mode === 'weighted' ? 'weighted' : 'points';
    const rounding: RoundingMode = policy.rounding ?? 'half_up';
    const valid = entries.filter((e) => Number.isFinite(e.score) && Number.isFinite(e.maxScore) && e.maxScore > 0 && e.score >= 0);
    let percentScaled = 0n;
    if (mode === 'points') {
        let earned = 0n;
        let possible = 0n;
        for (const entry of valid) {
            const score = toFixedInteger(entry.score, GRADE_SCALE);
            const maxScore = toFixedInteger(entry.maxScore, GRADE_SCALE);
            if (score === null || maxScore === null || maxScore <= 0) continue;
            earned += BigInt(score);
            possible += BigInt(maxScore);
        }
        if (possible > 0n) {
            percentScaled = divideRoundHalfUp(earned * 100n * BigInt(PERCENT_SCALE), possible);
        }
    } else {
        const categories = policy.categories ?? [];
        const categoryPercent = categories.length > 0 ? weightedCategoryPercent(valid, categories) : null;
        percentScaled = categoryPercent ?? weightedEntryPercent(valid);
    }
    const percent = Number(percentScaled) / PERCENT_SCALE;
    const rounded = applyRounding(percent, rounding, DEFAULT_ROUNDING_DECIMALS);
    const earned = valid.reduce((s, e) => s + e.score, 0);
    const possible = valid.reduce((s, e) => s + e.maxScore, 0);
    let passed: boolean | null = null;
    if (policy.passingScore !== null && policy.passingScore !== undefined) passed = rounded >= (policy.passingScore as number);
    return { earned, possible, percent, rounded, passed, mode };
}
export function recomputeGrade(entries: readonly ScoreEntry[], policy?: { mode?: GradingMode; rounding?: RoundingMode; passingScore?: number | null; categories?: readonly GradeCategory[] }): CalculatedGrade { return calculateGrade(entries, policy); }
export function computeGrade(...args: Parameters<typeof calculateGrade>): CalculatedGrade { return calculateGrade(...args); }
export function calculateWeightedGrade(entries: readonly ScoreEntry[], policy?: { rounding?: RoundingMode; passingScore?: number | null }): CalculatedGrade { return calculateGrade(entries, { ...(policy ?? {}), mode: 'weighted' }); }
export function calculatePointsGrade(entries: readonly ScoreEntry[], policy?: { rounding?: RoundingMode; passingScore?: number | null }): CalculatedGrade { return calculateGrade(entries, { ...(policy ?? {}), mode: 'points' }); }
export function roundGrade(value: number, decimals: number = DEFAULT_ROUNDING_DECIMALS, mode: RoundingMode = 'half_up'): number {
    if (mode === 'none') return value;
    if (mode === 'half_even') return roundHalfEven(value, decimals);
    return roundHalfUp(value, decimals);
}
export function normalizeScoreEntry(value: unknown): ScoreEntry | null {
    if (!isRecord(value)) return null;
    const score = typeof value['score'] === 'number' ? value['score'] : Number(value['score']);
    const maxScore = typeof value['max_score'] === 'number' ? value['max_score'] : Number(value['max_score'] ?? value['maxScore']);
    if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0 || score < 0) return null;
    if (score > MAX_SCORE || maxScore > MAX_SCORE) return null;
    const categoryId = value['category_id'] === undefined || value['category_id'] === null || value['category_id'] === '' ? null : (typeof value['category_id'] === 'string' ? value['category_id'].trim() : null);
    const weightRaw = value['weight'];
    let weight: number | null = null;
    if (weightRaw !== undefined && weightRaw !== null && weightRaw !== '') {
        const w = typeof weightRaw === 'number' ? weightRaw : Number(weightRaw);
        if (!Number.isFinite(w) || w < 0) return null;
        weight = w;
    }
    const itemTypeRaw = value['item_type'];
    const itemType = itemTypeRaw === undefined || itemTypeRaw === null ? null : (SCORE_ITEM_TYPES as readonly string[]).includes(String(itemTypeRaw)) ? (String(itemTypeRaw) as ScoreItemType) : null;
    if (itemTypeRaw !== undefined && itemTypeRaw !== null && itemType === null) return null;
    const itemId = value['item_id'] === undefined || value['item_id'] === null || value['item_id'] === '' ? null : (typeof value['item_id'] === 'string' ? value['item_id'].trim() : null);
    return { categoryId, score, maxScore, weight, itemType, itemId };
}
export function validateScoreEntry(body: unknown): ValidationResult<ScoreEntry> {
    const entry = normalizeScoreEntry(body);
    if (!entry) return { ok: false, error: 'invalid score entry' };
    return { ok: true, value: entry };
}
export const normalizePolicy = validateGradebookPolicy;
export const validatePolicy = validateGradebookPolicy;
export const computeCalculatedGrade = calculateGrade;
export const recomputeCalculatedGrade = recomputeGrade;
export const recompute = recomputeGrade;

/* ------------------------------------------------------------------------- */
/* Source-linked grade identity (idempotent writes)                          */
/* ------------------------------------------------------------------------- */

/**
 * Item types whose grade is owned by exactly one source row per
 * `(tenant, enrollment, course)`. A free `manual`/`lesson` entry keeps the
 * historical append behaviour: two manual scores are legitimately two rows.
 */
export const LINKED_SCORE_ITEM_TYPES = ['assignment', 'exam'] as const;
export type LinkedScoreItemType = (typeof LINKED_SCORE_ITEM_TYPES)[number];

export function normalizeLinkedScoreItemType(value: unknown): LinkedScoreItemType | null {
    if (typeof value !== 'string') return null;
    return (LINKED_SCORE_ITEM_TYPES as readonly string[]).includes(value) ? (value as LinkedScoreItemType) : null;
}

export interface LinkedScoreIdentity {
    tenantId: string;
    enrollmentId: string;
    courseId: string;
    itemType: LinkedScoreItemType;
    itemId: string;
}

/**
 * Deterministic `gradebook_scores.id` for a source-linked grade.
 *
 * The id is a name-based UUID (SHA-256 over the exact identity tuple, RFC 4122
 * version 5 shape) so the same source item for the same student in the same
 * course always maps to one primary key. A repeated write therefore collides on
 * the existing PRIMARY KEY instead of appending a second grade — that is the
 * whole idempotency mechanism, and it needs no schema change. A different
 * student, course, tenant or item always produces a different id, so no
 * cross-tenant or cross-student collision is possible. Returns null for a
 * malformed identity so the caller fails closed instead of writing a row under
 * a meaningless key.
 */
export function deterministicScoreId(identity: LinkedScoreIdentity): string | null {
    const itemType = normalizeLinkedScoreItemType(identity.itemType);
    if (!itemType) return null;
    const parts = [
        identity.tenantId,
        identity.enrollmentId,
        identity.courseId,
        identity.itemId,
    ];
    for (const part of parts) {
        if (normalizeId(part) === null) return null;
    }
    const digest = createHash('sha256')
        .update(['gradebook-score', 'v1', identity.tenantId, identity.enrollmentId,
            identity.courseId, itemType, identity.itemId].join('|'))
        .digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface ValidatedLinkedGrade {
    score: number;
    maxScore: number;
    weight: number | null;
}

/**
 * Validate the numeric payload of a source-linked grade. An award can never
 * exceed the item maximum, and both values stay inside the fixed-point range
 * the `DECIMAL(12,4)` column can represent, so a correction can never store a
 * score the grade calculator would then silently drop as invalid.
 */
export function validateLinkedGradeInput(body: unknown): ValidationResult<ValidatedLinkedGrade> {
    if (!isRecord(body)) return { ok: false, error: 'invalid grade payload' };
    const rawScore = body['score'];
    const rawMax = body['max_score'] ?? body['maxScore'];
    const score = typeof rawScore === 'number' ? rawScore : Number(rawScore);
    const maxScore = typeof rawMax === 'number' ? rawMax : Number(rawMax);
    if (rawScore === undefined || rawScore === null || rawScore === '') return { ok: false, error: 'score is required' };
    if (rawMax === undefined || rawMax === null || rawMax === '') return { ok: false, error: 'max_score is required' };
    if (!Number.isFinite(score) || !Number.isFinite(maxScore)) return { ok: false, error: 'invalid grade payload' };
    if (score < 0 || maxScore <= 0) return { ok: false, error: 'invalid grade payload' };
    if (score > MAX_SCORE || maxScore > MAX_SCORE) return { ok: false, error: 'invalid grade payload' };
    if (score > maxScore) return { ok: false, error: 'score must not exceed max_score' };
    let weight: number | null = null;
    const rawWeight = body['weight'];
    if (rawWeight !== undefined && rawWeight !== null && rawWeight !== '') {
        const parsed = typeof rawWeight === 'number' ? rawWeight : Number(rawWeight);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_WEIGHT) {
            return { ok: false, error: 'invalid grade payload' };
        }
        weight = parsed;
    }
    return { ok: true, value: { score, maxScore, weight } };
}