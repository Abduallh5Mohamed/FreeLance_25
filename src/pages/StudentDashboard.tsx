import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { BookOpen, FileText, Clock, Calendar, Download, Play, Eye, MessageSquare, Award, Users, Calendar as CalendarIcon, Sparkles, TrendingUp, Trophy, Target } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { useNavigate } from "react-router-dom";
import { getStudents, getCourses, getGroups } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useScreenRecordingPrevention } from "@/hooks/useScreenRecordingPrevention";
import { motion, AnimatePresence } from "framer-motion";
import { AnimatedSection } from "@/components/AnimatedSection";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { FloatingParticles } from "@/components/FloatingParticles";
import { AnimatedCounter } from "@/components/AnimatedCounter";

const StudentDashboard = () => {
  useScreenRecordingPrevention(); // Prevent screen recording
  const [studentData, setStudentData] = useState(null);
  const [courses, setCourses] = useState([]);
  const [materials, setMaterials] = useState([]);
  const [exams, setExams] = useState([]);
  const [examResults, setExamResults] = useState([]);
  const [groupInfo, setGroupInfo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchStudentData();
  }, []);

  const fetchStudentData = async () => {
    try {
      // TEMPORARY: Demo mode for student dashboard
      const DEMO_MODE = true;

      if (DEMO_MODE) {
        // Set demo session in localStorage for Messages page
        localStorage.setItem('student_session', JSON.stringify({
          email: 'demo@student.com',
          loginTime: Date.now()
        }));

        // Fetch real students from MySQL API
        const allStudents = await getStudents();
        const demoStudent = allStudents?.[0] || {
          id: 'demo-123',
          name: 'محمد أحمد',
          email: 'demo@student.com',
          phone: '01234567890',
          grade: 'الصف الثاني الثانوي',
          group_id: null
        };

        setStudentData(demoStudent);

        // Fetch real courses from MySQL API
        const allCourses = await getCourses();
        setCourses(allCourses || []);

        // Fetch group info if student has a group
        if (demoStudent.group_id) {
          const allGroups = await getGroups();
          const studentGroup = allGroups?.find(g => g.id === demoStudent.group_id);
          if (studentGroup) {
            setGroupInfo(studentGroup);
          }
        }

        // TODO: Add API routes for materials, exams, messages
        setMaterials([]);
        setExams([]);
        setMessages([]);

        setLoading(false);
        return;
      }

      // Production mode would require proper authentication
      // For now, redirect to auth
      toast({
        title: "تسجيل الدخول مطلوب",
        description: "يرجى تسجيل الدخول للوصول إلى لوحة التحكم",
        variant: "destructive",
      });
      navigate('/auth');
    } catch (error) {
      console.error('Error fetching student data:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل البيانات",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const getMaterialIcon = (type) => {
    switch (type) {
      case 'pdf':
        return <FileText className="w-5 h-5 text-red-500" />;
      case 'presentation':
        return <FileText className="w-5 h-5 text-blue-500" />;
      case 'video':
        return <Play className="w-5 h-5 text-green-500" />;
      default:
        return <FileText className="w-5 h-5 text-gray-500" />;
    }
  };

  const getInitials = (name) => {
    return name?.split(' ').map(n => n[0]).join('').slice(0, 2) || 'N/A';
  };

  const handleTakeExam = (examId) => {
    navigate(`/take-exam/${examId}`);
  };

  const handleSendMessage = () => {
    navigate('/messages');
  };

  const getGradeColor = (percentage) => {
    if (percentage >= 85) return 'text-green-600';
    if (percentage >= 70) return 'text-blue-600';
    if (percentage >= 60) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getGradeText = (percentage) => {
    if (percentage >= 85) return 'ممتاز';
    if (percentage >= 70) return 'جيد جداً';
    if (percentage >= 60) return 'جيد';
    return 'مقبول';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center relative overflow-hidden">
        <FloatingParticles />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center relative z-10"
        >
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4"
          />
          <motion.p
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="text-lg font-medium text-primary"
          >
            جاري تحميل بياناتك...
          </motion.p>
        </motion.div>
      </div>
    );
  }

  if (!studentData) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center relative overflow-hidden">
        <FloatingParticles />
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative z-10"
        >
          <GlassmorphicCard className="w-full max-w-md p-8 text-center">
            <Award className="w-16 h-16 mx-auto mb-4 text-destructive" />
            <p className="text-lg font-medium text-foreground mb-4">لا يمكن العثور على بيانات الطالب</p>
            <Button
              onClick={() => navigate("/auth")}
              className="bg-gradient-to-r from-primary to-accent hover:shadow-glow"
            >
              العودة لتسجيل الدخول
            </Button>
          </GlassmorphicCard>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <StudentHeader />

      <div className="container mx-auto px-3 md:px-4 lg:px-6 py-6 md:py-8 relative z-10">
        {/* Student Profile Section */}
        <AnimatedSection>
          <GlassmorphicCard className="mb-8">
            <CardContent className="pt-6">
              <div className="flex flex-col md:flex-row items-center gap-6">
                <motion.div
                  whileHover={{ scale: 1.1, rotate: 5 }}
                  transition={{ type: "spring", stiffness: 300 }}
                >
                  <Avatar className="w-24 h-24 border-4 border-primary/30 shadow-xl">
                    <AvatarFallback className="text-2xl font-bold bg-gradient-to-br from-primary to-accent text-white">
                      {getInitials(studentData.name)}
                    </AvatarFallback>
                  </Avatar>
                </motion.div>
                <div className="flex-1 text-center md:text-right">
                  <motion.h1
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent mb-2"
                  >
                    مرحباً، {studentData.name} 👋
                  </motion.h1>
                  <div className="flex flex-col md:flex-row gap-2 items-center justify-center md:justify-start text-muted-foreground">
                    <Badge className="bg-gradient-to-r from-blue-500 to-cyan-500 text-white border-0">
                      {studentData.email}
                    </Badge>
                    <Badge className="bg-gradient-to-r from-purple-500 to-pink-500 text-white border-0">
                      {studentData.grade}
                    </Badge>
                  </div>
                </div>
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  className="bg-gradient-to-br from-primary/10 to-accent/10 backdrop-blur-sm p-6 rounded-2xl text-center border-2 border-primary/20"
                >
                  <Sparkles className="w-8 h-8 mx-auto mb-2 text-primary" />
                  <p className="text-sm text-muted-foreground mb-1">الكورسات المسجلة</p>
                  <AnimatedCounter to={courses.length} className="text-4xl font-bold text-primary" />
                </motion.div>
              </div>
            </CardContent>
          </GlassmorphicCard>
        </AnimatedSection>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
          {/* Left Sidebar */}
          <div className="md:col-span-1 lg:col-span-1 space-y-4 md:space-y-6" data-section="courses">
            {/* Enrolled Courses */}
            <AnimatedSection>
              <GlassmorphicCard>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <motion.div
                      animate={{ rotate: [0, 10, -10, 0] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    >
                      <BookOpen className="w-5 h-5 text-primary" />
                    </motion.div>
                    الكورسات المسجلة
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {courses.length > 0 ? (
                      <AnimatePresence>
                        {courses.map((course, index) => (
                          <motion.div
                            key={course.id}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            transition={{ delay: index * 0.1 }}
                          >
                            <Card className="p-4 bg-gradient-to-br from-primary/5 to-accent/5 border-primary/20 hover:shadow-lg hover:scale-105 transition-all duration-300 cursor-pointer">
                              <div className="flex items-start gap-3">
                                <div className="p-2 bg-primary/10 rounded-lg">
                                  <BookOpen className="w-5 h-5 text-primary" />
                                </div>
                                <div className="flex-1">
                                  <h3 className="font-bold text-foreground mb-1">{course.name}</h3>
                                  <Badge className="mb-2 bg-gradient-to-r from-blue-500 to-cyan-500 text-white border-0 text-xs">
                                    {course.subject}
                                  </Badge>
                                  {course.description && (
                                    <p className="text-xs text-muted-foreground leading-relaxed">{course.description}</p>
                                  )}
                                </div>
                              </div>
                            </Card>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    ) : (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-center py-8"
                      >
                        <BookOpen className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
                        <p className="text-muted-foreground text-sm">لم يتم تسجيلك في أي كورس بعد</p>
                      </motion.div>
                    )}
                  </div>
                </CardContent>
              </GlassmorphicCard>
            </AnimatedSection>

            {/* Group Information */}
            {groupInfo && (
              <AnimatedSection>
                <GlassmorphicCard>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <motion.div
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{ duration: 2, repeat: Infinity }}
                      >
                        <Users className="w-5 h-5 text-primary" />
                      </motion.div>
                      معلومات المجموعة
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div className="p-4 bg-gradient-to-br from-primary/10 to-accent/10 rounded-xl">
                        <h3 className="font-bold text-lg mb-2 text-primary">{groupInfo.name}</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">{groupInfo.description}</p>
                      </div>

                      <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                        <span className="text-sm font-medium flex items-center gap-2">
                          <Users className="w-4 h-4" />
                          عدد الطلاب
                        </span>
                        <Badge className="bg-gradient-to-r from-green-500 to-emerald-500 text-white border-0">
                          {groupInfo.current_students}/{groupInfo.max_students}
                        </Badge>
                      </div>

                      {groupInfo.courses && (
                        <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                          <span className="text-sm font-medium flex items-center gap-2">
                            <BookOpen className="w-4 h-4" />
                            الكورس
                          </span>
                          <Badge className="bg-gradient-to-r from-blue-500 to-cyan-500 text-white border-0">
                            {groupInfo.courses.name}
                          </Badge>
                        </div>
                      )}

                      {groupInfo.schedule_days && groupInfo.schedule_days.length > 0 && (
                        <div>
                          <p className="text-sm font-medium mb-2 flex items-center gap-2">
                            <Calendar className="w-4 h-4" />
                            أيام الحضور
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {groupInfo.schedule_days.map((day, index) => (
                              <motion.div
                                key={index}
                                initial={{ opacity: 0, scale: 0 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ delay: index * 0.1 }}
                              >
                                <Badge className="bg-gradient-to-r from-purple-500 to-pink-500 text-white border-0">
                                  {day}
                                </Badge>
                              </motion.div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </GlassmorphicCard>
              </AnimatedSection>
            )}

            {/* Quick Actions */}
            <Card className="shadow-soft">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5" />
                  التواصل
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Button onClick={handleSendMessage} className="w-full" variant="outline">
                  <MessageSquare className="w-4 h-4 ml-2" />
                  مراسلة المدرس
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Main Content */}
          <div className="md:col-span-2 lg:col-span-3 space-y-4 md:space-y-6">
            {/* Course Materials */}
            <Card className="shadow-soft">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  المحتوى التعليمي
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {materials.length > 0 ? (
                    materials.map((material) => (
                      <Card key={material.id} className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {getMaterialIcon(material.material_type)}
                            <div>
                              <h4 className="font-medium">{material.title}</h4>
                              <p className="text-sm text-muted-foreground">
                                {material.courses?.name} - {material.courses?.subject}
                              </p>
                              {material.description && (
                                <p className="text-xs text-muted-foreground mt-1">
                                  {material.description}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Badge variant="secondary">
                              {material.material_type === 'pdf' ? 'PDF' :
                                material.material_type === 'presentation' ? 'عرض' : 'فيديو'}
                            </Badge>
                            {material.file_url && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => window.open(material.file_url, '_blank')}
                              >
                                <Eye className="w-4 h-4 ml-1" />
                                عرض
                              </Button>
                            )}
                          </div>
                        </div>
                      </Card>
                    ))
                  ) : (
                    <p className="text-center text-muted-foreground py-8">
                      لا يوجد محتوى تعليمي متاح حالياً
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Available Exams */}
            <Card className="shadow-soft">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="w-5 h-5" />
                  الامتحانات المتاحة
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {exams.length > 0 ? (
                    exams.map((exam) => (
                      <Card key={exam.id} className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-medium">{exam.title}</h4>
                            <p className="text-sm text-muted-foreground">
                              {exam.courses?.name} - {exam.courses?.subject}
                            </p>
                            <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                              {exam.exam_date && (
                                <div className="flex items-center gap-1">
                                  <Calendar className="w-4 h-4" />
                                  {new Date(exam.exam_date).toLocaleDateString('ar-SA')}
                                </div>
                              )}
                              <div className="flex items-center gap-1">
                                <Clock className="w-4 h-4" />
                                {exam.duration_minutes} دقيقة
                              </div>
                              <span>{exam.total_marks} درجة</span>
                            </div>
                          </div>
                          <Button
                            onClick={() => handleTakeExam(exam.id)}
                            className="shrink-0"
                          >
                            دخول الامتحان
                          </Button>
                        </div>
                      </Card>
                    ))
                  ) : (
                    <p className="text-center text-muted-foreground py-8">
                      لا توجد امتحانات متاحة حالياً
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Exam Results and Grades */}
            <Card className="shadow-soft">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Award className="w-5 h-5" />
                  نتائج الامتحانات
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {examResults.length > 0 ? (
                    examResults.map((result) => {
                      const percentage = (result.marks_obtained / result.exams?.total_marks) * 100;
                      return (
                        <Card key={result.id} className="p-4">
                          <div className="flex items-center justify-between">
                            <div>
                              <h4 className="font-medium">{result.exams?.title}</h4>
                              <p className="text-sm text-muted-foreground">
                                {result.exams?.courses?.name}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {new Date(result.submitted_at).toLocaleDateString('ar-SA')}
                              </p>
                            </div>
                            <div className="text-center">
                              <div className="text-lg font-bold">
                                {result.marks_obtained}/{result.exams?.total_marks}
                              </div>
                              <div className={`text-sm font-medium ${getGradeColor(percentage)}`}>
                                {getGradeText(percentage)} ({percentage.toFixed(0)}%)
                              </div>
                              {result.grade && (
                                <Badge variant="secondary" className="mt-1">
                                  {result.grade}
                                </Badge>
                              )}
                            </div>
                          </div>
                          {result.remarks && (
                            <p className="text-xs text-muted-foreground mt-2 pt-2 border-t">
                              <span className="font-medium">ملاحظات:</span> {result.remarks}
                            </p>
                          )}
                        </Card>
                      );
                    })
                  ) : (
                    <p className="text-center text-muted-foreground py-8">
                      لا توجد نتائج امتحانات بعد
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Recent Messages */}
            <Card className="shadow-soft">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5" />
                  الرسائل الأخيرة
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {messages.length > 0 ? (
                    messages.map((message) => (
                      <Card key={message.id} className="p-3">
                        <p className="text-sm">{message.message_text}</p>
                        <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                          <span>{new Date(message.sent_at).toLocaleDateString('ar-SA')}</span>
                          <Badge variant={message.is_read ? "secondary" : "default"}>
                            {message.is_read ? "مقروءة" : "جديدة"}
                          </Badge>
                        </div>
                      </Card>
                    ))
                  ) : (
                    <p className="text-center text-muted-foreground py-4">
                      لا توجد رسائل
                    </p>
                  )}
                  <Button onClick={handleSendMessage} variant="outline" className="w-full mt-3">
                    عرض جميع الرسائل
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StudentDashboard;