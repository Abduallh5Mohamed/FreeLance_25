import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Scan, CheckCircle, XCircle, MessageCircle, Calendar, Send } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import axios from 'axios';

const API_URL = 'http://localhost:3001/api';

const BarcodeAttendance = () => {
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [todayAttendance, setTodayAttendance] = useState([]);
  const [students, setStudents] = useState([]);
  const { toast } = useToast();

  useEffect(() => {
    fetchGroups();
    fetchStudents();
  }, []);

  useEffect(() => {
    if (selectedGroupId) {
      fetchTodayAttendance();
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
    } catch (error) {
      console.error('Error fetching attendance:', error);
      toast({
        title: "خطأ",
        description: "فشل تحميل سجل الحضور",
        variant: "destructive",
      });
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

      // Check if already recorded
      if (error.response?.status === 400 && error.response?.data?.message?.includes('already recorded')) {
        toast({
          title: "تنبيه",
          description: error.response.data.message,
          variant: "default",
        });
      } else {
        toast({
          title: "خطأ",
          description: "حدث خطأ أثناء تسجيل الحضور",
          variant: "destructive",
        });
      }
    }
  };

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (barcodeInput.trim()) {
      recordAttendance(barcodeInput.trim(), 'present');
    }
  };

  const handleBarcodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setBarcodeInput(value);

    // Auto-submit when barcode is exactly 25 characters
    if (value.length === 25) {
      recordAttendance(value.trim(), 'present');
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
                  <TableHead>الباركود</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead>الوقت</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {todayAttendance.map((record: any) => {
                  const student = students.find((s: any) => s.id === record.student_id);
                  return (
                    <TableRow key={record.id}>
                      <TableCell className="font-medium">{student?.name || 'غير معروف'}</TableCell>
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
                      <TableCell>{new Date(record.created_at).toLocaleTimeString('ar-SA')}</TableCell>
                      <TableCell>
                        {student && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => sendWhatsAppNotification(student, record.status)}
                          >
                            <MessageCircle className="ml-1 h-3 w-3" />
                            إعادة الإرسال
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {todayAttendance.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      لم يتم تسجيل أي حضور اليوم بعد
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

export default BarcodeAttendance;
