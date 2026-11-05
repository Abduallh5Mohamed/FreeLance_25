import { useEffect, useRef } from "react";
import {
  CalendarDays,
  Users,
  Play,
  List,
  GraduationCap,
  UserRound,
} from "lucide-react";

export function GatherIllustration() {
  const art = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = art.current;
    if (!root) return;
    const svg = root.querySelector<SVGSVGElement>(".tw-gather-wires")!;
    const cards = Array.from(root.querySelectorAll<HTMLElement>(".tw-gather-card"));
    const platform = root.querySelector<HTMLElement>(".tw-gather-platform")!;
    const measure = () => {
      const box = root.getBoundingClientRect(), target = platform.getBoundingClientRect();
      svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
      const endX = target.left - box.left + 3;
      cards.forEach((card, i) => {
        const b = card.getBoundingClientRect();
        const x = b.left + b.width / 2 - box.left, y = b.bottom - box.top - 1;
        const endY = target.top - box.top + target.height * (i === 2 ? .24 : .8);
        const bendY = Math.max(y + 20, endY - 12);
        svg.querySelectorAll("path")[i].setAttribute("d", `M${x} ${y} C${x} ${bendY} ${x + 12} ${bendY} ${x + 40} ${bendY} H${endX - 25} Q${endX} ${bendY} ${endX} ${endY}`);
      });
    };
    const observer = new ResizeObserver(measure);
    [root, platform, ...cards].forEach(el => observer.observe(el));
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="tw-gather-art"
      ref={art}
      role="img"
      aria-label="جدول الحصص والطلاب والواجبات تتجمع في منصة المعلم"
    >
      <svg
        viewBox="0 0 800 250"
        className="tw-gather-wires"
        fill="none"
        aria-hidden="true"
      >
        <g stroke="#1655ec" strokeWidth="2.2" strokeLinecap="round">
          <path d="M69 132 C69 190 100 190 160 190 H430 Q464 190 464 218" />
          <path d="M220 132 C220 180 245 190 300 190 H430 Q464 190 464 218" />
          <path d="M371 132 C371 174 416 174 430 150 Q440 140 440 110 Q440 80 464 80" />
        </g>
      </svg>
      <div className="tw-gather-cards">
        <div className="tw-gather-card">
          <strong>جدول الحصص</strong>
          <div className="tw-gather-calendar">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
        </div>
        <div className="tw-gather-card">
          <strong>الطلاب</strong>
          <div className="tw-gather-list">
            {[0, 1, 2, 3].map((i) => (
              <span key={i}>
                <UserRound />
                <b />
                <i />
              </span>
            ))}
          </div>
        </div>
        <div className="tw-gather-card">
          <strong>الواجبات</strong>
          <div className="tw-gather-list">
            {[0, 1, 2, 3].map((i) => (
              <span key={i}>
                <em>{i === 1 ? "✓" : ""}</em>
                <b />
                <i />
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="tw-gather-platform">
        <div className="tw-gather-chrome">
          <i />
          <i />
          <i />
        </div>
        <div className="tw-gather-body">
          <strong>
            <GraduationCap /> منصة المعلم
          </strong>
          <div className="tw-gather-skeleton">
            <i />
            <i />
            <i />
          </div>
          <div className="tw-gather-tools">
            <CalendarDays />
            <Users />
            <Play fill="currentColor" />
            <List />
          </div>
          <div className="tw-gather-skeleton">
            <i />
            <i />
          </div>
        </div>
      </div>
      <svg className="tw-gather-rays" viewBox="0 0 60 50" aria-hidden="true">
        <path
          d="m10 30-3-18m20 16 7-20m5 29 16-12"
          fill="none"
          stroke="#ffd322"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
