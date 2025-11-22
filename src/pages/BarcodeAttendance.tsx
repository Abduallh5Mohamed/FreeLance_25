import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Scan, CheckCircle, XCircle, MessageCircle, Calendar, Send, DollarSign } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '/api';

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
  const { toast } = useToast();

  useEffect(() => {
    fetchGroups();
    fetchGrades();
    fetchStudents();
  }, []);

  useEffect(() => {
    if (selectedGroupId) {
      fetchTodayAttendance();
      fetchAbsentStudents();
    }
  }, [selectedGroupId]);

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

      // Update payment status for all students who attended (merge with existing cache)
      const paymentsData: Record<string, boolean> = { ...monthlyPayments };
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;
      for (const record of response.data || []) {
        const student = students.find((s: any) => s.id === record.student_id);
        if (student && !paymentsData[student.id]) {
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
      }
      console.log('[Attendance] monthlyPayments (today) =>', paymentsData);
      setMonthlyPayments(paymentsData);
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
      const today = new Date().toISOString().split('T')[0];
      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Get all students in the group
      const groupStudents = students.filter((s: any) =>
        s.group_id === selectedGroupId && s.is_active
      );

      // Get students who attended today
      const attendedIds = todayAttendance
        .filter((a: any) => a.status === 'present')
        .map((a: any) => a.student_id);

      // Filter absent students
      const absent = groupStudents.filter((s: any) => !attendedIds.includes(s.id));

      // Fetch last attendance for each absent student
      const lastAttendanceData: Record<string, any> = {};
      // Start with existing payment cache so we don't lose paid status for present students
      const paymentsData: Record<string, boolean> = { ...monthlyPayments };

      for (const student of absent) {
        // Get last attendance
        try {
          const attResponse = await axios.get(`${API_URL}/attendance`, {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              student_id: student.id,
              limit: 1,
              order: 'desc'
            }
          });
          if (attResponse.data && attResponse.data.length > 0) {
            lastAttendanceData[student.id] = attResponse.data[0];
          }
        } catch (err) {
          console.error('Error fetching last attendance:', err);
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
      setLastAttendance(lastAttendanceData);
      console.log('[Attendance] monthlyPayments (absent) =>', paymentsData);
      setMonthlyPayments(paymentsData);
    } catch (error) {
      console.error('Error fetching absent students:', error);
    }
  };

  const sendWhatsAppNotification = (student: any, status: string) => {
    const message = status === 'present'
      ? `السلام عليكم،\n\nنفيدكم بأن الطالب/ة ${student.name} قد حضر/ت اليوم ${new Date().toLocaleDateString('ar-SA')}.\n\nشكراً لتعاونكم.`
      : `السلام عليكم،\n\nنفيدكم بأن الطالب/ة ${student.name} لم يحضر/تحضر اليوم ${new Date().toLocaleDateString('ar-SA')}.\n\nيرجى التواصل معنا لمعرفة السبب.`;

    const phoneNumber = student.phone?.replace(/^0/, '2'); // Convert to international format
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/${phoneNumber}?text=${encodedMessage}`, '_blank');
  };

  const recordAttendance = async (barcodeId: string, status: 'present' | 'absent') => {
    try {
      const student = students.find((s: any) => s.barcode_id === barcodeId || s.barcode === barcodeId);

      if (!student) {
        toast({
          title: "خطأ",
          description: "الباركود غير صحيح",
          variant: "destructive",
        });
        return;
      }

      const today = new Date().toISOString().split('T')[0];
      const token = localStorage.getItem('token');

      // Record attendance via API
      const response = await axios.post(`${API_URL}/attendance`, {
        student_id: student.id,
        group_id: selectedGroupId || student.group_id,
        attendance_date: today,
        status: status
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.data) {
        toast({
          title: "تم التسجيل",
          description: `تم تسجيل ${status === 'present' ? 'حضور' : 'غياب'} ${student.name} بنجاح`,
        });

        // Don't send WhatsApp automatically
        // sendWhatsAppNotification(student, status);

        fetchTodayAttendance();
        setBarcodeInput("");
      }
    } catch (error: any) {
      console.error('Error recording attendance:', error);

      // Check if already recorded (409 Conflict or 400 with message)
      if (error.response?.status === 409 ||
        (error.response?.status === 400 && error.response?.data?.message?.includes('already recorded')) ||
        error.response?.data?.error?.includes('already recorded')) {
        toast({
          title: "تنبيه",
          description: `تم تسجيل حضور ${student.name} مسبقاً اليوم`,
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
    }
  };

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (barcodeInput.trim()) {
      recordAttendance(barcodeInput.trim(), 'present');
    }
  };

  const handleBarcodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim().toUpperCase();
    setBarcodeInput(value);

    // Auto-submit when barcode is exactly 25 characters
    if (value.length === 25) {
      recordAttendance(value, 'present');
    }
  };

  const markAbsent = async (student: any) => {
    const today = new Date().toISOString().split('T')[0];
    const token = localStorage.getItem('token');

    try {
      await axios.post(`${API_URL}/attendance`, {
        student_id: student.id,
        group_id: selectedGroupId || student.group_id,
        attendance_date: today,
        status: 'absent'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      toast({
        title: "تم التسجيل",
        description: `تم تسجيل غياب ${student.name}`,
      });

      // Don't send WhatsApp automatically
      // sendWhatsAppNotification(student, 'absent');
      fetchTodayAttendance();
    } catch (error: any) {
      console.error('Error marking absent:', error);
      toast({
        title: "خطأ",
        description: error.response?.data?.message || "حدث خطأ أثناء تسجيل الغياب",
        variant: "destructive",
      });
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
                      {groups.map((group: any) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  <TableHead>حالة الدفع</TableHead>
                  <TableHead>الوقت</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {todayAttendance.map((record: any) => {
                  const student = students.find((s: any) => s.id === record.student_id);
                  const currentMonth = new Date().toISOString().slice(0, 7);
                  const hasPaid = monthlyPayments[student?.id] || false;

                  return (
                    <TableRow key={record.id}>
                      <TableCell className="font-medium">{student?.name || 'غير معروف'}</TableCell>
                      <TableCell className="font-mono text-sm">{student?.phone || '-'}</TableCell>
                      <TableCell className="font-mono text-sm">{student?.guardian_phone || '-'}</TableCell>
                      <TableCell className="font-mono text-sm">{student?.barcode || student?.barcode_id || '-'}</TableCell>
                      <TableCell>
                        <Badge variant={record.status === 'present' ? 'default' : 'destructive'}>
                          {record.status === 'present' ? (
                            <><CheckCircle className="ml-1 h-3 w-3" /> حاضر</>
                          ) : (
                            <><XCircle className="ml-1 h-3 w-3" /> غائب</>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={hasPaid ? 'default' : 'destructive'} className={!hasPaid ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' : ''}>
                          {hasPaid ? (
                            <><CheckCircle className="ml-1 h-3 w-3" /> مدفوع</>
                          ) : (
                            <><XCircle className="ml-1 h-3 w-3" /> غير مدفوع</>
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>{new Date(record.created_at).toLocaleTimeString('ar-SA')}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          {student && (
                            <Button
                              variant={hasPaid ? "secondary" : "default"}
                              size="sm"
                              onClick={() => handleQuickPayment(student)}
                              className={hasPaid ? "bg-green-500 hover:bg-green-600 text-white" : "bg-green-600 hover:bg-green-700"}
                            >
                              <DollarSign className="ml-1 h-3 w-3" />
                              {hasPaid ? 'دفع إضافي' : 'دفع'}
                            </Button>
                          )}
                          {student && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => sendWhatsAppNotification(student, record.status)}
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
                {todayAttendance.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      لم يتم تسجيل أي حضور اليوم بعد
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {selectedGroupId && absentStudents.length > 0 && (
          <Card className="shadow-soft mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-red-600" />
                الطلاب الغائبين ({absentStudents.length})
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
                  {absentStudents.map((student: any) => {
                    const lastAtt = lastAttendance[student.id];
                    const hasPaid = monthlyPayments[student.id];
                    return (
                      <TableRow key={student.id}>
                        <TableCell className="font-medium">{student.name}</TableCell>
                        <TableCell className="font-mono text-sm">{student.phone || '-'}</TableCell>
                        <TableCell className="font-mono text-sm">{student.guardian_phone || '-'}</TableCell>
                        <TableCell className="text-sm">
                          {lastAtt ? (
                            <div>
                              <div>{new Date(lastAtt.attendance_date).toLocaleDateString('ar-SA')}</div>
                              <div className="text-xs text-muted-foreground">
                                {lastAtt.notes || 'لا يوجد ملاحظات'}
                              </div>
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
                              onClick={() => markAbsent(student)}
                            >
                              تسجيل غياب
                            </Button>
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
      </div>

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
