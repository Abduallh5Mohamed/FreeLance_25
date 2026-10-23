import { randomUUID } from 'node:crypto';

export interface LoginSessionRecord {
    id: string;
    userId: string;
    identitySource: 'users' | 'staff';
    tokenVersion: number;
    issuedAtMs: number;
    expiresAtMs: number;
    revokedAtMs: number | null;
}

export interface LoginSessionStore {
    /** Must durably commit before a signed login token is returned. */
    insert(record: LoginSessionRecord): Promise<void>;
    find(id: string, userId: string): Promise<LoginSessionRecord | null>;
    /** Idempotent, scoped revocation; missing rows are not created. */
    revoke(id: string, userId: string, atMs: number): Promise<void>;
}

export const validSessionId = (value: unknown): value is string =>
    typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

const safeInstant = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Identity liveness and capability checks remain independent prerequisites. */
export function isLoginSessionLive(
    row: LoginSessionRecord | null,
    expected: { id: string; userId: string; identitySource: 'users' | 'staff'; tokenVersion: number },
    nowMs: number,
): boolean {
    return row !== null && validSessionId(expected.id)
        && row.id === expected.id && row.userId === expected.userId
        && row.identitySource === expected.identitySource
        && Number.isSafeInteger(expected.tokenVersion) && expected.tokenVersion >= 0
        && row.tokenVersion === expected.tokenVersion
        && safeInstant(nowMs) && safeInstant(row.issuedAtMs) && safeInstant(row.expiresAtMs)
        && row.issuedAtMs <= nowMs && nowMs < row.expiresAtMs
        && row.expiresAtMs > row.issuedAtMs && row.revokedAtMs === null;
}

export function createLoginSessionAuthority(store: LoginSessionStore, now: () => number = Date.now) {
    if (!store || typeof store.insert !== 'function' || typeof store.find !== 'function'
        || typeof store.revoke !== 'function' || typeof now !== 'function') {
        throw new Error('Login sessions require a durable scoped store and clock');
    }
    return {
        async issue(input: { userId: string; identitySource: 'users' | 'staff'; tokenVersion: number; expiresAtMs: number }) {
            const at = now();
            if (typeof input.userId !== 'string' || !input.userId.trim() || input.userId.trim() !== input.userId
                || input.userId.length > 36 || !['users', 'staff'].includes(input.identitySource)
                || !Number.isSafeInteger(input.tokenVersion) || input.tokenVersion < 0
                || !safeInstant(at) || !safeInstant(input.expiresAtMs) || input.expiresAtMs <= at) {
                throw new Error('Invalid login session identity or lifetime');
            }
            const record: LoginSessionRecord = {
                id: randomUUID(), ...input, issuedAtMs: at, revokedAtMs: null,
            };
            await store.insert(record);
            return Object.freeze(record);
        },
        async verify(expected: { id: string; userId: string; identitySource: 'users' | 'staff'; tokenVersion: number }) {
            if (!validSessionId(expected.id)) return false;
            return isLoginSessionLive(await store.find(expected.id, expected.userId), expected, now());
        },
        async revoke(id: string, userId: string) {
            const at = now();
            if (!validSessionId(id) || !userId || !safeInstant(at)) throw new Error('Invalid session revocation');
            await store.revoke(id, userId, at);
        },
    };
}
