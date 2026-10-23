import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookOpen, Plus, Edit2, Trash2, Users, Calendar, Globe, EyeOff } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import type { Course } from "@/lib/api";
import {
  getCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  getGrades,
  getSubscriptions,
  publishCourse,
  unpublishCourse,
} from "@/lib/api";
import { subscribeSessionChange } from "@/lib/session-events";
import {
  COURSE_PUBLICATION_UNCERTAIN_MESSAGE,
  COURSE_PUBLISHED_MESSAGE,
  COURSE_PUBLICATION_UNCHANGED_MESSAGE,
  COURSE_UNPUBLISHED_MESSAGE,
  createCourseManagementController,
  readCourseSessionPrincipal,
  toGradeFieldValue,
  type CourseFormValues,
  type CourseManagementController,
  type CourseManagementState,
  type CoursePublicationState,
} from "@/features/catalog/course-management";
// M2-09: the private course-unit metadata panel is mounted INSIDE the existing
// course-details dialog only, keyed by the selected course id. It owns no
// course state of its own: the selected course is a RESOURCE id and never a
// tenant authority.
import CourseUnitManager from "@/features/catalog/CourseUnitManager";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const EMPTY_FORM: CourseFormValues = {
  name: "",
  description: "",
  subject: "التاريخ",
  grade_id: "",
  subscription_id: "",
  price: ""
};

/**
 * The session principal the list and every write are scoped to. It is read at
 * claim time AND at commit time, so a reply that lands after the signed-in
 * user changed can never commit into the wrong workspace.
 *
 * `id:role` alone could not see a token rotation or a silent re-login that
 * keeps the same user and role — the key matched, so a reply scoped to the
 * retired session still committed. The canonical `authToken` is therefore part
 * of the boundary, compared by EXACT equality inside the seam's private
 * closure: what travels through this page is only an opaque `session:<n>`
 * incarnation id, so the raw token is never stored in state, rendered, logged
 * or sent anywhere. (An earlier djb2 digest was NOT usable as that boundary:
 * it collides for distinct tokens, supervisor/064.)
 */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const Courses = () => {
  const currentRole = (() => { try { return JSON.parse(localStorage.getItem('currentUser') || '{}').role as string | undefined; } catch { return undefined; } })();
  const [formData, setFormData] = useState<CourseFormValues>(EMPTY_FORM);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [controller, setController] = useState<CourseManagementController | null>(null);
  const [snapshot, setSnapshot] = useState<CourseManagementState | null>(null);
  /** Incarnation of the open create/edit dialog. A save that resolves after
   *  the user opened another dialog (create while a save was pending, or edit
   *  of a different course) belongs to an older incarnation and may no longer
   *  close or reset the form the user is looking at. */
  const [formInstance, setFormInstance] = useState(0);

  const { toast } = useToast();

  useEffect(() => {
    // One controller per mount: the seam owns the request lifecycle, the page
    // owns only the form. Disposal retires everything in flight on unmount.
    const instance = createCourseManagementController({
      loadCourses: getCourses,
      loadGrades: getGrades,
      loadSubscriptions: currentRole === 'instructor' ? undefined : getSubscriptions,
      createCourse: (payload) => createCourse(payload),
      updateCourse: (id, payload) => updateCourse(id, payload),
      archiveCourse: (id) => deleteCourse(id),
      // M2-22 — publication is an explicit DISCOVERY flag. It never enrolls
      // anyone, grants access to a lesson or a file, notifies a recipient or
      // takes payment; it only decides whether the course appears in the
      // anonymous public catalogue.
      publishCourse: (id) => publishCourse(id),
      unpublishCourse: (id) => unpublishCourse(id),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    const unsubscribe = instance.subscribe(setSnapshot);
    void instance.load();
    void instance.loadOptions();
    setController(instance);
    return () => {
      unsubscribe();
      instance.dispose();
      setController(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // A completed session mutation (login, logout, token rotation, identity or
    // scope change) makes every page-owned datum from the previous scope
    // foreign: the controller clears its own list/options/delete target, and
    // this clears the dialogs and the form the page owns. Without it a pending
    // old-scope save could close the new session's dialog, and the detail
    // dialog could keep rendering the previous tenant's course.
    const unsubscribe = subscribeSessionChange(() => {
      setFormInstance(0);
      setIsOpen(false);
      setEditingCourse(null);
      setFormData(EMPTY_FORM);
      setDeleteDialogOpen(false);
      setDetailsDialogOpen(false);
      setSelectedCourse(null);
    });
    return unsubscribe;
  }, []);

  const state = snapshot;
  const courses = state?.courses ?? [];
  const grades = state?.grades ?? [];
  const subscriptions = state?.subscriptions ?? [];
  const busyKind = state?.busyKind ?? null;
  const fieldErrors = state?.fieldErrors ?? {};
  const deleteTarget = state?.deleteTarget ?? null;

  const closeFormDialog = (active: CourseManagementController) => {
    // Retires the incarnation first: a save that is still on the wire can no
    // longer close or reset the dialog after this point.
    active.closeForm();
    setFormInstance(0);
    setIsOpen(false);
    setEditingCourse(null);
    setFormData(EMPTY_FORM);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!controller) return;
    // The incarnation THIS submit belongs to. It is re-checked after the await
    // because the user may open another dialog while the request is pending.
    const instance = formInstance;

    const outcome = await controller.submit(formData, editingCourse, instance);

    if (outcome === 'created' || outcome === 'updated') {
      // The server confirmed the write AND the dialog that started it is still
      // the one on screen. The refresh after it is a separate operation: if it
      // fails the page only shows a notice, it never re-opens this form (that
      // is what produced a duplicate course).
      if (!controller.isFormCurrent(instance)) return;
      const notice = controller.getState().gradeNotice;
      toast({
        title: outcome === 'created' ? "تم الإضافة بنجاح" : "تم التحديث بنجاح",
        description: outcome === 'created' ? "تم إنشاء كورس جديد" : "تم تحديث بيانات الكورس",
      });
      if (notice) {
        toast({
          title: "تم الاحتفاظ بالصف الدراسي",
          description: `الصف "${notice}" غير متاح حاليًا وتم حفظه كما هو دون حذف.`,
        });
      }
      closeFormDialog(controller);
      return;
    }

    if (outcome === 'failed') {
      // Form and editing target stay exactly as the user left them — but only
      // while it is still the dialog the failure belongs to.
      if (!controller.isFormCurrent(instance)) return;
      toast({
        title: "خطأ",
        description: controller.getState().mutationError ?? "حدث خطأ، حاول مرة أخرى",
        variant: "destructive",
      });
      return;
    }

    if (outcome === 'duplicate') {
      // A second click before the first write settled: no second request.
      return;
    }
    // 'invalid' — the field errors are rendered from the state below.
  };

  const handleEdit = (course: Course) => {
    const instance = controller?.openForm(course) ?? 0;
    setFormInstance(instance);
    setEditingCourse(course);
    setFormData({
      name: course.name ?? "",
      description: course.description ?? "",
      subject: course.subject || "التاريخ",
      // `course.grade` is stored as a NAME: map it back to the grade id the
      // select renders, and keep the raw value when the grade is no longer
      // active so it is never silently cleared.
      grade_id: toGradeFieldValue(course.grade, grades),
      subscription_id: (course as { subscription_id?: string }).subscription_id ?? "",
      price: course.price === undefined || course.price === null ? "" : String(course.price)
    });
    setIsOpen(true);
  };

  const handleDelete = (course: Course) => {
    if (!controller) return;
    controller.requestArchive(course);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!controller) return;
    const outcome = await controller.confirmArchive();
    if (outcome === 'archived') {
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف الكورس",
      });
      setDeleteDialogOpen(false);
      return;
    }
    if (outcome === 'failed') {
      // The dialog and its target stay open with the server's message so the
      // user can retry the same course without selecting it again.
      toast({
        title: "خطأ",
        description: controller.getState().archiveError ?? "حدث خطأ في الحذف",
        variant: "destructive",
      });
    }
  };

  const handleViewDetails = (course: Course) => {
    setSelectedCourse(course);
    setDetailsDialogOpen(true);
  };

  /**
   * The publication state the screen shows for one course.
   *
   * `null` means NOT KNOWN — the private list did not report a state (the M2-22
   * migration is a file only and may not be applied yet) and no action has
   * confirmed one. The page never renders "draft" for an unknown state, and the
   * offered action for an unknown state is publish, which is a truthful no-op
   * when the course is already published.
   */
  const publicationOf = (course: Course): CoursePublicationState | null =>
    state?.publication?.[course.id] ?? null;

  const publicationLabel = (course: Course): string => {
    const current = publicationOf(course);
    if (current === 'published') return "منشور في صفحة الاستكشاف";
    if (current === 'draft') return "غير منشور";
    return "حالة النشر غير معروفة";
  };

  /**
   * Explicit publish / unpublish.
   *
   * The intent is passed in from the control that was actually rendered, so the
   * action can never disagree with the label the user clicked. The outcome is
   * the controller's explicit result — never inferred from the state — and the
   * server's confirmed state is what the card then shows.
   */
  const handlePublication = async (course: Course, intent: CoursePublicationState) => {
    if (!controller) return;
    const outcome = intent === 'published'
      ? await controller.publish(course.id)
      : await controller.unpublish(course.id);

    if (outcome === 'published') {
      toast({ title: "تم النشر", description: COURSE_PUBLISHED_MESSAGE });
      return;
    }
    if (outcome === 'unpublished') {
      toast({ title: "تم إلغاء النشر", description: COURSE_UNPUBLISHED_MESSAGE });
      return;
    }
    if (outcome === 'unchanged') {
      toast({ title: "لا تغيير", description: COURSE_PUBLICATION_UNCHANGED_MESSAGE });
      return;
    }
    if (outcome === 'uncertain') {
      // The write may have persisted. Nothing is retried and no state is claimed.
      toast({
        title: "لم يتم تأكيد حالة النشر",
        description: controller.getState().publicationError ?? COURSE_PUBLICATION_UNCERTAIN_MESSAGE,
        variant: "destructive",
      });
      return;
    }
    if (outcome === 'unavailable') {
      toast({
        title: "النشر غير مفعّل",
        description: "لم يتم تفعيل نشر الكورسات على هذا الخادم بعد، لذلك لم يُرسل أي طلب.",
      });
      return;
    }
    if (outcome === 'failed') {
      toast({
        title: "خطأ",
        description: controller.getState().publicationError ?? "تعذّر تغيير حالة النشر",
        variant: "destructive",
      });
      return;
    }
    // 'duplicate' / 'blocked': a second click while a write is on the wire, or
    // an operation retired by a session change. No second request, no claim.
  };

  const openCreateDialog = () => {
    // A NEW incarnation: a save started by the previously open dialog can no
    // longer close or reset this one when it resolves late.
    const instance = controller?.openForm(null) ?? 0;
    setFormInstance(instance);
    setEditingCourse(null);
    setFormData(EMPTY_FORM);
    setIsOpen(true);
  };

  const gradeOptions = grades;
  const gradeValueMatches = gradeOptions.some((grade) => grade.id === formData.grade_id);

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

          <div className="flex items-center gap-2">
            {/* M2-22 — the public catalogue this page publishes into. It opens
                in a new tab so the private screen is never navigated away. */}
            <Button variant="outline" asChild>
              <a href="/discover" target="_blank" rel="noreferrer">
                <Globe className="w-4 h-4 ml-2" />
                صفحة الاستكشاف العامة
              </a>
            </Button>
            <Button className="shadow-medium" onClick={openCreateDialog}>
              <Plus className="w-4 h-4 ml-2" />
              إضافة كورس جديد
            </Button>
          </div>
        </div>

        {state?.refreshError && (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span>تم حفظ البيانات بنجاح، لكن تعذّر تحديث القائمة: {state.refreshError}</span>
            <Button variant="outline" size="sm" onClick={() => controller?.refresh()}>
              إعادة التحديث
            </Button>
          </div>
        )}

        <Dialog open={isOpen} onOpenChange={(open) => {
          if (!open) {
            // Closing retires the incarnation: a pending save started by this
            // dialog can no longer close or reset a newer one.
            controller?.closeForm();
            setFormInstance(0);
          }
          setIsOpen(open);
        }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editingCourse ? "تعديل الكورس" : "إضافة كورس جديد"}
              </DialogTitle>
              <DialogDescription>أدخل بيانات الكورس ثم احفظها.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">اسم الكورس</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="مثال: التاريخ - الصف الأول الثانوي"
                  aria-invalid={fieldErrors.name ? true : undefined}
                  aria-describedby={fieldErrors.name ? "name-error" : undefined}
                />
                {fieldErrors.name && (
                  <p id="name-error" role="alert" className="text-sm text-destructive">{fieldErrors.name}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="subject">المادة</Label>
                <Input
                  id="subject"
                  value={formData.subject}
                  onChange={(e) => setFormData(prev => ({ ...prev, subject: e.target.value }))}
                  placeholder="التاريخ"
                  aria-invalid={fieldErrors.subject ? true : undefined}
                  aria-describedby={fieldErrors.subject ? "subject-error" : undefined}
                />
                {fieldErrors.subject && (
                  <p id="subject-error" role="alert" className="text-sm text-destructive">{fieldErrors.subject}</p>
                )}
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
                    {gradeOptions.length > 0 ? (
                      gradeOptions.map((grade) => (
                        <SelectItem key={grade.id} value={grade.id || 'unknown'}>
                          {grade.name}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value="no-grade" disabled>
                        لا توجد صفوف دراسية - أضف صف أولاً
                      </SelectItem>
                    )}
                    {/* A legacy grade that is no longer active stays visible
                        and selectable instead of being dropped on save. */}
                    {formData.grade_id && !gradeValueMatches && (
                      <SelectItem value={formData.grade_id}>
                        {formData.grade_id} (غير متاح حاليًا)
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {state?.optionsError && (
                  <p className="text-sm text-destructive">تعذّر تحميل الصفوف الدراسية: {state.optionsError}</p>
                )}
              </div>
              {currentRole !== 'instructor' && <div className="space-y-2">
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
              </div>}
              <div className="space-y-2">
                <Label htmlFor="price">السعر (جنيه)</Label>
                <Input
                  id="price"
                  type="number"
                  value={formData.price === null || formData.price === undefined ? "" : String(formData.price)}
                  onChange={(e) => setFormData(prev => ({ ...prev, price: e.target.value }))}
                  placeholder="0"
                  min="0"
                  step="0.01"
                  aria-invalid={fieldErrors.price ? true : undefined}
                  aria-describedby={fieldErrors.price ? "price-error" : undefined}
                />
                {fieldErrors.price && (
                  <p id="price-error" role="alert" className="text-sm text-destructive">{fieldErrors.price}</p>
                )}
              </div>
              <Button type="submit" className="w-full" disabled={busyKind === 'create' || busyKind === 'update'}>
                {busyKind === 'create' || busyKind === 'update'
                  ? "جاري المعالجة..."
                  : (editingCourse ? "تحديث الكورس" : "إضافة الكورس")}
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {state?.phase === 'loading' && (
            <div className="col-span-full text-center py-12" role="status" aria-live="polite">
              <p className="text-muted-foreground">جاري تحميل الكورسات...</p>
            </div>
          )}

          {state?.phase === 'error' && (
            <div className="col-span-full text-center py-12 space-y-3">
              <p role="alert" className="text-destructive">{state.listError ?? "حدث خطأ في تحميل الكورسات"}</p>
              <Button variant="outline" onClick={() => controller?.load()}>
                إعادة المحاولة
              </Button>
            </div>
          )}

          {state?.phase === 'empty' && (
            <div className="col-span-full text-center py-12">
              <p className="text-muted-foreground">لا توجد كورسات بعد</p>
            </div>
          )}

          {state?.phase === 'ready' && courses.map((course) => (
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
                      aria-label={`تعديل الكورس ${course.name}`}
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    {/* M2-22 — the explicit publication control. The label, the
                        aria-label and the intent all derive from the SAME
                        confirmed state, so the action can never disagree with
                        what the button says. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handlePublication(
                        course,
                        publicationOf(course) === 'published' ? 'draft' : 'published',
                      )}
                      disabled={busyKind === 'publication'}
                      aria-label={publicationOf(course) === 'published'
                        ? `إلغاء نشر الكورس ${course.name}`
                        : `نشر الكورس ${course.name} في صفحة الاستكشاف`}
                    >
                      {publicationOf(course) === 'published'
                        ? <EyeOff className="w-4 h-4" />
                        : <Globe className="w-4 h-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(course)}
                      className="text-destructive hover:text-destructive"
                      aria-label={`حذف الكورس ${course.name}`}
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
                  {/* M2-22 — the confirmed publication state, or an explicit
                      "unknown" instead of a guessed one. */}
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">النشر:</span>
                    <span className="text-muted-foreground">{publicationLabel(course)}</span>
                  </div>

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
          ))}
        </div>

        {/* Dialog for Course Details */}
        <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
          {/* The panel below adds a bounded private section, so the dialog
              scrolls vertically instead of growing past the viewport. The
              course controller and the course form are untouched. */}
          <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>تفاصيل الكورس</DialogTitle>
              <DialogDescription>عرض بيانات الكورس المسجلة.</DialogDescription>
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

                {/* M2-09: the private unit panel is mounted ONLY while this
                    details dialog is open and a course is selected, and it is
                    KEYED by the course id — a different course is a different
                    panel with a different, immutable course binding, and
                    closing the dialog or changing the course unmounts it so
                    its private rows, drafts and in-flight replies die with
                    it. */}
                {detailsDialogOpen && selectedCourse ? (
                  <CourseUnitManager key={selectedCourse.id} courseId={selectedCourse.id} />
                ) : null}

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

        <AlertDialog
          open={deleteDialogOpen}
          onOpenChange={(open) => {
            // The dialog is NOT closed by the confirm action any more: the
            // installed Radix AlertDialogAction renders a Close child that
            // fires onOpenChange(false) the moment it is clicked, which
            // cancelled the target before the awaited request resolved and
            // defeated failure retention. Closing is now driven only by a
            // server-confirmed archive of the CURRENT target.
            if (!open && busyKind === 'archive') {
              // Dismissal while a delete is on the wire is ignored: the busy
              // state is owned by that request, not by the dialog.
              return;
            }
            setDeleteDialogOpen(open);
            // Closing the dialog (cancel / Escape) releases the pending target
            // and retires the in-flight archive with it.
            if (!open) controller?.cancelArchive();
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>هل أنت متأكد من حذف هذا الكورس؟</AlertDialogTitle>
              <AlertDialogDescription>
                سيتم أرشفة الكورس "{deleteTarget?.name}" وإخفاؤه من قائمة الكورسات الحالية.
                {deleteTarget && state?.archiveError && (
                  <span className="block mt-2 text-destructive" role="alert">
                    تعذّر الحذف: {state.archiveError}
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busyKind === 'archive'}>إلغاء</AlertDialogCancel>
              {/* A plain Button, not AlertDialogAction: the action must not
                  close the dialog itself — only a server-confirmed archive of
                  the current target may. */}
              <Button
                type="button"
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={busyKind === 'archive' || !deleteTarget}
              >
                {busyKind === 'archive' ? "جاري الحذف..." : "حذف"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
};

export default Courses;
