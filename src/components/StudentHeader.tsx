import { useState } from "react";
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
  BookOpen
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import alQaedLogo from "@/assets/al-qaed-logo-new.jpg";

const StudentHeader = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const handleNavigate = (href: string, name: string) => {
    if (name === "الكورسات" && window.location.pathname === "/student") {
      // Scroll to courses section if already on student page
      const coursesSection = document.querySelector('[data-section="courses"]');
      if (coursesSection) {
        coursesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      navigate(href);
    }
  };

  const studentNavigation = [
    { name: "البروفايل", href: "/student", icon: User },
    { name: "الكورسات", href: "/student", icon: BookOpen },
    { name: "الرسائل", href: "/messages", icon: MessageCircle },
  ];

  const handleLogout = async () => {
    try {
      // Clear offline student session if exists
      const offlineSession = localStorage.getItem('offlineStudentSession');
      if (offlineSession) {
        localStorage.removeItem('offlineStudentSession');
        toast({
          title: "تم تسجيل الخروج بنجاح",
          description: "أراك لاحقاً!",
        });
        navigate("/");
        return;
      }

      // Clear student session if exists
      localStorage.removeItem('student_session');
      
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
          {/* Logo and Brand */}
          <div className="flex items-center gap-3 min-w-fit">
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-r from-yellow-400 to-orange-500 rounded-full blur-lg opacity-50 animate-pulse"></div>
              <img 
                src={alQaedLogo} 
                alt="منصة القائد" 
                className="relative w-14 h-14 rounded-full object-cover border-3 border-white shadow-xl hover:scale-110 transition-transform duration-300"
              />
            </div>
            <div className="hidden md:block">
              <h1 className="text-xl font-bold text-white drop-shadow-lg">منصة القائد</h1>
              <p className="text-blue-100 text-xs font-medium">الأستاذ محمد رمضان - التاريخ</p>
            </div>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-2">
            {studentNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.name}
                  variant="ghost"
                  onClick={() => handleNavigate(item.href, item.name)}
                  className="flex items-center gap-2 px-4 py-2 text-white hover:bg-white/20 hover:text-white rounded-xl transition-all duration-300 font-medium"
                >
                  <Icon className="w-4 h-4" />
                  {item.name}
                </Button>
              );
            })}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-3">
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
            <div className="md:hidden absolute top-4 left-0 right-0 bg-primary border-t-2 border-white/20 shadow-2xl rounded-b-3xl backdrop-blur-lg z-50">
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