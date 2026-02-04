import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Search, Play, Clock, DollarSign, Lock, Unlock, Upload,
  X, AlertCircle
} from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { useToast } from "@/hooks/use-toast";
import { SecureVideoPlayer } from "@/components/SecureVideoPlayer";
import { SecureYouTubePlayer } from "@/components/SecureYouTubePlayer";
import {
  getStudentAvailablePremiumLectures, getStudentPurchasedPremiumLectures,
  getStudentPremiumPayments, submitPremiumLecturePayment,
  PremiumLecture, PremiumLecturePayment, User
} from "@/lib/api-http";
import { useScreenRecordingPrevention } from "@/hooks/useScreenRecordingPrevention";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Student {
  id: string;
  name: string;
  phone?: string;
  grade_id?: string;
  group_id?: string;
}

const StudentPremiumLectures = () => {
  useScreenRecordingPrevention();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentStudent, setCurrentStudent] = useState<Student | null>(null);
  const [availableLectures, setAvailableLectures] = useState<PremiumLecture[]>([]);
  const [purchasedLectures, setPurchasedLectures] = useState<PremiumLecture[]>([]);
  const [myPayments, setMyPayments] = useState<PremiumLecturePayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingVideo, setPlayingVideo] = useState<{ videoId: string; title: string } | null>(null);
  const [playingYouTube, setPlayingYouTube] = useState<{ videoUrl: string; title: string } | null>(null);
  const [activeTab, setActiveTab] = useState('available');

  // Payment Dialog State
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [selectedLecture, setSelectedLecture] = useState<PremiumLecture | null>(null);
  const [receiptImage, setReceiptImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [paymentNotes, setPaymentNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadUserAndData();
  }, []);

  const loadUserAndData = async () => {
    try {
      setLoading(true);

      const userStr = localStorage.getItem('currentUser');
      const studentStr = localStorage.getItem('currentStudent');

      if (!userStr) {
        toast({
          title: 'خطأ',
          description: 'يرجى تسجيل الدخول مرة أخرى',
          variant: 'destructive'
        });
        navigate('/auth');
        return;
      }

      const user: User = JSON.parse(userStr);
      setCurrentUser(user);

      // Get student info
      let studentId = user.student_id || user.id;
      if (studentStr) {
        const student: Student = JSON.parse(studentStr);
        setCurrentStudent(student);
        studentId = student.id;
      }

      // Load all data
      await loadData(studentId);
    } catch (error) {
      console.error('Error loading user data:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل البيانات',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const loadData = async (studentId: string) => {
    try {
      const [available, purchased, payments] = await Promise.all([
        getStudentAvailablePremiumLectures(studentId),
        getStudentPurchasedPremiumLectures(studentId),
        getStudentPremiumPayments(studentId)
      ]);

      setAvailableLectures(available || []);
      setPurchasedLectures(purchased || []);
      setMyPayments(payments || []);
    } catch (error) {
      console.error('Error loading lectures:', error);
    }
  };

  const handleCloseVideo = useCallback(() => {
    setPlayingVideo(null);
  }, []);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: "حجم الصورة كبير",
          description: "الحد الأقصى لحجم الصورة هو 5 ميجابايت",
          variant: "destructive",
        });
        return;
      }

      if (!file.type.startsWith('image/')) {
        toast({
          title: "نوع الملف غير صحيح",
          description: "يرجى اختيار صورة فقط",
          variant: "destructive",
        });
        return;
      }

      setReceiptImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleOpenPaymentDialog = (lecture: PremiumLecture) => {
    setSelectedLecture(lecture);
    setReceiptImage(null);
    setImagePreview(null);
    setPaymentNotes('');
    setShowPaymentDialog(true);
  };

  const handleSubmitPayment = async () => {
    if (!selectedLecture || !receiptImage || !currentStudent) {
      toast({
        title: "خطأ",
        description: "يرجى رفع صورة إيصال الدفع",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('student_id', currentStudent.id);
      formData.append('premium_lecture_id', selectedLecture.id);
      formData.append('amount', selectedLecture.price.toString());
      formData.append('receipt', receiptImage);
      if (paymentNotes) {
        formData.append('notes', paymentNotes);
      }

      await submitPremiumLecturePayment(formData);

      toast({
        title: "تم الإرسال",
        description: "تم إرسال طلب الدفع بنجاح، سيتم مراجعته قريباً",
      });

      setShowPaymentDialog(false);
      setSelectedLecture(null);
      setReceiptImage(null);
      setImagePreview(null);
      setPaymentNotes('');

      // Reload data
      await loadData(currentStudent.id);
    } catch (error: any) {
      console.error('Error submitting payment:', error);
      toast({
        title: "خطأ",
        description: error.message || "فشل في إرسال طلب الدفع",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const getLectureStatus = (lecture: PremiumLecture) => {
    if (lecture.access_id) {
      return 'purchased';
    }
    if (lecture.payment_status === 'pending') {
      return 'pending';
    }
    return 'available';
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge className="bg-gradient-to-r from-yellow-500 to-orange-500 text-white border-0">قيد المراجعة</Badge>;
      case 'approved':
        return <Badge className="bg-gradient-to-r from-green-500 to-emerald-500 text-white border-0">تمت الموافقة</Badge>;
      case 'rejected':
        return <Badge className="bg-gradient-to-r from-red-500 to-pink-500 text-white border-0">مرفوض</Badge>;
      default:
        return null;
    }
  };

  const filteredAvailable = availableLectures.filter(l =>
    l.title.toLowerCase().includes(searchQuery.toLowerCase()) &&
    !l.access_id // Not already purchased
  );

  const filteredPurchased = purchasedLectures.filter(l =>
    l.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <StudentHeader />

      {/* Video Player Modal */}
      {playingVideo && currentUser && (
        <SecureVideoPlayer
          videoId={playingVideo.videoId}
          userId={currentUser.id}
          studentName={currentUser.name || 'طالب'}
          groupName={currentStudent?.group_id || 'المجموعة'}
          onClose={handleCloseVideo}
        />
      )}

      {/* YouTube/External Video Player Modal */}
      {playingYouTube && currentUser && (
        <SecureYouTubePlayer
          videoUrl={playingYouTube.videoUrl}
          userId={currentUser.id}
          studentName={currentUser.name || 'طالب'}
          groupName={currentStudent?.group_id || 'المجموعة'}
          title={playingYouTube.title}
          onClose={() => setPlayingYouTube(null)}
        />
      )}

      {/* Payment Dialog */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">إرسال إيصال الدفع</DialogTitle>
            <DialogDescription>
              قم برفع صورة إيصال الدفع للحصة
            </DialogDescription>
          </DialogHeader>

          {selectedLecture && (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg">
                <h4 className="font-semibold text-lg mb-2">{selectedLecture.title}</h4>
                <div className="flex items-center gap-2 text-primary">
                  <DollarSign className="w-5 h-5" />
                  <span className="text-xl font-bold">{selectedLecture.price} جنيه</span>
                </div>
              </div>

              <div>
                <Label>صورة إيصال الدفع *</Label>
                <div className="mt-2">
                  {imagePreview ? (
                    <div className="relative">
                      <img
                        src={imagePreview}
                        alt="معاينة الإيصال"
                        className="w-full h-48 object-cover rounded-lg"
                      />
                      <Button
                        variant="destructive"
                        size="icon"
                        className="absolute top-2 left-2"
                        onClick={() => {
                          setReceiptImage(null);
                          setImagePreview(null);
                        }}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ) : (
                    <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-dashed rounded-lg cursor-pointer hover:border-primary/50 transition-colors bg-muted/50">
                      <Upload className="w-10 h-10 text-white/40 mb-2" />
                      <span className="text-white/60">اضغط لرفع صورة الإيصال</span>
                      <span className="text-white/40 text-sm mt-1">PNG, JPG حتى 5MB</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleImageChange}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>
              </div>

              <div>
                <Label>ملاحظات (اختياري)</Label>
                <Textarea
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  placeholder="أي ملاحظات إضافية..."
                  className="mt-2"
                  rows={3}
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setShowPaymentDialog(false)}
            >
              إلغاء
            </Button>
            <Button
              onClick={handleSubmitPayment}
              disabled={!receiptImage || submitting}
              className="bg-gradient-to-r from-primary to-accent hover:shadow-glow"
            >
              {submitting ? 'جاري الإرسال...' : 'إرسال طلب الدفع'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <main className="container mx-auto px-4 py-8 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <h1 className="text-3xl md:text-4xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent mb-3">
            الحصص الإضافية المدفوعة
          </h1>
          <p className="text-muted-foreground">
            حصص إضافية مميزة لتعزيز مستواك الدراسي
          </p>
        </motion.div>

        {/* Search */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-6"
        >
          <div className="relative max-w-md mx-auto">
            <Search className="absolute right-4 top-1/2 transform -translate-y-1/2 text-muted-foreground w-5 h-5" />
            <Input
              type="text"
              placeholder="ابحث عن حصة..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pr-12 py-6 rounded-xl"
            />
          </div>
        </motion.div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="mb-6 w-full max-w-lg mx-auto grid grid-cols-3">
            <TabsTrigger value="available" className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-primary data-[state=active]:to-accent data-[state=active]:text-white">
              المتاحة
            </TabsTrigger>
            <TabsTrigger value="purchased" className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-primary data-[state=active]:to-accent data-[state=active]:text-white">
              المشتراة ({purchasedLectures.length})
            </TabsTrigger>
            <TabsTrigger value="payments" className="data-[state=active]:bg-gradient-to-r data-[state=active]:from-primary data-[state=active]:to-accent data-[state=active]:text-white">
              طلباتي ({myPayments.length})
            </TabsTrigger>
          </TabsList>

          {/* Available Lectures */}
          <TabsContent value="available">
            {loading ? (
              <div className="text-center text-muted-foreground py-12">جاري التحميل...</div>
            ) : filteredAvailable.length === 0 ? (
              <GlassmorphicCard className="py-12 text-center">
                <Lock className="w-16 h-16 mx-auto text-muted-foreground/40 mb-4" />
                <p className="text-muted-foreground">لا توجد حصص مدفوعة متاحة حالياً</p>
              </GlassmorphicCard>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredAvailable.map((lecture, index) => {
                  const status = getLectureStatus(lecture);
                  return (
                    <motion.div
                      key={lecture.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                    >
                      <GlassmorphicCard className="overflow-hidden hover:scale-[1.02] transition-transform">
                        {/* Thumbnail */}
                        <div className="relative h-44 bg-gradient-to-br from-primary/20 to-accent/20">
                          {lecture.thumbnail_url ? (
                            <img
                              src={lecture.thumbnail_url}
                              alt={lecture.title}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Play className="w-16 h-16 text-white/30" />
                            </div>
                          )}
                          <div className="absolute top-3 left-3">
                            <Badge className="bg-gradient-to-r from-primary to-accent text-white border-0">
                              <DollarSign className="w-3 h-3 ml-1" />
                              {lecture.price} جنيه
                            </Badge>
                          </div>
                          {status === 'pending' && (
                            <div className="absolute top-3 right-3">
                              <Badge className="bg-gradient-to-r from-yellow-500 to-orange-500 text-white border-0">
                                <AlertCircle className="w-3 h-3 ml-1" />
                                قيد المراجعة
                              </Badge>
                            </div>
                          )}
                        </div>

                        {/* Content */}
                        <div className="p-5">
                          <h3 className="text-lg font-bold mb-2 line-clamp-2">
                            {lecture.title}
                          </h3>
                          {lecture.description && (
                            <p className="text-muted-foreground text-sm mb-4 line-clamp-2">
                              {lecture.description}
                            </p>
                          )}

                          <div className="flex flex-wrap gap-2 mb-4">
                            {lecture.grade_name && (
                              <Badge variant="outline">
                                {lecture.grade_name}
                              </Badge>
                            )}
                            {lecture.duration_minutes && lecture.duration_minutes > 0 && (
                              <Badge variant="outline">
                                <Clock className="w-3 h-3 ml-1" />
                                {lecture.duration_minutes} دقيقة
                              </Badge>
                            )}
                          </div>

                          {status === 'pending' ? (
                            <Button
                              disabled
                              className="w-full bg-gradient-to-r from-yellow-500 to-orange-500 opacity-60"
                            >
                              <AlertCircle className="w-4 h-4 ml-2" />
                              طلب الدفع قيد المراجعة
                            </Button>
                          ) : (
                            <Button
                              onClick={() => handleOpenPaymentDialog(lecture)}
                              className="w-full bg-gradient-to-r from-primary to-accent hover:shadow-glow"
                            >
                              <Upload className="w-4 h-4 ml-2" />
                              رفع إيصال الدفع
                            </Button>
                          )}
                        </div>
                      </GlassmorphicCard>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* Purchased Lectures */}
          <TabsContent value="purchased">
            {purchasedLectures.length === 0 ? (
              <GlassmorphicCard className="py-12 text-center">
                <Unlock className="w-16 h-16 mx-auto text-muted-foreground/40 mb-4" />
                <p className="text-muted-foreground">لم تشترِ أي حصص بعد</p>
              </GlassmorphicCard>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredPurchased.map((lecture, index) => (
                  <motion.div
                    key={lecture.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                  >
                    <GlassmorphicCard className="overflow-hidden hover:scale-[1.02] transition-transform">
                      {/* Thumbnail */}
                      <div className="relative h-44 bg-gradient-to-br from-green-500/20 to-emerald-500/20">
                        {lecture.thumbnail_url ? (
                          <img
                            src={lecture.thumbnail_url}
                            alt={lecture.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Play className="w-16 h-16 text-white/30" />
                          </div>
                        )}
                        <div className="absolute top-3 left-3">
                          <Badge className="bg-gradient-to-r from-green-500 to-emerald-500 text-white border-0">
                            <Unlock className="w-3 h-3 ml-1" />
                            مفتوحة
                          </Badge>
                        </div>
                      </div>

                      {/* Content */}
                      <div className="p-5">
                        <h3 className="text-lg font-bold text-white mb-2 line-clamp-2">
                          {lecture.title}
                        </h3>
                        {lecture.description && (
                          <p className="text-white/60 text-sm mb-4 line-clamp-2">
                            {lecture.description}
                          </p>
                        )}

                        <div className="flex flex-wrap gap-2 mb-4">
                          {lecture.duration_minutes && lecture.duration_minutes > 0 && (
                            <Badge variant="outline" className="text-white/70 border-white/20">
                              <Clock className="w-3 h-3 ml-1" />
                              {lecture.duration_minutes} دقيقة
                            </Badge>
                          )}
                          {lecture.granted_at && (
                            <Badge variant="outline" className="text-green-400/70 border-green-500/30">
                              تم الشراء: {new Date(lecture.granted_at).toLocaleDateString('ar-EG')}
                            </Badge>
                          )}
                        </div>

                        <Button
                          onClick={() => {
                            const videoUrl = lecture.video_url;
                            
                            // Check video type
                            if (videoUrl.startsWith('video://')) {
                              // MinIO encrypted video
                              const videoId = videoUrl.replace('video://', '');
                              setPlayingVideo({ videoId, title: lecture.title });
                            } else if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
                              // YouTube video - play in secure player
                              setPlayingYouTube({ videoUrl, title: lecture.title });
                            } else if (videoUrl.includes('drive.google.com')) {
                              // Google Drive - play in secure player (same as YouTube)
                              setPlayingYouTube({ videoUrl: videoUrl.replace('/view', '/preview'), title: lecture.title });
                            } else {
                              // Unknown video type - try secure player
                              setPlayingYouTube({ videoUrl, title: lecture.title });
                            }
                          }}
                          className="w-full bg-gradient-to-r from-green-600 to-teal-600 hover:from-green-700 hover:to-teal-700"
                        >
                          <Play className="w-4 h-4 ml-2" />
                          مشاهدة الحصة
                        </Button>
                      </div>
                    </GlassmorphicCard>
                  </motion.div>
                ))}
              </div>
            )}
          </TabsContent>

          {/* My Payments */}
          <TabsContent value="payments">
            {myPayments.length === 0 ? (
              <GlassmorphicCard className="py-12 text-center">
                <DollarSign className="w-16 h-16 mx-auto text-white/20 mb-4" />
                <p className="text-white/60">لم ترسل أي طلبات دفع بعد</p>
              </GlassmorphicCard>
            ) : (
              <div className="space-y-4">
                {myPayments.map((payment) => (
                  <GlassmorphicCard key={payment.id} className="p-5">
                    <div className="flex flex-col md:flex-row gap-4 items-start">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-lg font-semibold text-white">{payment.lecture_title}</h3>
                          {getStatusBadge(payment.status)}
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <span className="text-white/50">المبلغ:</span>
                            <span className="text-white mr-2">{payment.lecture_price} جنيه</span>
                          </div>
                          <div>
                            <span className="text-white/50">التاريخ:</span>
                            <span className="text-white mr-2">
                              {payment.created_at ? new Date(payment.created_at).toLocaleDateString('ar-EG') : '-'}
                            </span>
                          </div>
                        </div>
                        {payment.status === 'rejected' && payment.rejection_reason && (
                          <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                            <p className="text-red-400 text-sm">
                              <AlertCircle className="w-4 h-4 inline ml-1" />
                              سبب الرفض: {payment.rejection_reason}
                            </p>
                          </div>
                        )}
                        {payment.notes && (
                          <p className="text-white/50 text-sm mt-2">ملاحظاتك: {payment.notes}</p>
                        )}
                      </div>
                    </div>
                  </GlassmorphicCard>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
};

export default StudentPremiumLectures;
