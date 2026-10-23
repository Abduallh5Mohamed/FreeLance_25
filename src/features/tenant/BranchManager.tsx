/**
 * M2-07 — the dedicated branch-management component on the existing
 * instructor dashboard.
 *
 * The component renders ONLY: it owns no request, no cursor and no decision.
 * The whole request/form lifecycle lives in `src/features/tenant/branches.ts`
 * (the injected controller), and the transport is the canonical one in
 * `src/lib/api-http.ts`. The controller is created once per mount and disposed
 * on unmount, so the private rows, the drafts and every in-flight reply die
 * with the view.
 *
 * Accessibility decisions (Arabic / RTL):
 *  - the panel is opened EXPLICITLY by the user; no branch request is made
 *    for a viewer who never opens it;
 *  - every input has a bound `<label htmlFor>` and the feedback regions are
 *    `aria-live="polite"`;
 *  - busy controls are disabled and every non-submit button carries
 *    `type="button"`, so an archive, a cancel or a paging button can never
 *    submit the open form by accident;
 *  - a control is disabled only while a mutation is ACTUALLY in flight (the
 *    single mutation flight) or while a form is open. A definite failure —
 *    for example a concurrent-modification conflict — keeps its error
 *    message but never latches the row disabled, so a deliberate retry stays
 *    possible without an unrelated operation first;
 *  - the owner-only nature is a LABEL. The branch capability is never inferred
 *    from the local role, the profile or the tenant status — the server stays
 *    authoritative and a denial is shown as the server's own message.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Building2,
  ChevronRight,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  assignInstructorBranch,
  createMyTenantBranch,
  listMyTenantBranches,
  listMyTenantInstructorMemberships,
  updateMyTenantBranch,
} from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  BRANCH_DUPLICATE_CREATE_WARNING,
  INSTRUCTOR_SELECTION_INVALID_MESSAGE,
  createTenantBranchController,
  readCourseSessionPrincipal,
  type TenantBranchController,
  type TenantBranchState,
} from './branches';

/** The canonical principal reader, exactly as the accepted dashboard uses it. */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const PHASE_TEXT: Record<TenantBranchState['phase'], string> = {
  idle: 'افتح لوحة الفروع لعرض البيانات.',
  loading: 'جارٍ تحميل الفروع…',
  ready: '',
  empty: 'لا توجد فروع مسجّلة بعد.',
  error: 'تعذّر تحميل الفروع.',
  unauthorized: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى لعرض الفروع.',
  denied: 'إدارة الفروع متاحة لمالك المؤسسة فقط؛ الخادم هو المرجع.',
  'no-workspace': 'لا توجد مساحة عمل مُصرّح بها مرتبطة بهذا الحساب.',
};

export default function BranchManager() {
  const controllerRef = useRef<TenantBranchController | null>(null);
  const [snapshot, setSnapshot] = useState<TenantBranchState | null>(null);

  useEffect(() => {
    // One controller per mount: the seam owns the request lifecycle (session
    // fences, stale-reply invalidation, disposal). Disposal retires everything
    // in flight and clears the private rows and drafts.
    const controller = createTenantBranchController({
      listBranches: (params) => listMyTenantBranches(params),
      createBranch: (name) => createMyTenantBranch(name),
      updateBranch: (branchId, update) => updateMyTenantBranch(branchId, update),
      // M2-B12 — the same controller owns the instructor branch-assignment
      // section, so both surfaces share one principal/session/dispose lifetime
      // and one write latch.
      listInstructorMemberships: (params) => listMyTenantInstructorMemberships(params),
      assignInstructorBranch: (membershipId, branchId) => assignInstructorBranch(membershipId, branchId),
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
  const rows = state?.rows ?? [];
  const nextCursor = state?.nextCursor ?? null;
  const hasPreviousPage = state?.hasPreviousPage ?? false;
  const lastConfirmed = state?.lastConfirmed ?? null;
  const form = state?.form ?? {
    mode: 'closed' as const,
    draft: '',
    targetId: null,
    targetName: null,
    error: null,
  };
  const mutation = state?.mutation ?? {
    status: 'idle' as const,
    kind: null,
    targetId: null,
    error: null,
    notice: null,
  };
  const busy = mutation.status === 'saving';
  const uncertain = mutation.status === 'uncertain';

  // M2-B12 — the instructor section of the same panel.
  const instructors = state?.instructors ?? null;
  const instructorRows = instructors?.rows ?? [];
  const instructorSelection = instructors?.selection ?? null;
  const instructorBusy = instructors?.mutation.status === 'saving';
  const instructorUncertain = instructors?.mutation.status === 'uncertain';
  // The selector offers ONLY the active branches of the CURRENT bounded page:
  // an archived, foreign or unknown id can never be selected here.
  const selectableBranches = rows.filter((row) => row.status === 'active');

  return (
    <Card className="mb-8 border-0 shadow-lg">
      <CardHeader>
        <CardTitle className="text-indigo-700 flex items-center gap-2">
          <Building2 className="w-5 h-5" />
          الفروع
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">
          إدارة الفروع متاحة لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل أي عملية، وقد لا تكون
          ميزة الفروع مُفعّلة في هذه البيئة.
        </p>

        {!open ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => { void controllerRef.current?.open(); }}
          >
            <ChevronRight className="w-4 h-4" />
            فتح لوحة الفروع
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
                فرع جديد
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={phase === 'loading'}
                onClick={() => { void controllerRef.current?.close(); }}
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
                  <span>تعذّر تحميل الفروع: {state.error}</span>
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
              {lastConfirmed ? (
                <p className="text-sm text-emerald-700">
                  أكّد الخادم آخر عملية على فرع «<span dir="auto">{lastConfirmed.name}</span>».
                </p>
              ) : null}
              {mutation.error ? (
                <p className="text-sm text-red-600 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>تعذّر تنفيذ العملية: {mutation.error}</span>
                </p>
              ) : null}
              {mutation.notice ? (
                <p className="text-sm text-amber-700 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
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
                      <Badge variant={row.status === 'active' ? 'default' : 'outline'} dir="auto">
                        {row.status === 'active' ? 'نشط' : 'مؤرشف'}
                      </Badge>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || form.mode !== 'closed'}
                        onClick={() => controllerRef.current?.openRenameForm(row.id)}
                      >
                        <Pencil className="w-4 h-4" />
                        تعديل الاسم
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

            {form.mode !== 'closed' ? (
              <form
                className="space-y-3 border-t border-slate-200 pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (form.mode === 'create') {
                    void controllerRef.current?.create();
                  } else {
                    void controllerRef.current?.saveName();
                  }
                }}
              >
                <label htmlFor="branch-name" className="block text-sm font-medium text-slate-700">
                  {form.mode === 'create' ? 'اسم الفرع الجديد' : 'اسم الفرع'}
                </label>
                <input
                  id="branch-name"
                  type="text"
                  dir="auto"
                  maxLength={255}
                  disabled={busy}
                  value={form.draft}
                  onChange={(event) => controllerRef.current?.updateDraft(event.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                />
                {form.mode === 'rename' && form.targetName ? (
                  <p className="text-xs text-slate-500">
                    تعديل الاسم متاح لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل الحفظ.
                  </p>
                ) : null}
                {form.mode === 'create' ? (
                  <p className="text-xs text-slate-500">{BRANCH_DUPLICATE_CREATE_WARNING}</p>
                ) : null}
                <div aria-live="polite" className="space-y-1">
                  {busy ? (
                    <p className="text-sm text-slate-500">جارٍ الحفظ… بانتظار تأكيد الخادم.</p>
                  ) : null}
                  {form.error ? (
                    <p className="text-sm text-red-600 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
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
                {rows.length > 0 ? `${rows.length} فرع في هذه الصفحة` : 'لا توجد صفوف في هذه الصفحة'}
                {nextCursor ? ' — تتوفر صفحة تالية' : ''}
              </p>
            </div>
          </div>
        )}

        {/* M2-B12 — instructor branch-assignment organization metadata. The
            record answers which active branch of THIS tenant an instructor
            membership is organized under. It changes no role, permission,
            teaching access, course, group, student, enrollment or price, and
            the server stays authoritative for every outcome. */}
        <div className="space-y-3 border-t border-slate-200 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Users className="w-4 h-4" />
              ربط المدربين بالفروع
            </h3>
            {!instructors?.open ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => { void controllerRef.current?.openInstructors(); }}
              >
                <Link2 className="w-4 h-4" />
                عرض المدربين
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => controllerRef.current?.closeInstructors()}
              >
                إغلاق قائمة المدربين
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-500">
            ربط المدرب بالفرع بيانات تنظيمية فقط؛ لا يغيّر الدور أو الصلاحيات أو الوصول أو المقررات أو
            المجموعات أو الطلاب. يتحقق الخادم من ملكية المؤسسة قبل أي عملية.
          </p>

          {instructors?.open ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={instructors.phase === 'loading'}
                  onClick={() => { void controllerRef.current?.refreshInstructors(); }}
                >
                  <RefreshCw className="w-4 h-4" />
                  تحديث قائمة المدربين
                </Button>
              </div>

              <div aria-live="polite" className="space-y-1">
                {instructors.phase === 'loading' ? (
                  <p className="text-sm text-slate-500">جارٍ تحميل المدربين…</p>
                ) : null}
                {instructors.phase === 'error' && instructors.error ? (
                  <p className="text-sm text-red-600 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>تعذّر تحميل المدربين: {instructors.error}</span>
                  </p>
                ) : null}
                {instructors.phase === 'unauthorized'
                  || instructors.phase === 'denied'
                  || instructors.phase === 'no-workspace' ? (
                  <p className="text-sm text-amber-700 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{PHASE_TEXT[instructors.phase]}</span>
                  </p>
                ) : null}
                {instructors.phase === 'empty' ? (
                  <p className="text-sm text-slate-500">لا يوجد مدربون نشطون في هذه المؤسسة.</p>
                ) : null}
                {instructors.lastConfirmed ? (
                  <p className="text-sm text-emerald-700">
                    أكّد الخادم آخر ربط للمدرب «
                    <span dir="auto">{instructors.lastConfirmed.instructor_name}</span>
                    »{instructors.lastConfirmed.branch_name
                      ? <> على فرع «<span dir="auto">{instructors.lastConfirmed.branch_name}</span>».</>
                      : ' بدون فرع.'}
                  </p>
                ) : null}
                {instructors.mutation.error ? (
                  <p className="text-sm text-red-600 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>تعذّر تنفيذ العملية: {instructors.mutation.error}</span>
                  </p>
                ) : null}
                {instructors.mutation.notice ? (
                  <p className="text-sm text-amber-700 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{instructors.mutation.notice}</span>
                  </p>
                ) : null}
              </div>

              {instructorRows.length > 0 ? (
                <ul className="space-y-2">
                  {instructorRows.map((row) => {
                    const selected = instructorSelection?.membershipId === row.membership_id
                      ? instructorSelection.branchId
                      : (row.branch_id ?? '');
                    // A branch recorded earlier and archived since is not in the
                    // selectable list; it stays visible as its own option so the
                    // control never silently misrepresents the stored value.
                    const recordedUnavailable = row.branch_id !== null
                      && !selectableBranches.some((branch) => branch.id === row.branch_id);
                    return (
                      <li
                        key={row.membership_id}
                        className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate" dir="auto">
                            {row.instructor_name}
                          </p>
                          <p className="text-xs text-slate-400 mt-1" dir="ltr">{row.instructor_id}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={row.branch_id ? 'default' : 'outline'} dir="auto">
                            {row.branch_name ?? 'بدون فرع'}
                          </Badge>
                          <label
                            className="sr-only"
                            htmlFor={`instructor-branch-${row.membership_id}`}
                          >
                            الفرع
                          </label>
                          <select
                            id={`instructor-branch-${row.membership_id}`}
                            dir="auto"
                            disabled={instructorBusy || instructors.phase === 'loading'}
                            value={selected}
                            onChange={(event) => controllerRef.current?.selectInstructorBranch(
                              row.membership_id,
                              event.target.value,
                            )}
                            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                          >
                            <option value="">— اختر فرعًا —</option>
                            {recordedUnavailable ? (
                              <option value={row.branch_id as string}>
                                {row.branch_name ?? (row.branch_id as string)}
                              </option>
                            ) : null}
                            {selectableBranches.map((branch) => (
                              <option key={branch.id} value={branch.id}>{branch.name}</option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            size="sm"
                            className="bg-indigo-600 hover:bg-indigo-700"
                            disabled={instructorBusy || instructorSelection?.membershipId !== row.membership_id}
                            onClick={() => { void controllerRef.current?.saveInstructorBranch(); }}
                          >
                            حفظ الربط
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={instructorBusy || row.branch_id === null}
                            onClick={() => { void controllerRef.current?.clearInstructorBranch(row.membership_id); }}
                          >
                            مسح الربط
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {instructorRows.length > 0 || instructors.hasPreviousPage || instructors.nextCursor ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={instructors.phase === 'loading' || !instructors.hasPreviousPage}
                    onClick={() => { void controllerRef.current?.firstInstructorsPage(); }}
                  >
                    الصفحة الأولى
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={instructors.phase === 'loading' || !instructors.nextCursor}
                    onClick={() => { void controllerRef.current?.nextInstructorsPage(); }}
                  >
                    الصفحة التالية
                  </Button>
                  <p className="text-xs text-slate-500">
                    {instructorRows.length > 0
                      ? `${instructorRows.length} مدرب في هذه الصفحة`
                      : 'لا توجد صفوف في هذه الصفحة'}
                    {instructors.nextCursor ? ' — تتوفر صفحة تالية' : ''}
                  </p>
                </div>
              ) : null}

              {instructorUncertain ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={instructors.phase === 'loading'}
                    onClick={() => { void controllerRef.current?.reconcileInstructors(); }}
                  >
                    <RefreshCw className="w-4 h-4" />
                    قراءة القائمة الحالية
                  </Button>
                  <p className="text-xs text-slate-500">
                    القراءة الحالية تعرض الحالة الآن فقط؛ لا تؤكد نجاح الحفظ السابق.
                  </p>
                </div>
              ) : null}

              {instructors.phase === 'ready' && selectableBranches.length === 0 ? (
                <p className="text-xs text-amber-700">{INSTRUCTOR_SELECTION_INVALID_MESSAGE}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
