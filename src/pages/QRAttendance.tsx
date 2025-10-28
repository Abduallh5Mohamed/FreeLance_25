import { useState, useRef, useEffect } from 'react';
import { getStudents, markAttendance, getAttendanceByDate } from '@/lib/api-http';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Barcode, Check, AlertCircle, Clock, Users } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';

export default function BarcodeAttendance() {
  const [barcodeInput, setBarcodeInput] = useState('');
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const barcodeInputRef = useRef(null);

  useEffect(() => {
    barcodeInputRef.current?.focus();
    loadTodayAttendance();
  }, []);

  const loadTodayAttendance = async () => {
    try {
      const today = new Date();
      const records = await getAttendanceByDate(today);
      setAttendanceRecords(records || []);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleBarcodeScan = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const barcode = barcodeInput.trim();
    if (!barcode) {
      setMessage({ type: 'error', text: 'أدخل الباركود' });
      return;
    }
    setLoading(true);
    try {
      const students = await getStudents();
      const student = students.find(s => s.barcode === barcode);
      
      if (!student) {
        setMessage({ type: 'error', text: 'باركود غير صحيح' });
        setBarcodeInput('');
        setLoading(false);
        return;
      }

      const today = new Date().toISOString().split('T')[0];
      const todayRecords = attendanceRecords.filter(r => 
        r.student_id === student.id && r.attendance_date === today
      );
      
      if (todayRecords.length > 0) {
        setMessage({ type: 'error', text: `${student.name} مسجل بالفعل` });
        setBarcodeInput('');
        setLoading(false);
        return;
      }

      await markAttendance({ 
        student_id: student.id,
        attendance_date: new Date(),
      });
      
      setMessage({ type: 'success', text: `✓ تم تسجيل حضور ${student.name}` });
      setBarcodeInput('');
      setTimeout(() => loadTodayAttendance(), 500);
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      console.error('Error:', error);
      setMessage({ type: 'error', text: 'خطأ في التسجيل' });
    } finally {
      setLoading(false);
      barcodeInputRef.current?.focus();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      <div className="max-w-6xl mx-auto px-4 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <Barcode className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-4xl font-bold text-foreground">تسجيل الحضور</h1>
              <p className="text-muted-foreground">امسح باركود الطالب لتسجيل الحضور</p>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="lg:col-span-2">
            <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft h-full">
              <CardHeader className="border-b border-primary/20">
                <CardTitle className="text-primary">ماسح الباركود</CardTitle>
              </CardHeader>
              <CardContent className="p-8">
                <div className="space-y-4">
                  <p className="text-muted-foreground text-sm">اضغط Enter بعد الفراغ من المسح</p>
                  <Input
                    ref={barcodeInputRef}
                    type="text"
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    onKeyDown={handleBarcodeScan}
                    placeholder="ضع الماسح هنا..."
                    disabled={loading}
                    className="bg-white dark:bg-slate-700 border-primary/30 dark:border-primary/50 text-foreground text-xl py-6 placeholder-muted-foreground focus:border-primary"
                    autoFocus
                  />
                </div>

                {message && (
                  <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                    className={`mt-6 p-4 rounded-lg flex items-center gap-3 ${
                      message.type === 'success'
                        ? 'bg-green-100 dark:bg-green-500/20 border border-green-300 dark:border-green-500/50 text-green-700 dark:text-green-300'
                        : 'bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/50 text-red-700 dark:text-red-300'
                    }`}>
                    {message.type === 'success' ? <Check className="w-5 h-5 flex-shrink-0" /> : <AlertCircle className="w-5 h-5 flex-shrink-0" />}
                    <span className="font-medium">{message.text}</span>
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft">
              <CardHeader className="border-b border-primary/20">
                <div className="flex items-center gap-2 text-primary">
                  <Users className="w-5 h-5" />
                  <CardTitle className="text-lg">اليوم</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="p-6">
                <div className="text-center">
                  <div className="text-5xl font-bold text-primary mb-2">{attendanceRecords.length}</div>
                  <p className="text-muted-foreground">طالب مسجل</p>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="mt-6">
          <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft">
            <CardHeader className="border-b border-primary/20">
              <div className="flex items-center gap-2 text-primary">
                <Clock className="w-5 h-5" />
                <CardTitle>سجل الحضور</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {attendanceRecords.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <p>لم يتم تسجيل أي حضور بعد</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-primary/5 border-b border-primary/20">
                      <tr>
                        <th className="px-6 py-3 text-right text-primary font-semibold text-sm">#</th>
                        <th className="px-6 py-3 text-right text-primary font-semibold text-sm">الطالب</th>
                        <th className="px-6 py-3 text-right text-primary font-semibold text-sm">الوقت</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-primary/10">
                      {attendanceRecords.map((record, i) => (
                        <motion.tr key={record.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}
                          className="hover:bg-primary/5 dark:hover:bg-primary/10 transition">
                          <td className="px-6 py-3 text-primary font-semibold">{i + 1}</td>
                          <td className="px-6 py-3 text-foreground font-medium">{record.student_id}</td>
                          <td className="px-6 py-3 text-muted-foreground text-sm">
                            {new Date(record.attendance_date).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
