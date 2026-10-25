import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Video,
  FileText,
  File,
  Link as LinkIcon,
  Presentation,
  Plus,
  Trash2,
  Edit,
  Eye,
  BookOpen,
  Sparkles,
  Calendar,
  Clock,
  AlertCircle,
  RefreshCw
} from "lucide-react";
import Header from "@/components/Header";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { FloatingParticles } from "@/components/FloatingParticles";
import {
  getCourses,
  getGroups,
  getLectures,
  getMaterials,
  getExams,
  createLecture,
  createMaterial,
  createExam,
  deleteLecture,
  deleteMaterial,
  deleteExam,
  Course,
  Group,
  CourseMaterial,
  Exam,
  AUTH_SESSION_CHANGED_EVENT,
} from "@/lib/api-http";

interface ContentItem {
  id: string;
  title: string;
  description: string;
  type: 'lecture' | 'material' | 'exam';
  subType?: CourseMaterial['material_type'];
  course: string;
  uploadDate: string;
  youtubeUrl?: string;
  duration?: string;
  instructor?: string;
  thumbnail?: string;
  fileUrl?: string;
  questionsCount?: number;
  totalMarks?: number;
}

type ContentTab = 'lectures' | 'materials' | 'exams';
type TabStatus = { loading: boolean; error: boolean; loaded: boolean };

const createEmptyTabState = (): Record<ContentTab, TabStatus> => ({
  lectures: { loading: true, error: false, loaded: false },
  materials: { loading: true, error: false, loaded: false },
  exams: { loading: true, error: false, loaded: false },
});

const createEmptyForm = () => ({
  title: '',
  description: '',
  course: '',
  type: 'pdf' as CourseMaterial['material_type'],
  youtubeUrl: '',
  durationMinutes: '',
  price: '',
  totalMarks: '',
  fileUrl: '',
  groupIds: [] as string[],
});

const formatContentDate = (value?: string | Date | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ar-EG');
};

const TeacherContentManager = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [selectedTab, setSelectedTab] = useState<ContentTab>('lectures');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formData, setFormData] = useState(createEmptyForm);
  const [contentItems, setContentItems] = useState<ContentItem[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [tabState, setTabState] = useState<Record<ContentTab, TabStatus>>(createEmptyTabState);
  const [saving, setSaving] = useState(false);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [coursesError, setCoursesError] = useState(false);
  const [groupsError, setGroupsError] = useState(false);
  const [referencesReady, setReferencesReady] = useState(false);
  const requestRef = useRef(0);
  const sessionRef = useRef(0);
  const saveGuardRef = useRef(false);
  const deleteGuardRef = useRef<Set<string>>(new Set());

  const resetForm = useCallback(() => setFormData(createEmptyForm()), []);

  const loadContent = useCallback(async () => {
    const requestId = ++requestRef.current;
    setReferencesReady(false);
    const session = sessionRef.current;
    if (!localStorage.getItem('authToken')) {
      navigate('/auth', { replace: true });
      return;
    }

    setTabState((previous) => ({
      lectures: { ...previous.lectures, loading: true, error: false },
      materials: { ...previous.materials, loading: true, error: false },
      exams: { ...previous.exams, loading: true, error: false },
    }));
    setCoursesError(false);
    setGroupsError(false);

    const [coursesResult, groupsResult, lecturesResult, materialsResult, examsResult] =
      await Promise.allSettled([getCourses(), getGroups(), getLectures(), getMaterials(), getExams()]);
    if (requestId !== requestRef.current || session !== sessionRef.current) return;
    setReferencesReady(coursesResult.status === 'fulfilled' && groupsResult.status === 'fulfilled');

    const courseData = coursesResult.status === 'fulfilled' ? (coursesResult.value || []) : [];
    const groupData = groupsResult.status === 'fulfilled' ? (groupsResult.value || []) : [];
    if (coursesResult.status === 'fulfilled') setCourses(courseData);
    if (groupsResult.status === 'fulfilled') setGroups(groupData);
    setCoursesError(coursesResult.status !== 'fulfilled');
    setGroupsError(groupsResult.status !== 'fulfilled');

    const courseNames = new Map(courseData.map((course) => [course.id, course.name]));
    const nextItems: ContentItem[] = [];

    if (lecturesResult.status === 'fulfilled') {
      nextItems.push(...(lecturesResult.value || []).map((lecture) => ({
        id: lecture.id,
        title: lecture.title,
        description: lecture.description || '',
        type: 'lecture' as const,
        course: lecture.course_name || courseNames.get(lecture.course_id) || lecture.course_id,
        uploadDate: formatContentDate(lecture.created_at),
        youtubeUrl: lecture.video_url,
        fileUrl: lecture.video_url,
        duration: lecture.duration_minutes ? `${lecture.duration_minutes} دقيقة` : undefined,
      })));
    }

    if (materialsResult.status === 'fulfilled') {
      nextItems.push(...(materialsResult.value || []).map((material) => ({
        id: material.id,
        title: material.title,
        description: material.description || '',
        type: 'material' as const,
        subType: material.material_type,
        course: material.course_name || courseNames.get(material.course_id) || material.course_id,
        uploadDate: formatContentDate(material.created_at),
        fileUrl: material.file_url,
      })));
    }

    if (examsResult.status === 'fulfilled') {
      nextItems.push(...(examsResult.value || []).map((exam) => {
        const examRow = exam as Exam & { created_at?: string };
        return {
          id: exam.id,
          title: exam.title,
          description: '',
          type: 'exam' as const,
          course: courseNames.get(exam.course_id) || exam.course_id,
          uploadDate: formatContentDate(examRow.created_at),
          duration: exam.duration_minutes ? `${exam.duration_minutes} دقيقة` : undefined,
          totalMarks: exam.total_marks,
        };
      }));
    }

    setContentItems((previous) => {
      const retained = previous.filter((item) => {
        if (item.type === 'lecture') return lecturesResult.status !== 'fulfilled';
        if (item.type === 'material') return materialsResult.status !== 'fulfilled';
        return examsResult.status !== 'fulfilled';
      });
      return [...nextItems, ...retained];
    });

    setTabState((previous) => ({
      lectures: lecturesResult.status === 'fulfilled'
        ? { loading: false, error: false, loaded: true }
        : { loading: false, error: true, loaded: previous.lectures.loaded },
      materials: materialsResult.status === 'fulfilled'
        ? { loading: false, error: false, loaded: true }
        : { loading: false, error: true, loaded: previous.materials.loaded },
      exams: examsResult.status === 'fulfilled'
        ? { loading: false, error: false, loaded: true }
        : { loading: false, error: true, loaded: previous.exams.loaded },
    }));
  }, [navigate]);

  useEffect(() => {
    void loadContent();

    const refresh = () => {
      sessionRef.current += 1;
      requestRef.current += 1;
      setContentItems([]);
      setCourses([]);
      setGroups([]);
      setTabState(createEmptyTabState());
      setCoursesError(false);
      setGroupsError(false);
      setIsDialogOpen(false);
      resetForm();
      setSaving(false);
      setDeletingIds([]);
      saveGuardRef.current = false;
      deleteGuardRef.current.clear();
      void loadContent();
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
  }, [loadContent, resetForm]);

  const handleAddContent = async () => {
    if (saveGuardRef.current || !referencesReady || coursesError || groupsError) return;
    if (!formData.title || !formData.description || !courses.some(course => course.id === formData.course)
        || formData.groupIds.some(id => !groups.some(group => group.id === id && group.course_id === formData.course))) {
      toast({
        title: "خطأ",
        description: "يرجى ملء جميع الحقول المطلوبة",
        variant: "destructive"
      });
      return;
    }
    if (formData.groupIds.length === 0) {
      toast({
        title: "خطأ",
        description: "اختر مجموعة واحدة على الأقل",
        variant: "destructive"
      });
      return;
    }
    if (selectedTab === 'lectures' && !formData.youtubeUrl.trim()) {
      toast({ title: "خطأ", description: "رابط الفيديو مطلوب", variant: "destructive" });
      return;
    }
    if (selectedTab === 'materials' && !formData.fileUrl.trim()) {
      toast({ title: "خطأ", description: "رابط الملف مطلوب", variant: "destructive" });
      return;
    }
    if (selectedTab === 'exams' && (!formData.durationMinutes || !formData.totalMarks)) {
      toast({ title: "خطأ", description: "المدة والدرجة الكلية مطلوبتان", variant: "destructive" });
      return;
    }
    if (!localStorage.getItem('authToken')) {
      toast({ title: "انتهت الجلسة", description: "يرجى تسجيل الدخول مرة أخرى", variant: "destructive" });
      navigate('/auth', { replace: true });
      return;
    }

    saveGuardRef.current = true;
    setSaving(true);
    const session = sessionRef.current;
    try {
      if (selectedTab === 'lectures') {
        await createLecture({
          course_id: formData.course,
          group_id: formData.groupIds[0],
          title: formData.title,
          description: formData.description || undefined,
          video_url: formData.youtubeUrl.trim(),
          duration_minutes: formData.durationMinutes ? Number(formData.durationMinutes) : undefined,
          price: formData.price ? Number(formData.price) : 0,
          is_free: false,
          is_published: true,
        });
      } else if (selectedTab === 'materials') {
        await createMaterial({
          course_id: formData.course,
          title: formData.title,
          description: formData.description || undefined,
          material_type: formData.type,
          file_url: formData.fileUrl.trim(),
          is_free: false,
          is_published: true,
          group_ids: formData.groupIds,
        });
      } else {
        const examPayload: Partial<Exam> & { description?: string; group_ids: string[] } = {
          course_id: formData.course,
          title: formData.title,
          description: formData.description || undefined,
          duration_minutes: Number(formData.durationMinutes),
          total_marks: Number(formData.totalMarks),
          group_ids: formData.groupIds,
          is_active: true,
        };
        await createExam(examPayload);
      }

      if (session !== sessionRef.current) return;

      toast({
        title: "تم الحفظ بنجاح",
        description: `تم إضافة ${selectedTab === 'lectures' ? 'محاضرة' : selectedTab === 'materials' ? 'مادة تعليمية' : 'امتحان'} جديد`,
      });
      resetForm();
      setIsDialogOpen(false);
      void loadContent();
    } catch (error) {
      if (session !== sessionRef.current) return;
      console.error('Error saving content:', error);
      toast({
        title: "خطأ",
        description: error instanceof Error && error.message
          ? error.message
          : 'تعذّر حفظ المحتوى',
        variant: "destructive"
      });
    } finally {
      if (session === sessionRef.current) {
        saveGuardRef.current = false;
        setSaving(false);
      }
    }
  };

  const handleDelete = async (item: ContentItem) => {
    if (deleteGuardRef.current.has(item.id)) return;
    if (!confirm('هل أنت متأكد من حذف هذا العنصر؟')) return;
    if (!localStorage.getItem('authToken')) {
      toast({ title: "انتهت الجلسة", description: "يرجى تسجيل الدخول مرة أخرى", variant: "destructive" });
      navigate('/auth', { replace: true });
      return;
    }

    deleteGuardRef.current.add(item.id);
    setDeletingIds((previous) => [...previous, item.id]);
    const session = sessionRef.current;
    try {
      if (item.type === 'lecture') {
        await deleteLecture(item.id);
      } else if (item.type === 'material') {
        await deleteMaterial(item.id);
      } else {
        const deleted = await deleteExam(item.id);
        if (!deleted) throw new Error('تعذّر حذف الامتحان');
      }
      if (session !== sessionRef.current) return;

      requestRef.current += 1;
      void loadContent();
      toast({
        title: "تم الحذف",
        description: "تم حذف العنصر بنجاح",
      });
    } catch (error) {
      if (session !== sessionRef.current) return;
      console.error('Error deleting content:', error);
      toast({
        title: "خطأ",
        description: error instanceof Error && error.message
          ? error.message
          : 'تعذّر حذف العنصر',
        variant: "destructive"
      });
    } finally {
      if (session === sessionRef.current) {
        deleteGuardRef.current.delete(item.id);
        setDeletingIds((previous) => previous.filter((deletingId) => deletingId !== item.id));
      }
    }
  };

  const availableGroups = groups.filter((group) => !formData.course || group.course_id === formData.course);

  const toggleGroup = (groupId: string) => {
    setFormData((previous) => {
      if (selectedTab !== 'materials') {
        return {
          ...previous,
          groupIds: previous.groupIds.includes(groupId) ? [] : [groupId],
        };
      }
      return {
        ...previous,
        groupIds: previous.groupIds.includes(groupId)
          ? previous.groupIds.filter((id) => id !== groupId)
          : [...previous.groupIds, groupId],
      };
    });
  };

  const filteredItems = contentItems.filter(item => {
    if (selectedTab === 'lectures') return item.type === 'lecture';
    if (selectedTab === 'materials') return item.type === 'material';
    if (selectedTab === 'exams') return item.type === 'exam';
    return true;
  });

  const getIcon = (item: ContentItem) => {
    if (item.type === 'lecture') return <Video className="w-5 h-5" />;
    if (item.type === 'exam') return <FileText className="w-5 h-5" />;
    if (item.subType === 'pdf') return <FileText className="w-5 h-5" />;
    if (item.subType === 'video') return <Video className="w-5 h-5" />;
    if (item.subType === 'presentation') return <Presentation className="w-5 h-5" />;
    if (item.subType === 'link') return <LinkIcon className="w-5 h-5" />;
    return <File className="w-5 h-5" />;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-900 dark:via-indigo-950 dark:to-violet-950" dir="rtl">
      <FloatingParticles />
      <Header />

      <main className="container mx-auto px-4 py-8 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-4xl font-bold bg-gradient-to-r from-indigo-600 via-blue-600 to-violet-600 bg-clip-text text-transparent mb-2">
                إدارة المحتوى التعليمي
              </h1>
              <p className="text-slate-600 dark:text-slate-400">رفع وإدارة المحاضرات، المواد التعليمية، والامتحانات</p>
            </div>
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-indigo-600 via-blue-600 to-violet-600 hover:from-indigo-700 hover:via-blue-700 hover:to-violet-700 shadow-lg hover:shadow-xl transition-all">
                  <Plus className="w-5 h-5 ml-2" />
                  إضافة محتوى جديد
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[600px]" dir="rtl">
                <DialogHeader>
                  <DialogTitle className="text-2xl">
                    إضافة {selectedTab === 'lectures' ? 'محاضرة' : selectedTab === 'materials' ? 'مادة تعليمية' : 'امتحان'} جديد
                  </DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  {(coursesError || groupsError) && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                      تعذّر تحميل {coursesError && groupsError ? 'الكورسات والمجموعات' : coursesError ? 'الكورسات' : 'المجموعات'}. لن تتمكن من النشر حتى تنجح إعادة المحاولة.
                      <Button type="button" variant="outline" size="sm" className="mt-2 w-full" onClick={() => void loadContent()}>
                        إعادة المحاولة
                      </Button>
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Label htmlFor="title">العنوان *</Label>
                    <Input
                      id="title"
                      placeholder="عنوان المحتوى"
                      value={formData.title}
                      onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="description">الوصف *</Label>
                    <Textarea
                      id="description"
                      placeholder="وصف تفصيلي للمحتوى"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      rows={3}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="course">الكورس *</Label>
                    <Select
                      value={formData.course}
                      onValueChange={(value) => setFormData((previous) => ({ ...previous, course: value, groupIds: [] }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر الكورس" />
                      </SelectTrigger>
                      <SelectContent>
                        {courses.map((course) => (
                          <SelectItem key={course.id} value={course.id}>
                            {course.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <Label>المجموعات *</Label>
                    {!formData.course ? (
                      <p className="text-xs text-muted-foreground">اختر الكورس أولاً لعرض مجموعاته.</p>
                    ) : availableGroups.length === 0 ? (
                      <p className="text-xs text-muted-foreground">لا توجد مجموعات مرتبطة بهذا الكورس.</p>
                    ) : (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {availableGroups.map((group) => (
                          <label key={group.id} className="flex items-center gap-2 rounded-md border p-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={formData.groupIds.includes(group.id)}
                              onChange={() => toggleGroup(group.id)}
                              className="w-4 h-4"
                            />
                            <span className="text-sm">{group.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  {selectedTab === 'lectures' && (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="youtubeUrl">رابط الفيديو الداخلي *</Label>
                        <Input
                          id="youtubeUrl"
                          placeholder="video://..."
                          value={formData.youtubeUrl}
                          onChange={(e) => setFormData({ ...formData, youtubeUrl: e.target.value })}
                        />
                        <p className="text-xs text-muted-foreground">
                          الروابط الخارجية غير مسموحة. استخدم مرجع فيديو داخلي بصيغة video://.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="grid gap-2">
                          <Label htmlFor="durationMinutes">المدة بالدقائق</Label>
                          <Input
                            id="durationMinutes"
                            type="number"
                            min="0"
                            placeholder="45"
                            value={formData.durationMinutes}
                            onChange={(e) => setFormData({ ...formData, durationMinutes: e.target.value })}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="price">السعر</Label>
                          <Input
                            id="price"
                            type="number"
                            min="0"
                            placeholder="0"
                            value={formData.price}
                            onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {selectedTab === 'materials' && (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="type">نوع المادة</Label>
                        <Select
                          value={formData.type}
                          onValueChange={(value) => setFormData({ ...formData, type: value as CourseMaterial['material_type'] })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="اختر نوع المادة" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pdf">PDF</SelectItem>
                            <SelectItem value="presentation">عرض تقديمي</SelectItem>
                            <SelectItem value="link">رابط</SelectItem>
                            <SelectItem value="other">ملف آخر</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="fileUrl">رابط الملف *</Label>
                        <Input
                          id="fileUrl"
                          placeholder="https://drive.google.com/..."
                          value={formData.fileUrl}
                          onChange={(e) => setFormData({ ...formData, fileUrl: e.target.value })}
                        />
                      </div>
                    </>
                  )}

                  {selectedTab === 'exams' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="durationMinutes">المدة بالدقائق *</Label>
                        <Input
                          id="durationMinutes"
                          type="number"
                          min="1"
                          placeholder="60"
                          value={formData.durationMinutes}
                          onChange={(e) => setFormData({ ...formData, durationMinutes: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="totalMarks">الدرجة الكلية *</Label>
                        <Input
                          id="totalMarks"
                          type="number"
                          min="1"
                          placeholder="100"
                          value={formData.totalMarks}
                          onChange={(e) => setFormData({ ...formData, totalMarks: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)} disabled={saving}>
                    إلغاء
                  </Button>
                  <Button 
                    className="bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
                    onClick={handleAddContent}
                    disabled={saving || !referencesReady || coursesError || groupsError}
                  >
                    {saving ? 'جاري الحفظ...' : 'إضافة'}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 bg-white dark:bg-slate-800 p-1 rounded-xl shadow-md">
            <Button
              variant={selectedTab === 'lectures' ? 'default' : 'ghost'}
              onClick={() => setSelectedTab('lectures')}
              className={selectedTab === 'lectures' ? 'bg-gradient-to-r from-cyan-600 to-teal-600' : ''}
            >
              <Video className="w-4 h-4 ml-2" />
              المحاضرات
            </Button>
            <Button
              variant={selectedTab === 'materials' ? 'default' : 'ghost'}
              onClick={() => setSelectedTab('materials')}
              className={selectedTab === 'materials' ? 'bg-gradient-to-r from-cyan-600 to-teal-600' : ''}
            >
              <BookOpen className="w-4 h-4 ml-2" />
              المواد التعليمية
            </Button>
            <Button
              variant={selectedTab === 'exams' ? 'default' : 'ghost'}
              onClick={() => setSelectedTab('exams')}
              className={selectedTab === 'exams' ? 'bg-gradient-to-r from-cyan-600 to-teal-600' : ''}
            >
              <FileText className="w-4 h-4 ml-2" />
              الامتحانات
            </Button>
          </div>
        </motion.div>

        {tabState[selectedTab].error && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mb-6 rounded-xl border border-red-200 bg-red-50 p-6 text-center"
          >
            <AlertCircle className="w-10 h-10 text-red-600 mx-auto mb-3" />
            <h3 className="text-lg font-bold text-slate-800 mb-1">تعذّر تحميل هذا القسم</h3>
            <p className="text-sm text-slate-600 mb-4">
              لا نعرض قائمة فارغة كأن القسم نظيف. قد تكون الجلسة أو الصلاحية غير كافية.
            </p>
            <Button variant="outline" onClick={() => void loadContent()} className="gap-2">
              <RefreshCw className="w-4 h-4" />
              إعادة المحاولة
            </Button>
          </motion.div>
        )}

        {tabState[selectedTab].loading && filteredItems.length === 0 && !tabState[selectedTab].error && (
          <div className="text-center py-16 text-slate-500" aria-live="polite">
            جارٍ تحميل المحتوى...
          </div>
        )}

        {/* Content Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AnimatePresence mode="popLayout">
            {filteredItems.map((item, index) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: index * 0.05 }}
              >
                <Card className="bg-white dark:bg-slate-800 shadow-lg hover:shadow-xl transition-all border-0 overflow-hidden group">
                  {item.thumbnail && (
                    <div className="h-48 overflow-hidden relative">
                      <img
                        src={item.thumbnail}
                        alt={item.title}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                      <Badge className="absolute top-3 right-3 bg-gradient-to-r from-cyan-600 to-teal-600">
                        {item.type === 'lecture' ? 'محاضرة' : item.type === 'material' ? 'مادة' : 'امتحان'}
                      </Badge>
                    </div>
                  )}
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 text-cyan-600 dark:text-cyan-400">
                        {getIcon(item)}
                        <CardTitle className="text-lg">{item.title}</CardTitle>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {item.description && (
                      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4 line-clamp-2">
                        {item.description}
                      </p>
                    )}
                    <div className="space-y-2 mb-4">
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <BookOpen className="w-4 h-4" />
                        <span>{item.course}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <Calendar className="w-4 h-4" />
                        <span>{item.uploadDate}</span>
                      </div>
                      {item.duration && (
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <Clock className="w-4 h-4" />
                          <span>{item.duration}</span>
                        </div>
                      )}
                      {typeof item.totalMarks === 'number' && (
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <FileText className="w-4 h-4" />
                          <span>{item.totalMarks} درجة</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                      >
                        <Eye className="w-4 h-4 ml-1" />
                        عرض
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-600 text-red-600 hover:bg-red-50"
                        onClick={() => handleDelete(item)}
                        disabled={deletingIds.includes(item.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {!tabState[selectedTab].loading
          && !tabState[selectedTab].error
          && tabState[selectedTab].loaded
          && filteredItems.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <div className="text-cyan-600 mb-4">
              <Sparkles className="w-16 h-16 mx-auto" />
            </div>
            <h3 className="text-2xl font-bold text-slate-700 dark:text-slate-300 mb-2">
              لا يوجد محتوى حتى الآن
            </h3>
            <p className="text-slate-500 dark:text-slate-400 mb-6">
              ابدأ بإضافة {selectedTab === 'lectures' ? 'محاضرات' : selectedTab === 'materials' ? 'مواد تعليمية' : 'امتحانات'} للطلاب
            </p>
            <Button
              className="bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
              onClick={() => setIsDialogOpen(true)}
            >
              <Plus className="w-5 h-5 ml-2" />
              إضافة المحتوى الأول
            </Button>
          </motion.div>
        )}
      </main>
    </div>
  );
};

export default TeacherContentManager;
