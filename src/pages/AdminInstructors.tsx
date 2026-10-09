import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Users,
  Plus,
  Edit2,
  Wallet,
  Phone,
  Mail,
  Video,
  GraduationCap,
  Power,
  PowerOff,
  Search,
  DollarSign,
  TrendingUp,
  ArrowUpCircle,
  ArrowDownCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import {
  getInstructors,
  updateInstructor,
  deleteInstructor,
  requestServiceCreditAdjustment,
  Instructor,
} from "@/lib/api";

export default function AdminInstructors() {
  const profile = (() => {
    try {
      return JSON.parse(localStorage.getItem('currentUser') || 'null') as { role?: string; admin_permissions?: string[] } | null;
    } catch { return null; }
  })();
  const permitted = (key: string) => profile?.role === 'admin' || Boolean(profile?.admin_permissions?.includes(key));
  const canCreateInstructor = permitted('instructor.create');
  const canOpenInstructorAccount = permitted('instructor.read');
  const canUpdateInstructor = permitted('instructor.update');
  const canSuspendInstructor = permitted('instructor.suspend');
  const canReadServiceCredit = permitted('service_credit.read');
  const canAdjustServiceCredit = permitted('service_credit.adjust');
  const navigate = useNavigate();
  const { toast } = useToast();
  const [instructors, setInstructors] = useState<Instructor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Add/Edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingInstructor, setEditingInstructor] = useState<Instructor | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
  });
  const [submitting, setSubmitting] = useState(false);

  // Wallet dialog
  const [walletDialogOpen, setWalletDialogOpen] = useState(false);
  const [selectedInstructor, setSelectedInstructor] = useState<Instructor | null>(null);
  const [walletAction, setWalletAction] = useState<"credit" | "debit">("credit");
  const [walletAmount, setWalletAmount] = useState("");
  const [walletDescription, setWalletDescription] = useState("");
  const [walletSubmitting, setWalletSubmitting] = useState(false);

  useEffect(() => {
    const userStr = localStorage.getItem("currentUser");
    if (!userStr) {
      navigate("/auth");
      return;
    }
    const user = JSON.parse(userStr);
    if (user.role !== "admin" && !user.admin_member) {
      navigate("/auth");
      toast({
        variant: "destructive",
        title: "غير مسموح",
        description: "هذه الصفحة للمسؤول فقط",
      });
      return;
    }
    fetchInstructors();
  }, []);

  const fetchInstructors = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await getInstructors();
      setInstructors(data || []);
    } catch (error: any) {
      console.error("Error fetching instructors:", error);
      setLoadError(error.message || "فشل في جلب بيانات المدرسين");
      toast({
        variant: "destructive",
        title: "خطأ",
        description: error.message || "فشل في جلب بيانات المدرسين",
      });
    } finally {
      setLoading(false);
    }
  };

  // === Edit existing Instructor ===
  const openEditDialog = (inst: Instructor) => {
    setEditingInstructor(inst);
    setFormData({
      name: inst.name,
      email: inst.email || "",
      phone: inst.phone || "",
      password: "",
    });
    setDialogOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast({ variant: "destructive", title: "خطأ", description: "يجب إدخال الاسم" });
      return;
    }
    if (!editingInstructor) return;

    try {
      setSubmitting(true);
      const updateData: any = {
        name: formData.name.trim(),
        email: formData.email.trim() || null,
        phone: formData.phone.trim() || null,
      };
      if (formData.password.trim()) updateData.password = formData.password.trim();
      await updateInstructor(editingInstructor.id, updateData);
      toast({ title: "تم بنجاح", description: "تم تحديث بيانات المدرس" });
      fetchInstructors();
      setDialogOpen(false);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "خطأ",
        description: error.message || "حدث خطأ",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // === Toggle Active ===
  const handleToggleActive = async (inst: Instructor) => {
    try {
      await updateInstructor(inst.id, { is_active: !inst.is_active });
      toast({
        title: "تم بنجاح",
        description: inst.is_active ? "تم تعطيل الحساب" : "تم تفعيل الحساب",
      });
      fetchInstructors();
    } catch (error: any) {
      toast({ variant: "destructive", title: "خطأ", description: error.message });
    }
  };

  // === Deactivate without deleting teaching or financial history ===
  const handleDelete = async (inst: Instructor) => {
    if (!confirm(`هل أنت متأكد من إيقاف حساب المدرس "${inst.name}"؟ ستبقى بياناته محفوظة.`)) return;
    try {
      await deleteInstructor(inst.id);
      toast({ title: "تم بنجاح", description: "تم إيقاف حساب المدرس مع الاحتفاظ ببياناته" });
      fetchInstructors();
    } catch (error: any) {
      toast({ variant: "destructive", title: "خطأ", description: error.message });
    }
  };

  // === Wallet ===
  const openWalletDialog = (inst: Instructor, action: "credit" | "debit") => {
    setSelectedInstructor(inst);
    setWalletAction(action);
    setWalletAmount("");
    setWalletDescription("");
    setWalletDialogOpen(true);
  };

  const handleWalletSubmit = async () => {
    if (!selectedInstructor || !walletAmount) return;
    if (walletDescription.trim().length < 3) {
      toast({ variant: "destructive", title: "السبب مطلوب", description: "اكتب سبب تعديل رصيد خدمات المنصة" });
      return;
    }
    const amount = parseFloat(walletAmount);
    if (isNaN(amount) || amount <= 0) {
      toast({ variant: "destructive", title: "خطأ", description: "أدخل مبلغ صحيح" });
      return;
    }

    try {
      setWalletSubmitting(true);
      await requestServiceCreditAdjustment({
        instructor_id: selectedInstructor.id,
        action_key: walletAction === 'credit' ? 'service_credit.credit' : 'service_credit.debit',
        amount: walletAmount,
        reason: walletDescription.trim(),
      });
      toast({ title: "أُرسل طلب الموافقة", description: `تعديل رصيد خدمات ${selectedInstructor.name} لن يُنفذ قبل اعتماد مسؤول آخر.` });
      fetchInstructors();
      setWalletDialogOpen(false);
    } catch (error: any) {
      toast({ variant: "destructive", title: "خطأ", description: error.message });
    } finally {
      setWalletSubmitting(false);
    }
  };

  const filteredInstructors = instructors.filter(
    (i) =>
      i.name?.toLowerCase().includes(search.toLowerCase()) ||
      i.phone?.includes(search) ||
      i.email?.toLowerCase().includes(search.toLowerCase())
  );

  // Stats
  const totalBalance = instructors.reduce((sum, i) => sum + Number(i.wallet_balance || 0), 0);
  const activeCount = instructors.filter((i) => i.is_active).length;
  const displayNumber = (value: number) => loading || loadError ? "—" : value.toLocaleString("ar-EG");

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50 dark:from-slate-900 dark:via-indigo-950 dark:to-purple-950" dir="rtl">
      <Header />

      <main className="container mx-auto px-4 py-8">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-xl flex items-center justify-center">
                <GraduationCap className="w-7 h-7 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-foreground">إدارة المدرسين</h1>
                <p className="text-muted-foreground">إضافة وتعديل وإيقاف حسابات المدرسين دون حذف بياناتهم</p>
              </div>
            </div>
            {canCreateInstructor && <Button className="bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 shadow-lg gap-2" onClick={() => navigate('/admin/platform')}>
              <Plus className="w-4 h-4" />
              تهيئة مدرس واشتراك جديد
            </Button>}
          </div>
        </motion.div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="border-0 shadow-lg overflow-hidden">
              <div className="bg-gradient-to-br from-indigo-500 to-purple-500 p-5 text-white">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm opacity-80">إجمالي المدرسين</p>
                    <p className="text-3xl font-bold mt-1">{displayNumber(instructors.length)}</p>
                  </div>
                  <Users className="w-8 h-8 opacity-60" />
                </div>
              </div>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
            <Card className="border-0 shadow-lg overflow-hidden">
              <div className="bg-gradient-to-br from-emerald-500 to-teal-500 p-5 text-white">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm opacity-80">المدرسين النشطين</p>
                    <p className="text-3xl font-bold mt-1">{displayNumber(activeCount)}</p>
                  </div>
                  <Power className="w-8 h-8 opacity-60" />
                </div>
              </div>
            </Card>
          </motion.div>

          {canReadServiceCredit && <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <Card className="border-0 shadow-lg overflow-hidden">
              <div className="bg-gradient-to-br from-amber-500 to-orange-500 p-5 text-white">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm opacity-80">إجمالي أرصدة خدمات المنصة</p>
                    <p className="text-3xl font-bold mt-1">{loading || loadError ? "—" : totalBalance.toFixed(2)} <span className="text-lg">ج.م</span></p>
                  </div>
                  <Wallet className="w-8 h-8 opacity-60" />
                </div>
              </div>
            </Card>
          </motion.div>}
        </div>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute right-3 top-2.5 w-4 h-4 text-slate-400" />
          <Input
            placeholder="ابحث بالاسم أو الهاتف أو الإيميل…"
            className="pr-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Instructors list */}
        {loading ? (
          <div className="text-center py-16 text-slate-400">جاري التحميل…</div>
        ) : loadError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-red-800">
            <p>{loadError}</p>
            <Button variant="outline" className="mt-3" onClick={fetchInstructors}>إعادة المحاولة</Button>
          </div>
        ) : filteredInstructors.length === 0 ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center text-slate-400">
              <GraduationCap className="w-16 h-16 mx-auto mb-4 opacity-20" />
              <p className="text-lg font-medium">{instructors.length === 0 ? "لا يوجد مدرسين بعد" : "لا توجد نتائج للبحث"}</p>
              {instructors.length === 0 && canCreateInstructor && (
                <Button className="mt-4 bg-indigo-600 hover:bg-indigo-700 gap-2" onClick={() => navigate('/admin/platform')}>
                  <Plus className="w-4 h-4" /> إضافة أول مدرس
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredInstructors.map((inst, i) => {
              const initials = inst.name
                .split(" ")
                .slice(0, 2)
                .map((w) => w[0])
                .join("")
                .toUpperCase();
              return (
                <motion.div
                  key={inst.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}
                >
                  <Card className="border-0 shadow-sm hover:shadow-lg transition-all overflow-hidden">
                    {/* Header bar */}
                    <div className={`bg-gradient-to-r ${inst.is_active ? "from-indigo-500 to-purple-500" : "from-slate-400 to-slate-500"} p-4`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-12 w-12 border-2 border-white/30">
                            <AvatarFallback className="bg-white/20 text-white font-bold">{initials}</AvatarFallback>
                          </Avatar>
                          <div>
                            <h3 className="font-bold text-white text-lg">{inst.name}</h3>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={`text-xs ${inst.is_active ? "bg-emerald-500/20 text-emerald-100 border-emerald-300/30" : "bg-slate-500/20 text-slate-200 border-slate-300/30"}`}>
                                {inst.is_active ? "نشط" : "معطل"}
                              </Badge>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          {canUpdateInstructor && <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-white hover:bg-white/20" onClick={() => openEditDialog(inst)}>
                            <Edit2 className="w-4 h-4" />
                          </Button>}
                          {canSuspendInstructor && <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-white hover:bg-red-500/30" onClick={() => handleDelete(inst)} disabled={!inst.is_active} title="إيقاف الحساب مع الاحتفاظ بالبيانات">
                            <PowerOff className="w-4 h-4" />
                          </Button>}
                        </div>
                      </div>
                    </div>

                    {/* Info */}
                    <CardContent className="p-4 space-y-3">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="flex items-center gap-2 text-slate-600">
                          <Phone className="w-4 h-4 text-indigo-400 shrink-0" />
                          <span className="truncate" dir="ltr">{inst.phone || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-slate-600">
                          <Mail className="w-4 h-4 text-indigo-400 shrink-0" />
                          <span className="truncate">{inst.email || "—"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-slate-600">
                          <Video className="w-4 h-4 text-purple-400 shrink-0" />
                          <span>{inst.total_lectures ?? 0} فيديو</span>
                        </div>
                        <div className="flex items-center gap-2 text-slate-600">
                          <Users className="w-4 h-4 text-blue-400 shrink-0" />
                          <span>{inst.total_students ?? 0} طالب</span>
                        </div>
                      </div>

                      {/* Wallet */}
                      {canReadServiceCredit && <div className="bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400 text-sm font-medium">
                            <Wallet className="w-4 h-4" />
                            رصيد خدمات المنصة
                          </div>
                          <span className="font-bold text-emerald-700 dark:text-emerald-400">{Number(inst.wallet_balance || 0).toFixed(2)} ج.م</span>
                        </div>
                        {canAdjustServiceCredit && <div className="flex gap-2">
                          <Button size="sm" className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-xs gap-1 h-7" onClick={() => openWalletDialog(inst, "credit")}>
                            <ArrowUpCircle className="w-3 h-3" /> إضافة رصيد
                          </Button>
                          <Button size="sm" variant="outline" className="flex-1 border-red-200 text-red-600 hover:bg-red-50 text-xs gap-1 h-7" onClick={() => openWalletDialog(inst, "debit")}>
                            <ArrowDownCircle className="w-3 h-3" /> خصم رصيد
                          </Button>
                        </div>}
                      </div>}

                      {/* Toggle active */}
                      {canSuspendInstructor && <Button
                        size="sm"
                        variant="outline"
                        className={`w-full gap-1 ${inst.is_active ? "border-amber-200 text-amber-600 hover:bg-amber-50" : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"}`}
                        onClick={() => handleToggleActive(inst)}
                      >
                        {inst.is_active ? <><PowerOff className="w-3 h-3" /> تعطيل الحساب</> : <><Power className="w-3 h-3" /> تفعيل الحساب</>}
                      </Button>}
                      {canOpenInstructorAccount && <Button size="sm" variant="outline" className="w-full" onClick={() => navigate(`/admin/instructors/${inst.id}`)}>فتح الملف الكامل وكشف الحساب</Button>}
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </main>

      {/* Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GraduationCap className="w-5 h-5 text-indigo-600" />
              تعديل بيانات المدرس
            </DialogTitle>
            <DialogDescription>عدّل بيانات تسجيل دخول المدرس. اترك كلمة المرور فارغة إذا لم ترد تغييرها.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>الاسم *</Label>
              <Input value={formData.name} onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))} placeholder="اسم المدرس" required />
            </div>
            <div className="space-y-2">
              <Label>رقم الهاتف</Label>
              <Input value={formData.phone} onChange={(e) => setFormData((p) => ({ ...p, phone: e.target.value }))} placeholder="01234567890" />
            </div>
            <div className="space-y-2">
              <Label>البريد الإلكتروني (اختياري)</Label>
              <Input type="email" value={formData.email} onChange={(e) => setFormData((p) => ({ ...p, email: e.target.value }))} placeholder="email@example.com" />
            </div>
            <div className="space-y-2">
              <Label>كلمة المرور (اتركه فارغاً للإبقاء)</Label>
              <Input type="password" value={formData.password} onChange={(e) => setFormData((p) => ({ ...p, password: e.target.value }))} />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>إلغاء</Button>
              <Button type="submit" className="bg-indigo-600 hover:bg-indigo-700" disabled={submitting}>
                {submitting ? "جاري…" : "تحديث"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Wallet Dialog */}
      <Dialog open={walletDialogOpen} onOpenChange={setWalletDialogOpen}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {walletAction === "credit" ? <ArrowUpCircle className="w-5 h-5 text-emerald-600" /> : <ArrowDownCircle className="w-5 h-5 text-red-600" />}
              {walletAction === "credit" ? "طلب إضافة رصيد خدمات" : "طلب خصم رصيد خدمات"}
            </DialogTitle>
            <DialogDescription>هذا رصيد خدمات المنصة وليس أموال الطلاب. تُسجل العملية وسببها في الموافقات.</DialogDescription>
          </DialogHeader>
          {selectedInstructor && (
            <div className="space-y-4">
              <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                <p className="font-medium">{selectedInstructor.name}</p>
                <p className="text-sm text-slate-500">رصيد خدمات المنصة: {Number(selectedInstructor.wallet_balance || 0).toFixed(2)} ج.م — ليس تحصيل الطلاب</p>
              </div>
              <div className="space-y-2">
                <Label>المبلغ (ج.م) *</Label>
                <Input type="number" min="0.01" step="0.01" value={walletAmount} onChange={(e) => setWalletAmount(e.target.value)} placeholder="أدخل المبلغ" required />
              </div>
              <div className="space-y-2">
                <Label>سبب التعديل *</Label>
                <Input value={walletDescription} onChange={(e) => setWalletDescription(e.target.value)} placeholder="سبب العملية" />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setWalletDialogOpen(false)}>إلغاء</Button>
            <Button
              className={walletAction === "credit" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"}
              onClick={handleWalletSubmit}
              disabled={walletSubmitting || !walletAmount || walletDescription.trim().length < 3}
            >
              {walletSubmitting ? "جاري…" : "طلب الموافقة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
