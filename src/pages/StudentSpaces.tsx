import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, GraduationCap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getCurrentStudentEnrollment, getStudentSpaces, selectStudentSpace, type StudentSpace } from '@/lib/api';
import { notifySessionChange } from '@/lib/session-events';
import { createStudentSpacesController, type EnrollmentStorage } from '@/features/enrollment/workflows';

const enrollmentStorage: EnrollmentStorage = {
  getItem: (key) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};

export default function StudentSpaces() {
  const navigate = useNavigate();
  // M2-01: space selection runs through the injected production seam —
  // explicit loading/empty/error states, single-flight selection, and a
  // token-swap guard that never leaves a previous identity beside a new token.
  const controller = useMemo(() => createStudentSpacesController({
    loadSpaces: getStudentSpaces,
    selectSpace: selectStudentSpace,
    loadProfile: getCurrentStudentEnrollment,
  }, {
    storage: enrollmentStorage,
    notify: notifySessionChange,
    onSelected: () => navigate('/student'),
    // External-session boundary: the identity may only be persisted while the
    // token in storage is still the one this selection rotated to (logout in
    // this document, another tab's login or a revocation change it). The value
    // is compared inside the controller and never stored or logged.
    readAuthToken: () => (typeof localStorage === 'undefined' ? null : localStorage.getItem('authToken')),
  }), [navigate]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => { controller.loadSpaces(); }, [controller]);
  useEffect(() => () => controller.dispose(), [controller]);
  return <main className="min-h-screen bg-slate-50 p-4 py-12" dir="rtl"><div className="mx-auto max-w-4xl"><h1 className="mb-2 text-3xl font-bold">اختر مساحة المدرس</h1><p className="mb-8 text-slate-500">كل مساحة منفصلة بمحتواها ومجموعتها وبياناتها.</p>{state.phase === 'loading' && <Card><CardContent className="p-8 text-center text-slate-500">جارٍ تحميل المساحات…</CardContent></Card>}{state.phase === 'error' && <div className="mb-4 space-y-3"><p role="alert" className="rounded bg-red-50 p-3 text-red-700">{state.message}</p><Button type="button" variant="outline" onClick={() => controller.loadSpaces()}>إعادة المحاولة</Button></div>}{state.selectionError && <div className="mb-4 space-y-3 rounded bg-red-50 p-3 text-red-700"><p role="alert">{state.selectionError}</p>{state.pendingIdentityLoad && <Button type="button" size="sm" variant="outline" disabled={state.selectingId !== null} onClick={() => controller.retryIdentityLoad()}>{state.selectingId ? 'جارٍ إعادة المحاولة…' : 'إعادة تحميل بيانات المساحة'}</Button>}</div>}<div className="grid gap-4 md:grid-cols-2">{state.spaces.map(space => <Card key={space.student_enrollment_id}><CardHeader><CardTitle className="flex items-center gap-2"><Building2 />{space.business_name}</CardTitle></CardHeader><CardContent><p className="mb-4 flex items-center gap-2 text-slate-600"><GraduationCap className="h-4 w-4" />{space.grade_name || 'بدون صف'} — {space.group_name || 'بدون مجموعة'}</p><Button className="w-full" disabled={state.selectingId !== null} onClick={() => controller.select(space)}>{state.selectingId === space.student_enrollment_id ? 'جارٍ الفتح…' : 'الدخول للمساحة'}</Button></CardContent></Card>)}</div>{state.phase === 'empty' && state.spaces.length === 0 && <Card><CardContent className="p-8 text-center">لا توجد عضوية مقبولة بعد. انتظر موافقة المدرس أو استخدم رابط الانضمام الخاص به.</CardContent></Card>}</div></main>;
}
