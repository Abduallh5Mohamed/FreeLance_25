import { useId, useRef, useState, type PointerEvent } from "react";
import { Check, RotateCcw, SlidersHorizontal } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import "./understanding-lab.css";

const answers = [
  { label: "أ: منحنى متزايد", path: "M10 65 Q60 60 100 12", explanation: "قيمة الدالة تزيد كلما تحرّكنا يمينًا." },
  { label: "ب: منحنى متناقص", path: "M10 12 Q40 60 100 65", explanation: "ده منحنى متناقص: قيمته بتقل كلما تحرّكنا يمينًا. جرّب تاني." },
  { label: "ج: دالة ثابتة", path: "M10 40 H100", explanation: "هنا القيمة ثابتة؛ مش بتزيد مع الحركة يمينًا. جرّب تاني." },
];

export function UnderstandingLab() {
  const [power, setPower] = useState(1.8);
  const [answer, setAnswer] = useState<number | null>(null);
  const [explored, setExplored] = useState(false);
  const [dragging, setDragging] = useState(false);
  const graph = useRef<SVGSVGElement>(null);
  const range = useRef<HTMLInputElement>(null);
  const firstAnswer = useRef<HTMLButtonElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const patternId = useId();
  const reduced = useReducedMotion();
  const step = answer !== null ? 2 : explored ? 1 : 0;
  const pointY = 260 - 210 * Math.pow(.5, power);
  const path = Array.from({ length: 61 }, (_, i) => {
    const t = i / 60;
    return `${i ? "L" : "M"}${45 + 280 * t},${260 - 210 * Math.pow(t, power)}`;
  }).join(" ");
  const changePower = (value: number) => { setPower(Math.max(.5, Math.min(3, value))); setExplored(true); };
  const drag = (event: PointerEvent<SVGCircleElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const svg = graph.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const fraction = Math.max(.125, Math.min(Math.SQRT1_2, (260 - point.y) / 210));
    changePower(Math.log(fraction) / Math.log(.5));
  };
  const reset = () => { setPower(1.8); setAnswer(null); setExplored(false); range.current?.focus(); };
  return <section className="tw-lab" aria-labelledby="tw-lab-heading">
    <header className="tw-lab-heading"><h2 id="tw-lab-heading">جرّب الفكرة. اختار إجابتك. <span>افهم السبب.</span></h2><p>تجربة صغيرة، توريك الفرق.</p></header>
    <div className="tw-lab-shell">
      <img src="/landing/tab-seated-v3.png" className="tw-lab-mascot" alt="" aria-hidden="true" />
      <nav className="tw-lab-progress" aria-label="خطوات التجربة">
        {["استكشف", "اختار", "افهم"].map((label, i) => <button key={label} type="button" aria-current={step === i ? "step" : undefined} disabled={i === 2 && answer === null} onClick={() => { if (i === 0) range.current?.focus(); else if (i === 1) firstAnswer.current?.focus(); else feedback.current?.focus(); }}><b>{i + 1}</b>{label}</button>)}
      </nav>
      <div className="tw-lab-body">
        <div className="tw-lab-graph">
          <svg ref={graph} viewBox="0 0 370 310" aria-label="منحنى متزايد يمكن تغيير انحنائه باستخدام شريط التحكم أسفله">
            <defs><pattern id={patternId} width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#bdd7ff"/></pattern></defs>
            <rect x="35" y="20" width="300" height="255" fill={`url(#${patternId})`}/>
            <path d="M45 30 V275 H340 M40 38 L45 30 L50 38 M332 270 L340 275 L332 280" fill="none" stroke="#13356c" strokeWidth="2"/>
            <text x="28" y="25" fill="#13356c">ص</text><text x="346" y="280" fill="#13356c">س</text>
            <path d={path} fill="none" stroke="#0755ef" strokeWidth="4" strokeLinecap="round"/>
            <g aria-hidden="true"><rect x="135" y={pointY - 59} width="100" height="30" rx="12" fill="#fff0ac"/><text x="185" y={pointY - 39} textAnchor="middle" fill="#14336b" fontSize="12">{dragging ? "لاحظ المنحنى" : "اسحب النقطة"}</text></g>
            <circle cx="185" cy={pointY} r="23" fill="transparent" className="tw-lab-handle" aria-hidden="true" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }} onPointerMove={drag} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false); }} onLostPointerCapture={() => setDragging(false)} />
            <circle cx="185" cy={pointY} r="11" fill="#ffd622" stroke="#efb900" strokeWidth="2" pointerEvents="none"/>
          </svg>
          <label className="tw-lab-slider"><SlidersHorizontal size={18}/><span>غيّر شكل المنحنى</span><input ref={range} type="range" min="0.5" max="3" step="0.01" value={power} onChange={e => changePower(Number(e.target.value))} aria-label="غيّر شكل المنحنى" aria-valuetext={`درجة الانحناء ${power.toFixed(2)}، المنحنى متزايد`} /></label>
          <p className="tw-lab-hint">الشكل بيتغيّر، لكن القيمة لسه بتزيد وإنت رايح يمين.</p>
        </div>
        <div className="tw-lab-question">
          <h3 id="tw-lab-question">أي رسم يعبّر عن دالة متزايدة؟</h3>
          <div className="tw-lab-answers" role="group" aria-labelledby="tw-lab-question">
            {answers.map((option, i) => <motion.button layout={!reduced} key={option.label} ref={i === 0 ? firstAnswer : undefined} type="button" aria-label={option.label} aria-pressed={answer === i} className={answer === i ? "is-selected" : ""} onClick={() => setAnswer(i)} onTap={() => setAnswer(i)}>
              <svg viewBox="0 0 110 80" aria-hidden="true"><path d="M10 8 V70 H105" fill="none" stroke="#bed4f3"/><path d={option.path} fill="none" stroke="#0755ef" strokeWidth="3"/></svg><span aria-hidden="true">{["أ", "ب", "ج"][i]}</span>{answer === i && <motion.i layoutId={reduced ? undefined : "tw-lab-choice"}><Check size={16}/></motion.i>}
            </motion.button>)}
          </div>
          <div className="tw-lab-feedback-slot" aria-live="polite" aria-atomic="true">
            {answer === null ? <p className="tw-lab-empty">اختار إجابة وشوف تفسيرها هنا.</p> : <motion.div ref={feedback} tabIndex={-1} key={answer} className="tw-lab-feedback" initial={reduced ? false : { opacity: 0, y: -12, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .3 }}>
              <div><strong>{answer === 0 ? "إجابة صحيحة" : "خلّينا نفكّر فيها"}</strong><p>{answers[answer].explanation}</p></div>
              <svg viewBox="0 0 110 80" aria-hidden="true"><path d="M10 8 V70 H105" fill="none" stroke="#bed4f3"/><path d={answers[answer].path} fill="none" stroke="#0755ef" strokeWidth="3"/></svg>
            </motion.div>}
          </div>
        </div>
        <footer className="tw-lab-footer"><span>تجربة توضيحية — إجابتك لا تُحفظ</span><button type="button" onClick={reset}><RotateCcw size={18}/>جرّب تاني</button></footer>
      </div>
    </div>
  </section>;
}
