import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Upload, Video, Trash2, Play, BookOpen, Clock, Eye, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Header from '@/components/Header';
import { motion } from 'framer-motion';
import { getCourses, getLectures, createLecture, deleteLecture, getGrades, getGroups, Course, Lecture, User, Grade, Group } from '@/lib/api';
import VideoUploader from '@/components/VideoUploader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { VideoPlayer } from '@/components/VideoPlayer';
import SimpleVideoPlayer from '@/components/SimpleVideoPlayer';

export default function TeacherLectures() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [uploadMethod, setUploadMethod] = useState<'url' | 'upload'>('upload');
  const [playingVideo, setPlayingVideo] = useState<{ url: string; title: string } | null>(null);

  // Use useCallback to prevent recreating this function on every render
  const handleCloseVideo = useCallback(() => {
    setPlayingVideo(null);
  }, []);

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    video_url: '',
    duration_minutes: '',
    grade_id: '',
    group_id: '',
    is_free: false
  });

  useEffect(() => {
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (currentUser) {
      loadCourses();
      loadGrades();
      loadGroups();
      loadLectures();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const checkAuth = async () => {
    try {
      const userStr = localStorage.getItem('currentUser');
      if (!userStr) {
        navigate('/auth');
        toast({
          variant: "destructive",
          title: "غير مسموح",
          description: "يرجى تسجيل الدخول كمعلم أولاً",
        });
        return;
      }

      const user = JSON.parse(userStr) as User;
      if (user.role !== 'admin' && user.role !== 'teacher' && user.role !== 'staff') {
        navigate('/auth');
        toast({
          variant: "destructive",
          title: "غير مسموح",
          description: "هذه الصفحة للمعلمين فقط",
        });
        return;
      }

      setCurrentUser(user);
    } catch (error) {
      console.error('Auth check error:', error);
      navigate('/auth');
    }
  };

  const loadCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data || []);
    } catch (error) {
      console.error('Error loading courses:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل الدورات',
        variant: 'destructive'
      });
    }
  };

  const loadGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data || []);
    } catch (error) {
      console.error('Error loading grades:', error);
    }
  };

  const loadGroups = async () => {
    try {
      const data = await getGroups();
      setGroups(data || []);
    } catch (error) {
      console.error('Error loading groups:', error);
    }
  };

  const loadLectures = async () => {
    try {
      const data = await getLectures();
      setLectures(data || []);
    } catch (error) {
      console.error('Error loading lectures:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCourse || !formData.grade_id || !formData.group_id || !formData.title || !formData.video_url) {
      toast({
        title: 'خطأ',
        description: 'يرجى ملء جميع الحقول المطلوبة (الدورة، الصف، المجموعة، العنوان، رابط الفيديو)',
        variant: 'destructive'
      });
      return;
    }

    setLoading(true);
    try {
      await createLecture({
        course_id: selectedCourse,
        grade_id: formData.grade_id || null,
        group_id: formData.group_id || null,
        title: formData.title,
        description: formData.description || null,
        video_url: formData.video_url,
        duration_minutes: formData.duration_minutes ? parseInt(formData.duration_minutes) : null,
        is_free: formData.is_free,
        is_published: true
      });

      toast({
        title: 'نجح',
        description: 'تم رفع المحاضرة بنجاح'
      });

      setFormData({
        title: '',
        description: '',
        video_url: '',
        duration_minutes: '',
        grade_id: '',
        group_id: '',
        is_free: false
      });
      setSelectedCourse('');
      loadLectures();
    } catch (error) {
      console.error('Error uploading lecture:', error);
      toast({
        title: 'خطأ',
        description: error instanceof Error ? error.message : 'فشل رفع المحاضرة',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذه المحاضرة؟')) return;

    try {
      await deleteLecture(id);
      toast({
        title: 'نجح',
        description: 'تم حذف المحاضرة'
      });
      loadLectures();
    } catch (error) {
      console.error('Error deleting lecture:', error);
      toast({
        title: 'خطأ',
        description: error instanceof Error ? error.message : 'فشل حذف المحاضرة',
        variant: 'destructive'
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950">
      <Header />

      {/* Video Player Modal */}
      {playingVideo && currentUser && (
        <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl border-2 border-purple-500/20">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-purple-50 to-pink-50 dark:from-gray-800 dark:to-gray-700">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-500 rounded-lg">
                  <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                  </svg>
                </div>
                <h3 className="text-xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                  {playingVideo.title || 'عرض الفيديو'}
                </h3>
              </div>
              <button
                onClick={handleCloseVideo}
                className="p-2 hover:bg-red-100 dark:hover:bg-red-900/20 hover:text-red-600 transition-colors rounded-full"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Video Container */}
            <div className="flex-1 bg-black relative" style={{ minHeight: '500px' }}>
              {playingVideo.url.startsWith('video://') ? (
                <SimpleVideoPlayer
                  videoId={playingVideo.url.replace('video://', '')}
                  userId={currentUser.id}
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
            <div className="px-4 py-3 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-700 border-t text-center">
              <p className="text-sm text-muted-foreground">
                💡 اضغط ESC للخروج • يتم البث من خوادم المنصة
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="w-full px-4 py-8 space-y-6" dir="rtl">
        <div className="max-w-7xl mx-auto">
          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 mb-8"
          >
            <div className="p-3 bg-gradient-to-br from-cyan-500 to-teal-600 rounded-xl shadow-lg">
              <Video className="h-8 w-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
                رفع المحاضرات
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                أضف محاضرات فيديو للطلاب
              </p>
            </div>
          </motion.div>

          <div className="grid grid-cols-1 gap-4 lg:gap-6">
            {/* Upload Form */}
            <Card className="shadow-lg border-t-4 border-t-cyan-500">
              <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5 text-cyan-600" />
                  رفع محاضرة جديدة
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <Tabs value={uploadMethod} onValueChange={(v) => setUploadMethod(v as 'url' | 'upload')} className="w-full">
                  <TabsList className="grid w-full grid-cols-2 mb-6">
                    <TabsTrigger value="upload" className="flex items-center gap-2">
                      <Upload className="h-4 w-4" />
                      رفع فيديو
                    </TabsTrigger>
                    <TabsTrigger value="url" className="flex items-center gap-2">
                      <Video className="h-4 w-4" />
                      رابط Google Drive
                    </TabsTrigger>
                  </TabsList>

                  {/* Tab 1: Upload Video to MinIO */}
                  <TabsContent value="upload" className="space-y-4">
                    <div className="space-y-4">
                      <div>
                        <Label>اختر الدورة *</Label>
                        <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                          <SelectTrigger>
                            <SelectValue placeholder="اختر الدورة" />
                          </SelectTrigger>
                          <SelectContent>
                            {courses.map(c => (
                              <SelectItem key={c.id} value={c.id}>
                                <div className="flex items-center gap-2">
                                  <BookOpen className="h-4 w-4 text-cyan-500" />
                                  {c.name}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label>الصف الدراسي *</Label>
                        <Select value={formData.grade_id} onValueChange={(value) => setFormData({ ...formData, grade_id: value, group_id: '' })}>
                          <SelectTrigger>
                            <SelectValue placeholder="اختر الصف الدراسي" />
                          </SelectTrigger>
                          <SelectContent>
                            {grades.map(grade => (
                              <SelectItem key={grade.id} value={grade.id}>
                                {grade.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label>المجموعة *</Label>
                        <Select
                          value={formData.group_id}
                          onValueChange={(value) => setFormData({ ...formData, group_id: value })}
                          disabled={!formData.grade_id}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={formData.grade_id ? "اختر المجموعة" : "اختر الصف أولاً"} />
                          </SelectTrigger>
                          <SelectContent>
                            {groups
                              .filter(group => group.grade_id === formData.grade_id)
                              .map(group => (
                                <SelectItem key={group.id} value={group.id}>
                                  {group.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label>عنوان المحاضرة *</Label>
                        <Input
                          value={formData.title}
                          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                          placeholder="مثال: الحرب العالمية الأولى"
                        />
                      </div>

                      <div>
                        <Label>وصف المحاضرة</Label>
                        <Textarea
                          value={formData.description}
                          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                          placeholder="وصف مختصر للمحاضرة..."
                          rows={3}
                        />
                      </div>

                      <div>
                        <Label>مدة المحاضرة (بالدقائق)</Label>
                        <Input
                          type="number"
                          value={formData.duration_minutes}
                          onChange={(e) => setFormData({ ...formData, duration_minutes: e.target.value })}
                          placeholder="60"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="is_free_upload"
                          checked={formData.is_free}
                          onChange={(e) => setFormData({ ...formData, is_free: e.target.checked })}
                          className="w-4 h-4"
                        />
                        <Label htmlFor="is_free_upload" className="cursor-pointer">
                          محاضرة مجانية (متاحة لجميع الطلاب)
                        </Label>
                      </div>

                      {/* Show upload section */}
                      {selectedCourse && formData.grade_id && formData.group_id && formData.title && (
                        <>
                          <div className="border-t pt-4 mt-4">
                            <div className="p-4 bg-cyan-50 dark:bg-cyan-950 rounded-lg mb-4">
                              <h3 className="font-bold text-cyan-700 dark:text-cyan-300 mb-2">📋 ملخص المحاضرة</h3>
                              <div className="space-y-1 text-sm">
                                <p><strong>الدورة:</strong> {courses.find(c => c.id === selectedCourse)?.name}</p>
                                <p><strong>الصف:</strong> {grades.find(g => g.id === formData.grade_id)?.name}</p>
                                <p><strong>المجموعة:</strong> {groups.find(g => g.id === formData.group_id)?.name}</p>
                                <p><strong>العنوان:</strong> {formData.title}</p>
                                {formData.description && <p><strong>الوصف:</strong> {formData.description}</p>}
                              </div>
                            </div>

                            <VideoUploader
                              courseId={selectedCourse}
                              uploadedBy={currentUser?.id || ''}
                              title={formData.title}
                              description={formData.description}
                              onUploadComplete={async (videoId) => {
                                try {
                                  await createLecture({
                                    course_id: selectedCourse,
                                    grade_id: formData.grade_id,
                                    group_id: formData.group_id,
                                    title: formData.title,
                                    description: formData.description || null,
                                    video_url: `video://${videoId}`,
                                    duration_minutes: formData.duration_minutes ? parseInt(formData.duration_minutes) : null,
                                    is_free: formData.is_free,
                                    is_published: true
                                  });

                                  toast({
                                    title: 'نجح',
                                    description: 'تم رفع المحاضرة والفيديو بنجاح'
                                  });

                                  setFormData({
                                    title: '',
                                    description: '',
                                    video_url: '',
                                    duration_minutes: '',
                                    grade_id: '',
                                    group_id: '',
                                    is_free: false
                                  });
                                  setSelectedCourse('');
                                  loadLectures();
                                } catch (error) {
                                  console.error('Error creating lecture:', error);
                                  toast({
                                    title: 'خطأ',
                                    description: 'الفيديو تم رفعه لكن فشل حفظ بيانات المحاضرة',
                                    variant: 'destructive'
                                  });
                                }
                              }}
                              onCancel={() => {
                                setFormData({
                                  title: '',
                                  description: '',
                                  video_url: '',
                                  duration_minutes: '',
                                  grade_id: '',
                                  group_id: '',
                                  is_free: false
                                });
                                setSelectedCourse('');
                              }}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </TabsContent>

                  {/* Tab 2: Google Drive URL */}
                  <TabsContent value="url">
                    <form onSubmit={handleSubmit} className="space-y-4">
                      <div>
                        <Label>اختر الدورة *</Label>
                        <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                          <SelectTrigger>
                            <SelectValue placeholder="اختر الدورة" />
                          </SelectTrigger>
                          <SelectContent>
                            {courses.map(c => (
                              <SelectItem key={c.id} value={c.id}>
                                <div className="flex items-center gap-2">
                                  <BookOpen className="h-4 w-4 text-cyan-500" />
                                  {c.name}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label>الصف الدراسي *</Label>
                        <Select value={formData.grade_id} onValueChange={(value) => setFormData({ ...formData, grade_id: value, group_id: '' })}>
                          <SelectTrigger>
                            <SelectValue placeholder="اختر الصف الدراسي" />
                          </SelectTrigger>
                          <SelectContent>
                            {grades.map(grade => (
                              <SelectItem key={grade.id} value={grade.id}>
                                {grade.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label>المجموعة *</Label>
                        <Select
                          value={formData.group_id}
                          onValueChange={(value) => setFormData({ ...formData, group_id: value })}
                          disabled={!formData.grade_id}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={formData.grade_id ? "اختر المجموعة" : "اختر الصف أولاً"} />
                          </SelectTrigger>
                          <SelectContent>
                            {groups
                              .filter(group => group.grade_id === formData.grade_id)
                              .map(group => (
                                <SelectItem key={group.id} value={group.id}>
                                  {group.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <Label>عنوان المحاضرة *</Label>
                        <Input
                          value={formData.title}
                          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                          placeholder="مثال: الحرب العالمية الأولى"
                        />
                      </div>

                      <div>
                        <Label>وصف المحاضرة</Label>
                        <Textarea
                          value={formData.description}
                          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                          placeholder="وصف مختصر للمحاضرة..."
                          rows={3}
                        />
                      </div>

                      <div>
                        <Label>رابط الفيديو من Google Drive *</Label>
                        <Input
                          value={formData.video_url}
                          onChange={(e) => setFormData({ ...formData, video_url: e.target.value })}
                          placeholder="https://drive.google.com/file/d/..."
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                          الصق رابط الفيديو من Google Drive
                        </p>
                      </div>

                      <div>
                        <Label>مدة المحاضرة (بالدقائق)</Label>
                        <Input
                          type="number"
                          value={formData.duration_minutes}
                          onChange={(e) => setFormData({ ...formData, duration_minutes: e.target.value })}
                          placeholder="60"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="is_free"
                          checked={formData.is_free}
                          onChange={(e) => setFormData({ ...formData, is_free: e.target.checked })}
                          className="w-4 h-4"
                        />
                        <Label htmlFor="is_free" className="cursor-pointer">
                          محاضرة مجانية (متاحة لجميع الطلاب)
                        </Label>
                      </div>

                      <Button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
                      >
                        {loading ? 'جاري الرفع...' : (
                          <>
                            <Upload className="h-4 w-4 ml-2" />
                            رفع المحاضرة
                          </>
                        )}
                      </Button>
                    </form>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>

            {/* Lectures List */}
            <Card className="lg:col-span-4 shadow-lg border-t-4 border-t-cyan-500">
              <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
                <CardTitle className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Video className="h-5 w-5 text-cyan-600" />
                    المحاضرات المرفوعة
                  </span>
                  <Badge variant="secondary" className="text-lg px-3 py-1">
                    {lectures.length} محاضرة
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {lectures.length === 0 ? (
                  <div className="text-center py-16">
                    <Video className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                    <p className="text-lg font-semibold text-gray-600">لا توجد محاضرات</p>
                    <p className="text-sm text-muted-foreground mt-2">ابدأ برفع أول محاضرة</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {lectures.map((lecture) => {
                      const lectureGrade = grades.find(g => g.id === lecture.grade_id);
                      const lectureGroup = groups.find(g => g.id === lecture.group_id);

                      return (
                        <motion.div
                          key={lecture.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="group relative border rounded-xl hover:shadow-lg hover:border-cyan-400 transition-all duration-200 bg-white dark:bg-gray-800 overflow-hidden"
                        >
                          {/* Header with Course Badge */}
                          <div className="bg-gradient-to-r from-cyan-500 to-teal-600 p-3 text-white">
                            <div className="flex items-center justify-between mb-2">
                              <Badge className="bg-white/20 text-white border-white/30 text-xs">
                                <BookOpen className="h-3 w-3 ml-1" />
                                {lecture.course_name || 'دورة غير محددة'}
                              </Badge>
                              {lecture.is_free && (
                                <Badge className="bg-green-500 text-white text-xs">مجانية</Badge>
                              )}
                            </div>
                            <h4 className="font-bold text-base line-clamp-2">{lecture.title}</h4>
                          </div>

                          {/* Content */}
                          <div className="p-4 space-y-3">
                            {/* Grade and Group - Prominent Display */}
                            <div className="grid grid-cols-2 gap-2">
                              <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                                <p className="text-xs text-blue-600 dark:text-blue-400 font-medium mb-1">الصف</p>
                                <p className="font-bold text-blue-900 dark:text-blue-100">
                                  {lectureGrade?.name || 'غير محدد'}
                                </p>
                              </div>
                              <div className="bg-purple-50 dark:bg-purple-900/20 p-3 rounded-lg border border-purple-200 dark:border-purple-800">
                                <p className="text-xs text-purple-600 dark:text-purple-400 font-medium mb-1">المجموعة</p>
                                <p className="font-bold text-purple-900 dark:text-purple-100">
                                  {lectureGroup?.name || 'غير محددة'}
                                </p>
                              </div>
                            </div>

                            {/* Description */}
                            {lecture.description && (
                              <p className="text-sm text-muted-foreground line-clamp-3">
                                {lecture.description}
                              </p>
                            )}

                            {/* Duration */}
                            {lecture.duration_minutes && (
                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Clock className="h-4 w-4 text-cyan-600" />
                                <span>{lecture.duration_minutes} دقيقة</span>
                              </div>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="border-t p-3 bg-gray-50 dark:bg-gray-900/50 flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPlayingVideo({ url: lecture.video_url, title: lecture.title })}
                              className="flex-1 border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                            >
                              <Play className="h-4 w-4 ml-1" />
                              مشاهدة
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleDelete(lecture.id)}
                              className="opacity-70 group-hover:opacity-100 transition-opacity"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
