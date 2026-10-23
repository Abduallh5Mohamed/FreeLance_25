import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { getGrades, getStudents, type Grade } from '@/lib/api';
import {
  GROUP_SCHEDULE_DAYS,
  GROUP_SCHEDULE_DAY_LABELS,
  createProductionGroupScheduleController,
} from '@/features/groups/group-schedules';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  createProductionGroupAnnouncementController,
} from '@/features/groups/group-announcements';
import { useToast } from '@/hooks/use-toast';
import { Plus, Edit, Trash2, Users, Search, Phone, Mail, Eye, Megaphone } from 'lucide-react';

interface Student {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  guardian_phone?: string;
  grade?: string;
  grade_id?: string;
  group_id?: string;
  grade_name?: string;
  group_name?: string;
  barcode?: string;
  is_active?: boolean;
}

const Groups = () => {
  /**
   * M2-19: the whole group/schedule lifecycle runs through the injected
   * production seam in `src/features/groups/group-schedules.ts` — one bounded
   * list read, strict canonical weekday/time form, duplicate-submit blocking,
   * retained retryable drafts, denied/not-found cleanup and the session, scope,
   * form, target and dispose fences. The page only renders.
   */
  const controller = useMemo(() => createProductionGroupScheduleController(), []);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);

  /**
   * M2-21: the private group-announcement panel runs through its own injected
   * production seam in `src/features/groups/group-announcements.ts` — one
   * bounded page per owned group, a bounded "next page" only when the server
   * minted a cursor, strict canonical create/edit/publish/retract, duplicate
   * blocking, retained drafts and the session, principal, selection, list,
   * form, target and dispose fences. The page only renders.
   */
  const announcementController = useMemo(
    () => createProductionGroupAnnouncementController(),
    [],
  );
  const announcementState = useSyncExternalStore(
    announcementController.subscribe,
    announcementController.getState,
  );

  const [students, setStudents] = useState<Student[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [booted, setBooted] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let alive = true;
    controller.load().finally(() => { if (alive) setBooted(true); });
    return () => { alive = false; };
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => () => announcementController.dispose(), [announcementController]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await getGrades();
        if (alive) setGrades(data);
      } catch (error) {
        console.error('Error fetching grades:', error);
      }
      try {
        const data = await getStudents();
        if (alive) setStudents(data || []);
      } catch (error) {
        console.error('Error fetching students:', error);
      }
    })();
    return () => { alive = false; };
  }, []);

  const form = state.form;
  const isDialogOpen = form.mode !== 'closed';
  const isEditing = form.mode === 'edit';
  const selectedGroup = selectedGroupId
    ? state.rows.find((row) => row.id === selectedGroupId) ?? null
    : null;
  const isStudentsDialogOpen = selectedGroup !== null;
  const saving = state.mutation.status === 'saving';
  const retryable = state.phase === 'error' || state.phase === 'unauthorized';

  const announcementForm = announcementState.form;
  const announcementSaving = announcementState.mutation.status === 'saving';
  const isAnnouncementsOpen = announcementState.groupId !== null;
  const announcementsGroup = announcementState.groupId
    ? state.rows.find((row) => row.id === announcementState.groupId) ?? null
    : null;
  const announcementRetryable =
    announcementState.phase === 'error' || announcementState.phase === 'unauthorized';

  const gradeNameOf = (gradeId: string | null) =>
    grades.find((grade) => grade.id === gradeId)?.name || '-';

  const handleViewStudents = (groupId: string) => {
    setSelectedGroupId(groupId);
    setSearchTerm('');
  };

  const getGroupStudents = () => {
    if (!selectedGroup) return [];
    return students.filter((student) => student.group_id === selectedGroup.id);
  };

  const getFilteredStudents = () => {
    const groupStudents = getGroupStudents();
    if (!searchTerm.trim()) return groupStudents;

    const search = searchTerm.toLowerCase().trim();
    return groupStudents.filter((student) =>
      student.name?.toLowerCase().includes(search) ||
      student.phone?.toLowerCase().includes(search) ||
      student.email?.toLowerCase().includes(search),
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const outcome = await controller.save();
    const settled = controller.getState();

    if (outcome === 'confirmed') {
      toast({
        title: 'نجح',
        description: isEditing ? 'تم تحديث المجموعة بنجاح' : 'تم إضافة المجموعة بنجاح',
      });
      return;
    }
    if (outcome === 'invalid') {
      // The form keeps the user's input and shows the local validation error.
      return;
    }
    if (outcome === 'blocked' || outcome === 'idle') return;

    toast({
      title: 'خطأ',
      description: settled.mutation.notice || settled.mutation.error || 'فشل في حفظ المجموعة',
      variant: 'destructive',
    });
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('هل أنت متأكد من حذف هذه المجموعة؟')) return;

    const outcome = await controller.remove(id);
    const settled = controller.getState();
    if (outcome === 'confirmed') {
      toast({ title: 'نجح', description: 'تم حذف المجموعة بنجاح' });
      return;
    }
    if (outcome === 'blocked' || outcome === 'idle') return;
    toast({
      title: 'خطأ',
      description: settled.mutation.notice || settled.mutation.error || 'فشل في حذف المجموعة',
      variant: 'destructive',
    });
  };

  const toggleGroupStatus = async (groupId: string, isActive: boolean) => {
    const outcome = await controller.setActive(groupId, !isActive);
    const settled = controller.getState();
    if (outcome === 'confirmed') {
      toast({
        title: 'نجح',
        description: isActive ? 'تم إغلاق المجموعة' : 'تم فتح المجموعة',
      });
      return;
    }
    if (outcome === 'blocked' || outcome === 'idle') return;
    toast({
      title: 'خطأ',
      description: settled.mutation.notice || settled.mutation.error || 'فشل في تحديث حالة المجموعة',
      variant: 'destructive',
    });
  };

  const handleOpenAnnouncements = (groupId: string) => {
    void announcementController.select(groupId);
  };

  const handleAnnouncementSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const outcome = await announcementController.save();
    const settled = announcementController.getState();
    if (outcome === 'confirmed') {
      toast({
        title: 'نجح',
        description: announcementForm.mode === 'edit'
          ? 'تم تحديث الإعلان بنجاح'
          : 'تم إضافة الإعلان بنجاح',
      });
      return;
    }
    if (outcome === 'unchanged') {
      toast({ title: 'لا تغيير', description: settled.mutation.notice || 'لم يتغيّر شيء.' });
      return;
    }
    if (outcome === 'invalid') {
      // The form keeps the instructor's input and shows the local validation error.
      return;
    }
    if (outcome === 'blocked' || outcome === 'idle') return;

    toast({
      title: 'خطأ',
      description: settled.mutation.notice || settled.mutation.error || 'فشل في حفظ الإعلان',
      variant: 'destructive',
    });
  };

  const handleAnnouncementPublish = async (announcementId: string) => {
    const outcome = await announcementController.publish(announcementId);
    const settled = announcementController.getState();
    if (outcome === 'confirmed') {
      toast({ title: 'نجح', description: settled.mutation.notice || 'تم نشر الإعلان.' });
      return;
    }
    if (outcome === 'blocked' || outcome === 'idle' || outcome === 'unchanged') return;
    toast({
      title: 'خطأ',
      description: settled.mutation.notice || settled.mutation.error || 'فشل في نشر الإعلان',
      variant: 'destructive',
    });
  };

  const handleAnnouncementRetract = async (announcementId: string) => {
    if (!window.confirm('هل أنت متأكد من سحب هذا الإعلان؟ لا يمكن التراجع عن السحب.')) return;

    const outcome = await announcementController.retract(announcementId);
    const settled = announcementController.getState();
    if (outcome === 'confirmed') {
      toast({ title: 'نجح', description: settled.mutation.notice || 'تم سحب الإعلان.' });
      return;
    }
    if (outcome === 'blocked' || outcome === 'idle' || outcome === 'unchanged') return;
    toast({
      title: 'خطأ',
      description: settled.mutation.notice || settled.mutation.error || 'فشل في سحب الإعلان',
      variant: 'destructive',
    });
  };

  const announcementStateLabel = (value: string) =>
    value === 'published' ? 'منشور' : value === 'retracted' ? 'مسحوب' : 'مسودة';

  if (!booted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="text-center">جاري التحميل...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Users className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة المجموعات</h1>
              <p className="text-muted-foreground">إنشاء وإدارة المجموعات الدراسية</p>
            </div>
          </div>

          <Button
            onClick={() => controller.openCreate()}
            disabled={saving || (state.phase !== 'ready' && state.phase !== 'empty')}
          >
            <Plus className="w-4 h-4 ml-2" />
            إضافة مجموعة جديدة
          </Button>
        </div>

        {state.phase === 'denied' && (
          <div role="alert" className="mb-4 rounded bg-red-50 p-3 text-red-700">
            {state.error || 'لا تملك صلاحية إدارة المجموعات في هذه المساحة.'}
          </div>
        )}

        {state.phase === 'no-workspace' && (
          <div role="alert" className="mb-4 rounded bg-amber-50 p-3 text-amber-800">
            {state.error || 'لم يتم تحديد مساحة عمل. اختر مساحة المدرس أولاً.'}
          </div>
        )}

        {retryable && (
          <div className="mb-4 space-y-3">
            <p role="alert" className="rounded bg-red-50 p-3 text-red-700">
              {state.error || 'فشل في تحميل المجموعات'}
            </p>
            <Button type="button" variant="outline" onClick={() => controller.refresh()}>
              إعادة المحاولة
            </Button>
          </div>
        )}

        {state.mutation.status === 'uncertain' && state.mutation.notice && (
          <div role="status" className="mb-4 rounded bg-amber-50 p-3 text-amber-800">
            {state.mutation.notice}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>قائمة المجموعات</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {state.rows.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد مجموعات حالياً</p>
              </div>
            ) : (
              <div className="space-y-4">
                {state.rows.map((group) => (
                  <div
                    key={group.id}
                    className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                  >
                    <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10 border-2 border-white">
                          <AvatarFallback className="text-xs bg-white text-cyan-600">
                            <Users className="w-5 h-5" />
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <h3 className="font-bold text-white text-lg">{group.name}</h3>
                          <div className="flex items-center gap-2 text-xs text-cyan-50">
                            {group.grade_id && <span>📚 {gradeNameOf(group.grade_id)}</span>}
                            {!group.is_active && <span>⚠ مجموعة مغلقة</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleGroupStatus(group.id, group.is_active)}
                          disabled={saving}
                          className="h-8 px-2 text-white hover:bg-white/20"
                        >
                          {group.is_active ? 'إغلاق' : 'فتح'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenAnnouncements(group.id)}
                          disabled={saving || announcementSaving}
                          className="h-8 px-2 text-white hover:bg-white/20"
                          title="إعلانات المجموعة"
                        >
                          <Megaphone className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => controller.openEdit(group.id)}
                          disabled={saving}
                          className="h-8 w-8 p-0 text-white hover:bg-white/20"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(group.id)}
                          disabled={saving}
                          className="h-8 w-8 p-0 text-white hover:bg-red-500/30"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📝 الوصف</div>
                        <div className="text-sm font-medium">{group.description || '-'}</div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">🎓 الصف الدراسي</div>
                        <div className="text-sm font-medium">{gradeNameOf(group.grade_id)}</div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">👥 النوع</div>
                        <Badge variant="secondary" className="text-xs">مجموعة دراسية</Badge>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">👨‍🎓 عدد الطلاب</div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-medium">
                            {students.filter((student) => student.group_id === group.id).length} / {group.max_students}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewStudents(group.id)}
                            className="h-7 text-xs"
                          >
                            <Eye className="w-3 h-3 ml-1" />
                            عرض الطلاب
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="px-4 pb-4">
                      <div className="border-t pt-3 flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-xs font-semibold text-cyan-600 dark:text-cyan-400">🗓️ الموعد الأسبوعي</span>
                        {group.schedule_days.length === 0 && !group.schedule_time ? (
                          <span className="text-muted-foreground">غير محدد</span>
                        ) : (
                          <>
                            {group.schedule_days.map((day) => (
                              <Badge key={day} variant="outline" className="text-xs">
                                {GROUP_SCHEDULE_DAY_LABELS[day]}
                              </Badge>
                            ))}
                            {group.schedule_time && (
                              <span className="font-mono text-xs text-cyan-900 dark:text-cyan-100" dir="ltr">
                                {group.schedule_time}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) controller.cancel(); }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {isEditing ? 'تعديل المجموعة' : 'إضافة مجموعة جديدة'}
              </DialogTitle>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم المجموعة</Label>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(e) => controller.setField({ name: e.target.value })}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="grade">الصف الدراسي</Label>
                  <Select
                    value={form.gradeId}
                    onValueChange={(value) => controller.setField({ gradeId: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="اختر الصف" />
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
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">الوصف</Label>
                <Textarea
                  id="description"
                  value={form.description}
                  onChange={(e) => controller.setField({ description: e.target.value })}
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="max_students">الحد الأقصى للطلاب</Label>
                  <Input
                    id="max_students"
                    type="number"
                    value={form.maxStudents}
                    onChange={(e) => controller.setField({ maxStudents: e.target.value })}
                    min="1"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="schedule_time">وقت المجموعة (اختياري)</Label>
                  <Input
                    id="schedule_time"
                    type="time"
                    value={form.time}
                    onChange={(e) => controller.setField({ time: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>أيام الأسبوع (اختياري)</Label>
                <div className="grid grid-cols-4 gap-2">
                  {GROUP_SCHEDULE_DAYS.map((day) => {
                    const checked = form.days.includes(day);
                    return (
                      <label key={day} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => controller.toggleDay(day)}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">{GROUP_SCHEDULE_DAY_LABELS[day]}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {form.error && (
                <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
                  {form.error}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" onClick={() => controller.cancel()} disabled={saving}>
                  إلغاء
                </Button>
                <Button type="submit" disabled={saving}>
                  {isEditing ? 'تحديث' : 'إضافة'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Announcements Dialog — the private M2-21 management surface */}
        <Dialog
          open={isAnnouncementsOpen}
          onOpenChange={(open) => { if (!open) void announcementController.select(null); }}
        >
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Megaphone className="w-5 h-5 text-primary" />
                إعلانات مجموعة: {announcementsGroup?.name ?? ''}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                إعلانات خاصة تُدار من هذه الشاشة فقط. لا يُرسل أي بريد أو رسالة أو تنبيه، ولا
                يوجد جدولة نشر أو انتهاء صلاحية.
              </p>

              {announcementState.phase === 'denied' && (
                <div role="alert" className="rounded bg-red-50 p-3 text-red-700">
                  {announcementState.error || 'لا تملك صلاحية إدارة إعلانات هذه المجموعة.'}
                </div>
              )}

              {announcementState.phase === 'no-workspace' && (
                <div role="alert" className="rounded bg-amber-50 p-3 text-amber-800">
                  {announcementState.error || 'لم يتم تحديد مساحة عمل. اختر مساحة المدرس أولاً.'}
                </div>
              )}

              {announcementRetryable && announcementState.phase !== 'denied' && announcementState.phase !== 'no-workspace' && (
                <div className="space-y-3">
                  <p role="alert" className="rounded bg-red-50 p-3 text-red-700">
                    {announcementState.error || 'فشل في تحميل الإعلانات'}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void announcementController.refresh()}
                  >
                    إعادة المحاولة
                  </Button>
                </div>
              )}

              {announcementState.mutation.status === 'uncertain' && announcementState.mutation.notice && (
                <div role="status" className="rounded bg-amber-50 p-3 text-amber-800">
                  {announcementState.mutation.notice}
                </div>
              )}

              {announcementState.mutation.status !== 'uncertain' && announcementState.mutation.notice && (
                <div role="status" className="rounded bg-emerald-50 p-3 text-emerald-800">
                  {announcementState.mutation.notice}
                </div>
              )}

              {announcementState.phase === 'loading' && (
                <div className="text-center py-6 text-muted-foreground">جاري تحميل الإعلانات...</div>
              )}

              {(announcementState.phase === 'ready' || announcementState.phase === 'empty') && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    onClick={() => announcementController.openCreate()}
                    disabled={announcementSaving || announcementForm.mode !== 'closed'}
                  >
                    <Plus className="w-4 h-4 ml-2" />
                    إعلان جديد
                  </Button>
                </div>
              )}

              {announcementState.phase === 'empty' && (
                <div className="text-center py-8 text-muted-foreground">
                  <Megaphone className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>لا توجد إعلانات لهذه المجموعة.</p>
                </div>
              )}

              {announcementState.rows.length > 0 && (
                <div className="space-y-3">
                  {announcementState.rows.map((announcement) => (
                    <div
                      key={announcement.id}
                      className="border border-cyan-200 dark:border-cyan-800 rounded-lg p-4 bg-white dark:bg-slate-900"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="font-bold text-foreground truncate">{announcement.title}</h4>
                            <Badge
                              variant={announcement.state === 'published' ? 'default' : 'secondary'}
                              className="text-xs"
                            >
                              {announcementStateLabel(announcement.state)}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm whitespace-pre-wrap break-words text-muted-foreground">
                            {announcement.body}
                          </p>
                          <div className="mt-2 text-xs text-muted-foreground" dir="ltr">
                            {announcement.updated_at ?? announcement.created_at ?? ''}
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 flex-col gap-2">
                          {announcement.state !== 'retracted' && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => announcementController.openEdit(announcement.id)}
                              disabled={announcementSaving || announcementForm.mode !== 'closed'}
                            >
                              <Edit className="w-3 h-3 ml-1" />
                              تعديل
                            </Button>
                          )}
                          {announcement.state === 'draft' && (
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void handleAnnouncementPublish(announcement.id)}
                              disabled={announcementSaving}
                            >
                              نشر
                            </Button>
                          )}
                          {announcement.state !== 'retracted' && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => void handleAnnouncementRetract(announcement.id)}
                              disabled={announcementSaving}
                              className="text-red-600 hover:bg-red-50"
                            >
                              سحب
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {announcementState.nextCursor !== null && (
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void announcementController.loadMore()}
                    disabled={announcementState.loadingMore || announcementSaving}
                  >
                    {announcementState.loadingMore ? 'جاري التحميل...' : 'تحميل المزيد'}
                  </Button>
                </div>
              )}

              {announcementForm.mode !== 'closed' && (
                <form onSubmit={handleAnnouncementSubmit} className="space-y-3 border-t pt-4">
                  <div className="space-y-2">
                    <Label htmlFor="announcement_title">عنوان الإعلان</Label>
                    <Input
                      id="announcement_title"
                      value={announcementForm.title}
                      onChange={(e) => announcementController.setField({ title: e.target.value })}
                      maxLength={ANNOUNCEMENT_TITLE_MAX}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="announcement_body">نص الإعلان</Label>
                    <Textarea
                      id="announcement_body"
                      value={announcementForm.body}
                      onChange={(e) => announcementController.setField({ body: e.target.value })}
                      rows={5}
                      maxLength={ANNOUNCEMENT_BODY_MAX}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="announcement_state">الحالة</Label>
                    <Select
                      value={announcementForm.state}
                      onValueChange={(value) =>
                        announcementController.setField({ state: value as 'draft' | 'published' })}
                    >
                      <SelectTrigger id="announcement_state">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="draft">مسودة</SelectItem>
                        <SelectItem value="published">منشور</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      السحب إجراء منفصل ونهائي ولا يمكن التراجع عنه.
                    </p>
                  </div>

                  {announcementForm.error && (
                    <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">
                      {announcementForm.error}
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => announcementController.cancel()}
                      disabled={announcementSaving}
                    >
                      إلغاء
                    </Button>
                    <Button type="submit" disabled={announcementSaving}>
                      {announcementForm.mode === 'edit' ? 'تحديث' : 'إضافة'}
                    </Button>
                  </div>
                </form>
              )}

              <div className="flex justify-end pt-4 border-t">
                <Button variant="outline" onClick={() => void announcementController.select(null)}>
                  إغلاق
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Students Dialog */}
        <Dialog open={isStudentsDialogOpen} onOpenChange={(open) => { if (!open) setSelectedGroupId(null); }}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-primary" />
                طلاب مجموعة: {selectedGroup?.name}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Search Box */}
              <div className="flex items-center gap-2 bg-muted/50 rounded-lg px-3 py-2">
                <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <Input
                  placeholder="ابحث بالاسم أو رقم الهاتف..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
                />
              </div>

              {/* Students Count */}
              <div className="flex items-center justify-between px-2">
                <div className="text-sm text-muted-foreground">
                  عدد الطلاب: <span className="font-bold text-foreground">{getFilteredStudents().length}</span>
                  {searchTerm && ` من أصل ${getGroupStudents().length}`}
                </div>
                <Badge variant="secondary">
                  {getGroupStudents().length} / {selectedGroup?.max_students}
                </Badge>
              </div>

              {/* Students List */}
              <div className="space-y-3">
                {getFilteredStudents().length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Users className="w-16 h-16 mx-auto mb-4 opacity-20" />
                    <p className="text-lg font-medium">
                      {searchTerm ? 'لا توجد نتائج للبحث' : 'لا يوجد طلاب في هذه المجموعة'}
                    </p>
                  </div>
                ) : (
                  getFilteredStudents().map((student) => (
                    <div
                      key={student.id}
                      className="border-2 border-cyan-100 dark:border-cyan-900 rounded-xl overflow-hidden hover:shadow-lg transition-all duration-300 bg-white dark:bg-slate-900 hover:border-cyan-300 dark:hover:border-cyan-700"
                    >
                      {/* Header */}
                      <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-12 w-12 border-3 border-white shadow-lg">
                            <AvatarFallback className="bg-white text-cyan-600 font-bold text-lg">
                              {student.name?.charAt(0) || '؟'}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1">
                            <h4 className="text-white font-bold text-base">{student.name}</h4>
                            <div className="flex items-center gap-2 mt-1">
                              {student.grade_name && (
                                <Badge variant="secondary" className="bg-white/20 text-white border-0 text-xs">
                                  🎓 {student.grade_name}
                                </Badge>
                              )}
                              <Badge variant={student.is_active ? 'default' : 'secondary'} className="bg-white/20 text-white border-0 text-xs">
                                {student.is_active ? '✓ نشط' : '⚠ غير نشط'}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Content */}
                      <div className="p-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {student.phone && (
                            <div className="flex items-start gap-3 p-3 bg-cyan-50 dark:bg-cyan-950/30 rounded-lg">
                              <div className="w-8 h-8 bg-cyan-100 dark:bg-cyan-900 rounded-full flex items-center justify-center flex-shrink-0">
                                <Phone className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-cyan-700 dark:text-cyan-400 mb-1">
                                  رقم الطالب
                                </div>
                                <div className="text-sm font-bold text-cyan-900 dark:text-cyan-100 font-mono" dir="ltr">
                                  {student.phone}
                                </div>
                              </div>
                            </div>
                          )}

                          {student.guardian_phone && (
                            <div className="flex items-start gap-3 p-3 bg-green-50 dark:bg-green-950/30 rounded-lg">
                              <div className="w-8 h-8 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center flex-shrink-0">
                                <Phone className="w-4 h-4 text-green-600 dark:text-green-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-green-700 dark:text-green-400 mb-1">
                                  رقم ولي الأمر
                                </div>
                                <div className="text-sm font-bold text-green-900 dark:text-green-100 font-mono" dir="ltr">
                                  {student.guardian_phone}
                                </div>
                              </div>
                            </div>
                          )}

                          {student.email && (
                            <div className="flex items-start gap-3 p-3 bg-purple-50 dark:bg-purple-950/30 rounded-lg col-span-1 md:col-span-2">
                              <div className="w-8 h-8 bg-purple-100 dark:bg-purple-900 rounded-full flex items-center justify-center flex-shrink-0">
                                <Mail className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-purple-700 dark:text-purple-400 mb-1">
                                  البريد الإلكتروني
                                </div>
                                <div className="text-sm font-medium text-purple-900 dark:text-purple-100 truncate">
                                  {student.email}
                                </div>
                              </div>
                            </div>
                          )}

                          {student.barcode && (
                            <div className="flex items-start gap-3 p-3 bg-orange-50 dark:bg-orange-950/30 rounded-lg col-span-1 md:col-span-2">
                              <div className="w-8 h-8 bg-orange-100 dark:bg-orange-900 rounded-full flex items-center justify-center flex-shrink-0">
                                <span className="text-sm">🔖</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-orange-700 dark:text-orange-400 mb-1">
                                  الباركود
                                </div>
                                <div className="text-sm font-mono font-bold text-orange-900 dark:text-orange-100">
                                  {student.barcode}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end pt-4 border-t">
                <Button variant="outline" onClick={() => setSelectedGroupId(null)}>
                  إغلاق
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default Groups;
