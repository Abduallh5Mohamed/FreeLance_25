/**
 * M4 A6 — gradebook domain policy.
 */
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
        let num = 0n;
        let den = 0n;
        for (const entry of valid) {
            const score = toFixedInteger(entry.score, GRADE_SCALE);
            const maxScore = toFixedInteger(entry.maxScore, GRADE_SCALE);
            const weightRaw = entry.weight === null || entry.weight === undefined ? 1 : entry.weight;
            const weight = toFixedInteger(weightRaw, GRADE_SCALE);
            if (score === null || maxScore === null || maxScore <= 0 || weight === null || weight < 0) continue;
            const pct = divideRoundHalfUp(BigInt(score) * 100n * BigInt(PERCENT_SCALE), BigInt(maxScore));
            num += pct * BigInt(weight);
            den += BigInt(weight);
        }
        if (den > 0n) percentScaled = divideRoundHalfUp(num, den);
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