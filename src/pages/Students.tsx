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
import { Users, Plus, Edit2, Trash2, Search, Phone, Mail } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getStudents, getGrades, getGroups, getCourses, getSubscriptions, updateStudent, deleteStudent } from "@/lib/api-http";
import { supabase } from "@/integrations/supabase/client";

const Students = () => {
  const [students, setStudents] = useState([]);
  const [courses, setCourses] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
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
    subscription_id: "",
    subscription_price: "",
    group_id: "",
    password: ""
  });

  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchStudents();
    fetchCourses();
    fetchSubscriptions();
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
      // Filter for online students only (is_offline = false or 0)
      const onlineStudents = data.filter(student => !student.is_offline || student.is_offline === 0 || student.is_offline === false);
      setStudents(onlineStudents || []);
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

  const fetchSubscriptions = async () => {
    try {
      const data = await getSubscriptions();
      setSubscriptions(data || []);
    } catch (error) {
      console.error('Error fetching subscriptions:', error);
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

  const filteredStudents = students.filter(student =>
    student.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    student.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    student.phone?.includes(searchTerm)
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
      if (!editingStudent) {
        throw new Error("هذه الصفحة للتعديل فقط. الطلاب الأونلاين يسجلون من خلال صفحة التسجيل");
      }

      // Update student via Backend API
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

      fetchStudents();
      setIsOpen(false);
      setEditingStudent(null);
      setSelectedCourses([]);
      setFormData({ name: "", email: "", phone: "", grade: "", grade_id: "", subscription_id: "", subscription_price: "", group_id: "", password: "" });
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

  const handleEdit = (student) => {
    setEditingStudent(student);
    setFormData({
      name: student.name,
      email: student.email,
      phone: student.phone,
      grade: student.grade,
      grade_id: student.grade_id || "",
      subscription_id: student.subscription_id || "",
      subscription_price: student.subscription_price?.toString() || "",
      group_id: student.group_id || "",
      password: "" // Don't show existing password
    });
    setSelectedCourses(student.student_courses?.map(sc => sc.courses.id) || []);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      const success = await deleteStudent(id);

      if (success) {
        fetchStudents();
        toast({
          title: "تم الحذف بنجاح",
          description: "تم حذف الطالب من قاعدة البيانات",
        });
      } else {
        throw new Error("فشل حذف الطالب");
      }
    } catch (error) {
      console.error('Error deleting student:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في حذف الطالب",
        variant: "destructive",
      });
    }
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Users className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة الطلاب الأونلاين</h1>
              <p className="text-muted-foreground">الطلاب الذين سجلوا عبر المنصة. للموافقة على طلبات التسجيل، انتقل إلى صفحة "طلبات التسجيل"</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>تعديل بيانات الطالب</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم الطالب</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="أدخل اسم الطالب"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">البريد الإلكتروني</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                    placeholder="example@email.com"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">رقم الهاتف</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                    placeholder="01234567890"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="grade">الصف الدراسي</Label>
                  <Select
                    value={formData.grade_id}
                    onValueChange={(value) => {
                      setFormData(prev => ({ ...prev, grade_id: value, group_id: '' }));
                    }}
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
                    onValueChange={(value) => setFormData(prev => ({ ...prev, group_id: value }))}
                    disabled={!formData.grade_id}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={!formData.grade_id ? "اختر الصف أولاً" : "اختر المجموعة"} />
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
                  {formData.grade_id && groups.filter(g => g.grade_id === formData.grade_id).length === 0 && (
                    <p className="text-xs text-muted-foreground">لا توجد مجموعات متاحة لهذا الصف</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">كلمة المرور</Label>
                  <Input
                    id="password"
                    type="text"
                    value={formData.password}
                    onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                    placeholder={editingStudent ? "اتركه فارغاً للإبقاء على كلمة المرور الحالية" : "أدخل كلمة المرور"}
                  />
                  {!editingStudent && (
                    <p className="text-xs text-muted-foreground">سيتم توليد كلمة مرور تلقائياً إذا تركت هذا الحقل فارغاً</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subscription">خطة الاشتراك</Label>
                  <Select value={formData.subscription_id} onValueChange={(value) => {
                    const selectedSub = subscriptions.find(s => s.id === value);
                    setFormData(prev => ({
                      ...prev,
                      subscription_id: value,
                      subscription_price: selectedSub ? selectedSub.price.toString() : ""
                    }));
                  }}>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر خطة الاشتراك" />
                    </SelectTrigger>
                    <SelectContent>
                      {subscriptions.map((subscription) => (
                        <SelectItem key={subscription.id} value={subscription.id}>
                          {subscription.name} - {subscription.price} جنيه
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subscription_price">سعر الاشتراك (قابل للتعديل)</Label>
                  <Input
                    id="subscription_price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.subscription_price}
                    onChange={(e) => setFormData(prev => ({ ...prev, subscription_price: e.target.value }))}
                    placeholder="500"
                  />
                </div>
                <div className="space-y-2">
                  <Label>الكورسات المسجلة</Label>
                  <div className="space-y-2">
                    {courses.map((course) => (
                      <div key={course.id} className="flex items-center space-x-2 space-x-reverse">
                        <Checkbox
                          id={course.id}
                          checked={selectedCourses.includes(course.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedCourses([...selectedCourses, course.id]);
                            } else {
                              setSelectedCourses(selectedCourses.filter(id => id !== course.id));
                            }
                          }}
                        />
                        <Label htmlFor={course.id} className="text-sm font-normal">
                          {course.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري المعالجة..." : (editingStudent ? "تحديث البيانات" : "إضافة الطالب")}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="shadow-soft">
          <CardHeader className="space-y-3">
            <CardTitle className="text-lg md:text-xl">قائمة الطلاب</CardTitle>
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <Input
                placeholder="البحث عن طالب..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full"
              />
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="space-y-4">
              {filteredStudents.map((student, index) => (
                <div 
                  key={student.id}
                  className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                >
                  <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10 border-2 border-white">
                        <AvatarFallback className="text-xs bg-white text-cyan-600">{getInitials(student.name)}</AvatarFallback>
                      </Avatar>
                      <div>
                        <h3 className="font-bold text-white text-lg">{student.name}</h3>
                        <div className="flex items-center gap-2 text-xs text-cyan-50">
                          <Mail className="w-3 h-3" />
                          <span>{student.email}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(student)}
                        className="h-8 w-8 p-0 text-white hover:bg-white/20"
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(student.id)}
                        className="h-8 w-8 p-0 text-white hover:bg-red-500/30"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  
                  <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div>
                      <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📱 رقم الهاتف</div>
                      <div className="text-sm font-medium flex items-center gap-2">
                        <Phone className="w-3 h-3 text-muted-foreground" />
                        {student.phone || '-'}
                      </div>
                    </div>
                    
                    <div>
                      <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">🎓 المرحلة</div>
                      <div className="text-sm font-medium">{student.grade}</div>
                    </div>
                    
                    <div>
                      <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📅 تاريخ الانضمام</div>
                      <div className="text-sm font-medium">{new Date(student.enrollment_date).toLocaleDateString('ar-SA')}</div>
                    </div>
                    
                    <div>
                      <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">💳 الاشتراك</div>
                      <div className="text-sm">
                        {student.subscriptions ? (
                          <div className="space-y-1">
                            <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs font-medium">
                              {student.subscriptions.name}
                            </span>
                            <div className="text-xs text-muted-foreground">
                              {student.subscription_price} جنيه
                            </div>
                            {student.subscription_end_date && (
                              <div className="text-xs text-muted-foreground">
                                ينتهي: {new Date(student.subscription_end_date).toLocaleDateString('ar-SA')}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">لا يوجد اشتراك</span>
                        )}
                      </div>
                    </div>
                    
                    <div>
                      <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📚 الكورسات</div>
                      <div className="flex flex-wrap gap-1">
                        {student.student_courses?.map((enrollment) => (
                          <span key={enrollment.courses.id} className="px-2 py-1 bg-primary/10 text-primary rounded text-xs font-medium">
                            {enrollment.courses.name}
                          </span>
                        ))}
                      </div>
                    </div>
                    
                    <div>
                      <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">⚡ الحالة</div>
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold inline-flex items-center gap-1 ${
                        student.is_active 
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' 
                          : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                      }`}>
                        {student.is_active ? '✓ نشط' : '⚠ غير نشط'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Students;