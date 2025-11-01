import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Package, Plus, TrendingDown, Trash2, Edit2, User, Calendar, DollarSign, Phone, FileText, ShoppingCart } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

const Imports = () => {
  const [imports, setImports] = useState([]);
  const [items, setItems] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [totalImports, setTotalImports] = useState(0);
  const [formData, setFormData] = useState({
    supplier_name: "",
    supplier_phone: "",
    import_date: new Date().toISOString().split('T')[0],
    payment_method: "cash",
    paid_amount: 0,
    notes: ""
  });
  const [currentItems, setCurrentItems] = useState([
    { item_code: "", item_name: "", quantity: 1, unit_price: 0 }
  ]);
  const { toast } = useToast();

  useEffect(() => {
    fetchImports();
    fetchItems();
  }, []);

  const fetchImports = async () => {
    try {
      const { data, error } = await supabase
        .from('imports')
        .select('*')
        .order('import_date', { ascending: false });

      if (error) throw error;

      setImports(data || []);
      const total = data?.reduce((sum, item) => sum + Number(item.total_amount), 0) || 0;
      setTotalImports(total);
    } catch (error) {
      console.error('Error fetching imports:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل البيانات",
        variant: "destructive",
      });
    }
  };

  const fetchItems = async () => {
    try {
      const { data, error } = await supabase
        .from('items')
        .select('*');
      
      if (error) throw error;
      setItems(data || []);
    } catch (error) {
      console.error('Error fetching items:', error);
    }
  };

  const handleAddItem = () => {
    setCurrentItems([...currentItems, { item_code: "", item_name: "", quantity: 1, unit_price: 0 }]);
  };

  const handleRemoveItem = (index: number) => {
    const newItems = currentItems.filter((_, i) => i !== index);
    setCurrentItems(newItems);
  };

  const handleItemChange = (index: number, field: string, value: any) => {
    const newItems = [...currentItems];
    newItems[index] = { ...newItems[index], [field]: value };
    
    // Auto-fill item name if code is selected
    if (field === 'item_code') {
      const selectedItem = items.find(item => item.code === value);
      if (selectedItem) {
        newItems[index].item_name = selectedItem.name;
      }
    }
    
    setCurrentItems(newItems);
  };

  const calculateTotal = () => {
    return currentItems.reduce((sum, item) => {
      return sum + (Number(item.quantity) * Number(item.unit_price));
    }, 0);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Validate form
      if (!formData.supplier_name.trim()) {
        toast({
          title: "خطأ",
          description: "الرجاء إدخال اسم المورد",
          variant: "destructive"
        });
        setLoading(false);
        return;
      }

      if (currentItems.length === 0 || !currentItems[0].item_name) {
        toast({
          title: "خطأ",
          description: "الرجاء إضافة عنصر واحد على الأقل",
          variant: "destructive"
        });
        setLoading(false);
        return;
      }

      const totalAmount = calculateTotal();
      const paidAmount = Number(formData.paid_amount);
      const remainingAmount = totalAmount - paidAmount;

      // Insert import record
      const { error: importError } = await supabase
        .from('imports')
        .insert({
          supplier_name: formData.supplier_name,
          supplier_phone: formData.supplier_phone,
          items: currentItems,
          total_amount: totalAmount,
          paid_amount: paidAmount,
          remaining_amount: remainingAmount,
          import_date: formData.import_date,
          payment_method: formData.payment_method,
          notes: formData.notes
        });

      if (importError) throw importError;

      // Deduct from cash account (expense)
      const { error: cashError } = await supabase
        .from('cash_account')
        .insert({
          type: 'expense',
          category: 'imports',
          amount: paidAmount,
          date: formData.import_date,
          description: `مستوردات من ${formData.supplier_name} - ${currentItems.length} عنصر`
        });

      if (cashError) throw cashError;

      // Add to expenses table
      await supabase
        .from('expenses')
        .insert({
          amount: paidAmount,
          description: `مستوردات من ${formData.supplier_name}`,
          category: 'imports',
          date: formData.import_date,
          time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
        });

      toast({
        title: "تم التسجيل",
        description: "تم إضافة المستوردات وخصمها من كشف الحساب بنجاح",
      });

      fetchImports();
      setIsOpen(false);
      resetForm();
    } catch (error) {
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ أثناء معالجة الطلب",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({
      supplier_name: "",
      supplier_phone: "",
      import_date: new Date().toISOString().split('T')[0],
      payment_method: "cash",
      paid_amount: 0,
      notes: ""
    });
    setCurrentItems([{ item_code: "", item_name: "", quantity: 1, unit_price: 0 }]);
  };

  const handleDelete = async (id: string) => {
    if (window.confirm("هل أنت متأكد من حذف هذا السجل؟")) {
      try {
        const { error } = await supabase
          .from('imports')
          .delete()
          .eq('id', id);

        if (error) throw error;

        toast({
          title: "تم الحذف",
          description: "تم حذف السجل بنجاح",
        });
        fetchImports();
      } catch (error) {
        console.error('Error deleting import:', error);
        toast({
          title: "خطأ",
          description: "حدث خطأ أثناء حذف السجل",
          variant: "destructive"
        });
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Package className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">المستوردات</h1>
              <p className="text-muted-foreground">إدارة المستوردات والمشتريات من الموردين</p>
            </div>
          </div>
          
          <Dialog open={isOpen} onOpenChange={(open) => {
            setIsOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button className="bg-primary hover:bg-primary/90">
                <Plus className="ml-2 h-4 w-4" />
                إضافة مستوردات جديدة
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>إضافة مستوردات جديدة</DialogTitle>
              </DialogHeader>
              
              <form onSubmit={handleSubmit} className="space-y-6">
                {/* Supplier Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="supplier_name">اسم المورد *</Label>
                    <Input
                      id="supplier_name"
                      value={formData.supplier_name}
                      onChange={(e) => setFormData({ ...formData, supplier_name: e.target.value })}
                      required
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="supplier_phone">هاتف المورد</Label>
                    <Input
                      id="supplier_phone"
                      value={formData.supplier_phone}
                      onChange={(e) => setFormData({ ...formData, supplier_phone: e.target.value })}
                      placeholder="01012345678"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="import_date">تاريخ المستوردات *</Label>
                    <Input
                      id="import_date"
                      type="date"
                      value={formData.import_date}
                      onChange={(e) => setFormData({ ...formData, import_date: e.target.value })}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="payment_method">طريقة الدفع</Label>
                    <Select
                      value={formData.payment_method}
                      onValueChange={(value) => setFormData({ ...formData, payment_method: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cash">كاش</SelectItem>
                        <SelectItem value="visa">فيزا</SelectItem>
                        <SelectItem value="instapay">إنستاباي</SelectItem>
                        <SelectItem value="later">آجل</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Payment & Total */}
                <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                  <div>
                    <Label className="text-sm text-muted-foreground">الإجمالي</Label>
                    <p className="text-2xl font-bold text-cyan-600">{calculateTotal().toFixed(2)} ج.م</p>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="paid_amount">المبلغ المدفوع</Label>
                    <Input
                      id="paid_amount"
                      type="number"
                      value={formData.paid_amount}
                      onChange={(e) => setFormData({ ...formData, paid_amount: Number(e.target.value) })}
                      min="0"
                      step="0.01"
                      max={calculateTotal()}
                    />
                  </div>

                  <div className="col-span-2">
                    <Label className="text-sm text-muted-foreground">المتبقي</Label>
                    <p className="text-xl font-bold text-primary">
                      {(calculateTotal() - Number(formData.paid_amount)).toFixed(2)} ج.م
                    </p>
                  </div>
                </div>

                {/* Notes */}
                <div className="space-y-2">
                  <Label htmlFor="notes">ملاحظات</Label>
                  <Textarea
                    id="notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    placeholder="أي ملاحظات إضافية..."
                    rows={3}
                  />
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsOpen(false);
                      resetForm();
                    }}
                  >
                    إلغاء
                  </Button>
                  <Button type="submit" disabled={loading}>
                    {loading ? "جاري الحفظ..." : "حفظ المستوردات"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Summary Card */}
        <Card className="shadow-soft mb-6">
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-cyan-100 rounded-lg flex items-center justify-center">
                <TrendingDown className="w-6 h-6 text-cyan-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">إجمالي المستوردات</p>
                <p className="text-3xl font-bold text-cyan-600">{totalImports.toFixed(2)} ج.م</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Imports Cards */}
        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>سجل المستوردات</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {imports.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Package className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد مستوردات مسجلة</p>
              </div>
            ) : (
              <div className="space-y-4">
                {imports.map((importRecord: any, index) => {
                  const paymentMethodLabel = 
                    importRecord.payment_method === 'cash' ? 'كاش' :
                    importRecord.payment_method === 'visa' ? 'فيزا' :
                    importRecord.payment_method === 'instapay' ? 'إنستاباي' : 'آجل';
                  
                  return (
                    <div 
                      key={importRecord.id}
                      className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                    >
                      <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-10 w-10 border-2 border-white">
                            <AvatarFallback className="text-xs bg-white text-cyan-600">
                              <Package className="w-5 h-5" />
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <h3 className="font-bold text-white text-lg">{importRecord.supplier_name}</h3>
                            <div className="flex items-center gap-2 text-xs text-cyan-50">
                              {importRecord.supplier_phone && (
                                <>
                                  <Phone className="w-3 h-3" />
                                  <span>{importRecord.supplier_phone}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(importRecord.id)}
                            className="h-8 w-8 p-0 text-white hover:bg-red-500/30"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      
                      <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <Calendar className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">التاريخ</span>
                          </div>
                          <p className="font-medium">{new Date(importRecord.import_date).toLocaleDateString('ar-SA')}</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <ShoppingCart className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">عدد الأصناف</span>
                          </div>
                          <p className="font-medium">{importRecord.items?.length || 0}</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <DollarSign className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">الإجمالي</span>
                          </div>
                          <p className="font-bold text-cyan-600">{Number(importRecord.total_amount).toFixed(2)} ج.م</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <DollarSign className="w-4 h-4 text-green-600" />
                            <span className="text-sm text-muted-foreground">المدفوع</span>
                          </div>
                          <p className="font-bold text-green-600">{Number(importRecord.paid_amount).toFixed(2)} ج.م</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <DollarSign className="w-4 h-4 text-orange-600" />
                            <span className="text-sm text-muted-foreground">المتبقي</span>
                          </div>
                          <p className="font-bold text-orange-600">{Number(importRecord.remaining_amount).toFixed(2)} ج.م</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <FileText className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">طريقة الدفع</span>
                          </div>
                          <p className="font-medium">{paymentMethodLabel}</p>
                        </div>
                        
                        {importRecord.notes && (
                          <div className="col-span-2">
                            <div className="flex items-center gap-2 mb-2">
                              <FileText className="w-4 h-4 text-cyan-600" />
                              <span className="text-sm text-muted-foreground">ملاحظات</span>
                            </div>
                            <p className="font-medium text-sm">{importRecord.notes}</p>
                          </div>
                        )}
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

export default Imports;
