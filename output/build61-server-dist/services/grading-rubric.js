"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGradingRubric = parseGradingRubric;
exports.scoreGradingRubric = scoreGradingRubric;
const exam_grading_1 = require("./exam-grading");
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function amount(value) {
    if (typeof value !== 'string' || !/^\d{1,7}(?:\.\d{1,2})?$/.test(value))
        throw Error('INVALID_RUBRIC_POINTS');
    const n = (0, exam_grading_1.toHundredths)(value);
    if (n === null || !Number.isSafeInteger(n))
        throw Error('INVALID_RUBRIC_POINTS');
    return n;
}
/** A rubric describes a pinned question; it never changes that question's marks. */
function parseGradingRubric(raw, pinnedPoints) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20)
        throw Error('INVALID_RUBRIC');
    const max = amount(pinnedPoints);
    if (max <= 0)
        throw Error('INVALID_RUBRIC_TOTAL');
    let total = 0;
    const keys = new Set();
    const criteria = raw.map(item => {
        if (!exact(item, ['key', 'label', 'max_points']) || typeof item.key !== 'string' ||
            !/^[a-z][a-z0-9_]{0,31}$/.test(item.key) || keys.has(item.key) || typeof item.label !== 'string' ||
            !item.label.trim() || item.label.length > 200)
            throw Error('INVALID_RUBRIC_CRITERION');
        keys.add(item.key);
        const points = amount(item.max_points);
        if (points <= 0 || !Number.isSafeInteger(total + points))
            throw Error('INVALID_RUBRIC_POINTS');
        total += points;
        return { key: item.key, label: item.label.trim(), max_points: (0, exam_grading_1.formatHundredths)(points) };
    });
    if (total !== max)
        throw Error('RUBRIC_TOTAL_MISMATCH');
    return { criteria, total_points: (0, exam_grading_1.formatHundredths)(max) };
}
/** Require every criterion exactly once; the server computes the final sum. */
function scoreGradingRubric(rubric, raw) {
    const canonical = parseGradingRubric(rubric.criteria, rubric.total_points);
    if (!Array.isArray(raw) || raw.length !== canonical.criteria.length)
        throw Error('RUBRIC_MARKS_INCOMPLETE');
    const marks = new Map();
    for (const mark of raw) {
        if (!exact(mark, ['key', 'points']) || typeof mark.key !== 'string' || marks.has(mark.key))
            throw Error('INVALID_RUBRIC_MARK');
        const criterion = canonical.criteria.find(c => c.key === mark.key);
        const n = amount(mark.points);
        if (!criterion || n > amount(criterion.max_points))
            throw Error('RUBRIC_MARK_OUT_OF_RANGE');
        marks.set(mark.key, n);
    }
    const total = [...marks.values()].reduce((a, b) => a + b, 0);
    return { points: (0, exam_grading_1.formatHundredths)(total), marks: canonical.criteria.map(c => ({ key: c.key, points: (0, exam_grading_1.formatHundredths)(marks.get(c.key)) })) };
}
