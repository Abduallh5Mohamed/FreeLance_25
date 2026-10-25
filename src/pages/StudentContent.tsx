import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FileText, Download, Eye, Search, Filter, File, Link as LinkIcon, Presentation, Video, PlayCircle, BookOpen, Play, X, AlertCircle, RefreshCw } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { useToast } from "@/hooks/use-toast";
import { getStudentMaterials, CourseMaterial, User, AUTH_SESSION_CHANGED_EVENT } from "@/lib/api-http";
import { VideoPlayer } from "@/components/VideoPlayer";
import { useScreenRecordingPrevention } from "@/hooks/useScreenRecordingPrevention";

interface Material extends CourseMaterial {
  thumbnail?: string;
}

const StudentContent = () => {
  useScreenRecordingPrevention(); // Prevent screen recording & screenshots
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedMaterial, setSelectedMaterial] = useState<Material | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const requestRef = useRef(0);
  const sessionRef = useRef(0);

  const loadMaterials = useCallback(async () => {
    const requestId = ++requestRef.current;
    const session = sessionRef.current;
    const userStr = localStorage.getItem('currentUser');
    let user: User | null = null;
    try {
      user = userStr ? JSON.parse(userStr) as User : null;
    } catch {
      user = null;
    }

    if (!localStorage.getItem('authToken')) {
      setMaterials([]);
      setHasLoaded(false);
      setLoading(false);
      navigate('/auth', { replace: true });
      return;
    }

    if (!user || user.role !== 'student') {
      setMaterials([]);
      setHasLoaded(false);
      setLoading(false);
      setLoadError(true);
      return;
    }

    setLoading(true);
    setLoadError(false);
    try {
      const data = await getStudentMaterials(user.id);
      if (requestId !== requestRef.current || session !== sessionRef.current) return;
      setMaterials(data || []);
      setHasLoaded(true);
    } catch (error) {
      if (requestId !== requestRef.current || session !== sessionRef.current) return;
      console.error('Error loading materials:', error);
      setLoadError(true);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل المحتوى',
        variant: 'destructive'
      });
    } finally {
      if (requestId === requestRef.current && session === sessionRef.current) {
        setLoading(false);
      }
    }
  }, [navigate, toast]);

  useEffect(() => {
    void loadMaterials();

    const refresh = () => {
      sessionRef.current += 1;
      requestRef.current += 1;
      setSelectedMaterial(null);
      setMaterials([]);
      setHasLoaded(false);
      setLoadError(false);
      setLoading(false);
      void loadMaterials();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'authToken' || event.key === 'currentUser' || event.key === null) refresh();
    };

    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      requestRef.current += 1;
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [loadMaterials]);

  useEffect(() => {
    setSelectedMaterial(null);
  }, [searchQuery, selectedType]);

  const getIcon = (type?: string) => {
    switch (type) {
      case 'pdf':
        return <FileText className="w-5 h-5 text-red-500" />;
      case 'video':
        return <Video className="w-5 h-5 text-green-500" />;
      case 'presentation':
        return <Presentation className="w-5 h-5 text-cyan-500" />;
      case 'link':
        return <LinkIcon className="w-5 h-5 text-blue-500" />;
      case 'other':
        return <File className="w-5 h-5 text-purple-500" />;
      default:
        return <FileText className="w-5 h-5 text-gray-500" />;
    }
  };

  const getTypeLabel = (type?: string) => {
    switch (type) {
      case 'pdf':
        return 'PDF';
      case 'video':
        return 'فيديو';
      case 'presentation':
        return 'عرض تقديمي';
      case 'link':
        return 'رابط';
      case 'other':
        return 'ملف آخر';
      default:
        return 'ملف';
    }
  };

  const getThumbnailUrl = (fileUrl?: string): string | null => {
    if (!fileUrl) return null;

    if (fileUrl.includes('.jpg') || fileUrl.includes('.png') || fileUrl.includes('.gif') || fileUrl.includes('.webp')) {
      return fileUrl;
    }

    if (fileUrl.includes('drive.google.com')) {
      const fileId = fileUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
      if (fileId) return `https://drive.google.com/thumbnail?id=${fileId}&sz=w200`;
    }

    if (fileUrl.includes('youtube.com') || fileUrl.includes('youtu.be')) {
      const videoId = fileUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&]+)/)?.[1];
      if (videoId) return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }

    return null;
  };

  const filteredMaterials = materials.filter(material => {
    const matchesSearch = material.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      material.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (material.course_name?.toLowerCase().includes(searchQuery.toLowerCase()) || false);
    const matchesType = selectedType === 'all' || material.material_type === selectedType;
    return matchesSearch && matchesType;
  });

  const hasCurrentSession = () => {
    if (localStorage.getItem('authToken')) return true;
    toast({
      title: "انتهت الجلسة",
      description: "يرجى تسجيل الدخول مرة أخرى",
      variant: "destructive"
    });
    navigate('/auth', { replace: true });
    return false;
  };

  const handleView = (material: Material) => {
    if (!hasCurrentSession()) return;
    if (material.material_type === 'video') {
      // Only the canonical platform reference (`video://<id>`) is playable
      // through the secure player. A raw/private/external URL is never opened
      // as a playback fallback.
      if (!material.file_url?.startsWith('video://')) {
        toast({
          title: "غير متاح",
          description: "هذا الفيديو غير متاح للمشاهدة الآمنة",
          variant: "destructive"
        });
        return;
      }
      setSelectedMaterial(material);
    } else if (material.file_url) {
      // Open PDF or other files in new tab
      window.open(material.file_url, '_blank', 'noopener,noreferrer');
      toast({
        title: "جاري فتح الملف",
        description: material.title
      });
    } else {
      toast({
        title: "خطأ",
        description: "رابط الملف غير متوفر",
        variant: "destructive"
      });
    }
  };

  const handleDownload = (material: Material) => {
    if (!hasCurrentSession()) return;
    if (material.material_type === 'video' || material.file_url?.startsWith('video://')) {
      toast({
        title: "غير متاح",
        description: "التحميل المباشر للفيديوهات غير متاح",
        variant: "destructive"
      });
      return;
    }
    if (material.file_url) {
      // For Google Drive files, convert to download link
      let downloadUrl = material.file_url;
      if (material.file_url.includes('drive.google.com')) {
        const fileId = material.file_url.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
          material.file_url.match(/id=([a-zA-Z0-9-_]+)/)?.[1];
        if (fileId) {
          downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        }
      }
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      toast({
        title: "جاري تحميل الملف",
        description: material.title
      });
    } else {
      toast({
        title: "خطأ",
        description: "رابط التحميل غير متوفر",
        variant: "destructive"
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <StudentHeader />

      <div className="container mx-auto px-4 py-6 relative z-10 max-w-7xl">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <div className="flex items-center gap-3 mb-2">
            <BookOpen className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              المحتوى التعليمي
            </h1>
          </div>
          <p className="text-muted-foreground">
            المواد الدراسية والملفات المتاحة - PDF وصور ومستندات تعليمية
          </p>
        </motion.div>

        {/* Search and Filters */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <GlassmorphicCard className="mb-6">
            <CardContent className="pt-6">
              <div className="flex flex-col md:flex-row gap-4">
                {/* Search */}
                <div className="flex-1 relative">
                  <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="ابحث عن ملف أو مادة..."
                    className="pr-10"
                  />
                </div>

                {/* Type Filter */}
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: 'all', label: 'الكل', icon: Filter },
                    { value: 'pdf', label: 'PDF', icon: FileText },
                    { value: 'video', label: 'فيديو', icon: Video },
                    { value: 'presentation', label: 'عرض تقديمي', icon: Presentation },
                    { value: 'link', label: 'رابط', icon: LinkIcon },
                    { value: 'other', label: 'ملف آخر', icon: File }
                  ].map((filter) => {
                    const Icon = filter.icon;
                    return (
                      <Button
                        key={filter.value}
                        variant={selectedType === filter.value ? 'default' : 'outline'}
                        onClick={() => setSelectedType(filter.value)}
                        className="gap-2"
                        size="sm"
                      >
                        <Icon className="w-4 h-4" />
                        {filter.label}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </GlassmorphicCard>
        </motion.div>

        {/* Materials Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AnimatePresence>
            {filteredMaterials.map((material, idx) => (
              <motion.div
                key={material.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: idx * 0.05 }}
                whileHover={{ y: -5 }}
              >
                <Card className="overflow-hidden hover:shadow-2xl transition-all duration-300 h-full flex flex-col group">
                  {/* Thumbnail */}
                  <div className="relative h-48 bg-gradient-to-br from-primary/20 to-accent/20 overflow-hidden">
                    {(() => {
                      const thumbnailUrl = material.thumbnail || getThumbnailUrl(material.file_url);
                      if (!thumbnailUrl) {
                        return (
                          <div className="w-full h-full flex items-center justify-center [&>svg]:w-12 [&>svg]:h-12">
                            {getIcon(material.material_type)}
                          </div>
                        );
                      }
                      return (
                        <img
                          src={thumbnailUrl}
                          alt={material.title}
                          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none';
                          }}
                        />
                      );
                    })()}
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                      {material.material_type === 'video' ? (
                        <div className="flex flex-col items-center gap-3">
                          <PlayCircle className="w-16 h-16 text-white drop-shadow-lg" />
                          <span className="text-white font-medium">
                            {material.duration_minutes ? `${material.duration_minutes} دقيقة` : 'مدة غير متاحة'}
                          </span>
                        </div>
                      ) : (
                        <Eye className="w-12 h-12 text-white" />
                      )}
                    </div>
                    <div className="absolute top-2 right-2">
                      <Badge className="gap-1 shadow-lg">
                        {getIcon(material.material_type)}
                        {getTypeLabel(material.material_type)}
                      </Badge>
                    </div>
                  </div>

                  {/* Content */}
                  <CardContent className="p-4 flex-1 flex flex-col">
                    <div className="flex-1">
                      <Badge variant="outline" className="mb-2 text-xs">
                        {material.course_name || 'دورة غير محددة'}
                      </Badge>
                      <h3 className="font-bold text-base mb-2 line-clamp-2">
                        {material.title}
                      </h3>
                      <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                        {material.description}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>
                          {material.created_at
                            ? new Date(material.created_at).toLocaleDateString('ar-EG')
                            : 'تاريخ غير متاح'}
                        </span>
                        <span>•</span>
                        <span>
                          {material.duration_minutes
                            ? `${material.duration_minutes} دقيقة`
                            : material.material_type === 'video'
                              ? 'مدة غير متاحة'
                              : 'ملف'}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 mt-4">
                      <Button
                        onClick={() => handleView(material)}
                        className="flex-1 bg-gradient-to-r from-primary to-accent hover:shadow-lg"
                        size="sm"
                      >
                        <Eye className="w-4 h-4 ml-2" />
                        عرض
                      </Button>
                      <Button
                        onClick={() => handleDownload(material)}
                        variant="outline"
                        size="sm"
                      >
                        <Download className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {loading && materials.length === 0 && !loadError && (
          <div className="text-center py-16 text-muted-foreground" aria-live="polite">
            جارٍ تحميل المحتوى...
          </div>
        )}

        {/* Fetch Failure */}
        {loadError && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <GlassmorphicCard className="max-w-md mx-auto">
              <CardContent className="pt-8 pb-8">
                <AlertCircle className="w-16 h-16 mx-auto mb-4 text-destructive" />
                <h3 className="text-lg font-semibold mb-2">تعذّر تحميل المحتوى</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  لم نتمكن من التحقق من موادك الآن. لا توجد قائمة فارغة مؤكدة.
                </p>
                <Button onClick={() => void loadMaterials()} disabled={loading} className="gap-2">
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  إعادة المحاولة
                </Button>
              </CardContent>
            </GlassmorphicCard>
          </motion.div>
        )}

        {/* Empty State */}
        {!loading && !loadError && hasLoaded && filteredMaterials.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-20"
          >
            <GlassmorphicCard className="max-w-md mx-auto">
              <CardContent className="pt-8 pb-8">
                <FileText className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="text-lg font-semibold mb-2">لا توجد ملفات</h3>
                <p className="text-sm text-muted-foreground">
                  لم يتم العثور على أي ملفات تطابق بحثك
                </p>
              </CardContent>
            </GlassmorphicCard>
          </motion.div>
        )}

        {/* Video Player Modal */}
        <AnimatePresence>
          {selectedMaterial && selectedMaterial.material_type === 'video' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
              onClick={() => setSelectedMaterial(null)}
            >
              <motion.div
                initial={{ scale: 0.9 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.9 }}
                className="bg-black rounded-lg shadow-2xl max-w-4xl w-full"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-white/10">
                  <h2 className="text-xl font-bold text-white">{selectedMaterial.title}</h2>
                  <button
                    onClick={() => setSelectedMaterial(null)}
                    className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                  >
                    <X className="w-6 h-6 text-white" />
                  </button>
                </div>

                {/* Video Player */}
                <div className="w-full bg-black">
                  {selectedMaterial.file_url ? (
                    <VideoPlayer
                      url={selectedMaterial.file_url}
                      title={selectedMaterial.title}
                      onClose={() => setSelectedMaterial(null)}
                    />
                  ) : (
                    <div className="aspect-video flex items-center justify-center bg-black/50">
                      <div className="text-center">
                        <Play className="w-16 h-16 mx-auto mb-4 text-white/50" />
                        <p className="text-white/70">لم يتم تحديد فيديو</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Info */}
                {selectedMaterial.description && (
                  <div className="p-4 border-t border-white/10 bg-white/5">
                    <p className="text-sm text-white/70">{selectedMaterial.description}</p>
                  </div>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};

export default StudentContent;
