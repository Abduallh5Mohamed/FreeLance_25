import { useState, useEffect, useCallback, useRef } from 'react';
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
import { SecureYouTubePlayer } from '@/components/SecureYouTubePlayer';
import { motion, AnimatePresence } from 'framer-motion';
import {
  getPremiumLectures, createPremiumLecture, updatePremiumLecture,
  getPendingPremiumPayments, getAllPremiumPayments, approvePremiumPayment, rejectPremiumPayment,
  getGrades, getGroups, AUTH_SESSION_CHANGED_EVENT,
  authenticatedApiFetch, readAuthenticatedApiJson,
  PremiumLecture, PremiumLecturePayment, User, Grade, Group
} from '@/lib/api-http';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

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

const describePremiumActionError = (error: unknown, fallback: string): string => {
  const status = getErrorStatus(error);
  if (status === 401) return 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.';
  if (status === 403) return 'لا تملك صلاحية تنفيذ هذا الإجراء في هذه المساحة.';
  if (status === 409 && (error as { code?: unknown })?.code === 'CLIENT_SESSION_CHANGED') {
    return 'تغيّرت الجلسة. أعد المحاولة بعد التأكد من الجلسة الحالية.';
  }
  if (typeof status === 'number') return fallback;
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

const isYouTubeUrl = (value: string): boolean => {
  const parsed = safeHttpUrl(value);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
};

const isGoogleDriveUrl = (value: string): boolean => {
  const parsed = safeHttpUrl(value);
  return parsed?.hostname.toLowerCase() === 'drive.google.com';
};

export default function TeacherPremiumLectures() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [lectures, setLectures] = useState<PremiumLecture[]>([]);
  const [pendingPayments, setPendingPayments] = useState<PremiumLecturePayment[]>([]);
  const [allPayments, setAllPayments] = useState<PremiumLecturePayment[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<{ videoId: string; title: string } | null>(null);
  const [playingYouTube, setPlayingYouTube] = useState<{ videoUrl: string; title: string } | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingLecture, setEditingLecture] = useState<PremiumLecture | null>(null);
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectingPayment, setRejectingPayment] = useState<PremiumLecturePayment | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('lectures');
  const [uploadMethod, setUploadMethod] = useState<'url' | 'upload' | 'youtube'>('upload');

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

  const latestDraftRef = useRef(formData);
  latestDraftRef.current = formData;

  const isMountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const submitGuardRef = useRef(false);
  const uploadGuardRef = useRef(false);
  const deleteGuardRef = useRef<Set<string>>(new Set());
  const paymentGuardRef = useRef<Set<string>>(new Set());
  const dialogTokenRef = useRef('');
  const dialogGenerationRef = useRef(0);

  const handleCloseVideo = useCallback(() => {
    setPlayingVideo(null);
  }, []);

  const checkAuth = useCallback(() => {
    const token = readSessionToken();
    const userStr = localStorage.getItem('currentUser');
    if (!token || !userStr) {
      navigate('/auth');
      return;
    }

    try {
      const user = JSON.parse(userStr) as User;
      if (user.role !== 'admin' && user.role !== 'teacher' && user.role !== 'instructor') {
        navigate('/forbidden');
        return;
      }
      setCurrentUser(user);
    } catch (error) {
      console.error('Auth check error:', error);
      navigate('/auth');
    }
  }, [navigate]);

  const loadData = useCallback(async () => {
    const requestSeq = ++loadSeqRef.current;
    const startingToken = readSessionToken();
    const isCurrent = () =>
      isMountedRef.current
      && requestSeq === loadSeqRef.current
      && startingToken === readSessionToken();

    setLoading(true);
    setLoadError(null);
    try {
      if (!startingToken) {
        navigate('/auth');
        return;
      }
      const [lecturesData, gradesData, groupsData, pendingData, allPaymentsData] = await Promise.all([
        getPremiumLectures(),
        getGrades(),
        getGroups(),
        getPendingPremiumPayments(),
        getAllPremiumPayments()
      ]);
      if (!isCurrent()) return;
      if (!Array.isArray(lecturesData)
        || !Array.isArray(gradesData)
        || !Array.isArray(groupsData)
        || !Array.isArray(pendingData)
        || !Array.isArray(allPaymentsData)) {
        throw new Error('Invalid premium lectures response');
      }
      setLectures(lecturesData);
      setGrades(gradesData);
      setGroups(groupsData);
      setPendingPayments(pendingData);
      setAllPayments(allPaymentsData);
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Error loading data:', error);
      if (getErrorStatus(error) === 401) {
        navigate('/auth');
        return;
      }
      setLectures([]);
      setGrades([]);
      setGroups([]);
      setPendingPayments([]);
      setAllPayments([]);
      setLoadError(describePremiumActionError(error, 'تعذر تحميل بيانات الحصص المدفوعة. حاول مرة أخرى.'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    isMountedRef.current = true;
    checkAuth();

    const refreshSession = () => {
      loadSeqRef.current += 1;
      setCurrentUser(null);
      setLectures([]);
      setGrades([]);
      setGroups([]);
      setPendingPayments([]);
      setAllPayments([]);
      setPlayingVideo(null);
      setPlayingYouTube(null);
      setViewingReceipt(null);
      setRejectDialogOpen(false);
      setRejectingPayment(null);
      setRejectionReason('');
      setLoadError(null);
      resetForm();
      checkAuth();
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === 'authToken' || event.key === 'currentUser') refreshSession();
    };

    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refreshSession);
    window.addEventListener('storage', onStorage);
    return () => {
      isMountedRef.current = false;
      dialogGenerationRef.current += 1;
      loadSeqRef.current += 1;
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refreshSession);
      window.removeEventListener('storage', onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkAuth]);

  useEffect(() => {
    if (currentUser) void loadData();
  }, [currentUser, loadData]);

  const validateAndBuildLecture = (videoUrlOverride?: string, draft = latestDraftRef.current) => {
    const videoUrl = (videoUrlOverride ?? draft.video_url).trim();
    if (!draft.title.trim() || !videoUrl || !draft.price.trim() || !draft.grade_id || !draft.group_id) {
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "العنوان ورابط الفيديو والسعر والصف والمجموعة مطلوبين",
      });
      return null;
    }

    const price = Number(draft.price);
    const durationMinutes = draft.duration_minutes.trim()
      ? Number.parseInt(draft.duration_minutes, 10)
      : 0;
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(durationMinutes) || durationMinutes < 0) {
      toast({
        variant: "destructive",
        title: "بيانات غير صالحة",
        description: "تحقق من السعر والمدة قبل الحفظ.",
      });
      return null;
    }

    return {
      title: draft.title.trim(),
      description: draft.description.trim() || undefined,
      video_url: videoUrl,
      thumbnail_url: draft.thumbnail_url.trim() || undefined,
      duration_minutes: durationMinutes,
      price,
      grade_id: draft.grade_id,
      group_id: draft.group_id,
      is_published: draft.is_published,
    };
  };

  const persistLecture = async (
    videoUrlOverride?: string,
    expectedGeneration = dialogGenerationRef.current,
    expectedToken = readSessionToken(),
  ): Promise<boolean> => {
    const isCurrent = () => isMountedRef.current
      && expectedGeneration === dialogGenerationRef.current
      && expectedToken === readSessionToken();
    if (!isCurrent()) return false;
    const submittedDraft = { ...latestDraftRef.current, ...(videoUrlOverride === undefined ? {} : { video_url: videoUrlOverride }) };
    const submittedFingerprint = JSON.stringify(submittedDraft);
    const lectureData = validateAndBuildLecture(videoUrlOverride, submittedDraft);
    if (!lectureData) return false;

    const startingToken = readSessionToken();
    if (!startingToken) {
      navigate('/auth');
      return false;
    }
    if (!dialogTokenRef.current || dialogTokenRef.current !== startingToken) {
      toast({
        variant: "destructive",
        title: "تغيّرت الجلسة",
        description: "أُغلق نموذج الحصة أو تغيّرت الجلسة. لم يتم حفظ أي تغيير.",
      });
      return false;
    }
    if (submitGuardRef.current) return false;

    submitGuardRef.current = true;
    setSaving(true);
    try {
      const saved = editingLecture
        ? await updatePremiumLecture(editingLecture.id, lectureData)
        : await createPremiumLecture(lectureData);

      if (!isCurrent()) return false;
      if (readSessionToken() !== startingToken) {
        toast({
          variant: "destructive",
          title: "تغيّرت الجلسة",
          description: "لم نتأكد من نتيجة الحفظ. بيانات النموذج باقية؛ راجع القائمة قبل إعادة المحاولة.",
        });
        return false;
      }
      if (!saved || typeof saved.id !== 'string' || !saved.id) {
        toast({
          variant: "destructive",
          title: "تعذر تأكيد الحفظ",
          description: "لم نتأكد من حفظ الحصة. بيانات النموذج باقية؛ راجع القائمة قبل إعادة المحاولة.",
        });
        return false;
      }

      toast({
        title: editingLecture ? "تم التحديث" : "تم الإنشاء",
        description: editingLecture
          ? "تم تحديث الحصة المدفوعة بنجاح"
          : "تم إنشاء الحصة المدفوعة بنجاح",
      });
      resetForm();
      await loadData();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      console.error('Error saving lecture:', error);
      const status = getErrorStatus(error);
      if (status === 401) {
        navigate('/auth');
        return false;
      }
      toast({
        variant: "destructive",
        title: "خطأ",
        description: describePremiumActionError(error, "فشل في حفظ الحصة المدفوعة"),
      });
      return false;
    } finally {
      if (isCurrent()) {
        submitGuardRef.current = false;
        setSaving(false);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void persistLecture();
  };

  const resetForm = () => {
    dialogGenerationRef.current += 1;
    submitGuardRef.current = false;
    uploadGuardRef.current = false;
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
    setSaving(false);
    dialogTokenRef.current = '';
  };

  const openAddDialog = () => {
    resetForm();
    dialogTokenRef.current = readSessionToken();
    setShowAddDialog(true);
  };

  const handleEdit = (lecture: PremiumLecture) => {
    resetForm();
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
    dialogTokenRef.current = readSessionToken();
    setShowAddDialog(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذه الحصة؟')) return;
    if (deleteGuardRef.current.has(id)) return;
    deleteGuardRef.current.add(id);

    const startingToken = readSessionToken();
    try {
      if (!startingToken) {
        navigate('/auth');
        return;
      }
      const response = await authenticatedApiFetch(`/premium-lectures/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (response.status === 401) {
        navigate('/auth');
        return;
      }
      if (!response.ok) {
        const payload = await readAuthenticatedApiJson(response).catch(() => null);
        const message = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : null;
        throw new Error(message || 'فشل في حذف الحصة المدفوعة');
      }
      const result = await readAuthenticatedApiJson(response);
      if (readSessionToken() !== startingToken) {
        toast({
          variant: "destructive",
          title: "تغيّرت الجلسة",
          description: "لم نتأكد من نتيجة الحذف. أعد تحميل القائمة قبل المحاولة مرة أخرى.",
        });
        return;
      }
      if (!result || typeof result !== 'object' || (result as { success?: unknown }).success !== true) {
        toast({
          variant: "destructive",
          title: "تعذر تأكيد الحذف",
          description: "لم نتأكد من حذف الحصة. أعد تحميل القائمة قبل المحاولة مرة أخرى.",
        });
        return;
      }
      toast({
        title: "تم الحذف",
        description: "تم حذف الحصة المدفوعة بنجاح",
      });
      await loadData();
    } catch (error) {
      console.error('Error deleting lecture:', error);
      if (getErrorStatus(error) === 401) {
        navigate('/auth');
        return;
      }
      toast({
        variant: "destructive",
        title: "خطأ",
        description: describePremiumActionError(error, "فشل في حذف الحصة المدفوعة"),
      });
    } finally {
      deleteGuardRef.current.delete(id);
    }
  };

  const handleApprovePayment = async (payment: PremiumLecturePayment) => {
    if (paymentGuardRef.current.has(payment.id)) return;
    paymentGuardRef.current.add(payment.id);

    const startingToken = readSessionToken();
    try {
      if (!startingToken) {
        navigate('/auth');
        return;
      }
      const result = await approvePremiumPayment(payment.id, currentUser?.id);
      if (readSessionToken() !== startingToken) {
        toast({
          variant: "destructive",
          title: "تغيّرت الجلسة",
          description: "لم نتأكد من نتيجة الموافقة. أعد تحميل الطلبات قبل المحاولة مرة أخرى.",
        });
        return;
      }
      if (!result || result.success !== true) {
        toast({
          variant: "destructive",
          title: "تعذر تأكيد الموافقة",
          description: "لم نتأكد من الموافقة على الطلب. أعد تحميل الطلبات قبل المحاولة مرة أخرى.",
        });
        return;
      }
      toast({
        title: "تمت الموافقة",
        description: "تمت الموافقة على طلب الدفع ومنح الطالب حق الوصول للحصة",
      });
      await loadData();
    } catch (error) {
      console.error('Error approving payment:', error);
      if (getErrorStatus(error) === 401) {
        navigate('/auth');
        return;
      }
      toast({
        variant: "destructive",
        title: "خطأ",
        description: describePremiumActionError(error, "فشل في الموافقة على طلب الدفع"),
      });
    } finally {
      paymentGuardRef.current.delete(payment.id);
    }
  };

  const handleRejectPayment = async () => {
    if (!rejectingPayment) return;
    const paymentId = rejectingPayment.id;
    if (paymentGuardRef.current.has(paymentId)) return;
    paymentGuardRef.current.add(paymentId);

    const startingToken = readSessionToken();
    try {
      if (!startingToken) {
        navigate('/auth');
        return;
      }
      const result = await rejectPremiumPayment(paymentId, rejectionReason, currentUser?.id);
      if (readSessionToken() !== startingToken) {
        toast({
          variant: "destructive",
          title: "تغيّرت الجلسة",
          description: "لم نتأكد من نتيجة الرفض. سبب الرفض باقٍ في النموذج؛ أعد تحميل الطلبات قبل المحاولة.",
        });
        return;
      }
      if (!result || result.success !== true) {
        toast({
          variant: "destructive",
          title: "تعذر تأكيد الرفض",
          description: "لم نتأكد من رفض الطلب. سبب الرفض باقٍ؛ أعد تحميل الطلبات قبل المحاولة.",
        });
        return;
      }
      toast({
        title: "تم الرفض",
        description: "تم رفض طلب الدفع",
      });
      setRejectDialogOpen(false);
      setRejectingPayment(null);
      setRejectionReason('');
      await loadData();
    } catch (error) {
      console.error('Error rejecting payment:', error);
      if (getErrorStatus(error) === 401) {
        navigate('/auth');
        return;
      }
      toast({
        variant: "destructive",
        title: "خطأ",
        description: describePremiumActionError(error, "فشل في رفض طلب الدفع"),
      });
    } finally {
      paymentGuardRef.current.delete(paymentId);
    }
  };

  // Global upload tasks can retain callbacks after the originating dialog closes.
  const uploadDialogGeneration = dialogGenerationRef.current;
  const uploadDialogToken = readSessionToken();
  const handleVideoUploadComplete = async (videoId: string) => {
    const ownsUpload = () => !!uploadDialogToken && isMountedRef.current
      && uploadDialogGeneration === dialogGenerationRef.current
      && uploadDialogToken === readSessionToken()
      && dialogTokenRef.current === uploadDialogToken;
    if (!ownsUpload()) return;
    if (uploadGuardRef.current) return;
    uploadGuardRef.current = true;
    const videoUrl = `video://${videoId}`;
    const uploadedDraft = { ...latestDraftRef.current, video_url: videoUrl };
    latestDraftRef.current = uploadedDraft;
    setFormData(uploadedDraft);
    try {
      await persistLecture(videoUrl, uploadDialogGeneration, uploadDialogToken);
    } finally {
      if (ownsUpload()) uploadGuardRef.current = false;
    }
  };

  const handlePreviewLecture = (lecture: PremiumLecture) => {
    const videoUrl = lecture.video_url?.trim() ?? '';
    if (videoUrl.startsWith('video://')) {
      const videoId = videoUrl.slice('video://'.length).trim();
      if (!videoId) {
        toast({
          variant: "destructive",
          title: "رابط الفيديو غير صالح",
          description: "لا يمكن معاينة هذه الحصة الآن.",
        });
        return;
      }
      setPlayingVideo({ videoId, title: lecture.title });
      return;
    }
    if (isYouTubeUrl(videoUrl) || isGoogleDriveUrl(videoUrl)) {
      setPlayingYouTube({ videoUrl, title: lecture.title });
      return;
    }
    toast({
      variant: "destructive",
      title: "رابط الفيديو غير مدعوم",
      description: "نوع رابط هذه الحصة غير معروف. استخدم رابط YouTube أو Google Drive أو ارفع الفيديو.",
    });
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

      {/* YouTube/Drive Preview Modal */}
      {playingYouTube && currentUser && (
        <SecureYouTubePlayer
          videoUrl={playingYouTube.videoUrl}
          userId={currentUser.id}
          studentName={currentUser.name || 'معاينة'}
          groupName={'معاينة المدرس'}
          title={playingYouTube.title}
          onClose={() => setPlayingYouTube(null)}
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
      <Dialog
        open={rejectDialogOpen}
        onOpenChange={(open) => {
          if (!open && rejectingPayment && paymentGuardRef.current.has(rejectingPayment.id)) return;
          setRejectDialogOpen(open);
        }}
      >
        <DialogContent className="bg-slate-800 border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>رفض طلب الدفع</DialogTitle>
            <DialogDescription>
              أدخل سبب رفض طلب الدفع
            </DialogDescription>
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
            <Button
              variant="ghost"
              onClick={() => {
                if (rejectingPayment && paymentGuardRef.current.has(rejectingPayment.id)) return;
                setRejectDialogOpen(false);
              }}
            >
              إلغاء
            </Button>
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
            onClick={openAddDialog}
            className="bg-gradient-to-r from-cyan-500 to-teal-600 hover:from-cyan-600 hover:to-teal-700"
          >
            <Plus className="w-4 h-4 ml-2" />
            إضافة حصة جديدة
          </Button>
        </div>

        {loading ? (
          <div className="text-center text-muted-foreground py-12">جاري التحميل...</div>
        ) : loadError ? (
          <Card className="shadow-lg">
            <CardContent className="py-12 text-center">
              <AlertCircle className="w-12 h-12 mx-auto text-destructive/60 mb-4" />
              <p role="alert" className="text-destructive mb-4">{loadError}</p>
              <Button variant="outline" onClick={() => void loadData()}>إعادة المحاولة</Button>
            </CardContent>
          </Card>
        ) : (
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

            {filteredLectures.length === 0 ? (
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
                            onClick={() => handlePreviewLecture(lecture)}
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
                          onClick={() => setViewingReceipt(payment.receipt_image_url)}
                        >
                          <img
                            src={payment.receipt_image_url}
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
                                setRejectionReason('');
                                setRejectDialogOpen(true);
                              }}
                            >
                              <X className="w-4 h-4 ml-2" />
                              رفض
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => setViewingReceipt(payment.receipt_image_url)}
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
                                onClick={() => setViewingReceipt(payment.receipt_image_url)}
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
        )}
      </main>

      {/* Add/Edit Dialog */}
      <Dialog
        open={showAddDialog}
        onOpenChange={(open) => {
          if (open) {
            setShowAddDialog(true);
            return;
          }
          if (saving) return;
          resetForm();
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingLecture ? 'تعديل الحصة المدفوعة' : 'إضافة حصة مدفوعة جديدة'}</DialogTitle>
            <DialogDescription>
              قم برفع فيديو أو إدخال رابط Google Drive
            </DialogDescription>
          </DialogHeader>

          {/* Upload Method Tabs */}
          <Tabs value={uploadMethod} onValueChange={(v) => setUploadMethod(v as 'url' | 'upload' | 'youtube')} className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-4">
              <TabsTrigger value="upload" className="flex items-center gap-2">
                <Upload className="h-4 w-4" />
                رفع فيديو
              </TabsTrigger>
              <TabsTrigger value="url" className="flex items-center gap-2">
                <Video className="h-4 w-4" />
                Google Drive
              </TabsTrigger>
              <TabsTrigger value="youtube" className="flex items-center gap-2">
                <Play className="h-4 w-4" />
                YouTube
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
                    onUploadComplete={handleVideoUploadComplete}
                    onCancel={() => {
                      if (saving) return;
                      resetForm();
                    }}
                  />
                  {formData.video_url.startsWith('video://') && (
                    <Button
                      type="button"
                      onClick={() => void persistLecture(formData.video_url)}
                      disabled={saving}
                      className="mt-4 bg-gradient-to-r from-cyan-500 to-teal-600"
                    >
                      {saving ? 'جاري الحفظ...' : 'حفظ بيانات الحصة'}
                    </Button>
                  )}
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
                  <Button type="button" variant="ghost" onClick={resetForm} disabled={saving}>إلغاء</Button>
                  <Button
                    type="submit"
                    disabled={saving}
                    className="bg-gradient-to-r from-cyan-500 to-teal-600"
                  >
                    {saving ? 'جاري الحفظ...' : (editingLecture ? 'تحديث' : 'إنشاء')}
                  </Button>
                </DialogFooter>
              </form>
            </TabsContent>

            {/* Tab 3: YouTube URL */}
            <TabsContent value="youtube">
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
                    <Label>رابط فيديو YouTube *</Label>
                    <Input
                      value={formData.video_url}
                      onChange={(e) => setFormData({ ...formData, video_url: e.target.value })}
                      placeholder="https://www.youtube.com/watch?v=... أو https://youtu.be/..."
                      className="mt-2"
                      required
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      الصق رابط الفيديو من YouTube (سيتم تأمينه تلقائياً)
                    </p>
                  </div>

                  <div className="md:col-span-2">
                    <Label>رابط الصورة المصغرة</Label>
                    <Input
                      value={formData.thumbnail_url}
                      onChange={(e) => setFormData({ ...formData, thumbnail_url: e.target.value })}
                      placeholder="رابط صورة الغلاف (اختياري - سيتم استخدام صورة YouTube تلقائياً)"
                      className="mt-2"
                    />
                  </div>

                  <div className="md:col-span-2 flex items-center gap-3">
                    <Switch
                      id="is_published_youtube"
                      checked={formData.is_published}
                      onCheckedChange={(checked) => setFormData({ ...formData, is_published: checked })}
                    />
                    <Label htmlFor="is_published_youtube">نشر الحصة (جعلها مرئية للطلاب)</Label>
                  </div>
                </div>

                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={resetForm} disabled={saving}>إلغاء</Button>
                  <Button
                    type="submit"
                    disabled={saving}
                    className="bg-gradient-to-r from-cyan-500 to-teal-600"
                  >
                    {saving ? 'جاري الحفظ...' : (editingLecture ? 'تحديث' : 'إنشاء')}
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
