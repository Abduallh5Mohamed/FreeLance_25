import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, DollarSign, AlertTriangle } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

const Profits = () => {
  const [totalIncome, setTotalIncome] = useState(0);
  const [totalExpenses, setTotalExpenses] = useState(0);
  const [netProfit, setNetProfit] = useState(0);
  const { toast } = useToast();

  useEffect(() => {
    fetchFinancialData();
  }, []);

  const fetchFinancialData = async () => {
    try {
      // Fetch total income from account statements
      const { data: incomeData, error: incomeError } = await supabase
        .from('account_statement')
        .select('amount');

      if (incomeError) throw incomeError;

      const income = incomeData?.reduce((sum, item) => sum + Number(item.amount), 0) || 0;
      setTotalIncome(income);

      // Fetch total expenses
      const { data: expensesData, error: expensesError } = await supabase
        .from('expenses')
        .select('amount');

      if (expensesError) throw expensesError;

      const expenses = expensesData?.reduce((sum, item) => sum + Number(item.amount), 0) || 0;
      setTotalExpenses(expenses);

      // Calculate net profit
      const profit = income - expenses;
      setNetProfit(profit);
    } catch (error) {
      console.error('Error fetching financial data:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل البيانات المالية",
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
              <TrendingUp className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">تقرير الأرباح</h1>
              <p className="text-muted-foreground">الإيرادات والمصروفات وصافي الربح</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card className="shadow-soft">
            <CardContent className="p-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <DollarSign className="w-6 h-6 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">إجمالي الإيرادات</p>
                  <p className="text-2xl font-bold text-green-600">{totalIncome.toFixed(2)} ج.م</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">إجمالي المصروفات</p>
                  <p className="text-2xl font-bold text-red-600">{totalExpenses.toFixed(2)} ج.م</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-6">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${netProfit >= 0 ? 'bg-cyan-100' : 'bg-cyan-100'}`}>
                  <TrendingUp className={`w-6 h-6 ${netProfit >= 0 ? 'text-cyan-600' : 'text-cyan-600'}`} />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">صافي الربح</p>
                  <p className={`text-2xl font-bold ${netProfit >= 0 ? 'text-cyan-600' : 'text-cyan-600'}`}>
                    {netProfit.toFixed(2)} ج.م
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>ملخص مالي</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center p-4 bg-muted rounded-lg">
                <span className="font-medium">نسبة الربح من الإيرادات:</span>
                <span className="text-lg font-bold text-primary">
                  {totalIncome > 0 ? ((netProfit / totalIncome) * 100).toFixed(2) : 0}%
                </span>
              </div>
              <div className="flex justify-between items-center p-4 bg-muted rounded-lg">
                <span className="font-medium">متوسط المصروفات الشهرية:</span>
                <span className="text-lg font-bold text-primary">
                  {(totalExpenses / 12).toFixed(2)} ج.م
                </span>
              </div>
              <div className="flex justify-between items-center p-4 bg-muted rounded-lg">
                <span className="font-medium">متوسط الإيرادات الشهرية:</span>
                <span className="text-lg font-bold text-primary">
                  {(totalIncome / 12).toFixed(2)} ج.م
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Profits;