import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DollarSign, TrendingUp, Search, Calendar, User, FileText } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";

const AccountStatement = () => {
  const [statements, setStatements] = useState([]);
  const [totalIncome, setTotalIncome] = useState(0);
  const [searchTerm, setSearchTerm] = useState("");
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
          <CardHeader className="space-y-3">
            <CardTitle>سجل المدفوعات</CardTitle>
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <Input
                placeholder="البحث عن طالب..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full"
              />
            </div>
          </CardHeader>
          <CardContent className="p-4">
            {statements.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <DollarSign className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد سجلات مدفوعات</p>
              </div>
            ) : (
              <div className="space-y-4">
                {statements
                  .filter(statement => 
                    !searchTerm || 
                    statement.students?.name?.toLowerCase().includes(searchTerm.toLowerCase())
                  )
                  .map((statement, index) => (
                    <div 
                      key={statement.id}
                      className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                    >
                      <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-cyan-600 font-bold text-sm">
                            {statement.students?.name?.charAt(0) || 'ط'}
                          </div>
                          <div>
                            <h3 className="font-bold text-white text-lg">{statement.students?.name || 'غير محدد'}</h3>
                            <div className="flex items-center gap-2 text-xs text-cyan-50">
                              <span>{statement.subscriptions?.name || "غير محدد"}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-left">
                          <p className="text-white text-xs opacity-90">المبلغ</p>
                          <p className="text-white font-bold text-lg">{Number(statement.amount).toFixed(2)} ج.م</p>
                        </div>
                      </div>
                      
                      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <User className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">الطالب</span>
                          </div>
                          <p className="font-medium">{statement.students?.name || 'غير محدد'}</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <FileText className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">نوع الاشتراك</span>
                          </div>
                          <p className="font-medium">{statement.subscriptions?.name || "غير محدد"}</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <DollarSign className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">المبلغ</span>
                          </div>
                          <p className="font-bold text-green-600">{Number(statement.amount).toFixed(2)} ج.م</p>
                        </div>
                        
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <Calendar className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">تاريخ الدفع</span>
                          </div>
                          <p className="font-medium">{new Date(statement.payment_date).toLocaleDateString('ar-SA')}</p>
                        </div>
                        
                        <div className="md:col-span-2">
                          <div className="flex items-center gap-2 mb-2">
                            <FileText className="w-4 h-4 text-cyan-600" />
                            <span className="text-sm text-muted-foreground">الوصف</span>
                          </div>
                          <p className="font-medium">{statement.description || "-"}</p>
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

export default AccountStatement;