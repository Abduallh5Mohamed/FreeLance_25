import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, GraduationCap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getStudentSpaces, selectStudentSpace, type StudentSpace } from '@/lib/api';

export default function StudentSpaces() {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<StudentSpace[]>([]);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selecting = useRef(false);
  const generation = useRef(0);
  const load = async () => {
    const current = ++generation.current;
    setLoading(true); setError(''); setSpaces([]);
    try {
      const next = await getStudentSpaces();
      if (!Array.isArray(next) || next.some(space => !space || typeof space.student_enrollment_id !== 'string'
        || !space.student_enrollment_id || typeof space.tenant_id !== 'string' || !space.tenant_id
        || typeof space.business_name !== 'string')) throw new Error('تعذّر تأكيد قائمة المساحات');
      if (current === generation.current) setSpaces(next);
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'تعذر تحميل المساحات'); }
    finally { if (current === generation.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { generation.current += 1; }; }, []);
  const select = async (space: StudentSpace) => {
    if (selecting.current || loading) return;
    selecting.current = true;
    const current = generation.current;
    const startingPath = window.location.pathname;
    setBusy(space.student_enrollment_id); setError('');
    try {
      const selected = await selectStudentSpace(space.student_enrollment_id);
      // Our session publication can retire this guarded view before continuation.
      // Navigate only if its exact committed session and the original route remain current.
      if (selected.isCurrentSession() && window.location.pathname === startingPath) navigate('/student');
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'تعذر فتح مساحة المدرس'); }
    finally { selecting.current = false; if (current === generation.current) setBusy(''); }
  };
  return <main className="min-h-screen bg-slate-50 p-4 py-12" dir="rtl"><div className="mx-auto max-w-4xl">
    <h1 className="mb-2 text-3xl font-bold">اختر مساحة المدرس</h1><p className="mb-8 text-slate-500">كل مساحة منفصلة بمحتواها ومجموعتها وبياناتها.</p>
    {loading && <p role="status">جارٍ تحميل المساحات…</p>}
    {error && <div role="alert" className="mb-4 rounded bg-red-50 p-3 text-red-700"><p>{error}</p><Button variant="outline" disabled={Boolean(busy) || loading} onClick={() => void load()}>إعادة تحميل المساحات</Button></div>}
    <div className="grid gap-4 md:grid-cols-2">{spaces.map(space => <Card key={space.student_enrollment_id}><CardHeader><CardTitle className="flex items-center gap-2"><Building2 />{space.business_name}</CardTitle></CardHeader><CardContent><p className="mb-4 flex items-center gap-2 text-slate-600"><GraduationCap className="h-4 w-4" />{space.grade_name || 'بدون صف'} — {space.group_name || 'بدون مجموعة'}</p><Button className="w-full" disabled={Boolean(busy) || loading} onClick={() => void select(space)}>{busy === space.student_enrollment_id ? 'جارٍ الفتح…' : 'الدخول للمساحة'}</Button></CardContent></Card>)}</div>
    {!loading && spaces.length === 0 && !error && <Card><CardContent className="p-8 text-center">لا توجد عضوية مقبولة بعد. انتظر موافقة المدرس أو استخدم رابط الانضمام الخاص به.</CardContent></Card>}
  </div></main>;
}
