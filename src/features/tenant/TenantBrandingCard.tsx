/**
 * M2-12 — the dedicated private-branding card on the existing instructor
 * dashboard.
 *
 * The component renders ONLY: it owns no request, no draft and no decision. The
 * whole request/form lifecycle lives in `src/features/tenant/branding.ts` (the
 * injected controller), and the transport is the canonical one in
 * `src/lib/api-http.ts`. The controller is created once per mount and disposed
 * on unmount, so the confirmed branding, the drafts and every in-flight reply
 * die with the view.
 *
 * Accessibility decisions (Arabic / RTL):
 *  - the panel is opened EXPLICITLY by the user; no branding request is made for
 *    a viewer who never opens it;
 *  - every input has a bound `<label htmlFor>`, the inherit controls are real
 *    checkboxes with their own labels, and every feedback region is
 *    `aria-live="polite"`;
 *  - busy controls are disabled and every non-submit button carries
 *    `type="button"`, so a cancel, a preview switch or a reconcile button can
 *    never submit the open form by accident;
 *  - the close control is NEVER disabled, so a pending read can always be
 *    dismissed;
 *  - the preview is clearly labelled as LOCAL and UNSAVED while it shows drafts,
 *    and it renders the Arabic slot RTL and the English slot LTR *inside the
 *    preview only* — the application's own direction, language and theme are
 *    untouched;
 *  - the owner-only nature is a LABEL. The branding capability is never inferred
 *    from the local role, the profile or the tenant status — the server stays
 *    authoritative and a denial is shown as the server's own message;
 *  - the accent color is applied as CSS ONLY after the controller has validated
 *    it as `#RRGGBB`; the value is never injected as raw style text, HTML or a
 *    URL, and no image, font or network resource is fetched.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Palette, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getMyTenantBranding, updateMyTenantBranding } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  buildTenantBrandingPreview,
  createTenantBrandingController,
  readCourseSessionPrincipal,
  type TenantBrandingController,
  type TenantBrandingField,
  type TenantBrandingLocale,
  type TenantBrandingState,
} from './branding';

/** The canonical principal reader, exactly as the accepted dashboard uses it. */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const PHASE_TEXT: Record<TenantBrandingState['phase'], string> = {
  idle: 'افتح إعدادات الهوية لعرض البيانات.',
  loading: 'جارٍ تحميل هوية المساحة…',
  ready: '',
  empty: 'لا توجد هوية مخصّصة محفوظة؛ تُستخدم الهوية الحالية (موروثة).',
  error: 'تعذّر تحميل هوية المساحة.',
  unauthorized: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى لعرض الهوية.',
  denied: 'تخصيص الهوية متاح لمالك المؤسسة فقط؛ الخادم هو المرجع.',
  'no-workspace': 'لا توجد مساحة عمل مُصرّح بها مرتبطة بهذا الحساب.',
};

const LABELS: Record<TenantBrandingField, string> = {
  display_name_ar: 'اسم العرض بالعربية',
  display_name_en: 'اسم العرض بالإنجليزية',
  accent_color: 'اللون المميّز',
};

const HINTS: Record<TenantBrandingField, string> = {
  display_name_ar: 'حتى 255 حرفًا. اتركه «موروثًا» لاستخدام الاسم الحالي.',
  display_name_en: 'حتى 255 حرفًا. اتركه «موروثًا» لاستخدام الاسم الحالي.',
  accent_color: 'بصيغة #RRGGBB، مثل #1D4ED8. اتركه «موروثًا» لعدم تغيير اللون.',
};

export default function TenantBrandingCard() {
  const controllerRef = useRef<TenantBrandingController | null>(null);
  const [snapshot, setSnapshot] = useState<TenantBrandingState | null>(null);

  useEffect(() => {
    // One controller per mount: the seam owns the request lifecycle (session
    // fences, stale-reply invalidation, disposal). Disposal retires everything
    // in flight and clears the private branding and drafts.
    const controller = createTenantBrandingController({
      loadBranding: () => getMyTenantBranding(),
      updateBranding: (update) => updateMyTenantBranding(update),
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
  const form = state?.form ?? {
    mode: 'closed' as const,
    display_name_ar: { inherit: true, text: '' },
    display_name_en: { inherit: true, text: '' },
    accent_color: { inherit: true, text: '' },
    originalAr: null,
    originalEn: null,
    originalAccent: null,
    error: null,
    notice: null,
  };
  const mutation = state?.mutation ?? { status: 'idle' as const, error: null, notice: null };
  const editing = form.mode === 'editing';
  const saving = mutation.status === 'saving';
  const uncertain = mutation.status === 'uncertain';
  const preview = state
    ? buildTenantBrandingPreview(state)
    : { locale: 'ar' as TenantBrandingLocale, displayName: null, accentColor: null, unsaved: false, inherited: true };

  const renderField = (field: TenantBrandingField) => {
    const draft = form[field];
    const inputId = `branding-${field}`;
    const inheritId = `branding-${field}-inherit`;
    return (
      <div key={field} className="space-y-1">
        <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
          {LABELS[field]}
        </label>
        <input
          id={inputId}
          type="text"
          dir="auto"
          maxLength={field === 'accent_color' ? 7 : 255}
          disabled={saving || draft.inherit}
          value={draft.inherit ? '' : draft.text}
          placeholder={field === 'accent_color' ? '#1D4ED8' : ''}
          onChange={(event) => controllerRef.current?.updateDraft(field, event.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
        />
        <div className="flex items-center gap-2">
          <input
            id={inheritId}
            type="checkbox"
            disabled={saving}
            checked={draft.inherit}
            onChange={(event) => controllerRef.current?.setInherit(field, event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          <label htmlFor={inheritId} className="text-xs text-slate-600">
            موروث من الهوية الحالية (بدون قيمة محفوظة)
          </label>
        </div>
        <p className="text-xs text-slate-500">{HINTS[field]}</p>
      </div>
    );
  };

  return (
    <Card className="mb-8 border-0 shadow-lg">
      <CardHeader>
        <CardTitle className="text-indigo-700 flex items-center gap-2">
          <Palette className="w-5 h-5" />
          هوية المساحة المخصّصة
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-slate-500">
          أسماء العرض واللون المميّز متاحة لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل أي عملية. لا
          تغيّر هذه الإعدادات اسم المؤسسة الرسمي ولا الصلاحيات ولا الأسعار.
        </p>

        {!open ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => { void controllerRef.current?.open(); }}
          >
            <Palette className="w-4 h-4" />
            فتح إعدادات الهوية
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
                disabled={phase === 'loading' || editing || (phase !== 'ready' && phase !== 'empty')}
                onClick={() => controllerRef.current?.openEditor()}
              >
                تعديل الهوية
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
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
                  <span>تعذّر تحميل الهوية: {state.error}</span>
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
              {state?.lastConfirmed ? (
                <p className="text-sm text-emerald-700">
                  أكّد الخادم حفظ الهوية
                  {state.lastConfirmed.updated_at ? (
                    <span dir="ltr"> — {state.lastConfirmed.updated_at}</span>
                  ) : null}
                  .
                </p>
              ) : null}
              {mutation.error ? (
                <p className="text-sm text-red-600 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>تعذّر حفظ الهوية: {mutation.error}</span>
                </p>
              ) : null}
              {mutation.notice ? (
                <p className="text-sm text-amber-700 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{mutation.notice}</span>
                </p>
              ) : null}
            </div>

            {editing ? (
              <form
                className="space-y-3 border-t border-slate-200 pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void controllerRef.current?.save();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !saving) {
                    event.preventDefault();
                    controllerRef.current?.cancelEditor();
                  }
                }}
              >
                {renderField('display_name_ar')}
                {renderField('display_name_en')}
                {renderField('accent_color')}
                <p className="text-xs text-slate-500">
                  يُرسل فقط ما تغيّر فعلًا؛ إن لم يتغيّر شيء فلن يُرسل أي طلب.
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
                    حفظ الهوية
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => controllerRef.current?.cancelEditor()}
                  >
                    إلغاء
                  </Button>
                </div>
              </form>
            ) : null}

            {/* LOCAL UNSAVED preview — never a global theme/language change. */}
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-700">معاينة محلية</p>
                <div className="flex items-center gap-2">
                  <Badge variant={preview.unsaved ? 'default' : 'outline'}>
                    {preview.unsaved ? 'غير محفوظة' : 'مطابقة للمحفوظ'}
                  </Badge>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={preview.locale === 'ar'}
                    onClick={() => controllerRef.current?.setPreviewLocale('ar')}
                  >
                    عربي
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={preview.locale === 'en'}
                    onClick={() => controllerRef.current?.setPreviewLocale('en')}
                  >
                    English
                  </Button>
                </div>
              </div>
              <div
                className="mt-3 flex items-center gap-3 rounded-md bg-white p-3"
                dir={preview.locale === 'ar' ? 'rtl' : 'ltr'}
                lang={preview.locale}
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-6 shrink-0 rounded-full border border-slate-200"
                  style={preview.accentColor ? { backgroundColor: preview.accentColor } : undefined}
                />
                <p className="text-base font-bold text-slate-800 truncate" dir="auto">
                  {preview.displayName ?? (preview.inherited ? '— موروث —' : '—')}
                </p>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                هذه معاينة محلية فقط داخل هذه البطاقة؛ لا تغيّر لغة التطبيق أو سمته، ولا تُحفظ حتى تضغط
                «حفظ الهوية».
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
