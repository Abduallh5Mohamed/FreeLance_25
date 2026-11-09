"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectionHundredths = projectionHundredths;
const exam_grading_1 = require("./exam-grading");
/** SQL DECIMAL projections may have scale4. Accept exact cents, never round. */
function projectionHundredths(raw) {
    if (typeof raw === 'string') {
        const match = /^(\d+)\.(\d{2})(\d{1,6})$/.exec(raw);
        if (match) {
            if (!/^0+$/.test(match[3]))
                return null;
            return (0, exam_grading_1.toHundredths)(match[1] + '.' + match[2]);
        }
    }
    return (0, exam_grading_1.toHundredths)(raw);
}
