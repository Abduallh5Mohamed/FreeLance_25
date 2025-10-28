import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Scan, CheckCircle, XCircle, MessageCircle, Calendar } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

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
      const { data, error } = await supabase
        .from('groups')
        .select('*')
        .eq('is_active', true);

      if (error) throw error;
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const fetchStudents = async () => {
    try {
      const { data, error } = await supabase
        .from('students')
        .select('*')
        .eq('is_active', true);

      if (error) throw error;
      setStudents(data || []);
    } catch (error) {
      console.error('Error fetching students:', error);
    }
  };

  const fetchTodayAttendance = async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      const { data, error } = await supabase
        .from('attendance')
        .select(`
          *,
          students (
            name,
            phone,
            barcode_id
          )
        `)
        .eq('attendance_date', today)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTodayAttendance(data || []);
    } catch (error) {
      console.error('Error fetching attendance:', error);
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
      const student = students.find((s: any) => s.barcode_id === barcodeId);
      
      if (!student) {
        toast({
          title: "خطأ",
          description: "الباركود غير صحيح",
          variant: "destructive",
        });
        return;
      }

      const today = new Date().toISOString().split('T')[0];

      // Check if already recorded today
      const { data: existing } = await supabase
        .from('attendance')
        .select('*')
        .eq('student_id', student.id)
        .eq('attendance_date', today)
        .single();

      if (existing) {
        toast({
          title: "تنبيه",
          description: `تم تسجيل ${status === 'present' ? 'حضور' : 'غياب'} ${student.name} مسبقاً اليوم`,
          variant: "default",
        });
        return;
      }

      const { error } = await supabase
        .from('attendance')
        .insert({
          student_id: student.id,
          course_id: null, // يمكن ربطه بكورس لاحقاً
          attendance_date: today,
          status: status,
          parent_phone: student.phone,
          whatsapp_sent: true
        });

      if (error) throw error;

      toast({
        title: "تم التسجيل",
        description: `تم تسجيل ${status === 'present' ? 'حضور' : 'غياب'} ${student.name} بنجاح`,
      });

      // Send WhatsApp notification
      sendWhatsAppNotification(student, status);

      fetchTodayAttendance();
      setBarcodeInput("");
    } catch (error) {
      console.error('Error recording attendance:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ أثناء تسجيل الحضور",
        variant: "destructive",
      });
    }
  };

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (barcodeInput.trim()) {
      recordAttendance(barcodeInput.trim(), 'present');
    }
  };

  const markAbsent = async (student: any) => {
    const today = new Date().toISOString().split('T')[0];
    
    try {
      const { error } = await supabase
        .from('attendance')
        .insert({
          student_id: student.id,
          course_id: student.course_id || null,
          attendance_date: today,
          status: 'absent',
          parent_phone: student.phone,
          whatsapp_sent: true
        });

      if (error) throw error;

      toast({
        title: "تم التسجيل",
        description: `تم تسجيل غياب ${student.name}`,
      });

      sendWhatsAppNotification(student, 'absent');
      fetchTodayAttendance();
    } catch (error) {
      console.error('Error marking absent:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ أثناء تسجيل الغياب",
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
                    امسح أو أدخل رقم الباركود
                  </label>
                  <Input
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    placeholder="STU-xxxxx"
                    autoFocus
                    className="text-lg"
                  />
                </div>
                
                <Button type="submit" className="w-full bg-green-600 hover:bg-green-700">
                  <CheckCircle className="ml-2 h-4 w-4" />
                  تسجيل الحضور
                </Button>
              </form>

              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
                <h3 className="font-medium mb-2 text-sm">ملاحظات:</h3>
                <ul className="text-xs space-y-1 text-muted-foreground">
                  <li>• ضع المؤشر في حقل الباركود</li>
                  <li>• امسح باركود الطالب باستخدام قارئ الباركود</li>
                  <li>• سيتم إرسال رسالة واتساب تلقائياً لولي الأمر</li>
                  <li>• يمكن تسجيل الغياب يدوياً من القائمة أدناه</li>
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
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">الحضور</p>
                  <p className="text-3xl font-bold text-green-600">
                    {todayAttendance.filter((a: any) => a.status === 'present').length}
                  </p>
                </div>
                <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">الغياب</p>
                  <p className="text-3xl font-bold text-red-600">
                    {todayAttendance.filter((a: any) => a.status === 'absent').length}
                  </p>
                </div>
              </div>
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
                {todayAttendance.map((record: any) => (
                  <TableRow key={record.id}>
                    <TableCell className="font-medium">{record.students?.name}</TableCell>
                    <TableCell className="font-mono text-sm">{record.students?.barcode_id}</TableCell>
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
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sendWhatsAppNotification(record.students, record.status)}
                      >
                        <MessageCircle className="ml-1 h-3 w-3" />
                        إعادة الإرسال
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
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
