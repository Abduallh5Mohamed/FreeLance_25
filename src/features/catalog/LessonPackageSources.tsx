import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { createPackageSources, initialPackageSources, packageSourceTransport, type PackageSourceState } from './lesson-package-sources';
export function LessonPackageSources({ courseId, destinationId, renderSource }: {
    courseId: string;
    destinationId: string;
    renderSource: (source: {
        unitId: string;
        lessonId: string;
        title: string;
    }, onLockChange: (locked: boolean) => void) => ReactNode;
}) {
    const [state, setState] = useState<PackageSourceState>(initialPackageSources);
    const ref = useRef<ReturnType<typeof createPackageSources> | null>(null);
    const onLockChange = useCallback((locked: boolean) => ref.current?.setLocked(locked), []);
    useEffect(() => {
        const controller = createPackageSources({ ...packageSourceTransport(courseId), destinationId,
            readPrincipal: () => { try {
                return readCourseSessionPrincipal(localStorage);
            }
            catch {
                return null;
            } }, subscribeSession: subscribeSessionChange });
        ref.current = controller;
        const unsubscribe = controller.subscribe(setState);
        const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(event.key))
            controller.invalidate(); };
        window.addEventListener('storage', storage);
        void controller.firstUnits();
        return () => { window.removeEventListener('storage', storage); unsubscribe(); controller.dispose(); ref.current = null; };
    }, [courseId, destinationId]);
    const disabled = state.locked || state.phase === 'loading' || state.phase === 'session-ended';
    return <section dir="rtl" aria-label="اختيار مصدر الحزمة من وحدات المقرر" className="mt-3 space-y-3 rounded border p-3 text-sm">
    <p>اختر الوحدة ثم الحصة المصدر من نفس المقرر. القوائم تُقرأ صفحة واحدة كل مرة، وقد يتغير ترتيبها؛ تغيير الوحدة أو الصفحة أو الحصة يمسح المقارنة والمراجعة السابقة.</p>
    <label>الوحدة المصدر<select className="block w-full rounded border p-2" value={state.unitId ?? ''} disabled={disabled} onChange={e => { void ref.current?.chooseUnit(e.target.value); }}>
      <option value="">اختر الوحدة</option>{state.units.map(row => <option key={row.id} value={row.id} disabled={row.status !== 'active'}>{row.title}{row.status === 'archived' ? ' — مؤرشفة' : ''}</option>)}
    </select></label>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled} onClick={() => { void ref.current?.firstUnits(); }}>أول صفحة وحدات وتحديث المصدر</Button>
      <Button type="button" variant="outline" disabled={disabled || !state.unitCursor || state.phase !== 'ready'} onClick={() => { void ref.current?.nextUnits(); }}>الوحدات التالية</Button></div>
    {state.unitId ? <><label>الحصة المصدر في الوحدة<select className="block w-full rounded border p-2" value={state.chosen?.lessonId ?? ''} disabled={disabled || state.phase !== 'ready'} onChange={e => ref.current?.chooseLesson(e.target.value)}>
      <option value="">اختر الحصة</option>{state.lessons.map(row => <option key={row.id} value={row.id} disabled={row.status !== 'active' || row.id.toLowerCase() === destinationId.toLowerCase()}>{row.title}{row.status === 'archived' ? ' — مؤرشفة' : row.id.toLowerCase() === destinationId.toLowerCase() ? ' — الحصة الوجهة' : ''}</option>)}
    </select></label>
    <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled} onClick={() => { void ref.current?.firstLessons(); }}>أول صفحة حصص وتحديث المصدر</Button>
      <Button type="button" variant="outline" disabled={disabled || !state.lessonCursor || state.phase !== 'ready'} onClick={() => { void ref.current?.nextLessons(); }}>الحصص التالية</Button></div></> : null}
    <div aria-live="polite">{state.phase === 'loading' ? <p role="status">جارٍ قراءة صفحة المصادر…</p> : null}
      {state.phase === 'error' ? <p role="alert">تعذر التحقق من صفحة المصادر. أُزيل الاختيار السابق؛ حدّث الصفحة المطلوبة أو اختر وحدة أخرى.</p> : null}
      {state.phase === 'session-ended' ? <p role="alert">تغيرت الجلسة وأُخفيت المصادر؛ افتح الحصص من جديد.</p> : null}
      {state.phase === 'ready' && !state.units.length ? <p>لا توجد وحدات في هذه الصفحة.</p> : null}
      {state.phase === 'ready' && state.unitId && !state.lessons.length ? <p>لا توجد حصص في هذه الصفحة.</p> : null}
      {state.locked ? <p role="status">تغيير المصدر متوقف أثناء الحفظ أو التحقق من نتيجته. إغلاق اللوحة أو الصفحة لا يلغي كتابة وصلت للخادم.</p> : null}
    </div>
    {state.chosen ? renderSource(state.chosen, onLockChange) : null}
  </section>;
}
