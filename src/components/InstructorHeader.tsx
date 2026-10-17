import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  LayoutDashboard,
  Video,
  Wallet,
  GitPullRequest,
  Users,
  LogOut,
  GraduationCap,
  ChevronLeft,
  Headphones,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { clearAuthToken } from '@/lib/api';
import { cn } from '@/lib/utils';
import tabwebAcademyLogo from '@/assets/Tabweb_Academy_Logo.png';

interface InstructorHeaderProps {
  instructorName?: string;
  walletBalance?: number | string;
}

const navItems = [
  { label: 'الرئيسية',          href: '/instructor',                  icon: LayoutDashboard },
  { label: 'فيديوهاتي',         href: '/instructor-lectures',         icon: Video           },
  { label: 'محفظتي',            href: '/instructor-wallet',           icon: Wallet          },
  { label: 'طلبات الفيديو',     href: '/instructor-video-requests',   icon: GitPullRequest  },
  { label: 'تسجيل وطلبات الطلاب', href: '/instructor-students',       icon: Users           },
  { label: 'الدعم',             href: '/support',                     icon: Headphones      },
];

export default function InstructorHeader({ instructorName = 'Instructor', walletBalance }: InstructorHeaderProps) {
  const navigate   = useNavigate();
  const location   = useLocation();
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('instructor_sidebar_collapsed');
    if (saved !== null) setIsCollapsed(saved === 'true');
  }, []);

  useEffect(() => {
    // Set sidebar width on mount
    document.documentElement.style.setProperty(
      '--sidebar-width',
      isCollapsed ? '72px' : '256px'
    );
    localStorage.setItem('instructor_sidebar_collapsed', String(isCollapsed));

    // Reset sidebar width on unmount so pages without sidebar work correctly
    return () => {
      document.documentElement.style.setProperty('--sidebar-width', '0px');
    };
  }, [isCollapsed]);

  const handleLogout = () => {
    // Canonical session teardown (supervisor/026): clearAuthToken removes
    // authToken/currentUser/currentStudent and notifies same-document
    // subscribers after the complete local mutation.
    clearAuthToken();
    navigate('/auth');
  };

  const initials = instructorName
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();

  return (
    <aside
      className={cn(
        "fixed top-0 right-0 h-screen bg-gradient-to-b from-indigo-700 via-purple-700 to-indigo-800 shadow-2xl z-50 flex flex-col transition-all duration-300 ease-in-out",
        isCollapsed ? "w-[72px]" : "w-64"
      )}
    >
      {/* Logo & Brand */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-white/10 shrink-0">
        <div className="w-10 h-10 rounded-xl overflow-hidden bg-white/20 shrink-0 flex items-center justify-center">
          <img src={tabwebAcademyLogo} alt="Tabweb Academy" className="w-10 h-10 object-contain" />
        </div>
        {!isCollapsed && (
          <div className="min-w-0">
            <h1 className="text-white font-bold text-sm truncate">منصة المدرسين</h1>
            <p className="text-indigo-200 text-[10px] truncate">{instructorName}</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.2) transparent' }}>
        {navItems.map(item => {
          const Icon = item.icon;
          const active = location.pathname === item.href;
          return (
            <Link
              key={item.href}
              to={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200",
                active
                  ? "bg-white/20 text-white font-semibold shadow-md"
                  : "text-white/70 hover:bg-white/10 hover:text-white"
              )}
            >
              <Icon className={cn("w-[18px] h-[18px] shrink-0", active && "text-white")} />
              {!isCollapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Wallet badge */}
      {walletBalance !== undefined && !isCollapsed && (
        <div className="mx-2 mb-2 bg-white/10 rounded-xl px-3 py-2 flex items-center gap-2 text-white text-sm">
          <Wallet className="w-4 h-4 shrink-0" />
          <span className="font-semibold">{Number(walletBalance).toFixed(2)} ج.م</span>
        </div>
      )}

      {/* Bottom Actions */}
      <div className="border-t border-white/10 px-2 py-3 space-y-1 shrink-0">
        {/* User info */}
        {!isCollapsed && (
          <div className="flex items-center gap-2 px-3 py-2 mb-1">
            <Avatar className="w-8 h-8 bg-white/20">
              <AvatarFallback className="bg-white/20 text-white text-xs">{initials}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium text-white truncate">{instructorName}</span>
          </div>
        )}
        <Button
          onClick={handleLogout}
          variant="ghost"
          className={cn(
            "w-full text-white/70 hover:bg-red-500/20 hover:text-red-300 rounded-xl transition-all",
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
        className="absolute top-4 left-[-12px] w-6 h-6 bg-white rounded-full shadow-lg flex items-center justify-center hover:bg-gray-100 transition-colors z-50"
      >
        <ChevronLeft className={cn("w-3 h-3 text-indigo-700 transition-transform", isCollapsed && "rotate-180")} />
      </button>
    </aside>
  );
}
