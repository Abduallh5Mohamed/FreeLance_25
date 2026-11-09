import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkIntent, parseWorkReceipt } from '../features/grading/grading-work-client';
const id = (n: number) => `b6000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('grading recovery markers contain only bounded typed identifiers and version; no answers or marks', () => {
    const i = { operation_id: id(1), kind: 'grade', assignment_id: id(2), question_ref: id(3), resource_id: id(4), version: 2 };
    assert.equal(parseWorkIntent(i).version, 2);
    for (const change of [{ marks: [] }, { feedback: 'private' }, { kind: 'fees.paid' }, { assignment_id: null }, { version: -1 }, { operation_id: 'foreign' }])
        assert.throws(() => parseWorkIntent({ ...i, ...change }));
});
test('grading recovery binds canonical historical grade to assignment marker attempt/question/version', () => {
    const i = parseWorkIntent({ operation_id: id(1), kind: 'grade', assignment_id: id(2), question_ref: id(3), resource_id: id(4), version: 2 });
    const r = { operation_id: id(1), attempt_id: id(4), kind: 'grade', attempt_version: 2, question_ref: id(3), revision: 1, awarded_points: '6.00', score: null, gradebook_linked: null };
    assert.equal(parseWorkReceipt(r, i).awarded_points, '6.00');
    for (const change of [{ attempt_id: id(5) }, { question_ref: id(6) }, { attempt_version: 3 }, { feedback: 'secret' }])
        assert.throws(() => parseWorkReceipt({ ...r, ...change }, i));
});
test('reopening and assignment receipts cannot be exchanged or imply a different resource/version', () => {
    const i = parseWorkIntent({ operation_id: id(1), kind: 'attempt.reopened', assignment_id: null, question_ref: null, resource_id: id(2), version: 4 }), r = { operation_id: id(1), kind: 'attempt.reopened', resource_id: id(2), version: 4, old_score: '8.00', gradebook_withdrawn: true };
    assert.equal(parseWorkReceipt(r, i).old_score, '8.00');
    for (const change of [{ version: 5 }, { old_score: '8abc' }, { gradebook_withdrawn: 'true' }, { tenant_id: id(3) }, { kind: 'assignment.saved' }])
        assert.throws(() => parseWorkReceipt({ ...r, ...change }, i));
});
