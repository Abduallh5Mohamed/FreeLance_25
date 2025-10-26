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
import { supabase } from "@/integrations/supabase/client";
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
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    subject: "التاريخ",
    grade_id: "",
    subscription_id: ""
  });
  
  const { toast } = useToast();

  useEffect(() => {
    fetchCourses();
    fetchGrades();
    fetchSubscriptions();
  }, []);

  const fetchGrades = async () => {
    try {
      const { data, error } = await supabase
        .from('grades')
        .select('*')
        .eq('is_active', true)
        .order('name', { ascending: true });
      
      if (error) throw error;
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchSubscriptions = async () => {
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('is_active', true)
        .order('name', { ascending: true });
      
      if (error) throw error;
      setSubscriptions(data || []);
    } catch (error) {
      console.error('Error fetching subscriptions:', error);
    }
  };


  const fetchCourses = async () => {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select(`
          *,
          subscriptions (
            id,
            name,
            price,
            duration_months
          )
        `)
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setCourses(data || []);
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
      if (editingCourse) {
        const { error: courseError } = await supabase
          .from('courses')
          .update({
            name: formData.name,
            description: formData.description,
            subject: formData.subject,
            grade_id: formData.grade_id || null,
            subscription_id: formData.subscription_id || null
          })
          .eq('id', editingCourse.id);
        
        if (courseError) throw courseError;
        
        toast({
          title: "تم التحديث بنجاح",
          description: "تم تحديث بيانات الكورس",
        });
      } else {
        const { data: newCourse, error: courseError } = await supabase
          .from('courses')
          .insert({
            name: formData.name,
            description: formData.description,
            subject: formData.subject,
            grade_id: formData.grade_id || null,
            subscription_id: formData.subscription_id || null,
            is_active: true
          })
          .select()
          .single();
        
        if (courseError) throw courseError;
        
        toast({
          title: "تم الإضافة بنجاح",
          description: "تم إنشاء كورس جديد",
        });
      }
      
      fetchCourses();
      setIsOpen(false);
      setEditingCourse(null);
      setFormData({ name: "", description: "", subject: "التاريخ", grade_id: "", subscription_id: "" });
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
      grade_id: course.grade_id || "",
      subscription_id: course.subscription_id || ""
    });
    setIsOpen(true);
  };

  const confirmDelete = async () => {
    if (!courseToDelete) return;
    
    try {
      const { error } = await supabase
        .from('courses')
        .delete()
        .eq('id', courseToDelete.id);
      
      if (error) throw error;
      
      fetchCourses();
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف الكورس",
      });
    } catch (error: any) {
      console.error('Delete error:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ في الحذف",
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

  return (
    <div className="min-h-screen bg-background" dir="rtl">
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
                      {grades.map((grade) => (
                        <SelectItem key={grade.id} value={grade.id}>
                          {grade.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="subscription">خطة الاشتراك</Label>
                  <Select
                    value={formData.subscription_id}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, subscription_id: value }))}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="اختر خطة الاشتراك" />
                    </SelectTrigger>
                    <SelectContent>
                      {subscriptions.map((sub) => (
                        <SelectItem key={sub.id} value={sub.id}>
                          {sub.name} - {sub.price} جنيه / {sub.duration_months} شهر
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  
                  {course.subscriptions && (
                    <div className="bg-primary/5 p-3 rounded-lg">
                      <p className="text-sm font-medium">خطة الاشتراك:</p>
                      <p className="text-sm text-muted-foreground">
                        {course.subscriptions.name} - {course.subscriptions.price} جنيه / {course.subscriptions.duration_months} شهر
                      </p>
                    </div>
                  )}
                  
                  <Button variant="outline" className="w-full">
                    عرض التفاصيل
                  </Button>
                </CardContent>
              </Card>
            ))
          )}
        </div>

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