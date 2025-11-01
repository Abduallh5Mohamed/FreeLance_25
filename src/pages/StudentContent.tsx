import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FileText, Download, Eye, Search, Filter, File, Image, Video, PlayCircle, BookOpen, Play, X } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { useToast } from "@/hooks/use-toast";
import { getStudentMaterials, CourseMaterial, User } from "@/lib/api-http";
import { VideoPlayer } from "@/components/VideoPlayer";

interface Material extends CourseMaterial {
  thumbnail?: string;
}

const StudentContent = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedMaterial, setSelectedMaterial] = useState<Material | null>(null);
  const [loading, setLoading] = useState(false);

  // Check authentication
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || user.role !== 'student') {
      navigate('/auth');
      return;
    }

    loadMaterials();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMaterials = async () => {
    try {
      setLoading(true);

      // Get current user from localStorage
      const userStr = localStorage.getItem('currentUser');
      const user: User | null = userStr ? JSON.parse(userStr) : null;

      console.log('👤 Current user:', user);

      if (!user) {
        console.error('❌ No user found in localStorage');
        setMaterials([]);
        return;
      }

      // Use student_id if available, otherwise use user id
      const studentIdentifier = user.student_id || user.id;
      console.log('🔑 Student identifier:', studentIdentifier);

      // Get materials for this student's group only
      const data = await getStudentMaterials(studentIdentifier);
      console.log('📚 Materials received from API:', data);

      const contentData = data || [];
      setMaterials(contentData);
      console.log('✅ Materials set to state:', contentData.length, 'items');
    } catch (error) {
      console.error('❌ Error loading materials:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل المحتوى',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const getIcon = (type?: string) => {
    switch (type) {
      case 'pdf':
        return <FileText className="w-5 h-5 text-red-500" />;
      case 'image':
        return <Image className="w-5 h-5 text-blue-500" />;
      case 'video':
        return <Video className="w-5 h-5 text-green-500" />;
      case 'document':
        return <File className="w-5 h-5 text-purple-500" />;
      default:
        return <FileText className="w-5 h-5 text-gray-500" />;
    }
  };

  const getTypeLabel = (type?: string) => {
    switch (type) {
      case 'pdf':
        return 'PDF';
      case 'image':
        return 'صورة';
      case 'video':
        return 'فيديو';
      case 'document':
        return 'مستند';
      default:
        return 'ملف';
    }
  };

  const getThumbnailUrl = (fileUrl?: string) => {
    if (!fileUrl) return 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400';

    // If it's a direct image URL, use it as thumbnail
    if (fileUrl.includes('.jpg') || fileUrl.includes('.png') || fileUrl.includes('.gif') || fileUrl.includes('.webp')) {
      return fileUrl;
    }

    // If it's a Google Drive URL, generate preview thumbnail
    if (fileUrl.includes('drive.google.com')) {
      const fileId = fileUrl.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1];
      if (fileId) return `https://drive.google.com/thumbnail?id=${fileId}&sz=w200`;
    }

    // If it's a YouTube URL, generate YouTube thumbnail
    if (fileUrl.includes('youtube.com') || fileUrl.includes('youtu.be')) {
      const videoId = fileUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&]+)/)?.[1];
      if (videoId) return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }

    // Default fallback
    return 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400';
  };

  const filteredMaterials = materials.filter(material => {
    const matchesSearch = material.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      material.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (material.course_name?.toLowerCase().includes(searchQuery.toLowerCase()) || false);
    const matchesType = selectedType === 'all' || material.material_type === selectedType;
    return matchesSearch && matchesType;
  });

  const handleView = (material: Material) => {
    if (material.material_type === 'video') {
      setSelectedMaterial(material);
    } else {
      toast({
        title: "جاري فتح الملف",
        description: material.title
      });
    }
  };

  const handleDownload = (material: Material) => {
    toast({
      title: "جاري تحميل الملف",
      description: material.title
    });
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
                    { value: 'image', label: 'صور', icon: Image },
                    { value: 'document', label: 'مستندات', icon: File }
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
                  {material.thumbnail || material.file_url && (
                    <div className="relative h-48 bg-gradient-to-br from-primary/20 to-accent/20 overflow-hidden">
                      <img
                        src={material.thumbnail || getThumbnailUrl(material.file_url)}
                        alt={material.title}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400';
                        }}
                      />
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                        {material.material_type === 'video' ? (
                          <div className="flex flex-col items-center gap-3">
                            <PlayCircle className="w-16 h-16 text-white drop-shadow-lg" />
                            <span className="text-white font-medium">{material.duration_minutes || 0} دقيقة</span>
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
                  )}

                  {/* Content */}
                  <CardContent className="p-4 flex-1 flex flex-col">
                    <div className="flex-1">
                      <Badge variant="outline" className="mb-2 text-xs">
                        {material.course_name || 'مادة عامة'}
                      </Badge>
                      <h3 className="font-bold text-base mb-2 line-clamp-2">
                        {material.title}
                      </h3>
                      <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                        {material.description}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{new Date(material.created_at || new Date()).toLocaleDateString('ar-EG')}</span>
                        <span>•</span>
                        <span>{material.duration_minutes ? `${material.duration_minutes} دقيقة` : 'ملف'}</span>
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

        {/* Empty State */}
        {filteredMaterials.length === 0 && (
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
