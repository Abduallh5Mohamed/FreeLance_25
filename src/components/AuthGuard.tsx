import { useMemo } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { canAccessRoute, type AccessProfile, type LegacyRole } from "@/auth/access-control";

interface AuthGuardProps {
  children: React.ReactNode;
  requiredRole?: LegacyRole;
}

function readStoredUser(): { user: AccessProfile | null; invalid: boolean } {
  const raw = localStorage.getItem("currentUser");
  if (!raw) return { user: null, invalid: false };

  try {
    return { user: JSON.parse(raw) as AccessProfile, invalid: false };
  } catch {
    return { user: null, invalid: true };
  }
}

export const AuthGuard = ({ children }: AuthGuardProps) => {
  const location = useLocation();
  const stored = useMemo(() => readStoredUser(), []);
  const hasToken = Boolean(localStorage.getItem("authToken"));

  if (stored.invalid) {
    localStorage.removeItem("currentUser");
  }

  if (!stored.user || !hasToken) {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }

  if ((stored.user.role === "admin" || stored.user.admin_member) && (location.pathname === "/teacher" || location.pathname === "/instructor")) {
    return <Navigate to="/admin" replace />;
  }

  if (!canAccessRoute(stored.user, location.pathname)) {
    return <Navigate to="/forbidden" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
};

export function RouteLoading() {
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center" dir="rtl" aria-live="polite">
      <div className="flex items-center gap-3 rounded-xl border bg-white px-5 py-4 text-slate-700 shadow-sm">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <span>جارٍ تجهيز الصفحة...</span>
      </div>
    </main>
  );
}

export default AuthGuard;
