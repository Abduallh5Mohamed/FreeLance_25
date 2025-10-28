import { useState } from "react";
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

interface Material {
  id: string;
  title: string;
  description: string;
  type: 'pdf' | 'image' | 'video' | 'document';
  course: string;
  uploadDate: string;
  size: string;
  url: string;
  thumbnail?: string;
  youtubeId?: string;
}

const StudentContent = () => {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');

  // Sample educational content with YouTube videos
  const [materials] = useState<Material[]>([
    {
      id: '1',
      title: 'ملخص الحرب العالمية الأولى',
      description: 'ملخص شامل لأسباب ونتائج الحرب العالمية الأولى مع الخرائط والصور',
      type: 'pdf',
      course: 'التاريخ الحديث',
      uploadDate: '2025-10-20',
      size: '2.5 MB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=400'
    },
    {
      id: '2',
      title: 'خريطة التضاريس الطبيعية',
      description: 'خرائط توضيحية لأنواع التضاريس المختلفة وتأثيرها على الحياة',
      type: 'image',
      course: 'الجغرافيا الطبيعية',
      uploadDate: '2025-10-18',
      size: '1.2 MB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400'
    },
    {
      id: '3',
      title: 'مذكرة الجغرافيا البشرية',
      description: 'مذكرة كاملة للفصل الدراسي الأول مع أمثلة عملية وخرائط',
      type: 'pdf',
      course: 'الجغرافيا البشرية',
      uploadDate: '2025-10-15',
      size: '3.8 MB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1526628953301-3e589a6a8b74?w=400'
    },
    {
      id: '4',
      title: 'جدول أهم الأحداث التاريخية',
      description: 'جدول زمني يوضح أهم الأحداث من القرن 19 إلى القرن 21',
      type: 'image',
      course: 'التاريخ الحديث',
      uploadDate: '2025-10-22',
      size: '856 KB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400'
    },
    {
      id: '5',
      title: 'ملخص الثورة الفرنسية',
      description: 'ملف وورد يحتوي على تفاصيل الثورة الفرنسية والأحداث الرئيسية',
      type: 'document',
      course: 'التاريخ الحديث',
      uploadDate: '2025-10-10',
      size: '1.5 MB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1488515503393-29d440291138?w=400'
    },
    {
      id: '6',
      title: 'أطلس الجغرافيا العالمية',
      description: 'مجموعة خرائط شاملة للعالم مع التقسيمات الجغرافية والسياسية',
      type: 'image',
      course: 'الجغرافيا',
      uploadDate: '2025-10-25',
      size: '2.1 MB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1526778548025-fa2f459cd5c1?w=400'
    },
    {
      id: '7',
      title: 'كتاب: الدولة الإسلامية',
      description: 'كتاب شامل عن تاريخ الدولة الإسلامية والعصور الإسلامية',
      type: 'pdf',
      course: 'التاريخ الإسلامي',
      uploadDate: '2025-10-12',
      size: '4.2 MB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1506880018603-83d5b814b5a6?w=400'
    },
    {
      id: '8',
      title: 'صور توضيحية للعصور التاريخية',
      description: 'مجموعة صور نادرة وتوضيحية للعصور التاريخية المختلفة',
      type: 'image',
      course: 'التاريخ',
      uploadDate: '2025-10-08',
      size: '3.5 MB',
      url: '#',
      thumbnail: 'https://images.unsplash.com/photo-1506755855726-89015b63dc70?w=400'
    }
  ]);

  const getIcon = (type: string) => {
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

  const getTypeLabel = (type: string) => {
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

  const filteredMaterials = materials.filter(material => {
    const matchesSearch = material.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         material.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         material.course.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = selectedType === 'all' || material.type === selectedType;
    return matchesSearch && matchesType;
  });

  const handleView = (material: Material) => {
    toast({
      title: "جاري فتح الملف",
      description: material.title
    });
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
                  {material.thumbnail && (
                    <div className="relative h-48 bg-gradient-to-br from-primary/20 to-accent/20 overflow-hidden">
                      <img
                        src={material.thumbnail}
                        alt={material.title}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                      />
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                        {material.type === 'video' ? (
                          <div className="flex flex-col items-center gap-3">
                            <PlayCircle className="w-16 h-16 text-white drop-shadow-lg" />
                            <span className="text-white font-medium">{material.size}</span>
                          </div>
                        ) : (
                          <Eye className="w-12 h-12 text-white" />
                        )}
                      </div>
                      <div className="absolute top-2 right-2">
                        <Badge className="gap-1 shadow-lg">
                          {getIcon(material.type)}
                          {getTypeLabel(material.type)}
                        </Badge>
                      </div>
                    </div>
                  )}

                  {/* Content */}
                  <CardContent className="p-4 flex-1 flex flex-col">
                    <div className="flex-1">
                      <Badge variant="outline" className="mb-2 text-xs">
                        {material.course}
                      </Badge>
                      <h3 className="font-bold text-base mb-2 line-clamp-2">
                        {material.title}
                      </h3>
                      <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                        {material.description}
                      </p>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{new Date(material.uploadDate).toLocaleDateString('ar-EG')}</span>
                        <span>•</span>
                        <span>{material.size}</span>
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
      </div>
    </div>
  );
};

export default StudentContent;
