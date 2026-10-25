import { useState, useEffect, useCallback, useRef } from "react";
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
import { motion } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { useToast } from "@/hooks/use-toast";
import { SecureVideoPlayer } from "@/components/SecureVideoPlayer";
import {
  getStudentAvailablePremiumLectures, getStudentPurchasedPremiumLectures,
  getStudentPremiumPayments, getCurrentStudentEnrollment,
  authenticatedApiFetch, readAuthenticatedApiJson,
  AUTH_SESSION_CHANGED_EVENT,
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
  tenant_id?: string;
  business_name?: string;
}

const readSessionToken = () => localStorage.getItem('authToken') ?? '';

const getErrorStatus = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null) {
    if ('status' in error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number') return status;
    }
    if ('response' in error) {
      const response = (error as { response?: { status?: unknown } }).response;
      if (typeof response?.status === 'number') return response.status;
    }
  }
  return undefined;
};

const describePremiumLoadError = (error: unknown): string => {
  const status = getErrorStatus(error);
  if (status === 401) return 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.';
  if (status === 403) return 'لا تملك صلاحية عرض الحصص المدفوعة في هذه المساحة.';
  if (status === 409) return 'اختر مساحة المدرس أولاً لعرض الحصص المدفوعة.';
  if (status === 404) return 'لم يتم العثور على تسجيل الطالب في هذه المساحة.';
  if (typeof status === 'number') return 'تعذر تحميل بيانات الحصص المدفوعة من الخادم. حاول مرة أخرى.';
  return 'تعذر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.';
};

const safeHttpUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<{ videoId: string; title: string } | null>(null);
  const [activeTab, setActiveTab] = useState('available');

  const isMountedRef = useRef(true);
  const userLoadSeqRef = useRef(0);
  const dataLoadSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const submitGuardRef = useRef(false);
  const paymentGenerationRef = useRef(0);

  // Payment Dialog State
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [selectedLecture, setSelectedLecture] = useState<PremiumLecture | null>(null);
  const [receiptImage, setReceiptImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [paymentNotes, setPaymentNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const resetPaymentDraft = useCallback(() => {
    paymentGenerationRef.current += 1;
    submitGuardRef.current = false;
    setSubmitting(false);
    previewSeqRef.current += 1;
    setShowPaymentDialog(false);
    setSelectedLecture(null);
    setReceiptImage(null);
    setImagePreview(null);
    setPaymentNotes('');
  }, []);

  const loadData = useCallback(async (studentId: string) => {
    const requestSeq = ++dataLoadSeqRef.current;
    const startingToken = readSessionToken();
    const isCurrent = () =>
      isMountedRef.current
      && requestSeq === dataLoadSeqRef.current
      && startingToken === readSessionToken();

    try {
      const [available, purchased, payments] = await Promise.all([
        getStudentAvailablePremiumLectures(studentId),
        getStudentPurchasedPremiumLectures(studentId),
        getStudentPremiumPayments(studentId)
      ]);
      if (!isCurrent()) return;
      if (!Array.isArray(available) || !Array.isArray(purchased) || !Array.isArray(payments)) {
        throw new Error('Invalid premium lectures response');
      }

      setAvailableLectures(available);
      setPurchasedLectures(purchased);
      setMyPayments(payments);
      setLoadError(null);
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error loading lectures:', error);
      if (getErrorStatus(error) === 401) {
        navigate('/auth');
        return;
      }
      setAvailableLectures([]);
      setPurchasedLectures([]);
      setMyPayments([]);
      setLoadError(describePremiumLoadError(error));
    }
  }, [navigate]);

  const loadUserAndData = useCallback(async () => {
    const requestSeq = ++userLoadSeqRef.current;
    dataLoadSeqRef.current += 1;
    const startingToken = readSessionToken();

    setLoading(true);
    setLoadError(null);
    setAvailableLectures([]);
    setPurchasedLectures([]);
    setMyPayments([]);

    try {
      if (!startingToken) {
        navigate('/auth');
        return;
      }

      const userStr = localStorage.getItem('currentUser');
      if (!userStr) {
        navigate('/auth');
        return;
      }

      let user: User;
      try {
        user = JSON.parse(userStr) as User;
      } catch {
        navigate('/auth');
        return;
      }
      if (!user || typeof user !== 'object') {
        navigate('/auth');
        return;
      }
      if (user.role !== 'student') {
        navigate('/forbidden');
        return;
      }
      if (!isMountedRef.current || requestSeq !== userLoadSeqRef.current) return;

      setCurrentUser(user);
      setCurrentStudent(null);

      // The server-derived enrollment id (selected workspace) is the only id
      // accepted by the premium endpoints; never fall back to the user id.
      const student = await getCurrentStudentEnrollment();
      if (!isMountedRef.current || requestSeq !== userLoadSeqRef.current || startingToken !== readSessionToken()) return;
      if (!student || typeof student.id !== 'string' || !student.id) {
        throw new Error('STUDENT_ENROLLMENT_UNRESOLVED');
      }

      setCurrentStudent(student);
      await loadData(student.id);
    } catch (error) {
      if (!isMountedRef.current || requestSeq !== userLoadSeqRef.current || startingToken !== readSessionToken()) return;
      console.error('Error loading user data:', error);
      if (getErrorStatus(error) === 401) {
        navigate('/auth');
        return;
      }
      setLoadError(describePremiumLoadError(error));
    } finally {
      if (isMountedRef.current && requestSeq === userLoadSeqRef.current) setLoading(false);
    }
  }, [navigate, loadData]);

  useEffect(() => {
    isMountedRef.current = true;
    void loadUserAndData();

    const refreshSession = () => {
      userLoadSeqRef.current += 1;
      dataLoadSeqRef.current += 1;
      previewSeqRef.current += 1;
      submitGuardRef.current = false;
      setCurrentUser(null);
      setCurrentStudent(null);
      setAvailableLectures([]);
      setPurchasedLectures([]);
      setMyPayments([]);
      setPlayingVideo(null);
      setSubmitting(false);
      resetPaymentDraft();
      void loadUserAndData();
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key
        || event.key === 'authToken'
        || event.key === 'currentUser'
        || event.key === 'currentStudent'
        || event.key === 'currentStudentSpace') {
        refreshSession();
      }
    };

    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refreshSession);
    window.addEventListener('storage', onStorage);
    return () => {
      isMountedRef.current = false;
      paymentGenerationRef.current += 1;
      userLoadSeqRef.current += 1;
      dataLoadSeqRef.current += 1;
      previewSeqRef.current += 1;
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refreshSession);
      window.removeEventListener('storage', onStorage);
    };
  }, [loadUserAndData, resetPaymentDraft]);

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
        previewSeqRef.current += 1;
        setReceiptImage(null);
        setImagePreview(null);
        return;
      }

      if (!file.type.startsWith('image/')) {
        toast({
          title: "نوع الملف غير صحيح",
          description: "يرجى اختيار صورة فقط",
          variant: "destructive",
        });
        previewSeqRef.current += 1;
        setReceiptImage(null);
        setImagePreview(null);
        return;
      }

      const requestSeq = ++previewSeqRef.current;
      setReceiptImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        if (!isMountedRef.current || requestSeq !== previewSeqRef.current) return;
        setImagePreview(typeof reader.result === 'string' ? reader.result : null);
      };
      reader.onerror = () => {
        if (!isMountedRef.current || requestSeq !== previewSeqRef.current) return;
        setReceiptImage(null);
        setImagePreview(null);
        toast({
          title: "تعذر قراءة الصورة",
          description: "اختر صورة أخرى من فضلك",
          variant: "destructive",
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const clearReceiptPreview = () => {
    previewSeqRef.current += 1;
    setReceiptImage(null);
    setImagePreview(null);
  };

  const handleOpenPaymentDialog = (lecture: PremiumLecture) => {
    resetPaymentDraft();
    setSelectedLecture(lecture);
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

    const startingToken = readSessionToken();
    const generation = paymentGenerationRef.current;
    const isCurrentPayment = () => isMountedRef.current
      && generation === paymentGenerationRef.current && startingToken === readSessionToken();
    if (!startingToken) {
      navigate('/auth');
      return;
    }
    if (submitGuardRef.current) return;
    submitGuardRef.current = true;
    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('premium_lecture_id', selectedLecture.id);
      formData.append('amount', String(selectedLecture.price));
      formData.append('receipt', receiptImage);
      if (paymentNotes) {
        formData.append('notes', paymentNotes);
      }

      const response = await authenticatedApiFetch('/premium-lectures/payments', {
        method: 'POST',
        body: formData,
      });
      if (!isCurrentPayment()) return;
      if (response.status === 401) {
        navigate('/auth');
        return;
      }
      if (!response.ok) {
        const payload = await readAuthenticatedApiJson(response).catch(() => null);
        if (!isCurrentPayment()) return;
        const message = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : null;
        toast({
          title: response.status === 403 ? "لا تملك صلاحية" : "تعذر إرسال الطلب",
          description: message || "فشل في إرسال طلب الدفع",
          variant: "destructive",
        });
        return;
      }

      const payment = await readAuthenticatedApiJson(response);
      if (!isCurrentPayment()) return;

      if (readSessionToken() !== startingToken) {
        toast({
          title: "تغيّرت الجلسة",
          description: "لم نتأكد من تسجيل الطلب في هذه الجلسة. إيصالك وملاحظاتك باقية؛ راجع طلباتي قبل إعادة الإرسال.",
          variant: "destructive",
        });
        return;
      }
      if (!payment
        || typeof payment.id !== 'string'
        || !payment.id
        || payment.status !== 'pending'
        || payment.premium_lecture_id !== selectedLecture.id) {
        toast({
          title: "تعذر تأكيد الطلب",
          description: "لم نتأكد من تسجيل طلب الدفع. لم نمسح إيصالك؛ راجع \"طلباتي\" قبل إعادة الإرسال.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "تم الإرسال",
        description: "تم إرسال طلب الدفع بنجاح، سيتم مراجعته قريباً",
      });

      resetPaymentDraft();
      await loadData(currentStudent.id);
    } catch (error) {
      if (!isCurrentPayment()) return;
      console.error('Error submitting payment:', error);
      const status = getErrorStatus(error);
      if (status === 401) {
        navigate('/auth');
        return;
      }
      if ((error as { code?: unknown })?.code === 'CLIENT_SESSION_CHANGED') {
        toast({
          title: "تغيّرت الجلسة",
          description: "لم نمسح إيصالك. راجع طلباتي قبل إعادة الإرسال.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "خطأ",
        description: status === 403
          ? "لا تملك صلاحية إرسال طلب دفع لهذه الحصة."
          : status === 409
            ? "اختر مساحة المدرس أولاً قبل إرسال طلب الدفع."
            : error instanceof Error && error.message && !/^HTTP\s/.test(error.message)
              ? error.message
              : "فشل في إرسال طلب الدفع",
        variant: "destructive",
      });
    } finally {
      if (isCurrentPayment()) {
        submitGuardRef.current = false;
        setSubmitting(false);
      }
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

      {/* Payment Dialog */}
      <Dialog
        open={showPaymentDialog}
        onOpenChange={(open) => {
          if (open) {
            setShowPaymentDialog(true);
            return;
          }
          if (submitting) return;
          resetPaymentDraft();
        }}
      >
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
                        onClick={clearReceiptPreview}
                        disabled={submitting}
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
                        disabled={submitting}
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
                  disabled={submitting}
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={resetPaymentDraft}
              disabled={submitting}
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

        {loadError && (
          <div role="alert" className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            <p>{loadError}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void loadUserAndData()}>
              إعادة المحاولة
            </Button>
          </div>
        )}

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
            ) : loadError ? null : filteredAvailable.length === 0 ? (
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
            {loading ? (
              <div className="text-center text-muted-foreground py-12">جاري التحميل...</div>
            ) : loadError ? null : purchasedLectures.length === 0 ? (
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
                            const videoUrl = lecture.video_url?.trim() ?? '';
                            if (videoUrl.startsWith('video://')) {
                              const videoId = videoUrl.slice('video://'.length).trim();
                              if (!videoId) {
                                toast({
                                  title: "رابط الفيديو غير صالح",
                                  description: "لا يمكن تشغيل هذه الحصة الآن. تواصل مع المدرس.",
                                  variant: "destructive",
                                });
                                return;
                              }
                              setPlayingVideo({ videoId, title: lecture.title });
                              return;
                            }
                            toast({
                              title: "رابط الفيديو غير مدعوم",
                              description: "نوع رابط هذه الحصة غير معروف. تواصل مع المدرس.",
                              variant: "destructive",
                            });
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
            {loading ? (
              <div className="text-center text-muted-foreground py-12">جاري التحميل...</div>
            ) : loadError ? null : myPayments.length === 0 ? (
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
