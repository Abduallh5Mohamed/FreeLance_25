import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Wallet,
  ArrowUpCircle,
  ArrowDownCircle,
  TrendingUp,
  TrendingDown,
  Filter,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import Header from '@/components/Header';
import {
  getInstructorWallet,
  getInstructorWalletTransactions,
  InstructorWalletTransaction,
  User,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export default function InstructorWallet() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [transactions, setTransactions] = useState<InstructorWalletTransaction[]>([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [typeFilter, setTypeFilter] = useState<'all' | 'credit' | 'debit'>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (!userStr) { navigate('/auth'); return; }
    const user = JSON.parse(userStr) as User;
    if (user.role !== 'instructor' && user.role !== 'admin') {
      navigate('/auth'); return;
    }
    setCurrentUser(user);
    loadWallet(user.id, 1, 'all');
  }, []);

  const loadWallet = async (id: string, page: number, type: string) => {
    try {
      setLoading(true);
      const [walletData, txData] = await Promise.allSettled([
        getInstructorWallet(id),
        getInstructorWalletTransactions(id, page, 15, type !== 'all' ? (type as 'credit' | 'debit') : undefined),
      ]);
      if (walletData.status === 'fulfilled') setWallet(walletData.value);
      if (txData.status === 'fulfilled') {
        setTransactions(txData.value.data || []);
        setPagination(txData.value.pagination || { page: 1, pages: 1, total: 0 });
      }
    } catch (err) {
      toast({ variant: 'destructive', title: 'خطأ', description: 'فشل في تحميل بيانات المحفظة' });
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (val: string) => {
    setTypeFilter(val as any);
    if (currentUser) loadWallet(currentUser.id, 1, val);
  };

  const handlePageChange = (newPage: number) => {
    if (currentUser) loadWallet(currentUser.id, newPage, typeFilter);
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleString('ar-EG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-emerald-50 to-teal-50" dir="rtl">
      <Header />

      <main className="container mx-auto px-4 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent flex items-center gap-2">
            <Wallet className="w-8 h-8 text-emerald-600" />
            رصيد خدمات المنصة
          </h1>
          <p className="text-slate-500 mt-1">رصيد خدماتك لدى المنصة، وليس مدفوعات الطلاب التي تصلك مباشرة.</p>
        </motion.div>

        {/* Balance card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }}>
            <Card className="border-0 shadow-lg overflow-hidden md:col-span-1">
              <div className="bg-gradient-to-br from-emerald-500 to-teal-600 p-6 text-white">
                <Wallet className="w-8 h-8 opacity-70 mb-3" />
                <p className="text-sm opacity-80">الرصيد الحالي</p>
                <p className="text-4xl font-bold mt-1">
                  {loading ? '…' : Number(wallet?.balance ?? 0).toFixed(2)}
                  <span className="text-lg mr-1 opacity-80">ج.م</span>
                </p>
                {wallet?.last_updated && (
                  <p className="text-xs opacity-60 mt-2">آخر تحديث: {formatDate(wallet.last_updated)}</p>
                )}
              </div>
            </Card>
          </motion.div>

          {/* Summary stats */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <Card className="border-0 shadow-lg h-full">
              <CardContent className="p-6 flex flex-col justify-center gap-4 h-full">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-emerald-600">
                    <TrendingUp className="w-5 h-5" />
                    <span className="text-sm font-medium">إجمالي الإيداعات</span>
                  </div>
                  <span className="font-bold text-emerald-600">
                    +{Number(wallet?.summary?.total_credited ?? 0).toFixed(2)} ج.م
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-red-500">
                    <TrendingDown className="w-5 h-5" />
                    <span className="text-sm font-medium">إجمالي الخصومات</span>
                  </div>
                  <span className="font-bold text-red-500">
                    -{Number(wallet?.summary?.total_debited ?? 0).toFixed(2)} ج.م
                  </span>
                </div>
                <div className="text-xs text-slate-400 border-t pt-3">
                  {wallet?.summary?.credit_count ?? 0} إيداع · {wallet?.summary?.debit_count ?? 0} خصم
                </div>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <Card className="border-0 shadow-lg h-full">
              <CardContent className="p-6 flex flex-col justify-center gap-3 h-full">
                <p className="text-sm font-medium text-slate-600">ملاحظات</p>
                <ul className="text-xs text-slate-500 space-y-2 list-disc list-inside">
                  <li>ترفع إيصال الشحن بنفسك، ولا يُضاف المبلغ إلا بعد اعتماد الإدارة</li>
                  <li>شحن «أخرى» لا يجدد الاشتراك دون إذن منك</li>
                  <li>خصم التجديد يتم كاملًا وعند انتهاء الفترة فقط</li>
                  <li>يُخصم الرصيد تلقائياً عند قبول طلب فيديو مدفوع</li>
                </ul>
                <Button asChild size="sm"><Link to="/instructor-subscription">شحن الرصيد وإدارة التجديد</Link></Button>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Transactions table */}
        <Card className="border-0 shadow-lg">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-slate-700 flex items-center gap-2">
              <RefreshCw className="w-5 h-5" />
              سجل المعاملات ({pagination.total})
            </CardTitle>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-400" />
              <Select value={typeFilter} onValueChange={handleFilterChange}>
                <SelectTrigger className="w-36 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  <SelectItem value="credit">إيداعات فقط</SelectItem>
                  <SelectItem value="debit">خصومات فقط</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-12 text-slate-400">جاري التحميل…</div>
            ) : transactions.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <Wallet className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p>لا توجد معاملات</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-slate-500 text-right">
                        <th className="pb-3 pr-2">النوع</th>
                        <th className="pb-3">المبلغ</th>
                        <th className="pb-3">الرصيد بعد</th>
                        <th className="pb-3">الوصف</th>
                        <th className="pb-3">التاريخ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {transactions.map(tx => (
                        <tr key={tx.id} className="hover:bg-slate-50 transition-colors">
                          <td className="py-3 pr-2">
                            {tx.type === 'credit' ? (
                              <div className="flex items-center gap-1 text-emerald-600">
                                <ArrowUpCircle className="w-4 h-4" />
                                <Badge variant="outline" className="border-emerald-300 text-emerald-600 text-xs">إيداع</Badge>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1 text-red-500">
                                <ArrowDownCircle className="w-4 h-4" />
                                <Badge variant="outline" className="border-red-300 text-red-500 text-xs">خصم</Badge>
                              </div>
                            )}
                          </td>
                          <td className={`py-3 font-bold ${tx.type === 'credit' ? 'text-emerald-600' : 'text-red-500'}`}>
                            {tx.type === 'credit' ? '+' : '-'}{Number(tx.amount).toFixed(2)} ج.م
                          </td>
                          <td className="py-3 text-slate-600">{Number(tx.balance_after).toFixed(2)} ج.م</td>
                          <td className="py-3 text-slate-600 max-w-xs truncate">{tx.description}</td>
                          <td className="py-3 text-slate-400 text-xs whitespace-nowrap">{formatDate(tx.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {pagination.pages > 1 && (
                  <div className="flex items-center justify-center gap-2 mt-6">
                    <Button variant="outline" size="sm"
                      disabled={pagination.page <= 1}
                      onClick={() => handlePageChange(pagination.page - 1)}>
                      السابق
                    </Button>
                    <span className="text-sm text-slate-500">
                      {pagination.page} / {pagination.pages}
                    </span>
                    <Button variant="outline" size="sm"
                      disabled={pagination.page >= pagination.pages}
                      onClick={() => handlePageChange(pagination.page + 1)}>
                      التالي
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
