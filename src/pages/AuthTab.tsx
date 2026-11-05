import { useRef, useEffect, useState } from 'react';

/** High-resolution character poses with bounded pupil tracking in the open-eye state. */
export function AuthTab({ target, pose }: { target: { x: number; y: number } | null; pose: 'watch' | 'covered' | 'peek' }) {
  const ref = useRef<SVGSVGElement>(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!target || !ref.current) { setLook({x:0,y:0}); return; }
    const box=ref.current.getBoundingClientRect();
    const dx=target.x-(box.left+box.width*.5),dy=target.y-(box.top+box.height*.5);
    const length=Math.max(1,Math.hypot(dx,dy));
    setLook({x:dx/length*2.4,y:dy/length*2.4});
  },[target]);
  const watch=pose==='watch';
  const offset = watch ? 0 : pose === 'covered' ? 724 : 1448;
  return <svg ref={ref} className="auth-tab" data-pose={pose} viewBox="0 0 724 670" aria-hidden="true">
    <defs><clipPath id="tab-hd-cell"><rect width="724" height="670"/></clipPath>
      <clipPath id="tab-hd-eyes"><ellipse cx="292" cy="389" rx="51" ry="62"/><ellipse cx="489" cy="360" rx="46" ry="57"/></clipPath>
    </defs>
    <g clipPath="url(#tab-hd-cell)"><image href="/auth/tab-hd-states.png" x={-offset} width="2172" height="724"/></g>
    {watch && target && <g clipPath="url(#tab-hd-eyes)">
      <rect x="230" y="290" width="320" height="175" fill="#fff"/>
      <g className="auth-tab-pupils" style={{transform:`translate(${look.x*3}px,${look.y*3}px)`}} fill="#082958">
        <ellipse cx="294" cy="389" rx="39" ry="49"/><ellipse cx="488" cy="362" rx="37" ry="47"/>
        <circle cx="279" cy="366" r="11" fill="white"/><circle cx="475" cy="341" r="10" fill="white"/>
      </g>
    </g>}
  </svg>;
}
