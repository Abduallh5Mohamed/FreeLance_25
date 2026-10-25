import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  getCourses,
  getGroups,
  getMaterials,
  createMaterial,
  deleteMaterial,
  Course,
  Group,
  CourseMaterial,
  AUTH_SESSION_CHANGED_EVENT,
} from '@/lib/api-http';
import { Upload, FileText, Image, File, Video, Trash2, BookOpen, Eye, Presentation, AlertCircle, RefreshCw } from 'lucide-react';
import Header from '@/components/Header';
import { VideoPlayer } from '@/components/VideoPlayer';
import { motion } from 'framer-motion';

const createEmptyForm = () => ({
  title: '',
  description: '',
  file_url: '',
  material_type: 'pdf' as CourseMaterial['material_type'],
  is_free: false,
  group_ids: [] as string[],
});

export default function TeacherMaterials() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<Course[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [materials, setMaterials] = useState<CourseMaterial[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [coursesError, setCoursesError] = useState(false);
  const [groupsError, setGroupsError] = useState(false);
  const [referencesReady, setReferencesReady] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [formData, setFormData] = useState(createEmptyForm);
  const [playingVideo, setPlayingVideo] = useState<CourseMaterial | null>(null);
  const requestRef = useRef(0);
  const sessionRef = useRef(0);
  const saveGuardRef = useRef(false);
  const deleteGuardRef = useRef<Set<string>>(new Set());

  const loadData = useCallback(async () => {
    const requestId = ++requestRef.current;
    setReferencesReady(false);
    const session = sessionRef.current;

    if (!localStorage.getItem('authToken')) {
      setCourses([]);
      setGroups([]);
      setMaterials([]);
      setHasLoaded(false);
      navigate('/auth', { replace: true });
      return;
    }

    setLoading(true);
    setLoadError(false);
    setCoursesError(false);
    setGroupsError(false);
    try {
      const [coursesResult, groupsResult, materialsResult] = await Promise.allSettled([
        getCourses(),
        getGroups(),
        getMaterials(),
      ]);
      if (requestId !== requestRef.current || session !== sessionRef.current) return;
    setReferencesReady(coursesResult.status === 'fulfilled' && groupsResult.status === 'fulfilled');

      if (coursesResult.status === 'fulfilled') setCourses(coursesResult.value || []);
      else setCoursesError(true);

      if (groupsResult.status === 'fulfilled') setGroups(groupsResult.value || []);
      else setGroupsError(true);

      if (materialsResult.status === 'fulfilled') {
        setMaterials(materialsResult.value || []);
        setHasLoaded(true);
      } else {
        setLoadError(true);
      }
    } finally {
      if (requestId === requestRef.current && session === sessionRef.current) {
        setLoading(false);
      }
    }
  }, [navigate]);

  useEffect(() => {
    void loadData();

    const refresh = () => {
      sessionRef.current += 1;
      requestRef.current += 1;
      setCourses([]);
      setGroups([]);
      setMaterials([]);
      setPlayingVideo(null);
      setHasLoaded(false);
      setLoadError(false);
      setCoursesError(false);
      setGroupsError(false);
      setSaving(false);
      setDeletingIds([]);
      setSelectedCourse('');
      setFormData(createEmptyForm());
      saveGuardRef.current = false;
      deleteGuardRef.current.clear();
      setLoading(false);
      void loadData();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'authToken' || event.key === 'currentUser' || event.key === null) refresh();
    };

    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      sessionRef.current += 1;
      requestRef.current += 1;
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [loadData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saveGuardRef.current || !referencesReady || coursesError || groupsError) return;
    if (!courses.some(course => course.id === selectedCourse) || !formData.title
        || formData.group_ids.some(id => !groups.some(group => group.id === id && group.course_id === selectedCourse))) {
      toast({
        title: 'خطأ',
        description: 'يرجى ملء جميع الحقول المطلوبة',
        variant: 'destructive'
      });
      return;
    }
    if (formData.group_ids.length === 0) {
      toast({
        title: 'خطأ',
        description: 'اختر مجموعة واحدة على الأقل ليصل المحتوى للطلاب',
        variant: 'destructive'
      });
      return;
    }

    if (!localStorage.getItem('authToken')) {
      toast({
        title: 'انتهت الجلسة',
        description: 'يرجى تسجيل الدخول مرة أخرى',
        variant: 'destructive'
      });
      navigate('/auth', { replace: true });
      return;
    }

    saveGuardRef.current = true;
    setSaving(true);
    const session = sessionRef.current;
    try {
      await createMaterial({
        course_id: selectedCourse,
        title: formData.title,
        description: formData.description || undefined,
        material_type: formData.material_type,
        file_url: formData.file_url.trim() || undefined,
        is_free: formData.is_free,
        is_published: true,
        display_order: materials.length,
        group_ids: formData.group_ids,
      });
      if (session !== sessionRef.current) return;

      requestRef.current += 1;
      void loadData();
      setFormData(createEmptyForm());
      toast({
        title: 'نجح',
        description: 'تم رفع المادة التعليمية بنجاح'
      });
    } catch (error) {
      if (session !== sessionRef.current) return;
      console.error('Error uploading material:', error);
      toast({
        title: 'خطأ',
        description: 'فشل رفع المادة التعليمية',
        variant: 'destructive'
      });
    } finally {
      if (session === sessionRef.current) {
        saveGuardRef.current = false;
        setSaving(false);
      }
    }
  };

  const handleDelete = async (id: string) => {
    if (deleteGuardRef.current.has(id)) return;
    if (!confirm('هل أنت متأكد من حذف هذه المادة؟')) return;

    if (!localStorage.getItem('authToken')) {
      toast({
        title: 'انتهت الجلسة',
        description: 'يرجى تسجيل الدخول مرة أخرى',
        variant: 'destructive'
      });
      navigate('/auth', { replace: true });
      return;
    }

    deleteGuardRef.current.add(id);
    setDeletingIds((previous) => [...previous, id]);
    const session = sessionRef.current;
    try {
      await deleteMaterial(id);
      if (session !== sessionRef.current) return;

      requestRef.current += 1;
      void loadData();
      setPlayingVideo((previous) => previous?.id === id ? null : previous);
      toast({
        title: 'نجح',
        description: 'تم حذف المادة'
      });
    } catch (error) {
      if (session !== sessionRef.current) return;
      console.error('Error deleting material:', error);
      toast({
        title: 'خطأ',
        description: 'فشل حذف المادة',
        variant: 'destructive'
      });
    } finally {
      if (session === sessionRef.current) {
        deleteGuardRef.current.delete(id);
        setDeletingIds((previous) => previous.filter((deletingId) => deletingId !== id));
      }
    }
  };

  const hasCurrentSession = () => {
    if (localStorage.getItem('authToken')) return true;
    toast({
      title: 'انتهت الجلسة',
      description: 'يرجى تسجيل الدخول مرة أخرى',
      variant: 'destructive'
    });
    navigate('/auth', { replace: true });
    return false;
  };

  const handlePreview = (material: CourseMaterial) => {
    if (!hasCurrentSession()) return;
    if (!material.file_url) {
      toast({
        title: 'غير متاح',
        description: 'رابط الملف غير متوفر',
        variant: 'destructive'
      });
      return;
    }
    if (material.material_type === 'video') {
      setPlayingVideo(material);
      return;
    }
    window.open(material.file_url, '_blank', 'noopener,noreferrer');
  };

  const selectedCourseGroups = groups.filter((group) => group.course_id === selectedCourse);

  const getMaterialIcon = (type: string) => {
    switch (type) {
      case 'pdf':
        return <FileText className="h-5 w-5 text-red-500" />;
      case 'presentation':
        return <Presentation className="h-5 w-5 text-cyan-500" />;
      case 'video':
        return <Video className="h-5 w-5 text-green-500" />;
      case 'link':
        return <File className="h-5 w-5 text-blue-500" />;
      case 'other':
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
      case 'video':
        return '🎬 فيديو';
      case 'link':
        return '🔗 رابط';
      case 'other':
        return '📎 ملف آخر';
      default:
        return type;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950">
      <Header />

      {playingVideo?.file_url && (
        <VideoPlayer
          url={playingVideo.file_url}
          title={playingVideo.title}
          onClose={() => setPlayingVideo(null)}
        />
      )}

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
                  <Select
                    value={selectedCourse}
                    onValueChange={(value) => {
                      setSelectedCourse(value);
                      setFormData((previous) => ({ ...previous, group_ids: [] }));
                    }}
                  >
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
                  {coursesError && (
                    <p className="text-xs text-destructive mt-1">تعذّر تحميل الدورات. أعد المحاولة قبل النشر.</p>
                  )}
                </div>

                <div>
                  <Label>المجموعات *</Label>
                  {!selectedCourse ? (
                    <p className="text-xs text-muted-foreground mt-1">اختر الدورة أولاً لعرض مجموعاتها.</p>
                  ) : selectedCourseGroups.length === 0 ? (
                    <p className="text-xs text-muted-foreground mt-1">
                      {groupsError ? 'تعذّر تحميل المجموعات. أعد المحاولة قبل النشر.' : 'لا توجد مجموعات مرتبطة بهذه الدورة.'}
                    </p>
                  ) : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {selectedCourseGroups.map((group) => (
                        <label key={group.id} className="flex items-center gap-2 rounded-md border p-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.group_ids.includes(group.id)}
                            onChange={(event) => setFormData((previous) => ({
                              ...previous,
                              group_ids: event.target.checked
                                ? [...previous.group_ids, group.id]
                                : previous.group_ids.filter((groupId) => groupId !== group.id),
                            }))}
                            className="w-4 h-4"
                          />
                          <span className="text-sm">{group.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
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
                      <SelectItem value="other">
                        <div className="flex items-center gap-2">
                          <Image className="h-4 w-4 text-purple-500" />
                          صورة أو ملف آخر
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
                  disabled={saving || !referencesReady || coursesError || groupsError}
                  className="w-full bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
                >
                  {saving ? 'جاري الرفع...' : (
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
              {loadError && (
                <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
                  <p className="font-semibold">تعذّر تحميل المواد</p>
                  <p className="text-sm text-muted-foreground mt-1 mb-3">
                    لا توجد قائمة فارغة مؤكدة حتى تنجح إعادة المحاولة.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading} className="gap-2">
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    إعادة المحاولة
                  </Button>
                </div>
              )}

              {loading && materials.length === 0 && !loadError ? (
                <div className="text-center py-16 text-muted-foreground" aria-live="polite">
                  جارٍ تحميل المواد...
                </div>
              ) : !loadError && hasLoaded && materials.length === 0 ? (
                <div className="text-center py-16">
                  <FileText className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                  <p className="text-lg font-semibold text-gray-600">لا توجد مواد تعليمية</p>
                  <p className="text-sm text-muted-foreground mt-2">ابدأ برفع أول مادة تعليمية</p>
                </div>
              ) : materials.length > 0 ? (
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
                              {material.course_name
                                || courses.find((course) => course.id === material.course_id)?.name
                                || 'دورة غير محددة'}
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
                            onClick={() => handlePreview(material)}
                            className="border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(material.id)}
                          disabled={deletingIds.includes(material.id)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
        </div>
      </div>
    </div>
  );
}
