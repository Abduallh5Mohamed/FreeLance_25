import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { CreditCard, Plus, Edit2, Trash2 } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getSubscriptions, createSubscription, updateSubscription, deleteSubscription, type Subscription } from "@/lib/api";

const Subscriptions = () => {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ name: "", duration_months: "", price: "", description: "" });

  const { toast } = useToast();

  const fetchSubscriptions = async () => {
    try {
      const data = await getSubscriptions();
      setSubscriptions(data || []);
    } catch (err) {
      toast({ title: "خطأ", description: "فشل في جلب الاشتراكات", variant: "destructive" });
    }
  };

  useEffect(() => { fetchSubscriptions(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (editingSubscription) {
        await updateSubscription(editingSubscription.id, { name: formData.name, duration_months: parseInt(formData.duration_months), price: parseFloat(formData.price), description: formData.description });
        toast({ title: "تم التحديث", description: "تم تحديث الاشتراك" });
      } else {
        await createSubscription({ name: formData.name, duration_months: parseInt(formData.duration_months), price: parseFloat(formData.price), description: formData.description });
        toast({ title: "تم الإضافة", description: "تم إنشاء الاشتراك" });
      }
      setIsOpen(false);
      setFormData({ name: "", duration_months: "", price: "", description: "" });
      fetchSubscriptions();
    } catch (err) {
      toast({ title: "خطأ", description: "فشل في حفظ الاشتراك", variant: "destructive" });
    } finally { setLoading(false); }
  };

  const handleEdit = (subscription: Subscription) => {
    setEditingSubscription(subscription);
    setFormData({ name: subscription.name, duration_months: String(subscription.duration_months || ''), price: String(subscription.price || ''), description: subscription.description || '' });
    setIsOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSubscription(id);
      toast({ title: "تم الحذف بنجاح", description: "تم حذف الاشتراك" });
      fetchSubscriptions();
    } catch (err) {
      toast({ title: "خطأ", description: "حدث خطأ في الحذف", variant: "destructive" });
    }
  };

  const toggleActive = async (id: string, currentStatus: boolean) => {
    try {
      await updateSubscription(id, { is_active: !currentStatus });
      toast({ title: "تم التحديث", description: `تم ${!currentStatus ? 'تفعيل' : 'إلغاء'} الاشتراك` });
      fetchSubscriptions();
    } catch (err) {
      toast({ title: "خطأ", description: "حدث خطأ في التحديث", variant: "destructive" });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <CreditCard className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة الاشتراكات</h1>
              <p className="text-muted-foreground">إضافة وإدارة خطط الاشتراك للطلاب</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button className="shadow-medium">
                <Plus className="w-4 h-4 ml-2" />
                إضافة اشتراك جديد
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editingSubscription ? "تعديل الاشتراك" : "إضافة اشتراك جديد"}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم الاشتراك</Label>
                  <Input id="name" value={formData.name} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} placeholder="مثال: اشتراك شهري" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="duration_months">المدة (بالأشهر)</Label>
                  <Input id="duration_months" type="number" min="1" value={formData.duration_months} onChange={(e) => setFormData(prev => ({ ...prev, duration_months: e.target.value }))} placeholder="3" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="price">السعر (جنيه)</Label>
                  <Input id="price" type="number" min="0" step="0.01" value={formData.price} onChange={(e) => setFormData(prev => ({ ...prev, price: e.target.value }))} placeholder="500" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">الوصف</Label>
                  <Textarea id="description" value={formData.description} onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))} placeholder="وصف مختصر للاشتراك..." rows={3} />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>{loading ? "جاري المعالجة..." : (editingSubscription ? "تحديث الاشتراك" : "إضافة الاشتراك")}</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>قائمة الاشتراكات</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {subscriptions.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <CreditCard className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد اشتراكات مسجلة</p>
              </div>
            ) : (
              <div className="space-y-4">
                {subscriptions.map((subscription) => (
                  <div key={subscription.id} className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900">
                    <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 bg-white/10 rounded flex items-center justify-center"><CreditCard className="w-5 h-5 text-white" /></div>
                        <div>
                          <h3 className="font-bold text-white text-lg">{subscription.name}</h3>
                          <div className="flex items-center gap-2 text-xs text-cyan-50"><span>{subscription.duration_months} شهر</span><span>{subscription.price} ج.م</span></div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleEdit(subscription)} className="h-8 w-8 p-0 text-white hover:bg-white/20"><Edit2 className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(subscription.id)} className="h-8 w-8 p-0 text-white hover:bg-red-500/30"><Trash2 className="w-4 h-4" /></Button>
                      </div>
                    </div>
                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📝 الوصف</div>
                        <div className="text-sm text-muted-foreground">{subscription.description || 'لا يوجد وصف'}</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">⏳ المدة</div>
                        <div className="text-sm font-medium">{subscription.duration_months} شهر</div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">💰 السعر</div>
                        <div className="text-sm font-bold">{subscription.price} ج.م</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Subscriptions;