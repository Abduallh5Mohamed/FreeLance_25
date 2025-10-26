import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calendar, Check, X, Users, Search } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";

const Attendance = () => {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedCourse, setSelectedCourse] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [students, setStudents] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [courses, setCourses] = useState([]);
  const { toast } = useToast();

  useEffect(() => {
    fetchStudents();
    fetchCourses();
    fetchAttendance();
  }, [selectedDate]);

  const fetchStudents = async () => {
    try {
      const { data, error } = await supabase
        .from('students')
        .select(`
          *,
          student_courses (
            courses (
              id,
              name,
              subject
            )
          )
        `)
        .eq('is_active', true);
      
      if (error) throw error;
      setStudents(data || []);
    } catch (error) {
      console.error('Error fetching students:', error);
    }
  };

  const fetchCourses = async () => {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('*');
      
      if (error) throw error;
      setCourses(data || []);
    } catch (error) {
      console.error('Error fetching courses:', error);
    }
  };

  const fetchAttendance = async () => {
    try {
      const { data, error } = await supabase
        .from('attendance')
        .select(`
          *,
          students (name, email),
          courses (name)
        `)
        .eq('attendance_date', selectedDate);
      
      if (error) throw error;
      setAttendance(data || []);
    } catch (error) {
      console.error('Error fetching attendance:', error);
    }
  };

  const markAttendance = async (studentId: string, status: 'present' | 'absent') => {
    try {
      // Check if attendance already exists for this student on this date
      const { data: existingAttendance } = await supabase
        .from('attendance')
        .select('*')
        .eq('student_id', studentId)
        .eq('attendance_date', selectedDate)
        .single();

      if (existingAttendance) {
        // Update existing attendance
        const { error } = await supabase
          .from('attendance')
          .update({ status })
          .eq('id', existingAttendance.id);
        
        if (error) throw error;
      } else {
        // Create new attendance record
        const student = students.find(s => s.id === studentId);
        if (student?.student_courses?.[0]) {
          const { error } = await supabase
            .from('attendance')
            .insert({
              student_id: studentId,
              course_id: student.student_courses[0].courses.id,
              attendance_date: selectedDate,
              status
            });
          
          if (error) throw error;
        }
      }

      fetchAttendance();
      toast({
        title: `تم تسجيل ${status === 'present' ? 'الحضور' : 'الغياب'}`,
        description: `تم تسجيل الحضور للطالب`,
      });
    } catch (error) {
      toast({
        title: "خطأ",
        description: "حدث خطأ في تسجيل الحضور",
        variant: "destructive",
      });
    }
  };

  const getStudentAttendance = (studentId: string) => {
    return attendance.find(a => 
      a.student_id === studentId && 
      a.attendance_date === selectedDate
    );
  };

  const attendanceStats = {
    present: attendance.filter(a => a.status === 'present').length,
    absent: attendance.filter(a => a.status === 'absent').length,
    total: students.length
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl">
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
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {students.length > 0 ? (
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
                          onClick={() => markAttendance(student.id, 'present')}
                          className="text-xs"
                        >
                          <Check className="w-3 h-3 ml-1" />
                          حاضر
                        </Button>
                        <Button
                          size="sm"
                          variant={studentAttendance?.status === 'absent' ? "destructive" : "outline"}
                          onClick={() => markAttendance(student.id, 'absent')}
                          className="text-xs"
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
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الطالب</TableHead>
                    <TableHead>الكورس</TableHead>
                    <TableHead>التاريخ</TableHead>
                    <TableHead>الحالة</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attendance.length > 0 ? (
                    attendance
                      .filter(record => {
                        const matchesSearch = record.students?.name.toLowerCase().includes(searchTerm.toLowerCase());
                        const matchesCourse = selectedCourse === "all" || record.courses?.name === selectedCourse;
                        return matchesSearch && matchesCourse;
                      })
                      .map((record) => (
                        <TableRow key={record.id}>
                          <TableCell className="font-medium">{record.students?.name}</TableCell>
                          <TableCell>{record.courses?.name}</TableCell>
                          <TableCell>{record.attendance_date}</TableCell>
                          <TableCell>
                            <span className={`px-2 py-1 rounded-full text-xs ${
                              record.status === 'present' 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-red-100 text-red-800'
                            }`}>
                              {record.status === 'present' ? 'حاضر' : 'غائب'}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        لا توجد سجلات حضور لهذا التاريخ
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Attendance;