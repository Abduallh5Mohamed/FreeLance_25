import { execute, queryOne } from '../db';

/**
 * Per-user notification channel preferences (M6 P3).
 *
 * Quiet defaults: only in-app delivery is on; email/whatsapp/sms stay off
 * until the owner explicitly opts in. Every delivery decision must go
 * through `canDeliver` / `isChannelEnabled` so an opt-out is honoured
 * server-side, never just hidden in the UI.
 *
 * Persistence contract: table notification_preferences is created by the
 * versioned migration 20260930_notification_preferences.sql (never at runtime).
 *
 * Rows are keyed by (user_id, user_type) with the user_type namespace
 * derived from the authenticated principal's role — never from client input —
 * mirroring server/src/routes/notifications.ts.
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'whatsapp', 'sms'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationPreferences {
  in_app: boolean;
  email: boolean;
  whatsapp: boolean;
  sms: boolean;
}

/** Quiet defaults: in-app on, everything else off. */
export const defaultPreferences = (): NotificationPreferences => ({
  in_app: true,
  email: false,
  whatsapp: false,
  sms: false,
});

export const isNotificationChannel = (value: unknown): value is NotificationChannel =>
  typeof value === 'string' &&
  (NOTIFICATION_CHANNELS as readonly string[]).includes(value);

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return fallback;
};

/** Merge a raw DB row over quiet defaults; unknown/missing columns stay denied. */
export const normalizePreferences = (row: Record<string, unknown> | null): NotificationPreferences => {
  const defaults = defaultPreferences();
  if (row === null) return defaults;
  return {
    in_app: toBoolean(row.in_app, defaults.in_app),
    email: toBoolean(row.email, defaults.email),
    whatsapp: toBoolean(row.whatsapp, defaults.whatsapp),
    sms: toBoolean(row.sms, defaults.sms),
  };
};

/** Deny-by-default single-channel check. Unknown channels deny. */
export const isChannelEnabled = (
  prefs: NotificationPreferences | null,
  channel: string,
): boolean => {
  if (!isNotificationChannel(channel)) return false;
  if (prefs === null) return defaultPreferences()[channel];
  return prefs[channel];
};

/**
 * Server-side delivery gate. A missing preference row means quiet defaults;
 * an explicit false (opt-out) always denies, even for otherwise eligible
 * recipients. Producers must call this before sending on any channel.
 */
export const canDeliver = (
  prefs: NotificationPreferences | null,
  channel: string,
): boolean => isChannelEnabled(prefs, channel);

export interface PreferencesParseOk {
  ok: true;
  value: Partial<NotificationPreferences>;
}

export interface PreferencesParseFail {
  ok: false;
  error: string;
}

export type PreferencesParseResult = PreferencesParseOk | PreferencesParseFail;

/**
 * Strict validation for PUT /preferences bodies. Each supplied channel must
 * be a real boolean (numbers/strings/arrays rejected so `0`/`"false"` can
 * never silently flip consent). Unknown fields rejected; empty bodies
 * rejected so a client cannot wipe consent by accident.
 */
export const parsePreferencesInput = (body: unknown): PreferencesParseResult => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Preferences body must be an object' };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) {
    return { ok: false, error: 'Provide at least one channel preference' };
  }
  const unknown = keys.filter((k) => !isNotificationChannel(k));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown preference channel: ${unknown[0]}` };
  }
  const value: Partial<NotificationPreferences> = {};
  for (const channel of NOTIFICATION_CHANNELS) {
    if (!(channel in record)) continue;
    const raw = record[channel];
    if (typeof raw !== 'boolean') {
      return { ok: false, error: `${channel} must be a boolean` };
    }
    value[channel] = raw;
  }
  return { ok: true, value };
};

/** Merge a validated partial update over stored prefs (owner-scoped merge). */
export const mergePreferences = (
  stored: NotificationPreferences,
  patch: Partial<NotificationPreferences>,
): NotificationPreferences => ({ ...stored, ...patch });

type QueryOneFn = typeof queryOne;
type ExecuteFn = typeof execute;

export const fetchPreferences = async (
  queryOneFn: QueryOneFn,
  userId: string,
  userType: string,
): Promise<NotificationPreferences | null> => {
  const row = await queryOneFn<Record<string, unknown>>(
    'SELECT in_app, email, whatsapp, sms FROM notification_preferences WHERE user_id = ? AND user_type = ?',
    [userId, userType],
  );
  return row ? normalizePreferences(row) : null;
};

export const savePreferences = async (
  executeFn: ExecuteFn,
  queryOneFn: QueryOneFn,
  userId: string,
  userType: string,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> => {
  const stored = await fetchPreferences(queryOneFn, userId, userType);
  const merged = mergePreferences(stored ?? defaultPreferences(), patch);
  const patchFlags = [
    patch.in_app === undefined ? 0 : 1,
    patch.email === undefined ? 0 : 1,
    patch.whatsapp === undefined ? 0 : 1,
    patch.sms === undefined ? 0 : 1,
  ];
  await executeFn(
    `INSERT INTO notification_preferences (user_id, user_type, in_app, email, whatsapp, sms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       in_app = IF(?, VALUES(in_app), in_app),
       email = IF(?, VALUES(email), email),
       whatsapp = IF(?, VALUES(whatsapp), whatsapp),
       sms = IF(?, VALUES(sms), sms)`,
    [
      userId,
      userType,
      merged.in_app ? 1 : 0,
      merged.email ? 1 : 0,
      merged.whatsapp ? 1 : 0,
      merged.sms ? 1 : 0,
      ...patchFlags,
    ],
  );
  // Read the persisted result: another disjoint PATCH may have committed
  // while this upsert waited. The pre-write merge is not authoritative.
  const saved = await fetchPreferences(queryOneFn, userId, userType);
  if (!saved) throw new Error('Notification preferences write could not be confirmed');
  return saved;
};
