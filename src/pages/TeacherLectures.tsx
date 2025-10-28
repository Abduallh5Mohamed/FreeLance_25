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
import { Upload, Video, Trash2, Play, BookOpen, Clock, Eye } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';

interface Course {
  id: string;
  name: string;
  subject: string;
}

interface Lecture {
  id: string;
  title: string;
  description: string | null;
  video_url: string;
  duration_minutes: number | null;
  course_id: string;
  is_free: boolean;
  created_at: string;
  courses?: { name: string };
}

export default function TeacherLectures() {
  const { toast } = useToast();
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    video_url: '',
    duration_minutes: '',
    is_free: false
  });

  useEffect(() => {
    loadCourses();
    loadLectures();
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

  const loadLectures = async () => {
    try {
      const { data, error } = await supabase
        .from('course_materials')
        .select(`
          *,
          courses (name)
        `)
        .eq('material_type', 'video')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setLectures(data || []);
    } catch (error) {
      console.error('Error loading lectures:', error);
    }
  };

  const convertDriveUrl = (url: string) => {
    const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (fileIdMatch) {
      return `https://drive.google.com/file/d/${fileIdMatch[1]}/preview`;
    }
    return url;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourse || !formData.title || !formData.video_url) {
      toast({
        title: 'خطأ',
        description: 'يرجى ملء جميع الحقول المطلوبة',
        variant: 'destructive'
      });
      return;
    }

    setLoading(true);
    try {
      const embedUrl = convertDriveUrl(formData.video_url);
      
      const { error } = await supabase
        .from('course_materials')
        .insert({
          course_id: selectedCourse,
          title: formData.title,
          description: formData.description || null,
          material_type: 'video',
          file_url: embedUrl,
          duration_minutes: formData.duration_minutes ? parseInt(formData.duration_minutes) : null,
          is_free: formData.is_free,
          is_published: true,
          display_order: lectures.length
        });

      if (error) throw error;

      toast({
        title: 'نجح',
        description: 'تم رفع المحاضرة بنجاح'
      });

      setFormData({
        title: '',
        description: '',
        video_url: '',
        duration_minutes: '',
        is_free: false
      });
      loadLectures();
    } catch (error) {
      console.error('Error uploading lecture:', error);
      toast({
        title: 'خطأ',
        description: 'فشل رفع المحاضرة',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذه المحاضرة؟')) return;

    try {
      const { error } = await supabase
        .from('course_materials')
        .delete()
        .eq('id', id);

      if (error) throw error;

      toast({
        title: 'نجح',
        description: 'تم حذف المحاضرة'
      });
      loadLectures();
    } catch (error) {
      toast({
        title: 'خطأ',
        description: 'فشل حذف المحاضرة',
        variant: 'destructive'
      });
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
            <Video className="h-8 w-8 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
              رفع المحاضرات
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              أضف محاضرات فيديو للطلاب
            </p>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 lg:gap-6">
          {/* Upload Form */}
          <Card className="lg:col-span-3 shadow-lg border-t-4 border-t-cyan-500">
            <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-cyan-600" />
                رفع محاضرة جديدة
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
                  <Label>عنوان المحاضرة *</Label>
                  <Input
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="مثال: الحرب العالمية الأولى"
                  />
                </div>

                <div>
                  <Label>وصف المحاضرة</Label>
                  <Textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="وصف مختصر للمحاضرة..."
                    rows={3}
                  />
                </div>

                <div>
                  <Label>رابط الفيديو من Google Drive *</Label>
                  <Input
                    value={formData.video_url}
                    onChange={(e) => setFormData({ ...formData, video_url: e.target.value })}
                    placeholder="https://drive.google.com/file/d/..."
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    الصق رابط الفيديو من Google Drive
                  </p>
                </div>

                <div>
                  <Label>مدة المحاضرة (بالدقائق)</Label>
                  <Input
                    type="number"
                    value={formData.duration_minutes}
                    onChange={(e) => setFormData({ ...formData, duration_minutes: e.target.value })}
                    placeholder="60"
                  />
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
                    محاضرة مجانية (متاحة لجميع الطلاب)
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
                      رفع المحاضرة
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Lectures List */}
          <Card className="lg:col-span-2 shadow-lg border-t-4 border-t-cyan-500">
            <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Video className="h-5 w-5 text-cyan-600" />
                  المحاضرات المرفوعة
                </span>
                <Badge variant="secondary" className="text-lg px-3 py-1">
                  {lectures.length} محاضرة
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {lectures.length === 0 ? (
                <div className="text-center py-16">
                  <Video className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-lg font-semibold text-gray-600">لا توجد محاضرات</p>
                  <p className="text-sm text-muted-foreground mt-2">ابدأ برفع أول محاضرة</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {lectures.map((lecture) => (
                    <motion.div
                      key={lecture.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="group flex items-center justify-between p-5 border rounded-xl hover:shadow-md hover:border-cyan-300 transition-all duration-200 bg-white dark:bg-gray-800"
                    >
                      <div className="flex items-start gap-4 flex-1">
                        <div className="p-3 bg-gradient-to-br from-cyan-100 to-teal-100 dark:from-cyan-900 dark:to-teal-900 rounded-lg">
                          <Video className="h-5 w-5 text-cyan-600" />
                        </div>
                        <div className="flex-1">
                          <h4 className="font-bold text-lg mb-1">{lecture.title}</h4>
                          {lecture.description && (
                            <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                              {lecture.description}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline" className="text-xs">
                              {lecture.courses?.name || 'دورة غير محددة'}
                            </Badge>
                            {lecture.duration_minutes && (
                              <Badge variant="secondary" className="text-xs flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {lecture.duration_minutes} دقيقة
                              </Badge>
                            )}
                            {lecture.is_free && (
                              <Badge className="text-xs bg-green-600">مجانية</Badge>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => window.open(lecture.video_url, '_blank')}
                          className="border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(lecture.id)}
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
