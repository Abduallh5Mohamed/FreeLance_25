import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DollarSign, Plus, CreditCard, AlertTriangle, CheckCircle, Search, Upload, X, Eye, Check, XCircle, User, Calendar, Edit2, Trash2, MessageCircle } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";
import { getGrades, getGroups, createFee, getFees, getStudentByPhone, getStudentById, getStudents, getSubscriptionRequests, approveSubscriptionRequest, rejectSubscriptionRequest, deleteFee, cleanupApprovedRequestsByMonth } from "@/lib/api-http";

const Fees = () => {
  const [fees, setFees] = useState([]);
  // تمت إزالة عرض الأوفلاين من الواجهة؛ نحافظ على الحالة إن احتجنا لاحقاً
  const [offlineFees, setOfflineFees] = useState([]);
  const [subscriptionRequests, setSubscriptionRequests] = useState([]);
  const [approvedRequests, setApprovedRequests] = useState([]);

  const [isOpen, setIsOpen] = useState(false);
  const [isAddNewOpen, setIsAddNewOpen] = useState(false);
  const [isViewRequestOpen, setIsViewRequestOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [grades, setGrades] = useState([]);
  const [groups, setGroups] = useState([]);
  const [paymentData, setPaymentData] = useState({
    feeId: null,
    amount: "",
    paymentMethod: "cash",
    notes: ""
  });
  // إزالة نموذج الدفع الأوفلاين من الواجهة
  const [offlinePaymentData, setOfflinePaymentData] = useState({
    studentName: "",
    phone: "",
    guardianPhone: "",
    gradeId: "",
    groupId: "",
    barcode: "",
    totalAmount: "",
    paidAmount: "",
    notes: ""
  });
  const [isSearchingStudent, setIsSearchingStudent] = useState(false);

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
    loadSubscriptionRequests();
    loadFeesFromDB();
  }, []);

  const loadSubscriptionRequests = async () => {
    try {
      const [pendingRequests, approvedReqs] = await Promise.all([
        getSubscriptionRequests({ status: 'pending' }),
        getSubscriptionRequests({ status: 'approved' })
      ]);
      setSubscriptionRequests(pendingRequests || []);
      setApprovedRequests(approvedReqs || []);
    } catch (error) {
      console.error('Error loading subscription requests:', error);
    }
  };

  const loadFeesFromDB = async () => {
    try {
      const [onlineFees, offlineFeesData] = await Promise.all([
        getFees(false),
        getFees(true)
      ]);

      // Map API response to match expected format
      const mapFeeData = (fee: any) => ({
        ...fee,
        studentName: fee.student_name || fee.studentName,
        paidAmount: fee.paid_amount || fee.paidAmount || 0,
        dueDate: fee.due_date || fee.dueDate,
        course: fee.grade_name || fee.course || '',
        status: fee.status === 'paid' ? 'مدفوع' : fee.status === 'partial' ? 'جزئي' : 'متأخر'
      });

      setFees((onlineFees || []).map(mapFeeData));
      setOfflineFees((offlineFeesData || []).map(mapFeeData));
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

  const handleStudentLookup = async (field: "phone" | "barcode" | "name", value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setIsSearchingStudent(true);
    try {
      let student = null;
      if (field === "barcode") {
        student = await getStudentById(trimmed).catch(() => null);
        if (!student) {
          const students = await getStudents();
          student = students.find((s: any) => (s.barcode || "").toUpperCase() === trimmed.toUpperCase()) || null;
        }
      } else if (field === "phone") {
        student = await getStudentByPhone(trimmed);
      }

      if (!student && field === "name") {
        const students = await getStudents();
        student = students.find((s: any) => s.name?.toLowerCase() === trimmed.toLowerCase()) || null;
      }

      if (!student) {
        toast({ title: "لم يتم العثور على الطالب", description: "تأكد من أن الطالب مسجل في قاعدة البيانات", variant: "destructive" });
        return;
      }

      setOfflinePaymentData(prev => ({
        ...prev,
        studentName: student.name || prev.studentName,
        phone: student.phone || prev.phone,
        gradeId: student.grade_id || prev.gradeId,
        groupId: student.group_id || prev.groupId,
        barcode: student.barcode || prev.barcode,
      }));
    } catch (error) {
      console.error("lookup error", error);
      toast({ title: "خطأ", description: "فشل البحث عن الطالب", variant: "destructive" });
    } finally {
      setIsSearchingStudent(false);
    }
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

  const handleNewImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: "حجم الصورة كبير",
          description: "الحد الأقصى لحجم الصورة هو 5 ميجابايت",
          variant: "destructive",
        });
        return;
      }

      if (!file.type.startsWith('image/')) {
        toast({
          title: "نوع الملف غير صحيح",
          description: "يرجى اختيار صورة فقط",
          variant: "destructive",
        });
        return;
      }

      setPaymentImage(file);

      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleApproveRequest = async (request) => {
    try {
      await approveSubscriptionRequest(request.id);

      // Reload data
      await loadSubscriptionRequests();
      await loadFeesFromDB();

      toast({
        title: "✅ تم قبول الطلب",
        description: `تم قبول طلب الطالب ${request.student_name} وحفظه في قاعدة البيانات`,
      });

      setIsViewRequestOpen(false);
      setSelectedRequest(null);
    } catch (error) {
      console.error('Error approving request:', error);
      toast({
        title: "خطأ",
        description: error instanceof Error ? error.message : "فشل في قبول الطلب",
        variant: "destructive",
      });
    }
  };

  const handleSendWhatsApp = (request) => {
    // Format phone number (remove leading 0 and add 20)
    const phone = request.guardian_phone || request.phone;
    if (!phone) {
      toast({
        title: "خطأ",
        description: "لا يوجد رقم WhatsApp لولي الأمر",
        variant: "destructive",
      });
      return;
    }

    const cleanPhone = phone.replace(/\D/g, ''); // Remove non-digits
    const formattedPhone = cleanPhone.startsWith('0') ? '2' + cleanPhone : cleanPhone;

    // Create message
    const message =
      `✅ تم قبول طلب دفع الاشتراك\n\n` +
      `👤 اسم الطالب: ${request.student_name}\n` +
      `💰 المبلغ المدفوع: ${request.amount} جنيه\n` +
      `📚 الصف: ${request.grade_name || 'غير محدد'}\n` +
      `👥 المجموعة: ${request.group_name || 'غير محدد'}\n\n` +
      `شكراً لثقتكم بنا 🙏\n` +
      `مركز القائد التعليمي`;

    // Generate WhatsApp link
    const whatsappLink = `https://wa.me/${formattedPhone}?text=${encodeURIComponent(message)}`;

    // Open WhatsApp in new tab
    window.open(whatsappLink, '_blank');

    toast({
      title: "✅ تم فتح WhatsApp",
      description: `تم فتح WhatsApp لإرسال رسالة إلى ${phone}`,
    });
  };

  const handleRejectRequest = async (request) => {
    const reason = prompt("سبب الرفض:");
    if (!reason) return;

    try {
      await rejectSubscriptionRequest(request.id, reason);

      // Reload data
      await loadSubscriptionRequests();

      toast({
        title: "تم رفض الطلب",
        description: `تم رفض طلب الطالب ${request.student_name}`,
        variant: "destructive",
      });

      setIsViewRequestOpen(false);
      setSelectedRequest(null);
    } catch (error) {
      console.error('Error rejecting request:', error);
      toast({
        title: "خطأ",
        description: error instanceof Error ? error.message : "فشل في رفض الطلب",
        variant: "destructive",
      });
    }
  };

  const handleDeleteFee = async (feeId: string, studentName: string) => {
    if (!confirm(`هل أنت متأكد من حذف عملية دفع الطالب ${studentName}؟`)) return;

    try {
      await deleteFee(feeId);

      // Reload data
      await loadFeesFromDB();
      await loadSubscriptionRequests();

      toast({
        title: "تم الحذف بنجاح",
        description: `تم حذف عملية دفع الطالب ${studentName}`,
      });
    } catch (error) {
      console.error('Error deleting fee:', error);
      toast({
        title: "خطأ",
        description: "فشل في حذف العملية",
        variant: "destructive",
      });
    }
  };

  const handleCleanupMonth = async () => {
    if (!confirm(`هل أنت متأكد من حذف جميع الطلبات المقبولة في شهر ${new Date(filterYear, filterMonth - 1).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' })}؟\n\nهذا الإجراء لا يمكن التراجع عنه!`)) return;

    try {
      const result = await cleanupApprovedRequestsByMonth(filterMonth, filterYear);

      await loadSubscriptionRequests();

      toast({
        title: "تم التنظيف بنجاح",
        description: `تم حذف ${result.deletedCount} طلب مقبول من قاعدة البيانات`,
      });
    } catch (error) {
      console.error('Error cleaning up:', error);
      toast({
        title: "خطأ",
        description: "فشل في تنظيف البيانات",
        variant: "destructive",
      });
    }
  };

  const processOfflinePayment = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const selectedGrade = grades.find(g => g.id === offlinePaymentData.gradeId);
      const selectedGroup = groups.find(g => g.id === offlinePaymentData.groupId);
      const totalAmount = parseFloat(offlinePaymentData.totalAmount) || 0;
      const paidAmount = parseFloat(offlinePaymentData.paidAmount) || 0;
      const remainingAmount = totalAmount - paidAmount;

      // Validate amounts
      if (paidAmount > totalAmount) {
        toast({
          title: "خطأ في المبلغ",
          description: "المبلغ المدفوع لا يمكن أن يكون أكبر من المبلغ المستحق",
          variant: "destructive",
        });
        return;
      }

      // Determine status based on payment
      let status: 'paid' | 'partial' | 'pending' = 'pending';
      if (paidAmount >= totalAmount) {
        status = 'paid';
      } else if (paidAmount > 0) {
        status = 'partial';
      }

      const feeData = {
        student_name: offlinePaymentData.studentName,
        phone: offlinePaymentData.phone,
        guardian_phone: offlinePaymentData.guardianPhone || null,
        grade_id: offlinePaymentData.gradeId,
        grade_name: selectedGrade?.name || '',
        group_id: offlinePaymentData.groupId,
        group_name: selectedGroup?.name || '',
        barcode: offlinePaymentData.barcode,
        amount: totalAmount,
        paid_amount: paidAmount,
        status: status,
        payment_method: 'cash',
        is_offline: true,
        notes: offlinePaymentData.notes,
        due_date: new Date().toISOString().split('T')[0],
        payment_date: paidAmount > 0 ? new Date().toISOString().split('T')[0] : null,
        payment_year: new Date().getFullYear(),
        payment_month: new Date().getMonth() + 1
      };

      const createdFee = await createFee(feeData);

      // Add to offline fees list
      setOfflineFees([...offlineFees, createdFee]);

      toast({
        title: "تم إضافة الطالب بنجاح",
        description: `تم تسجيل الطالب ${offlinePaymentData.studentName}${paidAmount > 0 ? ` بمبلغ ${paidAmount} ج.م` : ''}${remainingAmount > 0 ? ` - المتبقي: ${remainingAmount} ج.م` : ''}`,
      });

      setIsAddNewOpen(false);
      setOfflinePaymentData({
        studentName: "",
        phone: "",
        guardianPhone: "",
        gradeId: "",
        groupId: "",
        barcode: "",
        totalAmount: "",
        paidAmount: "",
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

  const processPayment = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const fee = fees.find(f => f.id === paymentData.feeId);
      if (!fee) return;

      const newPaidAmount = fee.paidAmount + parseFloat(paymentData.amount);

      // Update fee in database
      await updateFee(fee.id, {
        paid_amount: newPaidAmount,
        status: newPaidAmount >= fee.amount ? 'paid' : 'partial',
        payment_date: new Date().toISOString().split('T')[0],
        payment_method: paymentData.paymentMethod,
        notes: paymentData.notes
      });

      toast({
        title: "تم تسجيل الدفع بنجاح",
        description: "تم تحديث حالة المصروفات وحفظها في قاعدة البيانات",
      });

      // Refresh fees list
      fetchFees();

      setIsOpen(false);
      setPaymentData({ feeId: null, amount: "", paymentMethod: "cash", notes: "" });
    } catch (error) {
      console.error('Error processing payment:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ أثناء معالجة الدفع",
        variant: "destructive",
      });
    }
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

  // Calculate totals from both online and offline fees
  // حساب الإجماليات للأونلاين فقط بعد إزالة عرض الأوفلاين
  const totalFees = fees.reduce((sum, fee) => sum + (Number(fee.amount) || 0), 0);
  const totalPaid = fees.reduce((sum, fee) => sum + (Number(fee.paidAmount) || 0), 0);
  const totalRemaining = totalFees - totalPaid;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4 md:gap-0">
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
                  <p className="text-2xl font-bold text-green-600">{totalPaid.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م</p>
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
                  <p className="text-2xl font-bold text-red-600">{totalRemaining.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Online Students Fees */}
        <Card className="shadow-soft mb-6">
          <CardHeader className="bg-gradient-to-r from-blue-50 to-cyan-50 dark:from-blue-950 dark:to-cyan-950">
            <CardTitle className="flex flex-col sm:flex-row items-start sm:items-center gap-2 justify-between w-full">
              <span className="mb-2 sm:mb-0">كشف المصروفات - الطلاب الأونلاين</span>
              <div className="flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <Search className="w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="البحث عن طالب..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="max-w-full sm:max-w-sm w-full"
                  />
                </div>
                <Select value={filterStatus} onValueChange={setFilterStatus}>
                  <SelectTrigger className="w-full sm:w-[200px]">
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
            </CardTitle>
          </CardHeader>
          <CardContent>
            {subscriptionRequests.length > 0 && (
              <div className="mb-6">
                <h3 className="font-semibold text-yellow-800 dark:text-yellow-400 mb-4 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" />
                  طلبات الاشتراك المعلقة ({subscriptionRequests.length})
                </h3>
                <div className="space-y-3">
                  {subscriptionRequests.map((request) => (
                    <div
                      key={request.id}
                      className="border border-yellow-200 dark:border-yellow-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-yellow-50 dark:bg-yellow-950/20"
                    >
                      <div className="bg-gradient-to-r from-yellow-400 to-orange-400 px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
                        <div className="flex items-center gap-3 w-full sm:w-auto">
                          <Avatar className="h-8 w-8 border-2 border-white shrink-0">
                            <AvatarFallback className="text-xs bg-white text-yellow-600">
                              {request.student_name?.charAt(0) || 'ط'}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <h4 className="font-bold text-white text-sm">{request.student_name}</h4>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelectedRequest(request);
                            setIsViewRequestOpen(true);
                          }}
                          className="h-8 w-full sm:w-auto px-4 text-white hover:bg-white/20 self-end sm:self-auto"
                        >
                          <Eye className="w-3 h-3 ml-2" />
                          عرض التفاصيل
                        </Button>
                      </div>

                      <div className="p-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div>
                          <span className="text-xs text-muted-foreground">الموبايل:</span>
                          <p className="font-medium">{request.phone}</p>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground">الصف:</span>
                          <p className="font-medium">{request.grade_name}</p>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground">المجموعة:</span>
                          <p className="font-medium">{request.group_name}</p>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground">التاريخ:</span>
                          <p className="font-medium">{new Date(request.created_at).toLocaleDateString('ar-EG')}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Approved Subscription Requests with WhatsApp */}
            {(() => {
              const filteredApproved = approvedRequests.filter((req: any) => {
                const reqDate = new Date(req.updated_at || req.created_at);
                return reqDate.getMonth() + 1 === filterMonth && reqDate.getFullYear() === filterYear;
              });
              return (
                <div className="mb-6">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-4 gap-4 sm:gap-0">
                    <h3 className="font-semibold text-green-800 dark:text-green-400 flex items-center gap-2">
                      <CheckCircle className="w-5 h-5" />
                      طلبات تم قبولها ({filteredApproved.length})
                    </h3>
                    <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                      <div className="flex gap-2 w-full sm:w-auto">
                        <Select value={filterMonth.toString()} onValueChange={(v) => setFilterMonth(parseInt(v))}>
                          <SelectTrigger className="w-full sm:w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                              <SelectItem key={m} value={m.toString()}>
                                {new Date(2025, m - 1).toLocaleDateString('ar-EG', { month: 'long' })}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select value={filterYear.toString()} onValueChange={(v) => setFilterYear(parseInt(v))}>
                          <SelectTrigger className="w-24 sm:w-24">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i).map((y) => (
                              <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={handleCleanupMonth}
                        disabled={filteredApproved.length === 0}
                        title="حذف جميع طلبات هذا الشهر من قاعدة البيانات"
                        className="whitespace-nowrap w-full sm:w-auto"
                      >
                        <Trash2 className="w-3 h-3 ml-1" />
                        تنظيف الشهر
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {filteredApproved.map((request) => (
                      <div
                        key={request.id}
                        className="border border-green-200 dark:border-green-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-green-50 dark:bg-green-950/20"
                      >
                        <div className="bg-gradient-to-r from-green-500 to-emerald-500 px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
                          <div className="flex items-center gap-3 w-full sm:w-auto">
                            <Avatar className="h-8 w-8 border-2 border-white shrink-0">
                              <AvatarFallback className="text-xs bg-white text-green-600">
                                {request.student_name?.charAt(0) || 'ط'}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <h4 className="font-bold text-white text-sm">{request.student_name}</h4>
                              <span className="text-xs text-green-50">✅ تم القبول</span>
                            </div>
                          </div>
                          <div className="flex gap-2 self-end sm:self-auto">
                            {request.guardian_phone && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleSendWhatsApp(request)}
                                className="h-8 px-3 text-white hover:bg-white/20 bg-white/10 hover:bg-white/30"
                                title="إرسال WhatsApp"
                              >
                                <MessageCircle className="w-3 h-3 ml-1" />
                                WhatsApp
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleDeleteFee(request.id, request.student_name)}
                              className="h-8 px-3 text-white hover:bg-red-600/30 bg-red-600/20"
                              title="حذف"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>

                        <div className="p-3 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                          <div>
                            <span className="text-xs text-muted-foreground">الموبايل:</span>
                            <p className="font-medium">{request.phone}</p>
                          </div>
                          {request.guardian_phone && (
                            <div>
                              <span className="text-xs text-muted-foreground">WhatsApp ولي الأمر:</span>
                              <p className="font-medium text-green-600">{request.guardian_phone}</p>
                            </div>
                          )}
                          <div>
                            <span className="text-xs text-muted-foreground">المبلغ:</span>
                            <p className="font-medium text-green-600">{request.amount} ج.م</p>
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground">الصف:</span>
                            <p className="font-medium">{request.grade_name}</p>
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground">المجموعة:</span>
                            <p className="font-medium">{request.group_name}</p>
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground">تاريخ القبول:</span>
                            <p className="font-medium">{new Date(request.updated_at || request.created_at).toLocaleDateString('ar-EG')}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {filteredApproved.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      <CheckCircle className="w-12 h-12 mx-auto mb-3 opacity-20" />
                      <p>لا توجد طلبات مقبولة في هذا الشهر</p>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Online Students Fees Cards */}
            {filteredFees.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <DollarSign className="w-16 h-16 mx-auto mb-4 opacity-20" />
                <p className="text-lg font-medium">لا توجد مصروفات للطلاب الأونلاين</p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredFees.map((fee, index) => (
                  <div
                    key={fee.id}
                    className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                  >
                    <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10 border-2 border-white">
                          <AvatarFallback className="text-xs bg-white text-cyan-600">
                            {fee.studentName?.charAt(0) || 'ط'}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <h3 className="font-bold text-white text-lg">{fee.studentName}</h3>
                          <div className="flex items-center gap-2 text-xs text-cyan-50">
                            <span>{fee.course}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {fee.status !== "مدفوع" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handlePayment(fee)}
                            className="h-8 px-3 text-white hover:bg-white/20"
                          >
                            <CreditCard className="w-4 h-4 ml-1" />
                            دفع
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <DollarSign className="w-4 h-4 text-cyan-600" />
                          <span className="text-sm text-muted-foreground">المبلغ المطلوب</span>
                        </div>
                        <p className="font-bold text-cyan-600">{fee.amount} ج.م</p>
                      </div>

                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <CheckCircle className="w-4 h-4 text-green-600" />
                          <span className="text-sm text-muted-foreground">المبلغ المدفوع</span>
                        </div>
                        <p className="font-bold text-green-600">{fee.paidAmount} ج.م</p>
                      </div>

                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <AlertTriangle className="w-4 h-4 text-red-600" />
                          <span className="text-sm text-muted-foreground">المتبقي</span>
                        </div>
                        <p className="font-bold text-red-600">{fee.amount - fee.paidAmount} ج.م</p>
                      </div>

                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <Calendar className="w-4 h-4 text-cyan-600" />
                          <span className="text-sm text-muted-foreground">تاريخ الاستحقاق</span>
                        </div>
                        <p className="font-medium">{fee.dueDate}</p>
                      </div>

                      <div className="col-span-2">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-sm text-muted-foreground">الحالة</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {getStatusIcon(fee.status)}
                          <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(fee.status)}`}>
                            {fee.status}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* قسم الأوفلاين تمت إزالته حسب الطلب */}

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
                    <p className="font-medium">{selectedRequest.student_name}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">رقم الموبايل</Label>
                    <p className="font-medium">{selectedRequest.phone}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">الصف الدراسي</Label>
                    <p className="font-medium">{selectedRequest.grade_name}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">المجموعة</Label>
                    <p className="font-medium">{selectedRequest.group_name}</p>
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

                {selectedRequest.receipt_image_url && (
                  <div>
                    <Label className="text-muted-foreground">صورة إيصال الدفع</Label>
                    <img
                      src={selectedRequest.receipt_image_url}
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