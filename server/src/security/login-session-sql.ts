import { validSessionId, type LoginSessionRecord, type LoginSessionStore } from './login-session';

/** Inject a real executor; this module imports no pool and performs no startup I/O. */
export interface LoginSessionSqlExecutor {
    queryOne<T>(sql: string, values: unknown[]): Promise<T | null>;
    execute(sql: string, values: unknown[]): Promise<{ affectedRows?: number }>;
}

interface SessionRow {
    id: unknown;
    user_id: unknown;
    identity_source: unknown;
    token_version: unknown;
    issued_at_ms: unknown;
    expires_at_ms: unknown;
    revoked_at_ms: unknown;
}

function integer(value: unknown): number {
    if (typeof value === 'string' && !/^\d+$/.test(value)) throw new Error('Invalid session row');
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid session row');
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid session row');
    return result;
}

function identity(value: unknown): string {
    if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 36) {
        throw new Error('Invalid session identity');
    }
    return value;
}

function decode(row: SessionRow): LoginSessionRecord {
    if (!validSessionId(row.id) || (row.identity_source !== 'users' && row.identity_source !== 'staff')) {
        throw new Error('Invalid session row');
    }
    const result: LoginSessionRecord = {
        id: row.id, userId: identity(row.user_id), identitySource: row.identity_source,
        tokenVersion: integer(row.token_version), issuedAtMs: integer(row.issued_at_ms),
        expiresAtMs: integer(row.expires_at_ms),
        revokedAtMs: row.revoked_at_ms === null ? null : integer(row.revoked_at_ms),
    };
    if (result.expiresAtMs <= result.issuedAtMs
        || (result.revokedAtMs !== null && result.revokedAtMs < result.issuedAtMs)) {
        throw new Error('Invalid session lifetime');
    }
    return result;
}

export function createLoginSessionSqlStore(executor: LoginSessionSqlExecutor): LoginSessionStore {
    if (!executor || typeof executor.queryOne !== 'function' || typeof executor.execute !== 'function') {
        throw new Error('Login session SQL requires an executor');
    }
    return {
        async insert(record) {
            // Validate the same shape on both write and read; no lossy coercion.
            decode({ id: record.id, user_id: record.userId, identity_source: record.identitySource,
                token_version: record.tokenVersion, issued_at_ms: record.issuedAtMs,
                expires_at_ms: record.expiresAtMs, revoked_at_ms: record.revokedAtMs });
            if (record.revokedAtMs !== null) throw new Error('A new session cannot already be revoked');
            const result = await executor.execute(
                `INSERT INTO login_sessions
                 (id, user_id, identity_source, token_version, issued_at_ms, expires_at_ms, revoked_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
                [record.id, record.userId, record.identitySource, record.tokenVersion, record.issuedAtMs, record.expiresAtMs],
            );
            if (result.affectedRows !== 1) throw new Error('Session creation was not confirmed');
        },
        async find(id, userId) {
            if (!validSessionId(id)) return null;
            identity(userId);
            const row = await executor.queryOne<SessionRow>(
                `SELECT id, user_id, identity_source, token_version, issued_at_ms, expires_at_ms, revoked_at_ms
                   FROM login_sessions WHERE id = ? AND user_id = ? LIMIT 1`,
                [id, userId],
            );
            if (row === null) return null;
            const record = decode(row);
            // Re-check byte-exact ownership even if a database collation aliases text.
            if (record.id !== id || record.userId !== userId) return null;
            return record;
        },
        async revoke(id, userId, atMs) {
            if (!validSessionId(id)) throw new Error('Invalid session id');
            identity(userId);
            integer(atMs);
            await executor.execute(
                `UPDATE login_sessions SET revoked_at_ms = ?
                  WHERE id = ? AND user_id = ? AND BINARY id = BINARY ? AND BINARY user_id = BINARY ?
                    AND revoked_at_ms IS NULL AND issued_at_ms <= ?`,
                [atMs, id, userId, id, userId, atMs],
            );
        },
    };
}
