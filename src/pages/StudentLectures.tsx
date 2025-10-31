import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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
import { getLectures, Lecture as APILecture, User } from "@/lib/api";
import { VideoPlayer } from "@/components/VideoPlayer";

interface Lecture extends APILecture {
  completed?: boolean;
  progress?: number;
  lessons?: number;
  level?: 'beginner' | 'intermediate' | 'advanced';
  students?: number;
  rating?: number;
  reviews?: number;
  instructor?: string;
}

const StudentLectures = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLecture, setSelectedLecture] = useState<Lecture | null>(null);
  const [playingVideo, setPlayingVideo] = useState<{ url: string; title: string } | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [loading, setLoading] = useState(true);

  // Check authentication
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || user.role !== 'student') {
      navigate('/auth');
      return;
    }

    loadLectures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadLectures = async () => {
    try {
      setLoading(true);
      const data = await getLectures();
      const lecturesData = data?.map(m => ({
        ...m,
        completed: false,
        progress: 0,
        lessons: 1,
        level: 'intermediate' as const,
        students: Math.floor(Math.random() * 3000) + 100,
        rating: Math.floor(Math.random() * 2) + 4,
        reviews: Math.floor(Math.random() * 500) + 50,
        instructor: 'المدرس'
      })) || [];
      setLectures(lecturesData);
    } catch (error) {
      console.error('Error loading lectures:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل المحاضرات',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const getLevelLabel = (level?: string) => {
    switch (level) {
      case 'beginner':
        return 'مبتدئ';
      case 'intermediate':
        return 'متوسط';
      case 'advanced':
        return 'متقدم';
      default:
        return 'متوسط';
    }
  };

  const getLevelColor = (level?: string) => {
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
      lecture.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lecture.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (lecture.instructor?.toLowerCase().includes(searchQuery.toLowerCase()) || false) ||
      (lecture.course_name?.toLowerCase().includes(searchQuery.toLowerCase()) || false);

    const matchesLevel = filterLevel === 'all' || lecture.level === filterLevel;

    return matchesSearch && matchesLevel;
  });

  const handlePlayLecture = (lecture: Lecture) => {
    console.log('Playing lecture:', {
      title: lecture.title,
      video_url: lecture.video_url,
    });
    setPlayingVideo({
      url: lecture.video_url,
      title: lecture.title
    });
    toast({
      title: "جاري تشغيل المحاضرة",
      description: lecture.title
    });
  };

  const renderStars = (rating?: number) => {
    const rate = rating || 4.5;
    return (
      <div className="flex items-center gap-1">
        {[...Array(5)].map((_, i) => (
          <Star
            key={i}
            className={`w-4 h-4 ${i < Math.floor(rate) ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'}`}
          />
        ))}
        <span className="text-sm font-medium ml-1">({rate.toFixed(1)})</span>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <StudentHeader />

      {/* Video Player Modal */}
      {playingVideo && (
        <VideoPlayer
          url={playingVideo.url}
          title={playingVideo.title}
          onClose={() => setPlayingVideo(null)}
        />
      )}

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
                      src={lecture.video_url.includes('drive.google.com')
                        ? `https://drive.google.com/thumbnail?id=${lecture.video_url.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1]}&sz=w500`
                        : 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=500'}
                      alt={lecture.title}
                      className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=500';
                      }}
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
                      {lecture.duration_minutes || 0} دقيقة
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
                        {lecture.course_name || 'دورة عامة'}
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
                        <p className="text-sm">{lecture.instructor || 'المدرس'}</p>
                      </div>

                      {/* Stats */}
                      <div className="space-y-2 text-xs text-muted-foreground mb-3">
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            {(lecture.students || 0).toLocaleString('ar-EG')} طالب
                          </span>
                          <span className="flex items-center gap-1">
                            <Award className="w-3 h-3" />
                            {lecture.lessons || 1} درس
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          {renderStars(lecture.rating)}
                          <span>({lecture.reviews || 0} تقييم)</span>
                        </div>
                      </div>

                      {/* Progress */}
                      {(lecture.progress || 0) > 0 && (
                        <div className="mb-3">
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span>التقدم</span>
                            <span>{lecture.progress}%</span>
                          </div>
                          <Progress value={lecture.progress || 0} className="h-1.5" />
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
                      {(lecture.completed) ? 'إعادة المشاهدة' : 'بدء المحاضرة'}
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
                {lectures.length > 0 ? Math.round(lectures.reduce((acc, l) => acc + (l.progress || 0), 0) / lectures.length) : 0}%
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
