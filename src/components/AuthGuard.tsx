import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { canAccessRoute, type LegacyRole } from "@/auth/access-control";
import { AUTH_SESSION_CHANGED_EVENT, verifyCurrentSession, type SessionVerification } from "@/lib/api-http";

interface AuthGuardProps {
  children: React.ReactNode;
  requiredRole?: LegacyRole;
}

export const AuthGuard = ({ children }: AuthGuardProps) => {
  const location = useLocation();
  const [revision, setRevision] = useState(0);
  const [verification, setVerification] = useState<SessionVerification | null>(null);
  const [verifiedPath, setVerifiedPath] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => { setVerification(null); setRevision(value => value + 1); };
    const storage = (event: StorageEvent) => {
      if (event.key === 'authToken' || event.key === null) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', storage);
    };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    setVerification(null);
    void verifyCurrentSession(controller.signal).then(result => {
      if (!active) return;
      if (result.state === 'changed') {
        setRevision(value => value + 1);
        return;
      }
      setVerifiedPath(location.pathname);
      setVerification(result);
    });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [location.pathname, revision]);

  if (!verification || verifiedPath !== location.pathname) return <RouteLoading />;
  if (verification.state === 'anonymous') {
    return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  }
  if (verification.state !== 'authenticated') {
    return <main dir="rtl" className="min-h-screen flex flex-col items-center justify-center gap-4" role="alert">
      <p>تعذّر التحقق من الجلسة الآن. حاول مرة أخرى.</p>
      <button type="button" className="rounded border px-4 py-2" onClick={() => setRevision(value => value + 1)}>إعادة المحاولة</button>
    </main>;
  }
  if (localStorage.getItem('authToken') !== verification.token) return <RouteLoading />;
  const user = verification.user;
  if ((user.role === 'admin' || user.admin_member) && ['/teacher', '/instructor'].includes(location.pathname)) {
    return <Navigate to="/admin" replace />;
  }
  if (!canAccessRoute(user, location.pathname)) {
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
