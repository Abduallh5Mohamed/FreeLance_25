import { STUDENT_CSV_COLUMNS, type StudentCsvPreviewPhase } from './csv-preview';
import type { ImportCommitGate, ImportCommitPhase } from './import-commit';
import type { ServerResolutionPhase } from './server-resolution';

/** Header-only, UTF-8 template. No student data, demo identity, or formula. */
export const STUDENT_IMPORT_TEMPLATE_FILENAME = 'student-import-template.csv';
export const STUDENT_IMPORT_TEMPLATE = `\uFEFF${STUDENT_CSV_COLUMNS.join(',')}\r\n`;
export const STUDENT_IMPORT_TEMPLATE_URL =
  `data:text/csv;charset=utf-8,${encodeURIComponent(STUDENT_IMPORT_TEMPLATE)}`;

export const STUDENT_IMPORT_STEPS = [
  { id: 'file', label: 'جهّز الملف' },
  { id: 'review', label: 'راجع الصفوف' },
  { id: 'match', label: 'طابق الموجود' },
  { id: 'confirm', label: 'أكّد الإدخال' },
] as const;

type Step = (typeof STUDENT_IMPORT_STEPS)[number]['id'];
export interface StudentImportGuide {
  readonly step: Step;
  readonly tone: 'info' | 'warning' | 'success';
  readonly message: string;
  /** Navigation only: never performs a reconciliation, confirmation or retry. */
  readonly target: string | null;
  readonly action: string | null;
}

interface GuideInput {
  readonly previewPhase: StudentCsvPreviewPhase;
  readonly hasRows: boolean;
  readonly gate: ImportCommitGate | null;
  readonly serverPhase: ServerResolutionPhase;
  readonly serverAvailable: boolean;
  readonly commitPhase: ImportCommitPhase;
  readonly hasConfirmedResult: boolean;
}

/** Presentation derived afresh from existing controllers. Owns no authority or I/O. */
export function describeStudentImportNextStep(input: GuideInput): StudentImportGuide {
  const { previewPhase, gate, serverPhase, commitPhase } = input;
  if (previewPhase === 'reading') {
    return { step: 'file', tone: 'info', message: 'جارٍ قراءة الملف؛ انتظر ظهور المعاينة قبل المراجعة.', target: null, action: null };
  }
  if (previewPhase !== 'ready' || !input.hasRows) {
    return {
      step: 'file', tone: previewPhase === 'error' ? 'warning' : 'info',
      message: previewPhase === 'error'
        ? 'راجع سبب رفض الملف أدناه، وعدّل نسختك ثم اخترها مرة أخرى. لم تؤكد هذه القراءة إدخال أي طالب.'
        : 'ابدأ بالقالب الفارغ، وأضف بيانات الطلاب ثم اختر الملف. يمكنك تجربة مجموعة صغيرة أولًا.',
      target: 'student-csv-file', action: 'انتقل لاختيار الملف',
    };
  }
  if (gate === null) {
    return { step: 'review', tone: 'info', message: 'المعاينة جاهزة؛ تأكد من اكتمال أدوات المراجعة قبل أي تأكيد.', target: null, action: null };
  }
  if (commitPhase === 'submitting') {
    return { step: 'confirm', tone: 'info', message: 'جارٍ تأكيد الدفعة. انتظر النتيجة ولا تبدأ إدخالًا آخر.', target: null, action: null };
  }
  if (commitPhase === 'committed' && input.hasConfirmedResult) {
    return {
      step: 'confirm', tone: 'success',
      message: 'أكد الخادم حفظ سجلات الطلاب فقط. إنشاء حساب أو إلحاق بمجموعة أو مقرر ومنح الوصول خطوات مستقلة؛ لا تعد إرسال الملف لأجلها.',
      target: null, action: null,
    };
  }
  if (gate.ok === false && !['not-reconciled', 'reconciliation-stale', 'existing-matches'].includes(gate.reason)) {
    return {
      step: 'review', tone: 'warning',
      message: 'احسم الصفوف المعلقة وصحّح الصفوف غير الصالحة، أو استبعد ما تسمح به أدوات المراجعة. تشابه الهاتف ليس إثباتًا أن الطالبين شخص واحد.',
      target: 'student-import-review', action: 'انتقل لمراجعة الصفوف',
    };
  }
  if (!input.serverAvailable) {
    return { step: 'match', tone: 'warning', message: 'المطابقة غير متاحة الآن؛ لا يمكن اعتبار الملف خاليًا من التطابق أو تأكيد إدخاله.', target: null, action: null };
  }
  if (serverPhase === 'resolving') {
    return { step: 'match', tone: 'info', message: 'جارٍ فحص الصفوف المُدرجة لدى الخادم. انتظر النتيجة؛ الفحص لا يُدخل الطلاب.', target: null, action: null };
  }
  if (serverPhase === 'failed' || serverPhase === 'malformed' || gate.ok === false || commitPhase === 'conflict' || commitPhase === 'rejected') {
    return {
      step: 'match', tone: 'warning',
      message: gate.ok === false && gate.reason === 'existing-matches'
        ? 'توجد قيم مطابقة لسجلات المؤسسة. راجع التحذيرات والقرارات أدناه، ثم أعد المطابقة للصفوف الحالية؛ لا دمج أو استبدال تلقائي.'
        : 'يلزم فحص ناجح وحديث للصفوف الحالية. تغيير القرار يلغي صلاحية المطابقة السابقة؛ أعدها بضغطة منك.',
      target: 'student-import-matching', action: 'انتقل للمطابقة',
    };
  }
  if (commitPhase === 'failed' || commitPhase === 'malformed') {
    return {
      step: 'confirm', tone: 'warning',
      message: 'لم تُؤكَّد نتيجة الإدخال؛ قد تكون الدفعة وصلت. راجع حالة العملية أدناه ولا تبدأ ملفًا أو دفعة مختلفة لتجاوز المشكلة.',
      target: 'student-import-confirmation', action: 'راجع حالة الإدخال',
    };
  }
  return {
    step: 'confirm', tone: 'info',
    message: 'الصفوف الحالية اجتازت شروط المراجعة والمطابقة. راجع العدد ثم أكّد مرة واحدة؛ لم يُحفظ الطلاب بهذه المعاينة وحدها.',
    target: 'student-import-confirmation', action: 'انتقل لتأكيد الإدخال',
  };
}
