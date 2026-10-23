/**
 * M2-10 — the dedicated private LESSON panel of ONE course unit.
 *
 * The component renders ONLY: it owns no request, no cursor and no decision.
 * The whole request/form/selection lifecycle lives in
 * `src/features/catalog/course-lessons.ts` (the injected controller), and the
 * transport is the canonical one in `src/lib/api-http.ts`. The controller is
 * created once per mount and disposed on unmount, so the private rows, the
 * selection, the drafts and every in-flight reply die with the view.
 *
 * The parent (`CourseUnitManager`) mounts this panel with a `key` of the
 * selected unit id and only for an EXPLICITLY selected unit row, so a different
 * unit is a different controller with a different, immutable (course, unit)
 * binding — and a closed/denied parent never keeps a child alive.
 *
 * Accessibility decisions (Arabic / RTL):
 *  - the panel is opened EXPLICITLY by the user; no lesson request is made for
 *    a viewer who never opens it, and nothing is fetched per unit row;
 *  - every input has a bound `<label htmlFor>`, the selection toggle is a real
 *    button with `aria-pressed`, and the feedback regions are
 *    `aria-live="polite"`;
 *  - busy controls are disabled and every non-submit button carries
 *    `type="button"`, so an archive, a cancel or a paging button can never
 *    submit the open form by accident;
 *  - the close control stays USABLE while a request is on the wire, so a slow
 *    response can always be abandoned;
 *  - a control is disabled only while a mutation is ACTUALLY in flight (the
 *    single mutation flight) or while a form is open. A definite failure — for
 *    example a concurrent-modification conflict — keeps its error message but
 *    never latches the row disabled, so a deliberate retry stays possible
 *    without an unrelated operation first;
 *  - the owner-only nature is a LABEL. The lesson capability is never inferred
 *    from the local role, the profile or the tenant status — the server stays
 *    authoritative and a denial is shown as the server's own message;
 *  - the position is labelled as a DISPLAY position inside the unit: this panel
 *    never unlocks a lesson, publishes content or changes an access right.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  ListOrdered,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  COURSE_LESSON_REORDER_LIMIT,
  createCourseLesson,
  listCourseLessons,
  reorderCourseLessons,
  updateCourseLesson,
} from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  COURSE_LESSON_ARCHIVE_NOTICE,
  COURSE_LESSON_DESCRIPTION_MAX,
  COURSE_LESSON_DUPLICATE_CREATE_WARNING,
  COURSE_LESSON_METADATA_NOTICE,
  COURSE_LESSON_PAGING_NOTICE,
  createCourseLessonController,
  readCourseSessionPrincipal,
  type CourseLessonController,
  type CourseLessonFormState,
  type CourseLessonMutationState,
  type CourseLessonState,
} from './course-lessons';

/** The canonical principal reader, exactly as the accepted courses page uses it. */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

/** The closed form, used before the controller has published its first state. */
const CLOSED_FORM: CourseLessonFormState = {
  mode: 'closed',
  titleDraft: '',
  descriptionDraft: '',
  clearDescription: false,
  orderDraft: '',
  targetId: null,
  targetTitle: null,
  originalTitle: null,
  originalDescription: null,
  originalOrder: null,
  reorderDrafts: [],
  error: null,
};

/** The idle mutation, used before the controller has published its first state. */
const IDLE_MUTATION: CourseLessonMutationState = {
  status: 'idle',
  kind: null,
  targetId: null,
  error: null,
  notice: null,
};

const PHASE_TEXT: Record<CourseLessonState['phase'], string> = {
  idle: 'افتح لوحة الدروس لعرض البيانات.',
  loading: 'جارٍ تحميل دروس الوحدة…',
  ready: '',
  empty: 'لا توجد دروس مسجّلة لهذه الوحدة بعد.',
  error: 'تعذّر تحميل دروس الوحدة.',
  malformed: 'تعذّر تحميل دروس الوحدة: استجابة غير صالحة من الخادم.',
  unauthorized: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى لعرض الدروس.',
  denied: 'إدارة دروس الوحدة متاحة لمالك المؤسسة فقط؛ الخادم هو المرجع.',
  'no-workspace': 'لا توجد مساحة عمل مُصرّح بها مرتبطة بهذا الحساب.',
  'missing-course': 'الكورس غير موجود أو غير متاح في مساحة العمل هذه.',
  'missing-unit': 'الوحدة غير موجودة أو لم تعد متاحة في هذا الكورس.',
};

export default function CourseLessonManager({
  courseId,
  unitId,
  unitName = null,
}: {
  courseId: string;
  unitId: string;
  unitName?: string | null;
}) {
  const controllerRef = useRef<CourseLessonController | null>(null);
  const [snapshot, setSnapshot] = useState<CourseLessonState | null>(null);

  useEffect(() => {
    // One controller per mount, bound to THIS (course, unit) for its whole
    // lifetime. The seam owns the request lifecycle (session fences, stale-reply
    // invalidation, disposal). Disposal retires everything in flight and clears
    // the private rows, the selection and the drafts.
    const controller = createCourseLessonController(courseId, unitId, {
      listLessons: (params) => listCourseLessons(params.courseId, params.unitId, {
        limit: params.limit,
        cursor: params.cursor,
      }),
      createLesson: (boundCourseId, boundUnitId, input) =>
        createCourseLesson(boundCourseId, boundUnitId, input),
      updateLesson: (boundCourseId, boundUnitId, lessonId, update) =>
        updateCourseLesson(boundCourseId, boundUnitId, lessonId, update),
      reorderLessons: (boundCourseId, boundUnitId, items) =>
        reorderCourseLessons(boundCourseId, boundUnitId, items),
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
  }, [courseId, unitId]);

  const state = snapshot;
  const open = state?.open ?? false;
  const phase = state?.phase ?? 'idle';
  const rows = state?.rows ?? [];
  const nextCursor = state?.nextCursor ?? null;
  const hasPreviousPage = state?.hasPreviousPage ?? false;
  const lastConfirmed = state?.lastConfirmed ?? null;
  const lastReorder = state?.lastReorder ?? null;
  const selectedIds = state?.selectedIds ?? [];
  const form = state?.form ?? CLOSED_FORM;
  const mutation = state?.mutation ?? IDLE_MUTATION;
  // The busy state follows the ACTUAL flight, never the historical
  // `mutation.kind`: a definite failure must not latch the controls disabled.
  const busy = mutation.status === 'saving';
  const uncertain = mutation.status === 'uncertain';
  const selectionFull = selectedIds.length >= COURSE_LESSON_REORDER_LIMIT;
  const selectedSet = new Set(selectedIds);

  return (
    <section
      dir="rtl"
      aria-label={unitName ? `دروس الوحدة «${unitName}»` : 'دروس الوحدة'}
      className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3"
    >
      <div className="flex items-center gap-2">
        <ListOrdered className="w-4 h-4 text-indigo-600" />
        <h3 className="text-sm font-semibold text-slate-800">
          دروس الوحدة{unitName ? <> «<span dir="auto">{unitName}</span>»</> : null} (بيانات وصفية خاصة)
        </h3>
      </div>

      <p className="text-xs text-slate-500">
        إدارة الدروس متاحة لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل أي عملية. الخادم هو المرجع،
        وقد لا تكون ميزة الدروس مُفعّلة في هذه البيئة.
      </p>
      <p className="text-xs text-slate-500">{COURSE_LESSON_METADATA_NOTICE}</p>

      {!open ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => { void controllerRef.current?.open(); }}
        >
          <ChevronLeft className="w-4 h-4" />
          فتح لوحة الدروس
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
              درس جديد
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
                <span>تعذّر تحميل دروس الوحدة: {state.error}</span>
              </p>
            ) : null}
            {phase === 'malformed' ? (
              <p className="text-sm text-red-600 flex items-start gap-2">
                <span>{PHASE_TEXT.malformed}</span>
              </p>
            ) : null}
            {phase === 'unauthorized' ||
            phase === 'denied' ||
            phase === 'no-workspace' ||
            phase === 'missing-course' ||
            phase === 'missing-unit' ? (
              <p className="text-sm text-amber-700 flex items-start gap-2">
                <span>{PHASE_TEXT[phase]}</span>
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
                أكّد الخادم آخر عملية على درس «<span dir="auto">{lastConfirmed.title}</span>».
              </p>
            ) : null}
            {lastReorder ? (
              <p className="text-sm text-emerald-700">
                أكّد الخادم ترتيب {lastReorder.selected} درسًا؛ تغيّر موضع {lastReorder.changed} منها.
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
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
              <p className="text-xs text-slate-500">
                {selectedIds.length > 0
                  ? `محدّد للترتيب: ${selectedIds.length} من ${COURSE_LESSON_REORDER_LIMIT}`
                  : 'حدّد صفوفًا من هذه الصفحة لترتيبها معًا.'}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={busy || form.mode !== 'closed' || selectedIds.length === 0}
                onClick={() => controllerRef.current?.openReorderForm()}
              >
                <ListOrdered className="w-4 h-4" />
                ترتيب التحديد
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={busy || form.mode !== 'closed' || selectedIds.length === 0}
                onClick={() => controllerRef.current?.clearSelection()}
              >
                <X className="w-4 h-4" />
                إلغاء التحديد
              </Button>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <ul className="space-y-2">
              {rows.map((row) => {
                const selected = selectedSet.has(row.id);
                return (
                  <li
                    key={row.id}
                    className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate" dir="auto">{row.title}</p>
                      {row.description ? (
                        <p className="text-xs text-slate-600 mt-1 line-clamp-2" dir="auto">
                          {row.description}
                        </p>
                      ) : (
                        <p className="text-xs text-slate-400 mt-1">لا يوجد وصف</p>
                      )}
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
                        variant={selected ? 'default' : 'outline'}
                        size="sm"
                        className="gap-2"
                        aria-pressed={selected}
                        disabled={busy || form.mode !== 'closed' || (!selected && selectionFull)}
                        onClick={() => controllerRef.current?.toggleSelection(row.id)}
                      >
                        <Check className="w-4 h-4" />
                        {selected ? 'محدّد' : 'تحديد'}
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
                );
              })}
            </ul>
          ) : null}

          {form.mode === 'create' || form.mode === 'edit' ? (
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
                <label htmlFor="course-lesson-title" className="block text-sm font-medium text-slate-700">
                  {form.mode === 'create' ? 'عنوان الدرس الجديد' : 'عنوان الدرس'}
                </label>
                <input
                  id="course-lesson-title"
                  type="text"
                  dir="auto"
                  maxLength={255}
                  disabled={busy}
                  value={form.titleDraft}
                  onChange={(event) => controllerRef.current?.updateTitleDraft(event.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                />
              </div>

              <div>
                <label
                  htmlFor="course-lesson-description"
                  className="block text-sm font-medium text-slate-700"
                >
                  وصف الدرس (اختياري)
                </label>
                <textarea
                  id="course-lesson-description"
                  dir="auto"
                  rows={3}
                  maxLength={COURSE_LESSON_DESCRIPTION_MAX}
                  disabled={busy}
                  value={form.descriptionDraft}
                  onChange={(event) =>
                    controllerRef.current?.updateDescriptionDraft(event.target.value)
                  }
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                />
                <label
                  htmlFor="course-lesson-clear-description"
                  className="mt-2 flex items-center gap-2 text-xs text-slate-600"
                >
                  <input
                    id="course-lesson-clear-description"
                    type="checkbox"
                    disabled={busy}
                    checked={form.clearDescription}
                    onChange={(event) =>
                      controllerRef.current?.setClearDescription(event.target.checked)
                    }
                  />
                  مسح الوصف تمامًا (يُرسل null إلى الخادم)
                </label>
              </div>

              <div>
                <label htmlFor="course-lesson-order" className="block text-sm font-medium text-slate-700">
                  موضع العرض داخل الوحدة
                </label>
                <input
                  id="course-lesson-order"
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  disabled={busy}
                  value={form.orderDraft}
                  onChange={(event) => controllerRef.current?.updateOrderDraft(event.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                />
                <p className="text-xs text-slate-500 mt-1">{COURSE_LESSON_METADATA_NOTICE}</p>
              </div>

              {form.mode === 'create' ? (
                <p className="text-xs text-slate-500">{COURSE_LESSON_DUPLICATE_CREATE_WARNING}</p>
              ) : (
                <p className="text-xs text-slate-500">{COURSE_LESSON_ARCHIVE_NOTICE}</p>
              )}

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

          {form.mode === 'reorder' ? (
            <form
              className="space-y-3 border-t border-slate-200 pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void controllerRef.current?.submitReorder();
              }}
            >
              <p className="text-sm font-medium text-slate-700">
                ترتيب الصفوف المحددة (دفعة واحدة ذرّية)
              </p>
              <p className="text-xs text-slate-500">
                تُرسل المواضع في طلب واحد فقط؛ لا تُرسل أي كتابة لكل صف على حدة.
              </p>

              <ul className="space-y-2">
                {form.reorderDrafts.map((draft) => (
                  <li key={draft.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-slate-800 truncate" dir="auto">{draft.title}</p>
                      <p className="text-xs text-slate-400" dir="ltr">{draft.id}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={`course-lesson-reorder-${draft.id}`}
                        className="text-xs text-slate-600"
                      >
                        الموضع
                      </label>
                      <input
                        id={`course-lesson-reorder-${draft.id}`}
                        type="text"
                        inputMode="numeric"
                        dir="ltr"
                        disabled={busy}
                        value={draft.orderDraft}
                        onChange={(event) =>
                          controllerRef.current?.updateReorderDraft(draft.id, event.target.value)
                        }
                        className="w-24 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                      />
                    </div>
                  </li>
                ))}
              </ul>

              <div aria-live="polite" className="space-y-1">
                {busy ? (
                  <p className="text-sm text-slate-500">جارٍ إرسال الدفعة… بانتظار تأكيد الخادم.</p>
                ) : null}
                {form.error ? (
                  <p className="text-sm text-red-600 flex items-start gap-2">
                    <span>{form.error}</span>
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={busy} className="bg-indigo-600 hover:bg-indigo-700">
                  حفظ الترتيب
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
              {rows.length > 0 ? `${rows.length} درسًا في هذه الصفحة` : 'لا توجد صفوف في هذه الصفحة'}
              {nextCursor ? ' — تتوفر صفحة تالية' : ''}
            </p>
          </div>
          <p className="text-xs text-slate-500">{COURSE_LESSON_PAGING_NOTICE}</p>
        </div>
      )}
    </section>
  );
}
