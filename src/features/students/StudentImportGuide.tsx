import {
  STUDENT_IMPORT_STEPS,
  STUDENT_IMPORT_TEMPLATE_FILENAME,
  STUDENT_IMPORT_TEMPLATE_URL,
  type StudentImportGuide as Guide,
} from './import-guide';

/** A read-only orientation aid; all actions still belong to the existing panel. */
export default function StudentImportGuide({ guide }: { guide: Guide }) {
  return (
    <section aria-label="خطوات استيراد الطلاب" className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-800">ابدأ بملف صغير، خطوة بخطوة</h3>
        <a
          href={STUDENT_IMPORT_TEMPLATE_URL}
          download={STUDENT_IMPORT_TEMPLATE_FILENAME}
          className="rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
        >
          تنزيل قالب CSV فارغ
        </a>
      </div>
      <ol className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {STUDENT_IMPORT_STEPS.map((step, index) => (
          <li
            key={step.id}
            aria-current={guide.step === step.id ? 'step' : undefined}
            className={`rounded-md border px-3 py-2 text-sm ${guide.step === step.id ? 'border-emerald-400 bg-emerald-50 font-semibold text-emerald-900' : 'border-slate-200 bg-white text-slate-600'}`}
          >
            {index + 1}. {step.label}
          </li>
        ))}
      </ol>
      <div
        role="status"
        aria-live="polite"
        className={`text-sm leading-7 ${guide.tone === 'warning' ? 'text-amber-900' : guide.tone === 'success' ? 'text-emerald-800' : 'text-slate-700'}`}
      >
        <p>{guide.message}</p>
        {guide.target && guide.action ? (
          <a className="font-medium underline underline-offset-4" href={`#${guide.target}`}>{guide.action}</a>
        ) : null}
      </div>
      <p className="text-xs leading-6 text-slate-500">القالب عناوين فقط بلا بيانات طلاب. اكتب الهواتف والباركود كنص للحفاظ على الأصفار الأولى.</p>
    </section>
  );
}
