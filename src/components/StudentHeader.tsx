import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  Menu,
  X,
  LogOut,
  MessageCircle,
  User,
  FileText,
  BookOpen,
  Video,
  File,
  CreditCard,
  Upload,
  Image as ImageIcon,
  ClipboardCheck
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { getGrades, getGroups, createSubscriptionRequest } from "@/lib/api-http";
import alQaedLogo from "@/assets/Qaad_Logo.png";

const StudentHeader = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [grades, setGrades] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGrade, setSelectedGrade] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("");
  const [studentName, setStudentName] = useState("");
  const [studentPhone, setStudentPhone] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentImage, setPaymentImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (showPaymentDialog) {
      loadGradesAndGroups();
    }
  }, [showPaymentDialog]);

  const loadGradesAndGroups = async () => {
    try {
      const [gradesData, groupsData] = await Promise.all([
        getGrades(),
        getGroups()
      ]);
      setGrades(gradesData || []);
      setGroups(groupsData || []);
    } catch (error) {
      console.error('Error loading data:', error);
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Check file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: "حجم الصورة كبير",
          description: "الحد الأقصى لحجم الصورة هو 5 ميجابايت",
          variant: "destructive",
        });
        return;
      }

      // Check file type
      if (!file.type.startsWith('image/')) {
        toast({
          title: "نوع الملف غير صحيح",
          description: "يرجى اختيار صورة فقط",
          variant: "destructive",
        });
        return;
      }

      setPaymentImage(file);

      // Create preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = () => {
    setPaymentImage(null);
    setImagePreview(null);
  };

  const handleNavigate = (href: string, name: string, scrollTo?: string) => {
    if (scrollTo) {
      // Always navigate to /student first if not already there
      if (window.location.pathname !== "/student") {
        navigate("/student");
        // Wait for navigation then scroll
        setTimeout(() => {
          const section = document.querySelector(`[data-section="${scrollTo}"]`);
          if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 100);
      } else {
        // Already on student page, just scroll
        const section = document.querySelector(`[data-section="${scrollTo}"]`);
        if (section) {
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    } else {
      navigate(href);
    }
  };

  const studentNavigation = [
    { name: "البروفايل", href: "/student", icon: User },
    { name: "المحاضرات", href: "/student-lectures", icon: Video },
    { name: "الحصص المدفوعة", href: "/student-premium-lectures", icon: CreditCard },
    { name: "المحتوى التعليمي", href: "/student-content", icon: File },
    { name: "الامتحانات", href: "/student-exams", icon: FileText },
    { name: "نتائج الامتحانات", href: "/student-exam-results", icon: ClipboardCheck },
    { name: "المحادثات", href: "/student-chat", icon: MessageCircle },
  ];

  const handleLogout = async () => {
    try {
      // Clear offline student session if exists
      const offlineSession = localStorage.getItem('offlineStudentSession');
      if (offlineSession) {
        localStorage.removeItem('offlineStudentSession');
        // Clear all authentication data
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        localStorage.removeItem('currentStudent');
        localStorage.removeItem('supabaseUser');
        toast({
          title: "تم تسجيل الخروج بنجاح",
          description: "أراك لاحقاً!",
        });
        navigate("/");
        return;
      }

      // Clear student session and all authentication data
      localStorage.removeItem('student_session');
      localStorage.removeItem('authToken');
      localStorage.removeItem('currentUser');
      localStorage.removeItem('currentStudent');
      localStorage.removeItem('supabaseUser');

      // Sign out from Supabase (for online students and admin users)
      const { error } = await supabase.auth.signOut();
      if (error && error.message !== "No session found") {
        throw error;
      }

      toast({
        title: "تم تسجيل الخروج بنجاح",
        description: "أراك لاحقاً!",
      });

      navigate("/");
    } catch (error) {
      toast({
        title: "خطأ في تسجيل الخروج",
        description: "حاول مرة أخرى",
        variant: "destructive",
      });
    }
  };

  return (
    <header className="bg-primary shadow-2xl border-b-2 border-white/10 sticky top-0 z-50 backdrop-blur-sm" dir="rtl">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          {/* Brand Text */}
          <div className="flex items-center gap-3 min-w-fit">
            <div>
              <h1 className="text-base sm:text-lg md:text-xl font-bold text-white drop-shadow-lg">منصة القائد</h1>
              <p className="text-blue-100 text-[10px] sm:text-xs font-medium hidden sm:block">الأستاذ محمد رمضان - التاريخ</p>
            </div>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-2 flex-1 justify-center overflow-x-auto scrollbar-hide">
            {studentNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.name}
                  variant="ghost"
                  onClick={() => handleNavigate(item.href, item.name)}
                  className="flex items-center gap-2 px-3 py-2 text-white hover:bg-white/20 hover:text-white rounded-xl transition-all duration-300 font-medium text-sm whitespace-nowrap"
                >
                  <Icon className="w-4 h-4" />
                  {item.name}
                </Button>
              );
            })}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-3">
            <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  className="text-white hover:bg-green-500/20 hover:text-white rounded-xl font-medium transition-all duration-300 border border-white/20"
                >
                  <CreditCard className="w-4 h-4 ml-2" />
                  دفع الاشتراك
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" dir="rtl">
                <DialogHeader>
                  <DialogTitle className="text-xl">دفع الاشتراك</DialogTitle>
                </DialogHeader>
                <form className="space-y-4 mt-4">
                  <div>
                    <Label>اسم الطالب *</Label>
                    <Input
                      type="text"
                      value={studentName}
                      onChange={(e) => setStudentName(e.target.value)}
                      placeholder="أدخل اسم الطالب"
                      required
                    />
                  </div>

                  <div>
                    <Label>رقم الهاتف *</Label>
                    <Input
                      type="tel"
                      value={studentPhone}
                      onChange={(e) => setStudentPhone(e.target.value)}
                      placeholder="01xxxxxxxxx"
                      required
                    />
                  </div>

                  <div>
                    <Label>رقم هاتف ولي الأمر *</Label>
                    <Input
                      type="tel"
                      value={guardianPhone}
                      onChange={(e) => setGuardianPhone(e.target.value)}
                      placeholder="01xxxxxxxxx"
                      required
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      سيتم إرسال إشعار واتساب لهذا الرقم عند الموافقة على الدفع
                    </p>
                  </div>

                  <div>
                    <Label>الصف الدراسي *</Label>
                    <Select value={selectedGrade} onValueChange={setSelectedGrade}>
                      <SelectTrigger>
                        <SelectValue placeholder="اختر الصف الدراسي" />
                      </SelectTrigger>
                      <SelectContent>
                        {grades.map((grade) => (
                          <SelectItem key={grade.id} value={grade.id}>
                            {grade.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>المجموعة *</Label>
                    <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                      <SelectTrigger>
                        <SelectValue placeholder="اختر المجموعة" />
                      </SelectTrigger>
                      <SelectContent>
                        {groups.map((group) => (
                          <SelectItem key={group.id} value={group.id}>
                            {group.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>المبلغ المدفوع *</Label>
                    <Input
                      type="number"
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(e.target.value)}
                      placeholder="أدخل المبلغ بالجنيه"
                      required
                      min="0"
                    />
                  </div>

                  <div>
                    <Label>ملاحظات</Label>
                    <Textarea
                      rows={3}
                      placeholder="أضف ملاحظاتك هنا..."
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </div>

                  <div>
                    <Label>صورة إيصال الدفع</Label>
                    <div className="mt-2">
                      {!imagePreview ? (
                        <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors">
                          <div className="flex flex-col items-center justify-center pt-5 pb-6">
                            <Upload className="w-8 h-8 mb-2 text-gray-400" />
                            <p className="text-sm text-gray-500">اضغط لرفع صورة الإيصال</p>
                            <p className="text-xs text-gray-400 mt-1">PNG, JPG (حد أقصى 5MB)</p>
                          </div>
                          <input
                            type="file"
                            className="hidden"
                            accept="image/*"
                            onChange={handleImageChange}
                          />
                        </label>
                      ) : (
                        <div className="relative">
                          <img
                            src={imagePreview}
                            alt="معاينة الإيصال"
                            className="w-full h-48 object-cover rounded-lg border-2 border-gray-200"
                          />
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="absolute top-2 left-2"
                            onClick={removeImage}
                          >
                            <X className="w-4 h-4 ml-1" />
                            حذف
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>

                  <Button
                    type="button"
                    className="w-full bg-gradient-to-r from-green-500 to-emerald-600"
                    onClick={async () => {
                      if (!paymentImage) {
                        toast({
                          title: "يرجى رفع صورة الإيصال",
                          description: "قم برفع صورة إيصال الدفع أولاً",
                          variant: "destructive",
                        });
                        return;
                      }

                      if (!studentName || !studentPhone) {
                        toast({
                          title: "بيانات ناقصة",
                          description: "يرجى إدخال الاسم ورقم الهاتف",
                          variant: "destructive",
                        });
                        return;
                      }

                      if (!guardianPhone || guardianPhone.length < 11) {
                        toast({
                          title: "بيانات ناقصة",
                          description: "يرجى إدخال رقم هاتف ولي الأمر صحيح (11 رقم)",
                          variant: "destructive",
                        });
                        return;
                      }

                      if (!selectedGrade || !selectedGroup) {
                        toast({
                          title: "بيانات ناقصة",
                          description: "يرجى اختيار الصف والمجموعة",
                          variant: "destructive",
                        });
                        return;
                      }

                      if (!paymentAmount || parseFloat(paymentAmount) <= 0) {
                        toast({
                          title: "بيانات ناقصة",
                          description: "يرجى إدخال المبلغ المدفوع",
                          variant: "destructive",
                        });
                        return;
                      }

                      try {
                        const selectedGradeData = grades.find(g => g.id === selectedGrade);
                        const selectedGroupData = groups.find(g => g.id === selectedGroup);

                        await createSubscriptionRequest({
                          student_name: studentName,
                          phone: studentPhone,
                          guardian_phone: guardianPhone,
                          grade_id: parseInt(selectedGrade),
                          grade_name: selectedGradeData?.name || '',
                          group_id: parseInt(selectedGroup),
                          group_name: selectedGroupData?.name || '',
                          amount: parseFloat(paymentAmount),
                          notes: notes || null,
                          receipt_image_url: imagePreview || null,
                        });

                        toast({
                          title: "✅ تم إرسال الطلب بنجاح",
                          description: "سيتم مراجعة طلبك والرد عليك قريباً",
                        });

                        setShowPaymentDialog(false);
                        setStudentName("");
                        setStudentPhone("");
                        setGuardianPhone("");
                        setPaymentAmount("");
                        setSelectedGrade("");
                        setSelectedGroup("");
                        setNotes("");
                        removeImage();
                      } catch (error) {
                        toast({
                          title: "خطأ في إرسال الطلب",
                          description: error instanceof Error ? error.message : "حاول مرة أخرى",
                          variant: "destructive",
                        });
                      }
                    }}
                  >
                    دفع الآن
                  </Button>
                </form>
              </DialogContent>
            </Dialog>

            <Button
              onClick={handleLogout}
              variant="ghost"
              className="text-white hover:bg-red-500/20 hover:text-white rounded-xl font-medium transition-all duration-300 border border-white/20"
            >
              <LogOut className="w-4 h-4 ml-2" />
              تسجيل الخروج
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden text-white hover:bg-white/20 rounded-xl"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            {isMenuOpen ? (
              <X className="w-6 h-6" />
            ) : (
              <Menu className="w-6 h-6" />
            )}
          </Button>
        </div>

        {/* Mobile Navigation */}
        <div className="relative">
          {isMenuOpen && (
            <div className="md:hidden absolute top-4 left-0 right-0 bg-primary border-t-2 border-white/20 shadow-2xl rounded-b-3xl backdrop-blur-lg z-50 max-h-[80vh] overflow-y-auto">
              <div className="px-4 py-4 space-y-2">
                {studentNavigation.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.name}
                      onClick={() => {
                        handleNavigate(item.href, item.name);
                        setIsMenuOpen(false);
                      }}
                      className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/20 rounded-xl transition-all duration-300 w-full text-right font-medium"
                    >
                      <Icon className="w-5 h-5" />
                      {item.name}
                    </button>
                  );
                })}

                {/* Logout Button - Mobile */}
                <button
                  onClick={() => {
                    handleLogout();
                    setIsMenuOpen(false);
                  }}
                  className="flex items-center gap-3 px-4 py-3 text-white bg-red-500/20 hover:bg-red-500/30 rounded-xl transition-all duration-300 w-full text-right font-medium"
                >
                  <LogOut className="w-5 h-5" />
                  تسجيل الخروج
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default StudentHeader;