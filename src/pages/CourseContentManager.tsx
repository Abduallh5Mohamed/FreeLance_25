import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { getCourses, getMaterials, createMaterial, deleteMaterial, getGrades, getGroups, type CourseMaterial } from '@/lib/api-http';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  createMaterialManagementController,
  readCourseSessionPrincipal,
  resolvePreviewMaterial,
  type MaterialFormValues,
  type MaterialManagementController,
  type MaterialManagementState,
} from '@/features/catalog/material-management';
import { Upload, Video, FileText, Presentation, Trash2, Plus, Play, BookOpen, Clock, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { VideoPlayer } from '@/components/VideoPlayer';
import Header from '@/components/Header';

/**
 * M2-03 — existing material management.
 *
 * The page owns only rendering and the typed form; every request lifecycle
 * (course/session/form/operation lifetimes, duplicate suppression, retained
 * failure state, honest contract refusal) lives in
 * `src/features/catalog/material-management.ts`, which is what the hermetic
 * tests drive. `DELETE` unpublishes (the server never hard-deletes), and an
 * external video link is refused before any request instead of being rewritten
 * into a link the server rejects.
 */
const EMPTY_FORM: MaterialFormValues = {
  title: '',
  description: '',
  material_type: 'video',
  file_url: '',
  duration_minutes: '',
  is_free: false,
  grade_id: '',
  group_ids: [],
};

/**
 * The canonical session boundary (M2-02's accepted reader): the token is only
 * compared inside the reader, never returned, rendered or sent anywhere.
 */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

export default function CourseContentManager() {
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<MaterialManagementState | null>(null);
  const [formData, setFormData] = useState<MaterialFormValues>(EMPTY_FORM);
  const controllerRef = useRef<MaterialManagementController | null>(null);
  /** The form incarnation this page is showing: a submit from an older one can
   *  never clear or close the form the instructor is typing into now. */
  const formInstanceRef = useRef(0);

  useEffect(() => {
    // One controller per mount: the seam owns the request lifecycle, the page
    // owns only the form. Disposal retires everything in flight on unmount.
    const instance = createMaterialManagementController({
      loadCourses: getCourses,
      loadGrades: getGrades,
      loadGroups: getGroups,
      loadMaterials: (courseId) => getMaterials(courseId),
      createMaterial: (payload) => createMaterial(payload),
      unpublishMaterial: (id) => deleteMaterial(id),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    const unsubscribe = instance.subscribe(setSnapshot);
    controllerRef.current = instance;
    formInstanceRef.current = instance.openForm();
    void instance.loadCourses();
    void instance.loadOptions();
    return () => {
      controllerRef.current = null;
      instance.dispose();
      unsubscribe();
    };
  }, []);

  // A different principal must not inherit the previous instructor's typed
  // form: the page-owned values and their incarnation are reset here.
  useEffect(() => {
    return subscribeSessionChange(() => {
      formInstanceRef.current = controllerRef.current?.openForm() ?? 0;
      setFormData(EMPTY_FORM);
    });
  }, []);

  const selectedCourse = snapshot?.selectedCourse ?? '';
  const busyKind = snapshot?.busyKind ?? null;

  // A course change opens a NEW form incarnation and clears what was typed for
  // the previous course, so a late save cannot reset the new form.
  useEffect(() => {
    if (!controllerRef.current) return;
    formInstanceRef.current = controllerRef.current.openForm();
    setFormData(EMPTY_FORM);
  }, [selectedCourse]);

  const courses = snapshot?.courses ?? [];
  const materials = snapshot?.materials ?? [];
  const phase = snapshot?.phase ?? 'idle';
  const selectedCourseData = courses.find((c) => c.id === selectedCourse);
  /**
   * The player is rendered from the CONTROLLER's preview id resolved against
   * the confirmed list — never from a URL captured when Play was clicked. A
   * course switch, an empty selection, a logout or a refresh that no longer
   * returns the row all unmount it on the same render.
   */
  const previewMaterial = resolvePreviewMaterial(materials, snapshot?.previewMaterialId ?? null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const controller = controllerRef.current;
    if (!controller) return;
    const outcome = await controller.submit(formData, formInstanceRef.current);
    if (outcome === 'created') {
      // The server confirmed the write: only now is the typed form cleared, and
      // a fresh incarnation starts for the next material.
      setFormData(EMPTY_FORM);
      formInstanceRef.current = controller.openForm();
      toast({ title: 'نجح', description: 'تم إضافة المحتوى بنجاح' });
      return;
    }
    if (outcome === 'rejected') {
      toast({
        title: 'غير مسموح',
        description: 'روابط الفيديو الخارجية غير مسموحة من الخادم؛ ارفع الفيديو إلى المنصة أولًا.',
        variant: 'destructive',
      });
      return;
    }
    if (outcome === 'failed') {
      toast({
        title: 'خطأ',
        description: controller.getState().createError ?? 'فشل إضافة المحتوى',
        variant: 'destructive',
      });
      return;
    }
    // 'invalid' renders the field errors; 'duplicate' / 'blocked' are silent:
    // the operation is already on screen or was retired by a newer state.
  };

  const handleDelete = async (material: CourseMaterial) => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (!window.confirm('سيتم إلغاء نشر هذا المحتوى (لن يُحذف نهائيًا من قاعدة البيانات). هل أنت متأكد؟')) {
      return;
    }
    controller.requestDelete(material);
    const outcome = await controller.confirmDelete();
    if (outcome === 'unpublished') {
      toast({ title: 'نجح', description: 'تم إلغاء نشر المحتوى' });
    } else if (outcome === 'failed') {
      toast({
        title: 'خطأ',
        description: controller.getState().deleteError ?? 'فشل إلغاء نشر المحتوى',
        variant: 'destructive',
      });
    }
  };

  const getMaterialIcon = (type: CourseMaterial['material_type']) => {
    switch (type) {
      case 'video': return <Video className="h-5 w-5 text-cyan-500" />;
      case 'pdf': return <FileText className="h-5 w-5 text-red-500" />;
      case 'presentation': return <Presentation className="h-5 w-5 text-cyan-500" />;
      default: return <Upload className="h-5 w-5 text-gray-500" />;
    }
  };

  const fieldErrors = snapshot?.fieldErrors ?? {};
  const groupsForGrade = (snapshot?.groups ?? []).filter((g) => g.grade_id === formData.grade_id);

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
            <Select
              value={selectedCourse}
              onValueChange={(v) => { void controllerRef.current?.selectCourse(v); }}
            >
              <SelectTrigger className="h-12 text-lg">
                <SelectValue placeholder="اختر دورة لإدارة محتواها" />
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

            {snapshot?.coursesError && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
                <span className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  فشل تحميل الدورات: {snapshot.coursesError}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => { void controllerRef.current?.loadCourses(); }}
                >
                  <RefreshCw className="h-4 w-4 ml-1" />
                  إعادة المحاولة
                </Button>
              </div>
            )}

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

        {snapshot?.optionsError && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <AlertTriangle className="h-4 w-4" />
            فشل تحميل الصفوف والمجموعات: {snapshot.optionsError}
          </div>
        )}

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
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label className="text-sm font-semibold">الصف الدراسي *</Label>
                    <Select
                      value={formData.grade_id}
                      onValueChange={(v) => setFormData({ ...formData, grade_id: v, group_ids: [] })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="اختر الصف الدراسي" />
                      </SelectTrigger>
                      <SelectContent>
                        {(snapshot?.grades ?? [])
                          .filter(g => !selectedCourseData?.grade || g.name === selectedCourseData.grade)
                          .map(g => (
                          <SelectItem key={g.id} value={g.id}>
                            {g.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {fieldErrors.grade_id && (
                      <p className="text-xs text-red-600 mt-1">{fieldErrors.grade_id}</p>
                    )}
                  </div>

                  <div>
                    <Label className="text-sm font-semibold">المجموعات *</Label>
                    <div className="mt-1 space-y-2 max-h-40 overflow-y-auto border rounded-md p-3">
                      {formData.grade_id ? (
                        groupsForGrade.length > 0 ? (
                          groupsForGrade.map(group => (
                            <div key={group.id} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                id={`group-${group.id}`}
                                checked={formData.group_ids.includes(group.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setFormData({ ...formData, group_ids: [...formData.group_ids, group.id] });
                                  } else {
                                    setFormData({ ...formData, group_ids: formData.group_ids.filter(id => id !== group.id) });
                                  }
                                }}
                                className="h-4 w-4 rounded border-gray-300"
                              />
                              <Label htmlFor={`group-${group.id}`} className="cursor-pointer text-sm">
                                {group.name}
                              </Label>
                            </div>
                          ))
                        ) : (
                          <p className="text-xs text-muted-foreground">لا توجد مجموعات لهذا الصف</p>
                        )
                      ) : (
                        <p className="text-xs text-muted-foreground">اختر الصف الدراسي أولاً</p>
                      )}
                    </div>
                    {fieldErrors.group_ids && (
                      <p className="text-xs text-red-600 mt-1">{fieldErrors.group_ids}</p>
                    )}
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
                    {fieldErrors.title && (
                      <p className="text-xs text-red-600 mt-1">{fieldErrors.title}</p>
                    )}
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
                        <Label className="text-sm font-semibold">مرجع الفيديو الداخلي (video://) *</Label>
                        <Input
                          value={formData.file_url}
                          onChange={e => setFormData({ ...formData, file_url: e.target.value })}
                          placeholder="video://..."
                          type="text"
                          required
                          className="mt-1"
                        />
                        <p className="text-xs text-amber-700 dark:text-amber-300 mt-1.5 flex items-start gap-1">
                          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          الخادم يرفض روابط الفيديو الخارجية؛ يجب رفع الفيديو إلى المنصة أولًا.
                        </p>
                        {fieldErrors.file_url && (
                          <p className="text-xs text-red-600 mt-1">{fieldErrors.file_url}</p>
                        )}
                      </div>

                      <div>
                        <Label className="text-sm font-semibold">المدة (بالدقائق)</Label>
                        <Input
                          value={formData.duration_minutes}
                          onChange={e => setFormData({ ...formData, duration_minutes: e.target.value })}
                          placeholder="30"
                          type="number"
                          min="1"
                          step="1"
                          className="mt-1"
                        />
                        {fieldErrors.duration_minutes && (
                          <p className="text-xs text-red-600 mt-1">{fieldErrors.duration_minutes}</p>
                        )}
                      </div>
                    </>
                  )}

                  {(formData.material_type === 'pdf' || formData.material_type === 'presentation') && (
                    <div>
                      <Label className="text-sm font-semibold">
                        {formData.material_type === 'pdf' ? 'رابط ملف PDF *' : 'رابط العرض التقديمي *'}
                      </Label>
                      <Input
                        value={formData.file_url}
                        onChange={e => setFormData({ ...formData, file_url: e.target.value })}
                        placeholder="https://drive.google.com/file/d/..."
                        type="url"
                        required
                        className="mt-1"
                      />
                      <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
                        💡 يُحفظ الرابط كما هو؛ تحويل روابط Google Drive إلى معاينة مضمّنة معطّل من الخادم.
                      </p>
                      {fieldErrors.file_url && (
                        <p className="text-xs text-red-600 mt-1">{fieldErrors.file_url}</p>
                      )}
                    </div>
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

                  {snapshot?.createError && (
                    <p className="text-sm text-red-600">{snapshot.createError}</p>
                  )}
                  {snapshot?.contractNotice && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">{snapshot.contractNotice}</p>
                  )}

                  <Button
                    type="submit"
                    disabled={busyKind === 'create'}
                    className="w-full h-11 bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700"
                  >
                    <Plus className="h-4 w-4 ml-2" />
                    {busyKind === 'create' ? 'جارٍ الإضافة...' : 'إضافة المحتوى'}
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
                {snapshot?.refreshError && (
                  <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
                    <span className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4" />
                      تعذر تحديث القائمة؛ المعروض الآن هو آخر حالة أكدها الخادم: {snapshot.refreshError}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => { void controllerRef.current?.refresh(); }}
                    >
                      <RefreshCw className="h-4 w-4 ml-1" />
                      تحديث
                    </Button>
                  </div>
                )}

                {phase === 'idle' ? (
                  <div className="text-center py-16 px-4">
                    <BookOpen className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                    <p className="text-lg font-semibold text-gray-600 dark:text-gray-400">
                      اختر دورة لعرض محتواها
                    </p>
                  </div>
                ) : phase === 'loading' ? (
                  <div className="flex flex-col items-center justify-center py-16">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-cyan-600 mb-4"></div>
                    <p className="text-muted-foreground">جاري التحميل...</p>
                  </div>
                ) : phase === 'error' ? (
                  <div className="text-center py-16 px-4">
                    <AlertTriangle className="h-16 w-16 text-red-300 mx-auto mb-4" />
                    <p className="text-lg font-semibold text-red-700 dark:text-red-300">
                      فشل تحميل المحتوى
                    </p>
                    <p className="text-sm text-muted-foreground mt-2">{snapshot?.listError}</p>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-4"
                      onClick={() => { void controllerRef.current?.refresh(); }}
                    >
                      <RefreshCw className="h-4 w-4 ml-1" />
                      إعادة المحاولة
                    </Button>
                  </div>
                ) : phase === 'empty' ? (
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
                              onClick={() => { controllerRef.current?.requestPreview(m.id); }}
                              className="bg-gradient-to-r from-cyan-500 to-teal-600 hover:from-cyan-600 hover:to-teal-700"
                            >
                              <Play className="h-4 w-4 ml-1" />
                              تشغيل
                            </Button>
                          )}
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => { void handleDelete(m); }}
                            disabled={busyKind === 'delete'}
                            title="إلغاء النشر"
                            aria-label={`إلغاء نشر ${m.title}`}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
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

      {/* Video Player Modal — mounted only while the previewed row is still in
          the confirmed list of the current course/session. */}
      {previewMaterial && previewMaterial.file_url && (
        <VideoPlayer
          url={previewMaterial.file_url}
          title={previewMaterial.title}
          onClose={() => { controllerRef.current?.closePreview(); }}
        />
      )}
    </div>
  );
}
