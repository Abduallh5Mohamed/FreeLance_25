import { useId, type ReactNode } from "react";
const labels = {
    academy: "معاينة توضيحية لأكاديمية أستاذ أحمد على الكمبيوتر والموبايل",
    lesson: "درس المشتقات في الدوال ومنهج المادة",
    schedule: "جدول المجموعة والحضور اليومي",
    results: "نتائج الاختبار والواجبات",
};
type Kind = keyof typeof labels;
function Text({ x, y, children, size = 12, bold = false, fill = "#102956", center = false }: {
    x: number;
    y: number;
    children: ReactNode;
    size?: number;
    bold?: boolean;
    fill?: string;
    center?: boolean;
}) {
    return <text x={x} y={y} textAnchor={center ? "middle" : "start"} direction="rtl" fontSize={size} fontWeight={bold ? 800 : 500} fill={fill}>{children}</text>;
}
function Panel({ x, y, w, h }: {
    x: number;
    y: number;
    w: number;
    h: number;
}) {
    return <><rect x={x} y={y} width={w} height={h} rx="11" fill="white" stroke="#7da8e2"/><rect x={x + 5} y={y + 5} width={w - 10} height={h - 10} rx="8" fill="#f4f9ff" stroke="#d3e5fc"/></>;
}
function Check({ x, y, muted = false }: {
    x: number;
    y: number;
    muted?: boolean;
}) {
    return <g><circle cx={x} cy={y} r="6" fill={muted ? "#939dab" : "#20ac64"}/><path d={`m${x - 3} ${y} 2 2 4-4`} fill="none" stroke="white" strokeWidth="1.5"/></g>;
}
function Player({ x, y, w, h, graph = false }: {
    x: number;
    y: number;
    w: number;
    h: number;
    graph?: boolean;
}) {
    return <g><rect x={x} y={y} width={w} height={h} rx="6" fill="#18396b"/>
    <path d={`M${x} ${y + h}V${y}H${x + w * .65}Z`} fill="#315d9e" opacity=".65"/>
    {graph ? <g transform={`translate(${x + w * .18} ${y + h * .13}) scale(${w / 280} ${h / 150})`}><path d="M0 100H190M65 110V0" stroke="white" strokeWidth="2" fill="none"/><path d="m186 96 5 4-5 4M61 5l4-5 4 5" stroke="white" fill="none"/><path d="M8 72C25 58 31 99 55 76S90 51 110 61S150 60 158 35S177 10 190 11" fill="none" stroke="#ffe21f" strokeWidth="2.5"/></g> : <path d={`m${x + w / 2 - 8} ${y + h / 2 - 12} 22 13-22 13Z`} fill="white"/>}
    <path d={`m${x + 12} ${y + h - 13} 7 4-7 4Z`} fill="white"/><path d={`M${x + 29} ${y + h - 9}H${x + w - 63}`} stroke="#859ebf" strokeWidth="3"/><path d={`M${x + 29} ${y + h - 9}H${x + w * .43}`} stroke="white" strokeWidth="3"/><circle cx={x + w * .43} cy={y + h - 9} r="3" fill="white"/><text x={x + w - 6} y={y + h - 6} textAnchor="end" fontSize="7" fill="white">0:00 / 18:24</text>
  </g>;
}
function Academy({ id }: {
    id: string;
}) {
    return <>
  <defs><linearGradient id={id} x2="1" y2="1"><stop stopColor="#8dc9ff"/><stop offset="1" stopColor="#e8f5ff"/></linearGradient></defs>
  <ellipse cx="325" cy="274" rx="305" ry="9" fill="#95c4fa" opacity=".4"/>
  <path d="M91 22Q91 9 105 9H277Q290 9 297 0H350Q361 0 369 10H617Q636 10 636 28V253Q636 267 621 267H105Q91 267 91 252Z" fill="#2873df" stroke="white" strokeWidth="2"/>
  <rect x="94" y="38" width="540" height="226" rx="9" fill="white" stroke="#a3ccfc" strokeWidth="3"/>
  {[112, 130, 148].map(x => <circle key={x} cx={x} cy="25" r="4" fill="white"/>)}
  <Text x={601} y={61} size={15} bold>أكاديمية أستاذ أحمد</Text><path d="m607 50 13-5 13 5-13 6Zm6 5v7q7 5 14 0v-7" fill="#153e7c"/>
  <circle cx="191" cy="56" r="7" fill="#deedff"/><circle cx="191" cy="53" r="3" fill="#3383ed"/><path d="M186 61q5-8 10 0" fill="#3383ed"/>
  <path d="M160 53q0-7 5-7t5 7v5h-10Z" stroke="#4587dc" fill="none"/><circle cx="170" cy="47" r="3" fill="#f76c72"/>
  <path d="M103 72H625M103 105H625" stroke="#d2e4fa"/>
  {['الرئيسية', 'الدروس', 'المجموعات', 'الواجبات', 'الاختبارات'].map((v, i) => <g key={v}>{i === 0 && <rect x="548" y="78" width="76" height="21" rx="5" fill="#0757eb"/>}<Text x={585 - i * 88} y={93} size={11} center fill={i === 0 ? 'white' : '#143566'} bold>{v}</Text></g>)}
  <rect x="108" y="112" width="515" height="141" rx="8" fill={`url(#${id})`}/>
  <path d="M108 112H270Q324 149 247 193T339 253H108Z" fill="#86c2fa" opacity=".65"/><path d="M623 112Q494 137 535 203T623 253" fill="#6fb1f4" opacity=".48"/>
  <Text x={555} y={151} size={20} bold>مرحبًا بكم في</Text><Text x={555} y={178} size={25} bold>أكاديمية أستاذ أحمد</Text><Text x={554} y={201} size={12}>منصتي التعليمية لدروس الرياضيات</Text>
  <rect x="452" y="215" width="98" height="24" rx="7" fill="#095be5"/><Text x={501} y={231} size={12} center fill="white" bold>ابدأ التعلم</Text>
  {[62, 101, 78, 54, 35].map((h, i) => <g key={i}><rect x={137 + i * 24} y={250 - h} width="20" height={h} fill={i === 2 ? '#ffdf37' : '#2978dd'}/><path d={`M${140 + i * 24} ${251 - h}v${h - 3}`} stroke="#78b8ff" strokeWidth="4"/></g>)}
  <g transform="translate(18 43) rotate(3 70 118)"><rect width="135" height="239" rx="22" fill="white" stroke="#172942" strokeWidth="3"/><rect x="5" y="5" width="125" height="229" rx="18" fill="#f4f9ff" stroke="#adcef3"/>
   {[20, 28, 36].map(x => <circle key={x} cx={x} cy="16" r="2" fill="#1254be"/>)}<Text x={110} y={37} size={12} bold>دروسي</Text><Player x={12} y={48} w={111} h={62}/>
   {['المعادلات الخطية', 'جميع الدروس', 'المتغيرات', 'المعادلات', 'التطبيقات'].map((v, i) => <g key={v}><path d={`M12 ${117 + i * 22}H123`} stroke="#d1e2f6"/><Text x={105} y={132 + i * 22} size={9} bold>{v}</Text><circle cx="115" cy={128 + i * 22} r="5" fill="#2c82f2"/><path d={`m114 ${125 + i * 22} 4 3-4 3Z`} fill="white"/></g>)}
  </g>
 </>;
}
function Lesson() { return <><Panel x={2} y={2} w={516} h={170}/><Text x={265} y={26} size={12} bold>الدرس: المشتقات في الدوال</Text><Player x={17} y={38} w={272} h={119} graph/><path d="M302 12V163" stroke="#c5dcf6"/><Text x={498} y={24} bold>منهج المادة</Text><Text x={492} y={45} size={11} bold>الوحدة الأولى: الدوال</Text>{['مقدمة في الدوال', 'المشتقات في الدوال', 'تطبيقات على الدوال'].map((v, i) => <g key={v}>{i === 1 && <rect x="313" y={54 + i * 24} width="190" height="23" rx="4" fill="#dbeaff"/>}<Text x={480} y={69 + i * 24} size={11}>{v}</Text>{i === 0 ? <Check x={493} y={65}/> : <circle cx="493" cy={65 + i * 24} r="5" fill={i === 1 ? '#247ff3' : 'white'} stroke="#83a1c8"/>}</g>)}<Text x={490} y={148} size={11} bold>الوحدة الثانية: التكامل</Text></>; }
function Schedule() {
    return <><Panel x={2} y={2} w={516} h={160}/><Text x={350} y={23} size={11} bold>جدول المجموعة (الثالث الثانوي - مجموعة أ)</Text><Text x={503} y={23} size={11} bold>الحضور - حصة اليوم</Text>
 {['الأربعاء', 'الثلاثاء', 'الإثنين', 'الأحد', 'السبت'].map((v, i) => <g key={v}><rect x={15 + i * 68} y="38" width="66" height="25" fill="#e2f0ff"/><Text x={48 + i * 68} y={54} size={10} center bold>{v}</Text><rect x={15 + i * 68} y="66" width="66" height="78" fill={i === 2 ? '#fff0af' : i === 1 || i === 3 ? '#d7eaff' : 'white'} stroke="#d0e1f6"/>{i > 0 && i < 4 ? <><Text x={48 + i * 68} y={90} size={10} bold center>{['', 'تطبيقات', 'مراجعة', 'رياضيات'][i]}</Text><text x={48 + i * 68} y="109" fontSize="9" textAnchor="middle" fill="#153765">{i === 1 ? '10:00–11:30' : i === 2 ? '4:00–5:00' : '10:00–11:30'}</text></> : <text x={48 + i * 68} y="103" textAnchor="middle" fill="#92aac8">—</text>}</g>)}
 {['أحمد خالد', 'سارة محمد', 'عمر علي', 'لوجين نبيل'].map((v, i) => <g key={v}><rect x="365" y={38 + i * 27} width="140" height="24" rx="4" fill={i % 2 ? '#eaf3ff' : 'white'}/><Text x={481} y={54 + i * 27} size={10}>{v}</Text><circle cx="494" cy={48 + i * 27} r="7" fill="#d1e7ff"/><circle cx="494" cy={46 + i * 27} r="3" fill="#327ce0"/><path d={`M489 ${54 + i * 27}q5-9 10 0`} fill="#327ce0"/><Check x={377} y={50 + i * 27} muted={i === 3}/></g>)}
 </>;
}
function Results({ id }: {
    id: string;
}) {
    return <><defs><linearGradient id={id} x2="0" y2="1"><stop stopColor="#8ac7ff"/><stop offset="1" stopColor="#1467ef"/></linearGradient></defs><Panel x={2} y={2} w={516} h={150}/><Text x={230} y={25} size={12} bold>نتائج الاختبار</Text><Text x={495} y={25} size={12} bold>الواجبات</Text>
 {[23, 42, 64, 87].map((h, i) => <g key={i}><rect x={24 + i * 55} y={115 - h} width="31" height={h} rx="3" fill={`url(#${id})`}/><Text x={39 + i * 55} y={132} size={8} center>{['يحتاج دعم', 'جيد', 'جيد جدًا', 'ممتاز'][i]}</Text></g>)}
 {['واجب (1): تطبيقات على الدوال', 'واجب (2): المشتقات', 'واجب (3): مسائل متنوعة'].map((v, i) => <g key={v}><rect x="265" y={38 + i * 33} width="239" height="28" rx="5" fill="white"/><Text x={496} y={55 + i * 33} size={9} bold>{v}</Text><rect x="272" y={42 + i * 33} width="62" height="20" rx="6" fill={i === 2 ? '#ffed9d' : '#d7f2e0'}/><Text x={303} y={56 + i * 33} size={9} center fill={i === 2 ? '#8a650c' : '#168449'}>{i === 2 ? 'بانتظار التقييم' : 'مُقيّم ✓'}</Text></g>)}
 </>;
}
/** Vector illustrations, never screenshots of a section or interactive app controls. */
export function ReferencePanel({ kind }: {
    kind: Kind;
}) {
    const id = useId().replace(/:/g, '');
    return <svg className={`tw-reference-panel tw-reference-panel-${kind}`} viewBox={kind === 'academy' ? '0 0 650 288' : kind === 'lesson' ? '0 0 520 174' : kind === 'schedule' ? '0 0 520 164' : '0 0 520 154'} role="img" aria-label={`مثال توضيحي: ${labels[kind]}`} direction="ltr" fontFamily="Tajawal, sans-serif">
 {kind === 'academy' ? <Academy id={id}/> : kind === 'lesson' ? <Lesson /> : kind === 'schedule' ? <Schedule /> : <Results id={id}/>}
 </svg>;
}
