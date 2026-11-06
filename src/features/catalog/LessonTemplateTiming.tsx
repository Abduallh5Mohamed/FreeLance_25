import { cairoLabel, timingLabel, type TimingChoice, type TimingReview } from './lesson-template-timing';

export function LessonTemplateTiming({ value, onChange, review, disabled }: {
  value: TimingChoice;
  onChange: (next: TimingChoice) => void;
  review: TimingReview | null;
  disabled: boolean;
}) {
  const setMode = (mode: TimingChoice['mode']) => onChange({ mode, release_at: mode === 'set' ? value.release_at ?? '' : null });
  return <fieldset disabled={disabled} aria-label="توقيت إتاحة الحصة الوجهة" className="space-y-2 rounded border p-2">
    <legend className="px-1 font-semibold">توقيت الإتاحة لهذه الحصة فقط</legend>
    <p>الحالي: {timingLabel(review?.current_release_at ?? null)}</p>
    <label className="flex gap-2"><input type="radio" checked={value.mode === 'keep'} onChange={() => setMode('keep')} />الإبقاء على التوقيت الحالي</label>
    <label className="flex gap-2"><input type="radio" checked={value.mode === 'set'} onChange={() => setMode('set')} />تعيين وقت UTC صريح</label>
    {value.mode === 'set' ? <div className="space-y-1 ps-6">
      <input aria-label="وقت الإتاحة UTC" value={value.release_at ?? ''} disabled={disabled}
        onChange={event => onChange({ mode: 'set', release_at: event.target.value })}
        placeholder="2026-11-10T18:00:00Z" className="block w-full rounded border p-2" />
      <p>القاهرة: {cairoLabel(value.release_at ?? null) ?? 'صيغة غير صحيحة — اكتب وقت UTC ينتهي بـ Z'}</p>
    </div> : null}
    <label className="flex gap-2"><input type="radio" checked={value.mode === 'clear'} onChange={() => setMode('clear')} />مسح الجدولة (null = بلا توقيت)</label>
    {review ? <p role="status">المقترح: {timingLabel(review.proposed_release_at)}</p> : null}
  </fieldset>;
}
