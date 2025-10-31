import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DollarSign, Plus, CreditCard, AlertTriangle, CheckCircle, Search, Upload, X, Eye, Check, XCircle } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getGrades, getGroups, createFee, getFees, getPaymentRequests, approvePaymentRequest, rejectPaymentRequest, type PaymentRequest } from "@/lib/api-http";

const Fees = () => {
  const [fees, setFees] = useState([]);
  const [offlineFees, setOfflineFees] = useState([]);
  const [subscriptionRequests, setSubscriptionRequests] = useState<PaymentRequest[]>([]);
  
  const [isOpen, setIsOpen] = useState(false);
  const [isAddNewOpen, setIsAddNewOpen] = useState(false);
  const [isViewRequestOpen, setIsViewRequestOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<PaymentRequest | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [grades, setGrades] = useState([]);
  const [groups, setGroups] = useState([]);
  const [paymentData, setPaymentData] = useState({
    feeId: null,
    amount: "",
    paymentMethod: "cash",
    notes: ""
  });
  const [offlinePaymentData, setOfflinePaymentData] = useState({
    studentName: "",
    phone: "",
    gradeId: "",
    groupId: "",
    barcode: "",
    amount: "",
    notes: ""
  });
  const [paymentImage, setPaymentImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  
  const { toast } = useToast();

  useEffect(() => {
    if (isAddNewOpen) {
      loadGradesAndGroups();
      generateBarcode();
    }
  }, [isAddNewOpen]);

  useEffect(() => {
    loadPaymentRequests();
    loadFeesFromDB();
  }, []);

  const loadPaymentRequests = async () => {
    try {
      const requests = await getPaymentRequests('pending');
      setSubscriptionRequests(requests || []);
    } catch (error) {
      console.error('Error loading payment requests:', error);
    }
  };

  const loadFeesFromDB = async () => {
    try {
      const [onlineFees, offlineFeesData] = await Promise.all([
        getFees(false),
        getFees(true)
      ]);
      setFees(onlineFees || []);
      setOfflineFees(offlineFeesData || []);
    } catch (error) {
      console.error('Error loading fees:', error);
    }
  };

  const loadGradesAndGroups = async () => {
    try {
      const [gradesData, groupsData] = await Promise.all([
        getGrades(),
        getGroups()
      ]);
      setGrades(gradesData || []);
      setGroups(groupsData || []);
    } catch (error) {
      console.error('Error loading data:', error);
    }
  };

  const generateBarcode = () => {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    const barcode = `OFF${timestamp}${random}`;
    setOfflinePaymentData(prev => ({ ...prev, barcode }));
  };

  const filteredFees = fees.filter(fee => {
    const matchesSearch = fee.studentName.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || fee.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const handlePayment = (fee) => {
    setPaymentData({
      feeId: fee.id,
      amount: (fee.amount - fee.paidAmount).toString(),
      paymentMethod: "cash",
      notes: ""
    });
    setPaymentImage(null);
    setImagePreview(null);
    setIsOpen(true);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Check file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: "حجم الصورة كبير",
          description: "الحد الأقصى لحجم الصورة هو 5 ميجابايت",
          variant: "destructive",
        });
        return;
      }

      // Check file type
      if (!file.type.startsWith('image/')) {
        toast({
          title: "نوع الملف غير صحيح",
          description: "يرجى اختيار صورة فقط",
          variant: "destructive",
        });
        return;
      }

      setPaymentImage(file);
      
      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    setPaymentImage(null);
    setImagePreview(null);
  };

  const handleApproveRequest = async (request: PaymentRequest) => {
    try {
      await approvePaymentRequest(request.id);

      toast({
        title: "تم قبول الطلب",
        description: `تم قبول طلب الطالب ${request.studentName} وحفظه في قاعدة البيانات`,
      });

      setIsViewRequestOpen(false);
      setSelectedRequest(null);

      await Promise.all([loadPaymentRequests(), loadFeesFromDB()]);
    } catch (error) {
      console.error('Error approving request:', error);
      toast({
        title: "خطأ",
        description: "فشل حفظ البيانات في قاعدة البيانات",
        variant: "destructive",
      });
    }
  };

  const handleRejectRequest = async (request: PaymentRequest) => {
    try {
      await rejectPaymentRequest(request.id);

      toast({
        title: "تم رفض الطلب",
        description: `تم رفض طلب الطالب ${request.studentName}`,
        variant: "destructive",
      });

      setIsViewRequestOpen(false);
      setSelectedRequest(null);

      await loadPaymentRequests();
    } catch (error) {
      console.error('Error rejecting request:', error);
      toast({
        title: "خطأ",
        description: "فشل تحديث حالة الطلب",
        variant: "destructive",
      });
    }
  };

  const processOfflinePayment = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const selectedGrade = grades.find(g => g.id === offlinePaymentData.gradeId);
      const selectedGroup = groups.find(g => g.id === offlinePaymentData.groupId);
      const paidAmount = parseFloat(offlinePaymentData.amount) || 0;

      const feeData = {
        student_name: offlinePaymentData.studentName,
        phone: offlinePaymentData.phone,
        grade_id: offlinePaymentData.gradeId,
        grade_name: selectedGrade?.name || '',
        group_id: offlinePaymentData.groupId,
        group_name: selectedGroup?.name || '',
        barcode: offlinePaymentData.barcode,
        amount: paidAmount,
        paid_amount: paidAmount,
        status: 'paid',
        payment_method: 'cash',
        is_offline: true,
        notes: offlinePaymentData.notes,
        due_date: new Date().toISOString().split('T')[0],
        payment_date: new Date().toISOString().split('T')[0]
      };

      const createdFee = await createFee(feeData);
      
      setOfflineFees([...offlineFees, createdFee]);
      
      toast({
        title: "تم إضافة الطالب بنجاح",
        description: `تم تسجيل الطالب ${offlinePaymentData.studentName} وحفظه في قاعدة البيانات`,
      });
      
      setIsAddNewOpen(false);
      setOfflinePaymentData({
        studentName: "",
        phone: "",
        gradeId: "",
        groupId: "",
        barcode: "",
        amount: "",
        notes: ""
      });
    } catch (error) {
      console.error('Error creating offline fee:', error);
      toast({
        title: "خطأ",
        description: "فشل حفظ البيانات في قاعدة البيانات",
        variant: "destructive",
      });
    }
  };

  const processPayment = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!paymentImage) {
      toast({
        title: "يرجى رفع صورة الإيصال",
        description: "قم برفع صورة إيصال الدفع أولاً",
        variant: "destructive",
      });
      return;
    }
    
    setFees(fees.map(fee => {
      if (fee.id === paymentData.feeId) {
        const newPaidAmount = fee.paidAmount + parseFloat(paymentData.amount);
        const newStatus = newPaidAmount >= fee.amount ? "مدفوع" : "جزئي";
        
        return {
          ...fee,
          paidAmount: newPaidAmount,
          status: newStatus,
          paymentDate: new Date().toISOString().split('T')[0]
        };
      }
      return fee;
    }));
    
    toast({
      title: "تم تسجيل الدفع بنجاح",
      description: "تم تحديث حالة المصروفات وحفظ صورة الإيصال",
    });
    
    setIsOpen(false);
    setPaymentData({ feeId: null, amount: "", paymentMethod: "cash", notes: "" });
    removeImage();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'مدفوع':
        return 'bg-green-100 text-green-800';
      case 'جزئي':
        return 'bg-yellow-100 text-yellow-800';
      case 'متأخر':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'مدفوع':
        return <CheckCircle className="w-4 h-4 text-green-600" />;
      case 'جزئي':
        return <CreditCard className="w-4 h-4 text-yellow-600" />;
      case 'متأخر':
        return <AlertTriangle className="w-4 h-4 text-red-600" />;
      default:
        return <DollarSign className="w-4 h-4 text-gray-600" />;
    }
  };

  const totalFees = fees.reduce((sum, fee) => sum + fee.amount, 0);
  const totalPaid = fees.reduce((sum, fee) => sum + fee.paidAmount, 0);
  const totalRemaining = totalFees - totalPaid;

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
              <h1 className="text-2xl font-bold text-foreground">إدارة المصروفات</h1>
              <p className="text-muted-foreground">متابعة مدفوعات الطلاب والرسوم</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
          <Card className="shadow-soft">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-green-100 rounded-lg flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">المبلغ المحصل</p>
                  <p className="text-2xl font-bold text-green-600">{totalPaid} ج.م</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="shadow-soft">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">المبلغ المتبقي</p>
                  <p className="text-2xl font-bold text-red-600">{totalRemaining} ج.م</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Online Students Fees */}
        <Card className="shadow-soft mb-6">
          <CardHeader className="bg-gradient-to-r from-blue-50 to-cyan-50 dark:from-blue-950 dark:to-cyan-950">
            <CardTitle className="flex items-center gap-2">
              <span>💻</span>
              كشف المصروفات - الطلاب الأونلاين
            </CardTitle>
            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="البحث عن طالب..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="max-w-sm"
                />
              </div>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="max-w-[200px]">
                  <SelectValue placeholder="تصفية حسب الحالة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">جميع الحالات</SelectItem>
                  <SelectItem value="مدفوع">مدفوع</SelectItem>
                  <SelectItem value="جزئي">جزئي</SelectItem>
                  <SelectItem value="متأخر">متأخر</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {subscriptionRequests.length > 0 && (
              <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <h3 className="font-semibold text-yellow-800 mb-3">طلبات الاشتراك المعلقة ({subscriptionRequests.length})</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>الطالب</TableHead>
                      <TableHead>الموبايل</TableHead>
                      <TableHead>الصف</TableHead>
                      <TableHead>المجموعة</TableHead>
                      <TableHead>التاريخ</TableHead>
                      <TableHead>الإجراءات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {subscriptionRequests.map((request) => (
                      <TableRow key={request.id}>
                        <TableCell className="font-medium">{request.studentName}</TableCell>
                        <TableCell>{request.phone}</TableCell>
                        <TableCell>{request.gradeName}</TableCell>
                        <TableCell>{request.groupName}</TableCell>
                        <TableCell>{new Date(request.createdAt).toLocaleDateString('ar-EG')}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedRequest(request);
                              setIsViewRequestOpen(true);
                            }}
                            className="text-xs"
                          >
                            <Eye className="w-3 h-3 ml-1" />
                            عرض
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الطالب</TableHead>
                  <TableHead>الكورس</TableHead>
                  <TableHead>المبلغ المطلوب</TableHead>
                  <TableHead>المبلغ المدفوع</TableHead>
                  <TableHead>المتبقي</TableHead>
                  <TableHead>تاريخ الاستحقاق</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredFees.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      لا توجد مصروفات للطلاب الأونلاين
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredFees.map((fee) => (
                    <TableRow key={fee.id}>
                      <TableCell className="font-medium">{fee.studentName}</TableCell>
                      <TableCell>{fee.course}</TableCell>
                      <TableCell>{fee.amount} ج.م</TableCell>
                      <TableCell>{fee.paidAmount} ج.م</TableCell>
                      <TableCell className="font-medium text-red-600">
                        {fee.amount - fee.paidAmount} ج.م
                      </TableCell>
                      <TableCell>{fee.dueDate}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getStatusIcon(fee.status)}
                          <span className={`px-2 py-1 rounded-full text-xs ${getStatusColor(fee.status)}`}>
                            {fee.status}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {fee.status !== "مدفوع" && (
                          <Button
                            size="sm"
                            onClick={() => handlePayment(fee)}
                            className="text-xs"
                          >
                            <CreditCard className="w-3 h-3 ml-1" />
                            دفع
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Offline Students Fees */}
        <Card className="shadow-soft">
          <CardHeader className="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-950 dark:to-pink-950">
            <div className="flex items-center justify-between mb-4">
              <CardTitle className="flex items-center gap-2">
                <span>👤</span>
                كشف المصروفات - الطلاب الأوفلاين
              </CardTitle>
              <Dialog open={isAddNewOpen} onOpenChange={setIsAddNewOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-purple-600 hover:bg-purple-700">
                    <Plus className="w-4 h-4 ml-2" />
                    إضافة طالب
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>إضافة طالب أوفلاين</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={processOfflinePayment} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="offlineStudentName">اسم الطالب *</Label>
                      <Input
                        id="offlineStudentName"
                        type="text"
                        value={offlinePaymentData.studentName}
                        onChange={(e) => setOfflinePaymentData(prev => ({ ...prev, studentName: e.target.value }))}
                        placeholder="أدخل اسم الطالب"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="offlinePhone">رقم الموبايل *</Label>
                      <Input
                        id="offlinePhone"
                        type="tel"
                        value={offlinePaymentData.phone}
                        onChange={(e) => setOfflinePaymentData(prev => ({ ...prev, phone: e.target.value }))}
                        placeholder="01xxxxxxxxx"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="offlineGrade">الصف الدراسي *</Label>
                      <Select value={offlinePaymentData.gradeId} onValueChange={(value) => setOfflinePaymentData(prev => ({ ...prev, gradeId: value }))}>
                        <SelectTrigger>
                          <SelectValue placeholder="اختر الصف الدراسي" />
                        </SelectTrigger>
                        <SelectContent>
                          {grades.map((grade) => (
                            <SelectItem key={grade.id} value={grade.id}>
                              {grade.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="offlineGroup">المجموعة *</Label>
                      <Select value={offlinePaymentData.groupId} onValueChange={(value) => setOfflinePaymentData(prev => ({ ...prev, groupId: value }))}>
                        <SelectTrigger>
                          <SelectValue placeholder="اختر المجموعة" />
                        </SelectTrigger>
                        <SelectContent>
                          {groups.map((group) => (
                            <SelectItem key={group.id} value={group.id}>
                              {group.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="offlineBarcode">الباركود</Label>
                      <Input
                        id="offlineBarcode"
                        type="text"
                        value={offlinePaymentData.barcode}
                        readOnly
                        className="bg-muted font-mono"
                      />
                      <p className="text-xs text-muted-foreground">تم توليد الباركود تلقائياً</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="offlineAmount">المبلغ المدفوع *</Label>
                      <Input
                        id="offlineAmount"
                        type="number"
                        value={offlinePaymentData.amount}
                        onChange={(e) => setOfflinePaymentData(prev => ({ ...prev, amount: e.target.value }))}
                        placeholder="أدخل المبلغ بالجنيه"
                        required
                        min="0"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="offlineNotes">ملاحظات</Label>
                      <Textarea
                        id="offlineNotes"
                        value={offlinePaymentData.notes}
                        onChange={(e) => setOfflinePaymentData(prev => ({ ...prev, notes: e.target.value }))}
                        placeholder="أضف ملاحظاتك هنا..."
                        rows={3}
                      />
                    </div>
                    <Button type="submit" className="w-full bg-purple-600 hover:bg-purple-700">
                      إضافة الطالب
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="البحث عن طالب..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="max-w-sm"
                />
              </div>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="max-w-[200px]">
                  <SelectValue placeholder="تصفية حسب الحالة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">جميع الحالات</SelectItem>
                  <SelectItem value="مدفوع">مدفوع</SelectItem>
                  <SelectItem value="جزئي">جزئي</SelectItem>
                  <SelectItem value="متأخر">متأخر</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الطالب</TableHead>
                  <TableHead>الكورس</TableHead>
                  <TableHead>المبلغ المطلوب</TableHead>
                  <TableHead>المبلغ المدفوع</TableHead>
                  <TableHead>المتبقي</TableHead>
                  <TableHead>تاريخ الاستحقاق</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offlineFees.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      لا توجد مصروفات للطلاب الأوفلاين
                    </TableCell>
                  </TableRow>
                ) : (
                  offlineFees.map((fee) => (
                    <TableRow key={fee.id}>
                      <TableCell className="font-medium">{fee.studentName}</TableCell>
                      <TableCell>{fee.course}</TableCell>
                      <TableCell>{fee.amount} ج.م</TableCell>
                      <TableCell>{fee.paidAmount} ج.م</TableCell>
                      <TableCell className="font-medium text-red-600">
                        {fee.amount - fee.paidAmount} ج.م
                      </TableCell>
                      <TableCell>{fee.dueDate}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {getStatusIcon(fee.status)}
                          <span className={`px-2 py-1 rounded-full text-xs ${getStatusColor(fee.status)}`}>
                            {fee.status}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {fee.status !== "مدفوع" && (
                          <Button
                            size="sm"
                            onClick={() => handlePayment(fee)}
                            className="text-xs"
                          >
                            <CreditCard className="w-3 h-3 ml-1" />
                            دفع
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>تسجيل دفعة جديدة</DialogTitle>
            </DialogHeader>
            <form onSubmit={processPayment} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="amount">المبلغ المدفوع</Label>
                <Input
                  id="amount"
                  type="number"
                  value={paymentData.amount}
                  onChange={(e) => setPaymentData(prev => ({ ...prev, amount: e.target.value }))}
                  placeholder="أدخل المبلغ"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="paymentMethod">طريقة الدفع</Label>
                <Select value={paymentData.paymentMethod} onValueChange={(value) => setPaymentData(prev => ({ ...prev, paymentMethod: value }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">نقدي</SelectItem>
                    <SelectItem value="bank">تحويل بنكي</SelectItem>
                    <SelectItem value="card">بطاقة ائتمان</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="notes">ملاحظات</Label>
                <Input
                  id="notes"
                  value={paymentData.notes}
                  onChange={(e) => setPaymentData(prev => ({ ...prev, notes: e.target.value }))}
                  placeholder="ملاحظات إضافية"
                />
              </div>
              <div className="space-y-2">
                <Label>صورة إيصال الدفع *</Label>
                <div className="mt-2">
                  {!imagePreview ? (
                    <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                      <div className="flex flex-col items-center justify-center pt-5 pb-6">
                        <Upload className="w-8 h-8 mb-2 text-gray-400" />
                        <p className="text-sm text-gray-500">اضغط لرفع صورة الإيصال</p>
                        <p className="text-xs text-gray-400 mt-1">PNG, JPG (حد أقصى 5MB)</p>
                      </div>
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*"
                        onChange={handleImageChange}
                      />
                    </label>
                  ) : (
                    <div className="relative">
                      <img
                        src={imagePreview}
                        alt="معاينة الإيصال"
                        className="w-full h-48 object-cover rounded-lg border-2 border-gray-200"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute top-2 left-2"
                        onClick={removeImage}
                      >
                        <X className="w-4 h-4 ml-1" />
                        حذف
                      </Button>
                    </div>
                  )}
                </div>
              </div>
              <Button type="submit" className="w-full">
                تسجيل الدفعة
              </Button>
            </form>
          </DialogContent>
        </Dialog>

        {/* View Subscription Request Dialog */}
        <Dialog open={isViewRequestOpen} onOpenChange={setIsViewRequestOpen}>
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>تفاصيل طلب الاشتراك</DialogTitle>
            </DialogHeader>
            {selectedRequest && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">اسم الطالب</Label>
                    <p className="font-medium">{selectedRequest.studentName}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">رقم الموبايل</Label>
                    <p className="font-medium">{selectedRequest.phone}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">الصف الدراسي</Label>
                    <p className="font-medium">{selectedRequest.gradeName}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">المجموعة</Label>
                    <p className="font-medium">{selectedRequest.groupName}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">المبلغ المدفوع</Label>
                    <p className="font-medium text-green-600">{selectedRequest.amount} ج.م</p>
                  </div>
                </div>
                
                {selectedRequest.notes && (
                  <div>
                    <Label className="text-muted-foreground">الملاحظات</Label>
                    <p className="mt-1 p-3 bg-muted rounded-lg">{selectedRequest.notes}</p>
                  </div>
                )}

                {selectedRequest.receiptImageUrl && (
                  <div>
                    <Label className="text-muted-foreground">صورة إيصال الدفع</Label>
                    <img
                      src={selectedRequest.receiptImageUrl}
                      alt="إيصال الدفع"
                      className="mt-2 w-full rounded-lg border-2 border-gray-200"
                    />
                  </div>
                )}

                <div className="flex gap-3 pt-4">
                  <Button
                    className="flex-1 bg-green-600 hover:bg-green-700"
                    onClick={() => handleApproveRequest(selectedRequest)}
                  >
                    <Check className="w-4 h-4 ml-2" />
                    قبول
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1"
                    onClick={() => handleRejectRequest(selectedRequest)}
                  >
                    <XCircle className="w-4 h-4 ml-2" />
                    رفض
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default Fees;