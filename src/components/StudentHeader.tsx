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
    <header className="bg-gradient-primary shadow-soft border-b border-border/50 relative" dir="rtl">
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          {/* Logo and Brand */}
          <div className="flex items-center gap-4">
            <img 
              src={alQaedLogo} 
              alt="منصة القائد" 
              className="w-12 h-12 rounded-full object-cover border-2 border-accent/30"
            />
            <div>
              <h1 className="text-xl font-bold text-white">منصة القائد</h1>
              <p className="text-blue-100 text-sm">الأستاذ محمد رمضان - التاريخ</p>
            </div>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            {studentNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.name}
                  variant="ghost"
                  onClick={() => navigate(item.href)}
                  className="flex items-center gap-2 text-white hover:bg-white/10 hover:text-white"
                >
                  <Icon className="w-4 h-4" />
                  {item.name}
                </Button>
              );
            })}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-2">
            <Button
              onClick={handleLogout}
              variant="ghost"
              className="text-white hover:bg-white/10 hover:text-accent"
            >
              <LogOut className="w-4 h-4 ml-2" />
              تسجيل الخروج
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden text-white"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            {isMenuOpen ? (
              <X className="w-5 h-5" />
            ) : (
              <Menu className="w-5 h-5" />
            )}
          </Button>
        </div>

        {/* Mobile Navigation */}
        <div className="relative">
          {isMenuOpen && (
            <div className="md:hidden absolute top-full left-0 right-0 bg-primary border-t border-blue-400 shadow-lg z-50">
              <div className="px-4 py-2 space-y-1">
                {studentNavigation.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.name}
                      onClick={() => {
                        navigate(item.href);
                        setIsMenuOpen(false);
                      }}
                      className="flex items-center gap-2 px-3 py-2 text-white hover:bg-blue-600 rounded-lg transition-colors w-full text-right"
                    >
                      <Icon className="w-4 h-4" />
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
                  className="flex items-center gap-2 px-3 py-2 text-white hover:bg-blue-600 rounded-lg transition-colors w-full text-right"
                >
                  <LogOut className="w-4 h-4" />
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