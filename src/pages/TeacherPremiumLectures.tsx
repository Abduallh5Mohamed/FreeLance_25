import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { 
  Video, Trash2, Play, DollarSign, Clock, Eye, X, Check, 
  AlertCircle, Users, Plus, Search
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Header from '@/components/Header';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  getPremiumLectures, createPremiumLecture, updatePremiumLecture, deletePremiumLecture,
  getPendingPremiumPayments, getAllPremiumPayments, approvePremiumPayment, rejectPremiumPayment,
  getGrades, getGroups, PremiumLecture, PremiumLecturePayment, User, Grade, Group
} from '@/lib/api-http';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

export default function TeacherPremiumLectures() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [lectures, setLectures] = useState<PremiumLecture[]>([]);
  const [pendingPayments, setPendingPayments] = useState<PremiumLecturePayment[]>([]);
  const [allPayments, setAllPayments] = useState<PremiumLecturePayment[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<{ url: string; title: string } | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingLecture, setEditingLecture] = useState<PremiumLecture | null>(null);
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectingPayment, setRejectingPayment] = useState<PremiumLecturePayment | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('lectures');

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    video_url: '',
    thumbnail_url: '',
    duration_minutes: '',
    price: '',
    grade_id: '',
    group_id: '',
    is_published: false
  });

  const handleCloseVideo = useCallback(() => {
    setPlayingVideo(null);
  }, []);

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (currentUser) {
      loadData();
    }
  }, [currentUser]);

  const checkAuth = async () => {
    try {
      const userStr = localStorage.getItem('currentUser');
      if (!userStr) {
        navigate('/auth');
        return;
      }

      const user = JSON.parse(userStr) as User;
      if (user.role !== 'admin' && user.role !== 'teacher') {
        navigate('/auth');
        return;
      }

      setCurrentUser(user);
    } catch (error) {
      console.error('Auth check error:', error);
      navigate('/auth');
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [lecturesData, gradesData, groupsData, pendingData, allPaymentsData] = await Promise.all([
        getPremiumLectures(),
        getGrades(),
        getGroups(),
        getPendingPremiumPayments(),
        getAllPremiumPayments()
      ]);
      setLectures(lecturesData || []);
      setGrades(gradesData || []);
      setGroups(groupsData || []);
      setPendingPayments(pendingData || []);
      setAllPayments(allPaymentsData || []);
    } catch (error) {
      console.error('Error loading data:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل في تحميل البيانات",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.title || !formData.video_url || !formData.price) {
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "العنوان ورابط الفيديو والسعر مطلوبين",
      });
      return;
    }

    setLoading(true);
    try {
      const lectureData = {
        title: formData.title,
        description: formData.description || undefined,
        video_url: formData.video_url,
        thumbnail_url: formData.thumbnail_url || undefined,
        duration_minutes: formData.duration_minutes ? parseInt(formData.duration_minutes) : 0,
        price: parseFloat(formData.price),
        grade_id: formData.grade_id || undefined,
        group_id: formData.group_id || undefined,
        is_published: formData.is_published,
        created_by: currentUser?.id
      };

      if (editingLecture) {
        await updatePremiumLecture(editingLecture.id, lectureData);
        toast({
          title: "تم التحديث",
          description: "تم تحديث الحصة المدفوعة بنجاح",
        });
      } else {
        await createPremiumLecture(lectureData);
        toast({
          title: "تم الإنشاء",
          description: "تم إنشاء الحصة المدفوعة بنجاح",
        });
      }

      resetForm();
      loadData();
    } catch (error) {
      console.error('Error saving lecture:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل في حفظ الحصة المدفوعة",
      });
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({
      title: '',
      description: '',
      video_url: '',
      thumbnail_url: '',
      duration_minutes: '',
      price: '',
      grade_id: '',
      group_id: '',
      is_published: false
    });
    setEditingLecture(null);
    setShowAddDialog(false);
  };

  const handleEdit = (lecture: PremiumLecture) => {
    setFormData({
      title: lecture.title,
      description: lecture.description || '',
      video_url: lecture.video_url,
      thumbnail_url: lecture.thumbnail_url || '',
      duration_minutes: lecture.duration_minutes?.toString() || '',
      price: lecture.price.toString(),
      grade_id: lecture.grade_id || '',
      group_id: lecture.group_id || '',
      is_published: lecture.is_published
    });
    setEditingLecture(lecture);
    setShowAddDialog(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذه الحصة؟')) return;

    try {
      await deletePremiumLecture(id);
      toast({
        title: "تم الحذف",
        description: "تم حذف الحصة المدفوعة بنجاح",
      });
      loadData();
    } catch (error) {
      console.error('Error deleting lecture:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل في حذف الحصة المدفوعة",
      });
    }
  };

  const handleApprovePayment = async (payment: PremiumLecturePayment) => {
    try {
      await approvePremiumPayment(payment.id, currentUser?.id);
      toast({
        title: "تمت الموافقة",
        description: "تمت الموافقة على طلب الدفع ومنح الطالب حق الوصول للحصة",
      });
      loadData();
    } catch (error) {
      console.error('Error approving payment:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل في الموافقة على طلب الدفع",
      });
    }
  };

  const handleRejectPayment = async () => {
    if (!rejectingPayment) return;

    try {
      await rejectPremiumPayment(rejectingPayment.id, rejectionReason, currentUser?.id);
      toast({
        title: "تم الرفض",
        description: "تم رفض طلب الدفع",
      });
      setRejectDialogOpen(false);
      setRejectingPayment(null);
      setRejectionReason('');
      loadData();
    } catch (error) {
      console.error('Error rejecting payment:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل في رفض طلب الدفع",
      });
    }
  };

  const handleVideoUploadComplete = (url: string, duration?: number) => {
    setFormData(prev => ({
      ...prev,
      video_url: url,
      duration_minutes: duration ? Math.ceil(duration / 60).toString() : prev.duration_minutes
    }));
  };

  const filteredLectures = lectures.filter(lecture => 
    lecture.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-300">قيد المراجعة</Badge>;
      case 'approved':
        return <Badge variant="secondary" className="bg-green-500/20 text-green-300">تمت الموافقة</Badge>;
      case 'rejected':
        return <Badge variant="secondary" className="bg-red-500/20 text-red-300">مرفوض</Badge>;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900" dir="rtl">
      <Header />
      
      {/* Video Player Modal */}
      <AnimatePresence>
        {playingVideo && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
            onClick={handleCloseVideo}
          >
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              className="relative w-full max-w-4xl"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon"
                className="absolute -top-12 left-0 text-white hover:bg-white/20"
                onClick={handleCloseVideo}
              >
                <X className="w-6 h-6" />
              </Button>
              <h3 className="text-white text-xl mb-4">{playingVideo.title}</h3>
              <div className="aspect-video bg-black rounded-lg overflow-hidden">
                <video
                  src={playingVideo.url}
                  controls
                  autoPlay
                  className="w-full h-full"
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Receipt Viewer Modal */}
      <AnimatePresence>
        {viewingReceipt && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
            onClick={() => setViewingReceipt(null)}
          >
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              className="relative max-w-2xl max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon"
                className="absolute -top-12 left-0 text-white hover:bg-white/20"
                onClick={() => setViewingReceipt(null)}
              >
                <X className="w-6 h-6" />
              </Button>
              <img 
                src={viewingReceipt} 
                alt="إيصال الدفع" 
                className="max-w-full max-h-[85vh] object-contain rounded-lg"
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent className="bg-slate-800 border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>رفض طلب الدفع</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الرفض (اختياري)</Label>
              <Textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="أدخل سبب الرفض..."
                className="bg-white/10 border-white/20 text-white mt-2"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectDialogOpen(false)}>إلغاء</Button>
            <Button variant="destructive" onClick={handleRejectPayment}>تأكيد الرفض</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">الحصص المدفوعة</h1>
            <p className="text-white/60">إدارة الحصص الإضافية المدفوعة وطلبات الدفع</p>
          </div>
          <Button 
            onClick={() => setShowAddDialog(true)}
            className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
          >
            <Plus className="w-4 h-4 ml-2" />
            إضافة حصة جديدة
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="bg-white/10 border-white/20 mb-6">
            <TabsTrigger value="lectures" className="data-[state=active]:bg-purple-600">
              <Video className="w-4 h-4 ml-2" />
              الحصص ({lectures.length})
            </TabsTrigger>
            <TabsTrigger value="pending" className="data-[state=active]:bg-purple-600">
              <AlertCircle className="w-4 h-4 ml-2" />
              طلبات معلقة ({pendingPayments.length})
            </TabsTrigger>
            <TabsTrigger value="all-payments" className="data-[state=active]:bg-purple-600">
              <DollarSign className="w-4 h-4 ml-2" />
              جميع الطلبات ({allPayments.length})
            </TabsTrigger>
          </TabsList>

          {/* Lectures Tab */}
          <TabsContent value="lectures">
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-white/40 w-5 h-5" />
                <Input
                  type="text"
                  placeholder="البحث في الحصص..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pr-10 bg-white/10 border-white/20 text-white placeholder:text-white/40"
                />
              </div>
            </div>

            {loading ? (
              <div className="text-center text-white py-12">جاري التحميل...</div>
            ) : filteredLectures.length === 0 ? (
              <Card className="bg-white/5 border-white/10">
                <CardContent className="py-12 text-center">
                  <Video className="w-16 h-16 mx-auto text-white/20 mb-4" />
                  <p className="text-white/60">لا توجد حصص مدفوعة بعد</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredLectures.map((lecture) => (
                  <motion.div
                    key={lecture.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <Card className="bg-white/5 border-white/10 hover:bg-white/10 transition-all overflow-hidden">
                      <div className="relative h-40 bg-gradient-to-br from-purple-600/30 to-pink-600/30">
                        {lecture.thumbnail_url ? (
                          <img 
                            src={lecture.thumbnail_url} 
                            alt={lecture.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Video className="w-16 h-16 text-white/30" />
                          </div>
                        )}
                        <div className="absolute top-2 left-2">
                          <Badge className={lecture.is_published ? 'bg-green-500' : 'bg-yellow-500'}>
                            {lecture.is_published ? 'منشورة' : 'مسودة'}
                          </Badge>
                        </div>
                        <div className="absolute bottom-2 right-2">
                          <Badge className="bg-purple-600">
                            <DollarSign className="w-3 h-3 ml-1" />
                            {lecture.price} جنيه
                          </Badge>
                        </div>
                      </div>
                      <CardContent className="p-4">
                        <h3 className="text-lg font-semibold text-white mb-2 line-clamp-2">{lecture.title}</h3>
                        {lecture.description && (
                          <p className="text-white/60 text-sm mb-3 line-clamp-2">{lecture.description}</p>
                        )}
                        <div className="flex flex-wrap gap-2 mb-3">
                          {lecture.grade_name && (
                            <Badge variant="outline" className="text-white/70 border-white/20">
                              {lecture.grade_name}
                            </Badge>
                          )}
                          {lecture.group_name && (
                            <Badge variant="outline" className="text-white/70 border-white/20">
                              {lecture.group_name}
                            </Badge>
                          )}
                          {lecture.duration_minutes && lecture.duration_minutes > 0 && (
                            <Badge variant="outline" className="text-white/70 border-white/20">
                              <Clock className="w-3 h-3 ml-1" />
                              {lecture.duration_minutes} دقيقة
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center justify-between text-sm text-white/50 mb-4">
                          <span className="flex items-center">
                            <Users className="w-4 h-4 ml-1" />
                            {lecture.enrolled_count || 0} مشترك
                          </span>
                          {lecture.pending_payments && lecture.pending_payments > 0 && (
                            <span className="flex items-center text-yellow-400">
                              <AlertCircle className="w-4 h-4 ml-1" />
                              {lecture.pending_payments} طلب معلق
                            </span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 border-white/20 text-white hover:bg-white/10"
                            onClick={() => setPlayingVideo({ url: lecture.video_url, title: lecture.title })}
                          >
                            <Play className="w-4 h-4 ml-1" />
                            تشغيل
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-white/20 text-white hover:bg-white/10"
                            onClick={() => handleEdit(lecture)}
                          >
                            تعديل
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/50 text-red-400 hover:bg-red-500/20"
                            onClick={() => handleDelete(lecture.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Pending Payments Tab */}
          <TabsContent value="pending">
            {pendingPayments.length === 0 ? (
              <Card className="bg-white/5 border-white/10">
                <CardContent className="py-12 text-center">
                  <Check className="w-16 h-16 mx-auto text-green-400 mb-4" />
                  <p className="text-white/60">لا توجد طلبات دفع معلقة</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {pendingPayments.map((payment) => (
                  <Card key={payment.id} className="bg-white/5 border-white/10">
                    <CardContent className="p-6">
                      <div className="flex flex-col md:flex-row gap-6">
                        {/* Receipt Image */}
                        <div 
                          className="w-full md:w-48 h-48 bg-white/10 rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setViewingReceipt(`http://localhost:3001${payment.receipt_image_url}`)}
                        >
                          <img 
                            src={`http://localhost:3001${payment.receipt_image_url}`}
                            alt="إيصال الدفع"
                            className="w-full h-full object-cover"
                          />
                        </div>

                        {/* Payment Details */}
                        <div className="flex-1">
                          <div className="flex items-start justify-between mb-4">
                            <div>
                              <h3 className="text-xl font-semibold text-white mb-1">{payment.lecture_title}</h3>
                              <p className="text-white/60">{payment.student_name}</p>
                            </div>
                            {getStatusBadge(payment.status)}
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                            <div>
                              <p className="text-white/40 text-sm">رقم الهاتف</p>
                              <p className="text-white">{payment.student_phone}</p>
                            </div>
                            <div>
                              <p className="text-white/40 text-sm">الصف</p>
                              <p className="text-white">{payment.grade_name || '-'}</p>
                            </div>
                            <div>
                              <p className="text-white/40 text-sm">المجموعة</p>
                              <p className="text-white">{payment.group_name || '-'}</p>
                            </div>
                            <div>
                              <p className="text-white/40 text-sm">المبلغ</p>
                              <p className="text-white font-bold">{payment.lecture_price} جنيه</p>
                            </div>
                          </div>

                          {payment.notes && (
                            <div className="mb-4">
                              <p className="text-white/40 text-sm">ملاحظات الطالب</p>
                              <p className="text-white/80">{payment.notes}</p>
                            </div>
                          )}

                          <div className="flex gap-3">
                            <Button
                              onClick={() => handleApprovePayment(payment)}
                              className="bg-green-600 hover:bg-green-700"
                            >
                              <Check className="w-4 h-4 ml-2" />
                              موافقة
                            </Button>
                            <Button
                              variant="destructive"
                              onClick={() => {
                                setRejectingPayment(payment);
                                setRejectDialogOpen(true);
                              }}
                            >
                              <X className="w-4 h-4 ml-2" />
                              رفض
                            </Button>
                            <Button
                              variant="outline"
                              className="border-white/20 text-white hover:bg-white/10"
                              onClick={() => setViewingReceipt(`http://localhost:3001${payment.receipt_image_url}`)}
                            >
                              <Eye className="w-4 h-4 ml-2" />
                              عرض الإيصال
                            </Button>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* All Payments Tab */}
          <TabsContent value="all-payments">
            {allPayments.length === 0 ? (
              <Card className="bg-white/5 border-white/10">
                <CardContent className="py-12 text-center">
                  <DollarSign className="w-16 h-16 mx-auto text-white/20 mb-4" />
                  <p className="text-white/60">لا توجد طلبات دفع</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="bg-white/5 border-white/10">
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-white/10">
                          <th className="text-right text-white/60 p-4">الطالب</th>
                          <th className="text-right text-white/60 p-4">الحصة</th>
                          <th className="text-right text-white/60 p-4">المبلغ</th>
                          <th className="text-right text-white/60 p-4">الحالة</th>
                          <th className="text-right text-white/60 p-4">التاريخ</th>
                          <th className="text-right text-white/60 p-4">إجراءات</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allPayments.map((payment) => (
                          <tr key={payment.id} className="border-b border-white/5 hover:bg-white/5">
                            <td className="p-4">
                              <div>
                                <p className="text-white font-medium">{payment.student_name}</p>
                                <p className="text-white/50 text-sm">{payment.student_phone}</p>
                              </div>
                            </td>
                            <td className="p-4 text-white">{payment.lecture_title}</td>
                            <td className="p-4 text-white">{payment.lecture_price} جنيه</td>
                            <td className="p-4">{getStatusBadge(payment.status)}</td>
                            <td className="p-4 text-white/60">
                              {payment.created_at ? new Date(payment.created_at).toLocaleDateString('ar-EG') : '-'}
                            </td>
                            <td className="p-4">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-white/60 hover:text-white"
                                onClick={() => setViewingReceipt(`http://localhost:3001${payment.receipt_image_url}`)}
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* Add/Edit Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => { if (!open) resetForm(); else setShowAddDialog(true); }}>
        <DialogContent className="bg-slate-800 border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingLecture ? 'تعديل الحصة المدفوعة' : 'إضافة حصة مدفوعة جديدة'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <Label>عنوان الحصة *</Label>
                <Input
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="أدخل عنوان الحصة"
                  className="bg-white/10 border-white/20 text-white mt-2"
                  required
                />
              </div>

              <div className="md:col-span-2">
                <Label>الوصف</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="وصف الحصة..."
                  className="bg-white/10 border-white/20 text-white mt-2"
                  rows={3}
                />
              </div>

              <div>
                <Label>السعر (جنيه) *</Label>
                <Input
                  type="number"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  placeholder="0"
                  className="bg-white/10 border-white/20 text-white mt-2"
                  min="0"
                  step="0.01"
                  required
                />
              </div>

              <div>
                <Label>المدة (دقيقة)</Label>
                <Input
                  type="number"
                  value={formData.duration_minutes}
                  onChange={(e) => setFormData({ ...formData, duration_minutes: e.target.value })}
                  placeholder="0"
                  className="bg-white/10 border-white/20 text-white mt-2"
                  min="0"
                />
              </div>

              <div>
                <Label>الصف الدراسي</Label>
                <Select value={formData.grade_id || 'all'} onValueChange={(v) => setFormData({ ...formData, grade_id: v === 'all' ? '' : v })}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white mt-2">
                    <SelectValue placeholder="اختر الصف" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">الكل</SelectItem>
                    {grades.map((grade) => (
                      <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>المجموعة</Label>
                <Select value={formData.group_id || 'all'} onValueChange={(v) => setFormData({ ...formData, group_id: v === 'all' ? '' : v })}>
                  <SelectTrigger className="bg-white/10 border-white/20 text-white mt-2">
                    <SelectValue placeholder="اختر المجموعة" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">الكل</SelectItem>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-2">
                <Label>رابط الفيديو *</Label>
                <div className="mt-2 space-y-4">
                  {/* Video URL input - for simplicity, use direct URL */}
                  <Input
                    value={formData.video_url}
                    onChange={(e) => setFormData({ ...formData, video_url: e.target.value })}
                    placeholder="أدخل رابط الفيديو (YouTube, Vimeo, أو رابط مباشر)"
                    className="bg-white/10 border-white/20 text-white"
                  />
                  <p className="text-white/40 text-sm">يمكنك إدخال رابط يوتيوب أو فيميو أو رابط فيديو مباشر</p>
              </div>
              </div>

              <div className="md:col-span-2">
                <Label>رابط الصورة المصغرة</Label>
                <Input
                  value={formData.thumbnail_url}
                  onChange={(e) => setFormData({ ...formData, thumbnail_url: e.target.value })}
                  placeholder="رابط صورة الغلاف (اختياري)"
                  className="bg-white/10 border-white/20 text-white mt-2"
                />
              </div>

              <div className="md:col-span-2 flex items-center gap-3">
                <Switch
                  id="is_published"
                  checked={formData.is_published}
                  onCheckedChange={(checked) => setFormData({ ...formData, is_published: checked })}
                />
                <Label htmlFor="is_published">نشر الحصة (جعلها مرئية للطلاب)</Label>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={resetForm}>إلغاء</Button>
              <Button 
                type="submit" 
                disabled={loading}
                className="bg-gradient-to-r from-purple-600 to-pink-600"
              >
                {loading ? 'جاري الحفظ...' : (editingLecture ? 'تحديث' : 'إنشاء')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
