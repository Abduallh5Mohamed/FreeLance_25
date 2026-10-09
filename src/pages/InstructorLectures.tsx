import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Video, Play, Upload, Search, Plus, Send, X, Loader2, CheckCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import Header from '@/components/Header';
import VideoUploader from '@/components/VideoUploader';
import { VideoPlayer } from '@/components/VideoPlayer';
import { SecureVideoPlayer } from '@/components/SecureVideoPlayer';
import {
  getInstructorLectures,
  getInstructorWallet,
  getAvailableLecturesForRequest,
  sendVideoRequest,
  createInstructorLecture,
  updateLecture,
  reprocessVideo,
  getGrades,
  getGroups,
  Grade,
  Group,
  User,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export default function InstructorLectures() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [walletBalance, setWalletBalance] = useState(0);
  const [lectures, setLectures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Upload dialog
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadMethod, setUploadMethod] = useState<'upload' | 'url'>('upload');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    video_url: '',
    duration_minutes: '',
    price: '',
    grade_id: '',
    group_id: '',
    is_free: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [uploadComplete, setUploadComplete] = useState(false);
  const [completedVideoUrl, setCompletedVideoUrl] = useState('');

  // Request dialog
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [availableLectures, setAvailableLectures] = useState<any[]>([]);
  const [browseSearch, setBrowseSearch] = useState('');
  const [selectedForRequest, setSelectedForRequest] = useState<any>(null);
  const [requestMessage, setRequestMessage] = useState('');
  const [sending, setSending] = useState(false);

  // Video player modal
  const [playingVideo, setPlayingVideo] = useState<{ url: string; title: string } | null>(null);
  const handleCloseVideo = useCallback(() => {
    setPlayingVideo(null);
  }, []);

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (!userStr) { navigate('/auth'); return; }
    const user = JSON.parse(userStr) as User;
    if (user.role !== 'instructor' && user.role !== 'admin') { navigate('/auth'); return; }
    setCurrentUser(user);
    loadData(user.id);
  }, []);

  const loadData = async (id: string) => {
    try {
      setLoading(true);
      const [lecs, wallet, available, gradesData, groupsData] = await Promise.allSettled([
        getInstructorLectures(id),
        getInstructorWallet(id),
        getAvailableLecturesForRequest(id),
        getGrades(),
        getGroups(),
      ]);
      if (lecs.status === 'fulfilled') setLectures(lecs.value || []);
      if (wallet.status === 'fulfilled') setWalletBalance(Number(wallet.value?.balance ?? 0));
      if (available.status === 'fulfilled') setAvailableLectures(available.value || []);
      if (gradesData.status === 'fulfilled') setGrades(gradesData.value || []);
      if (groupsData.status === 'fulfilled') setGroups(groupsData.value || []);
    } finally {
      setLoading(false);
    }
  };

  const resetUploadForm = useCallback(() => {
    setFormData({ title: '', description: '', video_url: '', duration_minutes: '', price: '', grade_id: '', group_id: '', is_free: false });
    setCompletedVideoUrl('');
    setUploadComplete(false);
    setUploadMethod('upload');
  }, []);

  const handleUrlSubmit = async () => {
    if (!currentUser || !formData.title || !formData.video_url) {
      toast({ variant: 'destructive', title: 'خطأ', description: 'يرجى ملء العنوان ورابط الفيديو' });
      return;
    }
    try {
      setSubmitting(true);
      await createInstructorLecture({
        instructor_id: currentUser.id,
        title: formData.title,
        description: formData.description || undefined,
        video_url: formData.video_url,
        grade_id: formData.grade_id || undefined,
        group_id: formData.group_id || undefined,
        duration_minutes: formData.duration_minutes ? parseInt(formData.duration_minutes) : undefined,
        price: Number(formData.price),
        is_free: formData.is_free,
      });
      toast({ title: '✅ تمت إضافة المحاضرة', description: 'تم رفع المحاضرة بنجاح' });
      setUploadDialogOpen(false);
      resetUploadForm();
      loadData(currentUser.id);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'خطأ', description: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendRequest = async () => {
    if (!selectedForRequest || !currentUser) return;
    try {
      setSending(true);
      await sendVideoRequest({
        owner_id: String(selectedForRequest.instructor_id),
        requested_title: String(selectedForRequest.title || ''),
        requested_grade: String(selectedForRequest.grade_name || 'غير محدد'),
        requested_group: 'غير محدد',
        message: requestMessage || undefined,
      });
      toast({ title: '✅ تم إرسال الطلب', description: `طلبك على "${selectedForRequest.title}" تم إرساله` });
      setRequestDialogOpen(false);
      setSelectedForRequest(null);
      setRequestMessage('');
      loadData(currentUser.id);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'خطأ', description: err.message });
    } finally {
      setSending(false);
    }
  };

  const filteredLectures = lectures.filter(l =>
    l.title?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredAvailable = availableLectures.filter(l =>
    l.title?.toLowerCase().includes(browseSearch.toLowerCase()) ||
    l.instructor_name?.toLowerCase().includes(browseSearch.toLowerCase())
  );

  const formatDuration = (mins?: number) =>
    mins ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}` : '—';

  const filteredGroups = groups.filter(g => formData.grade_id ? g.grade_id === formData.grade_id : true);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50" dir="rtl">
      <Header />

      <main className="container mx-auto px-4 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-6 flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent flex items-center gap-2">
              <Video className="w-8 h-8 text-indigo-600" />
              فيديوهاتي
            </h1>
            <p className="text-slate-500 mt-1">{lectures.length} فيديو في مكتبتك</p>
          </div>
          <div className="flex gap-2">
            <Button
              className="bg-indigo-600 hover:bg-indigo-700 gap-2"
              onClick={() => { resetUploadForm(); setUploadDialogOpen(true); }}
            >
              <Upload className="w-4 h-4" />
              رفع فيديو جديد
            </Button>
            <Button
              className="bg-purple-600 hover:bg-purple-700 gap-2"
              onClick={() => navigate('/instructor-video-requests')}
            >
              <Send className="w-4 h-4" />
              طلب فيديو من instructor آخر
            </Button>
          </div>
        </motion.div>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute right-3 top-2.5 w-4 h-4 text-slate-400" />
          <Input
            placeholder="ابحث في فيديوهاتك…"
            className="pr-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Lectures grid */}
        {loading ? (
          <div className="text-center py-16 text-slate-400">جاري التحميل…</div>
        ) : filteredLectures.length === 0 ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center text-slate-400">
              <Video className="w-14 h-14 mx-auto mb-4 opacity-20" />
              <p className="font-medium">{lectures.length === 0 ? 'لا توجد فيديوهات بعد' : 'لا توجد نتائج للبحث'}</p>
              <p className="text-sm mt-1">ابدأ برفع فيديو جديد أو طلب فيديو من instructors آخرين</p>
              <Button className="mt-4 bg-indigo-600 hover:bg-indigo-700" onClick={() => { resetUploadForm(); setUploadDialogOpen(true); }}>
                <Upload className="w-4 h-4 ml-1" /> رفع فيديو
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredLectures.map((lec, i) => (
              <motion.div
                key={lec.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <Card className="border-0 shadow-sm hover:shadow-lg transition-shadow h-full">
                  <CardContent className="p-0 h-full flex flex-col">
                    {/* Thumbnail area - click to play */}
                    <button
                      className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-t-lg p-6 flex flex-col items-center justify-center gap-2 cursor-pointer hover:from-indigo-600 hover:to-purple-700 transition-colors group"
                      onClick={() => setPlayingVideo({ url: lec.video_url, title: lec.title })}
                    >
                      <Play className="w-12 h-12 text-white opacity-80 group-hover:opacity-100 group-hover:scale-110 transition-all" />
                      <span className="text-xs text-white/70 font-medium">اضغط للمشاهدة</span>
                    </button>
                    <div className="p-4 flex flex-col flex-1">
                      <h3 className="font-semibold text-slate-800 mb-1 line-clamp-2">{lec.title}</h3>
                      {lec.description && (
                        <p className="text-sm text-slate-500 mb-3 line-clamp-2">{lec.description}</p>
                      )}
                      <div className="flex items-center gap-2 flex-wrap mt-auto">
                        {lec.grade_name && <Badge variant="outline" className="text-xs">{lec.grade_name}</Badge>}
                        {lec.course_name && <Badge variant="outline" className="text-xs bg-indigo-50 border-indigo-200 text-indigo-700">{lec.course_name}</Badge>}
                        {lec.duration_minutes && (
                          <span className="text-xs text-slate-400">{formatDuration(lec.duration_minutes)}</span>
                        )}
                        {Number(lec.price) > 0 && <Badge className="bg-emerald-100 text-emerald-800">{Number(lec.price).toFixed(2)} ج.م</Badge>}
                      </div>
                      <Button size="sm" variant="outline" className="mt-3" onClick={() => {
                        const value = window.prompt('سعر الفيديو بالجنيه:', Number(lec.price) > 0 ? String(lec.price) : '');
                        if (!value || Number(value) <= 0) return;
                        void updateLecture(lec.id, { price: Number(value) }).then(() => currentUser && loadData(currentUser.id)).catch(error => toast({ variant: 'destructive', title: 'تعذر تحديث السعر', description: error.message }));
                      }}>{Number(lec.price) > 0 ? 'تعديل السعر' : 'تحديد السعر ليصبح قابلًا للترشيح'}</Button>
                      {lec.video_url?.startsWith('video://') && lec.preview_status !== 'ready' && <Button size="sm" variant="outline" className="mt-2" onClick={() => {
                        const videoId = String(lec.video_url).replace('video://', '');
                        void reprocessVideo(videoId).then(() => toast({ title: 'بدأ تجهيز المعاينة الآمنة', description: 'سيصبح الفيديو قابلًا للترشيح بعد اكتمال المعالجة.' })).catch(error => toast({ variant: 'destructive', title: 'تعذر تجهيز المعاينة', description: error.message }));
                      }}>تجهيز معاينة المشاركة</Button>}
                      <Button
                        size="sm"
                        className="w-full mt-3 bg-indigo-600 hover:bg-indigo-700 gap-1"
                        onClick={() => setPlayingVideo({ url: lec.video_url, title: lec.title })}
                      >
                        <Play className="w-4 h-4" />
                        مشاهدة الفيديو
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      {/* ========== Upload Video Dialog ========== */}
      <Dialog open={uploadDialogOpen} onOpenChange={(open) => { setUploadDialogOpen(open); if (!open) resetUploadForm(); }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-indigo-600" />
              رفع فيديو جديد
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <Tabs value={uploadMethod} onValueChange={(v) => setUploadMethod(v as 'upload' | 'url')}>
              <TabsList className="grid w-full grid-cols-1">
                <TabsTrigger value="upload" className="gap-1"><Upload className="w-3 h-3" /> رفع ملف</TabsTrigger>
              </TabsList>

              {/* Tab 1: File Upload */}
              <TabsContent value="upload" className="space-y-4">
                <div>
                  <Label>عنوان المحاضرة *</Label>
                  <Input
                    placeholder="مثال: الدرس الأول - المقدمة"
                    value={formData.title}
                    onChange={e => setFormData({ ...formData, title: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>الوصف (اختياري)</Label>
                  <Textarea
                    placeholder="وصف مختصر للمحاضرة…"
                    value={formData.description}
                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                    rows={2}
                    className="mt-1"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>الصف الدراسي (اختياري)</Label>
                    <Select value={formData.grade_id} onValueChange={v => setFormData({ ...formData, grade_id: v, group_id: '' })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="اختر الصف" /></SelectTrigger>
                      <SelectContent>
                        {grades.map(g => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>المجموعة (اختياري)</Label>
                    <Select value={formData.group_id} onValueChange={v => setFormData({ ...formData, group_id: v })} disabled={!formData.grade_id}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="اختر المجموعة" /></SelectTrigger>
                      <SelectContent>
                        {filteredGroups.map(g => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label htmlFor="video_price">سعر الفيديو بالجنيه *</Label>
                  <Input id="video_price" type="number" min="0.01" step="0.01" value={formData.price}
                    onChange={e => setFormData({ ...formData, price: e.target.value })} placeholder="مثال: 100" />
                </div>

                {/* Upload component - show only when title is filled */}
                {formData.title && Number(formData.price) > 0 && currentUser && (
                  <div className="border-t pt-4">
                    <VideoUploader
                      courseId={formData.grade_id || '00000000-0000-0000-0000-000000000000'}
                      uploadedBy={currentUser.id}
                      title={formData.title}
                      description={formData.description}
                      onUploadComplete={async (videoId) => {
                        try {
                          await createInstructorLecture({
                            instructor_id: currentUser.id,
                            title: formData.title,
                            description: formData.description || undefined,
                            video_url: `video://${videoId}`,
                            grade_id: formData.grade_id || undefined,
                            group_id: formData.group_id || undefined,
                            duration_minutes: formData.duration_minutes ? parseInt(formData.duration_minutes) : undefined,
                            price: Number(formData.price),
                            is_free: formData.is_free,
                          });
                          toast({ title: '✅ تمت إضافة المحاضرة', description: 'تم رفع الفيديو وحفظ المحاضرة بنجاح' });
                          setUploadDialogOpen(false);
                          resetUploadForm();
                          loadData(currentUser.id);
                        } catch (err: any) {
                          toast({ variant: 'destructive', title: 'خطأ', description: 'الفيديو تم رفعه لكن فشل حفظ بيانات المحاضرة: ' + err.message });
                        }
                      }}
                      onCancel={() => resetUploadForm()}
                    />
                  </div>
                )}
              </TabsContent>

              {/* Tab 2: URL */}
              <TabsContent value="url" className="space-y-4">
                <div>
                  <Label>عنوان المحاضرة *</Label>
                  <Input
                    placeholder="مثال: الدرس الأول - المقدمة"
                    value={formData.title}
                    onChange={e => setFormData({ ...formData, title: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>الوصف (اختياري)</Label>
                  <Textarea
                    placeholder="وصف مختصر للمحاضرة…"
                    value={formData.description}
                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                    rows={2}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>رابط الفيديو *</Label>
                  <Input
                    placeholder="https://drive.google.com/... أو رابط مباشر"
                    value={formData.video_url}
                    onChange={e => setFormData({ ...formData, video_url: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>مدة المحاضرة (بالدقائق)</Label>
                  <Input
                    type="number"
                    placeholder="60"
                    value={formData.duration_minutes}
                    onChange={e => setFormData({ ...formData, duration_minutes: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>الصف الدراسي (اختياري)</Label>
                    <Select value={formData.grade_id} onValueChange={v => setFormData({ ...formData, grade_id: v, group_id: '' })}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="اختر الصف" /></SelectTrigger>
                      <SelectContent>
                        {grades.map(g => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>المجموعة (اختياري)</Label>
                    <Select value={formData.group_id} onValueChange={v => setFormData({ ...formData, group_id: v })} disabled={!formData.grade_id}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder="اختر المجموعة" /></SelectTrigger>
                      <SelectContent>
                        {filteredGroups.map(g => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="is_free_url" checked={formData.is_free}
                    onChange={e => setFormData({ ...formData, is_free: e.target.checked })} className="w-4 h-4" />
                  <Label htmlFor="is_free_url" className="cursor-pointer text-sm">محاضرة مجانية (متاحة لجميع الطلاب)</Label>
                </div>
                <Button
                  className="w-full bg-indigo-600 hover:bg-indigo-700"
                  onClick={handleUrlSubmit}
                  disabled={submitting || !formData.title || !formData.video_url}
                >
                  {submitting ? 'جاري الحفظ…' : (<><Upload className="w-4 h-4 ml-1" /> إضافة المحاضرة</>)}
                </Button>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* ========== Request Video Dialog ========== */}
      <Dialog open={requestDialogOpen} onOpenChange={setRequestDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5 text-purple-600" />
              طلب فيديو من instructor آخر
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute right-3 top-2.5 w-4 h-4 text-slate-400" />
              <Input
                placeholder="ابحث عن فيديو…"
                className="pr-9"
                value={browseSearch}
                onChange={e => setBrowseSearch(e.target.value)}
              />
            </div>

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {filteredAvailable.length === 0 ? (
                <p className="text-center text-slate-400 py-4 text-sm">لا توجد فيديوهات متاحة</p>
              ) : filteredAvailable.map(lec => (
                <div
                  key={lec.id}
                  className={`p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                    selectedForRequest?.id === lec.id
                      ? 'border-purple-400 bg-purple-50'
                      : 'border-slate-100 hover:border-purple-200 bg-white'
                  }`}
                  onClick={() => setSelectedForRequest(lec)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm text-slate-800">{lec.title}</p>
                      <p className="text-xs text-slate-500">من: {lec.instructor_name}</p>
                    </div>
                    {lec.request_status && (
                      <Badge variant="outline" className="text-xs">
                        {lec.request_status === 'pending' ? 'معلق' : lec.request_status === 'rejected' ? 'مرفوض' : 'مقبول'}
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {selectedForRequest && (
              <div>
                <Label>رسالة لصاحب الفيديو (اختياري)</Label>
                <Textarea
                  placeholder="اكتب سبب الطلب أو أي ملاحظة…"
                  value={requestMessage}
                  onChange={e => setRequestMessage(e.target.value)}
                  rows={2}
                  className="mt-1"
                />
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRequestDialogOpen(false)}>إلغاء</Button>
            <Button
              className="bg-purple-600 hover:bg-purple-700"
              disabled={!selectedForRequest || sending || !!selectedForRequest?.request_status}
              onClick={handleSendRequest}
            >
              {sending ? 'جاري الإرسال…' : 'إرسال الطلب'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* ========== Video Player Modal ========== */}
      {playingVideo && currentUser && (
        <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl border-2 border-indigo-500/20">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-indigo-50 to-purple-50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-500 rounded-lg">
                  <Video className="h-5 w-5 text-white" />
                </div>
                <h3 className="text-xl font-bold text-slate-800 truncate">
                  {playingVideo.title || 'عرض الفيديو'}
                </h3>
              </div>
              <button
                onClick={handleCloseVideo}
                className="p-2 hover:bg-red-100 hover:text-red-600 transition-colors rounded-full"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Video Container */}
            <div className="flex-1 bg-black relative" style={{ minHeight: '500px' }}>
              {playingVideo.url.startsWith('video://') ? (
                <SecureVideoPlayer
                  videoId={playingVideo.url.replace('video://', '')}
                  userId={currentUser.id}
                  studentName={currentUser.name || ''}
                  groupName=""
                  onClose={handleCloseVideo}
                />
              ) : (
                <VideoPlayer
                  url={playingVideo.url}
                  title={playingVideo.title}
                  userId={currentUser.id}
                  onClose={handleCloseVideo}
                />
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-slate-50 border-t text-center">
              <p className="text-sm text-slate-500">
                💡 اضغط ESC للخروج • يتم البث من خوادم المنصة
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
