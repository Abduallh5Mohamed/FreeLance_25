import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Calendar, Check, X, Users, Search } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getStudents, getCourses, getAttendance, markAttendance } from "@/lib/api";
import { classifyAttendanceError, createKeyedSubmissionGuard, createResponseSequence, submitAttendanceMark } from "@/pages/QRAttendance";
import { todayDayKey, instantToDayKey } from "@/lib/attendance-calendar";

type AttendanceLoadErrors = {
  students?: string;
  courses?: string;
  attendance?: string;
};

const Attendance = () => {
  // Default to the current Africa/Cairo attendance business day
  // (supervisor/026): every operator sees the same "today" the server uses,
  // regardless of host timezone.
  const [selectedDate, setSelectedDate] = useState(todayDayKey());
  const [selectedCourse, setSelectedCourse] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [students, setStudents] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [courses, setCourses] = useState([]);
  const [loadErrors, setLoadErrors] = useState<AttendanceLoadErrors>({});
  const [pendingStudentIds, setPendingStudentIds] = useState<string[]>([]);
  const attendanceSequence = useRef(createResponseSequence());
  // Synchronous per-student single-flight guard: closes the pre-render window
  // that the pendingStudentIds React state leaves open for two same-tick calls.
  const submissionGuard = useRef(createKeyedSubmissionGuard());
  const { toast } = useToast();

  useEffect(() => {
    fetchStudents();
    fetchCourses();
    fetchAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  const fetchStudents = async () => {
    try {
      const data = await getStudents();
      setStudents(data || []);
      setLoadErrors((prev) => ({ ...prev, students: undefined }));
    } catch (error) {
      console.error('Error fetching students:', error);
      setLoadErrors((prev) => ({ ...prev, students: classifyAttendanceError(error).message }));
    }
  };

  const fetchCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data || []);
      setLoadErrors((prev) => ({ ...prev, courses: undefined }));
    } catch (error) {
      console.error('Error fetching courses:', error);
      setLoadErrors((prev) => ({ ...prev, courses: classifyAttendanceError(error).message }));
    }
  };

  const fetchAttendance = async () => {
    const token = attendanceSequence.current.next();
    try {
      const data = await getAttendance({ date: selectedDate });
      // Ignore a stale response belonging to a superseded date selection.
      if (!attendanceSequence.current.isCurrent(token)) return;
      setAttendance(data || []);
      setLoadErrors((prev) => ({ ...prev, attendance: undefined }));
    } catch (error) {
      if (!attendanceSequence.current.isCurrent(token)) return;
      console.error('Error fetching attendance:', error);
      setLoadErrors((prev) => ({ ...prev, attendance: classifyAttendanceError(error).message }));
    }
  };

  const handleMarkAttendance = async (studentId: string, status: 'present' | 'absent') => {
    // Mark the UI as pending, then claim the per-student slot synchronously
    // (before any await) inside submitAttendanceMark so two calls in the same
    // tick cannot both issue a write. The loser performs no I/O.
    setPendingStudentIds((prev) => (prev.includes(studentId) ? prev : [...prev, studentId]));
    const outcome = await submitAttendanceMark(
      // The selected value is a validated YYYY-MM-DD key; parsed as UTC
      // midnight it denotes the SAME Africa/Cairo calendar day (Cairo is
      // always UTC+2/+3, ahead of UTC), so the server's instant->Cairo-day
      // conversion records exactly the selected day on every host.
      { studentId, status, date: new Date(selectedDate) },
      { markAttendance, refreshAttendance: () => fetchAttendance() },
      submissionGuard.current,
    );

    // A same-tick duplicate lost the race; the winner owns the pending flag.
    if (outcome.kind === 'ignored') return;

    try {
      if (outcome.kind === 'recorded') {
        toast({
          title: `تم تسجيل ${status === 'present' ? 'الحضور' : 'الغياب'}`,
          description: `تم تسجيل ${status === 'present' ? 'الحضور' : 'الغياب'} للطالب`,
        });
      } else if (outcome.kind === 'duplicate') {
        toast({
          title: 'تنبيه',
          description: 'تم تسجيل الحضور مسبقاً لهذا التاريخ',
          variant: 'default',
        });
      } else {
        // Server/network/auth failure: submitAttendanceMark already re-read the
        // server's authoritative rows, so no false success is shown.
        toast({
          title: 'خطأ',
          description: outcome.classified.message,
          variant: 'destructive',
        });
      }
    } finally {
      setPendingStudentIds((prev) => prev.filter((id) => id !== studentId));
    }
  };

  const getStudentAttendance = (studentId: string) => {
    return attendance.find(a =>
      a.student_id === studentId &&
      // attendance_date arrives as a datetime; compare the Africa/Cairo
      // business day it denotes against the selected calendar-day key.
      instantToDayKey(a.attendance_date) === selectedDate
    );
  };

  const attendanceStats = {
    present: attendance.filter(a => a.status === 'present').length,
    absent: attendance.filter(a => a.status === 'absent').length,
    total: students.length
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Calendar className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">تسجيل الحضور</h1>
              <p className="text-muted-foreground">متابعة حضور وغياب الطلاب</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card className="shadow-soft">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                  <Check className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">الحضور</p>
                  <p className="text-2xl font-bold text-green-600">{attendanceStats.present}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
                  <X className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">الغياب</p>
                  <p className="text-2xl font-bold text-red-600">{attendanceStats.absent}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
                  <Users className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">إجمالي الطلاب</p>
                  <p className="text-2xl font-bold text-primary">{attendanceStats.total}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle>تسجيل الحضور اليوم</CardTitle>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="max-w-[200px]"
                  aria-label="تاريخ الحضور"
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadErrors.students ? (
                <div className="text-center py-8 space-y-3">
                  <p className="text-destructive font-medium">{loadErrors.students}</p>
                  <Button variant="outline" size="sm" onClick={() => fetchStudents()}>
                    إعادة المحاولة
                  </Button>
                </div>
              ) : students.length > 0 ? (
                students.map((student) => {
                  const studentAttendance = getStudentAttendance(student.id);
                  return (
                    <div key={student.id} className="flex items-center justify-between p-3 border rounded-lg">
                      <div>
                        <p className="font-medium">{student.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {student.student_courses?.map(sc => sc.courses.name).join(', ') || 'لا توجد كورسات'}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant={studentAttendance?.status === 'present' ? "default" : "outline"}
                          onClick={() => handleMarkAttendance(student.id, 'present')}
                          className="text-xs"
                          disabled={pendingStudentIds.includes(student.id)}
                          aria-label={`تسجيل حضور ${student.name}`}
                        >
                          <Check className="w-3 h-3 ml-1" />
                          حاضر
                        </Button>
                        <Button
                          size="sm"
                          variant={studentAttendance?.status === 'absent' ? "destructive" : "outline"}
                          onClick={() => handleMarkAttendance(student.id, 'absent')}
                          className="text-xs"
                          disabled={pendingStudentIds.includes(student.id)}
                          aria-label={`تسجيل غياب ${student.name}`}
                        >
                          <X className="w-3 h-3 ml-1" />
                          غائب
                        </Button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>لا توجد طلاب مسجلين</p>
                  <p className="text-sm">أضف طلاب أولاً من صفحة الطلاب</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle>سجل الحضور</CardTitle>
              <div className="flex gap-2">
                <div className="flex items-center gap-2">
                  <Search className="w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="البحث عن طالب..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="max-w-[200px]"
                    aria-label="البحث عن طالب"
                  />
                </div>
                <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                  <SelectTrigger className="max-w-[200px]">
                    <SelectValue placeholder="اختر الكورس" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">جميع الكورسات</SelectItem>
                    {courses.map((course) => (
                      <SelectItem key={course.id} value={course.name}>{course.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {loadErrors.courses && (
                  <p className="text-xs text-destructive mt-1">{loadErrors.courses}</p>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {loadErrors.attendance ? (
                <div className="text-center py-12 space-y-3">
                  <p className="text-destructive font-medium">{loadErrors.attendance}</p>
                  <Button variant="outline" size="sm" onClick={() => fetchAttendance()}>
                    إعادة المحاولة
                  </Button>
                </div>
              ) : attendance.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">لا توجد سجلات حضور لهذا التاريخ</div>
              ) : (
                <div className="space-y-4">
                  {attendance
                    .filter(record => {
                      const matchesSearch = record.students?.name.toLowerCase().includes(searchTerm.toLowerCase());
                      const matchesCourse = selectedCourse === "all" || record.courses?.name === selectedCourse;
                      return matchesSearch && matchesCourse;
                    })
                    .map((record) => (
                      <div key={record.id} className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900">
                        <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <Avatar className="h-10 w-10 border-2 border-white">
                              <AvatarFallback className="text-xs bg-white text-cyan-600">{(record.students?.name || '').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}</AvatarFallback>
                            </Avatar>
                            <div>
                              <h3 className="font-bold text-white text-lg">{record.students?.name}</h3>
                              <div className="text-xs text-cyan-50">{record.courses?.name || '-'}</div>
                            </div>
                          </div>
                          <div className="text-sm text-white">
                            {record.attendance_date}
                          </div>
                        </div>
                        <div className="p-4">
                          <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">⚡ الحالة</div>
                          <div>
                            <span className={`px-3 py-1 rounded-full text-xs font-semibold ${record.status === 'present' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
                              {record.status === 'present' ? 'حاضر' : 'غائب'}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Attendance;