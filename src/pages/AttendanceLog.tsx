import { useState, useEffect, useMemo } from 'react';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getGrades, getGroups, getStudents, getAttendance, type Grade, type Group, type Student, type Attendance } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Search, Check, X } from 'lucide-react';

const AttendanceLog = () => {
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);

  const [selectedGradeId, setSelectedGradeId] = useState<string>('');
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [selectedStudentId, setSelectedStudentId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');

  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [loading, setLoading] = useState(false);

  const { toast } = useToast();

  useEffect(() => {
    fetchGrades();
  }, []);

  useEffect(() => {
    if (selectedGradeId) {
      fetchGroups(selectedGradeId);
    } else {
      setGroups([]);
      setSelectedGroupId('');
    }
  }, [selectedGradeId]);

  useEffect(() => {
    if (selectedGroupId) {
      fetchStudents(selectedGroupId);
    } else {
      setStudents([]);
      setSelectedStudentId('');
    }
  }, [selectedGroupId]);

  useEffect(() => {
    if (selectedStudentId) {
      fetchAttendance(selectedStudentId);
    } else {
      setAttendance([]);
    }
  }, [selectedStudentId, currentMonth]);

  const fetchGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchGroups = async (gradeId: string) => {
    try {
      const allGroups = await getGroups();
      const filtered = allGroups.filter(g => g.grade_id === gradeId);
      setGroups(filtered);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const fetchStudents = async (groupId: string) => {
    try {
      const data = await getStudents();
      const filtered = data.filter((s: any) => s.group_id === groupId);
      setStudents(filtered);
    } catch (error) {
      console.error('Error fetching students:', error);
    }
  };

  const fetchAttendance = async (studentId: string) => {
    try {
      setLoading(true);
      const start = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
      const end = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
      const formatLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const startStr = formatLocal(start);
      const endStr = formatLocal(end);

      const data = await getAttendance({
        student_id: studentId,
        start_date: startStr,
        end_date: endStr,
        order: 'asc'
      });
      setAttendance(data || []);
    } catch (error) {
      console.error('Error fetching attendance:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل سجل الحضور',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const getScheduledSessionDates = (schedule_days: string[] | string | null | undefined): Date[] => {
    const dates: Date[] = [];
    if (!schedule_days) return dates;

    let days: string[] = [];
    if (typeof schedule_days === 'string') {
      try {
        days = JSON.parse(schedule_days);
      } catch {
        days = [];
      }
    } else if (Array.isArray(schedule_days)) {
      days = schedule_days;
    }

    if (days.length === 0) {
      // If no schedule_days, consider all days of the month
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      const lastDay = new Date(year, month + 1, 0).getDate();
      for (let d = 1; d <= lastDay; d++) {
        dates.push(new Date(year, month, d));
      }
      return dates;
    }

    const dayMap: { [k: string]: number } = {
      sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
    };
    const dayNums = days.map(d => dayMap[d.toLowerCase()]).filter(n => n !== undefined);

    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();

    for (let d = 1; d <= lastDay; d++) {
      const date = new Date(year, month, d);
      if (dayNums.includes(date.getDay())) {
        dates.push(date);
      }
    }

    return dates;
  };

  const selectedGroup = useMemo(() => {
    return groups.find(g => g.id === selectedGroupId);
  }, [groups, selectedGroupId]);

  const scheduledDates = useMemo(() => {
    if (!selectedGroup) return [];
    return getScheduledSessionDates(selectedGroup.schedule_days);
  }, [selectedGroup, currentMonth]);

  const attendanceMap = useMemo(() => {
    const map: { [dateStr: string]: Attendance } = {};
    attendance.forEach(a => {
      if (!a.attendance_date) return;
      // Avoid UTC shift: format using local date parts instead of toISOString
      const d = new Date(a.attendance_date as any);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      map[dateStr] = a;
    });
    return map;
  }, [attendance]);

  const filteredStudents = useMemo(() => {
    if (!searchTerm.trim()) return students;
    const term = searchTerm.toLowerCase();
    return students.filter((s: any) =>
      s.name?.toLowerCase().includes(term) ||
      s.phone?.toLowerCase().includes(term)
    );
  }, [students, searchTerm]);

  const handlePrevMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  };

  const monthLabel = currentMonth.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long' });

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <CalendarIcon className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">سجل الحضور</h1>
            <p className="text-muted-foreground">عرض سجل حضور الطلاب على التقويم الشهري</p>
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>التصفية</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>الصف الدراسي</Label>
                <Select value={selectedGradeId} onValueChange={setSelectedGradeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الصف" />
                  </SelectTrigger>
                  <SelectContent>
                    {grades.map(g => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>المجموعة</Label>
                <Select value={selectedGroupId} onValueChange={setSelectedGroupId} disabled={!selectedGradeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر المجموعة" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map(g => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>البحث عن الطالب</Label>
                <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2">
                  <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <Input
                    placeholder="ابحث بالاسم أو الهاتف..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
                    disabled={!selectedGroupId}
                  />
                </div>
              </div>
            </div>

            {selectedGroupId && (
              <div className="space-y-2">
                <Label>الطالب</Label>
                <Select value={selectedStudentId} onValueChange={setSelectedStudentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الطالب" />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredStudents.map((s: any) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>

        {selectedStudentId && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{monthLabel}</CardTitle>
                <div className="flex gap-2">
                  <Button variant="outline" size="icon" onClick={handlePrevMonth}>
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="icon" onClick={handleNextMonth}>
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-center py-8 text-muted-foreground">جاري التحميل...</div>
              ) : scheduledDates.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">لا توجد أيام مجدولة لهذا الشهر</div>
              ) : (
                <div className="space-y-3">
                  {scheduledDates.map(date => {
                    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                    const record = attendanceMap[dateStr];
                    const dayLabel = date.toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

                    return (
                      <div key={dateStr} className="flex items-center justify-between p-4 border rounded-lg hover:shadow transition">
                        <div className="flex items-center gap-3">
                          <div className="text-sm font-medium text-muted-foreground">{dayLabel}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {record ? (
                            record.status === 'present' ? (
                              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                                <Check className="w-4 h-4" />
                                <span className="text-xs font-semibold">حاضر</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                                <X className="w-4 h-4" />
                                <span className="text-xs font-semibold">غائب</span>
                              </div>
                            )
                          ) : (
                            <div className="text-xs text-muted-foreground px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-800">لم يسجل</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default AttendanceLog;
