import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, Plus, Edit2, Trash2, Users, Calendar } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getCourses, createCourse, updateCourse, deleteCourse, getGrades, getSubscriptions } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const Courses = () => {
  const [courses, setCourses] = useState([]);
  const [grades, setGrades] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [courseToDelete, setCourseToDelete] = useState(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState(null);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    subject: "التاريخ",
    grade_id: "",
    subscription_id: "",
    price: ""
  });

  const { toast } = useToast();

  useEffect(() => {
    fetchCourses();
    fetchGrades();
    fetchSubscriptions();
  }, []);

  const fetchGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data.filter(g => g.is_active));
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchSubscriptions = async () => {
    try {
      const data = await getSubscriptions();
      setSubscriptions(data.filter(s => s.is_active));
    } catch (error) {
      console.error('Error fetching subscriptions:', error);
    }
  };


  const fetchCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data.filter(c => c.is_active) || []);
    } catch (error) {
      console.error('Error fetching courses:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل الكورسات",
        variant: "destructive",
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Get the selected grade name
      const selectedGrade = grades.find(g => g.id === formData.grade_id);
      const gradeName = selectedGrade ? selectedGrade.name : null;

      if (editingCourse) {
        await updateCourse(editingCourse.id, {
          name: formData.name,
          description: formData.description,
          subject: formData.subject,
          grade: gradeName,
          price: parseFloat(formData.price) || 0
        });

        toast({
          title: "تم التحديث بنجاح",
          description: "تم تحديث بيانات الكورس",
        });
      } else {
        await createCourse({
          name: formData.name,
          description: formData.description,
          subject: formData.subject,
          grade: gradeName,
          price: parseFloat(formData.price) || 0,
          is_active: true
        });

        toast({
          title: "تم الإضافة بنجاح",
          description: "تم إنشاء كورس جديد",
        });
      }

      fetchCourses();
      setIsOpen(false);
      setEditingCourse(null);
      setFormData({ name: "", description: "", subject: "التاريخ", grade_id: "", subscription_id: "", price: "" });
    } catch (error: any) {
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ، حاول مرة أخرى",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = async (course) => {
    setEditingCourse(course);

    setFormData({
      name: course.name,
      description: course.description,
      subject: course.subject || "التاريخ",
      grade_id: course.grade || "",
      subscription_id: course.subscription_id || "",
      price: course.price || ""
    });
    setIsOpen(true);
  };

  const confirmDelete = async () => {
    if (!courseToDelete) return;

    try {
      await deleteCourse(courseToDelete.id);

      fetchCourses();
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف الكورس",
      });
    } catch (error) {
      console.error('Delete error:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في الحذف",
        variant: "destructive",
      });
    } finally {
      setDeleteDialogOpen(false);
      setCourseToDelete(null);
    }
  };

  const handleDelete = (course: any) => {
    setCourseToDelete(course);
    setDeleteDialogOpen(true);
  };

  const handleViewDetails = (course: any) => {
    setSelectedCourse(course);
    setDetailsDialogOpen(true);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <BookOpen className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة الكورسات</h1>
              <p className="text-muted-foreground">إضافة وإدارة الكورسات التعليمية</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button className="shadow-medium">
                <Plus className="w-4 h-4 ml-2" />
                إضافة كورس جديد
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingCourse ? "تعديل الكورس" : "إضافة كورس جديد"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم الكورس</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="مثال: التاريخ - الصف الأول الثانوي"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subject">المادة</Label>
                  <Input
                    id="subject"
                    value={formData.subject}
                    onChange={(e) => setFormData(prev => ({ ...prev, subject: e.target.value }))}
                    placeholder="التاريخ"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">وصف الكورس</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="أدخل وصف الكورس"
                    rows={3}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="grade">الصف الدراسي</Label>
                  <Select
                    value={formData.grade_id}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, grade_id: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="اختر الصف الدراسي" />
                    </SelectTrigger>
                    <SelectContent>
                      {grades.length > 0 ? (
                        grades.map((grade) => (
                          <SelectItem key={grade.id} value={grade.id || 'unknown'}>
                            {grade.name}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="no-grade" disabled>
                          لا توجد صفوف دراسية - أضف صف أولاً
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subscription">خطة الاشتراك</Label>
                  <Select
                    value={formData.subscription_id}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, subscription_id: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="اختر خطة الاشتراك" />
                    </SelectTrigger>
                    <SelectContent>
                      {subscriptions.length > 0 ? (
                        subscriptions.map((sub) => (
                          <SelectItem key={sub.id} value={sub.id || 'unknown'}>
                            {sub.name} - {sub.price} جنيه
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="no-subscription" disabled>
                          لا توجد خطط اشتراك
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="price">السعر (جنيه)</Label>
                  <Input
                    id="price"
                    type="number"
                    value={formData.price || ""}
                    onChange={(e) => setFormData(prev => ({ ...prev, price: e.target.value }))}
                    placeholder="0"
                    min="0"
                    step="0.01"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري المعالجة..." : (editingCourse ? "تحديث الكورس" : "إضافة الكورس")}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {courses.length === 0 ? (
            <div className="col-span-full text-center py-12">
              <p className="text-muted-foreground">لا توجد كورسات بعد</p>
            </div>
          ) : (
            courses.map((course) => (
              <Card key={course.id} className="shadow-soft hover:shadow-medium transition-all">
                <CardHeader>
                  <CardTitle className="flex items-start justify-between">
                    <div>
                      <p>{course.name}</p>
                      <p className="text-sm font-normal text-muted-foreground">{course.subject}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(course)}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(course)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {course.description && (
                    <p className="text-muted-foreground text-sm">{course.description}</p>
                  )}

                  <div className="space-y-2">
                    {course.grade && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">الصف:</span>
                        <span className="text-muted-foreground">{course.grade}</span>
                      </div>
                    )}

                    {course.price !== undefined && course.price !== null && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">السعر:</span>
                        <span className="text-primary font-semibold">{course.price} جنيه</span>
                      </div>
                    )}
                  </div>

                  <Button variant="outline" className="w-full" onClick={() => handleViewDetails(course)}>
                    عرض التفاصيل
                  </Button>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Dialog for Course Details */}
        <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>تفاصيل الكورس</DialogTitle>
            </DialogHeader>
            {selectedCourse && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-primary">اسم الكورس:</span>
                    <span>{selectedCourse.name}</span>
                  </div>

                  {selectedCourse.subject && (
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-primary">المادة:</span>
                      <span>{selectedCourse.subject}</span>
                    </div>
                  )}

                  {selectedCourse.description && (
                    <div className="space-y-1">
                      <span className="font-semibold text-primary">الوصف:</span>
                      <p className="text-muted-foreground text-sm">{selectedCourse.description}</p>
                    </div>
                  )}

                  {selectedCourse.grade && (
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-primary">الصف الدراسي:</span>
                      <span>{selectedCourse.grade}</span>
                    </div>
                  )}

                  {selectedCourse.price !== undefined && selectedCourse.price !== null && (
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-primary">السعر:</span>
                      <span className="text-lg font-bold text-primary">{selectedCourse.price} جنيه</span>
                    </div>
                  )}
                </div>

                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setDetailsDialogOpen(false)}
                >
                  إغلاق
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>هل أنت متأكد من حذف هذا الكورس؟</AlertDialogTitle>
              <AlertDialogDescription>
                سيتم حذف الكورس "{courseToDelete?.name}" نهائياً. هذا الإجراء لا يمكن التراجع عنه.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>إلغاء</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete} className="bg-destructive hover:bg-destructive/90">
                حذف
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
};

export default Courses;