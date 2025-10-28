import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Search, Play, PlayCircle, Clock, Users, BookOpen, ChevronRight, Star, Award, CheckCircle2, X } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { useToast } from "@/hooks/use-toast";

interface Lecture {
  id: string;
  title: string;
  description: string;
  instructor: string;
  course: string;
  duration: string;
  students: number;
  rating: number;
  reviews: number;
  thumbnail: string;
  videoUrl: string;
  youtubeId: string;
  completed: boolean;
  progress: number;
  lessons: number;
  level: 'beginner' | 'intermediate' | 'advanced';
}

const StudentLectures = () => {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLecture, setSelectedLecture] = useState<Lecture | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>('all');

  // Sample lectures data (Coursera style)
  const [lectures] = useState<Lecture[]>([
    {
      id: '1',
      title: 'مقدمة في التاريخ الإسلامي',
      description: 'نظرة شاملة على بداية الدولة الإسلامية وأهم الأحداث التي شكلت التاريخ الإسلامي',
      instructor: 'د. أحمد الزهراني',
      course: 'التاريخ الإسلامي 101',
      duration: '45 دقيقة',
      students: 2543,
      rating: 4.8,
      reviews: 342,
      thumbnail: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=500',
      videoUrl: 'https://www.youtube.com/embed/jNQXAC9IVRw',
      youtubeId: 'jNQXAC9IVRw',
      completed: true,
      progress: 100,
      lessons: 5,
      level: 'beginner'
    },
    {
      id: '2',
      title: 'العصر الأموي - الفتوحات والإنجازات',
      description: 'دراسة معمقة للدولة الأموية وأهم إنجازاتها الحضارية والعسكرية والإدارية',
      instructor: 'أ.د محمود خليل',
      course: 'التاريخ الإسلامي 102',
      duration: '52 دقيقة',
      students: 1876,
      rating: 4.7,
      reviews: 215,
      thumbnail: 'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=500',
      videoUrl: 'https://www.youtube.com/embed/jNQXAC9IVRw',
      youtubeId: 'jNQXAC9IVRw',
      completed: false,
      progress: 45,
      lessons: 6,
      level: 'intermediate'
    },
    {
      id: '3',
      title: 'العصر العباسي - العصر الذهبي',
      description: 'الازدهار الثقافي والعلمي في العصر العباسي ودوره في الحضارة الإسلامية العامة',
      instructor: 'د. فاطمة العتيبي',
      course: 'التاريخ الإسلامي 103',
      duration: '48 دقيقة',
      students: 1654,
      rating: 4.9,
      reviews: 298,
      thumbnail: 'https://images.unsplash.com/photo-1488515503393-29d440291138?w=500',
      videoUrl: 'https://www.youtube.com/embed/jNQXAC9IVRw',
      youtubeId: 'jNQXAC9IVRw',
      completed: false,
      progress: 0,
      lessons: 7,
      level: 'advanced'
    },
    {
      id: '4',
      title: 'الجغرافيا الطبيعية - التضاريس والمناخ',
      description: 'فهم شامل لأنواع التضاريس وتأثيرها على المناخ والسكان والاقتصاد',
      instructor: 'د. سليمان النجار',
      course: 'الجغرافيا 101',
      duration: '38 دقيقة',
      students: 3221,
      rating: 4.6,
      reviews: 421,
      thumbnail: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=500',
      videoUrl: 'https://www.youtube.com/embed/jNQXAC9IVRw',
      youtubeId: 'jNQXAC9IVRw',
      completed: true,
      progress: 100,
      lessons: 4,
      level: 'beginner'
    },
    {
      id: '5',
      title: 'الجغرافيا البشرية - التوزيع السكاني',
      description: 'دراسة أنماط التوزيع السكاني وأسبابها والعوامل المؤثرة على الهجرة والعمران',
      instructor: 'د. ليلى العبدالله',
      course: 'الجغرافيا 102',
      duration: '41 دقيقة',
      students: 1432,
      rating: 4.7,
      reviews: 187,
      thumbnail: 'https://images.unsplash.com/photo-1526628953301-3e589a6a8b74?w=500',
      videoUrl: 'https://www.youtube.com/embed/jNQXAC9IVRw',
      youtubeId: 'jNQXAC9IVRw',
      completed: false,
      progress: 30,
      lessons: 5,
      level: 'intermediate'
    },
    {
      id: '6',
      title: 'الحرب العالمية الأولى - الأسباب والنتائج',
      description: 'تحليل شامل لأسباب الحرب العالمية الأولى ونتائجها على العالم الحديث',
      instructor: 'أ.د علي الدوسري',
      course: 'التاريخ الحديث 101',
      duration: '55 دقيقة',
      students: 2187,
      rating: 4.8,
      reviews: 356,
      thumbnail: 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=500',
      videoUrl: 'https://www.youtube.com/embed/jNQXAC9IVRw',
      youtubeId: 'jNQXAC9IVRw',
      completed: false,
      progress: 60,
      lessons: 6,
      level: 'intermediate'
    }
  ]);

  const getLevelLabel = (level: string) => {
    switch (level) {
      case 'beginner':
        return 'مبتدئ';
      case 'intermediate':
        return 'متوسط';
      case 'advanced':
        return 'متقدم';
      default:
        return 'مستوى';
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'beginner':
        return 'bg-green-500/10 text-green-700';
      case 'intermediate':
        return 'bg-blue-500/10 text-blue-700';
      case 'advanced':
        return 'bg-red-500/10 text-red-700';
      default:
        return 'bg-gray-500/10 text-gray-700';
    }
  };

  const filteredLectures = lectures.filter(lecture => {
    const matchesSearch = 
      lecture.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lecture.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lecture.instructor.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lecture.course.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesLevel = filterLevel === 'all' || lecture.level === filterLevel;
    
    return matchesSearch && matchesLevel;
  });

  const handlePlayLecture = (lecture: Lecture) => {
    setSelectedLecture(lecture);
    toast({
      title: "جاري تشغيل المحاضرة",
      description: lecture.title
    });
  };

  const renderStars = (rating: number) => {
    return (
      <div className="flex items-center gap-1">
        {[...Array(5)].map((_, i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${i < Math.floor(rating) ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'}`}
          />
        ))}
        <span className="text-sm font-medium ml-1">({rating})</span>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <StudentHeader />

      {/* Video Player Modal */}
      <AnimatePresence>
        {selectedLecture && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
            onClick={() => setSelectedLecture(null)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-5xl"
            >
              <div className="relative">
                <button
                  onClick={() => setSelectedLecture(null)}
                  className="absolute -top-12 left-0 text-white hover:text-gray-300 transition-colors"
                >
                  <X className="w-8 h-8" />
                </button>

                <div className="aspect-video bg-black rounded-lg overflow-hidden">
                  <iframe
                    width="100%"
                    height="100%"
                    src={`${selectedLecture.videoUrl}?autoplay=1`}
                    title={selectedLecture.title}
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="w-full h-full"
                  />
                </div>
              </div>

              <Card className="mt-4">
                <CardContent className="pt-6">
                  <h2 className="text-xl font-bold mb-2">{selectedLecture.title}</h2>
                  <p className="text-muted-foreground mb-4">{selectedLecture.description}</p>
                  
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div>
                      <p className="text-sm text-muted-foreground">المدرس</p>
                      <p className="font-medium">{selectedLecture.instructor}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">المدة</p>
                      <p className="font-medium">{selectedLecture.duration}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">الطلاب</p>
                      <p className="font-medium">{selectedLecture.students.toLocaleString('ar-EG')}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">التقييم</p>
                      {renderStars(selectedLecture.rating)}
                    </div>
                  </div>

                  <Button
                    onClick={() => setSelectedLecture(null)}
                    className="w-full bg-gradient-to-r from-primary to-accent"
                  >
                    إغلاق
                  </Button>
                </CardContent>
              </Card>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="container mx-auto px-4 py-6 relative z-10 max-w-7xl">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <BookOpen className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              المحاضرات الدراسية
            </h1>
          </div>
          <p className="text-muted-foreground">
            محاضرات احترافية من أفضل المدرسين - نمط Coursera و Udemy
          </p>
        </motion.div>

        {/* Search and Filters */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <GlassmorphicCard>
            <CardContent className="pt-6">
              <div className="space-y-4">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="ابحث عن محاضرة أو مدرس أو مادة..."
                    className="pr-10"
                  />
                </div>

                {/* Level Filter */}
                <div className="flex gap-2 flex-wrap">
                  <span className="text-sm font-medium flex items-center">المستوى:</span>
                  {[
                    { value: 'all', label: 'الكل' },
                    { value: 'beginner', label: 'مبتدئ' },
                    { value: 'intermediate', label: 'متوسط' },
                    { value: 'advanced', label: 'متقدم' }
                  ].map((filter) => (
                    <Button
                      key={filter.value}
                      variant={filterLevel === filter.value ? 'default' : 'outline'}
                      onClick={() => setFilterLevel(filter.value)}
                      size="sm"
                    >
                      {filter.label}
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </GlassmorphicCard>
        </motion.div>

        {/* Lectures Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AnimatePresence>
            {filteredLectures.map((lecture, idx) => (
              <motion.div
                key={lecture.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: idx * 0.05 }}
                whileHover={{ y: -8 }}
              >
                <Card className="overflow-hidden hover:shadow-2xl transition-all duration-300 h-full flex flex-col group bg-gradient-to-br from-card to-card/50">
                  {/* Thumbnail */}
                  <div className="relative h-48 bg-gradient-to-br from-primary/20 to-accent/20 overflow-hidden">
                    <img
                      src={lecture.thumbnail}
                      alt={lecture.title}
                      className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                    />
                    
                    {/* Overlay */}
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                      <PlayCircle className="w-16 h-16 text-white drop-shadow-lg" />
                    </div>

                    {/* Badges */}
                    <div className="absolute top-2 right-2 flex gap-2">
                      <Badge className={getLevelColor(lecture.level)}>
                        {getLevelLabel(lecture.level)}
                      </Badge>
                      {lecture.completed && (
                        <Badge className="bg-green-500/20 text-green-700">
                          <CheckCircle2 className="w-3 h-3 ml-1" />
                          مكتمل
                        </Badge>
                      )}
                    </div>

                    {/* Duration */}
                    <div className="absolute bottom-2 right-2 bg-black/80 text-white px-2 py-1 rounded text-sm flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {lecture.duration}
                    </div>

                    {/* Progress Bar */}
                    {lecture.progress > 0 && (
                      <div className="absolute bottom-0 left-0 right-0">
                        <Progress value={lecture.progress} className="h-1 rounded-none" />
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <CardContent className="p-4 flex-1 flex flex-col">
                    <div className="flex-1">
                      <Badge variant="outline" className="mb-2 text-xs">
                        {lecture.course}
                      </Badge>
                      <h3 className="font-bold text-sm mb-2 line-clamp-2 group-hover:text-primary transition-colors">
                        {lecture.title}
                      </h3>
                      <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                        {lecture.description}
                      </p>

                      {/* Instructor */}
                      <div className="mb-3 pb-3 border-b">
                        <p className="text-xs font-medium text-muted-foreground">المدرس</p>
                        <p className="text-sm">{lecture.instructor}</p>
                      </div>

                      {/* Stats */}
                      <div className="space-y-2 text-xs text-muted-foreground mb-3">
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            {lecture.students.toLocaleString('ar-EG')} طالب
                          </span>
                          <span className="flex items-center gap-1">
                            <Award className="w-3 h-3" />
                            {lecture.lessons} درس
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          {renderStars(lecture.rating)}
                          <span>({lecture.reviews} تقييم)</span>
                        </div>
                      </div>

                      {/* Progress */}
                      {lecture.progress > 0 && (
                        <div className="mb-3">
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span>التقدم</span>
                            <span>{lecture.progress}%</span>
                          </div>
                          <Progress value={lecture.progress} className="h-1.5" />
                        </div>
                      )}
                    </div>

                    {/* Action Button */}
                    <Button
                      onClick={() => handlePlayLecture(lecture)}
                      className="w-full bg-gradient-to-r from-primary to-accent hover:shadow-lg"
                      size="sm"
                    >
                      <Play className="w-4 h-4 ml-2" />
                      {lecture.completed ? 'إعادة المشاهدة' : 'بدء المحاضرة'}
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Empty State */}
        {filteredLectures.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-20"
          >
            <GlassmorphicCard className="max-w-md mx-auto">
              <CardContent className="pt-8 pb-8">
                <BookOpen className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="text-lg font-semibold mb-2">لا توجد محاضرات</h3>
                <p className="text-sm text-muted-foreground">
                  لم يتم العثور على أي محاضرات تطابق بحثك
                </p>
              </CardContent>
            </GlassmorphicCard>
          </motion.div>
        )}

        {/* Stats Footer */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          <GlassmorphicCard>
            <CardContent className="pt-6 text-center">
              <Award className="w-8 h-8 mx-auto mb-2 text-primary" />
              <p className="text-2xl font-bold">{lectures.filter(l => l.completed).length}</p>
              <p className="text-sm text-muted-foreground">محاضرات مكتملة</p>
            </CardContent>
          </GlassmorphicCard>

          <GlassmorphicCard>
            <CardContent className="pt-6 text-center">
              <BookOpen className="w-8 h-8 mx-auto mb-2 text-accent" />
              <p className="text-2xl font-bold">{lectures.length}</p>
              <p className="text-sm text-muted-foreground">إجمالي المحاضرات</p>
            </CardContent>
          </GlassmorphicCard>

          <GlassmorphicCard>
            <CardContent className="pt-6 text-center">
              <Play className="w-8 h-8 mx-auto mb-2 text-green-500" />
              <p className="text-2xl font-bold">
                {Math.round(lectures.reduce((acc, l) => acc + l.progress, 0) / lectures.length)}%
              </p>
              <p className="text-sm text-muted-foreground">متوسط التقدم</p>
            </CardContent>
          </GlassmorphicCard>
        </motion.div>
      </div>
    </div>
  );
};

export default StudentLectures;
