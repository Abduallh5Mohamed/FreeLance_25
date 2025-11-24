import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search, Trophy, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getExamResults, getStudents, getGroups, getGrades, User } from "@/lib/api";
import Header from "@/components/Header";

interface ExamResult {
  id: string;
  exam_id: string;
  exam_title: string;
  student_id: string;
  student_name: string;
  grade_name?: string;
  group_name?: string;
  score: number;
  total_marks: number;
  passing_marks?: number;
  status: 'pending' | 'graded' | 'submitted';
  submitted_at: string;
  graded_at?: string;
}

interface Student {
  id: string;
  name: string;
  grade_id?: string;
  group_id?: string;
  grade_name?: string;
  group_name?: string;
}

interface Group {
  id: string;
  name: string;
}

interface Grade {
  id: string;
  name: string;
}

const ExamResults = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [results, setResults] = useState<ExamResult[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [selectedGrade, setSelectedGrade] = useState<string>("all");
  const [selectedStudent, setSelectedStudent] = useState<string>("all");

  // Check authentication
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || (user.role !== 'admin' && user.role !== 'teacher')) {
      navigate('/auth');
      return;
    }

    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      
      // Load all data in parallel
      const [resultsData, studentsData, groupsData, gradesData] = await Promise.all([
        getExamResults(),
        getStudents(),
        getGroups(),
        getGrades(),
      ]);

      setResults(resultsData || []);
      setStudents(studentsData || []);
      setGroups(groupsData || []);
      setGrades(gradesData || []);
    } catch (error) {
      console.error('Error loading data:', error);
      toast({
        title: "خطأ",
        description: "فشل تحميل البيانات",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  // Filter results based on search and filters
  const filteredResults = useMemo(() => {
    return results.filter((result) => {
      // Search filter (name or exam title)
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = result.student_name?.toLowerCase().includes(query);
        const matchesExam = result.exam_title?.toLowerCase().includes(query);
        if (!matchesName && !matchesExam) return false;
      }

      // Group filter
      if (selectedGroup !== "all") {
        const student = students.find(s => s.id === result.student_id);
        if (student?.group_id !== selectedGroup) return false;
      }

      // Grade filter
      if (selectedGrade !== "all") {
        const student = students.find(s => s.id === result.student_id);
        if (student?.grade_id !== selectedGrade) return false;
      }

      // Student filter
      if (selectedStudent !== "all" && result.student_id !== selectedStudent) {
        return false;
      }

      return true;
    });
  }, [results, students, searchQuery, selectedGroup, selectedGrade, selectedStudent]);

  // Get filtered students based on grade and group
  const availableStudents = useMemo(() => {
    return students.filter((student) => {
      if (selectedGrade !== "all" && student.grade_id !== selectedGrade) {
        return false;
      }
      if (selectedGroup !== "all" && student.group_id !== selectedGroup) {
        return false;
      }
      return true;
    });
  }, [students, selectedGrade, selectedGroup]);

  const getPercentage = (score: number, total: number) => {
    return total > 0 ? ((score / total) * 100).toFixed(1) : '0';
  };

  const getStatusBadge = (result: ExamResult) => {
    const percentage = parseFloat(getPercentage(result.score, result.total_marks));
    const passingPercentage = result.passing_marks 
      ? (result.passing_marks / result.total_marks) * 100 
      : 50;

    if (result.status === 'pending') {
      return <Badge variant="secondary">قيد المراجعة</Badge>;
    }

    if (percentage >= 90) {
      return <Badge className="bg-green-600">ممتاز</Badge>;
    } else if (percentage >= passingPercentage) {
      return <Badge className="bg-blue-600">ناجح</Badge>;
    } else {
      return <Badge variant="destructive">راسب</Badge>;
    }
  };

  const getPerformanceIcon = (score: number, total: number) => {
    const percentage = (score / total) * 100;
    if (percentage >= 90) {
      return <TrendingUp className="h-4 w-4 text-green-600" />;
    } else if (percentage >= 50) {
      return <Minus className="h-4 w-4 text-blue-600" />;
    } else {
      return <TrendingDown className="h-4 w-4 text-red-600" />;
    }
  };

  const resetFilters = () => {
    setSearchQuery("");
    setSelectedGroup("all");
    setSelectedGrade("all");
    setSelectedStudent("all");
  };

  if (loading) {
    return (
      <>
        <Header />
        <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6">
          <div className="max-w-7xl mx-auto">
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-gray-600">جاري التحميل...</p>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">نتائج الامتحانات</h1>
            <p className="text-gray-600">عرض ومتابعة درجات الطلاب</p>
          </div>
          <Button onClick={resetFilters} variant="outline">
            إعادة تعيين الفلاتر
          </Button>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle>الفلاتر والبحث</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Search */}
              <div className="relative">
                <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="ابحث بالاسم أو الامتحان..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pr-10 text-right"
                />
              </div>

              {/* Grade Filter */}
              <Select value={selectedGrade} onValueChange={setSelectedGrade}>
                <SelectTrigger className="text-right">
                  <SelectValue placeholder="اختر الصف" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الصفوف</SelectItem>
                  {grades.map((grade) => (
                    <SelectItem key={grade.id} value={grade.id}>
                      {grade.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Group Filter */}
              <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                <SelectTrigger className="text-right">
                  <SelectValue placeholder="اختر المجموعة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المجموعات</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Student Filter */}
              <Select value={selectedStudent} onValueChange={setSelectedStudent}>
                <SelectTrigger className="text-right">
                  <SelectValue placeholder="اختر الطالب" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الطلاب</SelectItem>
                  {availableStudents.map((student) => (
                    <SelectItem key={student.id} value={student.id}>
                      {student.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Active filters summary */}
            {(searchQuery || selectedGroup !== "all" || selectedGrade !== "all" || selectedStudent !== "all") && (
              <div className="mt-4 text-sm text-gray-600">
                عرض {filteredResults.length} من {results.length} نتيجة
              </div>
            )}
          </CardContent>
        </Card>

        {/* Results Table */}
        <Card>
          <CardHeader>
            <CardTitle>النتائج ({filteredResults.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {filteredResults.length === 0 ? (
              <div className="text-center py-12">
                <Trophy className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">لا توجد نتائج</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right">اسم الطالب</TableHead>
                      <TableHead className="text-right">الصف</TableHead>
                      <TableHead className="text-right">المجموعة</TableHead>
                      <TableHead className="text-right">الامتحان</TableHead>
                      <TableHead className="text-right">الدرجة</TableHead>
                      <TableHead className="text-right">النسبة المئوية</TableHead>
                      <TableHead className="text-right">الحالة</TableHead>
                      <TableHead className="text-right">الأداء</TableHead>
                      <TableHead className="text-right">تاريخ التسليم</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredResults.map((result) => {
                      const student = students.find(s => s.id === result.student_id);
                      return (
                        <TableRow key={result.id}>
                          <TableCell className="font-medium">{result.student_name}</TableCell>
                          <TableCell>{student?.grade_name || result.grade_name || '-'}</TableCell>
                          <TableCell>{student?.group_name || result.group_name || '-'}</TableCell>
                          <TableCell>{result.exam_title}</TableCell>
                          <TableCell>
                            <span className="font-semibold">
                              {result.score} / {result.total_marks}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="font-semibold text-blue-600">
                              {getPercentage(result.score, result.total_marks)}%
                            </span>
                          </TableCell>
                          <TableCell>{getStatusBadge(result)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {getPerformanceIcon(result.score, result.total_marks)}
                            </div>
                          </TableCell>
                          <TableCell>
                            {result.submitted_at
                              ? new Date(result.submitted_at).toLocaleDateString('ar-EG')
                              : '-'}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
    </>
  );
};

export default ExamResults;
