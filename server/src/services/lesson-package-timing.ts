/**
 * Explicit destination timing for one lesson when applying a saved template.
 *
 * Timing is NEVER inferred from a template. The owner states one of three
 * modes: keep the current release instant, set an explicit UTC instant, or
 * clear the schedule (null = released immediately under the existing lesson
 * release semantics). No timezone conversion is performed on input: a caller
 * must send an explicit UTC ISO-8601 instant with a `Z` designator.
 */
export const TIMING_MODES = ['keep', 'set', 'clear'] as const;
export type TimingMode = (typeof TIMING_MODES)[number];

export interface TimingInput {
  mode: TimingMode;
  /** Present only for `set`; a canonical UTC ISO string with `Z`. */
  release_at: string | null;
}

export interface TimingReview {
  mode: TimingMode;
  current_release_at: string | null;
  proposed_release_at: string | null;
}

const RELEASE_ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const TIMESTAMP_EPOCH_MIN = 1;
const TIMESTAMP_EPOCH_MAX = 2147483647;

const exact = (x: any, fields: string[]) =>
  x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === fields.slice().sort().join(',');

export function parseReleaseInstant(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = RELEASE_ISO_PATTERN.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const epoch = Math.floor(utc / 1000);
  if (!Number.isFinite(epoch) || epoch < TIMESTAMP_EPOCH_MIN || epoch > TIMESTAMP_EPOCH_MAX) return null;
  return epoch;
}

/** Render a stored epoch as canonical UTC ISO, `null` for no schedule, `undefined` if unreadable. */
export function renderReleaseInstant(epochSeconds: unknown): string | null | undefined {
  if (epochSeconds === null || epochSeconds === undefined) return null;
  const value = Number(epochSeconds);
  if (!Number.isInteger(value) || value < TIMESTAMP_EPOCH_MIN || value > TIMESTAMP_EPOCH_MAX) return undefined;
  const text = new Date(value * 1000).toISOString();
  return text;
}

export function parseTiming(raw: unknown): TimingInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { mode?: unknown; release_at?: unknown };
  if (!TIMING_MODES.includes(candidate.mode as TimingMode)) return null;
  const mode = candidate.mode as TimingMode;
  if (mode === 'keep') {
    if (!exact(raw, ['mode']) && !exact(raw, ['mode', 'release_at'])) return null;
    return candidate.release_at === undefined || candidate.release_at === null ? { mode: 'keep', release_at: null } : null;
  }
  if (!exact(raw, ['mode', 'release_at'])) return null;
  if (mode === 'clear') return candidate.release_at === null ? { mode: 'clear', release_at: null } : null;
  const epoch = parseReleaseInstant(candidate.release_at);
  return epoch === null ? null : { mode: 'set', release_at: new Date(epoch * 1000).toISOString() };
}

/** The effective release instant after the chosen timing mode. */
export function timingEpoch(timing: TimingInput, currentEpoch: number | null): number | null {
  if (timing.mode === 'keep') return currentEpoch;
  if (timing.mode === 'clear') return null;
  return parseReleaseInstant(timing.release_at);
}

export function timingReview(timing: TimingInput, currentEpoch: number | null): TimingReview {
  const proposed = timingEpoch(timing, currentEpoch);
  const current = renderReleaseInstant(currentEpoch);
  const proposedText = renderReleaseInstant(proposed);
  if (current === undefined || proposedText === undefined) throw Error('Unreadable release instant');
  return { mode: timing.mode, current_release_at: current, proposed_release_at: proposedText };
}

/**
 * A display-only Cairo label. This never participates in validation or storage;
 * the canonical value remains the UTC instant above.
 */
export function cairoDisplay(iso: string | null): string | null {
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
