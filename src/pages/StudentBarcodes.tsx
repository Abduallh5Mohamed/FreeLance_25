import { useState, useEffect } from 'react';
import { getStudents, updateStudent, getGroups } from '@/lib/api-http';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Barcode, Plus, Trash2, CheckCircle, Zap, Users, Search, Edit2, Calendar, Printer } from 'lucide-react';
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
  const [printStyle, setPrintStyle] = useState<'table' | 'cards'>('table');
  // Styles for printable cards (inline to keep scope local)
  const cardContainerStyle: React.CSSProperties = {
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: '0 4px 10px rgba(0,0,0,0.08)',
    background: '#fff',
    direction: 'rtl',
    padding: 0,
    width: '100%',
  };

  const cardHeaderStyle: React.CSSProperties = {
    background: 'linear-gradient(90deg,#06b6d4,#0ea5a4)',
    color: '#fff',
    padding: '12px 14px',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  };

  const avatarStyle: React.CSSProperties = {
    width: 42,
    height: 42,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.15)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 16,
  };

  const nameStyle: React.CSSProperties = { fontSize: 16, fontWeight: 700 };

  const infoRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '10px 12px', gap: 8, flexWrap: 'wrap' };
  const infoItemStyle: React.CSSProperties = { fontSize: 13, color: '#094', display: 'flex', gap: 8, alignItems: 'center' };

  const statusBadgeStyle: React.CSSProperties = { background: '#e6fffa', color: '#065f46', padding: '4px 8px', borderRadius: 999, fontSize: 12 };

  const barcodeAreaStyle: React.CSSProperties = { padding: '10px 12px 18px', textAlign: 'center' };
  const codeTextStyle: React.CSSProperties = { marginTop: 6, fontSize: 11, letterSpacing: 2, color: '#333' };
  const barcodeColumnStyle: React.CSSProperties = { minWidth: 140, maxWidth: '40%', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', boxSizing: 'border-box' };
  const [students, setStudents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [editingGuardianId, setEditingGuardianId] = useState(null);
  const [editingGuardianValue, setEditingGuardianValue] = useState('');
  const [savingGuardian, setSavingGuardian] = useState(false);

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
      // Debug: count students missing guardian phone
      try {
        const missingGuardianCount = (studentsData || []).filter(s => !(s.guardian_phone || s.parent_phone)).length;
        console.log(`Students missing guardian_phone: ${missingGuardianCount}`);
      } catch (e) {
        console.log('Could not compute missing guardian_phone count', e);
      }
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

  const handlePrint = (groupId?: string) => {
    // Store the current group before printing
    const currentGroup = selectedGroup;

    // If groupId is provided, switch to that group temporarily
    if (groupId && groupId !== selectedGroup) {
      setSelectedGroup(groupId);
      // Wait for DOM to update, then print
      setTimeout(() => {
        window.print();
        // Restore original group after print dialog closes
        setTimeout(() => setSelectedGroup(currentGroup), 500);
      }, 100);
    } else {
      window.print();
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
      <style>
        {`
          @media print {
            body * {
              visibility: hidden;
            }
            .print-area, .print-area * {
              visibility: visible;
            }
            /* Ensure print-area occupies full page and isn't constrained by layout */
            html, body { width: 100% !important; height: 100% !important; margin: 0 !important; padding: 0 !important; }
            .print-area, .print-area * { box-sizing: border-box; }
            .print-area {
              position: static !important;
              left: auto !important;
              top: auto !important;
              width: 100% !important;
              max-width: 100% !important;
              padding: 8mm !important;
              margin: 0 !important;
            }
            .no-print {
              display: none !important;
            }
            .print-table {
              width: 100%;
              border-collapse: collapse;
              margin-top: 20px;
            }
            .print-table th,
            .print-table td {
              border: 1px solid #000;
              padding: 8px;
              text-align: center;
              font-size: 12px;
            }
            .print-table th {
              background: #0891b2 !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
              color: white !important;
              font-weight: bold;
            }
            .print-table tr:nth-child(even) {
              background: #f0f9ff !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
            .print-header-title {
              text-align: center;
              margin-bottom: 10px;
              padding: 10px;
              background: #0891b2 !important;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
              color: white !important;
              font-size: 18px;
              font-weight: bold;
              border-radius: 5px;
            }
            .barcode-cell {
              padding: 5px !important;
            }
            .barcode-cell svg {
              margin: 0 auto;
            }
            /* print cards layout: multiple cards per page in portrait mode */
            .print-cards { 
              display: grid !important; 
              grid-template-columns: 1fr !important; 
              gap: 8mm !important;
              padding: 10mm !important;
              width: 100% !important; 
              max-width: 100% !important;
            }
            .print-card { 
              page-break-inside: avoid !important; 
              break-inside: avoid !important;
              width: 100% !important;
              max-width: 100% !important;
              margin: 0 !important;
              box-shadow: none !important; 
              border: 1.5px solid #06b6d4 !important;
              border-radius: 8px !important;
              overflow: hidden !important;
              -webkit-print-color-adjust: exact !important; 
              print-color-adjust: exact !important;
              display: block !important;
            }
            .print-card [style*="linear-gradient"], .print-card .bg-gradient-to-r { 
              -webkit-print-color-adjust: exact !important; 
              print-color-adjust: exact !important; 
            }
            @page {
              size: A4 portrait;
              margin: 0;
            }
          }
          @media screen {
            .print-area {
              display: none;
            }
          }
        `}
      </style>
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
            <div className="flex gap-2 no-print">
              <Button
                onClick={generateAllBarcodes}
                disabled={loading || students.filter(s => !s.barcode).length === 0}
                className="bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-600 hover:to-teal-600 text-white gap-2"
              >
                <Zap className="w-4 h-4" />
                إنشاء الكل
              </Button>
            </div>
          </div>
        </motion.div>

        {message && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            className={`mb-6 p-4 rounded-lg flex items-center gap-3 no-print ${message.type === 'success' ? 'bg-green-100 border border-green-300 text-green-800' : 'bg-red-100 border border-red-300 text-red-800'
              }`}>
            <CheckCircle className="w-5 h-5" />
            <span>{message.text}</span>
          </motion.div>
        )}

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="bg-white dark:bg-slate-800 rounded-lg border border-cyan-200 dark:border-cyan-800 shadow-soft overflow-hidden mb-6">

          <Tabs value={selectedGroup} onValueChange={setSelectedGroup} className="w-full">
            <div className="border-b border-cyan-200 dark:border-cyan-800 bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-cyan-950/30 dark:to-teal-950/30 px-4 py-2 no-print">
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
                <div className="flex items-center gap-2 mb-4 no-print">
                  <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <Input
                    placeholder="البحث عن طالب..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="flex-1"
                  />
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-muted-foreground">شكل الطباعة:</div>
                    <div className="inline-flex rounded-md bg-white/50 p-1">
                      <button onClick={() => setPrintStyle('table')} className={`px-3 py-1 text-sm ${printStyle === 'table' ? 'bg-cyan-500 text-white rounded' : 'text-muted-foreground'}`}>قائمة</button>
                      <button onClick={() => setPrintStyle('cards')} className={`px-3 py-1 text-sm ${printStyle === 'cards' ? 'bg-cyan-500 text-white rounded' : 'text-muted-foreground'}`}>بطاقات</button>
                    </div>
                  </div>

                  <Button
                    onClick={() => handlePrint(selectedGroup)}
                    variant="outline"
                    className="gap-2 border-cyan-500 text-cyan-600 hover:bg-cyan-50 dark:hover:bg-cyan-950"
                  >
                    <Printer className="w-4 h-4" />
                    طباعة المجموعة ({filteredStudents.length})
                  </Button>
                </div>

                {filteredStudents.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground no-print">
                    <Barcode className="w-16 h-16 mx-auto mb-4 opacity-20" />
                    <p className="text-lg font-medium">لا توجد طلاب في هذه المجموعة</p>
                  </div>
                ) : (
                  <>
                    {/* عرض البطاقات على الشاشة */}
                    <div className="space-y-4 no-print">{filteredStudents.map((student, index) => {
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
                                <div className="text-white/90 text-sm">{student.grade || '---'}</div>
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
                                <span className="text-sm text-muted-foreground">الصف</span>
                              </div>
                              <p className="font-medium">{student.grade || '---'}</p>
                            </div>

                            <div>
                              <div className="flex items-center gap-2 mb-2">
                                <Users className="w-4 h-4 text-cyan-600" />
                                <span className="text-sm text-muted-foreground">المجموعة</span>
                              </div>
                              <p className="font-medium">{groupName}</p>
                            </div>

                            <div>
                              <div className="flex items-center gap-2 mb-2">
                                <Barcode className="w-4 h-4 text-cyan-600" />
                                <span className="text-sm text-muted-foreground">ولي الأمر</span>
                              </div>
                              <p className="font-medium">{student.guardian_phone || '---'}</p>
                            </div>

                            <div>
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
                          </div>
                        </motion.div>
                      );
                    })}
                    </div>

                    {/* جدول او بطاقات الطباعة */}
                    <div className="print-area">
                      <div className="print-header-title">
                        كشف الباركود - {selectedGroup === 'all' ? 'جميع الطلاب' : selectedGroup === 'no-group' ? 'بدون مجموعة' : groups.find(g => g.id === selectedGroup)?.name || 'المجموعة'}
                      </div>

                      {printStyle === 'table' ? (
                        <table className="print-table">
                          <thead>
                            <tr>
                              <th style={{ width: '40px' }}>م</th>
                              <th style={{ width: '150px' }}>اسم الطالب</th>
                              <th style={{ width: '100px' }}>رقم الهاتف</th>
                              <th style={{ width: '100px' }}>رقم ولي الأمر</th>
                              <th style={{ width: '80px' }}>الصف</th>
                              <th style={{ width: '100px' }}>المجموعة</th>
                              <th style={{ width: '200px' }}>الباركود</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredStudents.map((student, index) => {
                              const barcode = sanitizeBarcode(student.barcode);
                              const groupName = student.group_id
                                ? groups.find(g => g.id === student.group_id)?.name
                                : '-';

                              return (
                                <tr key={student.id}>
                                  <td>{index + 1}</td>
                                  <td style={{ textAlign: 'right', paddingRight: '8px' }}>{student.name}</td>
                                  <td>{student.phone || '-'}</td>
                                  <td>{student.guardian_phone || '-'}</td>
                                  <td>{student.grade || '-'}</td>
                                  <td>{groupName}</td>
                                  <td className="barcode-cell">
                                    {barcode ? (
                                      <BarcodeReact
                                        value={barcode}
                                        width={1}
                                        height={30}
                                        fontSize={8}
                                        background="#ffffff"
                                        lineColor="#000000"
                                        margin={0}
                                      />
                                    ) : (
                                      <span style={{ color: '#f59e0b' }}>لا يوجد</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <div className="print-cards">
                          {filteredStudents.map((student, index) => {
                            const barcode = sanitizeBarcode(student.barcode);
                            const groupName = student.group_id ? groups.find(g => g.id === student.group_id)?.name : '-';
                            const initial = student.name ? student.name.trim().charAt(0) : '-';
                            return (
                              <div key={student.id} className="print-card" style={cardContainerStyle}>
                                <div style={cardHeaderStyle}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                                    <div style={avatarStyle}>{initial}</div>
                                    <div>
                                      <div style={nameStyle}>{student.name}</div>
                                      <div style={{ fontSize: 12, color: '#e6fffa', opacity: 0.95 }}>{student.grade || '---'}</div>
                                    </div>
                                  </div>
                                  <div style={{ textAlign: 'left' }}>
                                    <div style={statusBadgeStyle}>{student.active ? 'نشط' : 'غير نشط'}</div>
                                  </div>
                                </div>

                                {/* Student info section */}
                                <div style={{ padding: '16px 20px', background: '#f9fafb' }}>
                                  {/* Row 1: Phone number and Grade */}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, gap: 16 }}>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                        <div style={{ width: 16, height: 16, borderLeft: '3px solid #06b6d4' }}></div>
                                        <span style={{ fontSize: 11, color: '#666' }}>رقم الهاتف</span>
                                      </div>
                                      <div style={{ fontSize: 16, fontWeight: 700, paddingRight: 22, direction: 'ltr', textAlign: 'right' }}>{student.phone || '---'}</div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                        <div style={{ width: 16, height: 16, borderLeft: '3px solid #06b6d4' }}></div>
                                        <span style={{ fontSize: 11, color: '#666' }}>الصف</span>
                                      </div>
                                      <div style={{ fontSize: 16, fontWeight: 700, paddingRight: 22 }}>{student.grade || '---'}</div>
                                    </div>
                                  </div>

                                  {/* Row 2: Guardian phone and Group */}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14, gap: 16 }}>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                        <div style={{ width: 16, height: 16, borderLeft: '3px solid #06b6d4' }}></div>
                                        <span style={{ fontSize: 11, color: '#666' }}>ولي الأمر</span>
                                      </div>
                                      <div style={{ fontSize: 16, fontWeight: 700, paddingRight: 22, direction: 'ltr', textAlign: 'right' }}>{student.guardian_phone || '---'}</div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                        <div style={{ width: 16, height: 16, borderLeft: '3px solid #06b6d4' }}></div>
                                        <span style={{ fontSize: 11, color: '#666' }}>المجموعة</span>
                                      </div>
                                      <div style={{ fontSize: 16, fontWeight: 700, paddingRight: 22 }}>{groupName}</div>
                                    </div>
                                  </div>

                                  {/* Row 3: Status */}
                                  <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                      <div style={{ width: 16, height: 16, borderLeft: '3px solid #06b6d4' }}></div>
                                      <span style={{ fontSize: 11, color: '#666' }}>الحالة</span>
                                    </div>
                                    <div style={{ paddingRight: 22 }}>
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#d1fae5', color: '#065f46', padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600 }}>
                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }}></span>
                                        نشط
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {/* Barcode section */}
                                <div style={{ padding: '16px 20px 20px', textAlign: 'center', background: '#fff' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, justifyContent: 'center' }}>
                                    <div style={{ width: 16, height: 16, borderLeft: '3px solid #06b6d4' }}></div>
                                    <span style={{ fontSize: 11, color: '#666', fontWeight: 600 }}>الباركود</span>
                                  </div>
                                  {barcode ? (
                                    <div>
                                      <div style={{ background: '#fff', padding: 10, display: 'inline-block', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                                        <BarcodeReact value={barcode} width={1.5} height={55} fontSize={10} background="#fff" lineColor="#000" margin={0} />
                                      </div>
                                      <div style={{ marginTop: 8, fontSize: 10, letterSpacing: 2, color: '#666', fontWeight: 600 }}>{barcode}</div>
                                    </div>
                                  ) : (
                                    <div style={{ color: '#f59e0b', fontSize: 14, padding: '20px 0' }}>لا يوجد باركود</div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="grid grid-cols-1 md:grid-cols-3 gap-4 no-print">
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
