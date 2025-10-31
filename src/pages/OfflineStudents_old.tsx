import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Users, Plus, Edit2, Trash2, Search, Phone, Mail, Eye, EyeOff, DollarSign, Receipt, MessageCircle } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getStudents, getGrades, getGroups, getCourses, updateStudent, deleteStudent, createStudent } from "@/lib/api-http";

const OfflineStudents = () => {
  const [students, setStudents] = useState([]);
  const [courses, setCourses] = useState([]);
  const [groups, setGroups] = useState([]);
  const [grades, setGrades] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCourses, setSelectedCourses] = useState([]);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    grade: "",
    grade_id: "",
    group_id: "",
    password: ""
  });

  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchStudents();
    fetchCourses();
    fetchGroups();
    fetchGrades();
  }, []);

  const fetchGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchStudents = async () => {
    try {
      const data = await getStudents();
      // Filter for offline students only
      const offlineStudents = data.filter(student => student.is_offline === 1 || student.is_offline === '1' || student.is_offline === true);
      setStudents(offlineStudents || []);
    } catch (error) {
      console.error('Error fetching students:', error);
    }
  };

  const fetchCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data || []);
    } catch (error) {
      console.error('Error fetching courses:', error);
    }
  };

  const fetchGroups = async () => {
    try {
      const data = await getGroups();
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const filteredStudents = students.filter((student: any) =>
    student.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    student.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    student.phone?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    if (selectedCourses.length === 0) {
      toast({
        title: "خطأ",
        description: "يجب اختيار كورس واحد على الأقل",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    try {
      if (editingStudent) {
        // Update existing student via Backend API
        const updateData: Record<string, unknown> = {
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          grade: formData.grade,
          grade_id: formData.grade_id || null,
          group_id: formData.group_id || null,
        };

        const success = await updateStudent(editingStudent.id, updateData);

        if (!success) {
          throw new Error("فشل تحديث بيانات الطالب");
        }

        toast({
          title: "تم التحديث بنجاح",
          description: "تم تحديث بيانات الطالب في قاعدة البيانات",
        });
      } else {
        // Create new offline student via Backend API
        if (!formData.password) {
          toast({
            title: "خطأ",
            description: "يجب إدخال كلمة مرور للطالب الجديد",
            variant: "destructive",
          });
          setLoading(false);
          return;
        }

        const newStudent: Partial<Student> = {
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          grade: formData.grade,
          grade_id: formData.grade_id || null,
          group_id: formData.group_id || null,
          password: formData.password,
          is_offline: true,
          approval_status: 'approved',
          courses: selectedCourses as unknown as string[]
        };

        await createStudent(newStudent);

        toast({
          title: "تم الإضافة بنجاح",
          description: "تم إنشاء حساب الطالب الأوفلاين، يمكنه تسجيل الدخول الآن",
        });
      }

      fetchStudents();
      setIsOpen(false);
      resetForm();
    } catch (error: unknown) {
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: error instanceof Error ? error.message : "حدث خطأ، حاول مرة أخرى",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (student: any) => {
    setEditingStudent(student);
    setFormData({
      name: student.name || "",
      email: student.email || "",
      phone: student.phone || "",
      grade: student.grade || "",
      grade_id: student.grade_id || "",
      group_id: student.group_id || "",
      password: ""
    });

    const enrolledCourseIds = student.student_courses?.map((sc: any) => sc.courses.id) || [];
    setSelectedCourses(enrolledCourseIds);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (window.confirm("هل أنت متأكد من حذف هذا الطالب؟")) {
      try {
        const success = await deleteStudent(id);
        
        if (success) {
          toast({
            title: "تم الحذف",
            description: "تم حذف الطالب من قاعدة البيانات",
          });
          fetchStudents();
        } else {
          throw new Error("فشل حذف الطالب");
        }
      } catch (error) {
        console.error('Error deleting student:', error);
        toast({
          title: "خطأ",
          description: "حدث خطأ أثناء حذف الطالب",
          variant: "destructive"
        });
      }
    }
  };

  const resetForm = () => {
    setFormData({
      name: "",
      email: "",
      phone: "",
      grade: "",
      grade_id: "",
      group_id: "",
      password: ""
    });
    setSelectedCourses([]);
    setEditingStudent(null);
    setShowPassword(false);
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const handlePayment = async (student: any) => {
    setSelectedStudent(student);
    setPaymentAmount("");
    setPaymentDescription("");

    // Fetch payment history for this student
    try {
      const { data, error } = await supabase
        .from('account_statement')
        .select('*')
        .eq('student_id', student.id)
        .order('payment_date', { ascending: false });

      if (error) throw error;
      setStudentPayments(data || []);
    } catch (error) {
      console.error('Error fetching payments:', error);
      setStudentPayments([]);
    }

    setIsPaymentOpen(true);
  };

  const calculateTotalDue = (student: any) => {
    const total = student.student_courses?.reduce((total: number, sc: any) => {
      const subscriptionPrice = sc.courses?.subscriptions?.price || 0;
      console.log('Course:', sc.courses?.name, 'Subscription Price:', subscriptionPrice);
      return total + Number(subscriptionPrice);
    }, 0) || 0;
    console.log('Total Due for', student.name, ':', total);
    return total;
  };

  const calculateTotalPaid = () => {
    return studentPayments.reduce((total, payment) => total + Number(payment.amount), 0);
  };

  const submitPayment = async () => {
    if (!paymentAmount || Number(paymentAmount) <= 0) {
      toast({
        title: "خطأ",
        description: "الرجاء إدخال مبلغ صحيح",
        variant: "destructive"
      });
      return;
    }

    try {
      const amount = Number(paymentAmount);
      const paymentDate = new Date().toISOString().split('T')[0];

      // Add to account statement
      const { error: accountError } = await supabase
        .from('account_statement')
        .insert({
          student_id: selectedStudent.id,
          amount: amount,
          payment_date: paymentDate,
          description: paymentDescription || `دفعة من الطالب ${selectedStudent.name}`
        });

      if (accountError) throw accountError;

      // Add to profits
      const { error: profitError } = await supabase
        .from('profits')
        .insert({
          type: 'payment',
          amount: amount,
          description: paymentDescription || `دفعة من الطالب ${selectedStudent.name}`,
          date: paymentDate,
          time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
        });

      if (profitError) throw profitError;

      toast({
        title: "تم التسجيل",
        description: "تم تسجيل الدفعة بنجاح",
      });

      // Refresh payments
      handlePayment(selectedStudent);
      setPaymentAmount("");
      setPaymentDescription("");
    } catch (error) {
      console.error('Error submitting payment:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ أثناء تسجيل الدفعة",
        variant: "destructive"
      });
    }
  };

  const sendWhatsAppMessage = (student: any, isPaid: boolean) => {
    const totalDue = calculateTotalDue(student);
    const totalPaid = calculateTotalPaid();
    const remaining = totalDue - totalPaid;

    let message = `السلام عليكم،\n\n`;
    message += `تحية طيبة لولي أمر الطالب/ة: ${student.name}\n\n`;

    if (isPaid) {
      message += `نشكركم على دفع الرسوم الدراسية.\n`;
      message += `المبلغ المدفوع: ${totalPaid} ج.م\n`;
      if (remaining > 0) {
        message += `المتبقي: ${remaining} ج.م`;
      } else {
        message += `تم سداد كامل المستحقات.`;
      }
    } else {
      message += `نود تذكيركم بالرسوم الدراسية المستحقة.\n`;
      message += `الإجمالي المستحق: ${totalDue} ج.م\n`;
      message += `المدفوع: ${totalPaid} ج.م\n`;
      message += `المتبقي: ${remaining} ج.م\n\n`;
      message += `يرجى التواصل معنا لإتمام الدفع.`;
    }

    message += `\n\nشكراً لتعاونكم.`;

    const phoneNumber = student.phone.replace(/^0/, '2'); // Convert to international format
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/${phoneNumber}?text=${encodedMessage}`, '_blank');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950">
      <Header />

      <div className="container mx-auto p-6 space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2 text-foreground">
              <Users className="h-8 w-8 text-primary" />
              الطلاب الأوفلاين
            </h1>
            <p className="text-muted-foreground mt-1">
              إدارة الطلاب الذين يدخلون بإيميل وباسورد
            </p>
          </div>

          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button className="bg-primary hover:bg-primary/90">
                <Plus className="mr-2 h-4 w-4" />
                إضافة طالب أوفلاين
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {editingStudent ? "تعديل بيانات الطالب" : "إضافة طالب أوفلاين جديد"}
                </DialogTitle>
              </DialogHeader>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">اسم الطالب *</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email">البريد الإلكتروني * (للدخول)</Label>
                    <div className="relative">
                      <Mail className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="email"
                        type="email"
                        className="pr-10"
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="phone">رقم الهاتف *</Label>
                    <div className="relative">
                      <Phone className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="phone"
                        type="tel"
                        className="pr-10"
                        value={formData.phone}
                        onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                        placeholder="01012345678"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">
                      كلمة المرور * {editingStudent && "(اتركه فارغاً لعدم التغيير)"}
                    </Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        required={!editingStudent}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute left-0 top-0 h-full px-3"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="grade">الصف الدراسي *</Label>
                    <Select
                      value={formData.grade_id}
                      onValueChange={(value) => {
                        const selectedGrade = grades.find(g => g.id === value);
                        setFormData({
                          ...formData,
                          grade_id: value,
                          grade: selectedGrade?.name || ""
                        });
                      }}
                      required
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر الصف الدراسي" />
                      </SelectTrigger>
                      <SelectContent>
                        {grades.map((grade) => (
                          <SelectItem key={grade.id} value={grade.id}>
                            {grade.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="group">المجموعة</Label>
                    <Select
                      value={formData.group_id}
                      onValueChange={(value) => setFormData({ ...formData, group_id: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر المجموعة (اختياري)" />
                      </SelectTrigger>
                      <SelectContent>
                        {groups
                          .filter(group => !formData.grade_id || group.grade_id === formData.grade_id)
                          .map((group) => (
                            <SelectItem key={group.id} value={group.id}>
                              {group.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      سيتم تصفية المجموعات بناءاً على الصف المختار
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>الكورسات المسجلة *</Label>
                  <div className="grid grid-cols-2 gap-3 max-h-48 overflow-y-auto border rounded-md p-3">
                    {!formData.grade_id ? (
                      <div className="col-span-2 text-center text-muted-foreground text-sm py-4">
                        الرجاء اختيار الصف الدراسي أولاً
                      </div>
                    ) : courses.filter(course => course.grade_id === formData.grade_id).length === 0 ? (
                      <div className="col-span-2 text-center text-muted-foreground text-sm py-4">
                        لا توجد كورسات متاحة لهذا الصف
                      </div>
                    ) : (
                      courses
                        .filter(course => course.grade_id === formData.grade_id)
                        .map((course) => (
                          <div key={course.id} className="flex items-center space-x-2 space-x-reverse">
                            <Checkbox
                              id={`course-${course.id}`}
                              checked={selectedCourses.includes(course.id)}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setSelectedCourses([...selectedCourses, course.id]);
                                } else {
                                  setSelectedCourses(selectedCourses.filter(id => id !== course.id));
                                }
                              }}
                            />
                            <Label
                              htmlFor={`course-${course.id}`}
                              className="text-sm cursor-pointer"
                            >
                              {course.name} - {course.subject}
                            </Label>
                          </div>
                        ))
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    سيتم عرض الكورسات المتاحة للصف المحدد فقط. سيتم تسجيل قيمة الاشتراك في كشف الحساب والأرباح
                  </p>
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsOpen(false);
                      resetForm();
                    }}
                  >
                    إلغاء
                  </Button>
                  <Button type="submit" disabled={loading}>
                    {loading ? "جاري الحفظ..." : editingStudent ? "تحديث" : "إضافة الطالب"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="relative flex-1">
                <Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="ابحث عن طالب بالاسم أو الإيميل أو الهاتف..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pr-10"
                />
              </div>
              <CardTitle className="text-lg">
                إجمالي الطلاب: {filteredStudents.length}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>الطالب</TableHead>
                    <TableHead>البريد الإلكتروني</TableHead>
                    <TableHead>الهاتف</TableHead>
                    <TableHead>الصف</TableHead>
                    <TableHead>المجموعة</TableHead>
                    <TableHead>الكورسات المسجلة</TableHead>
                    <TableHead>تاريخ التسجيل</TableHead>
                    <TableHead>المستحقات</TableHead>
                    <TableHead className="text-center">الإجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredStudents.map((student: any) => (
                    <TableRow key={student.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar>
                            <AvatarFallback className="bg-primary text-primary-foreground">
                              {getInitials(student.name)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium">{student.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          {student.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          {student.phone}
                        </div>
                      </TableCell>
                      <TableCell>{student.grade || "غير محدد"}</TableCell>
                      <TableCell>
                        {groups.find(g => g.id === student.group_id)?.name || "غير محدد"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {student.student_courses?.map((sc: any, idx: number) => (
                            <span
                              key={idx}
                              className="text-xs bg-primary/10 text-primary px-2 py-1 rounded"
                            >
                              {sc.courses?.name}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        {student.enrollment_date ? new Date(student.enrollment_date).toLocaleDateString('ar-EG') : "غير محدد"}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm font-medium">
                          {calculateTotalDue(student)} ج.م
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-center gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handlePayment(student)}
                            className="text-green-600 hover:text-green-700"
                          >
                            <DollarSign className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(student)}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(student.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {/* Payment Dialog */}
        <Dialog open={isPaymentOpen} onOpenChange={setIsPaymentOpen}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Receipt className="h-5 w-5 text-primary" />
                إدارة المدفوعات - {selectedStudent?.name}
              </DialogTitle>
            </DialogHeader>

            {selectedStudent && (
              <div className="space-y-6">
                {/* Student Info & Summary */}
                <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                  <div>
                    <p className="text-sm text-muted-foreground">الطالب</p>
                    <p className="font-medium">{selectedStudent.name}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">رقم الهاتف</p>
                    <p className="font-medium">{selectedStudent.phone}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">إجمالي المستحقات</p>
                    <p className="font-bold text-lg text-cyan-600">
                      {calculateTotalDue(selectedStudent)} ج.م
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">إجمالي المدفوع</p>
                    <p className="font-bold text-lg text-green-600">
                      {calculateTotalPaid()} ج.م
                    </p>
                  </div>
                  <div className="col-span-2">
                    <p className="text-sm text-muted-foreground">المتبقي</p>
                    <p className="font-bold text-2xl text-primary">
                      {calculateTotalDue(selectedStudent) - calculateTotalPaid()} ج.م
                    </p>
                  </div>
                </div>

                {/* Enrolled Courses */}
                <div>
                  <h3 className="font-semibold mb-2">الكورسات المسجلة:</h3>
                  <div className="space-y-2">
                    {selectedStudent.student_courses?.map((sc: any, idx: number) => {
                      const subscriptionPrice = sc.courses?.subscriptions?.price || 0;
                      const hasSubscription = !!sc.courses?.subscriptions?.price;
                      return (
                        <div key={idx} className="flex justify-between items-center p-3 bg-muted/30 rounded">
                          <div className="flex flex-col">
                            <span>{sc.courses?.name}</span>
                            {!hasSubscription && (
                              <span className="text-xs text-destructive">⚠️ غير مرتبط بخطة اشتراك</span>
                            )}
                          </div>
                          <span className={`font-medium ${!hasSubscription ? 'text-destructive' : ''}`}>
                            {Number(subscriptionPrice).toFixed(2)} ج.م
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Payment Form */}
                <div className="space-y-4 p-4 border rounded-lg">
                  <h3 className="font-semibold">تسجيل دفعة جديدة</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="paymentAmount">المبلغ المدفوع (ج.م)</Label>
                      <Input
                        id="paymentAmount"
                        type="number"
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="paymentDescription">الوصف (اختياري)</Label>
                      <Input
                        id="paymentDescription"
                        value={paymentDescription}
                        onChange={(e) => setPaymentDescription(e.target.value)}
                        placeholder="مثال: دفعة شهر يناير"
                      />
                    </div>
                  </div>
                  <Button onClick={submitPayment} className="w-full">
                    <DollarSign className="ml-2 h-4 w-4" />
                    تسجيل الدفعة
                  </Button>
                </div>

                {/* WhatsApp Notifications */}
                <div className="space-y-2 p-4 border rounded-lg bg-green-50 dark:bg-green-950/20">
                  <h3 className="font-semibold flex items-center gap-2">
                    <MessageCircle className="h-5 w-5 text-green-600" />
                    إرسال رسالة واتساب لولي الأمر
                  </h3>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => sendWhatsAppMessage(selectedStudent, true)}
                    >
                      إشعار دفع
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => sendWhatsAppMessage(selectedStudent, false)}
                    >
                      تذكير بالدفع
                    </Button>
                  </div>
                </div>

                {/* Payment History */}
                <div>
                  <h3 className="font-semibold mb-3">سجل المدفوعات</h3>
                  {studentPayments.length === 0 ? (
                    <p className="text-center text-muted-foreground py-4">
                      لا توجد مدفوعات مسجلة
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {studentPayments.map((payment: any) => (
                        <div key={payment.id} className="flex justify-between items-center p-3 bg-muted/30 rounded">
                          <div>
                            <p className="font-medium">{payment.description}</p>
                            <p className="text-sm text-muted-foreground">
                              {new Date(payment.payment_date).toLocaleDateString('ar-EG')}
                            </p>
                          </div>
                          <span className="font-bold text-green-600">
                            {Number(payment.amount).toFixed(2)} ج.م
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default OfflineStudents;
