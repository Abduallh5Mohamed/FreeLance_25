/**
 * M2-08/M2-11/M2-17 — the dedicated local student import preview and decision panel.
 *
 * The component renders ONLY: it owns no parse, no read, no decision and no
 * report. The lifecycle lives in `src/features/students/csv-preview.ts` (the
 * accepted preview controller), `src/features/students/xlsx-preview.ts` (the
 * M2-17 bounded local XLSX decoder), `src/features/students/import-resolution.ts`
 * (the M2-11 decision model) and `src/features/students/import-report.ts` (the
 * M2-11 JSON report). All of them are created once per mount and disposed on
 * unmount, so the private rows, the decisions, the report and every in-flight
 * read die with the view.
 *
 * What this panel is NOT (and says so on screen):
 *  - it does NOT validate a phone or an email as an identity: the values are
 *    unverified text taken from the local file;
 *  - it does NOT decide whether a match blocks anything: a match is a warning
 *    that the value already exists, not an identity proof, an import success or
 *    an approval to overwrite;
 *  - it does NOT merge, delete or auto-resolve a candidate: every duplicate
 *    starts PENDING and waits for an explicit decision;
 *  - it does NOT execute a formula, read a cached formula result, or guess a
 *    date or a style: a workbook that carries any of them is refused whole.
 *
 * M2-17: the same panel accepts `.csv` or `.xlsx`. Both formats are decoded
 * locally and produce the SAME canonical preview rows, the same vocabulary and
 * the same decisions, so the reconciliation, review and commit stages below are
 * completely unaware of which format the instructor chose.
 *
 * The two WRITES it can make are both explicit, both one click, and both
 * bounded to the six accepted CSV columns: the M2-14 READ-ONLY reconciliation
 * (which sends three values of the INCLUDED rows and receives the NAMES of the
 * matched fields back — never an existing record's identity) and the M2-16
 * import confirmation (which submits one previously all-clear batch under one
 * idempotency key and creates tenant student rows only — never an account, a
 * login, a password, an invitation, an OTP, an enrollment, an assignment, a
 * payment or any access). Both refuse themselves unless the current decisions
 * and the CURRENT confirmed reconciliation allow them.
 *
 * Accessibility decisions (Arabic / RTL):
 *  - the file selection is EXPLICIT and labelled; the `accept` attribute is a
 *    hint only, the chosen file is validated by its actual content;
 *  - the file input has a bound `<label htmlFor>` and every feedback region
 *    is `aria-live="polite"`;
 *  - every non-submit control carries `type="button"`, so a paging, decision,
 *    reset or close control can never submit anything;
 *  - the close control stays ENABLED while a read is still on the wire: the
 *    user can always close a pending preview, which clears the private rows
 *    immediately and retires the pending result;
 *  - only 25 rows and 25 issues are rendered per page, so the DOM never grows
 *    with the size of the file;
 *  - every value is rendered as text by React: no raw HTML is ever injected.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, FileSpreadsheet, Upload, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { subscribeSessionChange } from '@/lib/session-events';
import { readInstructorSessionPrincipal } from '@/features/enrollment/instructor-students';
import {
  createStudentCsvPreviewController,
  STUDENT_CSV_MAX_BYTES,
  STUDENT_CSV_MAX_CELL_CHARS,
  STUDENT_CSV_MAX_COLUMNS,
  STUDENT_CSV_MAX_RECORDS,
  STUDENT_CSV_PAGE_SIZE,
  type StudentCsvColumn,
  type StudentCsvError,
  type StudentCsvErrorCode,
  type StudentCsvPreviewController,
  type StudentCsvPreviewState,
} from './csv-preview';
import {
  computeBlockingConflicts,
  createImportResolutionController,
  nonIncludedCount,
  type ImportResolutionController,
  type ImportResolutionState,
  type ImportRowStatus,
  type ServerMatchReview,
  type ServerMatchReviewState,
} from './import-resolution';
import {
  createImportReportController,
  type ImportReportController,
  type ImportReportLink,
} from './import-report';
import { resolveStudentImportRows, commitStudentImportBatch } from '@/lib/api-http';
import {
  createServerResolutionController,
  SERVER_RESOLUTION_MESSAGES,
  type ServerResolutionController,
  type ServerResolutionField,
  type ServerResolutionState,
} from './server-resolution';
import {
  createImportCommitController,
  evaluateImportCommitGate,
  IMPORT_COMMIT_MESSAGES,
  type ImportCommitController,
  type ImportCommitGate,
  type ImportCommitRefusal,
  type ImportCommitResult,
  type ImportCommitState,
} from './import-commit';

/** The canonical principal reader, exactly as the accepted page uses it. */
const readPrincipal = (): string | null => {
  try {
    return readInstructorSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const COLUMN_LABELS: Record<StudentCsvColumn, string> = {
  name: 'الاسم',
  email: 'البريد الإلكتروني',
  phone: 'هاتف الطالب',
  guardian_phone: 'هاتف ولي الأمر',
  grade: 'الصف',
  barcode: 'الباركود',
};

const ERROR_HEADLINES: Record<StudentCsvErrorCode, string> = {
  'empty-file': 'الملف فارغ.',
  'unsupported-format': 'صيغة الملف غير مدعومة؛ المتوقّع ملف CSV نصي أو مصنف XLSX.',
  'unsupported-encoding': 'تعذّرت قراءة الملف بترميز UTF-8.',
  'input-too-large': 'حجم الملف أكبر من الحد المسموح.',
  'too-many-records': 'عدد الصفوف أكبر من الحد المسموح.',
  'too-many-columns': 'عدد الأعمدة أكبر من الحد المسموح.',
  'cell-too-long': 'إحدى الخلايا أطول من الحد المسموح.',
  'malformed-quote': 'ترميز الاقتباس في الملف غير صحيح.',
  'unknown-header': 'الملف يحتوي عمودًا غير معروف أو غير مسموح.',
  'empty-header': 'الملف يحتوي عمودًا بلا اسم.',
  'duplicate-header': 'الملف يحتوي عمودًا مكررًا.',
  'missing-name-header': 'الملف لا يحتوي على العمود المطلوب name.',
  'ragged-record': 'صف لا يطابق عدد أعمدة الصف الأول.',
  'read-failed': 'تعذّرت قراءة الملف.',
  'session-changed': 'تغيّرت الجلسة أثناء قراءة الملف.',
  // M2-17: the bounded local XLSX decoder reuses the CSV headlines above for
  // every rule that means the same thing, and adds these for the failures
  // only a spreadsheet container can produce.
  'password-protected': 'المصنف محمي بكلمة مرور.',
  'unreadable-archive': 'تعذّرت قراءة الملف كأرشيف XLSX صالح.',
  'too-many-zip-entries': 'عدد عناصر الأرشيف أكبر من الحد المسموح.',
  'archive-too-large': 'الحجم الكلي للمصنف أكبر من الحد المسموح.',
  'entry-too-large': 'أحد أجزاء الملف أكبر من الحد المسموح.',
  'duplicate-zip-entry': 'الأرشيف يحتوي مسارًا مكررًا.',
  'unsafe-zip-path': 'الأرشيف يحتوي مسارًا غير آمن.',
  'unsupported-compression': 'طريقة ضغط غير مدعومة داخل الأرشيف.',
  'missing-workbook-part': 'المصنف لا يحتوي على جزء workbook.',
  'missing-worksheet': 'تعذّر العثور على ورقة العمل الأولى في المصنف.',
  'malformed-xml': 'أحد أجزاء المصنف غير صالح بنيويًا.',
  'unsupported-workbook-part': 'المصنف يحتوي جزءًا غير مدعوم (ماكرو، رسم، وسائط أو ارتباط خارجي).',
  'formula-cell': 'المصنف يحتوي معادلة؛ المعاينة تقرأ القيم المكتوبة فقط.',
  'unsupported-cell-type': 'المصنف يحتوي خلية من نوع غير مدعوم (قيمة منطقية أو خطأ).',
  'too-many-shared-strings': 'عدد النصوص المشتركة في المصنف أكبر من الحد المسموح.',
};

/** The truthful detail of a refused file, in the user's own language. */
const describeError = (error: StudentCsvError): string => {
  const headline = ERROR_HEADLINES[error.code];
  if (error.code === 'unknown-header' || error.code === 'duplicate-header') {
    return `${headline} العمود «${error.detail ?? ''}» غير مسموح في هذه المعاينة.`;
  }
  if (error.code === 'ragged-record') {
    return `${headline} السطر ${error.detail ?? ''} لا يطابق عدد أعمدة الصف الأول.`;
  }
  if (error.code === 'input-too-large') {
    return `${headline} الحد الأقصى ${STUDENT_CSV_MAX_BYTES} بايت.`;
  }
  if (error.code === 'too-many-records') {
    return `${headline} الحد الأقصى ${STUDENT_CSV_MAX_RECORDS} صف.`;
  }
  if (error.code === 'too-many-columns') {
    return `${headline} الحد الأقصى ${STUDENT_CSV_MAX_COLUMNS} أعمدة.`;
  }
  if (error.code === 'cell-too-long') {
    return `${headline} الحد الأقصى ${STUDENT_CSV_MAX_CELL_CHARS} حرفًا للخلية (السطر ${error.line ?? '—'}).`;
  }
  if (error.code === 'malformed-quote') {
    return `${headline} السطر ${error.line ?? '—'}.`;
  }
  return headline;
};

/** The row references of a duplicate candidate, bounded for the screen. */
const describeRowReferences = (rowNumbers: readonly number[]): string => {
  const shown = rowNumbers.slice(0, 5).join('، ');
  const rest = rowNumbers.length - Math.min(rowNumbers.length, 5);
  return rest > 0 ? `${shown} (+${rest})` : shown;
};

/** The four mutually exclusive row statuses, in the user's own language. */
const STATUS_LABELS: Record<ImportRowStatus, string> = {
  included: 'مُدرَج',
  excluded: 'مستبعَد',
  pending: 'قيد الانتظار',
  invalid: 'غير صالح',
};

const REPORT_FAILURE_TEXT: Record<string, string> = {
  'not-loaded': 'لا توجد بيانات محمّلة لإنشاء تقرير.',
  empty: 'لا توجد صفوف غير مُدرجة لإنشاء تقرير.',
  'too-large': 'حجم التقرير يتجاوز الحد المسموح؛ لم يُنشأ أي ملف.',
  failed: 'تعذّر إنشاء ملف التقرير.',
  'scope-changed': 'تغيّرت الجلسة؛ تم مسح بيانات الملف ولم يُنشأ أي تقرير.',
};

/**
 * The panel only dispatches into a ref that actually holds the seam.
 *
 * A ref is filled by the mount effect, so it is empty on the first render; and
 * a decision or a report must never be sent into a value that is not the seam.
 * The capability check is therefore on the METHODS, not on the presence of an
 * object, so a partially initialized ref can never be called.
 */
const asResolutionSeam = (value: unknown): ImportResolutionController | null =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ImportResolutionController).clear === 'function' &&
  typeof (value as ImportResolutionController).include === 'function'
    ? (value as ImportResolutionController)
    : null;

const asReportSeam = (value: unknown): ImportReportController | null =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ImportReportController).download === 'function' &&
  typeof (value as ImportReportController).retire === 'function' &&
  typeof (value as ImportReportController).dispose === 'function'
    ? (value as ImportReportController)
    : null;

/**
 * The M2-14 reconciliation seam, checked on its METHODS for the same reason:
 * a ref that does not hold the real seam must never receive a click.
 */
const asServerSeam = (value: unknown): ServerResolutionController | null =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ServerResolutionController).resolve === 'function' &&
  typeof (value as ServerResolutionController).retry === 'function' &&
  typeof (value as ServerResolutionController).clear === 'function'
    ? (value as ServerResolutionController)
    : null;

/**
 * The M2-16 import seam, checked on its METHODS for the same reason: a ref that
 * does not hold the real seam must never receive a confirmation.
 */
const asCommitSeam = (value: unknown): ImportCommitController | null =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ImportCommitController).confirm === 'function' &&
  typeof (value as ImportCommitController).clear === 'function' &&
  typeof (value as ImportCommitController).dispose === 'function'
    ? (value as ImportCommitController)
    : null;

/**
 * Why a batch is not confirmable, in the user's own language.
 *
 * The two list reasons that name affected rows state their count, and a
 * reconcile-gate reason explains the exact next step: the confirmation is
 * never merely disabled without a stated reason.
 */
const COMMIT_GATE_TEXT: Record<ImportCommitRefusal, (rowNumbers: readonly number[]) => string> = {
  'no-rows': () => IMPORT_COMMIT_MESSAGES['no-rows'],
  'pending-rows': () => IMPORT_COMMIT_MESSAGES['pending-rows'],
  'invalid-rows': () => IMPORT_COMMIT_MESSAGES['invalid-rows'],
  'too-many-rows': () => IMPORT_COMMIT_MESSAGES['too-many-rows'],
  'out-of-range': () => IMPORT_COMMIT_MESSAGES['out-of-range'],
  'missing-name': () => IMPORT_COMMIT_MESSAGES['missing-name'],
  'value-too-long': () => IMPORT_COMMIT_MESSAGES['value-too-long'],
  'not-reconciled': () => IMPORT_COMMIT_MESSAGES['not-reconciled'],
  'reconciliation-stale': () => IMPORT_COMMIT_MESSAGES['reconciliation-stale'],
  'existing-matches': (rowNumbers) =>
    rowNumbers.length > 0
      ? `${IMPORT_COMMIT_MESSAGES['existing-matches']} الصفوف المتأثرة: ${rowNumbers.join('، ')}.`
      : IMPORT_COMMIT_MESSAGES['existing-matches'],
};

/** Stable empty values, so a panel with no import never allocates per render. */
const EMPTY_COMMIT_STATE: ImportCommitState = {
  phase: 'idle',
  result: null,
  message: null,
  revision: 0,
};
const EMPTY_COMMIT_RESULT: ImportCommitResult | null = null;

/** The three match fields, in the user's own language. */
const MATCH_FIELD_LABELS: Record<ServerResolutionField, string> = {
  email: 'البريد الإلكتروني',
  phone: 'الهاتف',
  barcode: 'الباركود',
};

/**
 * The three review states of a matched row, in the user's own language.
 *
 * The wording keeps the review SEPARATE from the local within-file conflict
 * states: a server match is a warning about an existing value, not a
 * within-file duplicate and not an import outcome.
 */
const SERVER_REVIEW_LABELS: Record<ServerMatchReviewState, string> = {
  pending: 'قيد مراجعة التطابق',
  kept: 'أُبقي مُدرجًا',
  excluded: 'مستبعَد بسبب التطابق',
};

/** Stable empty values, so a panel without a review never allocates per render. */
const EMPTY_REVIEWS: ReadonlyMap<number, ServerMatchReview> = new Map();
const EMPTY_MATCHED_FIELDS: readonly ServerResolutionField[] = [];
const EMPTY_REVIEW_COUNTS = { pending: 0, kept: 0, excluded: 0 } as const;

export default function StudentImportPreview() {
  const controllerRef = useRef<StudentCsvPreviewController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * The M2-11 decision seam. It is created in the same mount effect as the
   * preview controller, so its lifetime is exactly the panel's lifetime. The
   * decision layer is only rendered once this ref exists: a panel that has no
   * model yet must not offer a decision it cannot record.
   */
  const resolutionRef = useRef<ImportResolutionController | null>(null);
  const reportRef = useRef<ImportReportController | null>(null);
  /**
   * The M2-14 reconciliation seam. It lives exactly as long as the panel, so a
   * closed panel can never answer a request that was started before the close.
   */
  const serverRef = useRef<ServerResolutionController | null>(null);
  /**
   * The M2-16 import seam. It lives exactly as long as the panel, so a closed
   * panel can never land a batch that was confirmed before the close.
   */
  const commitRef = useRef<ImportCommitController | null>(null);
  /** Monotonic selection token: a stale read can never load a newer file. */
  const selectionTokenRef = useRef(0);
  const [snapshot, setSnapshot] = useState<StudentCsvPreviewState | null>(null);
  const [resolutionSnapshot, setResolutionSnapshot] = useState<ImportResolutionState | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [serverSnapshot, setServerSnapshot] = useState<ServerResolutionState | null>(null);
  const [commitSnapshot, setCommitSnapshot] = useState<ImportCommitState | null>(null);

  useEffect(() => {
    const controller = createStudentCsvPreviewController({
      // The injected async read seam: the panel reads the local file only.
      // M2-17: the controller asks for TEXT for a CSV file and for BYTES for
      // a spreadsheet container, so neither format is ever decoded through
      // the other's door. The CSV seam is unchanged.
      readFile: (file) => (file as File).text(),
      readBytes: async (file) => {
        const target = file as File;
        if (typeof target.arrayBuffer !== 'function') return new Uint8Array(0);
        return new Uint8Array(await target.arrayBuffer());
      },
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);

    // The decision model shares the panel lifetime and the SAME session
    // notifier, so a logout clears the decisions with the preview.
    const resolution = createImportResolutionController({
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    resolutionRef.current = resolution;
    const unsubscribeResolution = resolution.subscribe(setResolutionSnapshot);

    // The report seam: one object URL per click, revoked on the next tick, on
    // every failure, on replacement and on disposal.
    const report = createImportReportController({
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
      createLink: () => document.createElement('a') as unknown as ImportReportLink,
      schedule: (task) => { setTimeout(task, 0); },
    });
    reportRef.current = report;

    // The M2-14 reconciliation seam: one request in flight, an explicit click
    // only, and the SAME session notifier so a logout drops the results with
    // the preview. It owns no storage and logs nothing.
    const server = createServerResolutionController({
      resolve: (rows) => resolveStudentImportRows(rows),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    serverRef.current = server;
    const unsubscribeServer = server.subscribe(setServerSnapshot);

    // The M2-16 import seam: one submission in flight, an explicit
    // confirmation only, and the SAME session notifier so a logout drops the
    // result with the preview. It writes no storage and logs nothing.
    const commit = createImportCommitController({
      commit: (commitRequest) => commitStudentImportBatch(commitRequest),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    commitRef.current = commit;
    const unsubscribeCommit = commit.subscribe(setCommitSnapshot);

    // A session change retires the outstanding report URL IMMEDIATELY: a
    // download that is still pending must not survive the scope it was made
    // in, and the lost session's report outcome must not stay on screen.
    const unsubscribeReportSession = subscribeSessionChange(() => {
      report.retire();
      setReportMessage(null);
    });

    return () => {
      unsubscribe();
      unsubscribeResolution();
      unsubscribeReportSession();
      unsubscribeServer();
      unsubscribeCommit();
      report.dispose();
      controller.dispose();
      resolution.dispose();
      server.dispose();
      commit.dispose();
      controllerRef.current = null;
      resolutionRef.current = null;
      reportRef.current = null;
      serverRef.current = null;
      commitRef.current = null;
    };
  }, []);

  const state = snapshot;
  const phase = state?.phase ?? 'idle';
  const rows = state?.rows ?? [];
  const visibleRows = state?.visibleRows ?? [];
  const visibleIssues = state?.visibleIssues ?? [];
  const error = state?.error ?? null;
  const reading = phase === 'reading';
  const hasPreview = phase === 'ready' || phase === 'empty';

  /**
   * The decision layer is only trustworthy once the model has been mounted.
   * Before that — and in any environment where the seam was never created —
   * the panel renders the accepted 170 preview unchanged rather than offering
   * a control that cannot record anything.
   */
  const resolutionSeam = asResolutionSeam(resolutionRef.current);
  const resolutionReady = resolutionSeam !== null;
  const resolution = resolutionReady ? resolutionSnapshot : null;
  const showDecisions = resolutionReady && hasPreview && resolution !== null;

  /**
   * The M2-14 reconciliation layer. Like the decision layer it is rendered only
   * once its seam exists, so a panel that cannot record an answer never offers
   * the question.
   */
  const serverSeam = asServerSeam(serverRef.current);
  const serverReady = serverSeam !== null;
  const server = serverReady ? serverSnapshot : null;
  const serverPhase = server?.phase ?? 'idle';
  const serverBusy = serverPhase === 'resolving';
  const serverResult = serverPhase === 'ready' ? server?.result ?? null : null;
  const serverMessage = server?.message ?? null;

  /**
   * M2-15 — the confirmed match set is the ONLY seed of the review, and the
   * review lives in the decision model so it is keyed by physical row number
   * and survives paging.
   */
  const reviewMap: ReadonlyMap<number, ServerMatchReview> = resolution?.serverMatches ?? EMPTY_REVIEWS;
  const reviewCounts = resolution?.serverMatchCounts ?? EMPTY_REVIEW_COUNTS;
  const reviewTotal = reviewCounts.pending + reviewCounts.kept + reviewCounts.excluded;
  const showReviews = showDecisions && reviewTotal > 0;

  /**
   * M2-16 — the import layer. Like every other layer it is rendered only once
   * its seam exists, so a panel that cannot record a confirmation never offers
   * the button. The seam also owns the gate: the CURRENT decisions and the
   * CURRENT confirmed reconciliation are what decide, never a cached value.
   */
  const commitSeam = asCommitSeam(commitRef.current);
  const commitReady = commitSeam !== null;
  const commitState = commitReady ? commitSnapshot : null;
  const commitPhase = commitState?.phase ?? 'idle';
  const commitBusy = commitPhase === 'submitting';
  const commitResult = commitPhase === 'committed' ? commitState?.result ?? EMPTY_COMMIT_RESULT : null;
  const commitMessage = commitState?.message ?? null;
  const showImport = showDecisions && commitReady;
  // The gate is evaluated on EVERY render from the live model and the live
  // reconciliation, so a decision, a review or a retired answer closes the
  // confirmation immediately and states why.
  const commitGate: ImportCommitGate | null = showImport && resolution
    ? evaluateImportCommitGate(resolution.rows, serverResult)
    : null;
  const canConfirm = commitGate !== null && commitGate.ok === true && !commitBusy;
  const gateRefusal = commitGate !== null && commitGate.ok !== true ? commitGate : null;
  const gateText = gateRefusal ? COMMIT_GATE_TEXT[gateRefusal.reason](gateRefusal.rowNumbers) : null;

  /**
   * Seeds the review from the CURRENT confirmed reconciliation and retires it
   * on every other state.
   *
   * `seedServerMatches` is idempotent for the same result, so a re-render never
   * resets a keep/exclude the user already made, and a superseded or retired
   * result can never seed again.
   */
  useEffect(() => {
    const seam = asResolutionSeam(resolutionRef.current);
    if (!seam) return;
    if (serverResult) seam.seedServerMatches(serverResult);
    else seam.clearServerMatches();
    // A NEW reconciliation is a new scope for the import: the confirmation that
    // was made for the previous one is retired with it, because the batch it
    // described is no longer the batch on screen.
    asCommitSeam(commitRef.current)?.clear();
  }, [serverPhase, serverResult]);

  /**
   * A refused file, a closed preview or a lost session drops every decision:
   * the private file metadata they belong to is gone.
   */
  useEffect(() => {
    if (phase === 'idle' || phase === 'error') {
      asResolutionSeam(resolutionRef.current)?.clear();
      // A refused file or a closed preview drops the report metadata too: the
      // outstanding URL of the previous file is retired immediately.
      asReportSeam(reportRef.current)?.retire();
      // The reconciliation results belong to the file that produced them.
      asServerSeam(serverRef.current)?.clear();
      // A refused file drops any confirmed or pending import with it.
      asCommitSeam(commitRef.current)?.clear();
      setReportMessage(null);
    }
  }, [phase]);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0];
    // The input is reset so the same file can be selected again.
    event.target.value = '';
    if (!file) return;
    // A new selection is a NEW file instance: no decision of the previous file
    // may survive into it.
    const token = selectionTokenRef.current + 1;
    selectionTokenRef.current = token;
    asResolutionSeam(resolutionRef.current)?.clear();
    // The replaced file's reconciliation and report never survive the swap.
    asServerSeam(serverRef.current)?.clear();
    // The replaced file's outstanding report URL dies immediately: a new file
    // never inherits a downloadable copy of the previous one.
    asReportSeam(reportRef.current)?.retire();
    // The replaced file's import attempt dies with it: a new file can never
    // reuse the previous batch's key or its recorded result.
    asCommitSeam(commitRef.current)?.clear();
    setReportMessage(null);
    void (async () => {
      await controllerRef.current?.selectFile(file);
      // A newer selection (or a close) owns the panel now: this outcome is
      // stale and must not seed a decision set.
      if (token !== selectionTokenRef.current) return;
      const current = controllerRef.current?.getState();
      if (!current) return;
      if (current.phase === 'ready' || current.phase === 'empty') {
        asResolutionSeam(resolutionRef.current)?.load(current.rows);
      }
    })();
  };

  const closePreview = () => {
    // Retire the pending selection AND the decisions that belong to it.
    selectionTokenRef.current += 1;
    controllerRef.current?.clear();
    asResolutionSeam(resolutionRef.current)?.clear();
    // A close retires a pending reconciliation as well: the answer belongs to
    // the preview the user just closed.
    asServerSeam(serverRef.current)?.clear();
    // A close retires a pending submission too: a batch confirmed before the
    // close must never land on the panel the user has dismissed.
    asCommitSeam(commitRef.current)?.clear();
    // The outstanding report URL dies with the closed preview.
    asReportSeam(reportRef.current)?.retire();
    setReportMessage(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const decide = (rowNumber: number, decision: 'include' | 'exclude') => {
    const seam = asResolutionSeam(resolutionRef.current);
    if (!seam) return;
    // The refusal (with its real row references) is published by the model and
    // rendered from the state; a refused decision changes nothing.
    if (decision === 'include') seam.include(rowNumber);
    else seam.exclude(rowNumber);
    // A decision changes WHICH rows are included, so a previous reconciliation
    // no longer describes the current set and is dropped (and any pending reply
    // is retired rather than allowed to land on the new set).
    asServerSeam(serverRef.current)?.clear();
    // A decision also retires a confirmation: the batch it described is not the
    // batch that would now be submitted.
    asCommitSeam(commitRef.current)?.clear();
  };

  /**
   * One EXPLICIT reconciliation click. Nothing here fires automatically: a file
   * selection, a decision, a reset or a page change never submits anything.
   */
  const reconcile = () => {
    const seam = asServerSeam(serverRef.current);
    const model = asResolutionSeam(resolutionRef.current);
    if (!seam || !model) return;
    // A fresh guarded principal observation BEFORE the request: a silent scope
    // swap must not submit the former scope's private rows.
    if (seam.revalidateScope()) return;
    void seam.resolve(model.getState().rows);
  };

  /** One explicit retry of the SAME submitted rows. */
  const retryReconcile = () => {
    const seam = asServerSeam(serverRef.current);
    if (!seam) return;
    if (seam.revalidateScope()) return;
    void seam.retry();
  };

  /**
   * M2-15 — one explicit review action on ONE matched row.
   *
   * All three act on the PHYSICAL row number, so a decision taken on page 1 is
   * the same decision on page 9. None of them sends a request, downloads a
   * report or changes any row the user did not name.
   */
  const keepMatch = (rowNumber: number) => {
    const seam = asResolutionSeam(resolutionRef.current);
    // A seam that does not carry the review capability offers no review action.
    if (!seam || typeof seam.keepServerMatch !== 'function') return;
    seam.keepServerMatch(rowNumber);
  };

  const excludeMatch = (rowNumber: number) => {
    const seam = asResolutionSeam(resolutionRef.current);
    if (!seam || typeof seam.excludeServerMatch !== 'function') return;
    seam.excludeServerMatch(rowNumber);
    // The decision set changed, so an already-materialized report is stale.
    asReportSeam(reportRef.current)?.retire();
    setReportMessage(null);
  };

  const undoMatch = (rowNumber: number) => {
    const seam = asResolutionSeam(resolutionRef.current);
    if (!seam || typeof seam.undoServerMatch !== 'function') return;
    seam.undoServerMatch(rowNumber);
    // An undo re-includes a row, so the previous document no longer describes
    // the current decision set.
    asReportSeam(reportRef.current)?.retire();
    setReportMessage(null);
  };

  const downloadReport = () => {
    const seam = asResolutionSeam(resolutionRef.current);
    const report = asReportSeam(reportRef.current);
    if (!seam || !report) {
      setReportMessage(REPORT_FAILURE_TEXT.failed);
      return;
    }
    // A FRESH guarded snapshot of the canonical principal, taken BEFORE any
    // report materialization: a silent scope swap (a logout that produced no
    // session event) must never export the former scope's private rows.
    if (seam.revalidateScope()) {
      // The former scope's data is GONE: the preview, the decisions, the
      // report metadata and the pending selection are all dropped, and the
      // action is refused WITHOUT allocating a Blob, a URL or a link.
      controllerRef.current?.clear();
      report.retire();
      selectionTokenRef.current += 1;
      setReportMessage(REPORT_FAILURE_TEXT['scope-changed']);
      return;
    }
    // Built from the CURRENT live decision set, never from a cached document.
    const result = report.download(seam.getState());
    // `in` narrowing (not `ok`) because this project compiles with
    // `strict: false`, where a boolean discriminant is widened to `boolean`.
    if ('reason' in result) {
      setReportMessage(REPORT_FAILURE_TEXT[result.reason] ?? REPORT_FAILURE_TEXT.failed);
      return;
    }
    setReportMessage(
      `تم إنشاء التقرير: ${result.rowCount} صفًا غير مُدرج (${result.bytes} بايت) باسم ${result.filename}.`,
    );
  };

  /**
   * M2-16 — ONE explicit import confirmation.
   *
   * Nothing here fires automatically: the controller re-evaluates the gate from
   * the live decisions and the CURRENT confirmed reconciliation, so a pending
   * row, an invalid row, a retired reconciliation or a single existing match
   * refuses the whole batch before any request is built. A retry of an
   * uncertain outcome re-enters here with the SAME batch, which is what makes
   * the controller reuse the same idempotency key.
   */
  const confirmImport = () => {
    const seam = asCommitSeam(commitRef.current);
    const model = asResolutionSeam(resolutionRef.current);
    if (!seam || !model) return;
    // A fresh guarded principal observation BEFORE the submission: a silent
    // scope swap must never send the former scope's private rows.
    if (seam.revalidateScope()) return;
    void seam.confirm(model.getState().rows, serverResult);
  };

  /**
   * The single close control of the panel. It is ALWAYS enabled while a
   * preview is open OR a read is still on the wire, so a pending read can be
   * closed by the user: the close retires the pending result, clears the
   * private rows immediately and a late reply revives nothing.
   */
  const closeControl = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-2"
      onClick={closePreview}
    >
      <X className="h-4 w-4" />
      إغلاق المعاينة
    </Button>
  );

  const counts = resolution?.counts ?? null;
  const blocking = showDecisions && resolution ? computeBlockingConflicts(resolution) : null;
  const modelRows = showDecisions && resolution
    ? new Map(resolution.rows.map((row) => [row.rowNumber, row]))
    : null;
  const reportText = typeof reportMessage === 'string' ? reportMessage : null;

  return (
    <Card className="mb-6 border-0 shadow-lg" dir="rtl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-emerald-700">
          <FileSpreadsheet className="h-5 w-5" />
          معاينة استيراد الطلاب من ملف CSV أو XLSX
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
          <AlertTriangle className="ml-1 inline h-4 w-4" />
          <strong>معاينة محلية فقط:</strong> لا يُحفظ أي طالب بمجرد قراءة الملف، ولا يُنشأ ولا
          يُعدَّل أي سجل تلقائيًا، ولا استيراد فعلي من تلقاء نفسه. قراءة الملف
          وترميزه والقرارات والتقرير كلها محلية. الاستثناءات صريحة وبضغطة منك فقط:
          «مطابقة الصفوف المُدرجة» ترسل قيم البريد والهاتف والباركود للصفوف المُدرجة وتُعيد أسماء
          الحقول المطابقة بلا أي بيانات عن السجلات الموجودة، و«تأكيد إدخال الطلاب» يُدخل الصفوف
          المُدرجة بعد مطابقة حديثة نظيفة كسجلات طلاب لهذه المؤسسة فقط، بلا حساب ولا تسجيل دخول
          ولا وصول.
        </p>

        <p className="text-sm text-slate-500">
          الأعمدة المقبولة بالإنجليزية: <span dir="ltr">name</span> (مطلوب)،
          و<span dir="ltr">email</span> و<span dir="ltr">phone</span> و
          <span dir="ltr">guardian_phone</span> و<span dir="ltr">grade</span> و
          <span dir="ltr">barcode</span>. أي عمود آخر (كلمة مرور، دور، معرّفات، حالة اعتماد…) يُرفض
          والملف كله. الحد الأقصى {STUDENT_CSV_MAX_BYTES} بايت، {STUDENT_CSV_MAX_RECORDS} صف،
          {STUDENT_CSV_MAX_COLUMNS} أعمدة، و{STUDENT_CSV_MAX_CELL_CHARS} حرفًا للخلية.
        </p>

        <p className="text-sm text-slate-500">
          في مصنف <span dir="ltr">XLSX</span> تُقرأ أول ورقة معلنة فقط، بلا دمج أوراق ولا تنفيذ
          معادلات ولا استخدام نتائج معادلات مخزّنة، والتواريخ والأنماط غير مدعومة. المعاينة لا تفتح
          مصنفًا محميًا بكلمة مرور، ولا مصنفًا يحتوي ماكرو أو رسمًا أو وسائط أو ارتباطًا خارجيًا،
          وأيًّا من هذه يُرفض الملف كله.
        </p>

        <div className="space-y-1">
          <label htmlFor="student-csv-file" className="block text-sm font-medium text-slate-700">
            اختر ملف CSV أو مصنف XLSX من جهازك
          </label>
          <input
            id="student-csv-file"
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={onFileChange}
            disabled={reading}
            className="block w-full rounded-md border border-slate-300 bg-white p-2 text-sm text-slate-700 shadow-sm disabled:bg-slate-100"
          />
        </div>

        <div aria-live="polite" className="space-y-2">
          {reading ? (
            <p className="text-sm text-slate-500">
              <Upload className="ml-1 inline h-4 w-4" />
              جارٍ قراءة الملف محليًا…
            </p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertTriangle className="ml-1 inline h-4 w-4" />
              {describeError(error)}
            </p>
          ) : null}
          {phase === 'empty' ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-slate-500">
              الملف مقروء لكنه لا يحتوي على أي صفوف بيانات بعد صف العناوين.
            </p>
          ) : null}
        </div>

        {reading || hasPreview ? (
          <div className="flex flex-wrap items-center gap-2">
            {closeControl}
          </div>
        ) : null}

        {hasPreview ? (
          <div className="space-y-4 border-t border-slate-200 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" dir="auto">
                {state?.fileName ?? ''}
              </Badge>
              <Badge variant="outline">{rows.length} صف</Badge>
              <Badge variant="outline">{state?.issueCount ?? 0} صف بمشكلة</Badge>
              <Badge variant="outline">{state?.duplicateGroupCount ?? 0} قيمة مكرّرة</Badge>
            </div>

            <p className="text-xs text-slate-500">
              التكرار المعروض داخل هذا الملف فقط (مطابقة تامة بعد إزالة المسافات)؛ لا يعني أن
              السجل غير موجود في المنصة، ولا يتم دمج الصفوف أو حذفها تلقائيًا. لمعرفة ما هو موجود
              مسبقًا في مؤسستك استخدم «مطابقة الصفوف المُدرجة» أدناه.
            </p>

            {showDecisions && counts ? (
              <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="default" dir="auto">مُدرَج: {counts.included}</Badge>
                  <Badge variant="outline" dir="auto">مستبعَد: {counts.excluded}</Badge>
                  <Badge variant="outline" dir="auto">قيد الانتظار: {counts.pending}</Badge>
                  <Badge variant="outline" dir="auto">غير صالح: {counts.invalid}</Badge>
                  <span className="text-xs text-slate-500">
                    المجموع {counts.total} صف؛ الحالات الأربع متنافية وتجمع إلى المجموع.
                  </span>
                </div>

                <p className="text-xs text-slate-500">
                  القرار محلي فقط: الصفوف المكرّرة تبدأ «قيد الانتظار» ولا يُختار أحدها تلقائيًا.
                  لا يمكن إدراج صفين يتشاركان القيمة نفسها في الهاتف أو البريد أو الباركود،
                  والكشف يشمل الملف كله لا الصفحة المعروضة. لا دمج ولا حذف ولا استيراد.
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      asResolutionSeam(resolutionRef.current)?.reset();
                      // A reset changes the included set back, so a previous
                      // reconciliation no longer applies.
                      asServerSeam(serverRef.current)?.clear();
                      // A reset retires a confirmation with the decisions it
                      // was made for.
                      asCommitSeam(commitRef.current)?.clear();
                      // A reset retires the outstanding URL without disposing
                      // the seam: a later valid click may still report.
                      asReportSeam(reportRef.current)?.retire();
                      setReportMessage(null);
                    }}
                  >
                    إعادة ضبط القرارات
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700"
                    disabled={nonIncludedCount(counts) === 0}
                    onClick={downloadReport}
                  >
                    تنزيل تقرير الصفوف غير المُدرجة (JSON) — يحتوي بيانات هذا الملف المحلي
                  </Button>
                </div>

                <div aria-live="polite" className="space-y-1">
                  {resolution?.refusal ? (
                    <p className="text-sm text-red-700">
                      {resolution.refusal.reason === 'conflict'
                        ? `تعذّر إدراج السطر ${resolution.refusal.rowNumber}: يتعارض مع السطر ${resolution.refusal.conflicts
                            .flatMap((conflict) => conflict.rowNumbers)
                            .filter((value, index, all) => all.indexOf(value) === index)
                            .join('، ')} في ${resolution.refusal.conflicts
                            .map((conflict) => COLUMN_LABELS[conflict.field])
                            .join('، ')}. القرارات السابقة محفوظة.`
                        : resolution.refusal.reason === 'invalid-row'
                          ? `السطر ${resolution.refusal.rowNumber} غير صالح ولا يمكن إدراجه.`
                          : `السطر ${resolution.refusal.rowNumber} غير موجود في هذا الملف.`}
                    </p>
                  ) : null}
                  {reportText ? (
                    <p className="text-sm text-slate-600">{reportText}</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {showDecisions && serverReady ? (
              <div className="space-y-3 rounded-lg border border-sky-200 bg-sky-50 p-3">
                <p className="text-sm leading-6 text-sky-900">
                  <strong>مطابقة مع السجلات الموجودة في مؤسستك (قراءة فقط):</strong> عند الضغط تُرسل
                  الصفوف المُدرجة فقط — بلا اسم ولا هاتف ولي الأمر ولا صف — لمعرفة أي قيم البريد
                  والهاتف والباركود موجودة مسبقًا. لا يُنشأ طالب ولا يُعدّل سجل ولا يُمنح وصول،
                  ولا تُستبدل بيانات موجودة. المطابقة تعني «هذه القيمة موجودة عندك» وليست إثبات
                  هوية ولا نجاح استيراد ولا موافقة على الاستبدال.
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="bg-sky-600 hover:bg-sky-700"
                    disabled={!counts || counts.included === 0 || serverBusy}
                    onClick={reconcile}
                  >
                    مطابقة الصفوف المُدرجة مع السجلات الموجودة
                  </Button>
                  {serverPhase === 'failed' || serverPhase === 'malformed' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={serverBusy}
                      onClick={retryReconcile}
                    >
                      إعادة المحاولة
                    </Button>
                  ) : null}
                </div>

                <div aria-live="polite" className="space-y-2">
                  {serverPhase === 'resolving' ? (
                    <p className="text-sm text-slate-600">جارٍ فحص السجلات الموجودة…</p>
                  ) : null}
                  {serverMessage ? (
                    <p
                      className={
                        serverPhase === 'ready'
                          ? 'text-sm text-slate-600'
                          : 'rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900'
                      }
                    >
                      {serverMessage}
                    </p>
                  ) : null}
                  {serverResult ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" dir="auto">تم الفحص: {serverResult.summary.checked}</Badge>
                      <Badge variant="outline" dir="auto">موجود مسبقًا: {serverResult.summary.matched}</Badge>
                      <Badge variant="outline" dir="auto">غير موجود: {serverResult.summary.clear}</Badge>
                      <span className="text-xs text-slate-500">
                        أعداد فقط — لم يُستورد أي طالب ولم يُمنح أي وصول.
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/*
              M2-15 — the SERVER-MATCH REVIEW block.

              It is deliberately a DIFFERENT block (indigo, own heading, own
              counts) from the local within-file conflict block above (slate):
              a within-file duplicate is a property of this file, a server match
              is a value that already exists in the organisation. Neither is an
              import outcome, and neither decides anything automatically.
            */}
            {showReviews ? (
              <div className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                <p className="text-sm leading-6 text-indigo-900">
                  <strong>مراجعة التطابقات مع السجلات الموجودة:</strong> هذه قيم موجودة
                  مسبقًا في مؤسستك، وليست تكرارًا داخل هذا الملف. لا يتغيّر قرار أي صف تلقائيًا:
                  كل صف مطابق يبقى كما هو حتى تختار «إبقاء مُدرجًا» أو «استبعاد بسبب التطابق»،
                  ويمكنك «تراجع» لإعادته إلى قيد المراجعة. لا يُنشأ طالب ولا يُعدّل سجل.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" dir="auto">قيد مراجعة التطابق: {reviewCounts.pending}</Badge>
                  <Badge variant="default" dir="auto">أُبقي مُدرجًا: {reviewCounts.kept}</Badge>
                  <Badge variant="outline" dir="auto">مستبعَد بسبب التطابق: {reviewCounts.excluded}</Badge>
                  <span className="text-xs text-slate-500">
                    المجموع {reviewTotal} صف مطابق؛ الحالات الثلاث متنافية وتجمع إلى المجموع.
                  </span>
                </div>
              </div>
            ) : null}

            {/*
              M2-16 — the IMPORT block.

              Deliberately its own block (emerald), separate from the local
              conflict block, the reconciliation block and the review block: a
              confirmation is the only action in this panel that writes, and it
              writes tenant student rows only. The gate states its reason at all
              times, so the button is never disabled without an explanation.
            */}
            {showImport ? (
              <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-sm leading-6 text-emerald-900">
                  <strong>تأكيد إدخال الطلاب (سجلات طلاب فقط):</strong> تُدخل الصفوف المُدرجة
                  كسجلات طلاب في مؤسستك الحالية داخل دفعة واحدة لا تتجزأ. لا يُنشأ حساب ولا تسجيل
                  دخول ولا كلمة مرور ولا دعوة ولا OTP، ولا تسجيل في مجموعة أو دورة أو فرع، ولا
                  يُعدَّل أي سجل موجود ولا تُستبدل قيمه. يتطلب التأكيد أن تكون كل صفوف الملف
                  محسومة، وأن تكون هناك مطابقة حديثة لهذه الصفوف نفسها أظهرت أن كل القيم غير
                  موجودة؛ وأي قيمة موجودة مسبقًا ترفض الدفعة كاملة. الضغط على الزر هو الطلب:
                  لا يُرسل شيء تلقائيًا.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" dir="auto">
                    الدفعة: {commitGate !== null && commitGate.ok === true ? commitGate.rows.length : counts?.included ?? 0} صف
                  </Badge>
                  {gateText ? (
                    <span className="text-xs text-emerald-900">{gateText}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700"
                    disabled={!canConfirm}
                    onClick={confirmImport}
                  >
                    تأكيد إدخال الطلاب
                  </Button>
                  {commitPhase === 'failed' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canConfirm}
                      onClick={confirmImport}
                    >
                      إعادة المحاولة بنفس الدفعة
                    </Button>
                  ) : null}
                </div>
                <div aria-live="polite" className="space-y-2">
                  {commitBusy ? (
                    <p className="text-sm text-slate-600">جارٍ إدخال الدفعة…</p>
                  ) : null}
                  {commitMessage ? (
                    <p
                      className={
                        commitPhase === 'committed'
                          ? 'text-sm text-emerald-800'
                          : 'rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900'
                      }
                    >
                      {commitMessage}
                    </p>
                  ) : null}
                  {commitResult ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="default" dir="auto">تم إدخال: {commitResult.created}</Badge>
                      <Badge variant="outline" dir="auto">
                        {commitResult.replayed ? 'نتيجة مسجّلة سابقًا' : 'دفعة جديدة'}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        الصفوف المُدخلة: {commitResult.row_numbers.join('، ')} — لا حساب ولا وصول.
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th scope="col" className="px-2 py-1">السطر</th>
                    <th scope="col" className="px-2 py-1">الاسم</th>
                    <th scope="col" className="px-2 py-1">الهاتف</th>
                    <th scope="col" className="px-2 py-1">البريد</th>
                    <th scope="col" className="px-2 py-1">ولي الأمر</th>
                    <th scope="col" className="px-2 py-1">الصف</th>
                    <th scope="col" className="px-2 py-1">الباركود</th>
                    <th scope="col" className="px-2 py-1">ملاحظات</th>
                    {showDecisions ? <th scope="col" className="px-2 py-1">الحالة</th> : null}
                    {showDecisions ? <th scope="col" className="px-2 py-1">القرار</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => {
                    const modelRow = modelRows?.get(row.rowNumber) ?? null;
                    const status: ImportRowStatus = modelRow
                      ? modelRow.status
                      : row.issues.length > 0
                        ? 'invalid'
                        : row.duplicates.length > 0
                          ? 'pending'
                          : 'included';
                    const conflicts = blocking?.get(row.rowNumber) ?? [];
                    /**
                     * The review is read through the MAP (keyed by the physical
                     * row number), never through the page: a match found on page
                     * 1 is still the same match on page 9. A stale generation
                     * returns null, so a retired reconciliation can never paint
                     * a warning onto the current set.
                     */
                    const review: ServerMatchReview | null = reviewMap.get(row.rowNumber) ?? null;
                    const matchedFields: readonly ServerResolutionField[] =
                      review?.matched_fields ?? EMPTY_MATCHED_FIELDS;
                    return (
                      <tr key={row.rowNumber} className="border-t border-slate-100">
                        <td className="px-2 py-1 text-slate-400">{row.rowNumber}</td>
                        <td className="px-2 py-1" dir="auto">{row.name}</td>
                        <td className="px-2 py-1" dir="ltr">{row.phone}</td>
                        <td className="px-2 py-1" dir="ltr">{row.email}</td>
                        <td className="px-2 py-1" dir="ltr">{row.guardian_phone}</td>
                        <td className="px-2 py-1" dir="auto">{row.grade}</td>
                        <td className="px-2 py-1" dir="ltr">{row.barcode}</td>
                        <td className="px-2 py-1">
                          {row.issues.map((issue) => (
                            <p key={`issue-${issue.rowNumber}`} className="text-xs text-red-700">
                              الاسم مطلوب في هذا الصف.
                            </p>
                          ))}
                          {row.duplicates.map((candidate) => (
                            <p
                              key={`duplicate-${candidate.field}-${candidate.value}`}
                              className="text-xs text-amber-700"
                            >
                              تكرار محتمل في {COLUMN_LABELS[candidate.field]}:{' '}
                              <span dir="ltr">{candidate.value}</span> (السطور{' '}
                              {describeRowReferences(candidate.rowNumbers)})
                            </p>
                          ))}
                          {matchedFields.length > 0 ? (
                            <p className="text-xs text-sky-700">
                              موجود مسبقًا في مؤسستك:{' '}
                              {matchedFields.map((field) => MATCH_FIELD_LABELS[field]).join('، ')}
                              {' '}— تنبيه فقط، وليس إثبات هوية ولا استيرادًا.
                              {review ? (
                                <span className="text-slate-600">
                                  {' '}حالة المراجعة: {SERVER_REVIEW_LABELS[review.review]}.
                                </span>
                              ) : null}
                            </p>
                          ) : null}
                        </td>
                        {showDecisions ? (
                          <td className="px-2 py-1">
                            <Badge
                              variant={status === 'included' ? 'default' : 'outline'}
                              dir="auto"
                            >
                              {STATUS_LABELS[status]}
                            </Badge>
                            {conflicts.length > 0 ? (
                              <p className="mt-1 text-xs text-red-700">
                                يتعارض مع السطر{' '}
                                {conflicts
                                  .flatMap((conflict) => conflict.rowNumbers)
                                  .filter((value, index, all) => all.indexOf(value) === index)
                                  .join('، ')}
                              </p>
                            ) : null}
                          </td>
                        ) : null}
                        {showDecisions ? (
                          <td className="px-2 py-1">
                            {status === 'invalid' ? (
                              <span className="text-xs text-red-700">غير قابل للإدراج</span>
                            ) : (
                              <div className="flex flex-wrap gap-1">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={status === 'included'}
                                  onClick={() => decide(row.rowNumber, 'include')}
                                >
                                  إدراج
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={status === 'excluded'}
                                  onClick={() => decide(row.rowNumber, 'exclude')}
                                >
                                  استبعاد
                                </Button>
                              </div>
                            )}
                            {/*
                              The M2-15 review controls of a MATCHED row. They
                              are a SEPARATE group from the plain include/exclude
                              above: the plain decision is about this file's
                              within-file duplicates, while these three are about
                              a value that already exists in the organisation.
                              Every one is an explicit `type="button"`; none of
                              them submits, requests or downloads.
                            */}
                            {review ? (
                              <div
                                className="mt-1 flex flex-wrap gap-1 border-t border-indigo-200 pt-1"
                                data-review-row={row.rowNumber}
                              >
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={review.review !== 'pending'}
                                  onClick={() => keepMatch(row.rowNumber)}
                                >
                                  إبقاء مُدرجًا
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={review.review !== 'pending'}
                                  onClick={() => excludeMatch(row.rowNumber)}
                                >
                                  استبعاد بسبب التطابق
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={review.review === 'pending'}
                                  onClick={() => undoMatch(row.rowNumber)}
                                >
                                  تراجع
                                </Button>
                              </div>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={state?.rowPage === 0}
                onClick={() => controllerRef.current?.previousRowPage()}
              >
                <ChevronRight className="h-4 w-4" />
                السابقة
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={(state?.rowPage ?? 0) + 1 >= Math.ceil(rows.length / STUDENT_CSV_PAGE_SIZE)}
                onClick={() => controllerRef.current?.nextRowPage()}
              >
                <ChevronLeft className="h-4 w-4" />
                التالية
              </Button>
              <p className="text-xs text-slate-500">
                الصفحة {(state?.rowPage ?? 0) + 1} من {Math.max(1, Math.ceil(rows.length / STUDENT_CSV_PAGE_SIZE))}
                {' '}- يعرض {STUDENT_CSV_PAGE_SIZE} صفًا كحد أقصى.
              </p>
            </div>

            {visibleIssues.length > 0 ? (
              <div className="space-y-2 border-t border-slate-200 pt-4">
                <h3 className="text-sm font-medium text-slate-700">صفوف بها مشكلات</h3>
                <ul className="space-y-1">
                  {visibleIssues.map((issue) => (
                    <li key={`issue-list-${issue.rowNumber}`} className="text-xs text-red-700">
                      السطر {issue.rowNumber}: الاسم مطلوب.
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={state?.issuePage === 0}
                    onClick={() => controllerRef.current?.previousIssuePage()}
                  >
                    السابقة
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={(state?.issuePage ?? 0) + 1 >= Math.ceil((state?.issueCount ?? 0) / STUDENT_CSV_PAGE_SIZE)}
                    onClick={() => controllerRef.current?.nextIssuePage()}
                  >
                    التالية
                  </Button>
                  <p className="text-xs text-slate-500">
                    {state?.issueCount ?? 0} صف بمشكلة.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
