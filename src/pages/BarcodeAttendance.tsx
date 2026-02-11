import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Scan, CheckCircle, XCircle, MessageCircle, Calendar, Send, DollarSign, AlertTriangle } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '/api';

// Helper: given schedule_days JSON and a reference date, return the previous scheduled day as YYYY-MM-DD
const getPreviousScheduledDay = (referenceDate: string, schedule_days: any): string | null => {
  let days: string[] = [];
  if (schedule_days) {
    if (typeof schedule_days === 'string') {
      try {
        days = JSON.parse(schedule_days);
      } catch {
        days = [];
      }
    } else if (Array.isArray(schedule_days)) {
      days = schedule_days;
    }
  }
  if (days.length === 0) return null;

  const dayMap: { [k: string]: number } = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
  };
  const dayNums = days.map(d => dayMap[d.toLowerCase()]).filter(n => n !== undefined);
  const refDate = new Date(referenceDate);
  // Walk backwards up to 14 days
  for (let i = 1; i <= 14; i++) {
    const candidate = new Date(refDate);
    candidate.setDate(candidate.getDate() - i);
    if (dayNums.includes(candidate.getDay())) {
      return candidate.toISOString().split('T')[0];
    }
  }
  return null;
};

// Helper: check if today matches a group's schedule_days
const isTodayScheduled = (schedule_days: any): boolean => {
  if (!schedule_days) return true; // no schedule = available every day
  let days: string[] = [];
  if (typeof schedule_days === 'string') {
    try { days = JSON.parse(schedule_days); } catch { return true; }
  } else if (Array.isArray(schedule_days)) {
    days = schedule_days;
  }
  if (days.length === 0) return true; // empty array = available every day
  const dayMap: { [k: string]: number } = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const todayNum = new Date().getDay();
  return days.some(d => dayMap[d.toLowerCase()] === todayNum);
};

// Helper: get Arabic day name from schedule_days
const getScheduleDaysArabic = (schedule_days: any): string => {
  if (!schedule_days) return 'كل يوم';
  let days: string[] = [];
  if (typeof schedule_days === 'string') {
    try { days = JSON.parse(schedule_days); } catch { return 'كل يوم'; }
  } else if (Array.isArray(schedule_days)) {
    days = schedule_days;
  }
  if (days.length === 0) return 'كل يوم';
  const arabicDays: { [k: string]: string } = { sun: 'الأحد', mon: 'الاثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت' };
  return days.map(d => arabicDays[d.toLowerCase()] || d).join(' و ');
};

const BarcodeAttendance = () => {
  const [groups, setGroups] = useState([]);
  const [grades, setGrades] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [todayAttendance, setTodayAttendance] = useState([]);
  const [students, setStudents] = useState([]);
  const [absentStudents, setAbsentStudents] = useState([]);
  const [lastAttendance, setLastAttendance] = useState<Record<string, any>>({});
  const [monthlyPayments, setMonthlyPayments] = useState<Record<string, boolean>>({});
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [selectedStudentForPayment, setSelectedStudentForPayment] = useState<any>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  // Cross-group warning dialog state
  const [crossGroupWarning, setCrossGroupWarning] = useState<{ open: boolean; student: any; studentGroup: any; } | null>(null);
  const { toast } = useToast();

  // Filter groups to only show those scheduled for today
  const todayGroups = groups.filter((g: any) => isTodayScheduled(g.schedule_days));

  useEffect(() => {
    fetchGroups();
    fetchGrades();
    fetchStudents();
  }, []);

  useEffect(() => {
    if (selectedGroupId) {
      fetchTodayAttendance();
    }
  }, [selectedGroupId]);

  // تحديث الغائبين تلقائياً عند تغيير الحضور أو الطلاب أو المجموعة
  useEffect(() => {
    if (selectedGroupId) {
      fetchAbsentStudents();
    }
  }, [todayAttendance, selectedGroupId, students]);

  const fetchGroups = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/groups`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setGroups(response.data.filter((g: any) => g.is_active));
    } catch (error) {
      console.error('Error fetching groups:', error);
      toast({
        title: "خطأ",
        description: "فشل تحميل المجموعات",
        variant: "destructive",
      });
    }
  };

  const fetchGrades = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/grades`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setGrades(response.data.filter((g: any) => g.is_active));
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchStudents = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`${API_URL}/students`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setStudents(response.data.filter((s: any) => s.is_active));
    } catch (error) {
      console.error('Error fetching students:', error);
      toast({
        title: "خطأ",
        description: "فشل تحميل الطلاب",
        variant: "destructive",
      });
    }
  };

  const fetchTodayAttendance = async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const token = localStorage.getItem('token');

      const response = await axios.get(`${API_URL}/attendance`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          date: today,
          group_id: selectedGroupId || undefined
        }
      });

      setTodayAttendance(response.data || []);

      // Update payment status and last attendance for all students who attended
      const paymentsData: Record<string, boolean> = {};
      const lastAttendanceData: Record<string, any> = {};
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      // استخدم تعريف today في أعلى الدالة وتجنب إعادة تعريفه لتفادي الخطأ

      for (const record of response.data || []) {
        const student = students.find((s: any) => s.id === record.student_id);
        if (student) {
          // Fetch payment status
          if (!paymentsData[student.id]) {
            try {
              const feeResponse = await axios.get(`${API_URL}/fees`, {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                  phone: student.phone,
                  status: 'paid'
                }
              });
              const hasMonthlyPayment = feeResponse.data.some((fee: any) => {
                return fee.payment_year === currentYear && fee.payment_month === currentMonth;
              });
              paymentsData[student.id] = hasMonthlyPayment;
            } catch (err) {
              console.error('Error fetching payment:', err);
              paymentsData[student.id] = false;
            }
          }

          // Fetch last scheduled session attendance
          try {
            const group = groups.find((g: any) => g.id === student.group_id);
            const lastScheduledDate = getPreviousScheduledDay(today, group?.schedule_days);
            if (lastScheduledDate) {
              const attResponse = await axios.get(`${API_URL}/attendance`, {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                  student_id: student.id,
                  date: lastScheduledDate
                }
              });
              if (attResponse.data && attResponse.data.length > 0) {
                lastAttendanceData[student.id] = { ...attResponse.data[0], _scheduledDate: lastScheduledDate, _attended: attResponse.data[0].status === 'present' };
              } else {
                // No record = was absent on last scheduled session
                lastAttendanceData[student.id] = { _scheduledDate: lastScheduledDate, _attended: false, status: 'absent' };
              }
            }
          } catch (err) {
            console.error('Error fetching last attendance:', err);
          }
        }
      }
      console.log('[Attendance] monthlyPayments (today) =>', paymentsData);
      console.log('[Attendance] lastAttendance (today) =>', lastAttendanceData);
      setMonthlyPayments(prev => ({ ...prev, ...paymentsData }));
      setLastAttendance(prev => ({ ...prev, ...lastAttendanceData }));
    } catch (error) {
      console.error('Error fetching attendance:', error);
      toast({
        title: "خطأ",
        description: "فشل تحميل سجل الحضور",
        variant: "destructive",
      });
    }
  };

  const fetchAbsentStudents = async () => {
    try {
      const token = localStorage.getItem('token');
      // Use local date parts to avoid UTC shift issues
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Get all students in the group
      const groupStudents = students.filter((s: any) =>
        s.group_id === selectedGroupId && s.is_active
      );

      // السجلات المسجلة حضور فعلي لهذا اليوم (نستثني الغياب حتى لو تم إدخاله يدوياً)
      // نستخدم Set لتسريع عملية البحث وتجنب التكرار
      const presentIds = new Set(
        todayAttendance
          .filter((a: any) => a.status === 'present')
          .map((a: any) => a.student_id)
      );

      // الطلاب الذين ليس لديهم سجل حضور (present) اليوم
      const absent = groupStudents.filter((s: any) => !presentIds.has(s.id));

      // Fetch last attendance for each absent student
      const lastAttendanceData: Record<string, any> = {};
      // Payment data for absent students only - will be merged with existing
      const paymentsData: Record<string, boolean> = {};

      for (const student of absent) {
        // Get last scheduled session attendance
        const group = groups.find((g: any) => g.id === student.group_id);
        const lastScheduledDate = getPreviousScheduledDay(today, group?.schedule_days);
        if (lastScheduledDate) {
          try {
            const attResponse = await axios.get(`${API_URL}/attendance`, {
              headers: { Authorization: `Bearer ${token}` },
              params: {
                student_id: student.id,
                date: lastScheduledDate
              }
            });
            if (attResponse.data && attResponse.data.length > 0) {
              lastAttendanceData[student.id] = { ...attResponse.data[0], _scheduledDate: lastScheduledDate, _attended: attResponse.data[0].status === 'present' };
            } else {
              // No record = was absent on last scheduled session
              lastAttendanceData[student.id] = { _scheduledDate: lastScheduledDate, _attended: false, status: 'absent' };
            }
          } catch (err) {
            console.error('Error fetching last attendance:', err);
          }
        }

        // Check monthly payment
        try {
          const feeResponse = await axios.get(`${API_URL}/fees`, {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              phone: student.phone,
              status: 'paid'
            }
          });
          // Check if payment exists for current month using payment_year and payment_month
          const hasMonthlyPayment = feeResponse.data.some((fee: any) => {
            return fee.payment_year === currentYear && fee.payment_month === currentMonth;
          });
          paymentsData[student.id] = hasMonthlyPayment;
        } catch (err) {
          console.error('Error fetching payment:', err);
          paymentsData[student.id] = false;
        }
      }

      setAbsentStudents(absent);
      setLastAttendance(prev => ({ ...prev, ...lastAttendanceData }));
      console.log('[Attendance] monthlyPayments (absent) =>', paymentsData);
      setMonthlyPayments(prev => ({ ...prev, ...paymentsData }));
    } catch (error) {
      console.error('Error fetching absent students:', error);
    }
  };

  // ارسال واتساب إلى رقم ولي الأمر (أولوية) ثم رقم الطالب إن لم يتوفر
  const sendWhatsAppNotification = (student: any, status: string) => {
    const message = status === 'present'
      ? `السلام عليكم،\n\nنفيدكم بأن الطالب/ة ${student.name} حضر اليوم ${new Date().toLocaleDateString('ar-EG')}\n\nشكراً لتعاونكم.`
      : `السلام عليكم،\n\nنفيدكم بأن الطالب/ة ${student.name} لم يحضر اليوم ${new Date().toLocaleDateString('ar-EG')}\n\nيرجى متابعة السبب.`;

    const rawPhone = student.guardian_phone || student.phone || '';
    if (!rawPhone) {
      toast({ title: 'لا يوجد رقم', description: 'لا يتوفر رقم لولي الأمر أو الطالب', variant: 'destructive' });
      return;
    }
    // إزالة كل الحروف وإبقاء الأرقام فقط
    let phoneNumber = rawPhone.replace(/[^0-9]/g, '');
    // إضافة كود مصر إذا كان الرقم يبدأ بـ 0
    if (phoneNumber.startsWith('0')) {
      phoneNumber = '+20' + phoneNumber.substring(1);
    } else if (!phoneNumber.startsWith('20')) {
      phoneNumber = '+20' + phoneNumber;
    } else {
      phoneNumber = '+' + phoneNumber;
    }
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/${phoneNumber}?text=${encodedMessage}`, '_blank');
  };

  // تسجيل حضور فقط (لم نعد ندعم إدخال غياب يدوي من الواجهة)
  const recordAttendance = async (barcodeId: string) => {
    try {
      const student = students.find((s: any) => s.barcode_id === barcodeId || s.barcode === barcodeId);

      if (!student) {
        toast({
          title: "خطأ",
          description: "الباركود غير صحيح",
          variant: "destructive",
        });
        setBarcodeInput("");
        return;
      }

      // Check if student belongs to a different group than selected
      if (selectedGroupId && student.group_id && student.group_id !== selectedGroupId) {
        const studentGroup = groups.find((g: any) => g.id === student.group_id);
        setCrossGroupWarning({ open: true, student, studentGroup });
        setBarcodeInput("");
        return;
      }

      await doRecordAttendance(student, student.group_id);
    } catch (error: any) {
      handleAttendanceError(error);
    }
  };

  // Actual attendance recording logic (used by both normal and cross-group flows)
  const doRecordAttendance = async (student: any, groupId: string) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const token = localStorage.getItem('token');

      const response = await axios.post(`${API_URL}/attendance`, {
        student_id: student.id,
        group_id: groupId,
        attendance_date: today,
        status: 'present'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data) {
        toast({
          title: "تم التسجيل",
          description: `تم تسجيل حضور ${student.name} بنجاح`,
        });

        fetchTodayAttendance();
        setBarcodeInput("");
      }
    } catch (error: any) {
      handleAttendanceError(error);
    }
  };

  const handleAttendanceError = (error: any) => {
    console.error('Error recording attendance:', error);

    if (error.response?.status === 409 ||
      (error.response?.status === 400 && error.response?.data?.message?.includes('already recorded')) ||
      error.response?.data?.error?.includes('already recorded')) {
      toast({
        title: "تنبيه",
        description: "تم تسجيل الحضور مسبقاً اليوم",
        variant: "default",
      });
    } else {
      toast({
        title: "خطأ",
        description: error.response?.data?.error || error.response?.data?.message || "حدث خطأ أثناء تسجيل الحضور",
        variant: "destructive",
      });
    }
    setBarcodeInput("");
  };

  // Handle cross-group confirmation
  const handleCrossGroupAccept = async () => {
    if (crossGroupWarning?.student) {
      await doRecordAttendance(crossGroupWarning.student, crossGroupWarning.student.group_id);
    }
    setCrossGroupWarning(null);
  };

  const handleCrossGroupReject = () => {
    toast({
      title: "تم الرفض",
      description: "لم يتم تسجيل حضور الطالب",
    });
    setCrossGroupWarning(null);
  };

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (barcodeInput.trim()) {
      recordAttendance(barcodeInput.trim());
    }
  };

  const handleBarcodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim().toUpperCase();
    setBarcodeInput(value);

    // Auto-submit when barcode is exactly 25 characters
    if (value.length === 25) {
      recordAttendance(value);
    }
  };

  const sendWhatsAppToAbsentStudents = async () => {
    if (!selectedGroupId) {
      toast({
        title: "تنبيه",
        description: "الرجاء اختيار مجموعة أولاً",
        variant: "destructive",
      });
      return;
    }

    try {
      const today = new Date().toISOString().split('T')[0];
      const token = localStorage.getItem('token');

      const response = await axios.post(`${API_URL}/attendance/notify-absent`, {
        group_id: selectedGroupId,
        date: today
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const data = response.data;

      if (data.absent === 0) {
        toast({
          title: "لا يوجد غياب",
          description: "جميع الطلاب حضروا اليوم!",
        });
        return;
      }

      // Open all WhatsApp links
      data.whatsapp_links.forEach((link: any, index: number) => {
        setTimeout(() => {
          window.open(link.link, '_blank');
        }, index * 500); // Delay to avoid popup blocker
      });

      toast({
        title: "تم إرسال الإشعارات",
        description: `تم إرسال ${data.notifications_sent} رسالة واتساب للطلاب الغائبين`,
      });

    } catch (error: any) {
      console.error('Error sending WhatsApp to absent students:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ أثناء إرسال الإشعارات",
        variant: "destructive",
      });
    }
  };

  const handleQuickPayment = (student: any) => {
    setSelectedStudentForPayment(student);
    setPaymentAmount("");
    setIsPaymentDialogOpen(true);
  };

  const processQuickPayment = async () => {
    if (!selectedStudentForPayment || !paymentAmount) {
      toast({
        title: "خطأ",
        description: "الرجاء إدخال المبلغ",
        variant: "destructive",
      });
      return;
    }

    try {
      const token = localStorage.getItem('token');
      const amount = parseFloat(paymentAmount);

      if (amount <= 0) {
        toast({
          title: "خطأ",
          description: "الرجاء إدخال مبلغ صحيح",
          variant: "destructive",
        });
        return;
      }

      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Create fee record
      await axios.post(`${API_URL}/fees`, {
        student_name: selectedStudentForPayment.name,
        phone: selectedStudentForPayment.phone,
        guardian_phone: selectedStudentForPayment.guardian_phone,
        grade_id: selectedStudentForPayment.grade_id,
        group_id: selectedStudentForPayment.group_id,
        barcode: selectedStudentForPayment.barcode,
        amount: amount,
        paid_amount: amount,
        status: 'paid',
        payment_method: 'cash',
        is_offline: false,
        payment_year: currentYear,
        payment_month: currentMonth,
        payment_date: new Date().toISOString().split('T')[0],
        notes: `دفع سريع من صفحة الحضور`
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      toast({
        title: "✅ تم تسجيل الدفع",
        description: `تم تسجيل دفع ${amount} ج.م لـ ${selectedStudentForPayment.name} لشهر ${currentMonth}/${currentYear}`,
      });

      setIsPaymentDialogOpen(false);
      setSelectedStudentForPayment(null);
      setPaymentAmount("");

      // Refresh payment status
      fetchTodayAttendance();
      fetchAbsentStudents();

    } catch (error: any) {
      console.error('Error processing quick payment:', error);

      if (error.response?.status === 400 && error.response?.data?.error?.includes('تم الدفع مسبقاً')) {
        toast({
          title: "تم الدفع مسبقاً",
          description: error.response.data.message || "الطالب قام بالدفع بالفعل لهذا الشهر",
          variant: "destructive",
        });
      } else {
        toast({
          title: "خطأ",
          description: error.response?.data?.message || "حدث خطأ أثناء تسجيل الدفع",
          variant: "destructive",
        });
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <Scan className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">تسجيل الحضور بالباركود</h1>
            <p className="text-muted-foreground">امسح باركود الطالب لتسجيل الحضور تلقائياً</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Scan className="h-5 w-5" />
                مسح الباركود
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleBarcodeSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    اختر المجموعة
                  </label>
                  <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر المجموعة" />
                    </SelectTrigger>
                    <SelectContent>
                      {todayGroups.length === 0 ? (
                        <div className="p-3 text-center text-sm text-muted-foreground">
                          لا توجد مجموعات مجدولة لهذا اليوم
                        </div>
                      ) : (
                        todayGroups.map((group: any) => (
                          <SelectItem key={group.id} value={group.id}>
                            {group.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  {todayGroups.length === 0 && groups.length > 0 && (
                    <div className="mt-2 p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
                      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" />
                        <p className="text-sm font-medium">لا توجد مجموعات مجدولة اليوم</p>
                      </div>
                      <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">المجموعات المتاحة لها أيام محددة أخرى</p>
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-sm font-medium mb-2 block">
                    امسح أو أدخل رقم الباركود
                  </label>
                  <Input
                    value={barcodeInput}
                    onChange={handleBarcodeChange}
                    placeholder="YX6CKWVPB835S2HPKSP57R9PO"
                    autoFocus
                    className="text-lg font-mono"
                    maxLength={25}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    سيتم التسجيل تلقائياً عند إدخال 25 رقم
                  </p>
                </div>
              </form>

              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
                <h3 className="font-medium mb-2 text-sm">ملاحظات:</h3>
                <ul className="text-xs space-y-1 text-muted-foreground">
                  <li>• اختر المجموعة أولاً</li>
                  <li>• ضع المؤشر في حقل الباركود</li>
                  <li>• امسح باركود الطالب (25 رقم)</li>
                  <li>• سيتم تسجيل الحضور تلقائياً عند اكتمال الباركود</li>
                  <li>• لإرسال واتساب للغائبين: اضغط الزر الأزرق ←</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                إحصائيات اليوم
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">الحضور</p>
                  <p className="text-3xl font-bold text-green-600">
                    {todayAttendance.filter((a: any) => a.status === 'present').length}
                  </p>
                </div>
                <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">الغياب</p>
                  <p className="text-3xl font-bold text-red-600">
                    {selectedGroupId
                      ? students.filter((s: any) => s.group_id === selectedGroupId && s.is_active).length
                      - todayAttendance.filter((a: any) => a.status === 'present').length
                      : 0
                    }
                  </p>
                </div>
              </div>

              <Button
                onClick={sendWhatsAppToAbsentStudents}
                disabled={!selectedGroupId}
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                <Send className="ml-2 h-4 w-4" />
                إرسال واتساب للطلاب الغائبين
              </Button>

              <p className="text-xs text-muted-foreground mt-2 text-center">
                سيتم إرسال رسالة واتساب لولي أمر كل طالب غائب
              </p>
            </CardContent>
          </Card>
        </div>

        {/* حسابات مشتقة للحضور والغياب لتجنب التكرار */}
        {(() => {
          const presentRecords = todayAttendance.filter((r: any) => r.status === 'present');
          const presentIds = new Set(presentRecords.map((r: any) => r.student_id));
          const filteredAbsentStudents = selectedGroupId
            ? students.filter((s: any) => s.group_id === selectedGroupId && s.is_active && !presentIds.has(s.id))
            : [];
          return (
            <>
              <Card className="shadow-soft">
                <CardHeader>
                  <CardTitle>سجل الحضور اليوم</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>الطالب</TableHead>
                        <TableHead>رقم التلفون</TableHead>
                        <TableHead>رقم ولي الأمر</TableHead>
                        <TableHead>الباركود</TableHead>
                        <TableHead>الحالة</TableHead>
                        <TableHead>حضر آخر حصة؟</TableHead>
                        <TableHead>حالة الدفع</TableHead>
                        <TableHead>الوقت</TableHead>
                        <TableHead>الإجراءات</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {presentRecords.map((record: any) => {
                        const student = students.find((s: any) => s.id === record.student_id);
                        const hasPaid = monthlyPayments[student?.id] || false;
                        const lastAtt = lastAttendance[student?.id];
                        return (
                          <TableRow key={record.id}>
                            <TableCell className="font-medium">{student?.name || 'غير معروف'}</TableCell>
                            <TableCell className="font-mono text-sm">{student?.phone || '-'}</TableCell>
                            <TableCell className="font-mono text-sm">{student?.guardian_phone || '-'}</TableCell>
                            <TableCell className="font-mono text-sm">{student?.barcode || student?.barcode_id || '-'}</TableCell>
                            <TableCell>
                              <Badge variant="default">
                                <CheckCircle className="ml-1 h-3 w-3" /> حاضر
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {lastAtt ? (
                                <div className="flex flex-col gap-1">
                                  <Badge variant={lastAtt._attended ? 'default' : 'destructive'}>
                                    {lastAtt._attended ? (
                                      <><CheckCircle className="ml-1 h-3 w-3" /> حضر</>
                                    ) : (
                                      <><XCircle className="ml-1 h-3 w-3" /> غائب</>
                                    )}
                                  </Badge>
                                  {lastAtt._scheduledDate && (
                                    <span className="text-xs text-muted-foreground">
                                      {new Date(lastAtt._scheduledDate).toLocaleDateString('ar-SA')}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <Badge variant="secondary">لم يحضر من قبل</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant={hasPaid ? 'default' : 'destructive'}>
                                {hasPaid ? (
                                  <><CheckCircle className="ml-1 h-3 w-3" /> مدفوع</>
                                ) : (
                                  <><XCircle className="ml-1 h-3 w-3" /> غير مدفوع</>
                                )}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm">
                              {new Date(record.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                {!hasPaid && (
                                  <Button
                                    variant="default"
                                    size="sm"
                                    onClick={() => student && handleQuickPayment(student)}
                                    className="bg-green-600 hover:bg-green-700"
                                  >
                                    <DollarSign className="ml-1 h-3 w-3" />
                                    دفع
                                  </Button>
                                )}
                                {student && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => sendWhatsAppNotification(student, 'present')}
                                  >
                                    <MessageCircle className="ml-1 h-3 w-3" />
                                    واتساب
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {presentRecords.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                            لم يتم تسجيل أي حضور اليوم بعد
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              {selectedGroupId && filteredAbsentStudents.length > 0 && (
                <Card className="shadow-soft mt-6">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <XCircle className="h-5 w-5 text-red-600" />
                      الطلاب الغائبين ({filteredAbsentStudents.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>الطالب</TableHead>
                          <TableHead>رقم التلفون</TableHead>
                          <TableHead>رقم ولي الأمر</TableHead>
                          <TableHead>آخر حصة</TableHead>
                          <TableHead>حالة الدفع</TableHead>
                          <TableHead>الإجراءات</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredAbsentStudents.map((student: any) => {
                          const lastAtt = lastAttendance[student.id];
                          const hasPaid = monthlyPayments[student.id];
                          return (
                            <TableRow key={student.id}>
                              <TableCell className="font-medium">{student.name}</TableCell>
                              <TableCell className="font-mono text-sm">{student.phone || '-'}</TableCell>
                              <TableCell className="font-mono text-sm">{student.guardian_phone || '-'}</TableCell>
                              <TableCell className="text-sm">
                                {lastAtt ? (
                                  <div className="flex flex-col gap-1">
                                    <Badge variant={lastAtt._attended ? 'default' : 'destructive'} className="w-fit">
                                      {lastAtt._attended ? (
                                        <><CheckCircle className="ml-1 h-3 w-3" /> حضر آخر حصة</>
                                      ) : (
                                        <><XCircle className="ml-1 h-3 w-3" /> لم يحضر آخر حصة</>
                                      )}
                                    </Badge>
                                    {lastAtt._scheduledDate && (
                                      <span className="text-xs text-muted-foreground">
                                        {new Date(lastAtt._scheduledDate).toLocaleDateString('ar-SA')}
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">لم يحضر من قبل</span>
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge variant={hasPaid ? 'default' : 'destructive'}>
                                  {hasPaid ? (
                                    <><CheckCircle className="ml-1 h-3 w-3" /> مدفوع</>
                                  ) : (
                                    <><XCircle className="ml-1 h-3 w-3" /> غير مدفوع</>
                                  )}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex gap-2">
                                  {!hasPaid && (
                                    <Button
                                      variant="default"
                                      size="sm"
                                      onClick={() => handleQuickPayment(student)}
                                      className="bg-green-600 hover:bg-green-700"
                                    >
                                      <DollarSign className="ml-1 h-3 w-3" />
                                      دفع
                                    </Button>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => sendWhatsAppNotification(student, 'absent')}
                                  >
                                    <MessageCircle className="ml-1 h-3 w-3" />
                                    واتساب
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </>
          );
        })()}
      </div>

      {/* Cross-Group Warning Dialog */}
      <Dialog open={crossGroupWarning?.open || false} onOpenChange={(open) => { if (!open) setCrossGroupWarning(null); }}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              تنبيه: طالب من مجموعة أخرى
            </DialogTitle>
            <DialogDescription>
              هذا الطالب مسجل في مجموعة مختلفة. هل تريد تسجيل حضوره في مجموعته الأصلية؟
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">اسم الطالب:</span>
                  <span className="font-medium">{crossGroupWarning?.student?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">مجموعته الأصلية:</span>
                  <span className="font-medium text-amber-700 dark:text-amber-400">{crossGroupWarning?.studentGroup?.name || 'غير محددة'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">المجموعة الحالية:</span>
                  <span className="font-medium">{groups.find((g: any) => g.id === selectedGroupId)?.name}</span>
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <Button variant="destructive" onClick={handleCrossGroupReject}>
                <XCircle className="ml-1 h-4 w-4" />
                رفض
              </Button>
              <Button onClick={handleCrossGroupAccept} className="bg-green-600 hover:bg-green-700">
                <CheckCircle className="ml-1 h-4 w-4" />
                موافقة (تسجيل في مجموعته)
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment Dialog */}
      <Dialog open={isPaymentDialogOpen} onOpenChange={setIsPaymentDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>دفع سريع - {selectedStudentForPayment?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>اسم الطالب</Label>
              <Input value={selectedStudentForPayment?.name || ''} disabled />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>رقم التلفون</Label>
                <Input value={selectedStudentForPayment?.phone || '-'} disabled className="font-mono" />
              </div>
              <div className="space-y-2">
                <Label>رقم ولي الأمر</Label>
                <Input value={selectedStudentForPayment?.guardian_phone || '-'} disabled className="font-mono" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>الصف</Label>
                <Input value={grades.find((g: any) => g.id === selectedStudentForPayment?.grade_id)?.name || '-'} disabled />
              </div>
              <div className="space-y-2">
                <Label>المجموعة</Label>
                <Input value={groups.find((g: any) => g.id === selectedStudentForPayment?.group_id)?.name || '-'} disabled />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="paymentAmount">المبلغ المدفوع *</Label>
              <Input
                id="paymentAmount"
                type="number"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                placeholder="أدخل المبلغ بالجنيه"
                min="0"
                step="0.01"
                autoFocus
              />
            </div>

            <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
              <p className="text-sm text-blue-700 dark:text-blue-300">
                📅 الشهر الحالي: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </p>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setIsPaymentDialogOpen(false)}>
                إلغاء
              </Button>
              <Button onClick={processQuickPayment} className="bg-green-600 hover:bg-green-700">
                <DollarSign className="ml-1 h-4 w-4" />
                تأكيد الدفع
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BarcodeAttendance;
