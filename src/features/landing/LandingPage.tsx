import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  BookOpen,
  Users,
  CalendarDays,
  Check,
  ArrowUpLeft,
  Menu,
  X,
  Play,
  Layers,
  ChartNoAxesCombined,
  MoveLeft,
  Mail,
  Phone,
  Mouse,
  Folder,
  CircleCheck,
  FilePenLine,
  Target,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FeatureDeck } from "./FeatureDeck";
import { MoreFeatures } from "./MoreFeatures";
import { ReferencePanel } from "./ReferencePanel";
import { ScrollCompanion } from "./ScrollCompanion";
import "./landing.css";
import { GatherIllustration } from "./GatherIllustration";
import { HeroIllustration } from "./HeroIllustration";
import "./hero-reference.css";
import "./reference-sections.css";
import "./mobile-landing.css";

const links = [
  ["المميزات", "#features"],
  ["كيف تعمل", "#how-it-works"],
  ["الباقات", "#plans"],
  ["أسئلة شائعة", "#faq"],
];
const faqs = [
  [
    "هل أقدر أستخدم اسم منصتي؟",
    "تبويب أكاديمي مبنية حول مساحة تعليمية خاصة بالمدرس. تواصل معنا لتحديد اسم منصتك وإعدادها وخيارات الهوية المتاحة قبل التفعيل.",
  ],
  [
    "هل أقدر أنظم أكتر من مجموعة؟",
    "تقدر ترتب طلابك داخل مجموعات، وتتابع جدول كل مجموعة وحضورها ومحتواها من نفس المساحة.",
  ],
  [
    "هل المنصة بتشتغل على الموبايل؟",
    "الواجهة متجاوبة مع الموبايل والتابلت والكمبيوتر، من غير الحاجة لتحميل تطبيق لزيارة المنصة.",
  ],
  [
    "إزاي أختار الباقة المناسبة؟",
    "ابدأ بحجم مجموعاتك ونوع محتواك واحتياجاتك. الأسعار والحدود النهائية قيد الاعتماد؛ تواصل معنا لتحديد الاختيار المناسب.",
  ],
  [
    "إزاي أبدأ؟",
    "حاليًا إنشاء منصة المدرس وتفعيل حسابه بيتم بالتنسيق مع إدارة تبويب أكاديمي. زر إنشاء الحساب يوضح لك طرق التواصل، ولو عندك حساب بالفعل تقدر تسجل دخولك مباشرة.",
  ],
];
const plans = [
  { name: "بداية", desc: "للبداية السريعة وإنشاء منصتك التعليمية بكل سهولة." },
  {
    name: "نمو",
    desc: "للمدرسين النشطين اللي بيدوروا على مزيد من المرونة والتطور.",
  },
  {
    name: "أكاديمية",
    desc: "للمدرسين اللي بيديروا عدة مجموعات، وبيدوروا على توسّع أكبر.",
  },
];

function Brand() {
  return (
    <span className="tw-brand">
      <span className="tw-brand-mark">
        <i />
        <i />
        <i />
        <b>⌣</b>
      </span>
      <span>
        تبويب أكاديمي<small>Tabweb Academy</small>
      </span>
    </span>
  );
}
function Dock() {
  return <div className="tw-dock" data-tab-dock />;
}
export function LandingPage() {
  const [menu, setMenu] = useState(false),
    [signup, setSignup] = useState(false),
    [sticky, setSticky] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.title;
    document.title = "تبويب أكاديمي | كل شغلك كمدرّس، في تبويب واحد";
    const hero = root.current?.querySelector(".tw-hero");
    const observer = new IntersectionObserver(
      ([entry]) => setSticky(!entry.isIntersecting),
      { threshold: 0 },
    );
    if (hero) observer.observe(hero);
    return () => {
      document.title = previous;
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [menu]);
  const openSignup = () => {
    setMenu(false);
    setSignup(true);
  };
  return (
    <div className="tw-landing" dir="rtl" ref={root}>
      <a href="#main-content" className="tw-skip">
        انتقل للمحتوى
      </a>
      <header className="tw-header">
        <div className="tw-nav tw-container">
          <a href="#top" aria-label="تبويب أكاديمي — الرئيسية">
            <Brand />
          </a>
          <nav className="tw-desktop-links" aria-label="التنقل الرئيسي">
            {links.map(([name, to]) => (
              <a href={to} key={to}>
                {name}
              </a>
            ))}
          </nav>
          <div className="tw-auth">
            <Link to="/auth" className="tw-button tw-button-outline">
              <span className="tw-desktop-label">تسجيل الدخول</span>
              <span className="tw-mobile-label">دخول</span>
            </Link>
            <button
              className="tw-button tw-button-primary"
              onClick={openSignup}
            >
              <span className="tw-desktop-label">أنشئ حسابك</span>
              <span className="tw-mobile-label">إنشاء حساب</span>
            </button>
            <button
              type="button"
              className="tw-menu-toggle"
              aria-label={menu ? "إغلاق القائمة" : "فتح القائمة"}
              aria-expanded={menu}
              aria-controls="tw-mobile-nav"
              onClick={() => setMenu((v) => !v)}
            >
              {menu ? <X /> : <Menu />}
            </button>
          </div>
        </div>
        {menu && (
          <nav
            className="tw-mobile-nav"
            id="tw-mobile-nav"
            aria-label="قائمة الموبايل"
          >
            {links.map(([name, to]) => (
              <a href={to} key={to} onClick={() => setMenu(false)}>
                {name}
                <ArrowUpLeft size={16} />
              </a>
            ))}
          </nav>
        )}
      </header>
      <main id="main-content">
        <section className="tw-hero tw-container" id="top">
          <div className="tw-hero-copy">
            <span className="tw-kicker">
              <i /> مساحة تعليمية تخصّك
            </span>
            <h1>
              كل شغلك كمدرّس.
              <br />
              <span>في تبويب واحد.</span>
            </h1>
            <p>منصتك باسمك، ودروسك وطلابك تحت عينك.</p>
            <div className="tw-actions">
              <button
                className="tw-button tw-button-primary"
                onClick={openSignup}
              >
                شوف منصتك
              </button>
              <a className="tw-button tw-button-outline" href="#platform">
                اكتشف الرحلة
              </a>
            </div>
            <span className="tw-hero-note">
              دروسك · مجموعاتك · متابعتك. بنفس طريقتك.
            </span>
          </div>
          <HeroIllustration />
          <a className="tw-scroll-hint" href="#together">
            <Mouse size={19} /> خلّينا نرتّب الحكاية <MoveLeft size={16} />
          </a>
        </section>
        <section className="tw-together" id="together">
          <svg className="tw-together-backdrop" viewBox="0 0 1200 250" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="together-wash" x2="1" y2="1">
                <stop stopColor="#e5f4ff" />
                <stop offset="1" stopColor="#d8edff" />
              </linearGradient>
            </defs>
            <path d="M48 28H810C834 28 824 2 852 2H1030C1057 2 1044 28 1074 28H1152Q1198 28 1198 76V208Q1198 248 1152 248H48Q2 248 2 208V76Q2 28 48 28Z" fill="url(#together-wash)" stroke="#bad7f7" strokeWidth="2" />
            <g fill="#a7c7ee"><circle cx="963" cy="22" r="7"/><circle cx="988" cy="22" r="7"/><circle cx="1013" cy="22" r="7"/></g>
          </svg>
          <div className="tw-container tw-together-inner">
            <div>
              <span className="tw-section-label">
                شغلك كتير. التنقّل مش لازم يكون كتير.
              </span>
              <h2>
                بدل ما يومك يتوزّع…
                <br />
                <span>اجمعه بطريقتك.</span>
              </h2>
            </div>
            <GatherIllustration />
          </div>
        </section>
        <section className="tw-platform" id="platform">
          <svg className="tw-platform-edge" viewBox="0 0 1200 20" preserveAspectRatio="none" aria-hidden="true"><path d="M0 8Q260 0 600 6T1200 12V20H0Z" fill="white" /></svg>
          <div className="tw-container">
            <div className="tw-section-heading">
              <span className="tw-section-label">اسمك هو اللي في الصورة</span>
              <h2>
                دي منصتك.
                <br />
                مش مجرد صفحة ليك.
              </h2>
              <p>
                مساحتك التعليمية الكاملة باسمك وهويتك،
                <br />
                تجمع دروسك وطلابك وإدارتك في مكان واحد.
              </p>
            </div>
            <div className="tw-academy-seated"><ReferencePanel kind="academy" /><img src="/landing/tab-seated-v3.png" alt="" aria-hidden="true" /></div>
          </div>
        </section>
        <section id="features" className="tw-features tw-container">
          <svg
            className="tw-feature-cable"
            viewBox="0 0 100 900"
            preserveAspectRatio="none"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M50 0 C0 60 70 100 50 150 S10 235 50 300 S90 400 50 450 S0 530 50 600 S90 700 50 750 S0 840 50 900"
              stroke="#1555ff"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
            {[150, 450, 750].map((y) => (
              <circle
                key={y}
                cx="50"
                cy={y}
                r="5"
                fill="white"
                stroke="#1555ff"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <div className="tw-feature-heading">
            <span className="tw-section-label">كل جزء في شغلك، له مكان</span>
            <h2>أدواتك مترتبة. عشان أفكارك تاخد راحتها.</h2>
          </div>
          <article className="tw-story">
            <div className="tw-story-copy">
              <span className="tw-icon-box">
                <BookOpen />
              </span>
              <h2>حضّر مرة. ودرّس بطريقتك.</h2>
              <p>
                أنشئ دروسك، ونظّم محتواك مرة واحدة. وقدّمها لطلابك بأسلوبك
                الخاص.
              </p>
              <ul>
                <li>
                  <Folder />
                  دروس منظمة وواضحة
                </li>
                <li>
                  <Play />
                  دعم الفيديو والملفات
                </li>
                <li>
                  <Layers />
                  بناء منهجك بالكامل
                </li>
              </ul>
            </div>
            <ReferencePanel kind="lesson" />
            <Dock />
          </article>
          <article className="tw-story tw-story-reverse">
            <div className="tw-story-copy">
              <span className="tw-icon-box">
                <Users />
              </span>
              <h2>كل مجموعة، ماشية على نظامك.</h2>
              <p>
                نظّم طلابك في مجموعات، وحدّد جدول كل مجموعة. وتابع الحضور بكل
                سهولة.
              </p>
              <ul>
                <li>
                  <Users />
                  إدارة مرنة للمجموعات
                </li>
                <li>
                  <CalendarDays />
                  جدول أسبوعي واضح
                </li>
                <li>
                  <CircleCheck />
                  متابعة حضور دقيقة
                </li>
              </ul>
            </div>
            <ReferencePanel kind="schedule" />
            <Dock />
          </article>
          <article className="tw-story">
            <div className="tw-story-copy">
              <span className="tw-icon-box">
                <ChartNoAxesCombined />
              </span>
              <h2>اعرف مين فاهم، ومين محتاجك.</h2>
              <p>
                تابع نتائج الاختبارات، وقيّم واجبات الطلاب. وحدّد بسرعة مين
                يحتاج لدعم إضافي.
              </p>
              <ul>
                <li>
                  <FilePenLine />
                  ملاحظات وتقييم على الواجبات
                </li>
                <li>
                  <ChartNoAxesCombined />
                  تقارير أداء واضحة
                </li>
                <li>
                  <Target />
                  تحديد سريع لنقاط الدعم
                </li>
              </ul>
            </div>
            <ReferencePanel kind="results" />
            <Dock />
          </article>
        </section>
        <FeatureDeck />
        <MoreFeatures />
        <section id="how-it-works" className="tw-setup">
          <div className="tw-container">
            <div className="tw-section-heading">
              <span className="tw-section-label">
                خطوة جديدة، مش تعقيد جديد
              </span>
              <h2>من فكرتك، لأول درس.</h2>
              <p>نبدأ معاك بإعداد منصتك، وإنت تكمّلها بطريقتك.</p>
            </div>
            <div className="tw-steps">
              {[
                {
                  title: "إنشاء منصتك",
                  text: "نتفق على احتياجاتك ونجهّز مساحة باسمك.",
                  icon: Layers,
                },
                {
                  title: "ترتيب محتواك",
                  text: "أضف دروسك ونظّم وحداتك ومجموعاتك.",
                  icon: BookOpen,
                },
                {
                  title: "دعوة طلابك",
                  text: "شارك مساحة التعلّم مع طلابك، وابدأ.",
                  icon: Users,
                },
              ].map(({ title, text, icon: Icon }, i) => (
                <article key={title}>
                  <span className="tw-step-number">{i + 1}</span>
                  <Icon size={30} />
                  <h3>{title}</h3>
                  <p>{text}</p>
                </article>
              ))}
            </div>
            <svg
              className="tw-plane-route"
              viewBox="0 0 240 145"
              aria-hidden="true"
              fill="none"
            >
              <path
                d="M8 125 C105 145 70 25 145 33 S185 15 220 4"
                stroke="#135bff"
                strokeWidth="1.5"
                strokeDasharray="7 6"
              />
              <path
                d="M10 60 C0 60 0 44 11 43 C9 22 39 21 43 38 C60 30 67 47 58 58 Z M19 130 C10 130 9 118 18 116 C18 103 39 100 44 113 C59 108 66 126 54 130 Z"
                fill="white"
                stroke="#5686d4"
                strokeWidth="1.2"
              />
            </svg>
            <Dock />
          </div>
        </section>
        <section id="plans" className="tw-plans tw-container">
          <div className="tw-section-heading">
            <span className="tw-section-label">على قدّ مرحلتك</span>
            <h2>
              ابدأ على قدّك.
              <br />
              وكبّر لما تكبر.
            </h2>
            <p>الأسعار والحدود قيد الاعتماد.</p>
          </div>
          <div className="tw-plan-grid">
            {plans.map((plan, i) => (
              <article
                className={`tw-plan ${i === 1 ? "tw-plan-featured" : ""}`}
                key={plan.name}
              >
                {i === 1 && (
                  <span className="tw-plan-badge">لخطوتك التالية</span>
                )}
                <h3>{plan.name}</h3>
                <div className="tw-price">—</div>
                <p>{plan.desc}</p>

                <button
                  className={`tw-button ${i === 1 ? "tw-button-primary" : "tw-button-outline"}`}
                  onClick={openSignup}
                >
                  {i === 2 ? "تواصل معنا" : "اختر الباقة"}
                </button>
              </article>
            ))}
          </div>
        </section>
        <section id="faq" className="tw-faq tw-container">
          <div>
            <span className="tw-section-label">نوضّحها قبل ما تبدأ</span>
            <h2>أسئلة قبل أول خطوة.</h2>
            <p>
              ولو في بالك حاجة تانية،
              <br />
              <button className="tw-text-button" onClick={openSignup}>
                خلّينا نتكلم <ArrowUpLeft size={17} />
              </button>
            </p>
          </div>
          <div className="tw-faq-list">
            {faqs.map(([q, a]) => (
              <details key={q}>
                <summary>
                  {q}
                  <span>+</span>
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="tw-final">
          <div className="tw-container">
            <span className="tw-section-label">شغلك يستاهل مساحة تخصّه</span>
            <h2>افتح تبويب جديد لشغلك.</h2>
            <button className="tw-button tw-button-white" onClick={openSignup}>
              ابدأ منصتك
            </button>
            <p>
              عندك حساب؟ <Link to="/auth">تسجيل الدخول</Link>
            </p>
            <img className="tw-final-peek" src="/landing/tab-peek-edge-v1.png" alt="" aria-hidden="true" />
            <span className="tw-final-outline" aria-hidden="true" />
          </div>
        </section>
      </main>
      <footer className="tw-footer tw-container">
        <a href="#top">
          <Brand />
        </a>
        <nav aria-label="روابط الفوتر">
          {links.map(([name, to]) => (
            <a href={to} key={to}>
              {name}
            </a>
          ))}
          <button onClick={openSignup}>تواصل معنا</button>
        </nav>
        <span>© {new Date().getFullYear()} تبويب أكاديمي</span>
      </footer>
      {sticky && (
        <div className="tw-sticky-signup">
          <span>خطوتك الجاية، في تبويب أكاديمي.</span>
          <button className="tw-button tw-button-primary" onClick={openSignup}>
            أنشئ حسابك <ArrowUpLeft size={16} />
          </button>
        </div>
      )}
      <ScrollCompanion />
      <Dialog open={signup} onOpenChange={setSignup}>
        <DialogContent dir="rtl" className="tw-signup-dialog">
          <DialogHeader>
            <DialogTitle>نبدأ منصتك مع بعض.</DialogTitle>
            <DialogDescription>
              إنشاء حساب المدرس وتفعيل منصته حاليًا بيتم بالتنسيق مع إدارة تبويب
              أكاديمي. تواصل معنا باحتياجاتك، ونوضح لك الإعداد والباقات المتاحة
              قبل أي اشتراك.
            </DialogDescription>
          </DialogHeader>
          <a
            href="mailto:med96ramadan1996@gmail.com?subject=طلب%20إنشاء%20منصة%20على%20تبويب%20أكاديمي"
            className="tw-contact-option"
          >
            <Mail />
            <span>
              راسل فريق تبويب أكاديمي
              <small dir="ltr">med96ramadan1996@gmail.com</small>
            </span>
            <ArrowUpLeft />
          </a>
          <a href="tel:+201034067686" className="tw-contact-option">
            <Phone />
            <span>
              اتصل بنا<small dir="ltr">01034067686</small>
            </span>
            <ArrowUpLeft />
          </a>
          <p className="tw-dialog-note">
            التواصل يفتح تطبيق البريد أو الاتصال عندك؛ لا يتم إرسال طلب
            تلقائيًا.
          </p>
          <Link to="/auth" className="tw-button tw-button-outline">
            عندك حساب بالفعل؟ تسجيل الدخول
          </Link>
        </DialogContent>
      </Dialog>
    </div>
  );
}
