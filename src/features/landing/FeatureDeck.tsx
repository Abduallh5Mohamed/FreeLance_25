import { useEffect, useRef, useState } from "react";
import { BookOpen, FileCheck2, Users } from "lucide-react";
import { ReferencePanel } from "./ReferencePanel";
import "./feature-deck.css";

const slides = [
  { title: "حضّر دروسك", detail: "رتّب وحداتك ودروسك وملفاتك في مسار واضح لطلابك.", icon: BookOpen, kind: "lesson" as const },
  { title: "قيّم الفهم", detail: "راجع نتائج الاختبارات والواجبات، وحدّد مين محتاج دعمك.", icon: FileCheck2, kind: "results" as const },
  { title: "تابع طلابك", detail: "جدول المجموعات والحضور اليومي، في نفس المساحة.", icon: Users, kind: "schedule" as const },
];

export function FeatureDeck() {
  const root = useRef<HTMLElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const section = root.current;
    if (!section) return;
    const media = matchMedia("(prefers-reduced-motion: reduce), (max-height: 620px)");
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (media.matches) { cards.current.forEach(card => card?.removeAttribute("aria-hidden")); return; }
      const rect = section.getBoundingClientRect();
      const distance = Math.max(1, rect.height - innerHeight);
      const progress = Math.max(0, Math.min(1, (64 - rect.top) / distance));
      // Two turns separated by stable reading intervals; reverse scroll retraces them.
      const turns = [Math.max(0, Math.min(1, (progress - .2) / .2)), Math.max(0, Math.min(1, (progress - .6) / .2))];
      const current = turns[1] >= .5 ? 2 : turns[0] >= .5 ? 1 : 0;
      setActive(previous => previous === current ? previous : current);
      cards.current.forEach((card, i) => {
        if (!card) return;
        const incoming = i === 0 ? 1 : turns[i - 1];
        const outgoing = i === 2 ? 0 : turns[i];
        const angle = incoming < 1 ? 180 * (1 - incoming) : -180 * outgoing;
        card.style.transform = `rotateY(${angle}deg)`;
        card.style.visibility = i === current ? "visible" : "hidden";
        card.setAttribute("aria-hidden", String(i !== current));
      });
      section.style.setProperty("--deck-progress", String(progress));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    const preference = () => { setReduced(media.matches); schedule(); };
    preference();
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    media.addEventListener("change", preference);
    const observer = new ResizeObserver(schedule); observer.observe(section);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); removeEventListener("scroll", schedule); removeEventListener("resize", schedule); media.removeEventListener("change", preference); };
  }, []);
  const goTo = (index: number) => {
    const section = root.current;
    if (!section) return;
    if (reduced) { document.getElementById(`tw-deck-card-${index}`)?.scrollIntoView({ block: "center" }); return; }
    const progress = [0, .5, 1][index];
    scrollTo({ top: scrollY + section.getBoundingClientRect().top - 64 + progress * (section.offsetHeight - innerHeight), behavior: "smooth" });
  };
  return <section ref={root} className="tw-feature-deck" aria-labelledby="tw-deck-title" data-reduced={reduced}>
    <div className="tw-deck-pin">
      <div className="tw-deck-copy">
        <h2 id="tw-deck-title">كل خطوة في يومك، <br/><span>لها تبويب.</span></h2>
        <p>من إعداد الدرس، لتقييم الفهم ومتابعة الطلاب. أدوات يومك متجمّعة، وكل خطوة واضحة.</p>
        <div className="tw-deck-nav" aria-label="مراحل يوم المدرس">
          {slides.map((slide, i) => <button type="button" key={slide.title} onClick={() => goTo(i)} aria-current={!reduced && active === i ? "step" : undefined}><slide.icon size={21}/><span>{slide.title}</span><b aria-hidden="true">{i + 1}</b></button>)}
        </div>
        <small>{reduced ? "استكشف أدوات يومك" : "كمّل السكرول لاستكشاف كل تبويب"}</small>
      </div>
      <div className="tw-deck-stage">
        <img className="tw-deck-mascot" src="/landing/tab-seated-v3.png" alt="" aria-hidden="true" />
        <div className="tw-deck-stack" aria-hidden="true" />
        {slides.map((slide, i) => <div key={slide.kind} id={`tw-deck-card-${i}`} className="tw-deck-card" ref={el => { cards.current[i] = el; }}>
          <div className="tw-deck-chrome"><i/><i/><i/><span>{slide.title}</span></div>
          <div className="tw-deck-content"><ReferencePanel kind={slide.kind}/><h3>{slide.title}</h3><p>{slide.detail}</p><small>معاينة توضيحية</small></div>
        </div>)}
      </div>
    </div>
  </section>;
}
