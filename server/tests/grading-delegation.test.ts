import test from 'node:test';
import assert from 'node:assert/strict';
import { gradingDelegationReady, assignedRubricPoints } from '../src/services/grading-delegation';
test('assignment writes require transactional audit, bound responsibility column and exact unique identities', async () => {
    for (const fault of ['none', 'audit_engine', 'responsibility', 'unique']) {
        const db = { query: async (s: string, p: any[] = []) => s.includes('information_schema.TABLES') ? p.map(name => ({ name, engine: fault === 'audit_engine' && name === 'audit_events' ? 'MyISAM' : 'InnoDB' })) : s.includes('information_schema.COLUMNS') ? [{ name: 'exam_rubric_awards', col: 'marks', kind: 'json' }, { name: 'exam_grading_control_operations', col: 'result', kind: 'json' }, ...fault === 'responsibility' ? [] : [{ name: 'exam_grading_assignments', col: 'responsible_user_id', kind: 'varchar' }]] : fault === 'unique' ? [] : [...([['exam_grading_assignments', 'primary', ['id']], ['exam_grading_assignments', 'question', ['tenant_id', 'question_ref']], ['exam_rubric_awards', 'primary', ['tenant_id', 'attempt_id', 'question_ref', 'revision']], ['exam_grading_control_operations', 'primary', ['tenant_id', 'operation_id']]] as const).flatMap(([name, ix, keys]) => keys.map((col, n) => ({ name, ix, col, seq: n + 1 })))], execute: async () => { throw Error('Readiness never writes'); } };
        if (fault === 'none')
            await gradingDelegationReady(db as any);
        else
            await assert.rejects(() => gradingDelegationReady(db as any));
    }
});
test('assigned scoring refuses stale transfer/version and another question before accepting criterion marks', () => {
    const scope = { id: 'assignment', tenantId: 'tenant', questionRef: 'question', versionId: 'version', teacherId: 'teacher', version: 4, rubricId: 'rubric', rubric: { criteria: [{ key: 'method', label: 'Method', max_points: '8.00' }], total_points: '8.00' } };
    assert.equal(assignedRubricPoints(scope, { assignment_version: 4, question_ref: 'question', marks: [{ key: 'method', points: '6.00' }] }).points, '6.00');
    for (const patch of [{ assignment_version: 3 }, { question_ref: 'foreign' }, { marks: [{ key: 'method', points: '8.01' }] }])
        assert.throws(() => assignedRubricPoints(scope, { assignment_version: 4, question_ref: 'question', marks: [{ key: 'method', points: '6.00' }], ...patch }));
});
