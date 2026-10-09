import { Link } from "react-router-dom";
import { ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { defaultRouteFor, type AccessProfile } from "@/auth/access-control";

export default function Forbidden() {
  let user: AccessProfile | null = null;
  try {
    user = JSON.parse(localStorage.getItem("currentUser") ?? "null");
  } catch {
    user = null;
  }

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6" dir="rtl">
      <section className="w-full max-w-lg rounded-2xl border bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <ShieldX className="h-7 w-7" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">ليس لديك صلاحية لفتح هذه الصفحة</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          إذا كنت تتوقع أن تكون هذه العملية متاحة لك، تواصل مع إدارة المنصة لمراجعة صلاحيات حسابك.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link to={defaultRouteFor(user)}>العودة إلى الصفحة الرئيسية</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/auth">تسجيل الدخول بحساب آخر</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
