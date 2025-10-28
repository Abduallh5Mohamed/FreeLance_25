import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Upload, FileText, Image, File, Trash2, BookOpen, Eye, Presentation } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';

interface Course {
  id: string;
  name: string;
  subject: string;
}

interface Material {
  id: string;
  title: string;
  description: string | null;
  file_url: string | null;
  material_type: string;
  course_id: string;
  is_free: boolean;
  created_at: string;
  courses?: { name: string };
}

export default function TeacherMaterials() {
  const { toast } = useToast();
  const [courses, setCourses] = useState<Course[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    file_url: '',
    material_type: 'pdf' as 'pdf' | 'presentation' | 'image' | 'link',
    is_free: false
  });

  useEffect(() => {
    loadCourses();
    loadMaterials();
  }, []);

  const loadCourses = async () => {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('id, name, subject')
        .order('name');
      
      if (error) throw error;
      setCourses(data || []);
    } catch (error) {
      console.error('Error loading courses:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل الدورات',
        variant: 'destructive'
      });
    }
  };

  const loadMaterials = async () => {
    try {
      const { data, error } = await supabase
        .from('course_materials')
        .select(`
          *,
          courses (name)
        `)
        .neq('material_type', 'video')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setMaterials(data || []);
    } catch (error) {
      console.error('Error loading materials:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourse || !formData.title) {
      toast({
        title: 'خطأ',
        description: 'يرجى ملء جميع الحقول المطلوبة',
        variant: 'destructive'
      });
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase
        .from('course_materials')
        .insert({
          course_id: selectedCourse,
          title: formData.title,
          description: formData.description || null,
          material_type: formData.material_type,
          file_url: formData.file_url || null,
          is_free: formData.is_free,
          is_published: true,
          display_order: materials.length
        });

      if (error) throw error;

      toast({
        title: 'نجح',
        description: 'تم رفع المادة التعليمية بنجاح'
      });

      setFormData({
        title: '',
        description: '',
        file_url: '',
        material_type: 'pdf',
        is_free: false
      });
      loadMaterials();
    } catch (error) {
      console.error('Error uploading material:', error);
      toast({
        title: 'خطأ',
        description: 'فشل رفع المادة التعليمية',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذه المادة؟')) return;

    try {
      const { error } = await supabase
        .from('course_materials')
        .delete()
        .eq('id', id);

      if (error) throw error;

      toast({
        title: 'نجح',
        description: 'تم حذف المادة'
      });
      loadMaterials();
    } catch (error) {
      toast({
        title: 'خطأ',
        description: 'فشل حذف المادة',
        variant: 'destructive'
      });
    }
  };

  const getMaterialIcon = (type: string) => {
    switch (type) {
      case 'pdf':
        return <FileText className="h-5 w-5 text-red-500" />;
      case 'presentation':
        return <Presentation className="h-5 w-5 text-cyan-500" />;
      case 'image':
        return <Image className="h-5 w-5 text-purple-500" />;
      default:
        return <File className="h-5 w-5 text-gray-500" />;
    }
  };

  const getMaterialTypeName = (type: string) => {
    switch (type) {
      case 'pdf':
        return '📄 PDF';
      case 'presentation':
        return '📊 عرض تقديمي';
      case 'image':
        return '🖼️ صورة';
      case 'link':
        return '🔗 رابط';
      default:
        return type;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950">
      <Header />

      <div className="w-full px-4 py-8 space-y-6" dir="rtl">
        <div className="max-w-7xl mx-auto">
        {/* Page Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 mb-8"
        >
          <div className="p-3 bg-gradient-to-br from-cyan-500 to-teal-600 rounded-xl shadow-lg">
            <Upload className="h-8 w-8 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
              رفع المواد التعليمية
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              أضف مستندات وملفات تعليمية للطلاب
            </p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 lg:gap-6">
          {/* Upload Form */}
          <Card className="lg:col-span-3 shadow-lg border-t-4 border-t-cyan-500">
            <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-cyan-600" />
                رفع مادة تعليمية جديدة
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label>اختر الدورة *</Label>
                  <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر الدورة" />
                    </SelectTrigger>
                    <SelectContent>
                      {courses.map(c => (
                        <SelectItem key={c.id} value={c.id}>
                          <div className="flex items-center gap-2">
                            <BookOpen className="h-4 w-4 text-cyan-500" />
                            {c.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>نوع المادة *</Label>
                  <Select
                    value={formData.material_type}
                    onValueChange={(value) => setFormData({ ...formData, material_type: value as any })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pdf">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-red-500" />
                          ملف PDF
                        </div>
                      </SelectItem>
                      <SelectItem value="presentation">
                        <div className="flex items-center gap-2">
                          <Presentation className="h-4 w-4 text-cyan-500" />
                          عرض تقديمي
                        </div>
                      </SelectItem>
                      <SelectItem value="image">
                        <div className="flex items-center gap-2">
                          <Image className="h-4 w-4 text-purple-500" />
                          صورة
                        </div>
                      </SelectItem>
                      <SelectItem value="link">
                        <div className="flex items-center gap-2">
                          <File className="h-4 w-4 text-gray-500" />
                          رابط خارجي
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>عنوان المادة *</Label>
                  <Input
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="مثال: ملخص الحرب العالمية الأولى"
                  />
                </div>

                <div>
                  <Label>وصف المادة</Label>
                  <Textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="وصف مختصر للمادة..."
                    rows={3}
                  />
                </div>

                <div>
                  <Label>رابط الملف (Google Drive/Link)</Label>
                  <Input
                    value={formData.file_url}
                    onChange={(e) => setFormData({ ...formData, file_url: e.target.value })}
                    placeholder="https://drive.google.com/..."
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    الصق رابط الملف من Google Drive أو أي رابط آخر
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="is_free"
                    checked={formData.is_free}
                    onChange={(e) => setFormData({ ...formData, is_free: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="is_free" className="cursor-pointer">
                    مادة مجانية (متاحة لجميع الطلاب)
                  </Label>
                </div>

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
                >
                  {loading ? 'جاري الرفع...' : (
                    <>
                      <Upload className="h-4 w-4 ml-2" />
                      رفع المادة
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Materials List */}
          <Card className="lg:col-span-2 shadow-lg border-t-4 border-t-cyan-500">
            <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-cyan-600" />
                  المواد المرفوعة
                </span>
                <Badge variant="secondary" className="text-lg px-3 py-1">
                  {materials.length} مادة
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {materials.length === 0 ? (
                <div className="text-center py-16">
                  <FileText className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-lg font-semibold text-gray-600">لا توجد مواد تعليمية</p>
                  <p className="text-sm text-muted-foreground mt-2">ابدأ برفع أول مادة تعليمية</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {materials.map((material) => (
                    <motion.div
                      key={material.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="group flex items-center justify-between p-5 border rounded-xl hover:shadow-md hover:border-cyan-300 transition-all duration-200 bg-white dark:bg-gray-800"
                    >
                      <div className="flex items-start gap-4 flex-1">
                        <div className="p-3 bg-gradient-to-br from-cyan-100 to-teal-100 dark:from-cyan-900 dark:to-teal-900 rounded-lg">
                          {getMaterialIcon(material.material_type)}
                        </div>
                        <div className="flex-1">
                          <h4 className="font-bold text-lg mb-1">{material.title}</h4>
                          {material.description && (
                            <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                              {material.description}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline" className="text-xs">
                              {material.courses?.name || 'دورة غير محددة'}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              {getMaterialTypeName(material.material_type)}
                            </Badge>
                            {material.is_free && (
                              <Badge className="text-xs bg-green-600">مجانية</Badge>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        {material.file_url && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open(material.file_url!, '_blank')}
                            className="border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(material.id)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        </div>
      </div>
    </div>
  );
}
