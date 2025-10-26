import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { CreditCard, Plus, Edit2, Trash2, Calendar, DollarSign } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { supabase } from "@/integrations/supabase/client";

const Subscriptions = () => {
  const [subscriptions, setSubscriptions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState(null);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    duration_months: "",
    price: "",
    description: ""
  });
  
  const { toast } = useToast();

  useEffect(() => {
    fetchSubscriptions();
  }, []);

  const fetchSubscriptions = async () => {
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setSubscriptions(data || []);
    } catch (error) {
      console.error('Error fetching subscriptions:', error);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    
    try {
      const subscriptionData = {
        name: formData.name,
        duration_months: parseInt(formData.duration_months),
        price: parseFloat(formData.price),
        description: formData.description
      };

      if (editingSubscription) {
        const { error } = await supabase
          .from('subscriptions')
          .update(subscriptionData)
          .eq('id', editingSubscription.id);
        
        if (error) throw error;
        
        toast({
          title: "تم التحديث بنجاح",
          description: "تم تحديث بيانات الاشتراك",
        });
      } else {
        const { error } = await supabase
          .from('subscriptions')
          .insert(subscriptionData);
        
        if (error) throw error;
        
        toast({
          title: "تم الإضافة بنجاح",
          description: "تم إضافة اشتراك جديد",
        });
      }
      
      fetchSubscriptions();
      setIsOpen(false);
      setEditingSubscription(null);
      setFormData({ name: "", duration_months: "", price: "", description: "" });
    } catch (error) {
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ، حاول مرة أخرى",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (subscription) => {
    setEditingSubscription(subscription);
    setFormData({
      name: subscription.name,
      duration_months: subscription.duration_months.toString(),
      price: subscription.price.toString(),
      description: subscription.description || ""
    });
    setIsOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      const { error } = await supabase
        .from('subscriptions')
        .delete()
        .eq('id', id);
      
      if (error) throw error;
      
      fetchSubscriptions();
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف الاشتراك",
      });
    } catch (error) {
      toast({
        title: "خطأ",
        description: "حدث خطأ في الحذف",
        variant: "destructive",
      });
    }
  };

  const toggleActive = async (id, currentStatus) => {
    try {
      const { error } = await supabase
        .from('subscriptions')
        .update({ is_active: !currentStatus })
        .eq('id', id);
      
      if (error) throw error;
      
      fetchSubscriptions();
      toast({
        title: "تم التحديث",
        description: `تم ${!currentStatus ? 'تفعيل' : 'إلغاء'} الاشتراك`,
      });
    } catch (error) {
      toast({
        title: "خطأ",
        description: "حدث خطأ في التحديث",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl">
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
                <DialogTitle>
                  {editingSubscription ? "تعديل الاشتراك" : "إضافة اشتراك جديد"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">اسم الاشتراك</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="مثال: اشتراك شهري - التاريخ"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="duration_months">المدة (بالأشهر)</Label>
                  <Input
                    id="duration_months"
                    type="number"
                    min="1"
                    value={formData.duration_months}
                    onChange={(e) => setFormData(prev => ({ ...prev, duration_months: e.target.value }))}
                    placeholder="3"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="price">السعر (جنيه)</Label>
                  <Input
                    id="price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.price}
                    onChange={(e) => setFormData(prev => ({ ...prev, price: e.target.value }))}
                    placeholder="500"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">الوصف</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="وصف مختصر للاشتراك..."
                    rows={3}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري المعالجة..." : (editingSubscription ? "تحديث الاشتراك" : "إضافة الاشتراك")}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>قائمة الاشتراكات</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>اسم الاشتراك</TableHead>
                  <TableHead>المدة</TableHead>
                  <TableHead>السعر</TableHead>
                  <TableHead>الوصف</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((subscription) => (
                  <TableRow key={subscription.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
                          <CreditCard className="w-4 h-4 text-primary" />
                        </div>
                        <span className="font-medium">{subscription.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Calendar className="w-4 h-4 text-muted-foreground" />
                        {subscription.duration_months} أشهر
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <DollarSign className="w-4 h-4 text-muted-foreground" />
                        {subscription.price} جنيه
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {subscription.description || "لا يوجد وصف"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggleActive(subscription.id, subscription.is_active)}
                        className={`px-2 py-1 rounded-full text-xs ${
                          subscription.is_active 
                            ? 'bg-green-100 text-green-800 hover:bg-green-200' 
                            : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
                        }`}
                      >
                        {subscription.is_active ? 'نشط' : 'غير نشط'}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(subscription)}
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(subscription.id)}
                          className="text-destructive hover:text-destructive"
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
      </div>
    </div>
  );
};

export default Subscriptions;