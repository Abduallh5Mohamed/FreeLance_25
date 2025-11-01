import { useState, useRef, useEffect } from 'react';
import { getStudents, markAttendance, getAttendanceByDate, getGroups } from '@/lib/api-http';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Calendar } from '@/components/ui/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Barcode, Check, AlertCircle, Users, CalendarIcon } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';

const BARCODE_LENGTH = 25;

const sanitizeBarcode = (value: string) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const formatLocalDate = (date: Date | string) => {
  const d = typeof date === 'string' ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export default function BarcodeAttendance() {
  const [barcodeInput, setBarcodeInput] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [groups, setGroups] = useState([]);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const barcodeInputRef = useRef(null);

  useEffect(() => {
    barcodeInputRef.current?.focus();
    loadGroups();
  }, []);

  useEffect(() => {
    loadAttendanceByDate(selectedDate);
  }, [selectedDate]);

  const loadGroups = async () => {
    try {
      const groupsData = await getGroups();
      setGroups(groupsData || []);
    } catch (error) {
      console.error('Error loading groups:', error);
    }
  };

  const loadAttendanceByDate = async (date) => {
    try {
      const records = await getAttendanceByDate(date);
      const normalized = (records || []).map((record) => ({
        ...record,
        attendance_date: new Date(record.attendance_date),
      }));
      setAttendanceRecords(normalized);
    } catch (error) {
      console.error('Error loading attendance:', error);
    }
  };

  const getFilteredRecords = () => {
    if (selectedGroup === 'all') return attendanceRecords;
    if (selectedGroup === 'no-group') {
      return attendanceRecords.filter(r => !r.group_id);
    }
    return attendanceRecords.filter(r => r.group_id === selectedGroup);
  };

  const filteredRecords = getFilteredRecords();

  const processBarcode = async (barcode: string) => {
    const normalizedBarcode = sanitizeBarcode(barcode);

    if (!normalizedBarcode) {
      setMessage({ type: 'error', text: 'أدخل الباركود' });
      return;
    }
    if (normalizedBarcode.length !== BARCODE_LENGTH) {
      setMessage({ type: 'error', text: `الباركود يجب أن يكون ${BARCODE_LENGTH} رمزًا` });
      setBarcodeInput('');
      return;
    }

    setLoading(true);
    try {
      const students = await getStudents();
      const student = students.find(s => sanitizeBarcode(s.barcode || '') === normalizedBarcode);
      
      if (!student) {
        setMessage({ type: 'error', text: 'باركود غير صحيح' });
        setBarcodeInput('');
        setLoading(false);
        return;
      }

      const selectedDateStr = formatLocalDate(selectedDate);
      // Ensure local state is up to date before checking duplicates
      await loadAttendanceByDate(selectedDate);
      const updatedRecords = await getAttendanceByDate(selectedDate);
      const normalizedRecords = (updatedRecords || []).map((record) => ({
        ...record,
        attendance_date: new Date(record.attendance_date),
      }));
      setAttendanceRecords(normalizedRecords);
      const existingRecord = normalizedRecords.find(r => 
        r.student_id === student.id && 
        formatLocalDate(r.attendance_date) === selectedDateStr
      );
      
      if (existingRecord) {
        setMessage({ type: 'error', text: `${student.name} مسجل بالفعل في هذا اليوم` });
        setBarcodeInput('');
        setLoading(false);
        return;
      }

      const attendanceDateStr = selectedDateStr;
      
      await markAttendance({ 
        barcode: normalizedBarcode,
        attendance_date: new Date(attendanceDateStr),
        status: 'present',
      });
      
      setMessage({ type: 'success', text: `✓ تم تسجيل حضور ${student.name}` });
      setBarcodeInput('');
      await loadAttendanceByDate(new Date(attendanceDateStr));
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      console.error('Error:', error);
      setMessage({ type: 'error', text: 'خطأ في التسجيل' });
    } finally {
      setLoading(false);
      barcodeInputRef.current?.focus();
    }
  };

  const handleBarcodeInput = async (value: string) => {
    const sanitized = sanitizeBarcode(value);
    setBarcodeInput(sanitized);

    if (sanitized.length >= BARCODE_LENGTH) {
      await processBarcode(sanitized);
      setBarcodeInput('');
    }
  };

  const handlePaste = async (e) => {
    e.preventDefault();
    const pastedText = sanitizeBarcode(e.clipboardData.getData('text'));
    if (pastedText) {
      await processBarcode(pastedText);
      setBarcodeInput('');
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft h-full">
              <CardHeader className="border-b border-primary/20">
                <CardTitle className="text-primary">ماسح الباركود</CardTitle>
              </CardHeader>
              <CardContent className="p-8">
                <div className="space-y-4">
                  <p className="text-muted-foreground text-sm">الصق الباركود أو اضغط Enter بعد المسح</p>
                  <Input
                    ref={barcodeInputRef}
                    type="text"
                    value={barcodeInput}
                    onChange={(e) => { void handleBarcodeInput(e.target.value); }}
                    onPaste={handlePaste}
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
            <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft h-full">
              <CardHeader className="border-b border-primary/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-primary">
                    <Users className="w-5 h-5" />
                    <CardTitle className="text-lg">قائمة الحضور</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-4">
                <div className="mb-4">
                  <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="اختر المجموعة" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4" />
                          الكل ({attendanceRecords.length})
                        </div>
                      </SelectItem>
                      {groups.map(group => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name} ({attendanceRecords.filter(r => r.group_id === group.id).length})
                        </SelectItem>
                      ))}
                      <SelectItem value="no-group">
                        بدون مجموعة ({attendanceRecords.filter(r => !r.group_id).length})
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="mb-4 text-center">
                  <div className="text-3xl font-bold text-primary mb-1">{filteredRecords.length}</div>
                  <p className="text-muted-foreground text-sm">طالب مسجل</p>
                </div>
                <div className="max-h-[400px] overflow-y-auto space-y-2">
                  {filteredRecords.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8">
                      <p>لا يوجد حضور في هذه المجموعة</p>
                    </div>
                  ) : (
                    filteredRecords.map((record, i) => (
                      <motion.div
                        key={record.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.02 }}
                        className="flex items-center justify-between p-3 bg-primary/5 dark:bg-primary/10 rounded-lg hover:bg-primary/10 dark:hover:bg-primary/20 transition"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-primary/20 rounded-full flex items-center justify-center">
                            <span className="text-primary font-bold text-sm">{i + 1}</span>
                          </div>
                          <span className="text-foreground font-medium">{record.student_name || record.student_id}</span>
                        </div>
                        <span className="text-muted-foreground text-xs">
                          {new Date(record.attendance_date).toLocaleTimeString('ar-EG', { 
                            hour: '2-digit', 
                            minute: '2-digit' 
                          })}
                        </span>
                      </motion.div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="mt-6">
          <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft">
            <CardHeader className="border-b border-primary/20">
              <div className="flex items-center gap-2 text-primary">
                <CalendarIcon className="w-5 h-5" />
                <CardTitle>اختر التاريخ</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-6 flex justify-center">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(date) => date && setSelectedDate(date)}
                locale={ar}
                className="rounded-md border border-primary/20"
              />
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
