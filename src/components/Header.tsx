import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { NotificationBell } from "@/components/NotificationBell";
import {
  BookOpen,
  Users,
  Calendar,
  DollarSign,
  FileText,
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
  Brain,
  ChevronLeft,
  Home,
  BarChart3,
  Headphones,
  ShieldCheck,
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import tabwebAcademyLogo from "@/assets/Tabweb_Academy_Logo.png";
import { cn } from "@/lib/utils";
import { canAccessRoute, type AccessProfile } from "@/auth/access-control";

const Header = () => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>("main");
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [currentUser, setCurrentUser] = useState<AccessProfile | null>(null);
  const [userName, setUserName] = useState<string>("");

  // Persist sidebar collapsed state
  useEffect(() => {
    const saved = localStorage.getItem("sidebar_collapsed");
    if (saved !== null) setIsCollapsed(saved === "true");
  }, []);

  useEffect(() => {
    // Set sidebar width on mount
    document.documentElement.style.setProperty(
      "--sidebar-width",
      isCollapsed ? "72px" : "260px"
    );
    localStorage.setItem("sidebar_collapsed", String(isCollapsed));

    // Reset sidebar width on unmount so pages without sidebar work correctly
    return () => {
      document.documentElement.style.setProperty("--sidebar-width", "0px");
    };
  }, [isCollapsed]);

  useEffect(() => {
    const userStr = localStorage.getItem("currentUser");
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        setCurrentUser(user);
        setUserName(user.name || "");
      } catch (e) {
        console.error("Error parsing user:", e);
      }
    }
  }, []);

  // Auto-expand group containing active route
  useEffect(() => {
    for (const group of navGroups) {
      if (group.items.some((item) => location.pathname === item.href)) {
        setExpandedGroup(group.id);
        break;
      }
    }
  }, [location.pathname]);

  const canAccess = (href: string): boolean => {
    return canAccessRoute(currentUser, href);
  };

  const handleLogout = async () => {
    try {
      localStorage.removeItem("student_session");
      localStorage.removeItem("authToken");
      localStorage.removeItem("currentUser");
      localStorage.removeItem("currentStudent");
      localStorage.removeItem("supabaseUser");
      const { error } = await supabase.auth.signOut();
      if (error && error.message !== "No session found") throw error;
      toast({
        title: "تم تسجيل الخروج بنجاح",
        description: "أراك لاحقاً!",
      });
      navigate("/");
    } catch {
      toast({
        title: "خطأ في تسجيل الخروج",
        description: "حاول مرة أخرى",
        variant: "destructive",
      });
    }
  };

  const navGroups = useMemo(
    () => [
      {
        id: "platform-admin",
        label: "إدارة المنصة",
        items: [
          { name: "نظرة عامة", href: "/admin", icon: LayoutDashboard, color: "text-indigo-400" },
          { name: "المدرسون", href: "/admin/instructors", icon: GraduationCap, color: "text-purple-400" },
          { name: "مركز العمليات", href: "/admin/operations", icon: ClipboardList, color: "text-amber-400" },
          { name: "اشتراكات المنصة", href: "/admin/platform", icon: CreditCard, color: "text-emerald-400" },
          { name: "الموافقات", href: "/admin/approvals", icon: ClipboardCheck, color: "text-yellow-400" },
          { name: "فريق الإدارة", href: "/admin/team", icon: Users, color: "text-cyan-400" },
          { name: "الأمان والتدقيق", href: "/admin/security", icon: ShieldCheck, color: "text-slate-300" },
          { name: "الدعم", href: "/support", icon: Headphones, color: "text-rose-400" },
        ],
      },
      {
        id: "analytics-admin",
        label: "مركز التحليلات",
        items: [
          { name: "نظرة تنفيذية", href: "/admin/analytics/overview", icon: LayoutDashboard, color: "text-indigo-400" },
          { name: "الرسوم والاتجاهات", href: "/admin/analytics/charts", icon: BarChart3, color: "text-sky-400" },
          { name: "السيناريوهات والحسابات", href: "/admin/analytics/scenarios", icon: Brain, color: "text-violet-400" },
          { name: "التقارير والتصدير", href: "/admin/analytics/reports", icon: FileText, color: "text-emerald-400" },
          { name: "جودة البيانات والمؤشرات", href: "/admin/analytics/governance", icon: ShieldCheck, color: "text-amber-400" },
        ],
      },
      {
        id: "main",
        items: [
          {
            name: "لوحة التحكم",
            href: "/teacher",
            icon: LayoutDashboard,
            color: "text-blue-400",
          },
          {
            name: "المحتوى التعليمي",
            href: "/course-content",
            icon: FileText,
            color: "text-emerald-400",
          },
          {
            name: "الرسائل",
            href: "/messages",
            icon: MessageCircle,
            color: "text-amber-400",
          },
          {
            name: "المساعد الذكي",
            href: "/chat-assistant",
            icon: Brain,
            color: "text-violet-400",
          },
          {
            name: "الدعم",
            href: "/support",
            icon: Headphones,
            color: "text-rose-400",
          },
        ],
      },
      {
        id: "teacher",
        label: "المعلم",
        items: [
          {
            name: "رفع المحاضرات",
            href: "/teacher-lectures",
            icon: Video,
            color: "text-cyan-400",
          },
          {
            name: "الحصص المدفوعة",
            href: "/teacher-premium-lectures",
            icon: DollarSign,
            color: "text-yellow-400",
          },
          {
            name: "إنشاء امتحانات",
            href: "/teacher-exams",
            icon: ClipboardCheck,
            color: "text-pink-400",
          },
          {
            name: "نتائج الامتحانات",
            href: "/exam-results",
            icon: BarChart3,
            color: "text-green-400",
          },
          {
            name: "تصحيح المقالي",
            href: "/manual-grading",
            icon: ClipboardCheck,
            color: "text-orange-400",
          },
        ],
      },
      {
        id: "students",
        label: "الطلاب",
        items: [
          {
            name: "طلبات التسجيل",
            href: "/registration-requests",
            icon: ClipboardList,
            color: "text-blue-400",
          },
          {
            name: "الطلاب الأونلاين",
            href: "/students",
            icon: Users,
            color: "text-green-400",
          },
          {
            name: "الطلاب الأوفلاين",
            href: "/offline-students",
            icon: Users,
            color: "text-slate-400",
          },
          {
            name: "بطاقات الطلاب",
            href: "/student-barcodes",
            icon: Users,
            color: "text-indigo-400",
          },
          {
            name: "تقارير الطلاب",
            href: "/student-reports",
            icon: FileText,
            color: "text-teal-400",
          },
        ],
      },
      {
        id: "courses",
        label: "الكورسات",
        items: [
          {
            name: "الكورسات",
            href: "/courses",
            icon: BookOpen,
            color: "text-sky-400",
          },
          {
            name: "الصفوف",
            href: "/grades",
            icon: GraduationCap,
            color: "text-purple-400",
          },
          {
            name: "المجموعات",
            href: "/groups",
            icon: Users,
            color: "text-rose-400",
          },
          {
            name: "الاشتراكات",
            href: "/subscriptions",
            icon: DollarSign,
            color: "text-emerald-400",
          },
        ],
      },
      {
        id: "attendance",
        label: "الحضور والاجتماعات",
        items: [
          {
            name: "تسجيل الحضور",
            href: "/barcode-attendance",
            icon: Calendar,
            color: "text-blue-400",
          },
          {
            name: "سجل الحضور",
            href: "/attendance-log",
            icon: Calendar,
            color: "text-cyan-400",
          },
          {
            name: "الاجتماعات",
            href: "/online-meeting",
            icon: Calendar,
            color: "text-violet-400",
          },
        ],
      },
      {
        id: "finance",
        label: "المالية",
        items: [
          {
            name: "مصروفات الطلاب",
            href: "/fees",
            icon: DollarSign,
            color: "text-green-400",
          },
          {
            name: "سجل الدفعات",
            href: "/student-payments",
            icon: CreditCard,
            color: "text-blue-400",
          },
          {
            name: "مصروفات السنتر",
            href: "/expenses",
            icon: DollarSign,
            color: "text-red-400",
          },
          {
            name: "المستوردات",
            href: "/imports",
            icon: DollarSign,
            color: "text-amber-400",
          },
          {
            name: "كشف الحساب",
            href: "/account-statement",
            icon: Wallet,
            color: "text-teal-400",
          },
          {
            name: "الأرباح",
            href: "/profits",
            icon: DollarSign,
            color: "text-emerald-400",
          },
        ],
      },
      {
        id: "instructor-area",
        label: "أدوات المدرس",
        instructorOnly: true,
        items: [
          {
            name: "فيديوهاتي ومكتبتي",
            href: "/instructor-lectures",
            icon: Video,
            color: "text-indigo-400",
          },
          {
            name: "طلبات الفيديو",
            href: "/instructor-video-requests",
            icon: ClipboardList,
            color: "text-orange-400",
          },
          {
            name: "تسجيل وطلبات الطلاب",
            href: "/instructor-students",
            icon: Users,
            color: "text-blue-400",
          },
          {
            name: "رصيد خدمات المنصة",
            href: "/instructor-wallet",
            icon: Wallet,
            color: "text-emerald-400",
          },
          {
            name: "اشتراكي في المنصة",
            href: "/instructor-subscription",
            icon: CreditCard,
            color: "text-cyan-400",
          },
        ],
      },
      {
        id: "management",
        label: "الإدارة",
        items: [
          {
            name: "الموظفين",
            href: "/staff",
            icon: Users,
            color: "text-indigo-400",
          },
          {
            name: "إدارة المدرسين",
            href: "/admin/instructors",
            icon: GraduationCap,
            color: "text-purple-400",
          },
          {
            name: "التقارير",
            href: "/reports",
            icon: BarChart3,
            color: "text-cyan-400",
          },
        ],
      },
    ],
    []
  );

  const isActive = (href: string) => location.pathname === href;

  return (
    <aside
      className={cn(
        "fixed top-0 right-0 h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 shadow-2xl z-50 flex flex-col transition-all duration-300 ease-in-out border-l border-slate-700/50",
        isCollapsed ? "w-[72px]" : "w-[260px]"
      )}
    >
      {/* Logo & Brand */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-slate-700/50 shrink-0">
        <div className="w-10 h-10 rounded-xl overflow-hidden bg-gradient-to-br from-cyan-500 to-blue-600 shrink-0 flex items-center justify-center shadow-lg shadow-cyan-500/20">
          <img
            src={tabwebAcademyLogo}
            alt="Tabweb Academy"
            className="w-10 h-10 object-cover"
          />
        </div>
        {!isCollapsed && (
          <div className="min-w-0">
            <h1 className="text-white font-bold text-sm truncate">
              Tabweb Academy
            </h1>
            <p className="text-slate-400 text-[10px] truncate">{userName || "حساب المنصة"}</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav
        className="flex-1 overflow-y-auto py-3 px-2 space-y-1"
        style={{
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(148, 163, 184, 0.2) transparent",
        }}
      >
        {navGroups.map((group) => {
          const isAdminGroup = group.id === "platform-admin" || group.id === "analytics-admin";
          if ((currentUser?.role === "admin" || currentUser?.admin_member) && !isAdminGroup) return null;
          if (currentUser?.role !== "admin" && !currentUser?.admin_member && isAdminGroup) return null;
          // The "أدوات المدرس" group only appears for instructor accounts
          const groupVisible = !(group as any).instructorOnly || currentUser?.role === 'instructor';
          if (!groupVisible) return null;

          const visibleItems = group.items.filter((item) =>
            canAccess(item.href)
          );
          if (visibleItems.length === 0) return null;

          const isGroupExpanded = expandedGroup === group.id;
          const hasActive = visibleItems.some((item) => isActive(item.href));

          if (!group.label) {
            // Main nav items - always visible
            return (
              <div key={group.id} className="space-y-0.5 mb-2">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 group",
                        active
                          ? "bg-gradient-to-l from-cyan-500/20 to-blue-500/10 text-white font-semibold shadow-lg shadow-cyan-500/5 border border-cyan-500/20"
                          : "text-slate-400 hover:bg-white/5 hover:text-white"
                      )}
                    >
                      <Icon
                        className={cn(
                          "w-[18px] h-[18px] shrink-0 transition-colors",
                          active ? "text-cyan-400" : item.color
                        )}
                      />
                      {!isCollapsed && (
                        <span className="truncate">{item.name}</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          }

          // Grouped nav items
          return (
            <div key={group.id} className="mb-1">
              {!isCollapsed ? (
                <>
                  <button
                    onClick={() =>
                      setExpandedGroup(isGroupExpanded ? null : group.id)
                    }
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all duration-200",
                      hasActive && !isGroupExpanded
                        ? "text-slate-200 bg-white/5"
                        : "text-slate-500 hover:text-slate-300 hover:bg-white/5"
                    )}
                  >
                    <span className="tracking-wider">{group.label}</span>
                    <ChevronLeft
                      className={cn(
                        "w-3.5 h-3.5 transition-transform duration-200",
                        isGroupExpanded && "-rotate-90"
                      )}
                    />
                  </button>
                  {isGroupExpanded && (
                    <div className="space-y-0.5 mt-0.5 mr-1 border-r border-slate-700/50 pr-2">
                      {visibleItems.map((item) => {
                        const Icon = item.icon;
                        const active = isActive(item.href);
                        return (
                          <Link
                            key={item.href}
                            to={item.href}
                            className={cn(
                              "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200",
                              active
                                ? "bg-gradient-to-l from-cyan-500/20 to-blue-500/10 text-white font-semibold shadow-lg shadow-cyan-500/5 border border-cyan-500/20"
                                : "text-slate-400 hover:bg-white/5 hover:text-white"
                            )}
                          >
                            <Icon
                              className={cn(
                                "w-[18px] h-[18px] shrink-0 transition-colors",
                                active ? "text-cyan-400" : item.color
                              )}
                            />
                            <span className="truncate">{item.name}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                visibleItems.slice(0, 1).map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      to={item.href}
                      className={cn(
                        "flex items-center justify-center px-3 py-2.5 rounded-xl transition-all",
                        active
                          ? "bg-gradient-to-br from-cyan-500/20 to-blue-500/10 text-white border border-cyan-500/20"
                          : "text-slate-400 hover:bg-white/5 hover:text-white"
                      )}
                      title={item.name}
                    >
                      <Icon
                        className={cn(
                          "w-[18px] h-[18px]",
                          active ? "text-cyan-400" : item.color
                        )}
                      />
                    </Link>
                  );
                })
              )}
            </div>
          );
        })}
      </nav>

      {/* Bottom Actions */}
      <div className="border-t border-slate-700/50 px-2 py-3 space-y-1 shrink-0">
        <div className="flex items-center justify-center">
          <NotificationBell userType="teacher" />
        </div>
        <Button
          onClick={handleLogout}
          variant="ghost"
          className={cn(
            "w-full text-slate-400 hover:bg-red-500/10 hover:text-red-400 rounded-xl transition-all duration-200",
            isCollapsed ? "justify-center px-2" : "justify-start gap-3 px-3"
          )}
        >
          <LogOut className="w-[18px] h-[18px] shrink-0" />
          {!isCollapsed && <span className="text-sm">تسجيل الخروج</span>}
        </Button>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="absolute top-4 left-[-12px] w-6 h-6 bg-slate-700 border border-slate-600 rounded-full shadow-lg flex items-center justify-center hover:bg-slate-600 hover:border-slate-500 transition-all z-50"
      >
        <ChevronLeft
          className={cn(
            "w-3 h-3 text-slate-300 transition-transform",
            isCollapsed && "rotate-180"
          )}
        />
      </button>
    </aside>
  );
};

export default Header;
