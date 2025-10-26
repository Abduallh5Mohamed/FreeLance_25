import React, { useState, useEffect } from 'react';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Plus, Edit, Trash2, Users } from 'lucide-react';

interface Group {
  id: string;
  name: string;
  description: string;
  max_students: number;
  current_students: number;
  is_active: boolean;
  type: 'offline' | 'online';
  grade_id?: string;
  grades?: { name: string };
}

interface Grade {
  id: string;
  name: string;
}

const Groups = () => {
  const [groups, setGroups] = useState<Group[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [currentGroup, setCurrentGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: 'offline' as 'offline' | 'online',
    grade_id: '',
    max_students: 50
  });

  useEffect(() => {
    fetchGroups();
    fetchGrades();
  }, []);

  const fetchGroups = async () => {
    try {
      const { data, error } = await supabase
        .from('groups')
        .select(`
          *,
          grades (name)
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setGroups(data || []);
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
      const { data, error } = await supabase
        .from('grades')
        .select('id, name')
        .eq('is_active', true);

      if (error) throw error;
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const groupData = {
        name: formData.name,
        description: formData.description,
        type: formData.type,
        grade_id: formData.grade_id || null,
        max_students: formData.max_students,
        is_active: true
      };

      let error;
      if (isEditing && currentGroup) {
        const { error: updateError } = await supabase
          .from('groups')
          .update(groupData)
          .eq('id', currentGroup.id);
        error = updateError;
      } else {
        const { error: insertError } = await supabase
          .from('groups')
          .insert([groupData]);
        error = insertError;
      }

      if (error) throw error;

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
    setFormData({
      name: group.name,
      description: group.description || '',
      type: group.type,
      grade_id: group.grade_id || '',
      max_students: group.max_students
    });
    setIsEditing(true);
    setIsDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('هل أنت متأكد من حذف هذه المجموعة؟')) return;

    try {
      // Step 1: Update students to remove group reference
      await supabase
        .from('students')
        .update({ group_id: null })
        .eq('group_id', id);

      // Step 2: Delete related attendance QR codes
      await supabase
        .from('attendance_qr_codes')
        .delete()
        .eq('group_id', id);

      // Step 3: Delete related material groups
      await supabase
        .from('material_groups')
        .delete()
        .eq('group_id', id);

      // Step 4: Delete related group courses
      await supabase
        .from('group_courses')
        .delete()
        .eq('group_id', id);

      // Step 5: Update exams to remove group reference
      await supabase
        .from('exams')
        .update({ group_id: null })
        .eq('group_id', id);

      // Step 6: Finally delete the group
      const { error } = await supabase
        .from('groups')
        .delete()
        .eq('id', id);

      if (error) throw error;

      toast({
        title: "نجح",
        description: "تم حذف المجموعة بنجاح",
      });

      fetchGroups();
    } catch (error: any) {
      console.error('Error deleting group:', error);
      toast({
        title: "خطأ",
        description: error.message || "فشل في حذف المجموعة",
        variant: "destructive",
      });
    }
  };

  const toggleGroupStatus = async (group: Group) => {
    try {
      const { error } = await supabase
        .from('groups')
        .update({ is_active: !group.is_active })
        .eq('id', group.id);

      if (error) throw error;

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
      type: 'offline',
      grade_id: '',
      max_students: 50
    });
    setIsEditing(false);
    setCurrentGroup(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background" dir="rtl">
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
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>اسم المجموعة</TableHead>
                  <TableHead>الوصف</TableHead>
                  <TableHead>الصف الدراسي</TableHead>
                  <TableHead>النوع</TableHead>
                  <TableHead>الطلاب</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <TableRow key={group.id}>
                    <TableCell className="font-medium">{group.name}</TableCell>
                    <TableCell>{group.description}</TableCell>
                    <TableCell>{group.grades?.name || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={group.type === 'online' ? 'default' : 'secondary'}>
                        {group.type === 'online' ? 'أونلاين' : 'أوفلاين'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {group.current_students} / {group.max_students}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={group.is_active}
                          onCheckedChange={() => toggleGroupStatus(group)}
                        />
                        <span className="text-sm">
                          {group.is_active ? 'مفتوحة' : 'مغلقة'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleEdit(group)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDelete(group.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
                  <Label htmlFor="type">نوع المجموعة</Label>
                  <Select
                    value={formData.type}
                    onValueChange={(value: 'offline' | 'online') => setFormData(prev => ({ ...prev, type: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="offline">أوفلاين</SelectItem>
                      <SelectItem value="online">أونلاين</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

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
      </div>
    </div>
  );
};

export default Groups;
