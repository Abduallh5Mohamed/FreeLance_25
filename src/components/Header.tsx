import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { 
  BookOpen, 
  Users, 
  Calendar, 
  DollarSign, 
  FileText, 
  Menu,
  X,
  LogOut,
  MessageCircle,
  GraduationCap,
  ChevronDown,
  LayoutDashboard,
  Wallet,
  ClipboardList
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import alQaedLogo from "@/assets/al-qaed-logo-new.jpg";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const mainNavigation = [
    { name: "لوحة التحكم", href: "/teacher", icon: LayoutDashboard },
    { name: "المحتوى التعليمي", href: "/course-content", icon: FileText },
    { name: "الرسائل", href: "/messages", icon: MessageCircle },
  ];

  const studentsMenu = [
    { name: "طلبات التسجيل", href: "/registration-requests", icon: ClipboardList },
    { name: "الطلاب الأونلاين", href: "/students", icon: Users },
    { name: "الطلاب الأوفلاين", href: "/offline-students", icon: Users },
    { name: "بطاقات الطلاب", href: "/student-barcodes", icon: Users },
  ];

  const coursesMenu = [
    { name: "الكورسات", href: "/courses", icon: BookOpen },
    { name: "الصفوف", href: "/grades", icon: GraduationCap },
    { name: "المجموعات", href: "/groups", icon: Users },
    { name: "الاشتراكات", href: "/subscriptions", icon: DollarSign },
  ];

  const attendanceMenu = [
    { name: "الحضور", href: "/qr-attendance", icon: Calendar },
    { name: "تسجيل الحضور", href: "/barcode-attendance", icon: Calendar },
    { name: "الاجتماعات", href: "/online-meeting", icon: Calendar },
  ];

  const financeMenu = [
    { name: "مصروفات الطلاب", href: "/fees", icon: DollarSign },
    { name: "مصروفات السنتر", href: "/expenses", icon: DollarSign },
    { name: "المستوردات", href: "/imports", icon: DollarSign },
    { name: "كشف الحساب", href: "/account-statement", icon: Wallet },
    { name: "الأرباح", href: "/profits", icon: DollarSign },
  ];

  const managementMenu = [
    { name: "إدارة الامتحانات", href: "/exam-manager", icon: FileText },
    { name: "الموظفين", href: "/staff", icon: Users },
    { name: "التقارير", href: "/reports", icon: FileText },
  ];

  const handleLogout = async () => {
    try {
      // Clear student session if exists
      localStorage.removeItem('student_session');
      
      // Sign out from Supabase (for admin users)
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
          <nav className="hidden xl:flex items-center gap-2">
            {/* Main Links */}
            {mainNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className="flex items-center gap-2 px-4 py-2 text-white hover:bg-white/20 rounded-xl transition-all duration-300 font-medium"
                >
                  <Icon className="w-4 h-4" />
                  {item.name}
                </Link>
              );
            })}

            {/* Students Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="text-white hover:bg-white/20 rounded-xl font-medium">
                  <Users className="w-4 h-4 ml-2" />
                  الطلاب
                  <ChevronDown className="w-4 h-4 mr-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-white dark:bg-gray-800">
                {studentsMenu.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.name} asChild>
                      <Link to={item.href} className="flex items-center gap-2 cursor-pointer">
                        <Icon className="w-4 h-4" />
                        {item.name}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Courses Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="text-white hover:bg-white/20 rounded-xl font-medium">
                  <BookOpen className="w-4 h-4 ml-2" />
                  الكورسات
                  <ChevronDown className="w-4 h-4 mr-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-white dark:bg-gray-800">
                {coursesMenu.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.name} asChild>
                      <Link to={item.href} className="flex items-center gap-2 cursor-pointer">
                        <Icon className="w-4 h-4" />
                        {item.name}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Attendance Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="text-white hover:bg-white/20 rounded-xl font-medium">
                  <Calendar className="w-4 h-4 ml-2" />
                  الحضور
                  <ChevronDown className="w-4 h-4 mr-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-white dark:bg-gray-800">
                {attendanceMenu.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.name} asChild>
                      <Link to={item.href} className="flex items-center gap-2 cursor-pointer">
                        <Icon className="w-4 h-4" />
                        {item.name}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Finance Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="text-white hover:bg-white/20 rounded-xl font-medium">
                  <DollarSign className="w-4 h-4 ml-2" />
                  المالية
                  <ChevronDown className="w-4 h-4 mr-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-white dark:bg-gray-800">
                {financeMenu.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.name} asChild>
                      <Link to={item.href} className="flex items-center gap-2 cursor-pointer">
                        <Icon className="w-4 h-4" />
                        {item.name}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Management Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="text-white hover:bg-white/20 rounded-xl font-medium">
                  <FileText className="w-4 h-4 ml-2" />
                  الإدارة
                  <ChevronDown className="w-4 h-4 mr-2" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-white dark:bg-gray-800">
                {managementMenu.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem key={item.name} asChild>
                      <Link to={item.href} className="flex items-center gap-2 cursor-pointer">
                        <Icon className="w-4 h-4" />
                        {item.name}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>

          {/* Desktop Actions */}
          <div className="hidden xl:flex items-center gap-3">
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
            className="xl:hidden text-white hover:bg-white/20 rounded-xl"
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
            <div className="xl:hidden absolute top-4 left-0 right-0 bg-primary border-t-2 border-white/20 shadow-2xl rounded-b-3xl backdrop-blur-lg z-50 max-h-[80vh] overflow-y-auto">
              <div className="px-4 py-4 space-y-1">
                {/* Main Links */}
                <div className="mb-4">
                  <p className="text-xs font-bold text-white/60 px-3 mb-2">القائمة الرئيسية</p>
                  {mainNavigation.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/20 rounded-xl transition-all duration-300 font-medium"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        <Icon className="w-5 h-5" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>

                {/* Students Menu */}
                <div className="mb-4">
                  <p className="text-xs font-bold text-white/60 px-3 mb-2">الطلاب</p>
                  {studentsMenu.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/20 rounded-xl transition-all duration-300"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        <Icon className="w-5 h-5" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>

                {/* Courses Menu */}
                <div className="mb-4">
                  <p className="text-xs font-bold text-white/60 px-3 mb-2">الكورسات</p>
                  {coursesMenu.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/20 rounded-xl transition-all duration-300"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        <Icon className="w-5 h-5" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>

                {/* Attendance Menu */}
                <div className="mb-4">
                  <p className="text-xs font-bold text-white/60 px-3 mb-2">الحضور والاجتماعات</p>
                  {attendanceMenu.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/20 rounded-xl transition-all duration-300"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        <Icon className="w-5 h-5" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>

                {/* Finance Menu */}
                <div className="mb-4">
                  <p className="text-xs font-bold text-white/60 px-3 mb-2">المالية</p>
                  {financeMenu.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/20 rounded-xl transition-all duration-300"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        <Icon className="w-5 h-5" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>

                {/* Management Menu */}
                <div className="mb-4">
                  <p className="text-xs font-bold text-white/60 px-3 mb-2">الإدارة</p>
                  {managementMenu.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.name}
                        to={item.href}
                        className="flex items-center gap-3 px-4 py-3 text-white hover:bg-white/20 rounded-xl transition-all duration-300"
                        onClick={() => setIsMenuOpen(false)}
                      >
                        <Icon className="w-5 h-5" />
                        {item.name}
                      </Link>
                    );
                  })}
                </div>
                
                {/* Logout Button - Mobile */}
                <button
                  onClick={() => {
                    handleLogout();
                    setIsMenuOpen(false);
                  }}
                  className="flex items-center gap-3 px-4 py-3 text-white bg-red-500/20 hover:bg-red-500/30 rounded-xl transition-all duration-300 w-full font-medium mt-2"
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

export default Header;