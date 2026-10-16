/**
 * Pure M1 integration target validation.
 *
 * The M1 integration suite (tests/integration/m1-tenant-isolation.test.ts)
 * talks to a real MySQL database and a live API process. If its configuration
 * is missing, ambiguous, or points at anything other than the isolated M1 test
 * stack, the harness must refuse before it opens a socket or issues a request.
 *
 * This module holds that policy as pure functions over injected values: it
 * reads no environment variables, parses no .env files, performs no DNS or
 * socket work and never connects to a database. Callers pass values in and
 * receive either a validated, normalized target or a thrown refusal that
 * lists every violation. "Pure" also means importing this module cannot have
 * side effects, so harness files can import it at module scope.
 *
 * These are configuration-string checks only: they cannot prove which
 * process actually listens on a port or which database a connection string
 * reaches. Live-stack identity evidence is outside pure validation and
 * remains a supervisor-authorized verification.
 */

import path from 'node:path';

/** Database name of the isolated M1 compose MySQL (see compose.m1.yaml). */
export const M1_TEST_DATABASE = 'tabweb_m1_test';

/** Host port published by the M1 compose stack for MySQL (127.0.0.1:13316). */
export const M1_COMPOSE_MYSQL_PORT = 13316;

/** Port the M1 API under test listens on, loopback only. */
export const M1_TEST_API_PORT = 3188;

/** Minimum length of the JWT secret used to sign M1 test tokens. */
export const M1_MIN_JWT_SECRET_LENGTH = 32;

/** Hosts the isolated M1 stack may be reached on; production names never qualify. */
export const M1_LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

/** Defaults used when configuration omits a value that only ever needs a safe one. */
export const M1_DEFAULT_DB_HOST = '127.0.0.1';
export const M1_DEFAULT_API_BASE_URL = `http://127.0.0.1:${M1_TEST_API_PORT}`;

/** File name of the isolated M1 environment generated at the repository root. */
export const M1_ENV_FILE_NAME = '.env.m1';

/**
 * Absolute path of the isolated M1 environment file for a harness file that
 * lives in server/tests/integration.
 *
 * The value is computed from the caller's own directory so it never depends
 * on the process working directory, and the file is never read, created or
 * touched here. The chain must reach three levels up: the integration
 * directory sits at <root>/server/tests/integration, so two levels up lands
 * in server/ while the generated .env.m1 lives at the repository root.
 */
export function resolveM1EnvPathFromIntegrationDir(integrationDir: string): string {
    return path.resolve(integrationDir, '..', '..', '..', M1_ENV_FILE_NAME);
}

/** Raw, untrusted configuration values as read from a caller/source. */
export interface M1TestTargetInput {
    dbName?: string | undefined;
    dbPort?: string | number | undefined;
    dbHost?: string | undefined;
    apiBaseUrl?: string | undefined;
    jwtSecret?: string | undefined;
}

/** Validated target the harness is allowed to talk to. */
export interface M1TestTarget {
    database: string;
    dbPort: number;
    dbHost: string;
    baseUrl: string;
}

/** Raised when any configured target is missing, ambiguous or unsafe. */
export class M1TargetGuardError extends Error {
    readonly violations: string[];

    constructor(violations: string[]) {
        super(`M1 integration target refused:\n- ${violations.join('\n- ')}`);
        this.name = 'M1TargetGuardError';
        this.violations = violations;
    }
}

function normalizeLoopbackHost(host: string): string {
    return host.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(host: string): boolean {
    return (M1_LOOPBACK_HOSTS as readonly string[]).includes(normalizeLoopbackHost(host));
}

/**
 * Compose ports are matched exactly — the same fail-closed contract the M1
 * seed script uses — so padded or unusual forms are refused, not guessed.
 */
function isExactPort(value: string | number | undefined, expected: number): boolean {
    if (typeof value === 'number') return value === expected;
    return typeof value === 'string' && value === String(expected);
}

/**
 * Echo a refused host for diagnosis without ever publishing credentials that
 * a misconfigured value may have smuggled into userinfo position.
 */
function redactHostEcho(host: string): string {
    const separator = host.indexOf('@');
    return separator === -1 ? host : `[userinfo redacted]@${host.slice(separator + 1)}`;
}

/**
 * Diagnosable description of a refused base URL. The raw submitted string,
 * userinfo, query string and fragment are never echoed: a misconfigured
 * target must stay diagnosable without copying credentials into test output
 * or CI logs.
 */
function describeRedactedBaseUrl(parsed: URL): string {
    const userinfo = parsed.username !== '' || parsed.password !== '' ? '[userinfo redacted]@' : '';
    const redactedParts = [
        parsed.search !== '' ? 'query redacted' : null,
        parsed.hash !== '' ? 'fragment redacted' : null,
        parsed.pathname !== '' && parsed.pathname !== '/' ? 'path redacted' : null,
    ].filter((part): part is string => part !== null);
    const suffix = redactedParts.length > 0 ? ` (${redactedParts.join(', ')})` : '';
    return `(${parsed.protocol}//${userinfo}${parsed.hostname}:${parsed.port || '(default port)'})${suffix}`;
}

/**
 * Validate the M1 integration target before any import-time work, pool
 * creation or network request. Throws M1TargetGuardError listing every
 * violation so an operator sees the full problem, not just the first one.
 *
 * An accepted API base is origin-only: userinfo, query strings, fragments
 * and base paths are refused, and refusals describe the problem without
 * echoing the submitted URL or any credentials it carried.
 */
export function assertSafeM1TestTarget(input: M1TestTargetInput): M1TestTarget {
    const violations: string[] = [];

    if (input.dbName !== M1_TEST_DATABASE) {
        violations.push(
            `database name must be exactly "${M1_TEST_DATABASE}" (isolated M1 compose database), got ${JSON.stringify(input.dbName)}`
        );
    }

    if (!isExactPort(input.dbPort, M1_COMPOSE_MYSQL_PORT)) {
        violations.push(
            `database port must be exactly the isolated compose port ${M1_COMPOSE_MYSQL_PORT}, got ${JSON.stringify(input.dbPort)}`
        );
    }

    let dbHost = M1_DEFAULT_DB_HOST;
    if (typeof input.dbHost === 'string') {
        if (normalizeLoopbackHost(input.dbHost) === '') {
            violations.push('database host is present but empty; omit it or use a loopback address');
        } else if (!isLoopbackHost(input.dbHost)) {
            violations.push(
                `database host must be loopback (${M1_LOOPBACK_HOSTS.join(', ')}), got ${JSON.stringify(redactHostEcho(input.dbHost))}`
            );
        } else {
            dbHost = normalizeLoopbackHost(input.dbHost);
        }
    }

    let baseUrl = M1_DEFAULT_API_BASE_URL;
    if (typeof input.apiBaseUrl === 'string') {
        const trimmed = input.apiBaseUrl.trim();
        if (trimmed === '') {
            violations.push('API base URL is present but empty; omit it for the isolated default or set a loopback URL');
        } else {
            let parsed: URL | null = null;
            try {
                parsed = new URL(trimmed);
            } catch {
                violations.push('API base URL is not a parseable URL');
            }
            if (parsed !== null) {
                const problems: string[] = [];
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                    problems.push(`scheme must be http or https, got ${JSON.stringify(parsed.protocol)}`);
                }
                if (parsed.username !== '' || parsed.password !== '') {
                    problems.push('username/password userinfo is not allowed (userinfo redacted in this refusal)');
                }
                if (parsed.search !== '') {
                    problems.push('query string is not allowed (query redacted in this refusal)');
                }
                if (parsed.hash !== '') {
                    problems.push('fragment is not allowed (fragment redacted in this refusal)');
                }
                if (parsed.pathname !== '' && parsed.pathname !== '/') {
                    problems.push('base path must be empty: the API base is origin-only (path redacted in this refusal)');
                }
                if (!isLoopbackHost(parsed.hostname)) {
                    problems.push(
                        `host must be loopback (${M1_LOOPBACK_HOSTS.join(', ')}), got ${JSON.stringify(parsed.hostname)}`
                    );
                }
                if (parsed.port !== String(M1_TEST_API_PORT)) {
                    problems.push(`port must be ${M1_TEST_API_PORT}, got ${JSON.stringify(parsed.port || '(default)')}`);
                }
                if (problems.length === 0) {
                    // Origin only: the harness concatenates absolute routes, so a
                    // trailing slash or path would silently double-prefix them.
                    baseUrl = parsed.origin;
                } else {
                    violations.push(`API base URL refused ${describeRedactedBaseUrl(parsed)}: ${problems.join('; ')}`);
                }
            }
        }
    }

    const secret = typeof input.jwtSecret === 'string' ? input.jwtSecret : '';
    if (secret.length < M1_MIN_JWT_SECRET_LENGTH) {
        violations.push(`JWT secret must be at least ${M1_MIN_JWT_SECRET_LENGTH} characters`);
    }

    if (violations.length > 0) {
        throw new M1TargetGuardError(violations);
    }

    return {
        database: M1_TEST_DATABASE,
        dbPort: M1_COMPOSE_MYSQL_PORT,
        dbHost,
        baseUrl,
    };
}
