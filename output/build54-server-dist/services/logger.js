"use strict";
/**
 * M8 Q4 — structured JSON logger with a redaction layer.
 *
 * Every record is emitted as one JSON line. Before serialization the whole
 * payload is deep-copied through a redaction walk that:
 *  - replaces values whose KEY looks like a secret (password/token/secret/
 *    authorization/cookie/api-key/credential/private-key/otp/pin/cvv/card...)
 *    with `[REDACTED]`;
 *  - masks email and phone values (key-driven, plus email value detection);
 *  - bounds recursion depth (`[MaxDepth]`), array length and string length;
 *  - treats `Error` values (including `cause` chains) as ordinary objects for
 *    the depth and cycle guards, so a deep or self-referencing error cannot
 *    expand past the bound;
 *  - breaks reference cycles (`[Circular]`);
 *  - caps the final record size, replacing an oversized record with a redacted,
 *    truncated preview.
 *
 * The clock and the output sink are injected so tests are deterministic and
 * hermetic; production defaults to `Date` and `process.stdout`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_BYTES = exports.DEFAULT_REDACTION = exports.MAX_DEPTH_MARKER = exports.CIRCULAR = exports.REDACTED = exports.LOG_LEVEL_WEIGHT = void 0;
exports.maskEmail = maskEmail;
exports.maskPhone = maskPhone;
exports.isSensitiveKey = isSensitiveKey;
exports.redactValue = redactValue;
exports.createLogger = createLogger;
exports.LOG_LEVEL_WEIGHT = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
exports.REDACTED = '[REDACTED]';
exports.CIRCULAR = '[Circular]';
exports.MAX_DEPTH_MARKER = '[MaxDepth]';
/**
 * Substrings that mark a KEY as a secret once its non-alphanumerics are
 * stripped and it is lowercased (e.g. `access_token`, `api-key`,
 * `clientSecret`). Chosen to avoid short false positives such as `monkey`
 * (`key`) or `shipping` (`pin`).
 */
const SENSITIVE_KEY_SUBSTRINGS = [
    'password',
    'passwd',
    'passphrase',
    'secret',
    'token',
    'authorization',
    'cookie',
    'credential',
    'privatekey',
    'signingkey',
    'apikey',
    'accesskey',
    'bearer',
    'sessionid',
    'cardnumber',
];
/** Exact tokens that mark a key as a secret. */
const SENSITIVE_KEY_TOKENS = ['pass', 'otp', 'pin', 'cvv', 'cvc', 'puk'];
/** Keys that carry an email address. */
const EMAIL_KEY_PATTERN = /e-?mail|emailaddress/i;
/** Keys that carry a phone number. */
const PHONE_KEY_PATTERN = /(phone|mobile|msisdn|whatsapp|telephone|\btel\b)/i;
const EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
exports.DEFAULT_REDACTION = {
    redactKeys: [],
    maskEmails: true,
    maskPhones: true,
    maxDepth: 6,
    maxArrayLength: 50,
    maxStringLength: 4096,
};
exports.DEFAULT_MAX_BYTES = 16 * 1024;
/** Masks an email while keeping the first local character and the domain. */
function maskEmail(value) {
    const at = value.lastIndexOf('@');
    if (at <= 0)
        return exports.REDACTED;
    const local = value.slice(0, at);
    const domain = value.slice(at);
    return `${local[0]}***${domain}`;
}
/** Masks a phone number while keeping only its last four digits. */
function maskPhone(value) {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4)
        return exports.REDACTED;
    return `***${digits.slice(-4)}`;
}
/** True when a key name (optionally extended) denotes a secret. */
function isSensitiveKey(key, extra = []) {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (extra.some((candidate) => candidate.toLowerCase().replace(/[^a-z0-9]/g, '') === compact))
        return true;
    if (SENSITIVE_KEY_SUBSTRINGS.some((needle) => compact.includes(needle)))
        return true;
    const tokens = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.toLowerCase())
        .filter(Boolean);
    return tokens.some((token) => SENSITIVE_KEY_TOKENS.includes(token));
}
const truncateString = (value, max) => value.length > max ? `${value.slice(0, max)}…` : value;
const redactStringValue = (key, value, options) => {
    const bounded = truncateString(value, options.maxStringLength);
    if (key !== null) {
        if (options.maskEmails && EMAIL_KEY_PATTERN.test(key))
            return maskEmail(bounded);
        if (options.maskPhones && PHONE_KEY_PATTERN.test(key))
            return maskPhone(bounded);
    }
    if (options.maskEmails && EMAIL_VALUE_PATTERN.test(bounded))
        return maskEmail(bounded);
    return bounded;
};
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
/**
 * Deep-copies a value while redacting secrets/PII, bounding size and breaking
 * cycles. `key` is the property name that held the value (null at the root or
 * inside an array), used for key-based redaction.
 */
function redactValue(value, options = {}) {
    const resolved = {
        redactKeys: options.redactKeys ?? exports.DEFAULT_REDACTION.redactKeys,
        maskEmails: options.maskEmails ?? exports.DEFAULT_REDACTION.maskEmails,
        maskPhones: options.maskPhones ?? exports.DEFAULT_REDACTION.maskPhones,
        maxDepth: options.maxDepth ?? exports.DEFAULT_REDACTION.maxDepth,
        maxArrayLength: options.maxArrayLength ?? exports.DEFAULT_REDACTION.maxArrayLength,
        maxStringLength: options.maxStringLength ?? exports.DEFAULT_REDACTION.maxStringLength,
    };
    const seen = new WeakSet();
    const walk = (current, key, depth) => {
        if (current === null || current === undefined)
            return current;
        if (key !== null && isSensitiveKey(key, resolved.redactKeys))
            return exports.REDACTED;
        if (typeof current === 'string')
            return redactStringValue(key, current, resolved);
        if (typeof current === 'number' || typeof current === 'boolean')
            return current;
        if (typeof current === 'bigint')
            return current.toString();
        if (typeof current === 'function' || typeof current === 'symbol')
            return undefined;
        if (typeof current === 'object') {
            if (seen.has(current))
                return exports.CIRCULAR;
            if (depth >= resolved.maxDepth)
                return exports.MAX_DEPTH_MARKER;
            seen.add(current);
            try {
                if (current instanceof Date)
                    return current.toISOString();
                if (current instanceof Error)
                    return walkError(current, depth);
                if (Array.isArray(current)) {
                    const items = current.slice(0, resolved.maxArrayLength)
                        .map((item) => walk(item, null, depth + 1));
                    if (current.length > resolved.maxArrayLength) {
                        items.push(`[+${current.length - resolved.maxArrayLength} more]`);
                    }
                    return items;
                }
                const output = {};
                for (const [entryKey, entryValue] of Object.entries(current)) {
                    output[entryKey] = walk(entryValue, entryKey, depth + 1);
                }
                return output;
            }
            finally {
                seen.delete(current);
            }
        }
        return String(current);
    };
    /**
     * Error values are subject to the same cycle and depth guard as any other
     * object: the Error is already in `seen`, so a self-referencing `cause`
     * becomes `[Circular]`, and a value past `maxDepth` becomes `[MaxDepth]`
     * instead of a full record. `cause` and any own enumerable property are
     * walked (not silently dropped) at `depth + 1`, which also covers
     * `AggregateError.errors`.
     */
    function walkError(error, depth) {
        const record = {
            name: error.name,
            message: truncateString(error.message, resolved.maxStringLength),
        };
        if (error.stack)
            record.stack = truncateString(error.stack, resolved.maxStringLength);
        for (const [entryKey, entryValue] of Object.entries(error)) {
            if (entryKey === 'name' || entryKey === 'message' || entryKey === 'stack' || entryKey === 'cause')
                continue;
            record[entryKey] = walk(entryValue, entryKey, depth + 1);
        }
        const cause = error.cause;
        if (cause !== undefined)
            record.cause = walk(cause, 'cause', depth + 1);
        return record;
    }
    return walk(value, null, 0);
}
const asFieldRecord = (value) => isPlainObject(value) ? value : {};
function createLogger(options = {}) {
    const level = options.level ?? 'info';
    const threshold = exports.LOG_LEVEL_WEIGHT[level];
    const now = options.now ?? (() => new Date());
    const write = options.write ?? ((line) => { process.stdout.write(line); });
    const maxBytes = options.maxBytes ?? exports.DEFAULT_MAX_BYTES;
    const maxStringLength = options.maxStringLength ?? exports.DEFAULT_REDACTION.maxStringLength;
    const redaction = {
        redactKeys: options.redactKeys,
        maskEmails: options.maskEmails,
        maskPhones: options.maskPhones,
        maxDepth: options.maxDepth,
        maxArrayLength: options.maxArrayLength,
        maxStringLength: options.maxStringLength,
    };
    const emit = (recordLevel, message, fields, base) => {
        if (exports.LOG_LEVEL_WEIGHT[recordLevel] < threshold)
            return;
        const redactedBase = asFieldRecord(redactValue(base ?? {}, redaction));
        const redactedFields = asFieldRecord(redactValue(fields ?? {}, redaction));
        const record = {
            time: now().toISOString(),
            level: recordLevel,
            message: truncateString(String(message), maxStringLength),
            ...redactedBase,
            ...redactedFields,
        };
        let line;
        try {
            line = JSON.stringify(record);
        }
        catch {
            line = JSON.stringify({ time: record.time, level: recordLevel, message: record.message, serialization_error: true });
        }
        const byteLength = Buffer.byteLength(line, 'utf8');
        if (byteLength > maxBytes) {
            // Preserve short scalar context (correlation ids, status, ...) and
            // replace bulky/deep values with a redacted preview so the record
            // stays bounded without losing who/what it belongs to.
            const compact = {};
            for (const [key, value] of Object.entries(record)) {
                if (typeof value === 'string')
                    compact[key] = truncateString(value, 128);
                else if (value === null || typeof value === 'number' || typeof value === 'boolean')
                    compact[key] = value;
            }
            compact.truncated = true;
            compact.bytes = byteLength;
            compact.preview = line.slice(0, maxBytes);
            line = JSON.stringify(compact);
        }
        write(`${line}\n`);
    };
    const make = (base) => ({
        level,
        isEnabled: (candidate) => exports.LOG_LEVEL_WEIGHT[candidate] >= threshold,
        debug: (message, fields) => emit('debug', message, fields, base),
        info: (message, fields) => emit('info', message, fields, base),
        warn: (message, fields) => emit('warn', message, fields, base),
        error: (message, fields) => emit('error', message, fields, base),
        child: (bindings) => make({ ...base, ...(bindings ?? {}) }),
    });
    return make(options.base ?? {});
}
