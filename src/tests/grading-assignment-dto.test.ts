import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGradingManagement, parseAssignedQuestions } from '../features/grading/GradingAssignments';
const id = (n: number) => `b6000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('assignment management distinguishes stored active status from current teacher authority and rejects private candidate fields', () => {
    const r = { assignment: { id: id(1), assignee_user_id: id(2), rubric_id: id(3), status: 'active', version: 2, authority_current: false }, candidates: [{ id: id(2), name: 'Teacher' }], rubrics: [{ id: id(3), revision: 1 }] };
    assert.equal(parseGradingManagement(r).assignment?.authority_current, false);
    for (const change of [{ candidates: [{ ...r.candidates[0], phone: 'private' }] }, { candidates: [r.candidates[0], r.candidates[0]] }, { assignment: { ...r.assignment, authority_current: 'true' } }, { tenant_id: id(9) }])
        assert.throws(() => parseGradingManagement({ ...r, ...change }));
});
test('assigned question DTO pins one rubric and bounded exact criteria, no financial or student identity fields', () => {
    const a = { id: id(1), question_ref: id(2), version: 0, rubric_id: id(3), label: 'Question', criteria: [{ key: 'method', label: 'Method', max_points: '0.10' }, { key: 'result', label: 'Result', max_points: '0.20' }], total_points: '0.30' };
    assert.equal(parseAssignedQuestions({ assignments: [a], next_cursor: null }).assignments.length, 1);
    for (const patch of [{ student_name: 'private' }, { criteria: [{ ...a.criteria[0], max_points: '0.11' }, a.criteria[1]] }, { criteria: [a.criteria[0], a.criteria[0]] }, { total_points: 'NaN' }, { permissions: ['fees.manage'] }])
        assert.throws(() => parseAssignedQuestions({ assignments: [{ ...a, ...patch }], next_cursor: null }));
    assert.throws(() => parseAssignedQuestions({ assignments: [a, a], next_cursor: null }));
});
