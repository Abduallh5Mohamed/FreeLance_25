import { Request, Response, NextFunction } from 'express';

type Entry = { count: number; resetAt: number };
const buckets = new Map<string, Entry>();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
}, 10 * 60_000);
cleanupTimer.unref();

/**
 * Addresses of reverse proxies allowed to set X-Forwarded-For. Without a
 * configured trusted proxy the header is attacker-controlled and must never
 * influence rate limiting (or any other identity decision). Deployment sets
 * TRUSTED_PROXIES to the proxy addresses (comma separated); loopback is not
 * trusted implicitly.
 */
export const trustedProxyAddresses = (): Set<string> => {
    const configured = (process.env.TRUSTED_PROXIES || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    return new Set(configured);
};

/**
 * Resolve the client address for security decisions. X-Forwarded-For is only
 * honoured when the direct peer is a configured trusted proxy; otherwise the
 * header is ignored so a spoofed value cannot bypass rate limits or poison
 * security logs. Returns the left-most XFF entry when trusted.
 */
export const resolveClientAddress = (req: Request): string => {
    const direct = (req.ip || req.socket?.remoteAddress || 'unknown').toLowerCase();
    if (!trustedProxyAddresses().has(direct)) return direct;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || direct;
};

/** Rate-limit bucket key for a request, built from the trusted client address. */
export const clientRateLimitKey = (name: string, req: Request): string =>
    `${name}:${resolveClientAddress(req)}`;

export function rateLimit(name: string, max: number, windowMs: number) {
    return (req: Request, res: Response, next: NextFunction) => {
        const key = clientRateLimitKey(name, req);
        const now = Date.now();
        const current = buckets.get(key);
        const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
        entry.count += 1;
        buckets.set(key, entry);
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
        if (entry.count > max) {
            res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
            return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        next();
    };
}
