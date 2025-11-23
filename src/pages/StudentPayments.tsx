import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Search, ChevronDown, ChevronUp, DollarSign, Calendar, Clock, User, Phone, CreditCard } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '/api';

interface Student {
  id: string;
  name: string;
  phone: string;
  guardian_phone: string;
  barcode: string;
  grade_id: string;
  group_id: string;
  is_active: boolean;
}

interface Payment {
  id: string;
  student_id?: string;
  student_name: string;
  phone: string;
  guardian_phone?: string;
  amount: number;
  paid_amount: number;
  remaining_amount: number;
  payment_year: number;
  payment_month: number;
  payment_date: string;
  payment_method: string;
  status: string;
  notes?: string;
  created_at: string;
  grade_id?: string;
  group_id?: string;
}

interface Grade {
  id: string;
  name: string;
}

interface Group {
  id: string;
  name: string;
}

const StudentPayments = () => {
  const [students, setStudents] = useState<Student[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [payments, setPayments] = useState<Record<string, Payment[]>>({});
  const [expandedStudents, setExpandedStudents] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedGrade, setSelectedGrade] = useState<string>("all");
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const token = localStorage.getItem('token');
        const headers = { Authorization: `Bearer ${token}` };

        // Fetch all data in parallel
        const [studentsRes, gradesRes, groupsRes, feesRes] = await Promise.all([
          axios.get(`${API_URL}/students`, { headers }),
          axios.get(`${API_URL}/grades`, { headers }),
          axios.get(`${API_URL}/groups`, { headers }),
          axios.get(`${API_URL}/fees`, { headers })
        ]);

        const activeStudents = studentsRes.data.filter((s: Student) => s.is_active);
        setStudents(activeStudents);
        setGrades(gradesRes.data.filter((g: Grade & { is_active: boolean }) => g.is_active));
        setGroups(groupsRes.data.filter((g: Group & { is_active: boolean }) => g.is_active));

        // Group payments by student
        const paymentsByStudent: Record<string, Payment[]> = {};

        for (const student of activeStudents) {
          // Get all payments for this student (by phone or student_id)
          const studentPayments = feesRes.data.filter((fee: Payment) =>
            fee.phone === student.phone ||
            (fee.student_id && fee.student_id === student.id)
          );

          // Sort by date descending (newest first)
          studentPayments.sort((a: Payment, b: Payment) => {
            const dateA = new Date(a.payment_date || a.created_at).getTime();
            const dateB = new Date(b.payment_date || b.created_at).getTime();
            return dateB - dateA;
          });

          paymentsByStudent[student.id] = studentPayments;
        }

        setPayments(paymentsByStudent);
      } catch (error) {
        console.error('Error fetching data:', error);
        toast({
          title: "خطأ",
          description: "فشل تحميل البيانات",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [toast]);

  const fetchData = async () => {
    // This function is no longer needed - merged into useEffect
  };

  const toggleStudent = (studentId: string) => {
    const newExpanded = new Set(expandedStudents);
    if (newExpanded.has(studentId)) {
      newExpanded.delete(studentId);
    } else {
      newExpanded.add(studentId);
    }
    setExpandedStudents(newExpanded);
  };

  const getMonthName = (month: number) => {
    const months = [
      'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
      'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
    ];
    return months[month - 1] || month.toString();
  };

  const formatDateTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return {
      date: date.toLocaleDateString('ar-EG', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }),
      time: date.toLocaleTimeString('ar-EG', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      })
    };
  };

  const getTotalPaid = (studentId: string) => {
    const studentPayments = payments[studentId] || [];
    return studentPayments
      .filter(p => p.status === 'paid')
      .reduce((sum, p) => sum + (Number(p.paid_amount) || Number(p.amount) || 0), 0);
  };

  const getPaymentCount = (studentId: string) => {
    return (payments[studentId] || []).filter(p => p.status === 'paid').length;
  };

  const getTotalAllStudents = () => {
    return filteredStudents.reduce((sum, s) => sum + getTotalPaid(s.id), 0);
  };

  const getTotalPaymentCount = () => {
    return filteredStudents.reduce((sum, s) => sum + getPaymentCount(s.id), 0);
  };

  const getAveragePayment = () => {
    const total = getTotalAllStudents();
    const count = filteredStudents.length;
    return count > 0 ? Math.round(total / count) : 0;
  };

  const filteredStudents = students.filter(student => {
    const matchesSearch = !searchTerm ||
      student.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      student.phone.includes(searchTerm) ||
      (student.guardian_phone && student.guardian_phone.includes(searchTerm));

    const matchesGrade = selectedGrade === "all" || student.grade_id === selectedGrade;
    const matchesGroup = selectedGroup === "all" || student.group_id === selectedGroup;

    return matchesSearch && matchesGrade && matchesGroup;
  });

  const getGradeName = (gradeId: string) => {
    return grades.find(g => g.id === gradeId)?.name || '-';
  };

  const getGroupName = (groupId: string) => {
    return groups.find(g => g.id === groupId)?.name || '-';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-900 dark:via-blue-950 dark:to-indigo-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <DollarSign className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">سجل دفعات الطلاب</h1>
            <p className="text-muted-foreground">عرض تفصيلي لجميع دفعات كل طالب</p>
          </div>
        </div>

        {/* Filters */}
        <Card className="mb-6 shadow-soft">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="md:col-span-2">
                <div className="relative">
                  <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                  <Input
                    placeholder="بحث بالاسم أو رقم التلفون..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pr-10"
                  />
                </div>
              </div>

              <Select value={selectedGrade} onValueChange={setSelectedGrade}>
                <SelectTrigger>
                  <SelectValue placeholder="كل الصفوف" />
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

              <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                <SelectTrigger>
                  <SelectValue placeholder="كل المجموعات" />
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
            </div>
          </CardContent>
        </Card>

        {/* Statistics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card className="shadow-soft">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
                  <User className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">إجمالي الطلاب</p>
                  <p className="text-2xl font-bold">{filteredStudents.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                  <DollarSign className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">إجمالي الدفعات</p>
                  <p className="text-2xl font-bold">
                    {getTotalAllStudents().toLocaleString()} ج.م
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                  <CreditCard className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">عدد الدفعات</p>
                  <p className="text-2xl font-bold">
                    {getTotalPaymentCount()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-orange-100 dark:bg-orange-900/30 rounded-lg flex items-center justify-center">
                  <Calendar className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">متوسط دفعة/طالب</p>
                  <p className="text-2xl font-bold">
                    {getAveragePayment().toLocaleString()} ج.م
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Students List */}
        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>قائمة الطلاب ({filteredStudents.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-8 text-muted-foreground">
                جاري التحميل...
              </div>
            ) : filteredStudents.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                لا توجد نتائج
              </div>
            ) : (
              <div className="space-y-2">
                {filteredStudents.map((student) => {
                  const isExpanded = expandedStudents.has(student.id);
                  const studentPayments = payments[student.id] || [];
                  const totalPaid = getTotalPaid(student.id);
                  const paymentCount = getPaymentCount(student.id);

                  return (
                    <Collapsible
                      key={student.id}
                      open={isExpanded}
                      onOpenChange={() => toggleStudent(student.id)}
                    >
                      <Card className={`border transition-all ${isExpanded ? 'border-primary shadow-md' : 'border-border'}`}>
                        <CollapsibleTrigger asChild>
                          <div className="p-4 cursor-pointer hover:bg-accent/50 transition-colors">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-4 flex-1">
                                <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
                                  <User className="h-5 w-5 text-primary" />
                                </div>

                                <div className="flex-1 grid grid-cols-1 md:grid-cols-5 gap-3">
                                  <div>
                                    <p className="font-semibold text-foreground">{student.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {getGradeName(student.grade_id)} - {getGroupName(student.group_id)}
                                    </p>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Phone className="h-3 w-3 text-muted-foreground" />
                                    <span className="text-sm font-mono">{student.phone}</span>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Phone className="h-3 w-3 text-muted-foreground" />
                                    <span className="text-sm font-mono text-muted-foreground">
                                      {student.guardian_phone || '-'}
                                    </span>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Badge variant="secondary" className="gap-1">
                                      <CreditCard className="h-3 w-3" />
                                      {paymentCount} دفعة
                                    </Badge>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Badge variant="default" className="gap-1 bg-green-600">
                                      <DollarSign className="h-3 w-3" />
                                      {totalPaid.toLocaleString()} ج.م
                                    </Badge>
                                  </div>
                                </div>

                                <Button variant="ghost" size="sm">
                                  {isExpanded ? (
                                    <ChevronUp className="h-4 w-4" />
                                  ) : (
                                    <ChevronDown className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </div>
                          </div>
                        </CollapsibleTrigger>

                        <CollapsibleContent>
                          <div className="border-t bg-accent/30 p-4">
                            {studentPayments.length === 0 ? (
                              <p className="text-center text-muted-foreground py-4">
                                لا توجد دفعات لهذا الطالب
                              </p>
                            ) : (
                              <div className="space-y-3">
                                <h4 className="font-semibold text-sm mb-3">
                                  تفاصيل الدفعات ({studentPayments.length})
                                </h4>
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="text-right">الشهر</TableHead>
                                      <TableHead className="text-right">المبلغ</TableHead>
                                      <TableHead className="text-right">المدفوع</TableHead>
                                      <TableHead className="text-right">المتبقي</TableHead>
                                      <TableHead className="text-right">الحالة</TableHead>
                                      <TableHead className="text-right">تاريخ الدفع</TableHead>
                                      <TableHead className="text-right">الساعة</TableHead>
                                      <TableHead className="text-right">طريقة الدفع</TableHead>
                                      <TableHead className="text-right">ملاحظات</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {studentPayments.map((payment) => {
                                      const { date, time } = formatDateTime(payment.payment_date || payment.created_at);
                                      return (
                                        <TableRow key={payment.id}>
                                          <TableCell className="font-medium">
                                            {payment.payment_month && payment.payment_year ? (
                                              <div className="flex items-center gap-2">
                                                <Calendar className="h-3 w-3 text-muted-foreground" />
                                                <span>
                                                  {getMonthName(payment.payment_month)} {payment.payment_year}
                                                </span>
                                              </div>
                                            ) : (
                                              '-'
                                            )}
                                          </TableCell>
                                          <TableCell className="font-mono">
                                            {Number(payment.amount || 0).toLocaleString()} ج.م
                                          </TableCell>
                                          <TableCell className="font-mono text-green-600">
                                            {Number(payment.paid_amount || 0).toLocaleString()} ج.م
                                          </TableCell>
                                          <TableCell className="font-mono text-red-600">
                                            {Number(payment.remaining_amount || 0).toLocaleString()} ج.م
                                          </TableCell>
                                          <TableCell>
                                            <Badge variant={payment.status === 'paid' ? 'default' : 'destructive'}>
                                              {payment.status === 'paid' ? 'مدفوع' : 'غير مدفوع'}
                                            </Badge>
                                          </TableCell>
                                          <TableCell className="text-sm">
                                            {date}
                                          </TableCell>
                                          <TableCell className="text-sm font-mono">
                                            <div className="flex items-center gap-1">
                                              <Clock className="h-3 w-3 text-muted-foreground" />
                                              {time}
                                            </div>
                                          </TableCell>
                                          <TableCell>
                                            <Badge variant="outline">
                                              {payment.payment_method === 'cash' ? 'كاش' :
                                                payment.payment_method === 'card' ? 'كارت' :
                                                  payment.payment_method === 'online' ? 'أونلاين' :
                                                    payment.payment_method}
                                            </Badge>
                                          </TableCell>
                                          <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                                            {payment.notes || '-'}
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                          </div>
                        </CollapsibleContent>
                      </Card>
                    </Collapsible>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default StudentPayments;
