import { AcademyBrand } from "@/components/AcademyBrand";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Eye, EyeOff, Users, UserRound, Phone, LockKeyhole } from "lucide-react";
import { AUTH_SESSION_CHANGED_EVENT, signIn } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import "./academy-auth.css";
import { AuthTab } from "./AuthTab";

const Auth = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [role, setRole] = useState<"student" | "teacher">("teacher");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [field, setField] = useState("");
  const [target, setTarget] = useState<{x: number; y: number} | null>(null);
  const followCaret = (input: HTMLInputElement) => {
    const style = getComputedStyle(input);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = style.font;
    const prefix = input.value.slice(0, input.selectionStart ?? input.value.length);
    const width = context.measureText(prefix).width + (parseFloat(style.letterSpacing) || 0) * prefix.length;
    const box = input.getBoundingClientRect();
    setTarget({ x: Math.min(box.right - 12, Math.max(box.left + 12, box.left + parseFloat(style.paddingLeft) + width - input.scrollLeft)), y: box.top + box.height / 2 });
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recoveryHelp, setRecoveryHelp] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const mountedRef = useRef(true);
  const authBusyRef = useRef(false);
  const navigationTimerRef = useRef<number | null>(null);
  const sessionEpochRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;

    const clearPendingNavigation = () => {
      if (navigationTimerRef.current === null) return;
      window.clearTimeout(navigationTimerRef.current);
      navigationTimerRef.current = null;
      authBusyRef.current = false;
      if (mountedRef.current) setLoading(false);
    };

    const handleSessionChange = () => {
      sessionEpochRef.current += 1;
      clearPendingNavigation();
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === 'authToken' || event.key === 'currentUser') {
        handleSessionChange();
      }
    };

    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, handleSessionChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      mountedRef.current = false;
      clearPendingNavigation();
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, handleSessionChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);


  // A pending role redirect is valid only while the login it belongs to is
  // still the current session. Unmount, logout or a newer login cancels it.
  const goToRoleHome = (path: string, token: string) => {
    if (navigationTimerRef.current !== null) {
      window.clearTimeout(navigationTimerRef.current);
    }
    const scheduledEpoch = sessionEpochRef.current;
    navigationTimerRef.current = window.setTimeout(() => {
      navigationTimerRef.current = null;
      if (!mountedRef.current) return;
      const sessionIsCurrent = sessionEpochRef.current === scheduledEpoch
        && localStorage.getItem('authToken') === token;
      if (!sessionIsCurrent) {
        authBusyRef.current = false;
        setLoading(false);
        return;
      }
      navigate(path);
    }, 300);
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (authBusyRef.current) return;
    authBusyRef.current = true;
    setLoading(true);
    setError("");

    try {

      // Phone-based login
      const result = await signIn(phone.trim(), password);
      if (!mountedRef.current) return;

      if (result.error) {
        throw new Error(result.error);
      }

      if (result.user && result.token) {
          // Never write or navigate for a session replaced while in flight.
          if (localStorage.getItem('authToken') !== result.token) {
            throw new Error("تغيّرت الجلسة أثناء تسجيل الدخول. أعد المحاولة.");
          }
          // Redirect based on role
          if (result.user.role === 'admin' || result.user.admin_member) {
            toast({ title: "تم تسجيل الدخول بنجاح", description: `مرحباً بك ${result.user.name}` });
            goToRoleHome("/admin", result.token);
          } else if (result.user.role === 'teacher') {
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${result.user.name}`,
            });
            {
              goToRoleHome("/teacher", result.token);
            }
          } else if (result.user.role === 'instructor') {
            // Instructor login - unified dashboard (same teaching dashboard as
            // the admin, but scoped to the instructor's own data)
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${result.user.name}`,
            });
            {
              goToRoleHome(result.user.billing_only ? "/instructor-subscription" : "/teacher", result.token);
            }
          } else if (result.user.role === 'staff') {
            // Accounts without legacy page grants use the scoped center-work portal.
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${result.user.name}`,
            });
            {
              goToRoleHome(result.user.accessible_pages?.length ? "/teacher" : "/center-work", result.token);
            }
          } else {
            localStorage.removeItem('currentStudent');
            localStorage.removeItem('currentStudentSpace');
            toast({ title: "تم تسجيل الدخول بنجاح", description: `مرحباً بك ${result.user.name}` });
            goToRoleHome('/student-spaces', result.token);
          }
          return;
        }

        throw new Error("رقم الهاتف أو كلمة المرور غير صحيحة");
    } catch (error) {
      if (!mountedRef.current) return;
      const errorMessage = error instanceof Error ? error.message :  "حدث خطأ غير متوقع";
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: errorMessage,
      });
    } finally {
      // Keep the form locked until the scheduled redirect runs or is cancelled.
      if (navigationTimerRef.current === null) {
        authBusyRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  };

  const covering = field === "password" || (visible && password.length > 0);

  return (
    <main className="academy-auth" dir="rtl">
      <header className="academy-auth-header">
        <Link className="academy-auth-home" to="/"><ArrowLeft size={17} /> العودة للرئيسية</Link>
        <span className="academy-auth-header-line" aria-hidden="true" />
        <div className="academy-auth-brand"><AcademyBrand /></div>
      </header>
      <div className="academy-auth-body">
        <svg className="academy-auth-contour" viewBox="0 0 1526 830" preserveAspectRatio="none" aria-hidden="true">
          <path d="M940 150 C956 104 981 72 1024 72 L1075 72 C1116 72 1119 108 1160 108 L1452 108 Q1525 108 1525 180" />
          <g><circle cx="1018" cy="99" r="7"/><circle cx="1043" cy="99" r="7"/><circle cx="1068" cy="99" r="7"/></g>
        </svg>
        <aside className="academy-auth-studio">
          <svg className="academy-auth-reference-art" viewBox="30 134 940 830" aria-hidden="true">
            <defs><filter id="auth-text-feather"><feGaussianBlur stdDeviation="10"/></filter><mask id="auth-art-only" maskUnits="userSpaceOnUse" x="30" y="134" width="940" height="830">
              <rect x="30" y="134" width="940" height="830" fill="white"/>
              <rect x="270" y="175" width="665" height="190" fill="black" filter="url(#auth-text-feather)"/>
              <rect x="30" y="910" width="940" height="54" fill="black"/>
            </mask></defs>
            <image href="/auth/blueprint-approved-reference.png" width="1586" height="992" mask="url(#auth-art-only)" />
          </svg>
          <div className="academy-auth-studio-title"><h2>مساحتك للتعلّم.</h2><p>كل يوم، خطوة أبعد.</p></div>
          <div className="academy-auth-studio-footer"><span aria-hidden="true">•••••<br/>•••••</span><b lang="en">TABWEB ACADEMY</b><span> / مساحة واحدة لكل خطوة</span></div>
        </aside>
        <div className="academy-auth-form-area">
        <section className="academy-auth-card">
          <AuthTab target={target} pose={covering ? (visible ? "peek" : "covered") : "watch"} />
          <span className="academy-auth-rays" aria-hidden="true"><i/><i/><i/></span>
          <h1>{isLogin ? "أهلًا بيك من جديد" : "إنشاء حساب"}</h1>
          <p className="academy-auth-welcome">{isLogin ? "ادخل لحسابك وكمّل رحلتك" : "ابدأ رحلتك مع تبويب أكاديمي"}</p>
          <div className="academy-auth-switch" aria-label="نوع الحساب" role="group">
            <button type="button" aria-pressed={role === "teacher"} onClick={() => setRole("teacher")}><UserRound size={18} /> مدرّس</button>
            <button type="button" aria-pressed={role === "student"} onClick={() => setRole("student")}><Users size={20} /> طالب</button>
          </div>
          {isLogin ? (
            <form onSubmit={handleAuth}>
              <label htmlFor="academy-phone">رقم الهاتف</label>
              <div className="academy-auth-phone">
              <Phone size={20} aria-hidden="true" />
              <input id="academy-phone" placeholder="رقم الهاتف" type="tel" dir="ltr" autoComplete="username" required value={phone}
                onFocus={e => { setField("phone"); followCaret(e.currentTarget); }} onBlur={() => { setField(""); setTarget(null); }}
                onSelect={e => followCaret(e.currentTarget)} onKeyUp={e => followCaret(e.currentTarget)} onScroll={e => followCaret(e.currentTarget)}
                onChange={e => { setPhone(e.target.value); followCaret(e.currentTarget); }} />
              </div>
              <label htmlFor="academy-password">كلمة المرور</label>
              <div className="academy-auth-password">
                <LockKeyhole size={20} aria-hidden="true" />
                <input id="academy-password" placeholder="كلمة المرور" type={visible ? "text" : "password"} autoComplete="current-password" required value={password}
                  dir="ltr" onFocus={e => { setField("password"); followCaret(e.currentTarget); }} onSelect={e => followCaret(e.currentTarget)} onKeyUp={e => followCaret(e.currentTarget)} onBlur={() => setField("")} onChange={e => { setPassword(e.target.value); followCaret(e.currentTarget); }} />
                <button type="button" aria-label={visible ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} onClick={() => { setVisible(!visible); setField("password"); }}>
                  {visible ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
              <button className="academy-auth-recovery" type="button" aria-expanded={recoveryHelp} onClick={() => setRecoveryHelp(!recoveryHelp)}>نسيت كلمة المرور؟</button>
              {recoveryHelp && <p className="academy-auth-help" role="status">{role === "student" ? "تواصل مع مدرسك أو إدارة أكاديميتك لمساعدتك في استعادة الدخول." : "تواصل مع إدارة المنصة لمساعدتك في استعادة الدخول إلى حسابك."}</p>}
              {error && <p role="alert">{error}</p>}
              <button className="academy-auth-primary" disabled={loading}>{loading ? "جاري تسجيل الدخول…" : "تسجيل الدخول"}<ArrowLeft size={26} aria-hidden="true" /></button>
            </form>
          ) : (
            <div className="academy-auth-registration">
              <p>{role === "student" ? "افتح رابط الدعوة اللي أرسله لك مدرسك لإنشاء حساب الطالب." : "تواصل مع فريق تبويب أكاديمي لتجهيز منصتك وحساب المدرّس."}</p>
              {role === "teacher" && <Link className="academy-auth-primary" to="/#plans">اطّلع على الباقات</Link>}
            </div>
          )}
          <button type="button" className="academy-auth-mode" disabled={loading} onClick={() => { setIsLogin(!isLogin); setPassword(""); setVisible(false); setField(""); setError(""); }}>
            <span>{isLogin ? "ليس لديك حساب؟ " : "لديك حساب بالفعل؟ "}</span>{isLogin ? "إنشاء حساب" : "تسجيل الدخول"}
          </button>
        </section>
        </div>
      </div>
    </main>
  );
};

export default Auth;
