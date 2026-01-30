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
  AlertCircle, Users, Plus, Search, Upload
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Header from '@/components/Header';
import { VideoUploader } from '@/components/VideoUploader';
import { SecureVideoPlayer } from '@/components/SecureVideoPlayer';
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
  const [playingVideo, setPlayingVideo] = useState<{ videoId: string; title: string } | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingLecture, setEditingLecture] = useState<PremiumLecture | null>(null);
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectingPayment, setRejectingPayment] = useState<PremiumLecturePayment | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('lectures');
  const [uploadMethod, setUploadMethod] = useState<'url' | 'upload'>('upload');

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
        return <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-300">قيد المراجعة</Badge>;
      case 'approved':
        return <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300">تمت الموافقة</Badge>;
      case 'rejected':
        return <Badge variant="secondary" className="bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">مرفوض</Badge>;
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      
      {/* Video Player Modal */}
      {playingVideo && currentUser && (
        <SecureVideoPlayer
          videoId={playingVideo.videoId}
          userId={currentUser.id}
          studentName={currentUser.name || 'معاينة'}
          groupName={'معاينة المدرس'}
          onClose={handleCloseVideo}
        />
      )}

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
          <div className="flex items-center gap-3">
            <div className="p-3 bg-gradient-to-br from-cyan-500 to-teal-600 rounded-xl shadow-lg">
              <DollarSign className="h-8 w-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">الحصص المدفوعة</h1>
              <p className="text-sm text-muted-foreground mt-1">إدارة الحصص الإضافية المدفوعة وطلبات الدفع</p>
            </div>
          </div>
          <Button 
            onClick={() => setShowAddDialog(true)}
            className="bg-gradient-to-r from-cyan-500 to-teal-600 hover:from-cyan-600 hover:to-teal-700"
          >
            <Plus className="w-4 h-4 ml-2" />
            إضافة حصة جديدة
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="lectures" className="data-[state=active]:bg-cyan-600 data-[state=active]:text-white">
              <Video className="w-4 h-4 ml-2" />
              الحصص ({lectures.length})
            </TabsTrigger>
            <TabsTrigger value="pending" className="data-[state=active]:bg-cyan-600 data-[state=active]:text-white">
              <AlertCircle className="w-4 h-4 ml-2" />
              طلبات معلقة ({pendingPayments.length})
            </TabsTrigger>
            <TabsTrigger value="all-payments" className="data-[state=active]:bg-cyan-600 data-[state=active]:text-white">
              <DollarSign className="w-4 h-4 ml-2" />
              جميع الطلبات ({allPayments.length})
            </TabsTrigger>
          </TabsList>

          {/* Lectures Tab */}
          <TabsContent value="lectures">
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-5 h-5" />
                <Input
                  type="text"
                  placeholder="البحث في الحصص..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pr-10"
                />
              </div>
            </div>

            {loading ? (
              <div className="text-center text-muted-foreground py-12">جاري التحميل...</div>
            ) : filteredLectures.length === 0 ? (
              <Card className="shadow-lg">
                <CardContent className="py-12 text-center">
                  <Video className="w-16 h-16 mx-auto text-muted-foreground/40 mb-4" />
                  <p className="text-muted-foreground">لا توجد حصص مدفوعة بعد</p>
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
                    <Card className="shadow-lg hover:shadow-xl transition-all overflow-hidden">
                      <div className="relative h-40 bg-gradient-to-br from-cyan-500/20 to-teal-500/20">
                        {lecture.thumbnail_url ? (
                          <img 
                            src={lecture.thumbnail_url} 
                            alt={lecture.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Video className="w-16 h-16 text-cyan-500/30" />
                          </div>
                        )}
                        <div className="absolute top-2 left-2">
                          <Badge className={lecture.is_published ? 'bg-green-500' : 'bg-yellow-500'}>
                            {lecture.is_published ? 'منشورة' : 'مسودة'}
                          </Badge>
                        </div>
                        <div className="absolute bottom-2 right-2">
                          <Badge className="bg-cyan-600">
                            <DollarSign className="w-3 h-3 ml-1" />
                            {lecture.price} جنيه
                          </Badge>
                        </div>
                      </div>
                      <CardContent className="p-4">
                        <h3 className="text-lg font-semibold mb-2 line-clamp-2">{lecture.title}</h3>
                        {lecture.description && (
                          <p className="text-muted-foreground text-sm mb-3 line-clamp-2">{lecture.description}</p>
                        )}
                        <div className="flex flex-wrap gap-2 mb-3">
                          {lecture.grade_name && (
                            <Badge variant="outline">
                              {lecture.grade_name}
                            </Badge>
                          )}
                          {lecture.group_name && (
                            <Badge variant="outline">
                              {lecture.group_name}
                            </Badge>
                          )}
                          {lecture.duration_minutes && lecture.duration_minutes > 0 && (
                            <Badge variant="outline">
                              <Clock className="w-3 h-3 ml-1" />
                              {lecture.duration_minutes} دقيقة
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center justify-between text-sm text-muted-foreground mb-4">
                          <span className="flex items-center">
                            <Users className="w-4 h-4 ml-1" />
                            {lecture.enrolled_count || 0} مشترك
                          </span>
                          {lecture.pending_payments && lecture.pending_payments > 0 && (
                            <span className="flex items-center text-yellow-600">
                              <AlertCircle className="w-4 h-4 ml-1" />
                              {lecture.pending_payments} طلب معلق
                            </span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() => {
                              // Extract video ID from video:// URL
                              const videoId = lecture.video_url?.startsWith('video://') 
                                ? lecture.video_url.replace('video://', '')
                                : lecture.video_url;
                              setPlayingVideo({ videoId, title: lecture.title });
                            }}
                          >
                            <Play className="w-4 h-4 ml-1" />
                            تشغيل
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleEdit(lecture)}
                          >
                            تعديل
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/50 text-red-600 hover:bg-red-500/20"
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
              <Card className="shadow-lg">
                <CardContent className="py-12 text-center">
                  <Check className="w-16 h-16 mx-auto text-green-500 mb-4" />
                  <p className="text-muted-foreground">لا توجد طلبات دفع معلقة</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {pendingPayments.map((payment) => (
                  <Card key={payment.id} className="shadow-lg">
                    <CardContent className="p-6">
                      <div className="flex flex-col md:flex-row gap-6">
                        {/* Receipt Image */}
                        <div 
                          className="w-full md:w-48 h-48 bg-muted rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
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
                              <h3 className="text-xl font-semibold mb-1">{payment.lecture_title}</h3>
                              <p className="text-muted-foreground">{payment.student_name}</p>
                            </div>
                            {getStatusBadge(payment.status)}
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                            <div>
                              <p className="text-muted-foreground text-sm">رقم الهاتف</p>
                              <p>{payment.student_phone}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground text-sm">الصف</p>
                              <p>{payment.grade_name || '-'}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground text-sm">المجموعة</p>
                              <p>{payment.group_name || '-'}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground text-sm">المبلغ</p>
                              <p className="font-bold">{payment.lecture_price} جنيه</p>
                            </div>
                          </div>

                          {payment.notes && (
                            <div className="mb-4">
                              <p className="text-muted-foreground text-sm">ملاحظات الطالب</p>
                              <p>{payment.notes}</p>
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
              <Card className="shadow-lg">
                <CardContent className="py-12 text-center">
                  <DollarSign className="w-16 h-16 mx-auto text-muted-foreground/40 mb-4" />
                  <p className="text-muted-foreground">لا توجد طلبات دفع</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="shadow-lg">
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b">
                          <th className="text-right text-muted-foreground p-4">الطالب</th>
                          <th className="text-right text-muted-foreground p-4">الحصة</th>
                          <th className="text-right text-muted-foreground p-4">المبلغ</th>
                          <th className="text-right text-muted-foreground p-4">الحالة</th>
                          <th className="text-right text-muted-foreground p-4">التاريخ</th>
                          <th className="text-right text-muted-foreground p-4">إجراءات</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allPayments.map((payment) => (
                          <tr key={payment.id} className="border-b hover:bg-muted/50">
                            <td className="p-4">
                              <div>
                                <p className="font-medium">{payment.student_name}</p>
                                <p className="text-muted-foreground text-sm">{payment.student_phone}</p>
                              </div>
                            </td>
                            <td className="p-4">{payment.lecture_title}</td>
                            <td className="p-4">{payment.lecture_price} جنيه</td>
                            <td className="p-4">{getStatusBadge(payment.status)}</td>
                            <td className="p-4 text-muted-foreground">
                              {payment.created_at ? new Date(payment.created_at).toLocaleDateString('ar-EG') : '-'}
                            </td>
                            <td className="p-4">
                              <Button
                                variant="ghost"
                                size="sm"
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
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingLecture ? 'تعديل الحصة المدفوعة' : 'إضافة حصة مدفوعة جديدة'}</DialogTitle>
          </DialogHeader>
          
          {/* Upload Method Tabs */}
          <Tabs value={uploadMethod} onValueChange={(v) => setUploadMethod(v as 'url' | 'upload')} className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="upload" className="flex items-center gap-2">
                <Upload className="h-4 w-4" />
                رفع فيديو
              </TabsTrigger>
              <TabsTrigger value="url" className="flex items-center gap-2">
                <Video className="h-4 w-4" />
                رابط Google Drive
              </TabsTrigger>
            </TabsList>

            {/* Tab 1: Upload Video */}
            <TabsContent value="upload" className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label>الصف الدراسي *</Label>
                  <Select value={formData.grade_id} onValueChange={(v) => setFormData({ ...formData, grade_id: v, group_id: '' })}>
                    <SelectTrigger className="mt-2">
                      <SelectValue placeholder="اختر الصف الدراسي" />
                    </SelectTrigger>
                    <SelectContent>
                      {grades.map((grade) => (
                        <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>المجموعة *</Label>
                  <Select 
                    value={formData.group_id} 
                    onValueChange={(v) => setFormData({ ...formData, group_id: v })}
                    disabled={!formData.grade_id}
                  >
                    <SelectTrigger className="mt-2">
                      <SelectValue placeholder={formData.grade_id ? "اختر المجموعة" : "اختر الصف أولاً"} />
                    </SelectTrigger>
                    <SelectContent>
                      {groups
                        .filter(group => group.grade_id === formData.grade_id)
                        .map((group) => (
                          <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="md:col-span-2">
                  <Label>عنوان الحصة *</Label>
                  <Input
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="أدخل عنوان الحصة"
                    className="mt-2"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <Label>الوصف</Label>
                  <Textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="وصف الحصة..."
                    className="mt-2"
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
                    className="mt-2"
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
                    className="mt-2"
                    min="0"
                  />
                </div>

                <div className="md:col-span-2 flex items-center gap-3">
                  <Switch
                    id="is_published_upload"
                    checked={formData.is_published}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_published: checked })}
                  />
                  <Label htmlFor="is_published_upload">نشر الحصة (جعلها مرئية للطلاب)</Label>
                </div>
              </div>

              {/* Show upload section */}
              {formData.grade_id && formData.group_id && formData.title && formData.price && (
                <div className="border-t pt-4 mt-4">
                  <div className="p-4 bg-cyan-50 dark:bg-cyan-950 rounded-lg mb-4">
                    <h3 className="font-bold text-cyan-700 dark:text-cyan-300 mb-2">📋 ملخص الحصة</h3>
                    <div className="space-y-1 text-sm">
                      <p><strong>الصف:</strong> {grades.find(g => g.id === formData.grade_id)?.name}</p>
                      <p><strong>المجموعة:</strong> {groups.find(g => g.id === formData.group_id)?.name}</p>
                      <p><strong>العنوان:</strong> {formData.title}</p>
                      <p><strong>السعر:</strong> {formData.price} جنيه</p>
                      {formData.description && <p><strong>الوصف:</strong> {formData.description}</p>}
                    </div>
                  </div>

                  <VideoUploader
                    courseId="premium"
                    uploadedBy={currentUser?.id || ''}
                    title={formData.title}
                    description={formData.description}
                    onUploadComplete={async (videoId) => {
                      try {
                        const lectureData = {
                          title: formData.title,
                          description: formData.description || undefined,
                          video_url: `video://${videoId}`,
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
                        } else {
                          await createPremiumLecture(lectureData);
                        }

                        toast({
                          title: 'نجح',
                          description: 'تم رفع الحصة والفيديو بنجاح'
                        });

                        resetForm();
                        loadData();
                      } catch (error) {
                        console.error('Error creating lecture:', error);
                        toast({
                          title: 'خطأ',
                          description: 'الفيديو تم رفعه لكن فشل حفظ بيانات الحصة',
                          variant: 'destructive'
                        });
                      }
                    }}
                    onCancel={resetForm}
                  />
                </div>
              )}
            </TabsContent>

            {/* Tab 2: Google Drive URL */}
            <TabsContent value="url">
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label>الصف الدراسي *</Label>
                    <Select value={formData.grade_id} onValueChange={(v) => setFormData({ ...formData, grade_id: v, group_id: '' })}>
                      <SelectTrigger className="mt-2">
                        <SelectValue placeholder="اختر الصف الدراسي" />
                      </SelectTrigger>
                      <SelectContent>
                        {grades.map((grade) => (
                          <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>المجموعة *</Label>
                    <Select 
                      value={formData.group_id} 
                      onValueChange={(v) => setFormData({ ...formData, group_id: v })}
                      disabled={!formData.grade_id}
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue placeholder={formData.grade_id ? "اختر المجموعة" : "اختر الصف أولاً"} />
                      </SelectTrigger>
                      <SelectContent>
                        {groups
                          .filter(group => group.grade_id === formData.grade_id)
                          .map((group) => (
                            <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="md:col-span-2">
                    <Label>عنوان الحصة *</Label>
                    <Input
                      value={formData.title}
                      onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                      placeholder="أدخل عنوان الحصة"
                      className="mt-2"
                      required
                    />
                  </div>

                  <div className="md:col-span-2">
                    <Label>الوصف</Label>
                    <Textarea
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      placeholder="وصف الحصة..."
                      className="mt-2"
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
                      className="mt-2"
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
                      className="mt-2"
                      min="0"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <Label>رابط الفيديو من Google Drive *</Label>
                    <Input
                      value={formData.video_url}
                      onChange={(e) => setFormData({ ...formData, video_url: e.target.value })}
                      placeholder="https://drive.google.com/file/d/..."
                      className="mt-2"
                      required
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      الصق رابط الفيديو من Google Drive
                    </p>
                  </div>

                  <div className="md:col-span-2">
                    <Label>رابط الصورة المصغرة</Label>
                    <Input
                      value={formData.thumbnail_url}
                      onChange={(e) => setFormData({ ...formData, thumbnail_url: e.target.value })}
                      placeholder="رابط صورة الغلاف (اختياري)"
                      className="mt-2"
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
                    className="bg-gradient-to-r from-cyan-500 to-teal-600"
                  >
                    {loading ? 'جاري الحفظ...' : (editingLecture ? 'تحديث' : 'إنشاء')}
                  </Button>
                </DialogFooter>
              </form>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </div>
  );
}
