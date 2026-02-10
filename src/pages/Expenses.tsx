import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DollarSign, Plus, Edit2, Trash2, TrendingDown, Calendar } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getExpenses, createExpense, updateExpense, deleteExpense, type Expense } from "@/lib/api-http";

const Expenses = () => {
  const [expenses, setExpenses] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    description: "",
    amount: "",
    category: ""
  });

  const { toast } = useToast();

  const fetchExpenses = async () => {
    try {
      const data = await getExpenses();
      setExpenses(data || []);
    } catch (error) {
      console.error('Error fetching expenses:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل المصروفات",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    fetchExpenses();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const now = new Date();
      const expenseData = {
        description: formData.description,
        amount: parseFloat(formData.amount),
        category: formData.category,
        date: now.toISOString().split('T')[0],
        time: now.toTimeString().split(' ')[0]
      };

      if (editingExpense) {
        await updateExpense(editingExpense.id, expenseData);

        toast({
          title: "تم التحديث بنجاح",
          description: "تم تحديث بيانات المصروف",
        });
      } else {
        await createExpense(expenseData);

        toast({
          title: "تم الإضافة بنجاح",
          description: "تم إضافة مصروف جديد",
        });
      }

      fetchExpenses();
      setIsOpen(false);
      setEditingExpense(null);
      setFormData({ description: "", amount: "", category: "" });
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

  const handleEdit = (expense) => {
    setEditingExpense(expense);
    setFormData({
      description: expense.description,
      amount: expense.amount.toString(),
      category: expense.category || ""
    });
    setIsOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await deleteExpense(id);

      fetchExpenses();
      toast({
        title: "تم الحذف بنجاح",
        description: "تم حذف المصروف",
      });
    } catch (error) {
      toast({
        title: "خطأ",
        description: "حدث خطأ في الحذف",
        variant: "destructive",
      });
    }
  };

  const totalExpenses = expenses.reduce((sum, expense) => sum + parseFloat(expense.amount || 0), 0);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4 md:gap-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <TrendingDown className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">إدارة المصروفات</h1>
              <p className="text-muted-foreground">تسجيل ومتابعة مصروفات السنتر</p>
            </div>
          </div>

          <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
              <Button className="shadow-medium w-full md:w-auto">
                <Plus className="w-4 h-4 ml-2" />
                إضافة مصروف جديد
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {editingExpense ? "تعديل المصروف" : "إضافة مصروف جديد"}
                </DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="description">الوصف</Label>
                  <Input
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="وصف المصروف"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="amount">المبلغ</Label>
                  <Input
                    id="amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.amount}
                    onChange={(e) => setFormData(prev => ({ ...prev, amount: e.target.value }))}
                    placeholder="المبلغ بالجنيه"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="category">الفئة</Label>
                  <Input
                    id="category"
                    value={formData.category}
                    onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                    placeholder="مثال: إيجار، رواتب، كهرباء"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "جاري المعالجة..." : (editingExpense ? "تحديث المصروف" : "إضافة المصروف")}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card className="shadow-soft">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
                  <TrendingDown className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">إجمالي المصروفات</p>
                  <p className="text-2xl font-bold text-red-600">{totalExpenses.toFixed(2)} ج.م</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
                  <DollarSign className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">عدد المصروفات</p>
                  <p className="text-2xl font-bold text-primary">{expenses.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>سجل المصروفات</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {expenses.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <DollarSign className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد مصروفات مسجلة</p>
              </div>
            ) : (
              <div className="space-y-4">
                {expenses.map((expense) => (
                  <div
                    key={expense.id}
                    className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                  >
                    <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
                      <div className="flex items-center gap-3 w-full sm:w-auto">
                        <Avatar className="h-10 w-10 border-2 border-white shrink-0">
                          <AvatarFallback className="text-xs bg-white text-cyan-600">
                            <DollarSign className="w-5 h-5" />
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <h3 className="font-bold text-white text-lg truncate">{expense.description}</h3>
                          <div className="flex items-center gap-2 text-xs text-cyan-50">
                            {expense.category && (
                              <span>🏷️ {expense.category}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2 self-end sm:self-auto">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(expense)}
                          className="h-8 w-8 p-0 text-white hover:bg-white/20"
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(expense.id)}
                          className="h-8 w-8 p-0 text-white hover:bg-red-500/30"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📝 الوصف</div>
                        <div className="text-sm font-medium">{expense.description}</div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">🏷️ الفئة</div>
                        <div className="text-sm font-medium">{expense.category || '-'}</div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">💰 المبلغ</div>
                        <div className="text-sm font-bold text-red-600 dark:text-red-400">
                          {parseFloat(expense.amount).toFixed(2)} ج.م
                        </div>
                      </div>

                      <div>
                        <div className="text-xs font-semibold text-cyan-600 dark:text-cyan-400 mb-1">📅 التاريخ</div>
                        <div className="text-sm font-medium flex items-center gap-2">
                          <Calendar className="w-3 h-3 text-muted-foreground" />
                          {expense.date ? new Date(expense.date).toLocaleDateString('ar-SA') : '-'}
                        </div>
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

export default Expenses;