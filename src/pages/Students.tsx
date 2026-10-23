import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Users, Edit2, Trash2, Search, Phone, Mail } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getStudents, getGrades, getGroups, updateStudent, deleteStudent, deleteUserByStudentId, type Student } from "@/lib/api-http";

/**
 * Row shape returned by GET /students (server/src/routes/students.ts):
 * the students table columns (s.*) plus grade_name, group_name,
 * enrollment_date and the aggregated course_names CSV string.
 */
export interface StudentListItem extends Student {
  is_active?: boolean;
  created_at?: string;
  course_names?: string | null;
  enrollment_date?: string;
}

/**
 * is_offline arrives from MySQL as 0/1 at runtime even though the shared
 * Student type declares boolean; normalize before trust.
 */
export const isOfflineStudent = (value: unknown): boolean =>
  value === true || value === 1 || value === "1";

/** Search across the fields the students API actually returns. */
export const filterStudentsBySearch = (students: StudentListItem[], term: string): StudentListItem[] => {
  const needle = term.trim();
  if (!needle) return students;
  const lowerNeedle = needle.toLowerCase();
  return students.filter(student =>
    student.name?.toLowerCase().includes(lowerNeedle) ||
    student.email?.toLowerCase().includes(lowerNeedle) ||
    student.phone?.includes(needle) ||
    student.guardian_phone?.includes(needle)
  );
};

/** course_names is a comma-separated string produced by GROUP_CONCAT. */
export const splitCourseNames = (courseNames?: string | null): string[] =>
  courseNames ? String(courseNames).split(",").filter(Boolean) : [];

export interface StudentMutationDeps {
  updateStudent: (id: string, data: Record<string, unknown>) => Promise<boolean>;
  deleteStudent: (id: string) => Promise<boolean>;
  deleteUserByStudentId: (id: string) => Promise<boolean>;
  /** Server-authoritative refresh: only invoked after the server confirms success. */
  refresh: () => void | Promise<void>;
  notify: (kind: "success" | "error", title: string, description: string) => void;
}

export interface StudentMutationOutcome {
  ok: boolean;
}

export interface StudentMutationMessages {
  successTitle: string;
  successDescription: string;
  failureTitle: string;
  failureDescription: string;
}

/**
 * Mutation controller for the student management pages. Keeps the pages thin
 * and makes the outcomes testable: every mutation is single-flight (a repeat
 * click while a request for the same target is in flight reuses it instead of
 * issuing a duplicate request), the list is refreshed only after the server
 * confirms success, and failures are surfaced without mutating local state.
 * A failure of the post-success refresh does NOT invert the outcome: the
 * server already accepted the mutation, so the success is still reported
 * (the refresh failure is logged and left to the page's own fetch handling).
 */
export const createStudentMutationController = (deps: StudentMutationDeps) => {
  const inFlight = new Map<string, Promise<StudentMutationOutcome>>();

  const run = (key: string, op: () => Promise<StudentMutationOutcome>): Promise<StudentMutationOutcome> => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = op().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };

  const runMutation = (
    key: string,
    call: () => Promise<boolean>,
    messages: StudentMutationMessages
  ): Promise<StudentMutationOutcome> =>
    run(key, async () => {
      try {
        const ok = await call();
        if (!ok) {
          deps.notify("error", messages.failureTitle, messages.failureDescription);
          return { ok: false };
        }
        try {
          await deps.refresh();
        } catch (refreshError) {
          // The mutation was accepted by the server; a refresh failure must
          // not be reported as a failed mutation (it would keep the dialog
          // open and invite a duplicate retry). The page's own fetch error
          // handling surfaces the load problem.
          console.error('Error refreshing after mutation:', refreshError);
        }
        deps.notify("success", messages.successTitle, messages.successDescription);
        return { ok: true };
      } catch (error: unknown) {
        deps.notify(
          "error",
          messages.failureTitle,
          error instanceof Error ? error.message : messages.failureDescription
        );
        return { ok: false };
      }
    });

  return {
    update: (id: string, data: Record<string, unknown>, messages: StudentMutationMessages) =>
      runMutation(`update:${id}`, () => deps.updateStudent(id, data), messages),
    remove: (id: string, messages: StudentMutationMessages) =>
      runMutation(`delete:${id}`, () => deps.deleteStudent(id), messages),
    removeUser: (id: string, messages: StudentMutationMessages) =>
      runMutation(`delete-user:${id}`, () => deps.deleteUserByStudentId(id), messages),
  };
};

const EMPTY_FORM = {
  name: "",
  email: "",
  phone: "",
  guardian_phone: "",
  grade: "",
  grade_id: "",
  group_id: ""
};

type ConfirmableDelete = { kind: "student" | "user"; id: string } | null;

/**
 * Monotonic generation fence for a page load. A response may only commit while
 * it is still the newest one for its resource; `invalidate()` retires every
 * outstanding load (scope clear / unmount) without starting a replacement.
 */
export interface LoadSequence {
  begin(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export const createLoadSequence = (): LoadSequence => {
  let latest = 0;
  return {
    begin(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
    invalidate(): void {
      latest += 1;
    },
  };
};

interface SelectorResult<T> {
  ok: boolean;
  value: T | null;
}

async function settleSelector<T>(load: () => Promise<T>): Promise<SelectorResult<T>> {
  try {
    return { ok: true, value: (await load()) ?? null };
  } catch (error) {
    console.error('Error loading selector list:', error);
    return { ok: false, value: null };
  }
}

export interface StudentPageLoadPatch {
  students?: StudentListItem[];
  grades?: unknown[];
  groups?: unknown[];
  /** Independent error channels: the student list vs the required selectors. */
  errors: { students?: string | null; selectors?: string | null };
}

export interface StudentPageLoaderDeps {
  getStudents: () => Promise<StudentListItem[]>;
  getGrades: () => Promise<unknown[]>;
  getGroups: () => Promise<unknown[]>;
  /** Page filter: which rows belong on this page (online vs offline). */
  includes: (student: StudentListItem) => boolean;
  apply: (patch: StudentPageLoadPatch) => void;
}

/**
 * Production load lifecycle of the student list page.
 *
 * The student list and the selector lists (grades/groups) are fenced
 * SEPARATELY: a superseded load of either kind can never commit (so an older
 * response cannot restore pre-mutation rows after a successful refresh), and a
 * student refresh clears only the student-list error — a failed selector load
 * keeps its own error channel instead of being erased by an unrelated refresh.
 */
export const createStudentPageLoader = (deps: StudentPageLoaderDeps) => {
  const studentsSequence = createLoadSequence();
  const selectorsSequence = createLoadSequence();

  return {
    async loadStudents() {
      const token = studentsSequence.begin();
      try {
        const data = await deps.getStudents();
        if (!studentsSequence.isCurrent(token)) return; // superseded: never commit
        deps.apply({
          students: (data || []).filter(deps.includes),
          errors: { students: null },
        });
      } catch (error) {
        if (!studentsSequence.isCurrent(token)) return;
        console.error('Error fetching students:', error);
        deps.apply({ errors: { students: 'تعذر تحميل قائمة الطلاب' } });
      }
    },
    async loadSelectors() {
      const token = selectorsSequence.begin();
      const [grades, groups] = await Promise.all([
        settleSelector(deps.getGrades),
        settleSelector(deps.getGroups),
      ]);
      if (!selectorsSequence.isCurrent(token)) return;
      deps.apply({
        grades: grades.ok ? grades.value || [] : undefined,
        groups: groups.ok ? groups.value || [] : undefined,
        errors: { selectors: grades.ok && groups.ok ? null : 'تعذر تحميل الصفوف أو المجموعات' },
      });
    },
    invalidate() {
      studentsSequence.invalidate();
      selectorsSequence.invalidate();
    },
  };
};

const Students = () => {
  const currentRole = (() => { try { return JSON.parse(localStorage.getItem('currentUser') || '{}').role as string | undefined; } catch { return undefined; } })();
  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [groups, setGroups] = useState([]);
  const [grades, setGrades] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<StudentListItem | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectorError, setSelectorError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConfirmableDelete>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const applyStudentPatch = (patch: StudentPageLoadPatch) => {
    if (patch.students !== undefined) setStudents(patch.students);
    if (patch.groups !== undefined) setGroups(patch.groups as never[]);
    if (patch.grades !== undefined) setGrades(patch.grades as never[]);
    if (patch.errors.students !== undefined) setLoadError(patch.errors.students);
    if (patch.errors.selectors !== undefined) setSelectorError(patch.errors.selectors);
  };

  const pageLoader = useMemo(() => createStudentPageLoader({
    getStudents,
    getGrades,
    getGroups,
    includes: (student) => !isOfflineStudent(student.is_offline),
    apply: applyStudentPatch,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useEffect(() => {
    pageLoader.loadStudents();
    pageLoader.loadSelectors();
    // Scope clear / unmount: retire in-flight loads so a late response cannot
    // commit over the current state.
    return () => pageLoader.invalidate();
  }, [pageLoader]);

  const mutations = useMemo(() => createStudentMutationController({
    updateStudent,
    deleteStudent,
    deleteUserByStudentId,
    refresh: () => pageLoader.loadStudents(),
    notify: (kind, title, description) => toast({
      title,
      description,
      ...(kind === "error" ? { variant: "destructive" as const } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const filteredStudents = filterStudentsBySearch(students, searchTerm);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return; // ignore duplicate submits while a request is in flight
    setLoading(true);

    try {
      if (!editingStudent) {
        throw new Error("هذه الصفحة للتعديل فقط. الطلاب الأونلاين يسجلون من خلال صفحة التسجيل");
      }

      // Update student via Backend API
      const updateData: Record<string, unknown> = {
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        guardian_phone: formData.guardian_phone,
        grade: formData.grade,
        grade_id: formData.grade_id || null,
        group_id: formData.group_id || null,
      };

      const outcome = await mutations.update(editingStudent.id, updateData, {
        successTitle: "تم التحديث بنجاح",
        successDescription: "تم تحديث بيانات الطالب في قاعدة البيانات",
        failureTitle: "خطأ",
        failureDescription: "فشل تحديث بيانات الطالب",
      });

      if (!outcome.ok) return; // keep the dialog open with the entered form state

      setIsOpen(false);
      setEditingStudent(null);
      setFormData(EMPTY_FORM);
    } catch (error: unknown) {
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: error instanceof Error ? error.message : "حدث خطأ، حاول مرة أخرى",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (student: StudentListItem) => {
    setEditingStudent(student);
    setFormData({
      name: student.name,
      email: student.email || "",
      phone: student.phone || "",
      guardian_phone: student.guardian_phone || "",
      grade: student.grade || "",
      grade_id: student.grade_id || "",
      group_id: student.group_id || ""
    });
    setIsOpen(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { kind, id } = pendingDelete;
    const messages = kind === "user"
      ? {
        successTitle: "تم الحذف نهائياً",
        successDescription: "تم حذف الطالب نهارياً من users و students",
        failureTitle: "خطأ",
        failureDescription: "فشل الحذف النهائي",
      }
      : {
        successTitle: "تم الحذف بنجاح",
        successDescription: "تم حذف الطالب من قاعدة البيانات",
        failureTitle: "خطأ",
        failureDescription: "فشل حذف الطالب",
      };
    const outcome = kind === "user"
      ? await mutations.removeUser(id, messages)
      : await mutations.remove(id, messages);
    if (outcome.ok) setPendingDelete(null);
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Users className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة الطلاب الأونلاين</h1>
              <p className="text-muted-foreground">الطلاب الذين سجلوا عبر المنصة. للموافقة على طلبات التسجيل، انتقل إلى صفحة "طلبات التسجيل"</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>تعديل بيانات الطالب</DialogTitle>
                <DialogDescription>راجع بيانات الطالب والكورسات المرتبطة به.</DialogDescription>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم الطالب</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="أدخل اسم الطالب"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">البريد الإلكتروني</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                    placeholder="example@email.com"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">رقم الهاتف</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                    placeholder="01234567890"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="guardian_phone">رقم ولي الأمر</Label>
                  <Input
                    id="guardian_phone"
                    value={formData.guardian_phone}
                    onChange={(e) => setFormData(prev => ({ ...prev, guardian_phone: e.target.value }))}
                    placeholder="01234567890"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="grade">الصف الدراسي</Label>
                  <Select
                    value={formData.grade_id}
                    onValueChange={(value) => {
                      setFormData(prev => ({ ...prev, grade_id: value, group_id: '' }));
                    }}
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
                  <Label htmlFor="group">المجموعة</Label>
                  <Select
                    value={formData.group_id}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, group_id: value }))}
                    disabled={!formData.grade_id}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={!formData.grade_id ? "اختر الصف أولاً" : "اختر المجموعة"} />
                    </SelectTrigger>
                    <SelectContent>
                      {groups
                        .filter(group => !formData.grade_id || group.grade_id === formData.grade_id)
                        .map((group) => (
                          <SelectItem key={group.id} value={group.id}>
                            {group.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {formData.grade_id && groups.filter(g => g.grade_id === formData.grade_id).length === 0 && (
                    <p className="text-xs text-muted-foreground">لا توجد مجموعات متاحة لهذا الصف</p>
                  )}
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري المعالجة..." : "تحديث البيانات"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>تأكيد الحذف</DialogTitle>
                <DialogDescription>
                  {pendingDelete?.kind === "user"
                    ? "سيتم حذف الطالب نهائياً من users و students. لا يمكن التراجع عن هذه العملية."
                    : "سيتم حذف الطالب من قائمة students. هل تريد المتابعة؟"}
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setPendingDelete(null)}>
                  إلغاء
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={confirmDelete}
                >
                  تأكيد الحذف
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="shadow-soft">
          <CardHeader className="space-y-3">
            <CardTitle className="text-lg md:text-xl">قائمة الطلاب</CardTitle>
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <Input
                placeholder="البحث عن طالب..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full"
              />
            </div>
          </CardHeader>
          <CardContent className="p-4">
            {loadError && (
              <div role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {loadError}
              </div>
            )}
            {selectorError && (
              <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-400">
                {selectorError}
              </div>
            )}
            {loadError ? null : filteredStudents.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا يوجد طلاب أونلاين حالياً</p>
              </div>
            ) : (
            <div className="space-y-4">
              {filteredStudents.map((student) => {
                const courseNames = splitCourseNames(student.course_names);
                const joinDateSource = student.enrollment_date || student.created_at;
                let joinDateDisplay = '-';
                if (joinDateSource) {
                  const d = new Date(joinDateSource);
                  if (!isNaN(d.getTime())) {
                    // Use Gregorian calendar with Arabic (Egypt) locale for numeric date
                    try {
                      joinDateDisplay = d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'numeric', day: 'numeric' });
                    } catch (_) {
                      joinDateDisplay = d.toLocaleDateString('en-GB');
                    }
                  }
                }
                const gradeDisplay = student.grade_name || student.grade || '-';
                const groupDisplay = student.group_name || '-';
                return (
                  <div
                    key={student.id}
                    className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                  >
                    <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10 border-2 border-white">
                          <AvatarFallback className="text-xs bg-white text-cyan-600">{getInitials(student.name)}</AvatarFallback>
                        </Avatar>
                        <div>
                          <h3 className="font-bold text-white text-lg">{student.name}</h3>
                          <div className="flex items-center gap-2 text-xs text-cyan-50">
                            <Mail className="w-3 h-3" />
                            <span>{student.email}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(student)}
                          className="h-8 w-8 p-0 text-white hover:bg-white/20"
                          aria-label="تعديل بيانات الطالب"
                          title="تعديل بيانات الطالب"
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDelete({ kind: "student", id: student.id })}
                          className="h-8 w-8 p-0 text-white hover:bg-red-500/30"
                          aria-label="حذف من students"
                          title="حذف من students"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDelete({ kind: "user", id: student.id })}
                          className="h-8 w-8 p-0 bg-red-600/90 text-white hover:bg-red-700 border-2 border-red-800 shadow-lg"
                          aria-label="حذف نهائي من users"
                          title="⚠️ حذف نهائي من users"
                        >
                          <Trash2 className="w-4 h-4 font-bold" />
                        </Button>
                      </div>
                    </div>

                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📱 رقم الهاتف</div>
                        <div className="text-sm font-medium flex items-center gap-2">
                          <Phone className="w-3 h-3 text-muted-foreground" />
                          {student.phone || '-'}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">👨‍👩‍👦 رقم ولي الأمر</div>
                        <div className="text-sm font-medium flex items-center gap-2">
                          <Phone className="w-3 h-3 text-muted-foreground" />
                          {student.guardian_phone || '-'}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">🎓 المرحلة</div>
                        <div className="text-sm font-medium">{gradeDisplay}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">👥 المجموعة</div>
                        <div className="text-sm font-medium">{groupDisplay}</div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📅 تاريخ الانضمام</div>
                        <div className="text-sm font-medium">{joinDateDisplay}</div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📚 الكورسات</div>
                        <div className="flex flex-wrap gap-1">
                          {courseNames.length > 0 ? (
                            courseNames.map((cName) => (
                              <span key={cName} className="px-2 py-1 bg-primary/10 text-primary rounded text-xs font-medium">
                                {cName}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">لا توجد كورسات</span>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">⚡ الحالة</div>
                        <span className={`px-3 py-1 rounded-full text-xs font-semibold inline-flex items-center gap-1 ${student.is_active
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                          : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'
                          }`}>
                          {student.is_active ? '✓ نشط' : '⚠ غير نشط'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Students;
