/**
 * M2-23 — the SERVER-AUTHORITATIVE student learning path page.
 *
 * This page previously rendered `getStudentMaterials(<a student id read from
 * localStorage>)`: a client-selected student identity and a flat material list
 * with no enrollment, no publication and no access decision behind it. It now
 * renders ONLY what the server projects for the authenticated student
 * enrollment carried by the session token:
 *
 *  - the bounded list of courses the enrollment may open
 *    (`GET /api/student-course-access/courses`);
 *  - the bounded learning path of ONE selected course, with the server's own
 *    `accessible` / `lock_reason` / `completed` / `completed_at` per lesson
 *    (`GET /api/student-course-access/courses/:courseId`);
 *  - a completion action that sends an EMPTY body and is answered with the
 *    SERVER's instant (`POST .../lessons/:lessonId/completion`).
 *
 * The page owns no decision. It does not decide who the student is, which
 * courses are theirs, whether a course is published, whether a lesson is
 * released or whether a prerequisite is met — the server decides all of it, and
 * a locked lesson is rendered honestly with its reason and WITHOUT a
 * description (the server withholds it, so there is nothing here to leak).
 *
 * All lifecycle lives in `src/features/catalog/student-learning-path.ts`
 * (session/principal/course/disposal fences, one bounded read at a time, ONE
 * completion write at a time, strict DTO validation, uncertain-write handling).
 * The component only renders the published snapshot.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Clock,
  ListOrdered,
  Lock,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import StudentHeader from '@/components/StudentHeader';
import { FloatingParticles } from '@/components/FloatingParticles';
import { GlassmorphicCard } from '@/components/GlassmorphicCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  completeStudentLesson,
  getStudentLearningPath,
  listStudentCourses,
  type StudentLesson,
} from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  STUDENT_LOCK_NOT_RELEASED_MESSAGE,
  STUDENT_LOCK_PREREQUISITE_MESSAGE,
  createStudentLearningPathController,
  readCourseSessionPrincipal,
  type StudentLearningPathController,
  type StudentLearningPathState,
} from '@/features/catalog/student-learning-path';

/** The canonical principal reader, exactly as the courses page uses it. */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

/**
 * The lock wording. The REASON is the server's; this only phrases it. A lesson
 * is never called "locked" for any other cause, and an accessible lesson is
 * never called locked.
 */
const lockText = (lesson: StudentLesson): string =>
  lesson.lock_reason === 'prerequisite_incomplete'
    ? STUDENT_LOCK_PREREQUISITE_MESSAGE
    : STUDENT_LOCK_NOT_RELEASED_MESSAGE;

const PHASE_TEXT: Partial<Record<StudentLearningPathState['phase'], string>> = {
  loading: 'جارٍ تحميل مسار التعلّم…',
  empty: 'لا توجد دروس نشطة في هذا الكورس بعد.',
  malformed: 'تعذّر تحميل المسار: استجابة غير صالحة من الخادم.',
  error: 'تعذّر تحميل مسار التعلّم. أعد المحاولة.',
  unauthorized: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.',
  forbidden: 'مسار التعلّم متاح لحساب تلميذ مسجَّل فقط؛ الخادم هو المرجع.',
  'no-workspace': 'اختر مساحة عمل المدرّس أولًا لعرض مسار التعلّم.',
  'missing-course': 'هذا الكورس غير متاح في مسارك.',
};

const StudentContent = () => {
  const navigate = useNavigate();
  const controllerRef = useRef<StudentLearningPathController | null>(null);
  const [snapshot, setSnapshot] = useState<StudentLearningPathState | null>(null);

  useEffect(() => {
    // One controller per mount. It owns every request, every fence and every
    // decision boundary; disposal retires everything in flight and clears the
    // private path.
    const controller = createStudentLearningPathController({
      listCourses: () => listStudentCourses(),
      getPath: (courseId) => getStudentLearningPath(courseId),
      completeLesson: (courseId, lessonId) => completeStudentLesson(courseId, lessonId),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    void controller.open();
    return () => {
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const state = snapshot;
  const open = state?.open ?? false;
  const courses = state?.courses ?? [];
  const coursesPhase = state?.coursesPhase ?? 'idle';
  const coursesError = state?.coursesError ?? null;
  const coursesTruncated = state?.coursesTruncated ?? false;
  const courseId = state?.courseId ?? null;
  const course = state?.course ?? null;
  const units = state?.units ?? [];
  const truncated = state?.truncated ?? false;
  const phase = state?.phase ?? 'idle';
  const error = state?.error ?? null;
  const refreshError = state?.refreshError ?? null;
  const mutation = state?.mutation ?? { status: 'idle' as const, lessonId: null, error: null, notice: null };
  const busy = mutation.status === 'saving';
  const lessonCount = units.reduce((total, unit) => total + unit.lessons.length, 0);
  const completedCount = units.reduce(
    (total, unit) => total + unit.lessons.filter((lesson) => lesson.completed).length,
    0,
  );
  const unauthorized = coursesPhase === 'unauthorized' || phase === 'unauthorized';

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden"
      dir="rtl"
    >
      <FloatingParticles />
      <StudentHeader />

      <div className="container mx-auto px-4 py-6 relative z-10 max-w-5xl">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <BookOpen className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              مسار التعلّم
            </h1>
          </div>
          <p className="text-muted-foreground">
            دروس كورساتك المسجَّلة، وإتاحتها وشروطها كما يحدّدها الخادم. لا تُحدَّد الهوية ولا الصلاحية من هذه الصفحة.
          </p>
        </motion.div>

        {/* Session / scope failures that need an action */}
        {unauthorized ? (
          <GlassmorphicCard className="mb-6">
            <CardContent className="pt-6 flex flex-col items-start gap-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="w-5 h-5" />
                <span className="font-semibold">انتهت الجلسة</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {coursesError ?? PHASE_TEXT.unauthorized}
              </p>
              <Button className="gap-2" onClick={() => navigate('/auth', { replace: true })}>
                <LogIn className="w-4 h-4" />
                تسجيل الدخول
              </Button>
            </CardContent>
          </GlassmorphicCard>
        ) : null}

        {/* Course selector — the server's own enrolled/published list */}
        {!unauthorized && coursesPhase === 'loading' ? (
          <p className="text-sm text-muted-foreground py-4" aria-live="polite">
            جارٍ تحميل كورساتك…
          </p>
        ) : null}

        {!unauthorized && coursesPhase === 'empty' ? (
          <GlassmorphicCard className="mb-6">
            <CardContent className="pt-6">
              <h3 className="font-semibold mb-1">لا توجد كورسات متاحة</h3>
              <p className="text-sm text-muted-foreground">
                لا يوجد تسجيل نشط في كورس منشور داخل مساحة العمل المختارة. التسجيل يتم من المؤسسة، ولا تُنشئه هذه الصفحة.
              </p>
            </CardContent>
          </GlassmorphicCard>
        ) : null}

        {!unauthorized && coursesPhase !== 'loading' && coursesPhase !== 'empty' && coursesPhase !== 'ready' ? (
          <GlassmorphicCard className="mb-6">
            <CardContent className="pt-6 flex flex-col items-start gap-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="w-5 h-5" />
                <span className="font-semibold">تعذّر تحميل كورساتك</span>
              </div>
              <p className="text-sm text-muted-foreground">{coursesError}</p>
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => { void controllerRef.current?.refreshCourses(); }}
              >
                <RefreshCw className="w-4 h-4" />
                إعادة المحاولة
              </Button>
            </CardContent>
          </GlassmorphicCard>
        ) : null}

        {courses.length > 0 ? (
          <div className="mb-6">
            <p className="text-xs text-muted-foreground mb-2">الكورسات المسجَّلة</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="اختيار الكورس">
              {courses.map((entry) => {
                const selected = entry.course_id === courseId;
                return (
                  <Button
                    key={entry.course_id}
                    type="button"
                    size="sm"
                    variant={selected ? 'default' : 'outline'}
                    aria-pressed={selected}
                    className="gap-2"
                    onClick={() => { void controllerRef.current?.selectCourse(entry.course_id); }}
                  >
                    <BookOpen className="w-4 h-4" />
                    <span dir="auto">{entry.name}</span>
                  </Button>
                );
              })}
            </div>
            {coursesTruncated ? (
              <p className="text-xs text-muted-foreground mt-2">
                عُرض أول 100 كورس فقط؛ القائمة محدودة من الخادم.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Path header */}
        {course ? (
          <GlassmorphicCard className="mb-4">
            <CardContent className="pt-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold" dir="auto">{course.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {course.subject ?? 'مادة غير محددة'} • {course.grade ?? 'صف غير محدد'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  {completedCount} / {lessonCount} مكتمل
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={phase === 'loading'}
                  onClick={() => { void controllerRef.current?.refreshPath(); }}
                >
                  <RefreshCw className={`w-4 h-4 ${phase === 'loading' ? 'animate-spin' : ''}`} />
                  تحديث
                </Button>
              </div>
            </CardContent>
          </GlassmorphicCard>
        ) : null}

        {/* Path phases */}
        {phase !== 'idle' && phase !== 'ready' ? (
          <div className="py-6" aria-live="polite">
            <p className="text-sm text-muted-foreground">{error ?? PHASE_TEXT[phase]}</p>
            {phase !== 'loading' && phase !== 'empty' && courseId ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-2 mt-3"
                onClick={() => { void controllerRef.current?.refreshPath(); }}
              >
                <RefreshCw className="w-4 h-4" />
                إعادة المحاولة
              </Button>
            ) : null}
          </div>
        ) : null}

        {refreshError ? (
          <p className="text-xs text-amber-700 mb-3" aria-live="polite">{refreshError}</p>
        ) : null}

        {/* The bounded learning path */}
        {units.map((unit) => (
          <Card key={unit.unit_id} className="mb-4 overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <ListOrdered className="w-4 h-4 text-primary" />
                <h3 className="font-semibold" dir="auto">{unit.name}</h3>
              </div>
              <ol className="space-y-2">
                {unit.lessons.map((lesson) => (
                  <li
                    key={lesson.lesson_id}
                    className={`rounded-lg border p-3 ${
                      lesson.accessible ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {lesson.accessible ? (
                          <BookOpen className="w-4 h-4 text-primary shrink-0" />
                        ) : (
                          <Lock className="w-4 h-4 text-slate-400 shrink-0" />
                        )}
                        <span className="font-medium text-sm" dir="auto">{lesson.title}</span>
                        <Badge variant="outline" className="text-xs">
                          {lesson.display_order}
                        </Badge>
                        {lesson.completed ? (
                          <Badge className="gap-1 text-xs">
                            <CheckCircle2 className="w-3 h-3" />
                            مكتمل
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {lesson.accessible && !lesson.completed ? (
                          <Button
                            type="button"
                            size="sm"
                            className="gap-2"
                            disabled={busy}
                            onClick={() => { void controllerRef.current?.completeLesson(lesson.lesson_id); }}
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            {busy && mutation.lessonId === lesson.lesson_id ? 'جارٍ التسجيل…' : 'تسجيل الإتمام'}
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {/* The server withholds the description of a locked lesson,
                        so a locked row has nothing to render here. */}
                    {lesson.accessible && lesson.description ? (
                      <p className="text-sm text-muted-foreground mt-2 whitespace-pre-line">
                        {lesson.description}
                      </p>
                    ) : null}

                    {!lesson.accessible ? (
                      <p className="text-xs text-amber-700 mt-2">{lockText(lesson)}</p>
                    ) : null}

                    {lesson.release_at ? (
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        يُتاح في <span dir="ltr">{lesson.release_at}</span>
                      </p>
                    ) : null}

                    {lesson.completed_at ? (
                      <p className="text-xs text-muted-foreground mt-1">
                        سُجّل الإتمام في <span dir="ltr">{lesson.completed_at}</span>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}

        {truncated ? (
          <p className="text-xs text-muted-foreground mb-4">
            عُرض أول 500 درس فقط؛ المسار محدود من الخادم.
          </p>
        ) : null}

        {/* Completion feedback */}
        <div aria-live="polite" className="mt-4 space-y-2">
          {mutation.status === 'saving' ? (
            <p className="text-sm text-muted-foreground">جارٍ تسجيل الإتمام… بانتظار تأكيد الخادم.</p>
          ) : null}
          {mutation.notice ? (
            <p className="text-sm text-emerald-700">{mutation.notice}</p>
          ) : null}
          {mutation.error ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm text-amber-900">{mutation.error}</p>
              {mutation.status === 'uncertain' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-2 mt-2"
                  onClick={() => { void controllerRef.current?.reconcile(); }}
                >
                  <RefreshCw className="w-4 h-4" />
                  إعادة قراءة المسار للمطابقة
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {open && phase === 'idle' && coursesPhase === 'ready' && !courseId ? (
          <p className="text-sm text-muted-foreground py-6">اختر كورسًا لعرض مساره.</p>
        ) : null}
      </div>
    </div>
  );
};

export default StudentContent;
