import { Request, Response, NextFunction } from 'express';

type Entry = { count: number; resetAt: number };
const buckets = new Map<string, Entry>();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
}, 10 * 60_000);
cleanupTimer.unref();

export function rateLimit(name: string, max: number, windowMs: number) {
    return (req: Request, res: Response, next: NextFunction) => {
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const key = `${name}:${forwarded || req.ip || 'unknown'}`;
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
