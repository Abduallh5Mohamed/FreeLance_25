import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  Menu,
  X,
  LogOut,
  MessageCircle,
  User,
  FileText,
  Video,
  File,
  CreditCard,
  ClipboardCheck,
  Calendar,
  Home
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { NotificationBell } from "@/components/NotificationBell";

const StudentHeader = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [studentId, setStudentId] = useState<string>("");
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        setStudentId(user.id || '');
      } catch (e) {
        console.error('Error parsing user:', e);
      }
    }
  }, []);

  // Close menu when route changes
  useEffect(() => {
    setIsMenuOpen(false);
  }, [location.pathname]);

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (isMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMenuOpen]);

  const handleNavigate = (href: string) => {
    navigate(href);
    setIsMenuOpen(false);
  };

  const navigationItems = [
    { name: "الرئيسية", href: "/student", icon: Home },
    { name: "المحاضرات", href: "/student-lectures", icon: Video },
    { name: "الحصص المدفوعة", href: "/student-premium-lectures", icon: CreditCard },
    { name: "المحتوى التعليمي", href: "/student-content", icon: File },
    { name: "الامتحانات", href: "/student-exams", icon: FileText },
    { name: "نتائج الامتحانات", href: "/student-exam-results", icon: ClipboardCheck },
    { name: "الاجتماعات المباشرة", href: "/student-meetings", icon: Calendar },
    { name: "المحادثات", href: "/student-chat", icon: MessageCircle },
  ];

  const handleLogout = async () => {
    try {
      localStorage.removeItem('student_session');
      localStorage.removeItem('authToken');
      localStorage.removeItem('currentUser');
      localStorage.removeItem('currentStudent');
      localStorage.removeItem('supabaseUser');
      localStorage.removeItem('offlineStudentSession');

      await supabase.auth.signOut();

      toast({
        title: "تم تسجيل الخروج بنجاح",
        description: "أراك لاحقاً!",
      });

      navigate("/");
    } catch (error) {
      console.error('Logout error:', error);
      navigate("/");
    }
  };

  const isActive = (href: string) => {
    return location.pathname === href;
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
              const active = isActive(item.href);
              return (
                <Button
                  key={item.name}
                  variant="ghost"
                  onClick={() => handleNavigate(item.href, item.name)}
                  className="flex items-center gap-2 px-3 py-2 text-white hover:bg-white/20 hover:text-white rounded-xl transition-all duration-300 font-medium text-sm whitespace-nowrap"
                >
                  <Icon className="w-3.5 h-3.5 xl:w-4 xl:h-4 flex-shrink-0" />
                  <span className="hidden xl:inline">{item.name}</span>
                  <span className="xl:hidden">{item.name.split(' ')[0]}</span>
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
              className="flex items-center gap-1 xl:gap-1.5 text-white hover:bg-red-500/20 rounded-lg text-[10px] xl:text-xs border border-white/20 px-2 xl:px-3 py-1.5 xl:py-2"
            >
              <LogOut className="w-3.5 h-3.5 xl:w-4 xl:h-4" />
              <span className="hidden xl:inline">تسجيل الخروج</span>
              <span className="xl:hidden">خروج</span>
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

      {/* Mobile/Tablet Menu - Full screen overlay */}
      {isMenuOpen && (
        <div className="lg:hidden fixed inset-0 top-[52px] sm:top-[60px] bg-primary z-40 overflow-y-auto">
          <div className="container mx-auto px-3 sm:px-4 py-4 min-h-full">
            {/* Navigation Grid */}
            <div className="grid grid-cols-2 xs:grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
              {navigationItems.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <button
                    key={item.name}
                    onClick={() => handleNavigate(item.href)}
                    className={`flex flex-col items-center gap-1.5 sm:gap-2 p-3 sm:p-4 rounded-xl transition-all ${active
                        ? 'bg-white/20 text-white'
                        : 'bg-white/5 text-white/90 hover:bg-white/10 active:bg-white/15'
                      }`}
                  >
                    <Icon className="w-5 h-5 sm:w-6 sm:h-6" />
                    <span className="text-[11px] sm:text-xs text-center leading-tight font-medium">{item.name}</span>
                  </button>
                );
              })}
            </div>

            {/* Logout Button */}
            <button
              onClick={handleLogout}
              className="w-full mt-4 sm:mt-6 flex items-center justify-center gap-2 p-3 sm:p-4 bg-red-500/20 hover:bg-red-500/30 active:bg-red-500/40 text-white rounded-xl transition-all"
            >
              <LogOut className="w-5 h-5 sm:w-6 sm:h-6" />
              <span className="text-sm sm:text-base font-medium">تسجيل الخروج</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
};

export default StudentHeader;
