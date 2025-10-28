import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { getCourses, getMaterials, createMaterial, deleteMaterial, convertDriveUrl, type Course, type CourseMaterial } from '@/lib/api-http';
import { Upload, Video, FileText, Presentation, Trash2, Plus, Play, BookOpen, Clock, CheckCircle } from 'lucide-react';
import { VideoPlayer } from '@/components/VideoPlayer';
import Header from '@/components/Header';

export default function CourseContentManager() {
  const { toast } = useToast();
  const [courses, setCourses] = useState<Course[]>([]);
  const [materials, setMaterials] = useState<CourseMaterial[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<{ url: string; title: string } | null>(null);
  const [formData, setFormData] = useState({ title: '', description: '', material_type: 'video' as CourseMaterial['material_type'], file_url: '', duration_minutes: '', is_free: false });

  const loadCourses = async () => { try { setCourses(await getCourses()); } catch { toast({ title: 'خطأ', description: 'فشل تحميل الدورات', variant: 'destructive' }); } };
  const loadMaterials = async (courseId: string) => { try { setLoading(true); setMaterials(await getMaterials(courseId)); } catch { toast({ title: 'خطأ', description: 'فشل تحميل المحتوى', variant: 'destructive' }); } finally { setLoading(false); } };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadCourses(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (selectedCourse) loadMaterials(selectedCourse); }, [selectedCourse]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourse) return toast({ title: 'خطأ', description: 'يرجى اختيار دورة', variant: 'destructive' });
    if (!formData.title) return toast({ title: 'خطأ', description: 'يرجى إدخال عنوان المحتوى', variant: 'destructive' });
    if (formData.material_type === 'video' && !formData.file_url) return toast({ title: 'خطأ', description: 'يرجى إدخال رابط الفيديو من Google Drive', variant: 'destructive' });
    try {
      setLoading(true);
      let finalUrl = formData.file_url;
      if (formData.material_type === 'video' && formData.file_url) {
        try { const conv = await convertDriveUrl(formData.file_url); finalUrl = conv.embedUrl; } catch { toast({ title: 'تحذير', description: 'تأكد من أن الرابط من Google Drive', variant: 'destructive' }); }
      }
      await createMaterial({ course_id: selectedCourse, title: formData.title, description: formData.description || undefined, material_type: formData.material_type, file_url: finalUrl || undefined, duration_minutes: formData.duration_minutes ? parseInt(formData.duration_minutes) : undefined, is_free: formData.is_free, is_published: true, display_order: materials.length });
      toast({ title: 'نجح', description: 'تم إضافة المحتوى بنجاح' });
      setFormData({ title: '', description: '', material_type: 'video', file_url: '', duration_minutes: '', is_free: false });
      loadMaterials(selectedCourse);
    } catch (error) {
      toast({ title: 'خطأ', description: error instanceof Error ? error.message : 'فشل إضافة المحتوى', variant: 'destructive' });
    } finally { setLoading(false); }
  };

  const handleDelete = async (id: string) => { if (!confirm('هل أنت متأكد من حذف هذا المحتوى؟')) return; try { await deleteMaterial(id); toast({ title: 'نجح', description: 'تم حذف المحتوى' }); loadMaterials(selectedCourse); } catch { toast({ title: 'خطأ', description: 'فشل حذف المحتوى', variant: 'destructive' }); } };
  const getMaterialIcon = (type: CourseMaterial['material_type']) => { switch (type) { case 'video': return <Video className="h-5 w-5 text-cyan-500" />; case 'pdf': return <FileText className="h-5 w-5 text-red-500" />; case 'presentation': return <Presentation className="h-5 w-5 text-cyan-500" />; default: return <Upload className="h-5 w-5 text-gray-500" />; } };

  const selectedCourseData = courses.find(c => c.id === selectedCourse);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950">
      <Header />

      <div className="container mx-auto px-4 py-8 space-y-6" dir="rtl">
        {/* Page Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="p-3 bg-gradient-to-br from-cyan-500 to-teal-600 rounded-xl shadow-lg">
            <BookOpen className="h-8 w-8 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
              إدارة محتوى الدورات
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              أضف وأدر الفيديوهات والملفات التعليمية
            </p>
          </div>
        </div>

        {/* Course Selector */}
        <Card className="shadow-lg border-t-4 border-t-cyan-500">
          <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-cyan-600" />
              اختر الدورة
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <Select value={selectedCourse} onValueChange={setSelectedCourse}>
              <SelectTrigger className="h-12 text-lg">
                <SelectValue placeholder="🎓 اختر دورة لإدارة محتواها" />
              </SelectTrigger>
              <SelectContent>
                {courses.map(c => (
                  <SelectItem key={c.id} value={c.id} className="text-lg py-3">
                    <div className="flex items-center gap-2">
                      <BookOpen className="h-4 w-4 text-cyan-500" />
                      <span className="font-semibold">{c.name}</span>
                      <Badge variant="secondary" className="mr-auto">{c.subject}</Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selectedCourseData && (
              <div className="mt-4 p-4 bg-cyan-50 dark:bg-gray-800 rounded-lg border border-cyan-200 dark:border-gray-700">
                <p className="text-sm font-semibold text-cyan-900 dark:text-cyan-100">
                  الدورة المختارة: {selectedCourseData.name}
                </p>
                {selectedCourseData.description && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedCourseData.description}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {selectedCourse && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Add Material Form */}
            <Card className="lg:col-span-1 shadow-lg border-t-4 border-t-green-500 h-fit">
              <CardHeader className="bg-gradient-to-r from-green-50 to-emerald-50 dark:from-gray-800 dark:to-gray-700">
                <CardTitle className="flex items-center gap-2">
                  <Plus className="h-5 w-5 text-green-600" />
                  إضافة محتوى جديد
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <Label className="text-sm font-semibold">نوع المحتوى</Label>
                    <Select
                      value={formData.material_type}
                      onValueChange={(v) => setFormData({ ...formData, material_type: v as CourseMaterial['material_type'] })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="video">
                          <div className="flex items-center gap-2">
                            <Video className="h-4 w-4 text-cyan-500" />
                            فيديو
                          </div>
                        </SelectItem>
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
                        <SelectItem value="link">رابط</SelectItem>
                        <SelectItem value="other">أخرى</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-sm font-semibold">العنوان *</Label>
                    <Input
                      value={formData.title}
                      onChange={e => setFormData({ ...formData, title: e.target.value })}
                      placeholder="عنوان المحتوى"
                      required
                      className="mt-1"
                    />
                  </div>

                  <div>
                    <Label className="text-sm font-semibold">الوصف</Label>
                    <Textarea
                      value={formData.description}
                      onChange={e => setFormData({ ...formData, description: e.target.value })}
                      placeholder="وصف المحتوى"
                      rows={3}
                      className="mt-1"
                    />
                  </div>

                  {formData.material_type === 'video' && (
                    <>
                      <div>
                        <Label className="text-sm font-semibold">رابط الفيديو (Google Drive) *</Label>
                        <Input
                          value={formData.file_url}
                          onChange={e => setFormData({ ...formData, file_url: e.target.value })}
                          placeholder="https://drive.google.com/file/d/..."
                          type="url"
                          required
                          className="mt-1"
                        />
                        <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                          💡 الصق رابط المشاركة من Google Drive
                        </p>
                      </div>

                      <div>
                        <Label className="text-sm font-semibold">المدة (بالدقائق)</Label>
                        <Input
                          value={formData.duration_minutes}
                          onChange={e => setFormData({ ...formData, duration_minutes: e.target.value })}
                          placeholder="30"
                          type="number"
                          min="1"
                          className="mt-1"
                        />
                      </div>
                    </>
                  )}

                  <div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <input
                      type="checkbox"
                      id="is_free"
                      checked={formData.is_free}
                      onChange={e => setFormData({ ...formData, is_free: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="is_free" className="cursor-pointer text-sm font-medium">
                      محتوى مجاني (متاح للجميع)
                    </Label>
                  </div>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full h-11 bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700"
                  >
                    <Plus className="h-4 w-4 ml-2" />
                    إضافة المحتوى
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* Materials List */}
            <Card className="lg:col-span-2 shadow-lg border-t-4 border-t-cyan-500">
              <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Video className="h-5 w-5 text-cyan-600" />
                    محتوى الدورة
                  </span>
                  <Badge variant="secondary" className="text-lg px-3 py-1">
                    {materials.length} عنصر
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {loading ? (
                  <div className="flex flex-col items-center justify-center py-16">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600 mb-4"></div>
                    <p className="text-muted-foreground">جاري التحميل...</p>
                  </div>
                ) : materials.length === 0 ? (
                  <div className="text-center py-16 px-4">
                    <Upload className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                    <p className="text-lg font-semibold text-gray-600 dark:text-gray-400">
                      لا يوجد محتوى لهذه الدورة
                    </p>
                    <p className="text-sm text-muted-foreground mt-2">
                      ابدأ بإضافة فيديوهات أو ملفات تعليمية
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {materials.map(m => (
                      <div
                        key={m.id}
                        className="group flex items-center justify-between p-5 border rounded-xl hover:shadow-md hover:border-cyan-300 dark:hover:border-cyan-700 transition-all duration-200 bg-white dark:bg-gray-800"
                      >
                        <div className="flex items-start gap-4 flex-1">
                          <div className="p-3 bg-gradient-to-br from-cyan-100 to-teal-100 dark:from-cyan-900 dark:to-teal-900 rounded-lg">
                            {getMaterialIcon(m.material_type)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-bold text-lg mb-1 truncate">
                              {m.title}
                            </h4>
                            {m.description && (
                              <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                                {m.description}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              <Badge variant="outline" className="text-xs">
                                {m.material_type === 'video' ? '🎥 فيديو' :
                                  m.material_type === 'pdf' ? '📄 PDF' :
                                    m.material_type === 'presentation' ? '📊 عرض' : m.material_type}
                              </Badge>
                              {m.duration_minutes && (
                                <Badge variant="secondary" className="text-xs flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {m.duration_minutes} دقيقة
                                </Badge>
                              )}
                              {m.is_free && (
                                <Badge className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-100 flex items-center gap-1">
                                  <CheckCircle className="h-3 w-3" />
                                  مجاني
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex gap-2 mr-4">
                          {m.material_type === 'video' && m.file_url && (
                            <Button
                              variant="default"
                              size="sm"
                              onClick={() => setPlayingVideo({ url: m.file_url!, title: m.title })}
                              className="bg-gradient-to-r from-cyan-500 to-teal-600 hover:from-cyan-600 hover:to-teal-700"
                            >
                              <Play className="h-4 w-4 ml-1" />
                              تشغيل
                            </Button>
                          )}
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDelete(m.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Video Player Modal */}
      {playingVideo && (
        <VideoPlayer
          url={playingVideo.url}
          title={playingVideo.title}
          onClose={() => setPlayingVideo(null)}
        />
      )}
    </div>
  );
}
