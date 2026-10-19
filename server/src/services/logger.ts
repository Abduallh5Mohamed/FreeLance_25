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
 *  - breaks reference cycles (`[Circular]`);
 *  - caps the final record size, replacing an oversized record with a redacted,
 *    truncated preview.
 *
 * The clock and the output sink are injected so tests are deterministic and
 * hermetic; production defaults to `Date` and `process.stdout`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export const REDACTED = '[REDACTED]';
export const CIRCULAR = '[Circular]';
export const MAX_DEPTH_MARKER = '[MaxDepth]';

/**
 * Substrings that mark a KEY as a secret once its non-alphanumerics are
 * stripped and it is lowercased (e.g. `access_token`, `api-key`,
 * `clientSecret`). Chosen to avoid short false positives such as `monkey`
 * (`key`) or `shipping` (`pin`).
 */
const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
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
const SENSITIVE_KEY_TOKENS: readonly string[] = ['pass', 'otp', 'pin', 'cvv', 'cvc', 'puk'];

/** Keys that carry an email address. */
const EMAIL_KEY_PATTERN = /e-?mail|emailaddress/i;

/** Keys that carry a phone number. */
const PHONE_KEY_PATTERN = /(phone|mobile|msisdn|whatsapp|telephone|\btel\b)/i;

const EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RedactionOptions {
    /** Additional exact key names to always redact (case-insensitive). */
    redactKeys?: readonly string[];
    maskEmails?: boolean;
    maskPhones?: boolean;
    maxDepth?: number;
    maxArrayLength?: number;
    maxStringLength?: number;
}

export const DEFAULT_REDACTION: Required<Omit<RedactionOptions, 'redactKeys'>> & { redactKeys: readonly string[] } = {
    redactKeys: [],
    maskEmails: true,
    maskPhones: true,
    maxDepth: 6,
    maxArrayLength: 50,
    maxStringLength: 4096,
};

export interface LoggerOptions extends RedactionOptions {
    level?: LogLevel;
    /** Injected clock. */
    now?: () => Date;
    /** Injected sink; receives complete lines (with trailing newline). */
    write?: (line: string) => void;
    /** Base fields merged into every record. */
    base?: Record<string, unknown>;
    /** Maximum serialized record size; oversized records are truncated. */
    maxBytes?: number;
}

export interface Logger {
    readonly level: LogLevel;
    isEnabled(level: LogLevel): boolean;
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    child(bindings?: Record<string, unknown>): Logger;
}

export const DEFAULT_MAX_BYTES = 16 * 1024;

/** Masks an email while keeping the first local character and the domain. */
export function maskEmail(value: string): string {
    const at = value.lastIndexOf('@');
    if (at <= 0) return REDACTED;
    const local = value.slice(0, at);
    const domain = value.slice(at);
    return `${local[0]}***${domain}`;
}

/** Masks a phone number while keeping only its last four digits. */
export function maskPhone(value: string): string {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4) return REDACTED;
    return `***${digits.slice(-4)}`;
}

/** True when a key name (optionally extended) denotes a secret. */
export function isSensitiveKey(key: string, extra: readonly string[] = []): boolean {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (extra.some((candidate) => candidate.toLowerCase().replace(/[^a-z0-9]/g, '') === compact)) return true;
    if (SENSITIVE_KEY_SUBSTRINGS.some((needle) => compact.includes(needle))) return true;
    const tokens = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .map((token) => token.toLowerCase())
        .filter(Boolean);
    return tokens.some((token) => SENSITIVE_KEY_TOKENS.includes(token));
}

const truncateString = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max)}…` : value;

const redactStringValue = (
    key: string | null,
    value: string,
    options: Required<Omit<RedactionOptions, 'redactKeys'>> & { redactKeys: readonly string[] },
): string => {
    const bounded = truncateString(value, options.maxStringLength);
    if (key !== null) {
        if (options.maskEmails && EMAIL_KEY_PATTERN.test(key)) return maskEmail(bounded);
        if (options.maskPhones && PHONE_KEY_PATTERN.test(key)) return maskPhone(bounded);
    }
    if (options.maskEmails && EMAIL_VALUE_PATTERN.test(bounded)) return maskEmail(bounded);
    return bounded;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/**
 * Deep-copies a value while redacting secrets/PII, bounding size and breaking
 * cycles. `key` is the property name that held the value (null at the root or
 * inside an array), used for key-based redaction.
 */
export function redactValue(
    value: unknown,
    options: RedactionOptions = {},
): unknown {
    const resolved = {
        redactKeys: options.redactKeys ?? DEFAULT_REDACTION.redactKeys,
        maskEmails: options.maskEmails ?? DEFAULT_REDACTION.maskEmails,
        maskPhones: options.maskPhones ?? DEFAULT_REDACTION.maskPhones,
        maxDepth: options.maxDepth ?? DEFAULT_REDACTION.maxDepth,
        maxArrayLength: options.maxArrayLength ?? DEFAULT_REDACTION.maxArrayLength,
        maxStringLength: options.maxStringLength ?? DEFAULT_REDACTION.maxStringLength,
    };
    const seen = new WeakSet<object>();

    const walk = (current: unknown, key: string | null, depth: number): unknown => {
        if (current === null || current === undefined) return current;
        if (key !== null && isSensitiveKey(key, resolved.redactKeys)) return REDACTED;
        if (typeof current === 'string') return redactStringValue(key, current, resolved);
        if (typeof current === 'number' || typeof current === 'boolean') return current;
        if (typeof current === 'bigint') return current.toString();
        if (typeof current === 'function' || typeof current === 'symbol') return undefined;
        if (current instanceof Date) return current.toISOString();
        if (current instanceof Error) {
            const errorRecord: Record<string, unknown> = {
                name: current.name,
                message: truncateString(current.message, resolved.maxStringLength),
            };
            if (current.stack) errorRecord.stack = truncateString(current.stack, resolved.maxStringLength);
            return errorRecord;
        }
        if (typeof current === 'object') {
            if (seen.has(current as object)) return CIRCULAR;
            if (depth >= resolved.maxDepth) return MAX_DEPTH_MARKER;
            seen.add(current as object);
            try {
                if (Array.isArray(current)) {
                    const items = current.slice(0, resolved.maxArrayLength)
                        .map((item) => walk(item, null, depth + 1));
                    if (current.length > resolved.maxArrayLength) {
                        items.push(`[+${current.length - resolved.maxArrayLength} more]`);
                    }
                    return items;
                }
                const output: Record<string, unknown> = {};
                for (const [entryKey, entryValue] of Object.entries(current as Record<string, unknown>)) {
                    output[entryKey] = walk(entryValue, entryKey, depth + 1);
                }
                return output;
            } finally {
                seen.delete(current as object);
            }
        }
        return String(current);
    };

    return walk(value, null, 0);
}

const asFieldRecord = (value: unknown): Record<string, unknown> =>
    isPlainObject(value) ? value : {};

export function createLogger(options: LoggerOptions = {}): Logger {
    const level = options.level ?? 'info';
    const threshold = LOG_LEVEL_WEIGHT[level];
    const now = options.now ?? (() => new Date());
    const write = options.write ?? ((line: string) => { process.stdout.write(line); });
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxStringLength = options.maxStringLength ?? DEFAULT_REDACTION.maxStringLength;
    const redaction: RedactionOptions = {
        redactKeys: options.redactKeys,
        maskEmails: options.maskEmails,
        maskPhones: options.maskPhones,
        maxDepth: options.maxDepth,
        maxArrayLength: options.maxArrayLength,
        maxStringLength: options.maxStringLength,
    };

    const emit = (recordLevel: LogLevel, message: string, fields?: Record<string, unknown>, base?: Record<string, unknown>): void => {
        if (LOG_LEVEL_WEIGHT[recordLevel] < threshold) return;
        const redactedBase = asFieldRecord(redactValue(base ?? {}, redaction));
        const redactedFields = asFieldRecord(redactValue(fields ?? {}, redaction));
        const record: Record<string, unknown> = {
            time: now().toISOString(),
            level: recordLevel,
            message: truncateString(String(message), maxStringLength),
            ...redactedBase,
            ...redactedFields,
        };
        let line: string;
        try {
            line = JSON.stringify(record);
        } catch {
            line = JSON.stringify({ time: record.time, level: recordLevel, message: record.message, serialization_error: true });
        }
        const byteLength = Buffer.byteLength(line, 'utf8');
        if (byteLength > maxBytes) {
            // Preserve short scalar context (correlation ids, status, ...) and
            // replace bulky/deep values with a redacted preview so the record
            // stays bounded without losing who/what it belongs to.
            const compact: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(record)) {
                if (typeof value === 'string') compact[key] = truncateString(value, 128);
                else if (value === null || typeof value === 'number' || typeof value === 'boolean') compact[key] = value;
            }
            compact.truncated = true;
            compact.bytes = byteLength;
            compact.preview = line.slice(0, maxBytes);
            line = JSON.stringify(compact);
        }
        write(`${line}\n`);
    };

    const make = (base: Record<string, unknown>): Logger => ({
        level,
        isEnabled: (candidate: LogLevel) => LOG_LEVEL_WEIGHT[candidate] >= threshold,
        debug: (message, fields) => emit('debug', message, fields, base),
        info: (message, fields) => emit('info', message, fields, base),
        warn: (message, fields) => emit('warn', message, fields, base),
        error: (message, fields) => emit('error', message, fields, base),
        child: (bindings) => make({ ...base, ...(bindings ?? {}) }),
    });

    return make(options.base ?? {});
}
