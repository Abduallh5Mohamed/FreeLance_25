import {
  BookOpen,
  Users,
  CalendarDays,
  Check,
  Play,
  FileCheck2,
  LayoutDashboard,
  ChevronLeft,
} from "lucide-react";
import { useState, type ReactNode } from "react";

const tabs = [
  { name: "الرئيسية", icon: LayoutDashboard },
  { name: "الدروس", icon: BookOpen },
  { name: "الطلاب", icon: Users },
  { name: "الجدول", icon: CalendarDays },
];
export function BrowserFrame({
  children,
  title,
  className = "",
}: {
  children: ReactNode;
  title: string;
  className?: string;
}) {
  return (
    <div className={`tw-browser ${className}`}>
      <div className="tw-browser-bar">
        <span className="tw-traffic">
          <i />
          <i />
          <i />
        </span>
        <span>{title}</span>
        <span>▢</span>
      </div>
      {children}
    </div>
  );
}
export function LessonPreview() {
  return (
    <div className="tw-lesson">
      <div className="tw-video">
        <span>رياضيات • الصف الثالث الثانوي</span>
        <div className="tw-equation" dir="ltr">
          f(x) = x² + 2x
        </div>
        <Play size={31} fill="currentColor" />
        <div className="tw-video-progress">
          <i />
        </div>
        <small>معاينة توضيحية للدرس</small>
      </div>
      <div className="tw-curriculum">
        <strong>المشتقات في دقائق</strong>
        {["الفكرة ببساطة", "نحلّها مع بعض", "جرّب بنفسك"].map((v, i) => (
          <div key={v} className={i === 0 ? "selected" : ""}>
            <span>{i + 1}</span>
            {v}
            <Check size={13} />
          </div>
        ))}
      </div>
    </div>
  );
}
export function SchedulePreview() {
  return (
    <div className="tw-schedule">
      <div className="tw-panel-title">
        <strong>أسبوعك، قدامك</strong>
        <span>الأسبوع الحالي</span>
      </div>
      <div className="tw-calendar">
        {["الأحد", "الإثنين", "الثلاثاء"].map((day, i) => (
          <div key={day}>
            <header>
              {day}
              <b>{14 + i}</b>
            </header>
            <div className={`tw-event event-${i}`}>
              <small>{["09:00", "11:00", "10:00"][i]}</small>
              <strong>
                {["مجموعة الأساسيات", "مراجعة الوحدة", "حلّ الواجب"][i]}
              </strong>
              <span>{["درس جديد", "مراجعة وتطبيق", "متابعة المجموعة"][i]}</span>
            </div>
            <div className="tw-calendar-empty" />
          </div>
        ))}
      </div>
      <div className="tw-attendance">
        <span>
          <i /> حضور المجموعة
        </span>
        <b>
          أحمد علي <Check size={14} />
        </b>
        <b>
          سارة محمد <Check size={14} />
        </b>
      </div>
    </div>
  );
}
export function ResultsPreview() {
  return (
    <div className="tw-results">
      <div className="tw-panel-title">
        <strong>الصورة أوضح، لكل طالب</strong>
        <FileCheck2 size={21} />
      </div>
      <div className="tw-result-grid">
        <div className="tw-bars" aria-label="رسم توضيحي لتقدم الطلاب">
          {[35, 54, 42, 79, 66, 91].map((h, i) => (
            <i key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
        <div>
          <strong>واجب الوحدة الأولى</strong>
          {[
            ["أحمد علي", "تم التسليم"],
            ["سارة محمد", "تم التسليم"],
            ["عمر خالد", "بانتظار التسليم"],
          ].map(([name, status]) => (
            <div className="tw-student-row" key={name}>
              <span>{name}</span>
              <small className={status === "تم التسليم" ? "done" : ""}>
                {status}
              </small>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
export function DashboardPreview() {
  const [active, setActive] = useState(0);
  return (
    <BrowserFrame title="منصتك التعليمية" className="tw-dashboard">
      <div className="tw-preview-brand">
        <span className="tw-mini-logo">ت</span>
        <b>أكاديمية أستاذ أحمد</b>
        <span>مثال توضيحي</span>
      </div>
      <div
        className="tw-preview-tabs"
        role="tablist"
        aria-label="استكشف معاينة المنصة"
      >
        {tabs.map(({ name, icon: Icon }, i) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`preview-tab-${i}`}
            aria-controls="preview-panel"
            aria-selected={active === i}
            tabIndex={active === i ? 0 : -1}
            onKeyDown={(event) => {
              let next = i;
              if (event.key === "ArrowLeft") next = (i + 1) % tabs.length;
              else if (event.key === "ArrowRight")
                next = (i + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              setActive(next);
              document.getElementById(`preview-tab-${next}`)?.focus();
            }}
            onClick={() => setActive(i)}
          >
            <Icon size={15} />
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="preview-panel"
        aria-labelledby={`preview-tab-${active}`}
        className="tw-dashboard-content"
      >
        {active === 0 ? (
          <>
            <div className="tw-dashboard-greeting">
              <span>صباح الخير، أستاذ أحمد ☀</span>
              <strong>مساحة لشغلك. ووقت لطلابك.</strong>
            </div>
            <div className="tw-hero-preview-grid">
              <ResultsPreview />
              <LessonPreview />
              <SchedulePreview />
            </div>
            <div className="tw-overview">
              <div>
                <BookOpen />
                <strong>دروسك</strong>
                <small>منظمة في مكان واحد</small>
              </div>
              <div>
                <Users />
                <strong>مجموعاتك</strong>
                <small>كل مجموعة بنظامها</small>
              </div>
              <div>
                <CalendarDays />
                <strong>يومك</strong>
                <small>خطوتك الجاية واضحة</small>
              </div>
            </div>
            <div className="tw-next-lesson">
              <span className="tw-play">
                <Play size={17} fill="currentColor" />
              </span>
              <div>
                <strong>الدرس القادم: المشتقات</strong>
                <small>مجموعة الصف الثالث الثانوي</small>
              </div>
              <ChevronLeft size={18} />
            </div>
          </>
        ) : active === 1 ? (
          <LessonPreview />
        ) : active === 2 ? (
          <ResultsPreview />
        ) : (
          <SchedulePreview />
        )}
      </div>
    </BrowserFrame>
  );
}
