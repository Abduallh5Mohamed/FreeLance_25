import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudentCsv, STUDENT_CSV_COLUMNS } from '../features/students/csv-preview';
import {
  describeStudentImportNextStep,
  STUDENT_IMPORT_TEMPLATE,
  STUDENT_IMPORT_TEMPLATE_FILENAME,
  STUDENT_IMPORT_TEMPLATE_URL,
} from '../features/students/import-guide';

type Input = Parameters<typeof describeStudentImportNextStep>[0];
const ready = (patch: Partial<Input> = {}): Input => ({
  previewPhase: 'ready', hasRows: true, gate: { ok: true, rows: [] },
  serverPhase: 'ready', serverAvailable: true, commitPhase: 'idle',
  hasConfirmedResult: false, ...patch,
});

test('template round-trips through the actual parser with exactly the supported headers and no student rows', () => {
  const parsed = parseStudentCsv(STUDENT_IMPORT_TEMPLATE);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.headers, [...STUDENT_CSV_COLUMNS]);
  assert.deepEqual(parsed.rows, []);
  assert.equal(STUDENT_IMPORT_TEMPLATE.split('\r\n').length, 2);
  assert.equal(STUDENT_IMPORT_TEMPLATE_FILENAME, 'student-import-template.csv');
  assert.equal(decodeURIComponent(STUDENT_IMPORT_TEMPLATE_URL.split(',').slice(1).join(',')), STUDENT_IMPORT_TEMPLATE);
});

test('cleared, empty, refused or reading files never reuse a previous completion as a success', () => {
  for (const previewPhase of ['idle', 'empty', 'error', 'reading'] as const) {
    const guide = describeStudentImportNextStep(ready({ previewPhase, commitPhase: 'committed', hasConfirmedResult: true }));
    assert.equal(guide.step, 'file');
    assert.notEqual(guide.tone, 'success');
  }
  assert.equal(describeStudentImportNextStep(ready({ hasRows: false })).step, 'file');
});

test('a panel with no live decision/commit gate offers no action it cannot record', () => {
  const guide = describeStudentImportNextStep(ready({ gate: null }));
  assert.equal(guide.step, 'review');
  assert.equal(guide.target, null);
});

test('pending, invalid and out-of-bounds decisions route back to review even with a previous server result', () => {
  for (const reason of ['pending-rows', 'invalid-rows', 'too-many-rows', 'value-too-long', 'no-rows'] as const) {
    const guide = describeStudentImportNextStep(ready({ gate: { ok: false, reason, rowNumbers: [2] } }));
    assert.equal(guide.step, 'review');
    assert.equal(guide.target, 'student-import-review');
    assert.match(guide.message, /ليس إثباتًا/);
  }
});

test('absent or stale reconciliation requires an explicit new matching step', () => {
  for (const reason of ['not-reconciled', 'reconciliation-stale'] as const) {
    const guide = describeStudentImportNextStep(ready({ gate: { ok: false, reason, rowNumbers: [] } }));
    assert.equal(guide.step, 'match');
    assert.equal(guide.target, 'student-import-matching');
    assert.notEqual(guide.tone, 'success');
  }
});

test('existing-value warnings never propose merging, overwriting or automatic inclusion', () => {
  const guide = describeStudentImportNextStep(ready({ gate: { ok: false, reason: 'existing-matches', rowNumbers: [3] } }));
  assert.equal(guide.step, 'match');
  assert.match(guide.message, /لا دمج أو استبدال تلقائي/);
});

test('unavailable and in-flight matching never present an all-clear or a callable shortcut', () => {
  const unavailable = describeStudentImportNextStep(ready({ serverAvailable: false }));
  assert.equal(unavailable.step, 'match');
  assert.equal(unavailable.target, null);
  const resolving = describeStudentImportNextStep(ready({ serverPhase: 'resolving' }));
  assert.equal(resolving.step, 'match');
  assert.equal(resolving.target, null);
});

test('failed/malformed matching and a definite write refusal send the operator to matching again', () => {
  for (const serverPhase of ['failed', 'malformed'] as const) {
    assert.equal(describeStudentImportNextStep(ready({ serverPhase })).step, 'match');
  }
  for (const commitPhase of ['conflict', 'rejected'] as const) {
    assert.equal(describeStudentImportNextStep(ready({ commitPhase })).step, 'match');
  }
});

test('a ready gate says confirmation remains explicit and does not claim the rows are saved', () => {
  const guide = describeStudentImportNextStep(ready());
  assert.equal(guide.step, 'confirm');
  assert.equal(guide.target, 'student-import-confirmation');
  assert.notEqual(guide.tone, 'success');
  assert.match(guide.message, /لم يُحفظ الطلاب/);
});

test('in-flight confirmation has no retry shortcut, and uncertain outcomes are never success', () => {
  const submitting = describeStudentImportNextStep(ready({ commitPhase: 'submitting' }));
  assert.equal(submitting.target, null);
  for (const commitPhase of ['failed', 'malformed'] as const) {
    const guide = describeStudentImportNextStep(ready({ commitPhase }));
    assert.equal(guide.tone, 'warning');
    assert.match(guide.message, /قد تكون الدفعة وصلت/);
    assert.match(guide.message, /لا تبدأ ملفًا أو دفعة مختلفة/);
  }
});

test('only a confirmed result gives success, with separate account/enrollment/access next steps', () => {
  assert.notEqual(describeStudentImportNextStep(ready({ commitPhase: 'committed' })).tone, 'success');
  const guide = describeStudentImportNextStep(ready({ commitPhase: 'committed', hasConfirmedResult: true }));
  assert.equal(guide.tone, 'success');
  assert.equal(guide.target, null);
  assert.match(guide.message, /خطوات مستقلة/);
  assert.match(guide.message, /لا تعد إرسال الملف/);
});
