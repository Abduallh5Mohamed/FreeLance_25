"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.savePreferences = exports.fetchPreferences = exports.mergePreferences = exports.parsePreferencesInput = exports.canDeliver = exports.isChannelEnabled = exports.normalizePreferences = exports.isNotificationChannel = exports.defaultPreferences = exports.NOTIFICATION_CHANNELS = void 0;
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
exports.NOTIFICATION_CHANNELS = ['in_app', 'email', 'whatsapp', 'sms'];
/** Quiet defaults: in-app on, everything else off. */
const defaultPreferences = () => ({
    in_app: true,
    email: false,
    whatsapp: false,
    sms: false,
});
exports.defaultPreferences = defaultPreferences;
const isNotificationChannel = (value) => typeof value === 'string' &&
    exports.NOTIFICATION_CHANNELS.includes(value);
exports.isNotificationChannel = isNotificationChannel;
const toBoolean = (value, fallback) => {
    if (value === true || value === 1)
        return true;
    if (value === false || value === 0)
        return false;
    return fallback;
};
/** Merge a raw DB row over quiet defaults; unknown/missing columns stay denied. */
const normalizePreferences = (row) => {
    const defaults = (0, exports.defaultPreferences)();
    if (row === null)
        return defaults;
    return {
        in_app: toBoolean(row.in_app, defaults.in_app),
        email: toBoolean(row.email, defaults.email),
        whatsapp: toBoolean(row.whatsapp, defaults.whatsapp),
        sms: toBoolean(row.sms, defaults.sms),
    };
};
exports.normalizePreferences = normalizePreferences;
/** Deny-by-default single-channel check. Unknown channels deny. */
const isChannelEnabled = (prefs, channel) => {
    if (!(0, exports.isNotificationChannel)(channel))
        return false;
    if (prefs === null)
        return (0, exports.defaultPreferences)()[channel];
    return prefs[channel];
};
exports.isChannelEnabled = isChannelEnabled;
/**
 * Server-side delivery gate. A missing preference row means quiet defaults;
 * an explicit false (opt-out) always denies, even for otherwise eligible
 * recipients. Producers must call this before sending on any channel.
 */
const canDeliver = (prefs, channel) => (0, exports.isChannelEnabled)(prefs, channel);
exports.canDeliver = canDeliver;
/**
 * Strict validation for PUT /preferences bodies. Each supplied channel must
 * be a real boolean (numbers/strings/arrays rejected so `0`/`"false"` can
 * never silently flip consent). Unknown fields rejected; empty bodies
 * rejected so a client cannot wipe consent by accident.
 */
const parsePreferencesInput = (body) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Preferences body must be an object' };
    }
    const record = body;
    const keys = Object.keys(record);
    if (keys.length === 0) {
        return { ok: false, error: 'Provide at least one channel preference' };
    }
    const unknown = keys.filter((k) => !(0, exports.isNotificationChannel)(k));
    if (unknown.length > 0) {
        return { ok: false, error: `Unknown preference channel: ${unknown[0]}` };
    }
    const value = {};
    for (const channel of exports.NOTIFICATION_CHANNELS) {
        if (!(channel in record))
            continue;
        const raw = record[channel];
        if (typeof raw !== 'boolean') {
            return { ok: false, error: `${channel} must be a boolean` };
        }
        value[channel] = raw;
    }
    return { ok: true, value };
};
exports.parsePreferencesInput = parsePreferencesInput;
/** Merge a validated partial update over stored prefs (owner-scoped merge). */
const mergePreferences = (stored, patch) => ({ ...stored, ...patch });
exports.mergePreferences = mergePreferences;
const fetchPreferences = async (queryOneFn, userId, userType) => {
    const row = await queryOneFn('SELECT in_app, email, whatsapp, sms FROM notification_preferences WHERE user_id = ? AND user_type = ?', [userId, userType]);
    return row ? (0, exports.normalizePreferences)(row) : null;
};
exports.fetchPreferences = fetchPreferences;
const savePreferences = async (executeFn, queryOneFn, userId, userType, patch) => {
    const stored = await (0, exports.fetchPreferences)(queryOneFn, userId, userType);
    const merged = (0, exports.mergePreferences)(stored ?? (0, exports.defaultPreferences)(), patch);
    const patchFlags = [
        patch.in_app === undefined ? 0 : 1,
        patch.email === undefined ? 0 : 1,
        patch.whatsapp === undefined ? 0 : 1,
        patch.sms === undefined ? 0 : 1,
    ];
    await executeFn(`INSERT INTO notification_preferences (user_id, user_type, in_app, email, whatsapp, sms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       in_app = IF(?, VALUES(in_app), in_app),
       email = IF(?, VALUES(email), email),
       whatsapp = IF(?, VALUES(whatsapp), whatsapp),
       sms = IF(?, VALUES(sms), sms)`, [
        userId,
        userType,
        merged.in_app ? 1 : 0,
        merged.email ? 1 : 0,
        merged.whatsapp ? 1 : 0,
        merged.sms ? 1 : 0,
        ...patchFlags,
    ]);
    // Read the persisted result: another disjoint PATCH may have committed
    // while this upsert waited. The pre-write merge is not authoritative.
    const saved = await (0, exports.fetchPreferences)(queryOneFn, userId, userType);
    if (!saved)
        throw new Error('Notification preferences write could not be confirmed');
    return saved;
};
exports.savePreferences = savePreferences;
