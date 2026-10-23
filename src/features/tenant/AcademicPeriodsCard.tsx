/**
 * M2-B07 — the dedicated private academic-period planning card on the existing
 * instructor dashboard.
 *
 * The component renders ONLY: it owns no request, no draft and no decision. The
 * whole request/form lifecycle lives in `src/features/tenant/academic-periods.ts`
 * (the injected controller), and the transport is the canonical one in
 * `src/lib/api-http.ts`. The controller is created once per mount and disposed on
 * unmount, so the confirmed rows, the drafts and every in-flight reply die with
 * the view.
 *
 * Accessibility decisions (Arabic / RTL):
 *  - the panel is opened EXPLICITLY by the user; no period request is made for a
 *    viewer who never opens it;
 *  - every input has a bound `<label htmlFor>`, the view toggle is two labelled
 *    buttons with their selected state exposed through `aria-pressed`, and every
 *    feedback region is `aria-live="polite"`;
 *  - the form has exactly ONE `type="submit"` control and every other button
 *    carries `type="button"`, so a page step, an archive or a cancel can never
 *    submit the open form by accident;
 *  - the close control is NEVER disabled, so a pending read can always be
 *    dismissed;
 *  - the dates are rendered as the stored `YYYY-MM-DD` strings in a `dir="ltr"`
 *    span, because a date-only planning label must not be re-formatted into a
 *    locale string that could imply a time or a zone;
 *  - the owner-only nature is a LABEL. The capability is never inferred from the
 *    local role, the profile or the tenant status — the server stays
 *    authoritative and a denial is shown as the server's own message.
 *
 * What this card is NOT: it attaches no enrollment, no student access, no
 * renewal, no payment and no automatic date transition. The wording says so, so
 * a planning period can never be mistaken for an academic-policy change.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  createMyAcademicPeriod,
  listMyAcademicPeriods,
  updateMyAcademicPeriod,
} from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from '@/features/catalog/course-management';
import {
  ACADEMIC_PERIOD_PLANNING_NOTICE,
  ACADEMIC_PERIOD_PAGING_NOTICE,
  createAcademicPeriodController,
  type AcademicPeriodController,
  type AcademicPeriodState,
} from './academic-periods';

/** The canonical principal reader, exactly as the accepted dashboard uses it. */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const PHASE_TEXT: Partial<Record<AcademicPeriodState['phase'], string>> = {
  idle: 'افتح فترات الدراسة لعرض الفهرس.',
  loading: 'جارٍ تحميل فترات الدراسة…',
  empty: 'لا توجد فترات في هذا العرض بعد.',
  error: 'تعذّر تحميل فترات الدراسة.',
  malformed: 'وصلت استجابة غير صالحة من الخادم؛ لم يتم عرض أي فترة.',
  unauthorized: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى لعرض فترات الدراسة.',
  denied: 'إدارة فترات الدراسة متاحة لمالك المؤسسة فقط؛ الخادم هو المرجع.',
  'no-workspace': 'لا توجد مساحة عمل مُصرّح بها مرتبطة بهذا الحساب.',
};

const EMPTY_FORM = {
  mode: 'closed' as const,
  nameDraft: '',
  startsOnDraft: '',
  endsOnDraft: '',
  targetId: null,
  originalName: null,
  originalStartsOn: null,
  originalEndsOn: null,
  error: null,
  notice: null,
};

export default function AcademicPeriodsCard() {
  const controllerRef = useRef<AcademicPeriodController | null>(null);
  const [snapshot, setSnapshot] = useState<AcademicPeriodState | null>(null);

  useEffect(() => {
    // One controller per mount: the seam owns the request lifecycle (session
    // fences, stale-reply invalidation, disposal). Disposal retires everything
    // in flight and clears the private rows and drafts.
    const controller = createAcademicPeriodController({
      listPeriods: (params) => listMyAcademicPeriods(params),
      createPeriod: (input) => createMyAcademicPeriod(input),
      updatePeriod: (id, update) => updateMyAcademicPeriod(id, update),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const state = snapshot;
  const open = state?.open ?? false;
  const phase = state?.phase ?? 'idle';
  const form = state?.form ?? EMPTY_FORM;
  const mutation = state?.mutation ?? { status: 'idle' as const, kind: null, targetId: null, error: null, notice: null };
  const rows = state?.rows ?? [];
  const pagination = state?.pagination ?? { limit: 25, offset: 0, hasMore: false };
  const archivedView = state?.archivedView ?? false;
  const saving = mutation.status === 'saving';
  const uncertain = mutation.status === 'uncertain';
  const formOpen = form.mode !== 'closed';
  const listSettled = phase === 'ready' || phase === 'empty';

  return (
    <Card className="mb-8 border-0 shadow-lg">
      <CardHeader>
        <CardTitle className="text-indigo-700 flex items-center gap-2">
          <CalendarRange className="w-5 h-5" />
          فترات الدراسة (تخطيط)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">
          فهرس تخطيط خاص بمساحة العمل، متاح لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل أي عملية.
        </p>
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          {ACADEMIC_PERIOD_PLANNING_NOTICE}
        </p>

        {!open ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => { void controllerRef.current?.open(); }}
          >
            <CalendarRange className="w-4 h-4" />
            فتح فترات الدراسة
          </Button>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={phase === 'loading'}
                onClick={() => { void controllerRef.current?.refresh(); }}
              >
                <RefreshCw className="w-4 h-4" />
                تحديث
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={saving || !listSettled || formOpen}
                onClick={() => controllerRef.current?.openCreateForm()}
              >
                <Plus className="w-4 h-4" />
                إضافة فترة
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={!archivedView}
                disabled={phase === 'loading' || saving}
                onClick={() => { void controllerRef.current?.setArchivedView(false); }}
              >
                العرض الافتراضي
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={archivedView}
                disabled={phase === 'loading' || saving}
                onClick={() => { void controllerRef.current?.setArchivedView(true); }}
              >
                المؤرشفة
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => controllerRef.current?.close()}
              >
                إغلاق اللوحة
              </Button>
            </div>

            <div aria-live="polite" className="space-y-1">
              {phase === 'loading' ? (
                <p className="text-sm text-slate-500">{PHASE_TEXT.loading}</p>
              ) : null}
              {phase === 'error' && state?.error ? (
                <p className="text-sm text-red-600 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>تعذّر تحميل فترات الدراسة: {state.error}</span>
                </p>
              ) : null}
              {phase === 'malformed' ? (
                <p className="text-sm text-red-600 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{PHASE_TEXT.malformed}</span>
                </p>
              ) : null}
              {phase === 'unauthorized' || phase === 'denied' || phase === 'no-workspace' ? (
                <p className="text-sm text-amber-700 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{PHASE_TEXT[phase]}</span>
                </p>
              ) : null}
              {phase === 'empty' ? (
                <p className="text-sm text-slate-500">{PHASE_TEXT.empty}</p>
              ) : null}
              {state?.refreshError ? (
                <p className="text-sm text-amber-700 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>تم الحفظ، لكن تعذّر تحديث القائمة: {state.refreshError}</span>
                </p>
              ) : null}
              {state?.lastConfirmed ? (
                <p className="text-sm text-emerald-700">
                  أكّد الخادم حفظ الفترة «{state.lastConfirmed.name}».
                </p>
              ) : null}
              {mutation.error ? (
                <p className="text-sm text-red-600 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>تعذّر حفظ الفترة: {mutation.error}</span>
                </p>
              ) : null}
              {mutation.notice ? (
                <p className="text-sm text-amber-700 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{mutation.notice}</span>
                </p>
              ) : null}
            </div>

            {formOpen ? (
              <form
                className="space-y-3 border-t border-slate-200 pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (form.mode === 'create') void controllerRef.current?.create();
                  else void controllerRef.current?.save();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !saving) {
                    event.preventDefault();
                    controllerRef.current?.cancelForm();
                  }
                }}
              >
                <p className="text-sm font-medium text-slate-700">
                  {form.mode === 'create' ? 'فترة جديدة' : 'تعديل الفترة'}
                </p>
                <div className="space-y-1">
                  <label htmlFor="academic-period-name" className="block text-sm font-medium text-slate-700">
                    اسم الفترة
                  </label>
                  <input
                    id="academic-period-name"
                    type="text"
                    dir="auto"
                    maxLength={255}
                    disabled={saving}
                    value={form.nameDraft}
                    onChange={(event) => controllerRef.current?.updateNameDraft(event.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor="academic-period-starts" className="block text-sm font-medium text-slate-700">
                      تاريخ البداية
                    </label>
                    <input
                      id="academic-period-starts"
                      type="text"
                      dir="ltr"
                      inputMode="numeric"
                      placeholder="YYYY-MM-DD"
                      maxLength={10}
                      disabled={saving}
                      value={form.startsOnDraft}
                      onChange={(event) => controllerRef.current?.updateStartsOnDraft(event.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="academic-period-ends" className="block text-sm font-medium text-slate-700">
                      تاريخ النهاية
                    </label>
                    <input
                      id="academic-period-ends"
                      type="text"
                      dir="ltr"
                      inputMode="numeric"
                      placeholder="YYYY-MM-DD"
                      maxLength={10}
                      disabled={saving}
                      value={form.endsOnDraft}
                      onChange={(event) => controllerRef.current?.updateEndsOnDraft(event.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  تواريخ ميلادية فقط بصيغة YYYY-MM-DD، بلا وقت أو منطقة زمنية. يُرسل فقط ما تغيّر فعلًا؛ إن لم
                  يتغيّر شيء فلن يُرسل أي طلب.
                </p>
                <div aria-live="polite" className="space-y-1">
                  {saving ? (
                    <p className="text-sm text-slate-500">جارٍ الحفظ… بانتظار تأكيد الخادم.</p>
                  ) : null}
                  {form.error ? (
                    <p className="text-sm text-red-600 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{form.error}</span>
                    </p>
                  ) : null}
                  {form.notice ? (
                    <p className="text-sm text-slate-600">{form.notice}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={saving} className="bg-indigo-600 hover:bg-indigo-700">
                    {form.mode === 'create' ? 'إضافة الفترة' : 'حفظ التعديل'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => controllerRef.current?.cancelForm()}
                  >
                    إلغاء
                  </Button>
                </div>
              </form>
            ) : null}

            {listSettled && rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-600">
                      <th scope="col" className="py-2 font-medium">الاسم</th>
                      <th scope="col" className="py-2 font-medium">البداية</th>
                      <th scope="col" className="py-2 font-medium">النهاية</th>
                      <th scope="col" className="py-2 font-medium">الحالة</th>
                      <th scope="col" className="py-2 font-medium">إجراءات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className="border-b border-slate-100 align-top">
                        <td className="py-2 text-slate-800">{row.name}</td>
                        <td className="py-2 text-slate-600"><span dir="ltr">{row.starts_on}</span></td>
                        <td className="py-2 text-slate-600"><span dir="ltr">{row.ends_on}</span></td>
                        <td className="py-2">
                          <Badge variant={row.is_archived ? 'outline' : 'default'}>
                            {row.is_archived ? 'مؤرشفة' : 'نشطة'}
                          </Badge>
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              disabled={saving || formOpen}
                              onClick={() => controllerRef.current?.openEditForm(row.id)}
                            >
                              <Pencil className="w-3 h-3" />
                              تعديل
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="gap-1"
                              disabled={saving}
                              onClick={() => { void controllerRef.current?.setArchived(row.id, !row.is_archived); }}
                            >
                              {row.is_archived ? (
                                <>
                                  <ArchiveRestore className="w-3 h-3" />
                                  استعادة
                                </>
                              ) : (
                                <>
                                  <Archive className="w-3 h-3" />
                                  أرشفة
                                </>
                              )}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={phase === 'loading' || saving || !state?.hasPreviousPage}
                  onClick={() => { void controllerRef.current?.previousPage(); }}
                >
                  <ChevronRight className="w-4 h-4" />
                  السابق
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={phase === 'loading' || saving || !pagination.hasMore}
                  onClick={() => { void controllerRef.current?.nextPage(); }}
                >
                  التالي
                  <ChevronLeft className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-slate-500">
                صفحة بحجم <span dir="ltr">{pagination.limit}</span> تبدأ عند{' '}
                <span dir="ltr">{pagination.offset}</span> — {ACADEMIC_PERIOD_PAGING_NOTICE}
              </p>
            </div>

            {uncertain ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={phase === 'loading'}
                  onClick={() => { void controllerRef.current?.reconcile(); }}
                >
                  <RefreshCw className="w-4 h-4" />
                  قراءة الحالة الحالية
                </Button>
                <p className="text-xs text-slate-500">
                  القراءة الحالية تعرض الحالة الآن فقط؛ لا تؤكد نجاح الحفظ السابق.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
