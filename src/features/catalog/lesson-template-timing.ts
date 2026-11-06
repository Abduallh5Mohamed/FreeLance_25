export type TimingMode = 'keep' | 'set' | 'clear';

export interface TimingChoice {
  mode: TimingMode;
  release_at: string | null;
}

export interface TimingReview {
  mode: TimingMode;
  current_release_at: string | null;
  proposed_release_at: string | null;
}

const RELEASE_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/** Parse an explicit UTC ISO instant (or null for the clear mode). */
export function parseTimingInstant(raw: string | null | undefined): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return null;
  const match = RELEASE_ISO_PATTERN.exec(raw);
  if (!match) return undefined;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]),
    match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0')));
  const check = new Date(utc);
  if (check.getUTCFullYear() !== Number(match[1]) || check.getUTCMonth() !== Number(match[2]) - 1 || check.getUTCDate() !== Number(match[3])) return undefined;
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || utc < 1000 || utc > 2147483647999) return undefined;
  return new Date(Math.floor(utc / 1000) * 1000).toISOString();
}

/** Validate the exact timing object sent to the server. */
export function canonicalTiming(mode: TimingMode, instant: string | null | undefined): TimingChoice {
  if (mode === 'keep') return { mode: 'keep', release_at: null };
  if (mode === 'clear') return { mode: 'clear', release_at: null };
  if (mode !== 'set') throw Error('Invalid timing mode');
  const parsed = parseTimingInstant(instant);
  if (parsed === undefined || parsed === null) throw Error('Invalid timing instant');
  return { mode: 'set', release_at: parsed };
}

/** Display-only Cairo label. The canonical value stays the UTC instant. */
export function cairoLabel(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
}

export const timingLabel = (iso: string | null): string => {
  if (iso === null) return 'بلا جدولة (متاحة حسب حالة الحصة)';
  return `${iso} UTC (${cairoLabel(iso)} القاهرة)`;
};
