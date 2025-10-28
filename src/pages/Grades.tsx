import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { GraduationCap, Plus, Edit2, Trash2 } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getGrades, createGrade, updateGrade, deleteGrade, type Grade } from "@/lib/api";

const Grades = () => {
  const [grades, setGrades] = useState<Grade[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingGrade, setEditingGrade] = useState<Grade | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const [formData, setFormData] = useState({
    name: "",
    description: ""
  });

  const { toast } = useToast();

  useEffect(() => {
    fetchGrades();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
      toast({
        title: "خطأ",
        description: "فشل تحميل الصفوف",
        variant: "destructive",
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (editingGrade) {
        await updateGrade(editingGrade.id, {
          name: formData.name,
          display_order: editingGrade.display_order
        });
        toast({
          title: "تم التحديث بنجاح",
          description: "تم تحديث الصف بنجاح",
        });
      } else {
        await createGrade({
          name: formData.name,
          display_order: 0
        });
        toast({
          title: "تم الإضافة بنجاح",
          description: "تم إضافة الصف الجديد بنجاح",
        });
      }

      fetchGrades();
      setIsOpen(false);
      setEditingGrade(null);
      setFormData({ name: "", description: "" });
    } catch (error) {
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ أثناء حفظ الصف",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (grade: Grade) => {
    setEditingGrade(grade);
    setFormData({
      name: grade.name,
      description: grade.description || ""
    });
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("هل أنت متأكد من حذف هذا الصف؟")) return;

    try {
      await deleteGrade(id);
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف الصف بنجاح",
      });

      fetchGrades();
    } catch (error) {
      toast({
        title: "خطأ",
        description: "فشل حذف الصف",
        variant: "destructive",
      });
    }
  };

  const filteredGrades = grades.filter(grade =>
    grade.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (grade.description && grade.description.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <main className="container mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <GraduationCap className="h-8 w-8 text-primary" />
            <div>
              <h1 className="text-3xl font-bold">إدارة الصفوف</h1>
              <p className="text-muted-foreground">إضافة وتعديل الصفوف الدراسية</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button
                onClick={() => {
                  setEditingGrade(null);
                  setFormData({ name: "", description: "" });
                }}
              >
                <Plus className="ml-2 h-4 w-4" />
                إضافة صف جديد
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>
                  {editingGrade ? "تعديل الصف" : "إضافة صف جديد"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم الصف *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="مثال: الصف الأول الثانوي"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">الوصف</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="وصف مختصر للصف"
                    rows={3}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري المعالجة..." : (editingGrade ? "تحديث الصف" : "إضافة الصف")}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="space-y-4">
          <Input
            placeholder="البحث في الصفوف..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="max-w-md"
          />

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredGrades.map((grade) => (
              <div
                key={grade.id}
                className="p-6 bg-card rounded-lg border shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <GraduationCap className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold text-lg">{grade.name}</h3>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(grade)}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(grade.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                {grade.description && (
                  <p className="text-sm text-muted-foreground">{grade.description}</p>
                )}
              </div>
            ))}
          </div>

          {filteredGrades.length === 0 && (
            <div className="text-center py-12">
              <GraduationCap className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                {searchTerm ? "لا توجد نتائج للبحث" : "لا توجد صفوف بعد"}
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default Grades;