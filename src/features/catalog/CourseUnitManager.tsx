/**
 * M2-09 — the dedicated course-unit metadata panel inside the EXISTING course
 * details dialog.
 *
 * The component renders ONLY: it owns no request, no cursor and no decision.
 * The whole request/form lifecycle lives in `src/features/catalog/course-units.ts`
 * (the injected controller), and the transport is the canonical one in
 * `src/lib/api-http.ts`. The controller is created once per mount and disposed
 * on unmount, so the private rows, the drafts and every in-flight reply die
 * with the view — and because the details dialog mounts the panel with a
 * `key` of the selected course id, a different course is a different
 * controller with a different, immutable course binding.
 *
 * Accessibility decisions (Arabic / RTL):
 *  - the panel is opened EXPLICITLY by the user; no unit request is made for a
 *    viewer who never opens it, and nothing is fetched per course card;
 *  - every input has a bound `<label htmlFor>` and the feedback regions are
 *    `aria-live="polite"`;
 *  - busy controls are disabled and every non-submit button carries
 *    `type="button"`, so an archive, a cancel or a paging button can never
 *    submit the open form by accident;
 *  - the close control stays USABLE while a read is on the wire, so a slow
 *    response can always be abandoned;
 *  - a control is disabled only while a mutation is ACTUALLY in flight (the
 *    single mutation flight) or while a form is open. A definite failure —
 *    for example a concurrent-modification conflict — keeps its error message
 *    but never latches the row disabled, so a deliberate retry stays possible
 *    without an unrelated operation first;
 *  - the owner-only nature is a LABEL. The unit capability is never inferred
 *    from the local role, the profile or the tenant status — the server stays
 *    authoritative and a denial is shown as the server's own message;
 *  - the metadata position is labelled as a DISPLAY position inside the
 *    course: this panel never unlocks a lesson, publishes content or changes
 *    an access right.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ListOrdered,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { createCourseUnit, listCourseUnits, updateCourseUnit } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  COURSE_UNIT_DUPLICATE_CREATE_WARNING,
  COURSE_UNIT_METADATA_NOTICE,
  COURSE_UNIT_PAGING_NOTICE,
  createCourseUnitController,
  readCourseSessionPrincipal,
  type CourseUnitController,
  type CourseUnitState,
} from './course-units';
import CourseLessonManager from './CourseLessonManager';

/** The canonical principal reader, exactly as the accepted courses page uses it. */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const PHASE_TEXT: Record<CourseUnitState['phase'], string> = {
  idle: 'افتح لوحة الوحدات لعرض البيانات.',
  loading: 'جارٍ تحميل وحدات الكورس…',
  ready: '',
  empty: 'لا توجد وحدات مسجّلة لهذا الكورس بعد.',
  error: 'تعذّر تحميل وحدات الكورس.',
  malformed: 'تعذّر تحميل وحدات الكورس: استجابة غير صالحة من الخادم.',
  unauthorized: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى لعرض الوحدات.',
  denied: 'إدارة وحدات الكورس متاحة لمالك المؤسسة فقط؛ الخادم هو المرجع.',
  'no-workspace': 'لا توجد مساحة عمل مُصرّح بها مرتبطة بهذا الحساب.',
  'missing-course': 'الكورس غير موجود أو غير متاح في مساحة العمل هذه.',
};

export default function CourseUnitManager({ courseId }: { courseId: string }) {
  const controllerRef = useRef<CourseUnitController | null>(null);
  const [snapshot, setSnapshot] = useState<CourseUnitState | null>(null);

  useEffect(() => {
    // One controller per mount, bound to THIS course for its whole lifetime.
    // The seam owns the request lifecycle (session fences, stale-reply
    // invalidation, disposal). Disposal retires everything in flight and
    // clears the private rows and drafts.
    const controller = createCourseUnitController(courseId, {
      listUnits: (params) => listCourseUnits(params.courseId, {
        limit: params.limit,
        cursor: params.cursor,
      }),
      createUnit: (boundCourseId, input) => createCourseUnit(boundCourseId, input),
      updateUnit: (boundCourseId, unitId, update) =>
        updateCourseUnit(boundCourseId, unitId, update),
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
  }, [courseId]);

  const state = snapshot;
  const open = state?.open ?? false;
  const phase = state?.phase ?? 'idle';
  const rows = state?.rows ?? [];
  const nextCursor = state?.nextCursor ?? null;
  const hasPreviousPage = state?.hasPreviousPage ?? false;
  const lastConfirmed = state?.lastConfirmed ?? null;
  const form = state?.form ?? {
    mode: 'closed' as const,
    nameDraft: '',
    orderDraft: '',
    targetId: null,
    targetName: null,
    originalName: null,
    originalOrder: null,
    error: null,
  };
  const mutation = state?.mutation ?? {
    status: 'idle' as const,
    kind: null,
    targetId: null,
    error: null,
    notice: null,
  };
  // The busy state follows the ACTUAL flight, never the historical
  // `mutation.kind`: a definite failure must not latch the controls disabled.
  const busy = mutation.status === 'saving';
  const uncertain = mutation.status === 'uncertain';

  // M2-10 — ADDITIVE child view. The unit row the user explicitly selected for
  // lesson management, or null. The accepted unit controller above is NOT
  // touched: this is purely which child panel is mounted.
  const [lessonUnitId, setLessonUnitId] = useState<string | null>(null);

  // The child view is PRIVATE: it must die with the parent panel and with any
  // loss of the private scope, and it must never linger for a row that is no
  // longer on the settled page (a replacement or a removal).
  const privateScopeLost =
    !open ||
    phase === 'unauthorized' ||
    phase === 'denied' ||
    phase === 'no-workspace' ||
    phase === 'missing-course' ||
    phase === 'malformed';

  // Is the selected row still one of the rows this page shows?
  const selectedRowOnPage = rows.some((row) => row.id === lessonUnitId);
  // A transient `loading` phase is NOT a settled page, so it never tears the
  // child down by itself; only a closed panel, a lost scope or a settled page
  // that no longer holds the selected row does.
  const settledWithoutRow = (phase === 'ready' || phase === 'empty') && !selectedRowOnPage;

  // The RENDER-TIME gate. The private child is NOT mounted while the parent
  // scope is lost or while the settled page no longer holds the selected row.
  // The lifetime effect below clears the selection, but an effect runs AFTER the
  // render, so a denied parent (or a removed row) would otherwise paint the
  // private lesson panel for one frame. The gate mirrors the effect EXACTLY, so
  // the rendered child and the cleared selection can never disagree and the
  // child is never remounted from a stale selection.
  const lessonChildVisible =
    lessonUnitId !== null && !privateScopeLost && !settledWithoutRow;
  const visibleLessonUnitId = lessonChildVisible ? lessonUnitId : null;

  useEffect(() => {
    if (lessonUnitId === null) return;
    if (privateScopeLost || settledWithoutRow) {
      setLessonUnitId(null);
    }
  }, [lessonUnitId, privateScopeLost, phase, rows]);

  const lessonUnitName =
    rows.find((row) => row.id === visibleLessonUnitId)?.name ?? null;

  return (
    <section
      dir="rtl"
      aria-label="وحدات الكورس"
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3"
    >
      <div className="flex items-center gap-2">
        <ListOrdered className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-800">وحدات الكورس (بيانات وصفية خاصة)</h3>
      </div>

      <p className="text-xs text-slate-500">
        إدارة وحدات الكورس متاحة لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل أي عملية. الخادم هو
        المرجع، وقد لا تكون ميزة الوحدات مُفعّلة في هذه البيئة.
      </p>
      <p className="text-xs text-slate-500">{COURSE_UNIT_METADATA_NOTICE}</p>

      {!open ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => { void controllerRef.current?.open(); }}
        >
          <ChevronLeft className="w-4 h-4" />
          فتح لوحة الوحدات
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
              تحديث القائمة
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={phase === 'loading' || form.mode !== 'closed'}
              onClick={() => controllerRef.current?.openCreateForm()}
            >
              <Plus className="w-4 h-4" />
              وحدة جديدة
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => controllerRef.current?.close()}
            >
              <X className="w-4 h-4" />
              إغلاق اللوحة
            </Button>
          </div>

          <div aria-live="polite" className="space-y-1">
            {phase === 'loading' ? (
              <p className="text-sm text-slate-500">{PHASE_TEXT.loading}</p>
            ) : null}
            {phase === 'error' && state?.error ? (
              <p className="text-sm text-red-600 flex items-start gap-2">
                <span>تعذّر تحميل وحدات الكورس: {state.error}</span>
              </p>
            ) : null}
            {phase === 'malformed' ? (
              <p className="text-sm text-red-600 flex items-start gap-2">
                <span>{PHASE_TEXT.malformed}</span>
              </p>
            ) : null}
            {phase === 'unauthorized' || phase === 'denied' || phase === 'no-workspace' ? (
              <p className="text-sm text-amber-700 flex items-start gap-2">
                <span>{PHASE_TEXT[phase]}</span>
              </p>
            ) : null}
            {phase === 'missing-course' ? (
              <p className="text-sm text-amber-700 flex items-start gap-2">
                <span>{PHASE_TEXT['missing-course']}</span>
              </p>
            ) : null}
            {phase === 'empty' ? (
              <p className="text-sm text-slate-500">{PHASE_TEXT.empty}</p>
            ) : null}
            {state?.refreshError ? (
              <p className="text-sm text-amber-700">
                تم تأكيد الحفظ على الخادم، لكن تعذّر تحديث القائمة بعدها: {state.refreshError}
              </p>
            ) : null}
            {lastConfirmed ? (
              <p className="text-sm text-emerald-700">
                أكّد الخادم آخر عملية على وحدة «<span dir="auto">{lastConfirmed.name}</span>».
              </p>
            ) : null}
            {mutation.error ? (
              <p className="text-sm text-red-600 flex items-start gap-2">
                <span>تعذّر تنفيذ العملية: {mutation.error}</span>
              </p>
            ) : null}
            {mutation.notice ? (
              <p className="text-sm text-amber-700 flex items-start gap-2">
                <span>{mutation.notice}</span>
              </p>
            ) : null}
          </div>

          {rows.length > 0 ? (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate" dir="auto">{row.name}</p>
                    <p className="text-xs text-slate-400 mt-1" dir="ltr">{row.id}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <Badge variant="outline" dir="auto">
                      الموضع: {row.display_order}
                    </Badge>
                    <Badge variant={row.status === 'active' ? 'default' : 'outline'} dir="auto">
                      {row.status === 'active' ? 'نشط' : 'مؤرشف'}
                    </Badge>
                    <Button
                      type="button"
                      variant={lessonUnitId === row.id ? 'default' : 'outline'}
                      size="sm"
                      className="gap-2"
                      aria-expanded={lessonUnitId === row.id}
                      disabled={busy || form.mode !== 'closed'}
                      onClick={() =>
                        setLessonUnitId((current) => (current === row.id ? null : row.id))
                      }
                    >
                      <ListOrdered className="w-4 h-4" />
                      {lessonUnitId === row.id ? 'إخفاء الدروس' : 'دروس الوحدة'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || form.mode !== 'closed'}
                      onClick={() => controllerRef.current?.openEditForm(row.id)}
                    >
                      <Pencil className="w-4 h-4" />
                      تعديل
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || form.mode !== 'closed'}
                      onClick={() => {
                        void controllerRef.current?.setStatus(
                          row.id,
                          row.status === 'active' ? 'archived' : 'active',
                        );
                      }}
                    >
                      {row.status === 'active' ? (
                        <>
                          <Archive className="w-4 h-4" />
                          أرشفة
                        </>
                      ) : (
                        <>
                          <ArchiveRestore className="w-4 h-4" />
                          إعادة التفعيل
                        </>
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {visibleLessonUnitId ? (
            // Keyed by the selected unit id: a different unit is a different
            // mount (a different controller with an immutable binding), and
            // unmounting is what retires the child's rows, selection and drafts.
            // The child is mounted ONLY while the parent scope is permitted and
            // the selected row is still on the page (the render-time gate).
            <CourseLessonManager
              key={visibleLessonUnitId}
              courseId={courseId}
              unitId={visibleLessonUnitId}
              unitName={lessonUnitName}
            />
          ) : null}

          {form.mode !== 'closed' ? (
            <form
              className="space-y-3 border-t border-slate-200 pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (form.mode === 'create') {
                  void controllerRef.current?.create();
                } else {
                  void controllerRef.current?.save();
                }
              }}
            >
              <div>
                <label htmlFor="course-unit-name" className="block text-sm font-medium text-slate-700">
                  {form.mode === 'create' ? 'اسم الوحدة الجديدة' : 'اسم الوحدة'}
                </label>
                <input
                  id="course-unit-name"
                  type="text"
                  dir="auto"
                  maxLength={255}
                  disabled={busy}
                  value={form.nameDraft}
                  onChange={(event) => controllerRef.current?.updateNameDraft(event.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                />
              </div>

              <div>
                <label htmlFor="course-unit-order" className="block text-sm font-medium text-slate-700">
                  موضع العرض داخل الكورس
                </label>
                <input
                  id="course-unit-order"
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  disabled={busy}
                  value={form.orderDraft}
                  onChange={(event) => controllerRef.current?.updateOrderDraft(event.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                />
                <p className="text-xs text-slate-500 mt-1">
                  {COURSE_UNIT_METADATA_NOTICE}
                </p>
              </div>

              {form.mode === 'create' ? (
                <p className="text-xs text-slate-500">{COURSE_UNIT_DUPLICATE_CREATE_WARNING}</p>
              ) : null}
              {form.mode === 'edit' && form.targetName ? (
                <p className="text-xs text-slate-500">
                  التعديل متاح لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل الحفظ.
                </p>
              ) : null}

              <div aria-live="polite" className="space-y-1">
                {busy ? (
                  <p className="text-sm text-slate-500">جارٍ الحفظ… بانتظار تأكيد الخادم.</p>
                ) : null}
                {form.error ? (
                  <p className="text-sm text-red-600 flex items-start gap-2">
                    <span>{form.error}</span>
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={busy} className="bg-indigo-600 hover:bg-indigo-700">
                  حفظ
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => controllerRef.current?.cancelForm()}
                >
                  إلغاء
                </Button>
              </div>
            </form>
          ) : null}

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
                قراءة القائمة الحالية
              </Button>
              <p className="text-xs text-slate-500">
                القراءة الحالية تعرض الحالة الآن فقط؛ لا تؤكد نجاح الحفظ السابق.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={phase === 'loading' || !hasPreviousPage}
              onClick={() => { void controllerRef.current?.firstPage(); }}
            >
              الصفحة الأولى
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={phase === 'loading' || !nextCursor}
              onClick={() => { void controllerRef.current?.nextPage(); }}
            >
              الصفحة التالية
            </Button>
            <p className="text-xs text-slate-500">
              {rows.length > 0 ? `${rows.length} وحدة في هذه الصفحة` : 'لا توجد صفوف في هذه الصفحة'}
              {nextCursor ? ' — تتوفر صفحة تالية' : ''}
            </p>
          </div>
          <p className="text-xs text-slate-500">{COURSE_UNIT_PAGING_NOTICE}</p>
        </div>
      )}
    </section>
  );
}
