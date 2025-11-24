import React, { useState, useEffect } from 'react';
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
import { getGroups, getGrades, createGroup, updateGroup, deleteGroup, getStudents, type Group as APIGroup, type Grade as APIGrade } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Plus, Edit, Trash2, Users, Search, Phone, Mail, Eye } from 'lucide-react';

interface Group {
  id: string;
  name: string;
  description?: string;
  max_students?: number;
  current_students?: number;
  is_active: boolean;
  course_id?: string;
  grade_id?: string;
  grade_name?: string;
  schedule_days?: string[] | string | null;
  schedule_time?: string | null;
}

interface Grade {
  id: string;
  name: string;
  display_order: number;
  is_active: boolean;
}

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
  const [groups, setGroups] = useState<Group[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isStudentsDialogOpen, setIsStudentsDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<Group | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    grade_id: '',
    max_students: 50,
    schedule_days: [] as string[],
    schedule_time: '' as string
  });

  useEffect(() => {
    fetchGroups();
    fetchGrades();
    fetchStudents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchGroups = async () => {
    try {
      const data = await getGroups();
      // Fetch grade names for each group
      const gradesData = await getGrades();
      const groupsWithGrades = data.map(group => ({
        ...group,
        grade_name: gradesData.find(g => g.id === group.grade_id)?.name || '-'
      }));
      setGroups(groupsWithGrades);
    } catch (error) {
      console.error('Error fetching groups:', error);
      toast({
        title: "خطأ",
        description: "فشل في تحميل المجموعات",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchStudents = async () => {
    try {
      const data = await getStudents();
      setStudents(data || []);
    } catch (error) {
      console.error('Error fetching students:', error);
    }
  };

  const handleViewStudents = (group: Group) => {
    setSelectedGroup(group);
    setSearchTerm('');
    setIsStudentsDialogOpen(true);
  };

  const getGroupStudents = () => {
    if (!selectedGroup) return [];
    return students.filter(s => s.group_id === selectedGroup.id);
  };

  const getFilteredStudents = () => {
    const groupStudents = getGroupStudents();
    if (!searchTerm.trim()) return groupStudents;

    const search = searchTerm.toLowerCase().trim();
    return groupStudents.filter(student =>
      student.name?.toLowerCase().includes(search) ||
      student.phone?.toLowerCase().includes(search) ||
      student.email?.toLowerCase().includes(search)
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const groupData = {
        name: formData.name,
        description: formData.description,
        grade_id: formData.grade_id || undefined,
        max_students: formData.max_students,
        is_active: true,
        schedule_days: formData.schedule_days.length > 0 ? formData.schedule_days : undefined,
        schedule_time: formData.schedule_time || undefined
      };

      if (isEditing && currentGroup) {
        await updateGroup(currentGroup.id, groupData);
      } else {
        await createGroup(groupData);
      }

      toast({
        title: "نجح",
        description: isEditing ? "تم تحديث المجموعة بنجاح" : "تم إضافة المجموعة بنجاح",
      });

      setIsDialogOpen(false);
      resetForm();
      fetchGroups();
    } catch (error) {
      console.error('Error saving group:', error);
      toast({
        title: "خطأ",
        description: "فشل في حفظ المجموعة",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (group: Group) => {
    setCurrentGroup(group);
    let parsedDays: string[] = [];
    if (group.schedule_days) {
      if (typeof group.schedule_days === 'string') {
        try {
          parsedDays = JSON.parse(group.schedule_days);
        } catch {
          parsedDays = [];
        }
      } else if (Array.isArray(group.schedule_days)) {
        parsedDays = group.schedule_days;
      }
    }
    setFormData({
      name: group.name,
      description: group.description || '',
      grade_id: group.grade_id || '',
      max_students: group.max_students || 50,
      schedule_days: parsedDays,
      schedule_time: group.schedule_time || ''
    });
    setIsEditing(true);
    setIsDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('هل أنت متأكد من حذف هذه المجموعة؟')) return;

    try {
      await deleteGroup(id);

      toast({
        title: "نجح",
        description: "تم حذف المجموعة بنجاح",
      });

      fetchGroups();
    } catch (error) {
      console.error('Error deleting group:', error);
      toast({
        title: "خطأ",
        description: "فشل في حذف المجموعة",
        variant: "destructive",
      });
    }
  };

  const toggleGroupStatus = async (group: Group) => {
    try {
      await updateGroup(group.id, { is_active: !group.is_active });

      toast({
        title: "نجح",
        description: group.is_active ? "تم إغلاق المجموعة" : "تم فتح المجموعة",
      });

      fetchGroups();
    } catch (error) {
      toast({
        title: "خطأ",
        description: "فشل في تحديث حالة المجموعة",
        variant: "destructive",
      });
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      grade_id: '',
      max_students: 50,
      schedule_days: [],
      schedule_time: ''
    });
    setIsEditing(false);
    setCurrentGroup(null);
  };

  if (loading) {
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

          <Button onClick={() => {
            resetForm();
            setIsDialogOpen(true);
          }}>
            <Plus className="w-4 h-4 ml-2" />
            إضافة مجموعة جديدة
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>قائمة المجموعات</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {groups.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد مجموعات حالياً</p>
              </div>
            ) : (
              <div className="space-y-4">
                {groups.map((group) => (
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
                            {group.grade_name && (
                              <span>📚 {group.grade_name}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(group)}
                          className="h-8 w-8 p-0 text-white hover:bg-white/20"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(group.id)}
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
                        <div className="text-sm font-medium">{group.grade_name || '-'}</div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">👥 النوع</div>
                        <Badge variant="secondary" className="text-xs">مجموعة دراسية</Badge>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">👨‍🎓 عدد الطلاب</div>
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-medium">
                            {students.filter(s => s.group_id === group.id).length} / {group.max_students || 50}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleViewStudents(group)}
                            className="h-7 text-xs"
                          >
                            <Eye className="w-3 h-3 ml-1" />
                            عرض الطلاب
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
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
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="grade">الصف الدراسي</Label>
                  <Select
                    value={formData.grade_id}
                    onValueChange={(value) => setFormData(prev => ({ ...prev, grade_id: value }))}
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
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="max_students">الحد الأقصى للطلاب</Label>
                  <Input
                    id="max_students"
                    type="number"
                    value={formData.max_students}
                    onChange={(e) => setFormData(prev => ({ ...prev, max_students: parseInt(e.target.value) }))}
                    min="1"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="schedule_time">وقت المجموعة (اختياري)</Label>
                  <Input
                    id="schedule_time"
                    type="time"
                    value={formData.schedule_time}
                    onChange={(e) => setFormData(prev => ({ ...prev, schedule_time: e.target.value }))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>أيام الأسبوع (اختياري)</Label>
                <div className="grid grid-cols-4 gap-2">
                  {['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'].map((day) => {
                    const label = {
                      sat: 'السبت',
                      sun: 'الأحد',
                      mon: 'الاثنين',
                      tue: 'الثلاثاء',
                      wed: 'الأربعاء',
                      thu: 'الخميس',
                      fri: 'الجمعة'
                    }[day];
                    const checked = formData.schedule_days.includes(day);
                    return (
                      <label key={day} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const newDays = e.target.checked
                              ? [...formData.schedule_days, day]
                              : formData.schedule_days.filter(d => d !== day);
                            setFormData(prev => ({ ...prev, schedule_days: newDays }));
                          }}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">{label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>
                  إلغاء
                </Button>
                <Button type="submit" disabled={loading}>
                  {isEditing ? 'تحديث' : 'إضافة'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Students Dialog */}
        <Dialog open={isStudentsDialogOpen} onOpenChange={setIsStudentsDialogOpen}>
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
                  {getGroupStudents().length} / {selectedGroup?.max_students || 50}
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
                  getFilteredStudents().map((student, index) => (
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
                              <Badge variant={student.is_active ? "default" : "secondary"} className="bg-white/20 text-white border-0 text-xs">
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
                <Button variant="outline" onClick={() => setIsStudentsDialogOpen(false)}>
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
