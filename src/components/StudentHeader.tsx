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
    <header className="bg-primary shadow-lg sticky top-0 z-50" dir="rtl">
      <div className="container mx-auto px-3 sm:px-4 py-2 sm:py-3">
        <div className="flex items-center justify-between gap-2">
          {/* Logo/Brand */}
          <div
            className="flex items-center gap-2 flex-shrink-0 cursor-pointer"
            onClick={() => handleNavigate('/student')}
          >
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg md:text-xl font-bold text-white truncate">منصة القائد</h1>
              <p className="text-blue-100 text-[9px] sm:text-[10px] md:text-xs hidden xs:block">الأستاذ محمد رمضان</p>
            </div>
          </div>

          {/* Desktop Navigation - Show on lg screens and above */}
          <nav className="hidden lg:flex items-center gap-0.5 xl:gap-1 flex-1 justify-center overflow-x-auto">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Button
                  key={item.name}
                  variant="ghost"
                  onClick={() => handleNavigate(item.href)}
                  className={`flex items-center gap-1 px-2 xl:px-3 py-1.5 xl:py-2 text-white rounded-lg transition-all text-[10px] xl:text-xs whitespace-nowrap ${active ? 'bg-white/20' : 'hover:bg-white/10'
                    }`}
                >
                  <Icon className="w-3.5 h-3.5 xl:w-4 xl:h-4 flex-shrink-0" />
                  <span className="hidden xl:inline">{item.name}</span>
                  <span className="xl:hidden">{item.name.split(' ')[0]}</span>
                </Button>
              );
            })}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden lg:flex items-center gap-1.5 xl:gap-2 flex-shrink-0">
            <NotificationBell userId={studentId} userType="student" />
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

          {/* Mobile/Tablet Actions - Show below lg screens */}
          <div className="flex lg:hidden items-center gap-1.5 sm:gap-2">
            <NotificationBell userId={studentId} userType="student" />
            <Button
              variant="ghost"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="text-white hover:bg-white/10 p-1.5 sm:p-2 rounded-lg"
              aria-label={isMenuOpen ? "إغلاق القائمة" : "فتح القائمة"}
            >
              {isMenuOpen ? <X className="w-5 h-5 sm:w-6 sm:h-6" /> : <Menu className="w-5 h-5 sm:w-6 sm:h-6" />}
            </Button>
          </div>
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
