import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, Calendar, FileText, Trophy, Target, CheckCircle2, AlertCircle } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { useToast } from "@/hooks/use-toast";
import { getStudentExams, getStudents, Exam, User, Student } from "@/lib/api";
import { useScreenRecordingPrevention } from "@/hooks/useScreenRecordingPrevention";

interface StudentExam extends Exam {
  course_name?: string;
  description?: string;
  start_time?: string;
  end_time?: string;
  start_date?: string;
  end_date?: string;
  passing_score?: number;
  status?: 'available' | 'upcoming' | 'completed' | 'expired';
  attempts?: number;
  maxAttempts?: number;
  lastScore?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
  has_in_progress?: boolean;
  in_progress_started_at?: string;
}

const StudentExams = () => {
  useScreenRecordingPrevention(); // Prevent screen recording & screenshots
  const navigate = useNavigate();
  const { toast } = useToast();
  const [selectedTab, setSelectedTab] = useState<'available' | 'upcoming' | 'completed' | 'expired'>('available');
  const [exams, setExams] = useState<StudentExam[]>([]);
  const [loading, setLoading] = useState(true);

  // ===== DateTime Helpers (shared between loader + render) =====
  const sanitizeDateTime = (raw?: string): string | undefined => {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    const parts = trimmed.split(/\s+/);
    // Pattern like: YYYY-MM-DD YYYY-MM-DD HH:MM:SS → collapse duplicate date
    if (parts.length === 3 && parts[0] === parts[1]) {
      return `${parts[0]} ${parts[2]}`;
    }
    return trimmed;
  };

  const parseSafe = (raw?: string): Date | null => {
    const s = sanitizeDateTime(raw);
    if (!s) return null;
    const isoCandidate = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
    const d = new Date(isoCandidate);
    return isNaN(d.getTime()) ? null : d;
  };

  // Check authentication
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || user.role !== 'student') {
      navigate('/auth');
      return;
    }

    loadExams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadExams = async () => {
    try {
      setLoading(true);

      // Determine student ID
      const userStr = localStorage.getItem('currentUser');
      const user: User | null = userStr ? JSON.parse(userStr) : null;
      const studentId = user?.id;

      if (!studentId) {
        toast({
          title: 'خطأ',
          description: 'لم يتم العثور على بيانات الطالب',
          variant: 'destructive'
        });
        setLoading(false);
        return;
      }

      // ✅ Fetch exams ONLY for this student's group
      const data = await getStudentExams(studentId);
      const now = new Date();

      console.log('🕐 Current time:', now.toISOString(), '(Local:', now.toLocaleString('ar-EG'), ')');
      console.log(`📚 Loaded ${data?.length || 0} exams for student's group`);

      const examsData = data?.map((exam: StudentExam & { start_dt?: string; end_dt?: string }) => {
        const hasAttempted = (exam.attempts || 0) > 0;
        const hasInProgress = exam.has_in_progress === true;

        // Sanitize raw times first
        const combinedStart = exam.start_dt || exam.start_time;
        const combinedEnd = exam.end_dt || exam.end_time;
        const rawStart = sanitizeDateTime(combinedStart);
        const rawEnd = sanitizeDateTime(combinedEnd);
        const startDate = parseSafe(rawStart);
        const endDate = parseSafe(rawEnd);

        console.log(`\n📝 Exam: ${exam.title}`);
        console.log('  Has attempted:', hasAttempted, 'Has in_progress:', hasInProgress);
        console.log('  Start time (raw):', exam.start_time, '→', rawStart, 'Parsed valid?', !!startDate);
        console.log('  End time (raw):', exam.end_time, '→', rawEnd, 'Parsed valid?', !!endDate);

        let status: 'available' | 'upcoming' | 'completed' | 'expired' = 'available';

        // ✅ If in_progress, check if exam time window is still open
        if (hasInProgress) {
          // Check if exam end_time has passed
          if (endDate && now > endDate) {
            status = 'expired';
            console.log('  ⏰ Status: expired (in_progress but end time passed)');
          } else {
            // Also check if the attempt's own duration has expired
            const startedAt = exam.in_progress_started_at ? new Date(exam.in_progress_started_at) : null;
            const durationMs = (exam.duration_minutes || 60) * 60 * 1000;
            if (startedAt && (now.getTime() - startedAt.getTime()) > durationMs) {
              status = 'expired';
              console.log('  ⏰ Status: expired (attempt duration exceeded)');
            } else {
              status = 'available';
              console.log('  🔄 Status: available (in_progress, can resume)');
            }
          }
        } else if (hasAttempted) {
          status = 'completed';
          console.log('  ✅ Status: completed (already attempted)');
        } else if (startDate && endDate) {
          console.log('  Start parsed:', startDate.toISOString(), '(Local:', startDate.toLocaleString('ar-EG'), ')');
          console.log('  End parsed:', endDate.toISOString(), '(Local:', endDate.toLocaleString('ar-EG'), ')');
          console.log('  Now < Start?', now < startDate);
          console.log('  Now > End?', now > endDate);

          if (now < startDate) {
            status = 'upcoming';
            console.log('  📅 Status: upcoming (not started yet)');
          } else if (now > endDate) {
            status = 'expired';
            console.log('  ⏰ Status: expired (time ended, not attempted)');
          } else {
            status = 'available';
            console.log('  ✅ Status: available (within time window)');
          }
        } else {
          status = hasAttempted ? 'completed' : 'available';
          console.log('  ⚠️ Status:', status, '(timing missing or invalid)');
        }

        return {
          ...exam,
          start_time: rawStart, // sanitized
          end_time: rawEnd,     // sanitized
          status,
          has_in_progress: hasInProgress,
          in_progress_started_at: exam.in_progress_started_at,
          attempts: exam.attempts || 0,
          maxAttempts: exam.maxAttempts || 1,
          difficulty: (exam.difficulty || 'medium') as 'easy' | 'medium' | 'hard'
        };
      }) || [];

      setExams(examsData);
    } catch (error) {
      console.error('Error loading exams:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل الامتحانات',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy':
        return 'bg-green-500';
      case 'medium':
        return 'bg-yellow-500';
      case 'hard':
        return 'bg-red-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getDifficultyLabel = (difficulty: string) => {
    switch (difficulty) {
      case 'easy':
        return 'سهل';
      case 'medium':
        return 'متوسط';
      case 'hard':
        return 'صعب';
      default:
        return '';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'available':
        return 'متاح الآن';
      case 'upcoming':
        return 'قريباً';
      case 'completed':
        return 'مكتمل';
      case 'expired':
        return 'منتهي';
      default:
        return '';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'available':
        return 'bg-green-500';
      case 'upcoming':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-gray-500';
      case 'expired':
        return 'bg-red-500';
      default:
        return 'bg-gray-500';
    }
  };

  const filteredExams = exams.filter(exam => {
    if (selectedTab === 'available') return exam.status === 'available';
    if (selectedTab === 'upcoming') return exam.status === 'upcoming';
    if (selectedTab === 'completed') return exam.status === 'completed';
    if (selectedTab === 'expired') return exam.status === 'expired';
    return true;
  });

  const handleStartExam = (exam: StudentExam) => {
    // ✅ Allow if in_progress (resuming)
    if (exam.has_in_progress) {
      navigate(`/take-exam/${exam.id}`);
      return;
    }

    // Check if exam is available
    if (exam.status !== 'available') {
      let message = 'لا يمكن الدخول للامتحان';
      if (exam.status === 'upcoming') {
        message = 'الامتحان لم يبدأ بعد';
      } else if (exam.status === 'expired') {
        message = 'انتهى وقت الامتحان';
      }

      toast({
        title: "لا يمكن الدخول للامتحان",
        description: message,
        variant: "destructive"
      });
      return;
    }

    // Check attempts
    if ((exam.attempts || 0) >= (exam.maxAttempts || 1)) {
      toast({
        title: "لا يمكن الدخول للامتحان",
        description: "لقد استنفذت عدد المحاولات المتاحة",
        variant: "destructive"
      });
      return;
    }

    navigate(`/take-exam/${exam.id}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <StudentHeader />

      <div className="w-full px-3 xs:px-4 sm:px-6 md:px-8 lg:px-12 xl:px-16 py-4 xs:py-5 sm:py-6 md:py-8 relative z-10 max-w-[100vw]">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <div className="flex items-center gap-3 mb-2">
            <FileText className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              الامتحانات
            </h1>
          </div>
          <p className="text-muted-foreground">
            جميع الامتحانات المتاحة والقادمة
          </p>
        </motion.div>

        {/* Tabs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <GlassmorphicCard className="mb-4 sm:mb-5 md:mb-6">
            <CardContent className="pt-4 sm:pt-5 md:pt-6 px-3 sm:px-4 md:px-6">
              <div className="flex gap-1.5 xs:gap-2 sm:gap-3 flex-wrap">
                {[
                  { value: 'available', label: 'متاحة الآن', icon: CheckCircle2 },
                  { value: 'upcoming', label: 'قادمة', icon: Clock },
                  { value: 'completed', label: 'مكتملة', icon: Trophy },
                  { value: 'expired', label: 'منتهية', icon: AlertCircle }
                ].map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <Button
                      key={tab.value}
                      variant={selectedTab === tab.value ? 'default' : 'outline'}
                      onClick={() => setSelectedTab(tab.value as 'available' | 'upcoming' | 'completed' | 'expired')}
                      className="gap-1 xs:gap-1.5 sm:gap-2 text-[10px] xs:text-xs sm:text-sm px-2 xs:px-3 sm:px-4 py-1.5 xs:py-2"
                      size="sm"
                    >
                      <Icon className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4" />
                      <span className="hidden xs:inline">{tab.label}</span>
                      <span className="xs:hidden">{tab.label.split(' ')[0]}</span>
                    </Button>
                  );
                })}
              </div>
            </CardContent>
          </GlassmorphicCard>
        </motion.div>

        {/* Exams Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-3 xs:gap-4 sm:gap-5 md:gap-6">
          <AnimatePresence>
            {filteredExams.map((exam, idx) => (
              <motion.div
                key={exam.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: idx * 0.05 }}
                whileHover={{ y: -5 }}
              >
                <Card className="overflow-hidden hover:shadow-2xl transition-all duration-300 h-full border-2 border-primary/20">
                  <div className={`h-1.5 sm:h-2 ${getStatusColor(exam.status)}`} />

                  <CardHeader className="p-3 xs:p-4 sm:p-5 md:p-6">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-sm xs:text-base sm:text-lg mb-1.5 sm:mb-2 line-clamp-2">
                          {exam.title}
                        </CardTitle>
                        <div className="flex flex-wrap gap-1 xs:gap-1.5 sm:gap-2">
                          <Badge variant="outline" className="text-[9px] xs:text-[10px] sm:text-xs">
                            {exam.course_name || 'دورة عامة'}
                          </Badge>
                          <Badge className={`${getDifficultyColor(exam.difficulty || 'medium')} text-white text-[9px] xs:text-[10px] sm:text-xs`}>
                            {getDifficultyLabel(exam.difficulty || 'medium')}
                          </Badge>
                          <Badge className={`${getStatusColor(exam.status || 'available')} text-white text-[9px] xs:text-[10px] sm:text-xs`}>
                            {getStatusLabel(exam.status || 'available')}
                          </Badge>
                        </div>
                      </div>
                      <div className="p-2 xs:p-2.5 sm:p-3 bg-primary/10 rounded-lg flex-shrink-0">
                        <FileText className="w-4 h-4 xs:w-5 xs:h-5 sm:w-6 sm:h-6 text-primary" />
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="p-3 xs:p-4 sm:p-5 md:p-6 pt-0">
                    <p className="text-xs xs:text-sm text-muted-foreground mb-3 sm:mb-4 line-clamp-2">
                      {exam.description}
                    </p>

                    {/* Exam Info Grid */}
                    <div className="grid grid-cols-2 gap-2 xs:gap-2.5 sm:gap-3 mb-3 sm:mb-4">
                      <div className="flex items-center gap-1.5 xs:gap-2 text-[10px] xs:text-xs sm:text-sm">
                        <Clock className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-primary flex-shrink-0" />
                        <span>{exam.duration_minutes || 0} دقيقة</span>
                      </div>
                      <div className="flex items-center gap-1.5 xs:gap-2 text-[10px] xs:text-xs sm:text-sm">
                        <Target className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-primary flex-shrink-0" />
                        <span>أسئلة متعددة</span>
                      </div>
                      <div className="flex items-center gap-1.5 xs:gap-2 text-[10px] xs:text-xs sm:text-sm">
                        <Trophy className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-primary flex-shrink-0" />
                        <span>{exam.total_marks || 0} درجة</span>
                      </div>
                      <div className="flex items-center gap-1.5 xs:gap-2 text-[10px] xs:text-xs sm:text-sm">
                        <AlertCircle className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-primary flex-shrink-0" />
                        <span>{exam.attempts || 0}/{exam.maxAttempts || 2} محاولة</span>
                      </div>
                    </div>

                    {/* Date and Time (if available) */}
                    {(exam.start_time || exam.end_time) && (
                      <div className="bg-muted/50 rounded-lg p-2 xs:p-2.5 sm:p-3 mb-3 sm:mb-4 space-y-1.5 sm:space-y-2">
                        {exam.start_time && (() => {
                          const d = parseSafe(exam.start_time);
                          if (!d) return null;
                          return (
                            <div className="flex flex-wrap items-center gap-1 xs:gap-1.5 sm:gap-2 text-[10px] xs:text-xs sm:text-sm">
                              <Calendar className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-primary flex-shrink-0" />
                              <span className="font-medium">البدء:</span>
                              <span>{d.toLocaleDateString('ar-EG')}</span>
                              <Clock className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-primary flex-shrink-0" />
                              <span>{d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          );
                        })()}
                        {exam.end_time && (() => {
                          const d = parseSafe(exam.end_time);
                          if (!d) return null;
                          return (
                            <div className="flex flex-wrap items-center gap-1 xs:gap-1.5 sm:gap-2 text-[10px] xs:text-xs sm:text-sm">
                              <Calendar className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-red-500 flex-shrink-0" />
                              <span className="font-medium">الانتهاء:</span>
                              <span>{d.toLocaleDateString('ar-EG')}</span>
                              <Clock className="w-3 h-3 xs:w-3.5 xs:h-3.5 sm:w-4 sm:h-4 text-red-500 flex-shrink-0" />
                              <span>{d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {/* Last Score (if completed) */}
                    {exam.status === 'completed' && exam.lastScore !== undefined && (
                      <div className={`p-3 rounded-lg mb-4 ${(exam.lastScore || 0) >= (exam.passing_score || 0) ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">آخر درجة:</span>
                          <span className={`text-lg font-bold ${(exam.lastScore || 0) >= (exam.passing_score || 0) ? 'text-green-600' : 'text-red-600'}`}>
                            {exam.lastScore}/{exam.total_marks}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Action Button */}
                    {exam.status === 'available' && (
                      <Button
                        onClick={() => handleStartExam(exam)}
                        className={`w-full ${exam.has_in_progress
                          ? 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600'
                          : 'bg-gradient-to-r from-primary to-accent'} hover:shadow-lg`}
                        disabled={!exam.has_in_progress && (exam.attempts || 0) >= (exam.maxAttempts || 1)}
                      >
                        {exam.has_in_progress
                          ? '🔄 استكمال الامتحان'
                          : (exam.attempts || 0) >= (exam.maxAttempts || 1)
                            ? 'استنفذت المحاولات'
                            : 'بدء الامتحان'}
                      </Button>
                    )}
                    {exam.status === 'upcoming' && exam.start_time && (() => {
                      const d = parseSafe(exam.start_time); if (!d) return null; return (
                        <div className="space-y-2">
                          <Button className="w-full" variant="outline" disabled>
                            الامتحان لم يبدأ بعد
                          </Button>
                          <p className="text-xs text-center text-muted-foreground">
                            سيبدأ في: {d.toLocaleString('ar-EG')}
                          </p>
                        </div>
                      )
                    })()}
                    {exam.status === 'expired' && exam.end_time && (() => {
                      const d = parseSafe(exam.end_time); if (!d) return null; return (
                        <div className="space-y-2">
                          <Button className="w-full" variant="destructive" disabled>
                            انتهى الامتحان
                          </Button>
                          <p className="text-xs text-center text-muted-foreground">
                            انتهى في: {d.toLocaleString('ar-EG')}
                          </p>
                        </div>
                      )
                    })()}
                    {exam.status === 'completed' && (exam.attempts || 0) < (exam.maxAttempts || 1) && (
                      <Button
                        onClick={() => handleStartExam(exam)}
                        className="w-full"
                        variant="outline"
                      >
                        إعادة المحاولة ({(exam.maxAttempts || 1) - (exam.attempts || 0)} متبقية)
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Empty State */}
        {filteredExams.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-20"
          >
            <GlassmorphicCard className="max-w-md mx-auto">
              <CardContent className="pt-8 pb-8">
                <FileText className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="text-lg font-semibold mb-2">لا توجد امتحانات</h3>
                <p className="text-sm text-muted-foreground">
                  {selectedTab === 'available' && 'لا توجد امتحانات متاحة حالياً'}
                  {selectedTab === 'upcoming' && 'لا توجد امتحانات قادمة'}
                  {selectedTab === 'completed' && 'لم تكمل أي امتحان بعد'}
                  {selectedTab === 'expired' && 'لا توجد امتحانات منتهية'}
                </p>
              </CardContent>
            </GlassmorphicCard>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default StudentExams;
