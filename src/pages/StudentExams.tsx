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
import { getExams, Exam, User } from "@/lib/api";

interface StudentExam extends Exam {
  course_name?: string;
  description?: string;
  start_date?: string;
  end_date?: string;
  passing_score?: number;
  status?: 'available' | 'upcoming' | 'completed' | 'expired';
  attempts?: number;
  maxAttempts?: number;
  lastScore?: number;
  difficulty?: 'easy' | 'medium' | 'hard';
}

const StudentExams = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [selectedTab, setSelectedTab] = useState<'available' | 'upcoming' | 'completed'>('available');
  const [exams, setExams] = useState<StudentExam[]>([]);
  const [loading, setLoading] = useState(true);

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
      const data = await getExams();
      const examsData = data?.map((exam: StudentExam) => ({
        ...exam,
        status: (exam.status || 'available') as 'available' | 'upcoming' | 'completed' | 'expired',
        attempts: exam.attempts || 0,
        maxAttempts: exam.maxAttempts || 2,
        difficulty: (exam.difficulty || 'medium') as 'easy' | 'medium' | 'hard'
      })) || [];
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
    return true;
  });

  const handleStartExam = (exam: StudentExam) => {
    if ((exam.attempts || 0) >= (exam.maxAttempts || 2)) {
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

      <div className="container mx-auto px-4 py-6 relative z-10 max-w-7xl">
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
          <GlassmorphicCard className="mb-6">
            <CardContent className="pt-6">
              <div className="flex gap-2 flex-wrap">
                {[
                  { value: 'available', label: 'متاحة الآن', icon: CheckCircle2 },
                  { value: 'upcoming', label: 'قادمة', icon: Clock },
                  { value: 'completed', label: 'مكتملة', icon: Trophy }
                ].map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <Button
                      key={tab.value}
                      variant={selectedTab === tab.value ? 'default' : 'outline'}
                      onClick={() => setSelectedTab(tab.value as 'available' | 'upcoming' | 'completed')}
                      className="gap-2"
                    >
                      <Icon className="w-4 h-4" />
                      {tab.label}
                    </Button>
                  );
                })}
              </div>
            </CardContent>
          </GlassmorphicCard>
        </motion.div>

        {/* Exams Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                  <div className={`h-2 ${getStatusColor(exam.status)}`} />

                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <CardTitle className="text-lg mb-2 line-clamp-2">
                          {exam.title}
                        </CardTitle>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline" className="text-xs">
                            {exam.course_name || 'دورة عامة'}
                          </Badge>
                          <Badge className={`${getDifficultyColor(exam.difficulty || 'medium')} text-white text-xs`}>
                            {getDifficultyLabel(exam.difficulty || 'medium')}
                          </Badge>
                          <Badge className={`${getStatusColor(exam.status || 'available')} text-white text-xs`}>
                            {getStatusLabel(exam.status || 'available')}
                          </Badge>
                        </div>
                      </div>
                      <div className="p-3 bg-primary/10 rounded-lg">
                        <FileText className="w-6 h-6 text-primary" />
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent>
                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                      {exam.description}
                    </p>

                    {/* Exam Info Grid */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="w-4 h-4 text-primary" />
                        <span>{exam.duration_minutes || 0} دقيقة</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <Target className="w-4 h-4 text-primary" />
                        <span>أسئلة متعددة</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <Trophy className="w-4 h-4 text-primary" />
                        <span>{exam.total_marks || 0} درجة</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <AlertCircle className="w-4 h-4 text-primary" />
                        <span>{exam.attempts || 0}/{exam.maxAttempts || 2} محاولة</span>
                      </div>
                    </div>

                    {/* Date and Time (if available) */}
                    {exam.start_date && (
                      <div className="bg-muted/50 rounded-lg p-3 mb-4">
                        <div className="flex items-center gap-2 text-sm">
                          <Calendar className="w-4 h-4 text-primary" />
                          <span>{new Date(exam.start_date).toLocaleDateString('ar-EG')}</span>
                          {exam.start_date && (
                            <>
                              <span>•</span>
                              <Clock className="w-4 h-4 text-primary" />
                              <span>{new Date(exam.start_date).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
                            </>
                          )}
                        </div>
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
                        className="w-full bg-gradient-to-r from-primary to-accent hover:shadow-lg"
                        disabled={(exam.attempts || 0) >= (exam.maxAttempts || 2)}
                      >
                        {(exam.attempts || 0) >= (exam.maxAttempts || 2) ? 'استنفذت المحاولات' : 'بدء الامتحان'}
                      </Button>
                    )}
                    {exam.status === 'upcoming' && (
                      <Button className="w-full" variant="outline" disabled>
                        الامتحان قريباً
                      </Button>
                    )}
                    {exam.status === 'completed' && (exam.attempts || 0) < (exam.maxAttempts || 2) && (
                      <Button
                        onClick={() => handleStartExam(exam)}
                        className="w-full"
                        variant="outline"
                      >
                        إعادة المحاولة ({(exam.maxAttempts || 2) - (exam.attempts || 0)} متبقية)
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
