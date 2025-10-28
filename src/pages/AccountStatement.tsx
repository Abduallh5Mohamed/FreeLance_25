import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DollarSign, TrendingUp } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";

const AccountStatement = () => {
  const [statements, setStatements] = useState([]);
  const [totalIncome, setTotalIncome] = useState(0);
  const { toast } = useToast();

  useEffect(() => {
    fetchAccountStatements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAccountStatements = async () => {
    try {
      // TODO: Add account_statement API endpoint
      setStatements([]);
      setTotalIncome(0);

      toast({
        title: "قريباً",
        description: "سيتم إضافة كشف الحساب قريباً",
      });
    } catch (error) {
      console.error('Error fetching statements:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ في تحميل البيانات",
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
              <DollarSign className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">كشف الحساب</h1>
              <p className="text-muted-foreground">إجمالي رسوم الاشتراكات المحصلة</p>
            </div>
          </div>
        </div>

        <Card className="shadow-soft mb-6">
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">إجمالي الإيرادات</p>
                <p className="text-3xl font-bold text-green-600">{totalIncome.toFixed(2)} ج.م</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle>سجل المدفوعات</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الطالب</TableHead>
                  <TableHead>نوع الاشتراك</TableHead>
                  <TableHead>المبلغ</TableHead>
                  <TableHead>تاريخ الدفع</TableHead>
                  <TableHead>الوصف</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statements.map((statement) => (
                  <TableRow key={statement.id}>
                    <TableCell className="font-medium">{statement.students?.name}</TableCell>
                    <TableCell>{statement.subscriptions?.name || "غير محدد"}</TableCell>
                    <TableCell className="text-green-600 font-medium">{Number(statement.amount).toFixed(2)} ج.م</TableCell>
                    <TableCell>{new Date(statement.payment_date).toLocaleDateString('ar-SA')}</TableCell>
                    <TableCell>{statement.description || "-"}</TableCell>
                  </TableRow>
                ))}
                {statements.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      لا توجد سجلات مدفوعات
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AccountStatement;