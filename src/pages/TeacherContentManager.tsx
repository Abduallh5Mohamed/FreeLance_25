import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Upload,
  Video,
  FileText,
  Image,
  File,
  Plus,
  Trash2,
  Edit,
  Eye,
  Download,
  BookOpen,
  Sparkles,
  Calendar,
  Clock
} from "lucide-react";
import Header from "@/components/Header";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { FloatingParticles } from "@/components/FloatingParticles";

interface ContentItem {
  id: string;
  title: string;
  description: string;
  type: 'lecture' | 'material' | 'exam';
  subType?: 'pdf' | 'image' | 'video' | 'document';
  course: string;
  uploadDate: string;
  youtubeUrl?: string;
  duration?: string;
  instructor?: string;
  thumbnail?: string;
  fileUrl?: string;
  questionsCount?: number;
  totalMarks?: number;
}

const TeacherContentManager = () => {
  const { toast } = useToast();
  const [selectedTab, setSelectedTab] = useState<'lectures' | 'materials' | 'exams'>('lectures');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    course: '',
    type: '',
    youtubeUrl: '',
    duration: '',
    instructor: 'الأستاذ محمد رمضان',
    questionsCount: '',
    totalMarks: '',
    fileUrl: ''
  });

  // Sample content data
  const [contentItems, setContentItems] = useState<ContentItem[]>([
    {
      id: '1',
      title: 'مقدمة في التاريخ الإسلامي',
      description: 'محاضرة شاملة عن بداية الدولة الإسلامية',
      type: 'lecture',
      course: 'التاريخ الإسلامي',
      uploadDate: '2025-10-28',
      youtubeUrl: 'https://youtube.com/watch?v=xyz',
      duration: '45 دقيقة',
      instructor: 'الأستاذ محمد رمضان',
      thumbnail: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400'
    },
    {
      id: '2',
      title: 'ملخص الحرب العالمية الأولى',
      description: 'ملخص شامل PDF للحرب العالمية الأولى',
      type: 'material',
      subType: 'pdf',
      course: 'التاريخ الحديث',
      uploadDate: '2025-10-27',
      fileUrl: '#'
    },
    {
      id: '3',
      title: 'امتحان العصر العباسي',
      description: 'امتحان تفصيلي عن الفترة العباسية',
      type: 'exam',
      course: 'التاريخ الإسلامي',
      uploadDate: '2025-10-26',
      questionsCount: 30,
      totalMarks: 100
    }
  ]);

  const handleAddContent = () => {
    if (!formData.title || !formData.description || !formData.course) {
      toast({
        title: "خطأ",
        description: "يرجى ملء جميع الحقول المطلوبة",
        variant: "destructive"
      });
      return;
    }

    const newItem: ContentItem = {
      id: Date.now().toString(),
      title: formData.title,
      description: formData.description,
      course: formData.course,
      type: selectedTab === 'lectures' ? 'lecture' : selectedTab === 'materials' ? 'material' : 'exam',
      uploadDate: new Date().toISOString().split('T')[0],
      ...(selectedTab === 'lectures' && {
        youtubeUrl: formData.youtubeUrl,
        duration: formData.duration,
        instructor: formData.instructor,
        thumbnail: 'https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?w=400'
      }),
      ...(selectedTab === 'materials' && {
        subType: formData.type as 'pdf' | 'image' | 'document',
        fileUrl: formData.fileUrl || '#'
      }),
      ...(selectedTab === 'exams' && {
        questionsCount: parseInt(formData.questionsCount) || 0,
        totalMarks: parseInt(formData.totalMarks) || 0
      })
    };

    setContentItems([newItem, ...contentItems]);
    
    toast({
      title: "تم الإضافة بنجاح",
      description: `تم إضافة ${selectedTab === 'lectures' ? 'محاضرة' : selectedTab === 'materials' ? 'مادة تعليمية' : 'امتحان'} جديد`,
    });

    setFormData({
      title: '',
      description: '',
      course: '',
      type: '',
      youtubeUrl: '',
      duration: '',
      instructor: 'الأستاذ محمد رمضان',
      questionsCount: '',
      totalMarks: '',
      fileUrl: ''
    });
    setIsDialogOpen(false);
  };

  const handleDelete = (id: string) => {
    setContentItems(contentItems.filter(item => item.id !== id));
    toast({
      title: "تم الحذف",
      description: "تم حذف العنصر بنجاح",
    });
  };

  const filteredItems = contentItems.filter(item => {
    if (selectedTab === 'lectures') return item.type === 'lecture';
    if (selectedTab === 'materials') return item.type === 'material';
    if (selectedTab === 'exams') return item.type === 'exam';
    return true;
  });

  const getIcon = (item: ContentItem) => {
    if (item.type === 'lecture') return <Video className="w-5 h-5" />;
    if (item.type === 'exam') return <FileText className="w-5 h-5" />;
    if (item.subType === 'pdf') return <FileText className="w-5 h-5" />;
    if (item.subType === 'image') return <Image className="w-5 h-5" />;
    return <File className="w-5 h-5" />;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-slate-900 dark:via-indigo-950 dark:to-violet-950" dir="rtl">
      <FloatingParticles />
      <Header />

      <main className="container mx-auto px-4 py-8 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-4xl font-bold bg-gradient-to-r from-indigo-600 via-blue-600 to-violet-600 bg-clip-text text-transparent mb-2">
                إدارة المحتوى التعليمي
              </h1>
              <p className="text-slate-600 dark:text-slate-400">رفع وإدارة المحاضرات، المواد التعليمية، والامتحانات</p>
            </div>
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-indigo-600 via-blue-600 to-violet-600 hover:from-indigo-700 hover:via-blue-700 hover:to-violet-700 shadow-lg hover:shadow-xl transition-all">
                  <Plus className="w-5 h-5 ml-2" />
                  إضافة محتوى جديد
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[600px]" dir="rtl">
                <DialogHeader>
                  <DialogTitle className="text-2xl">
                    إضافة {selectedTab === 'lectures' ? 'محاضرة' : selectedTab === 'materials' ? 'مادة تعليمية' : 'امتحان'} جديد
                  </DialogTitle>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="title">العنوان *</Label>
                    <Input
                      id="title"
                      placeholder="عنوان المحتوى"
                      value={formData.title}
                      onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="description">الوصف *</Label>
                    <Textarea
                      id="description"
                      placeholder="وصف تفصيلي للمحتوى"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      rows={3}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="course">الكورس *</Label>
                    <Select value={formData.course} onValueChange={(value) => setFormData({ ...formData, course: value })}>
                      <SelectTrigger>
                        <SelectValue placeholder="اختر الكورس" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="التاريخ الإسلامي">التاريخ الإسلامي</SelectItem>
                        <SelectItem value="التاريخ الحديث">التاريخ الحديث</SelectItem>
                        <SelectItem value="الجغرافيا">الجغرافيا</SelectItem>
                        <SelectItem value="الحضارات القديمة">الحضارات القديمة</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {selectedTab === 'lectures' && (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="youtubeUrl">رابط YouTube</Label>
                        <Input
                          id="youtubeUrl"
                          placeholder="https://youtube.com/watch?v=..."
                          value={formData.youtubeUrl}
                          onChange={(e) => setFormData({ ...formData, youtubeUrl: e.target.value })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="grid gap-2">
                          <Label htmlFor="duration">المدة</Label>
                          <Input
                            id="duration"
                            placeholder="45 دقيقة"
                            value={formData.duration}
                            onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="instructor">المحاضر</Label>
                          <Input
                            id="instructor"
                            value={formData.instructor}
                            onChange={(e) => setFormData({ ...formData, instructor: e.target.value })}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {selectedTab === 'materials' && (
                    <div className="grid gap-2">
                      <Label htmlFor="type">نوع المادة</Label>
                      <Select value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value })}>
                        <SelectTrigger>
                          <SelectValue placeholder="اختر نوع المادة" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pdf">PDF</SelectItem>
                          <SelectItem value="image">صورة</SelectItem>
                          <SelectItem value="document">مستند</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {selectedTab === 'exams' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="questionsCount">عدد الأسئلة</Label>
                        <Input
                          id="questionsCount"
                          type="number"
                          placeholder="30"
                          value={formData.questionsCount}
                          onChange={(e) => setFormData({ ...formData, questionsCount: e.target.value })}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="totalMarks">الدرجة الكلية</Label>
                        <Input
                          id="totalMarks"
                          type="number"
                          placeholder="100"
                          value={formData.totalMarks}
                          onChange={(e) => setFormData({ ...formData, totalMarks: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                    إلغاء
                  </Button>
                  <Button 
                    className="bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
                    onClick={handleAddContent}
                  >
                    إضافة
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 bg-white dark:bg-slate-800 p-1 rounded-xl shadow-md">
            <Button
              variant={selectedTab === 'lectures' ? 'default' : 'ghost'}
              onClick={() => setSelectedTab('lectures')}
              className={selectedTab === 'lectures' ? 'bg-gradient-to-r from-cyan-600 to-teal-600' : ''}
            >
              <Video className="w-4 h-4 ml-2" />
              المحاضرات
            </Button>
            <Button
              variant={selectedTab === 'materials' ? 'default' : 'ghost'}
              onClick={() => setSelectedTab('materials')}
              className={selectedTab === 'materials' ? 'bg-gradient-to-r from-cyan-600 to-teal-600' : ''}
            >
              <BookOpen className="w-4 h-4 ml-2" />
              المواد التعليمية
            </Button>
            <Button
              variant={selectedTab === 'exams' ? 'default' : 'ghost'}
              onClick={() => setSelectedTab('exams')}
              className={selectedTab === 'exams' ? 'bg-gradient-to-r from-cyan-600 to-teal-600' : ''}
            >
              <FileText className="w-4 h-4 ml-2" />
              الامتحانات
            </Button>
          </div>
        </motion.div>

        {/* Content Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <AnimatePresence mode="popLayout">
            {filteredItems.map((item, index) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ delay: index * 0.05 }}
              >
                <Card className="bg-white dark:bg-slate-800 shadow-lg hover:shadow-xl transition-all border-0 overflow-hidden group">
                  {item.thumbnail && (
                    <div className="h-48 overflow-hidden relative">
                      <img
                        src={item.thumbnail}
                        alt={item.title}
                        className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                      <Badge className="absolute top-3 right-3 bg-gradient-to-r from-cyan-600 to-teal-600">
                        {item.type === 'lecture' ? 'محاضرة' : item.type === 'material' ? 'مادة' : 'امتحان'}
                      </Badge>
                    </div>
                  )}
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 text-cyan-600 dark:text-cyan-400">
                        {getIcon(item)}
                        <CardTitle className="text-lg">{item.title}</CardTitle>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-slate-600 dark:text-slate-400 mb-4 line-clamp-2">
                      {item.description}
                    </p>
                    <div className="space-y-2 mb-4">
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <BookOpen className="w-4 h-4" />
                        <span>{item.course}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <Calendar className="w-4 h-4" />
                        <span>{item.uploadDate}</span>
                      </div>
                      {item.duration && (
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <Clock className="w-4 h-4" />
                          <span>{item.duration}</span>
                        </div>
                      )}
                      {item.questionsCount && (
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <FileText className="w-4 h-4" />
                          <span>{item.questionsCount} سؤال - {item.totalMarks} درجة</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                      >
                        <Eye className="w-4 h-4 ml-1" />
                        عرض
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-600 text-red-600 hover:bg-red-50"
                        onClick={() => handleDelete(item.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {filteredItems.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-16"
          >
            <div className="text-cyan-600 mb-4">
              <Sparkles className="w-16 h-16 mx-auto" />
            </div>
            <h3 className="text-2xl font-bold text-slate-700 dark:text-slate-300 mb-2">
              لا يوجد محتوى حتى الآن
            </h3>
            <p className="text-slate-500 dark:text-slate-400 mb-6">
              ابدأ بإضافة {selectedTab === 'lectures' ? 'محاضرات' : selectedTab === 'materials' ? 'مواد تعليمية' : 'امتحانات'} للطلاب
            </p>
            <Button
              className="bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
              onClick={() => setIsDialogOpen(true)}
            >
              <Plus className="w-5 h-5 ml-2" />
              إضافة المحتوى الأول
            </Button>
          </motion.div>
        )}
      </main>
    </div>
  );
};

export default TeacherContentManager;
