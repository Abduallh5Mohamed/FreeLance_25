import { useState, useEffect } from 'react';
import { getStudents, updateStudent } from '@/lib/api-http';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Barcode, Plus, Trash2, CheckCircle, Zap } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';

export default function StudentBarcodes() {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const studentsData = await getStudents();
      
      setStudents(studentsData || []);
      
      console.log('Students loaded:', studentsData?.length);
    } catch (error) {
      console.error('Error loading data:', error);
      setMessage({ type: 'error', text: `خطأ في تحميل البيانات: ${error?.message}` });
    }
  };

  const generateBarcode = async (studentId) => {
    setLoading(true);
    try {
      const barcode = `STU${Date.now()}${Math.random().toString(36).substr(2, 9)}`.toUpperCase();
      const student = students.find(s => s.id === studentId);
      
      if (!student) throw new Error('الطالب غير موجود');
      
      const success = await updateStudent(studentId, { barcode });
      
      if (!success) throw new Error('فشل تحديث الباركود');
      
      setMessage({ type: 'success', text: student.barcode ? 'تم تحديث الباركود' : 'تم إنشاء الباركود' });
      
      await loadData();
      setTimeout(() => setMessage(null), 2000);
    } catch (error) {
      console.error('Error creating barcode:', error);
      setMessage({ type: 'error', text: `خطأ: ${error?.message || 'خطأ في إنشاء الباركود'}` });
    } finally {
      setLoading(false);
    }
  };

  const deleteBarcode = async (studentId) => {
    try {
      const success = await updateStudent(studentId, { barcode: null });
      if (!success) throw new Error('فشل حذف الباركود');
      
      setMessage({ type: 'success', text: 'تم حذف الباركود' });
      await loadData();
      setTimeout(() => setMessage(null), 2000);
    } catch (error) {
      console.error('Error:', error);
      setMessage({ type: 'error', text: 'خطأ' });
    }
  };

  const generateAllBarcodes = async () => {
    setLoading(true);
    try {
      let count = 0;
      for (const student of students) {
        if (!student.barcode) {
          const barcode = `STU${Date.now()}${Math.random().toString(36).substr(2, 9)}${count}`.toUpperCase();
          const success = await updateStudent(student.id, { barcode });
          
          if (success) {
            count++;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      setMessage({ type: 'success', text: `تم إنشاء ${count} باركود جديد` });
      await loadData();
      setTimeout(() => setMessage(null), 2000);
    } catch (error) {
      console.error('Error creating barcodes:', error);
      setMessage({ type: 'error', text: `خطأ: ${error?.message || 'خطأ في إنشاء الباركود'}` });
    } finally {
      setLoading(false);
    }
  };

  const getStudentBarcode = (studentId) => {
    return students.find(s => s.id === studentId)?.barcode;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      <div className="max-w-7xl mx-auto px-4 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
                <Barcode className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-foreground">إدارة الباركود</h1>
                <p className="text-muted-foreground">إنشاء وإدارة رموز الباركود الفريدة</p>
              </div>
            </div>
            <Button 
              onClick={generateAllBarcodes} 
              disabled={loading || students.filter(s => !s.barcode).length === 0}
              className="bg-primary hover:bg-primary/90 text-white gap-2"
            >
              <Zap className="w-4 h-4" />
              إنشاء الكل
            </Button>
          </div>
        </motion.div>

        {message && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            className={`mb-6 p-4 rounded-lg flex items-center gap-3 ${
              message.type === 'success' ? 'bg-green-100 border border-green-300 text-green-800' : 'bg-red-100 border border-red-300 text-red-800'
            }`}>
            <CheckCircle className="w-5 h-5" />
            <span>{message.text}</span>
          </motion.div>
        )}

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="bg-white dark:bg-slate-800 rounded-lg border border-primary/20 shadow-soft overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-primary/5 border-b border-primary/20">
                <tr>
                  <th className="px-6 py-4 text-right text-primary font-semibold">الطالب</th>
                  <th className="px-6 py-4 text-right text-primary font-semibold">الباركود</th>
                  <th className="px-6 py-4 text-right text-primary font-semibold">الحالة</th>
                  <th className="px-6 py-4 text-right text-primary font-semibold">الإجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary/10">
                {students.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-muted-foreground">
                      لا توجد طلاب
                    </td>
                  </tr>
                ) : (
                  students.map((student, index) => {
                    const barcode = student.barcode;
                    return (
                      <motion.tr key={student.id} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.05 }}
                        className="hover:bg-primary/5 transition dark:hover:bg-primary/10">
                        <td className="px-6 py-4 text-foreground font-medium">{student.name}</td>
                        <td className="px-6 py-4">
                          {barcode ? (
                            <span className="font-mono text-sm text-primary bg-primary/10 px-3 py-1 rounded dark:bg-primary/20">
                              {barcode}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">---</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {barcode ? (
                            <span className="inline-flex items-center gap-2 text-green-700 dark:text-green-400 text-sm bg-green-100 dark:bg-green-500/20 px-3 py-1 rounded">
                              <CheckCircle className="w-4 h-4" />
                              مسجل
                            </span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400 text-sm bg-amber-100 dark:bg-amber-500/20 px-3 py-1 rounded">
                              معلق
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={() => generateBarcode(student.id)} disabled={loading}
                              className="bg-primary hover:bg-primary/90 text-white text-xs gap-1">
                              <Plus className="w-3 h-3" />
                              {barcode ? 'تحديث' : 'إنشاء'}
                            </Button>
                            {barcode && (
                              <Button size="sm" variant="destructive" onClick={() => deleteBarcode(student.id)}
                                className="bg-red-600 hover:bg-red-700 text-white text-xs">
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </motion.tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="shadow-soft border-primary/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-primary text-sm">إجمالي الطلاب</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-primary">{students.length}</div>
            </CardContent>
          </Card>

          <Card className="shadow-soft border-primary/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-primary text-sm">مع باركود</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600 dark:text-green-400">{students.filter(s => s.barcode).length}</div>
            </CardContent>
          </Card>

          <Card className="shadow-soft border-primary/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-primary text-sm">بدون باركود</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-amber-600 dark:text-amber-400">{students.filter(s => !s.barcode).length}</div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
