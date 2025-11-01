import { useState, useEffect } from 'react';
import { getStudents, updateStudent, getGroups } from '@/lib/api-http';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Barcode, Plus, Trash2, CheckCircle, Zap, Users, Search, Edit2, Calendar } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';
import BarcodeReact from 'react-barcode';

const BARCODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BARCODE_LENGTH = 25;

const createBarcode = (existing: Set<string>): string => {
  let code = '';
  do {
    code = Array.from({ length: BARCODE_LENGTH }, () => BARCODE_CHARSET[Math.floor(Math.random() * BARCODE_CHARSET.length)]).join('');
  } while (existing.has(code));
  return code;
};

const sanitizeBarcode = (value?: string | null) => (value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export default function StudentBarcodes() {
  const [students, setStudents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    try {
      const [studentsData, groupsData] = await Promise.all([
        getStudents(),
        getGroups()
      ]);
      
      setStudents(studentsData || []);
      setGroups(groupsData || []);
      
      console.log('Students loaded:', studentsData?.length);
      console.log('Groups loaded:', groupsData?.length);
    } catch (error) {
      console.error('Error loading data:', error);
      setMessage({ type: 'error', text: `خطأ في تحميل البيانات: ${error?.message}` });
    }
  };

  const getFilteredStudents = () => {
    let filtered = students;
    
    if (selectedGroup !== 'all') {
      if (selectedGroup === 'no-group') {
        filtered = students.filter(s => !s.group_id);
      } else {
        filtered = students.filter(s => s.group_id === selectedGroup);
      }
    }
    
    if (searchTerm.trim()) {
      filtered = filtered.filter(s =>
        s.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        s.phone?.includes(searchTerm) ||
        s.barcode?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    
    return filtered;
  };

  const filteredStudents = getFilteredStudents();

  const generateBarcode = async (studentId) => {
    setLoading(true);
    try {
      const existingBarcodes = new Set(
        students
          .map((s) => sanitizeBarcode(s.barcode))
          .filter((code) => code && code.length === BARCODE_LENGTH)
      );
      const barcode = createBarcode(existingBarcodes);
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
      const existingBarcodes = new Set(
        students
          .map((s) => sanitizeBarcode(s.barcode))
          .filter((code) => code && code.length === BARCODE_LENGTH)
      );
      for (const student of students) {
        if (!student.barcode) {
          const barcode = createBarcode(existingBarcodes);
          const success = await updateStudent(student.id, { barcode });
          
          if (success) {
            count++;
            existingBarcodes.add(barcode);
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
              className="bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-600 hover:to-teal-600 text-white gap-2"
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
          className="bg-white dark:bg-slate-800 rounded-lg border border-cyan-200 dark:border-cyan-800 shadow-soft overflow-hidden mb-6">
          
          <Tabs value={selectedGroup} onValueChange={setSelectedGroup} className="w-full">
            <div className="border-b border-cyan-200 dark:border-cyan-800 bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-cyan-950/30 dark:to-teal-950/30 px-4 py-2">
              <TabsList className="bg-transparent">
                <TabsTrigger value="all" className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-cyan-500 data-[state=active]:to-teal-500 data-[state=active]:text-white">
                  <Users className="w-4 h-4 ml-2" />
                  الكل ({students.length})
                </TabsTrigger>
                {groups.map(group => (
                  <TabsTrigger 
                    key={group.id} 
                    value={group.id}
                    className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-cyan-500 data-[state=active]:to-teal-500 data-[state=active]:text-white"
                  >
                    {group.name} ({students.filter(s => s.group_id === group.id).length})
                  </TabsTrigger>
                ))}
                <TabsTrigger value="no-group" className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-cyan-500 data-[state=active]:to-teal-500 data-[state=active]:text-white">
                  بدون مجموعة ({students.filter(s => !s.group_id).length})
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value={selectedGroup} className="m-0">
              <div className="p-4 space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <Input
                    placeholder="البحث عن طالب..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full"
                  />
                </div>

                {filteredStudents.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Barcode className="w-16 h-16 mx-auto mb-4 opacity-20" />
                    <p className="text-lg font-medium">لا توجد طلاب في هذه المجموعة</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredStudents.map((student, index) => {
                      const barcode = sanitizeBarcode(student.barcode);
                      const groupName = student.group_id 
                        ? groups.find(g => g.id === student.group_id)?.name 
                        : 'لا يوجد اشتراك';
                      
                      return (
                        <motion.div
                          key={student.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.05 }}
                          className="border border-cyan-200 dark:border-cyan-800 rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white dark:bg-slate-900"
                        >
                          <div className="bg-gradient-to-r from-cyan-500 to-teal-500 px-4 py-3 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-cyan-600 font-bold text-sm">
                                {student.name?.charAt(0) || 'ط'}
                              </div>
                              <div>
                                <h3 className="font-bold text-white text-lg">{student.name}</h3>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => generateBarcode(student.id)}
                                disabled={loading}
                                className="h-8 w-8 p-0 text-white hover:bg-white/20"
                              >
                                <Edit2 className="w-4 h-4" />
                              </Button>
                              {barcode && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => deleteBarcode(student.id)}
                                  className="h-8 w-8 p-0 text-white hover:bg-white/20"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          </div>

                          <div className="p-4 grid grid-cols-2 gap-4">
                            <div>
                              <div className="flex items-center gap-2 mb-2">
                                <Barcode className="w-4 h-4 text-cyan-600" />
                                <span className="text-sm text-muted-foreground">رقم الهاتف</span>
                              </div>
                              <p className="font-medium">{student.phone || '---'}</p>
                            </div>

                            <div>
                              <div className="flex items-center gap-2 mb-2">
                                <Users className="w-4 h-4 text-cyan-600" />
                                <span className="text-sm text-muted-foreground">المرحلة</span>
                              </div>
                              <p className="font-medium">{student.grade || '---'}</p>
                            </div>

                            <div>
                              <div className="flex items-center gap-2 mb-2">
                                <Users className="w-4 h-4 text-cyan-600" />
                                <span className="text-sm text-muted-foreground">الخصوصات</span>
                              </div>
                              <p className="font-medium">{groupName}</p>
                            </div>

                            <div>
                              <div className="flex items-center gap-2 mb-2">
                                <Barcode className="w-4 h-4 text-cyan-600" />
                                <span className="text-sm text-muted-foreground">الاشتراك</span>
                              </div>
                              <p className="font-medium text-cyan-600">لا يوجد اشتراك</p>
                            </div>

                            <div className="col-span-2">
                              <div className="flex items-center gap-2 mb-2">
                                <CheckCircle className="w-4 h-4 text-cyan-600" />
                                <span className="text-sm text-muted-foreground">الحالة</span>
                              </div>
                              {barcode ? (
                                <span className="inline-flex items-center gap-2 text-green-700 dark:text-green-400 text-sm bg-green-100 dark:bg-green-500/20 px-3 py-1 rounded">
                                  <CheckCircle className="w-4 h-4" />
                                  نشط
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-2 text-amber-700 dark:text-amber-400 text-sm bg-amber-100 dark:bg-amber-500/20 px-3 py-1 rounded">
                                  <Calendar className="w-4 h-4" />
                                  بدون باركود
                                </span>
                              )}
                            </div>

                            {barcode && (
                              <div className="col-span-2">
                                <div className="flex items-center gap-2 mb-2">
                                  <Barcode className="w-4 h-4 text-cyan-600" />
                                  <span className="text-sm text-muted-foreground">الباركود</span>
                                </div>
                                <div className="bg-white p-2 rounded border inline-block">
                                  <BarcodeReact 
                                    value={barcode} 
                                    width={1.2}
                                    height={35}
                                    fontSize={10}
                                    background="#ffffff"
                                    lineColor="#000000"
                                    margin={0}
                                  />
                                </div>
                              </div>
                            )}

                            {!barcode && (
                              <div className="col-span-2">
                                <div className="flex items-center gap-2 mb-2">
                                  <Calendar className="w-4 h-4 text-cyan-600" />
                                  <span className="text-sm text-muted-foreground">تاريخ الانضمام</span>
                                </div>
                                <p className="font-medium">Invalid Date</p>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="shadow-soft border-primary/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-primary text-sm">إجمالي الطلاب</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-primary">{filteredStudents.length}</div>
            </CardContent>
          </Card>

          <Card className="shadow-soft border-primary/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-primary text-sm">مع باركود</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600 dark:text-green-400">{filteredStudents.filter(s => s.barcode).length}</div>
            </CardContent>
          </Card>

          <Card className="shadow-soft border-primary/20">
            <CardHeader className="pb-3">
              <CardTitle className="text-primary text-sm">بدون باركود</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-amber-600 dark:text-amber-400">{filteredStudents.filter(s => !s.barcode).length}</div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
