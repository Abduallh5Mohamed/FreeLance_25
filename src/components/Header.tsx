import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { NotificationBell } from "@/components/NotificationBell";
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
  ClipboardList,
  Video,
  CreditCard,
  ClipboardCheck,
  Brain
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import alQaedLogo from "@/assets/Qaad_Logo.png";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Permission mapping for routes
const PERMISSION_MAP: Record<string, string> = {
  '/students': 'students',
  '/offline-students': 'students',
  '/registration-requests': 'students',
  '/student-barcodes': 'students',
  '/student-reports': 'students',
  '/courses': 'courses',
  '/grades': 'groups',
  '/groups': 'groups',
  '/subscriptions': 'courses',
  '/attendance': 'attendance',
  '/barcode-attendance': 'attendance',
  '/attendance-log': 'attendance',
  '/online-meeting': 'attendance',
  '/fees': 'fees',
  '/student-payments': 'fees',
  '/messages': 'messages',
  '/chat-assistant': 'messages',
  '/reports': 'reports',
  '/expenses': 'expenses',
  '/imports': 'expenses',
  '/account-statement': 'expenses',
  '/profits': 'expenses',
  '/staff': 'admin', // Only admin can access staff management
  '/teacher-lectures': 'courses',
  '/teacher-exams': 'courses',
  '/exam-results': 'courses',
  '/manual-grading': 'courses',
  '/course-content': 'courses',
};

const Header = () => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const [userRole, setUserRole] = useState<string>('');
  const [accessiblePages, setAccessiblePages] = useState<string[]>([]);

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        setUserRole(user.role || '');
        setAccessiblePages(user.accessible_pages || []);
      } catch (e) {
        console.error('Error parsing user:', e);
      }
    }
  }, []);

  // Helper function to check if user can access a route
  const canAccess = (href: string): boolean => {
    // Admin and teacher have full access
    if (userRole === 'admin' || userRole === 'teacher') {
      return true;
    }

    // Staff can only access permitted pages
    if (userRole === 'staff') {
      const permission = PERMISSION_MAP[href];
      if (!permission) return false;
      if (permission === 'admin') return false; // Staff cannot access admin-only pages
      return accessiblePages.includes(permission);
    }

    return false;
  };

  // Filter menu items based on permissions
  const filterMenu = (menu: { name: string; href: string; icon: any }[]) => {
    return menu.filter(item => canAccess(item.href));
  };

  const mainNavigation = [
    { name: "لوحة التحكم", href: "/teacher", icon: LayoutDashboard },
    { name: "المحتوى التعليمي", href: "/course-content", icon: FileText },
    { name: "الرسائل", href: "/messages", icon: MessageCircle },
    { name: "المساعد الذكي", href: "/chat-assistant", icon: Brain },
  ];

  const teacherMenu = [
    { name: "رفع المحاضرات", href: "/teacher-lectures", icon: Video },
    { name: "الحصص المدفوعة", href: "/teacher-premium-lectures", icon: DollarSign },
    { name: "إنشاء امتحانات", href: "/teacher-exams", icon: ClipboardCheck },
    { name: "نتائج الامتحانات", href: "/exam-results", icon: ClipboardCheck },
    { name: "تصحيح المقالي", href: "/manual-grading", icon: ClipboardCheck },
  ];

  const studentsMenu = [
    { name: "طلبات التسجيل", href: "/registration-requests", icon: ClipboardList },
    { name: "الطلاب الأونلاين", href: "/students", icon: Users },
    { name: "الطلاب الأوفلاين", href: "/offline-students", icon: Users },
    { name: "بطاقات الطلاب", href: "/student-barcodes", icon: Users },
    { name: "تقارير الطلاب", href: "/student-reports", icon: FileText },
  ];

  const coursesMenu = [
    { name: "الكورسات", href: "/courses", icon: BookOpen },
    { name: "الصفوف", href: "/grades", icon: GraduationCap },
    { name: "المجموعات", href: "/groups", icon: Users },
    { name: "الاشتراكات", href: "/subscriptions", icon: DollarSign },
  ];

  const attendanceMenu = [
    { name: "إدارة الباركود", href: "/student-barcodes", icon: Calendar },
    { name: "تسجيل الحضور", href: "/barcode-attendance", icon: Calendar },
    { name: "سجل الحضور", href: "/attendance-log", icon: Calendar },
    { name: "الاجتماعات", href: "/online-meeting", icon: Calendar },
  ];

  const financeMenu = [
    { name: "مصروفات الطلاب", href: "/fees", icon: DollarSign },
    { name: "سجل الدفعات", href: "/student-payments", icon: CreditCard },
    { name: "مصروفات السنتر", href: "/expenses", icon: DollarSign },
    { name: "المستوردات", href: "/imports", icon: DollarSign },
    { name: "كشف الحساب", href: "/account-statement", icon: Wallet },
    { name: "الأرباح", href: "/profits", icon: DollarSign },
  ];

  const managementMenu = [
    { name: "الموظفين", href: "/staff", icon: Users },
    { name: "التقارير", href: "/reports", icon: FileText },
  ];

  // Filter menus for staff users
  const filteredMainNav = useMemo(() => filterMenu(mainNavigation), [userRole, accessiblePages]);
  const filteredTeacherMenu = useMemo(() => filterMenu(teacherMenu), [userRole, accessiblePages]);
  const filteredStudentsMenu = useMemo(() => filterMenu(studentsMenu), [userRole, accessiblePages]);
  const filteredCoursesMenu = useMemo(() => filterMenu(coursesMenu), [userRole, accessiblePages]);
  const filteredAttendanceMenu = useMemo(() => filterMenu(attendanceMenu), [userRole, accessiblePages]);
  const filteredFinanceMenu = useMemo(() => filterMenu(financeMenu), [userRole, accessiblePages]);
  const filteredManagementMenu = useMemo(() => filterMenu(managementMenu), [userRole, accessiblePages]);

  const handleLogout = async () => {
    try {
      // Clear all authentication data
      localStorage.removeItem('student_session');
      localStorage.removeItem('authToken');
      localStorage.removeItem('currentUser');
      localStorage.removeItem('currentStudent');
      localStorage.removeItem('supabaseUser');

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
    <header className="bg-gradient-to-r from-cyan-600 to-teal-600 shadow-lg border-b border-white/10 sticky top-0 z-50" dir="rtl">
      <div className="max-w-[1800px] mx-auto px-4 lg:px-6">
        <div className="flex items-center justify-between py-2.5 gap-3">
          {/* Brand Text Only */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="text-white">
              <h1 className="text-base lg:text-xl font-bold drop-shadow-lg whitespace-nowrap">منصة القائد</h1>
              <p className="text-cyan-100 text-[10px] lg:text-xs font-medium whitespace-nowrap hidden sm:block">الأستاذ محمد رمضان - التاريخ</p>
            </div>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden xl:flex items-center gap-1.5 flex-1 justify-center">
            {/* Main Links */}
            {filteredMainNav.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-white/90 hover:text-white hover:bg-white/15 rounded-lg transition-all text-sm whitespace-nowrap"
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden 2xl:inline">{item.name}</span>
                </Link>
              );
            })}

            {/* Teacher Dropdown - only show if has items */}
            {filteredTeacherMenu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                    <Video className="w-4 h-4" />
                    <span className="hidden 2xl:inline">المعلم</span>
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                  {filteredTeacherMenu.map((item) => {
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem key={item.name} asChild>
                        <Link to={item.href} className="flex items-center gap-2 cursor-pointer">
                          <Icon className="w-4 h-4 text-cyan-600" />
                          {item.name}
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Students Dropdown - only show if has items */}
            {filteredStudentsMenu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                    <Users className="w-4 h-4" />
                    <span className="hidden 2xl:inline">الطلاب</span>
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                  {filteredStudentsMenu.map((item) => {
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem key={item.name} asChild>
                        <Link to={item.href} className="flex items-center gap-2 cursor-pointer">
                          <Icon className="w-4 h-4 text-cyan-600" />
                          {item.name}
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Courses Dropdown - only show if has items */}
            {filteredCoursesMenu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                    <BookOpen className="w-4 h-4" />
                    <span className="hidden 2xl:inline">الكورسات</span>
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                  {filteredCoursesMenu.map((item) => {
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
            )}

            {/* Attendance Dropdown - only show if has items */}
            {filteredAttendanceMenu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                    <Calendar className="w-4 h-4" />
                    الحضور
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                  {filteredAttendanceMenu.map((item) => {
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
            )}

            {/* Finance Dropdown - only show if has items */}
            {filteredFinanceMenu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                    <DollarSign className="w-4 h-4" />
                    المالية
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                  {filteredFinanceMenu.map((item) => {
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
            )}

            {/* Management Dropdown - only show if has items */}
            {filteredManagementMenu.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="text-white/90 hover:text-white hover:bg-white/15 rounded-lg text-sm px-3 py-1.5 h-auto gap-1">
                    <FileText className="w-4 h-4" />
                    الإدارة
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52 bg-white dark:bg-gray-800">
                  {filteredManagementMenu.map((item) => {
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
            )}
          </nav>

          {/* Desktop Actions */}
          <div className="hidden xl:flex items-center gap-3">
            {/* Notification Bell */}
            <NotificationBell userType="teacher" />
            
            <Button
              onClick={handleLogout}
              variant="ghost"
              className="text-white hover:bg-red-500/20 hover:text-white rounded-xl font-medium transition-all duration-300 border border-white/20"
            >
              <LogOut className="w-4 h-4" />
              تسجيل الخروج
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <div className="xl:hidden flex items-center gap-2">
            {/* Notification Bell for Mobile */}
            <NotificationBell userType="teacher" />
            
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/20 rounded-xl"
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
              {isMenuOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className="relative">
          {isMenuOpen && (
            <div className="xl:hidden absolute top-4 left-0 right-0 bg-gradient-to-br from-teal-600 to-teal-700 border-t-2 border-white/20 shadow-2xl rounded-b-3xl backdrop-blur-lg z-50 max-h-[80vh] overflow-y-auto">
              <div className="px-4 py-4 space-y-1">
                {/* Main Links */}
                {filteredMainNav.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-white/60 px-3 mb-2">القائمة الرئيسية</p>
                    {filteredMainNav.map((item) => {
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
                )}

                {/* Teacher Menu */}
                {filteredTeacherMenu.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-white/60 px-3 mb-2">المعلم</p>
                    {filteredTeacherMenu.map((item) => {
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
                )}

                {/* Students Menu */}
                {filteredStudentsMenu.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-white/60 px-3 mb-2">الطلاب</p>
                    {filteredStudentsMenu.map((item) => {
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
                )}

                {/* Courses Menu */}
                {filteredCoursesMenu.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-white/60 px-3 mb-2">الكورسات</p>
                    {filteredCoursesMenu.map((item) => {
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
                )}

                {/* Attendance Menu */}
                {filteredAttendanceMenu.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-white/60 px-3 mb-2">الحضور والاجتماعات</p>
                    {filteredAttendanceMenu.map((item) => {
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
                )}

                {/* Finance Menu */}
                {filteredFinanceMenu.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-white/60 px-3 mb-2">المالية</p>
                    {filteredFinanceMenu.map((item) => {
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
                )}

                {/* Management Menu */}
                {filteredManagementMenu.length > 0 && (
                  <div className="mb-4">
                    <p className="text-xs font-bold text-white/60 px-3 mb-2">الإدارة</p>
                    {filteredManagementMenu.map((item) => {
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
                )}

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

