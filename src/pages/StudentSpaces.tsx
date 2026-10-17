import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, GraduationCap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getCurrentStudentEnrollment, getStudentSpaces, selectStudentSpace, type StudentSpace } from '@/lib/api';
import { notifySessionChange } from '@/lib/session-events';

export default function StudentSpaces() {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<StudentSpace[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { getStudentSpaces().then(setSpaces).catch(e => setError(e instanceof Error ? e.message : 'تعذر تحميل المساحات')); }, []);
  const select = async (space: StudentSpace) => {
    try {
      setBusy(space.student_enrollment_id);
      await selectStudentSpace(space.student_enrollment_id);
      const student = await getCurrentStudentEnrollment();
      localStorage.setItem('currentStudent', JSON.stringify(student));
      localStorage.setItem('currentStudentSpace', JSON.stringify(space));
      // Same-document scope change (supervisor/026): notify only after the
      // complete identity/scope mutation, so subscribers cached for the
      // previous space react before stale responses commit.
      notifySessionChange('scope');
      navigate('/student');
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذر فتح مساحة المدرس'); }
    finally { setBusy(''); }
  };
  return <main className="min-h-screen bg-slate-50 p-4 py-12" dir="rtl"><div className="mx-auto max-w-4xl"><h1 className="mb-2 text-3xl font-bold">اختر مساحة المدرس</h1><p className="mb-8 text-slate-500">كل مساحة منفصلة بمحتواها ومجموعتها وبياناتها.</p>{error && <p className="mb-4 rounded bg-red-50 p-3 text-red-700">{error}</p>}<div className="grid gap-4 md:grid-cols-2">{spaces.map(space => <Card key={space.student_enrollment_id}><CardHeader><CardTitle className="flex items-center gap-2"><Building2 />{space.business_name}</CardTitle></CardHeader><CardContent><p className="mb-4 flex items-center gap-2 text-slate-600"><GraduationCap className="h-4 w-4" />{space.grade_name || 'بدون صف'} — {space.group_name || 'بدون مجموعة'}</p><Button className="w-full" disabled={!!busy} onClick={() => select(space)}>{busy === space.student_enrollment_id ? 'جارٍ الفتح…' : 'الدخول للمساحة'}</Button></CardContent></Card>)}</div>{spaces.length === 0 && !error && <Card><CardContent className="p-8 text-center">لا توجد عضوية مقبولة بعد. انتظر موافقة المدرس أو استخدم رابط الانضمام الخاص به.</CardContent></Card>}</div></main>;
}
