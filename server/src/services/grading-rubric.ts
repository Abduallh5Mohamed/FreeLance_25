import { formatHundredths, toHundredths } from './exam-grading';

export interface GradingCriterion { key: string; label: string; max_points: string }
export interface GradingRubric { criteria: GradingCriterion[]; total_points: string }
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function amount(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(value)) throw Error('INVALID_RUBRIC_POINTS');
  const n = toHundredths(value);
  if (n === null || !Number.isSafeInteger(n)) throw Error('INVALID_RUBRIC_POINTS');
  return n;
}

/** A rubric describes a pinned question; it never changes that question's marks. */
export function parseGradingRubric(raw: unknown, pinnedPoints: string): GradingRubric {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) throw Error('INVALID_RUBRIC');
  const max = amount(pinnedPoints);
  if (max <= 0) throw Error('INVALID_RUBRIC_TOTAL');
  let total = 0;
  const keys = new Set<string>();
  const criteria = raw.map(item => {
    if (!exact(item, ['key', 'label', 'max_points']) || typeof item.key !== 'string' ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(item.key) || keys.has(item.key) || typeof item.label !== 'string' ||
      !item.label.trim() || item.label.length > 200) throw Error('INVALID_RUBRIC_CRITERION');
    keys.add(item.key);
    const points = amount(item.max_points);
    if (points <= 0 || !Number.isSafeInteger(total + points)) throw Error('INVALID_RUBRIC_POINTS');
    total += points;
    return { key: item.key, label: item.label.trim(), max_points: formatHundredths(points) };
  });
  if (total !== max) throw Error('RUBRIC_TOTAL_MISMATCH');
  return { criteria, total_points: formatHundredths(max) };
}

/** Require every criterion exactly once; the server computes the final sum. */
export function scoreGradingRubric(rubric: GradingRubric, raw: unknown): { points: string; marks: Array<{ key: string; points: string }> } {
  const canonical = parseGradingRubric(rubric.criteria, rubric.total_points);
  if (!Array.isArray(raw) || raw.length !== canonical.criteria.length) throw Error('RUBRIC_MARKS_INCOMPLETE');
  const marks = new Map<string, number>();
  for (const mark of raw) {
    if (!exact(mark, ['key', 'points']) || typeof mark.key !== 'string' || marks.has(mark.key)) throw Error('INVALID_RUBRIC_MARK');
    const criterion = canonical.criteria.find(c => c.key === mark.key);
    const n = amount(mark.points);
    if (!criterion || n > amount(criterion.max_points)) throw Error('RUBRIC_MARK_OUT_OF_RANGE');
    marks.set(mark.key, n);
  }
  const total = [...marks.values()].reduce((a, b) => a + b, 0);
  return { points: formatHundredths(total), marks: canonical.criteria.map(c => ({ key: c.key, points: formatHundredths(marks.get(c.key)!) })) };
}
