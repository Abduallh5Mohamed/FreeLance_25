import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { NotificationBell } from "@/components/NotificationBell";
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
  ClipboardCheck,
  MessageSquare,
  Bot,
  ChevronDown,
  LayoutDashboard
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { getGrades, getGroups, createSubscriptionRequest, getSubscriptions, type Subscription } from "@/lib/api-http";
import alQaedLogo from "@/assets/Qaad_Logo.png";

const StudentHeader = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [grades, setGrades] = useState([]);
  const [groups, setGroups] = useState([]);
  const [subscriptionPlans, setSubscriptionPlans] = useState<Subscription[]>([]);
  const [selectedPlan, setSelectedPlan] = useState("");
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
      const [gradesData, groupsData, plansData] = await Promise.all([
        getGrades(),
        getGroups(),
        getSubscriptions()
      ]);
      setGrades(gradesData || []);
      setGroups(groupsData || []);
      setSubscriptionPlans(plansData || []);
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

  // Main navigation items
  const mainNavigation = [
    { name: "البروفايل", href: "/student", icon: User },
    { name: "المحادثات", href: "/student-chat", icon: MessageCircle },
    { name: "المساعد الذكي", href: "/student-ai-chat", icon: Bot },
  ];

  // Learning menu items
  const learningMenu = [
    { name: "المحاضرات", href: "/student-lectures", icon: Video },
    { name: "المحتوى التعليمي", href: "/student-content", icon: File },
    { name: "الحصص المدفوعة", href: "/student-premium-lectures", icon: CreditCard },
  ];

  // Exams menu items
  const examsMenu = [
    { name: "الامتحانات", href: "/student-exams", icon: FileText },
    { name: "نتائج الامتحانات", href: "/student-exam-results", icon: ClipboardCheck },
  ];

  // Meetings menu
  const meetingsMenu = [
    { name: "الاجتماعات المباشرة", href: "/student-meetings", icon: Video },
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
    <header className="bg-gradient-to-r from-orange-500 to-amber-600 shadow-lg sticky top-0 z-50 w-full overflow-x-hidden" dir="rtl">
      <div className="w-full px-1 sm:px-2">
        <div className="flex items-center justify-between py-1.5 gap-0.5">
          {/* Brand */}
          <div className="flex-shrink-0 min-w-0">
            <h1 className="text-xs sm:text-sm font-bold text-white truncate">منصة القائد</h1>
            <p className="text-white/90 text-[8px] hidden sm:block truncate">أ. محمد رمضان</p>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden lg:flex items-center gap-1.5 flex-1 justify-center">
            {/* Main Links */}
            {mainNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.name}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleNavigate(item.href, item.name)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-white/90 hover:text-white hover:bg-white/15 rounded-lg transition-all text-sm whitespace-nowrap"
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden 2xl:inline">{item.name}</span>
                </Button>
              );
            })}

            {/* Learning Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                  <BookOpen className="w-4 h-4" />
                  <span className="hidden 2xl:inline">التعليم</span>
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                {learningMenu.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.name} onClick={() => handleNavigate(item.href, item.name)}>
                      <div className="flex items-center gap-2 cursor-pointer w-full">
                        <Icon className="w-4 h-4 text-cyan-600" />
                        {item.name}
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Exams Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                  <FileText className="w-4 h-4" />
                  <span className="hidden 2xl:inline">الامتحانات</span>
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                {examsMenu.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.name} onClick={() => handleNavigate(item.href, item.name)}>
                      <div className="flex items-center gap-2 cursor-pointer w-full">
                        <Icon className="w-4 h-4 text-cyan-600" />
                        {item.name}
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Meetings Button */}
            {meetingsMenu.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.name}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleNavigate(item.href, item.name)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-white/90 hover:text-white hover:bg-white/15 rounded-lg transition-all text-sm whitespace-nowrap"
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden 2xl:inline">{item.name}</span>
                </Button>
              );
            })}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden lg:flex items-center gap-1 flex-shrink-0">
            {/* Notification Bell */}
            <NotificationBell userType="student" />
            
            <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-white hover:bg-white/10 px-1.5 py-1 text-[10px] rounded flex-shrink-0">
                  <CreditCard className="w-3 h-3 ml-0.5" />
                  <span className="hidden 2xl:inline">دفع</span>
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
                    <Label>خطة الاشتراك *</Label>
                    <Select 
                      value={selectedPlan} 
                      onValueChange={(value) => {
                        setSelectedPlan(value);
                        const plan = subscriptionPlans.find(p => p.id === value);
                        if (plan) {
                          setPaymentAmount(String(plan.price));
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر خطة الاشتراك" />
                      </SelectTrigger>
                      <SelectContent>
                        {subscriptionPlans.map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {plan.name} - {plan.price} ج.م ({plan.duration_months} شهر)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {subscriptionPlans.length === 0 && (
                      <p className="text-xs text-amber-500 mt-1">جاري تحميل خطط الاشتراك...</p>
                    )}
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
                    {selectedPlan && (
                      <p className="text-xs text-green-500 mt-1">
                        سعر الخطة: {subscriptionPlans.find(p => p.id === selectedPlan)?.price} ج.م
                      </p>
                    )}
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

                      if (!selectedPlan) {
                        toast({
                          title: "بيانات ناقصة",
                          description: "يرجى اختيار خطة الاشتراك",
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
                        const selectedPlanData = subscriptionPlans.find(p => p.id === selectedPlan);

                        await createSubscriptionRequest({
                          student_name: studentName,
                          phone: studentPhone,
                          guardian_phone: guardianPhone,
                          grade_id: parseInt(selectedGrade),
                          grade_name: selectedGradeData?.name || '',
                          group_id: parseInt(selectedGroup),
                          group_name: selectedGroupData?.name || '',
                          subscription_plan_id: selectedPlan,
                          subscription_plan_name: selectedPlanData?.name || '',
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
                        setSelectedPlan("");
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
              size="sm"
              className="text-white hover:bg-red-500/20 px-1.5 py-1 text-[10px] rounded flex-shrink-0"
            >
              <LogOut className="w-3 h-3 ml-0.5" />
              <span className="hidden 2xl:inline">خروج</span>
            </Button>
          </div>

          {/* Mobile Actions */}
          <div className="flex lg:hidden items-center gap-0.5 flex-shrink-0">
            {/* Notification Bell for Mobile */}
            <NotificationBell userType="student" />
            
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleNavigate('/student-chat', 'الدعم')}
              className="relative p-1 text-white hover:bg-white/10 rounded"
            >
              <MessageSquare className="w-3.5 h-3.5" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="p-1 text-white hover:bg-white/10 rounded"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
              {isMenuOpen ? <X className="w-3.5 h-3.5" /> : <Menu className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile Navigation */}
      {isMenuOpen && (
        <div className="lg:hidden bg-gradient-to-r from-orange-500 to-amber-600 border-t border-white/10">
          <div className="px-2 py-2 space-y-1 max-h-[70vh] overflow-y-auto">
            {/* Main Navigation */}
            <div className="mb-2">
              <div className="text-white/80 text-xs font-semibold px-3 py-1">القائمة الرئيسية</div>
              {mainNavigation.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.name}
                    onClick={() => {
                      handleNavigate(item.href, item.name);
                      setIsMenuOpen(false);
                    }}
                    className="flex items-center gap-3 px-3 py-2.5 text-white hover:bg-white/20 rounded-lg transition-all w-full text-right text-sm font-medium"
                  >
                    <Icon className="w-4 h-4" />
                    {item.name}
                  </button>
                );
              })}
            </div>

            {/* Learning Menu */}
            <div className="mb-2">
              <div className="text-white/80 text-xs font-semibold px-3 py-1">التعليم</div>
              {learningMenu.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.name}
                    onClick={() => {
                      handleNavigate(item.href, item.name);
                      setIsMenuOpen(false);
                    }}
                    className="flex items-center gap-3 px-3 py-2.5 text-white hover:bg-white/20 rounded-lg transition-all w-full text-right text-sm font-medium"
                  >
                    <Icon className="w-4 h-4" />
                    {item.name}
                  </button>
                );
              })}
            </div>

            {/* Exams Menu */}
            <div className="mb-2">
              <div className="text-white/80 text-xs font-semibold px-3 py-1">الامتحانات</div>
              {examsMenu.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.name}
                    onClick={() => {
                      handleNavigate(item.href, item.name);
                      setIsMenuOpen(false);
                    }}
                    className="flex items-center gap-3 px-3 py-2.5 text-white hover:bg-white/20 rounded-lg transition-all w-full text-right text-sm font-medium"
                  >
                    <Icon className="w-4 h-4" />
                    {item.name}
                  </button>
                );
              })}
            </div>

            {/* Meetings */}
            <div className="mb-2">
              <div className="text-white/80 text-xs font-semibold px-3 py-1">الاجتماعات</div>
              {meetingsMenu.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.name}
                    onClick={() => {
                      handleNavigate(item.href, item.name);
                      setIsMenuOpen(false);
                    }}
                    className="flex items-center gap-3 px-3 py-2.5 text-white hover:bg-white/20 rounded-lg transition-all w-full text-right text-sm font-medium"
                  >
                    <Icon className="w-4 h-4" />
                    {item.name}
                  </button>
                );
              })}
            </div>

            {/* دفع الاشتراك - موبايل */}
            <button
              onClick={() => {
                setShowPaymentDialog(true);
                setIsMenuOpen(false);
              }}
              className="flex items-center gap-3 px-3 py-2.5 text-white hover:bg-green-500/20 rounded-lg transition-all w-full text-right text-sm font-medium border border-white/20"
            >
              <CreditCard className="w-4 h-4" />
              دفع الاشتراك
            </button>

            {/* تسجيل الخروج - موبايل */}
            <button
              onClick={() => {
                handleLogout();
                setIsMenuOpen(false);
              }}
              className="flex items-center gap-3 px-3 py-2.5 text-white bg-red-500/20 hover:bg-red-500/30 rounded-lg transition-all w-full text-right text-sm font-medium"
            >
              <LogOut className="w-4 h-4" />
              تسجيل الخروج
            </button>
          </div>
        </div>
      )}
    </header>
  );
};

export default StudentHeader;