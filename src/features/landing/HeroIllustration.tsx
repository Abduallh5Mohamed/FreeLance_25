import {
  CalendarDays,
  Users,
  Play,
  House,
  Check,
  UserRound,
} from "lucide-react";

/** The hero is an illustration, not a second interactive application. */
export function HeroIllustration() {
  return (
    <div
      className="tw-reference-art"
      aria-label="معاينة توضيحية: جدول ودروس وحضور الطلاب في منصة واحدة"
      role="img"
    >
      <div className="tw-reference-cloud" />
      <svg
        className="tw-reference-wires"
        viewBox="0 0 550 270"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden="true"
      >
        <g stroke="#1354ef" strokeWidth="1.4" strokeLinecap="round">
          <path
            pathLength="1"
            d="M114 38 C151 53 120 18 127 32 C132 49 172 25 165 57 S158 84 181 91"
          />
          <path
            pathLength="1"
            d="M94 117 C134 134 107 99 110 111 C115 131 136 103 142 93 S166 84 180 100"
          />
          <path
            pathLength="1"
            d="M108 172 C139 186 118 150 135 148 S161 170 178 148"
          />
          <path
            pathLength="1"
            d="M96 238 C136 262 105 220 111 234 C117 256 137 230 150 232 S184 231 201 240"
          />
        </g>
      </svg>
      {["جدول منفصل", "قائمة طلاب", "واجبات", "فيديوهات الدروس"].map(
        (label, i) => (
          <div key={label} className={`tw-reference-card card-${i}`}>
            <div className="tw-reference-card-top">
              <i />
              <i />
              <i />
            </div>
            <strong>{label}</strong>
            {i === 0 ? (
              <div className="tw-tiny-calendar">
                {Array.from({ length: 15 }, (_, n) => (
                  <i key={n} />
                ))}
              </div>
            ) : i === 3 ? (
              <div className="tw-tiny-video">
                <Play fill="currentColor" />
                <span />
                <span />
              </div>
            ) : (
              <div className="tw-tiny-list">
                {[0, 1, 2].map((n) => (
                  <span key={n}>
                    {i === 1 ? <UserRound /> : <i />}
                    <b />
                  </span>
                ))}
              </div>
            )}
          </div>
        ),
      )}
      <div className="tw-reference-window">
        <div className="tw-reference-chrome">
          <i />
          <i />
          <i />
        </div>
        <div className="tw-reference-tabs">
          {[
            [House, "الصفحة الرئيسية"],
            [Play, "الدروس"],
            [Users, "الطلاب"],
            [CalendarDays, "الجدول"],
          ].map(([Icon, label]) => {
            const TabIcon = Icon as typeof House;
            return (
              <span key={String(label)}>
                <TabIcon />
                {String(label)}
              </span>
            );
          })}
        </div>
        <div className="tw-reference-panels">
          <div className="tw-reference-attendance">
            <h3>الحضور اليومي</h3>
            {["أحمد خالد", "سارة محمد", "عمر علي", "لوجين نبيل"].map(
              (name, i) => (
                <div key={name}>
                  <UserRound />
                  <span>{name}</span>
                  <b className={i === 2 ? "absent" : ""}>
                    <Check />
                  </b>
                </div>
              ),
            )}
          </div>
          <div className="tw-reference-lesson">
            <h3>الدرس: المتغيرات والمعادلات</h3>
            <div className="tw-reference-player">
              <Play fill="white" />
              <div className="tw-reference-controls">
                <Play fill="white" />
                <span>
                  <i />
                </span>
                <small>0:00 / 18:34</small>
              </div>
            </div>
            <div className="tw-reference-lesson-footer">
              <span>ملخص الدرس</span>
              <span>الملفات</span>
              <span>الواجب</span>
            </div>
          </div>
          <div className="tw-reference-schedule">
            <h3>الجدول</h3>
            <b>الأسبوع الحالي ‹</b>
            <div className="tw-reference-week">
              <span>الأحد</span>
              <span>الإثنين</span>
              <span>السبت</span>
              {[
                "14",
                "الأحد",
                "15",
                "9",
                "الإثنين",
                "16",
                "8",
                "الثلاثاء",
                "16",
              ].map((v, i) => (
                <span className={i === 2 ? "highlight" : ""} key={i}>
                  {v}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <svg
        className="tw-reference-tail"
        viewBox="0 0 550 270"
        preserveAspectRatio="none"
        fill="none"
        aria-hidden="true"
      >
        <path
          data-hero-cable
          d="M245 230 C273 228 345 242 400 246"
          stroke="#1354ef"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
      <div className="tw-dock tw-reference-character" data-tab-dock />
      <svg
        className="tw-reference-spark"
        viewBox="0 0 70 55"
        aria-hidden="true"
      >
        <path
          d="M15 35 12 12 M32 32 39 8 M45 40 61 25"
          stroke="#ffd420"
          strokeWidth="7"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
}
