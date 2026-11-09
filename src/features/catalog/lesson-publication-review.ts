import type { PackageSnapshot, PackageKind } from './lesson-package-preview';

export interface PublicationRow {
  kind: PackageKind; title: string; state: 'blocked' | 'review'; notes: string[];
}
/** Owner reference review only: never infer student eligibility or provider readiness. */
export function reviewLessonPublication(snapshot: PackageSnapshot): PublicationRow[] {
  return [
    ...snapshot.materials.map(row => ({ kind: 'material' as const, title: row.title, state: 'review' as const,
      notes: ['تحقق من نشر المادة في مصدرها.', 'تسليم الملف وفحصه وصلاحية الطالب تحتاج تحققًا مستقلًا.'] })),
    ...snapshot.videos.map(row => ({ kind: 'video' as const, title: row.title ?? 'فيديو غير متاح',
      state: row.video_status === 'ready' ? 'review' as const : 'blocked' as const,
      notes: row.video_status === 'ready' ? ['المعالجة مكتملة؛ التشغيل يتطلب جلسة طالب جديدة وتسليم وسائط جاهزًا.']
        : ['الفيديو غير جاهز أو لم يعد متاحًا؛ لا يمكن اعتبار الحزمة قابلة للتشغيل.'] })),
    ...snapshot.activities.map(row => {
      const notes: string[] = [];
      let blocked = row.source_status !== 'published';
      if (blocked) notes.push(row.source_status === 'draft' ? 'التقييم مسودة؛ انشر المصدر أولًا.' : 'مصدر التقييم لم يعد متاحًا.');
      if (row.audience === 'restricted') notes.push('جمهور مقيد؛ راجع تطابق مجموعة الطالب أو فرعه في المصدر.');
      if (row.kind === 'quiz') {
        if (snapshot.quizPin?.status !== 'published' || snapshot.quizPin.content_id !== row.content_id) {
          blocked = true; notes.push('لا توجد نسخة أسئلة منشورة ومثبتة لهذا المرجع.');
        } else notes.push(`نسخة أسئلة مثبتة: ${snapshot.quizPin.version_number ?? 'غير معروفة'}. بدء الطالب وحفظه وتسليمه يحتاج صلاحية حالية.`);
      } else notes.push('تسليم الواجب يتطلب تخزينًا خاصًا وفحصًا موثوقًا؛ إنشاء المرجع لا يفعلهما.');
      return { kind: row.kind, title: row.title ?? 'تقييم غير متاح', state: blocked ? 'blocked' as const : 'review' as const, notes };
    }),
    ...(snapshot.announcement ? [{ kind: 'announcement' as const, title: snapshot.announcement.title ?? 'إعلان غير متاح',
      state: snapshot.announcement.source_state === 'published' ? 'review' as const : 'blocked' as const,
      notes: [snapshot.announcement.source_state === 'published' ? 'مصدر الإعلان منشور؛ راجع المجموعة والجمهور.' : 'الإعلان مسودة أو مصدره غير متاح.',
        'راجع ظهور الإعلان للطالب منفصلًا؛ نشر المصدر لا يثبت الوصول أو إرسال إشعار.'] }] : []),
  ];
}

export interface PublicationReviewState {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'session-ended'; rows: PublicationRow[]; checkedAt: string | null;
}
export const initialPublicationReview = (): PublicationReviewState => ({ phase: 'idle', rows: [], checkedAt: null });
export function createPublicationReview(deps: { read(signal: AbortSignal): Promise<PackageSnapshot>; readPrincipal(): string | null; subscribeSession(fn: () => void): () => void }) {
  const principal = deps.readPrincipal(), listeners = new Set<(s: PublicationReviewState) => void>();
  let state = initialPublicationReview(), epoch = 0, disposed = false, active: AbortController | null = null;
  const set = (s: PublicationReviewState) => { state = s; if (!disposed) listeners.forEach(fn => fn(s)); };
  const cancel = () => { epoch++; active?.abort(); active = null; };
  const invalidate = () => { cancel(); set({ ...initialPublicationReview(), phase: 'session-ended' }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  return {
    subscribe(fn: (s: PublicationReviewState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
    async refresh() {
      if (disposed || state.phase === 'session-ended') return;
      if (!principal || principal !== deps.readPrincipal()) { invalidate(); return; }
      cancel(); const version = epoch, controller = new AbortController(); active = controller;
      const current = () => !disposed && version === epoch && !controller.signal.aborted;
      set({ ...initialPublicationReview(), phase: 'loading' });
      const timer = setTimeout(() => { if (current()) { cancel(); set({ ...initialPublicationReview(), phase: 'error' }); } }, 25000);
      try {
        const snapshot = await deps.read(controller.signal);
        if (!current()) return;
        if (principal !== deps.readPrincipal()) { invalidate(); return; }
        set({ phase: 'ready', rows: reviewLessonPublication(snapshot), checkedAt: new Date().toISOString() });
      } catch { if (current()) set({ ...initialPublicationReview(), phase: 'error' }); }
      finally { clearTimeout(timer); }
    },
    invalidate,
    dispose() { disposed = true; cancel(); unsubscribe(); listeners.clear(); state = initialPublicationReview(); },
  };
}
