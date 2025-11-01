import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Users, Plus, Edit2, Trash2, Mail, Phone } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";

const AVAILABLE_PAGES = [
  { id: "students", label: "إدارة الطلاب" },
  { id: "courses", label: "إدارة الكورسات" },
  { id: "groups", label: "إدارة المجموعات" },
  { id: "attendance", label: "الحضور والغياب" },
  { id: "fees", label: "المصروفات" },
  { id: "messages", label: "الرسائل" },
  { id: "reports", label: "التقارير" },
  { id: "expenses", label: "مصروفات السنتر" },
];

const Staff = () => {
  const [staff, setStaff] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState(null);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
  });
  const [selectedPages, setSelectedPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchStaff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchStaff = async () => {
    try {
      // TODO: Add staff API endpoint
      setStaff([]);
      toast({
        title: "قريباً",
        description: "سيتم إضافة إدارة الموظفين قريباً",
      });
    } catch (error) {
      console.error('Error fetching staff:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      toast({
        title: "قريباً",
        description: "سيتم إضافة هذه الميزة قريباً",
      });

      fetchStaff();
      setIsOpen(false);
      setEditingStaff(null);
      setFormData({ name: "", email: "", phone: "", password: "" });
      setSelectedPages([]);
    } catch (error) {
      toast({
        title: "خطأ",
        description: "حدث خطأ في العملية",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (staffMember: { name: string; email: string; phone?: string; accessible_pages?: string[] }) => {
    setEditingStaff(staffMember);
    setFormData({
      name: staffMember.name,
      email: staffMember.email,
      phone: staffMember.phone || "",
      password: "",
    });
    setSelectedPages(staffMember.accessible_pages || []);
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      // TODO: Add staff delete API endpoint
      toast({
        title: "قريباً",
        description: "سيتم إضافة هذه الميزة قريباً",
      });
    } catch (error) {
      toast({
        title: "خطأ",
        description: "حدث خطأ في الحذف",
        variant: "destructive",
      });
    }
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
              <h1 className="text-2xl font-bold text-foreground">إدارة الموظفين</h1>
              <p className="text-muted-foreground">إضافة وإدارة صلاحيات الموظفين</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button className="shadow-medium">
                <Plus className="w-4 h-4 ml-2" />
                إضافة موظف جديد
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingStaff ? "تعديل بيانات الموظف" : "إضافة موظف جديد"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">الاسم</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
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
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">رقم الهاتف</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">كلمة المرور</Label>
                  <Input
                    id="password"
                    type="password"
                    value={formData.password}
                    onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                    placeholder={editingStaff ? "اتركه فارغاً للإبقاء على كلمة المرور الحالية" : ""}
                    required={!editingStaff}
                  />
                </div>
                <div className="space-y-2">
                  <Label>الصفحات المسموح بالوصول إليها</Label>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {AVAILABLE_PAGES.map((page) => (
                      <div key={page.id} className="flex items-center space-x-2 space-x-reverse">
                        <Checkbox
                          id={page.id}
                          checked={selectedPages.includes(page.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedPages([...selectedPages, page.id]);
                            } else {
                              setSelectedPages(selectedPages.filter(p => p !== page.id));
                            }
                          }}
                        />
                        <Label htmlFor={page.id} className="text-sm font-normal">
                          {page.label}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري المعالجة..." : (editingStaff ? "تحديث البيانات" : "إضافة الموظف")}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>قائمة الموظفين</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {staff.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا يوجد موظفين حالياً</p>
              </div>
            ) : (
              <div className="space-y-4">
                {staff.map((staffMember) => {
                  const initials = staffMember.name
                    .split(' ')
                    .map(n => n[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2);
                  
                  return (
                    <div 
                      key={staffMember.id}
                      className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                    >
                      <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-10 w-10 border-2 border-white">
                            <AvatarFallback className="text-xs bg-white text-cyan-600">{initials}</AvatarFallback>
                          </Avatar>
                          <div>
                            <h3 className="font-bold text-white text-lg">{staffMember.name}</h3>
                            <div className="flex items-center gap-2 text-xs text-cyan-50">
                              {staffMember.email && (
                                <>
                                  <Mail className="w-3 h-3" />
                                  <span>{staffMember.email}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(staffMember)}
                            className="h-8 w-8 p-0 text-white hover:bg-white/20"
                          >
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(staffMember.id)}
                            className="h-8 w-8 p-0 text-white hover:bg-red-500/30"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      
                      <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <div>
                          <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📧 البريد الإلكتروني</div>
                          <div className="text-sm font-medium">{staffMember.email}</div>
                        </div>
                        
                        <div>
                          <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📱 رقم الهاتف</div>
                          <div className="text-sm font-medium flex items-center gap-2">
                            <Phone className="w-3 h-3 text-muted-foreground" />
                            {staffMember.phone || '-'}
                          </div>
                        </div>
                        
                        <div>
                          <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">🔐 الصلاحيات</div>
                          <div className="text-sm font-medium">
                            {staffMember.accessible_pages?.length || 0} صفحة
                          </div>
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

export default Staff;