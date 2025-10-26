import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { BookOpen, FileText, Clock, Calendar, Download, Play, Eye, MessageSquare, Award, Users, Calendar as CalendarIcon } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useScreenRecordingPrevention } from "@/hooks/useScreenRecordingPrevention";

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
      let studentEmail = null;
      let isOfflineStudent = false;

      // First, check if this is an offline student
      const offlineSession = localStorage.getItem('offlineStudentSession');
      if (offlineSession) {
        const session = JSON.parse(offlineSession);
        // Check if session is still valid (24 hours)
        const isSessionValid = new Date().getTime() - session.timestamp < 24 * 60 * 60 * 1000;

        if (isSessionValid && session.student) {
          studentEmail = session.student.email;
          isOfflineStudent = true;
        } else {
          localStorage.removeItem('offlineStudentSession');
          // auth guard disabled - redirect suppressed
          return;
        }
      } else {
        // Check if student is logged in via Supabase auth
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
          // auth guard disabled - redirect suppressed
          return;
        }
        studentEmail = user.email;
      }

      // Get student data using email
      const { data: student, error: studentError } = await supabase
        .from('students')
        .select(`
          *,
          student_courses (
            courses (
              id,
              name,
              subject,
              description
            )
          )
        `)
        .eq('email', studentEmail)
        .single();

      if (studentError || !student) {
        toast({
          title: "خطأ",
          description: "لا يمكن العثور على بيانات الطالب",
          variant: "destructive",
        });
        // auth guard disabled - redirect suppressed
        return;
      }

      setStudentData(student);

      // Extract enrolled courses
      const enrolledCourses = student.student_courses?.map(sc => sc.courses) || [];
      setCourses(enrolledCourses);

      // Fetch course materials for student's group and enrolled courses only
      if (student.group_id) {
        const enrolledCourseIds = enrolledCourses.map(c => c.id);

        const { data: materialsData, error: materialsError } = await supabase
          .from('material_groups')
          .select(`
            material_id,
            course_materials (
              *,
              courses (
                name,
                subject
              )
            )
          `)
          .eq('group_id', student.group_id);

        if (!materialsError && materialsData) {
          // Filter materials to only show those for enrolled courses
          const materials = materialsData
            .filter(mg =>
              mg.course_materials &&
              enrolledCourseIds.includes(mg.course_materials.course_id)
            )
            .map(mg => mg.course_materials);
          setMaterials(materials);
        }

        // Fetch exams for student's group and enrolled courses only
        const { data: examsData, error: examsError } = await supabase
          .from('exam_groups')
          .select(`
            exam_id,
            exams (
              *,
              courses (
                name,
                subject
              )
            )
          `)
          .eq('group_id', student.group_id);

        if (!examsError && examsData) {
          // Filter exams to only show those for enrolled courses and active exams
          const exams = examsData
            .filter(eg =>
              eg.exams &&
              eg.exams.is_active &&
              enrolledCourseIds.includes(eg.exams.course_id)
            )
            .map(eg => eg.exams);
          setExams(exams);
        }
      }

      // Fetch group information if student has a group
      if (student.group_id) {
        const { data: groupData, error: groupError } = await supabase
          .from('groups')
          .select(`
            *,
            courses (
              name,
              subject
            )
          `)
          .eq('id', student.group_id)
          .single();

        if (!groupError && groupData) {
          setGroupInfo(groupData);
        }
      }

      // Fetch recent messages between student and admin
      const { data: messagesData, error: messagesError } = await supabase
        .from('teacher_messages')
        .select('*')
        .or(`sender_id.eq.${student.id},recipient_id.eq.${student.id}`)
        .order('sent_at', { ascending: false })
        .limit(5);

      if (!messagesError) {
        setMessages(messagesData || []);
      }
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
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="mt-2 text-muted-foreground">جاري التحميل...</p>
        </div>
      </div>
    );
  }

  if (!studentData) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <p className="text-muted-foreground mb-4">لا يمكن العثور على بيانات الطالب</p>
            <Button onClick={() => { /* auth guard disabled - redirect suppressed */ }}>
              العودة لتسجيل الدخول
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <StudentHeader />

      <div className="container mx-auto px-4 py-8">
        {/* Student Profile Section */}
        <Card className="mb-8 shadow-soft">
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <Avatar className="w-16 h-16">
                <AvatarFallback className="text-lg font-medium">
                  {getInitials(studentData.name)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <h1 className="text-2xl font-bold text-foreground">مرحباً، {studentData.name}</h1>
                <p className="text-muted-foreground">{studentData.email}</p>
                <p className="text-sm text-muted-foreground">المرحلة: {studentData.grade}</p>
              </div>
              <div className="text-center">
                <p className="text-sm text-muted-foreground">الكورسات المسجلة</p>
                <p className="text-2xl font-bold text-primary">{courses.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Left Sidebar */}
          <div className="lg:col-span-1 space-y-6">
            {/* Enrolled Courses */}
            <Card className="shadow-soft">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BookOpen className="w-5 h-5" />
                  الكورسات المسجلة
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {courses.length > 0 ? (
                    courses.map((course) => (
                      <Card key={course.id} className="p-3">
                        <h3 className="font-medium">{course.name}</h3>
                        <p className="text-sm text-muted-foreground">{course.subject}</p>
                        {course.description && (
                          <p className="text-xs text-muted-foreground mt-1">{course.description}</p>
                        )}
                      </Card>
                    ))
                  ) : (
                    <p className="text-center text-muted-foreground py-4">
                      لم يتم تسجيلك في أي كورس بعد
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Group Information */}
            {groupInfo && (
              <Card className="shadow-soft">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5" />
                    معلومات المجموعة
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <p className="font-medium">{groupInfo.name}</p>
                    <p className="text-sm text-muted-foreground">{groupInfo.description}</p>
                    <p className="text-sm">
                      <span className="font-medium">الطلاب:</span> {groupInfo.current_students}/{groupInfo.max_students}
                    </p>
                    {groupInfo.courses && (
                      <p className="text-sm">
                        <span className="font-medium">الكورس:</span> {groupInfo.courses.name}
                      </p>
                    )}
                    {groupInfo.schedule_days && groupInfo.schedule_days.length > 0 && (
                      <div className="text-sm">
                        <span className="font-medium">أيام الحضور:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {groupInfo.schedule_days.map((day, index) => (
                            <Badge key={index} variant="outline" className="text-xs">
                              {day}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
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
          <div className="lg:col-span-3 space-y-6">
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