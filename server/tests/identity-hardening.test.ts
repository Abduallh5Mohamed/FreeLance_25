import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import {
    createLoginHandler,
    createRegisterHandler,
    resolveJwtLifetimeSeconds,
    MAX_JWT_LIFETIME_SECONDS,
    type LoginHandlerDeps,
    type RegisterHandlerDeps,
} from '../src/routes/auth';
import {
    createRedeemHandler,
    INVITATION_PASSWORD_MAX_LENGTH,
    type InvitationRedeemDeps,
    type InvitationRedeemResult,
} from '../src/routes/tenant-invitations';
import {
    resolvePublicRegistrationRole,
    validatePublicRegistrationInput,
} from '../src/security/registration-policy';
import { normalizeEgyptianPhone, phoneLookupCandidates } from '../src/security/phone';

/**
 * Identity/auth rejection-path suite (hermetic: no database, no network).
 * Every handler is driven through its injected-dependency factory with
 * disposable fixtures; the MySQL pool is never created.
 */

const TEST_SECRET = 'test-only-secret-with-sufficient-length';
const FIXTURE_PASSWORD = 'disposable-fixture-password-1';
const fixtureHash = bcrypt.hashSync(FIXTURE_PASSWORD, 4);

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

type CapturedResponse = Response & { capturedStatus?: number; capturedBody?: unknown };

const createResponse = (): CapturedResponse => {
    const response = {
        status(code: number) {
            response.capturedStatus = code;
            return response;
        },
        json(body: unknown) {
            response.capturedBody = body;
            return response;
        },
    } as CapturedResponse;
    return response;
};

// ---------------------------------------------------------------------------
// JWT lifetime cap
// ---------------------------------------------------------------------------

test('JWT lifetime defaults to 7 days and never exceeds it', () => {
    assert.equal(resolveJwtLifetimeSeconds(undefined), MAX_JWT_LIFETIME_SECONDS);
    assert.equal(resolveJwtLifetimeSeconds('7d'), MAX_JWT_LIFETIME_SECONDS);
    assert.equal(resolveJwtLifetimeSeconds('30d'), MAX_JWT_LIFETIME_SECONDS);
    assert.equal(resolveJwtLifetimeSeconds('365d'), MAX_JWT_LIFETIME_SECONDS);
    assert.equal(resolveJwtLifetimeSeconds('9999999999'), MAX_JWT_LIFETIME_SECONDS);
});

test('JWT lifetime accepts explicit short durations and rejects garbage', () => {
    assert.equal(resolveJwtLifetimeSeconds('3600'), 3600);
    assert.equal(resolveJwtLifetimeSeconds('15m'), 900);
    assert.equal(resolveJwtLifetimeSeconds('12h'), 43200);
    assert.equal(resolveJwtLifetimeSeconds('never'), MAX_JWT_LIFETIME_SECONDS);
    assert.equal(resolveJwtLifetimeSeconds('0'), MAX_JWT_LIFETIME_SECONDS);
    assert.equal(resolveJwtLifetimeSeconds('-5'), MAX_JWT_LIFETIME_SECONDS);
});

// ---------------------------------------------------------------------------
// Registration validation policy
// ---------------------------------------------------------------------------

test('registration validation rejects missing, weak, and malformed input', () => {
    assert.equal(validatePublicRegistrationInput({}).ok, false);
    assert.equal(
        validatePublicRegistrationInput({ phone: '01001234567', password: 'long-enough-1' }).ok,
        false, // name missing
    );
    const short = validatePublicRegistrationInput({ phone: '01001234567', password: 'short', name: 'N' });
    assert.equal(short.ok, false);
    const badPhone = validatePublicRegistrationInput({ phone: '12345', password: 'long-enough-1', name: 'N' });
    assert.equal(badPhone.ok, false);
    const badEmail = validatePublicRegistrationInput({ email: 'not-an-email', password: 'long-enough-1', name: 'N' });
    assert.equal(badEmail.ok, false);
    const tooLong = validatePublicRegistrationInput({
        phone: '01001234567', password: 'x'.repeat(INVITATION_PASSWORD_MAX_LENGTH + 1), name: 'N',
    });
    assert.equal(tooLong.ok, false);
});

test('registration validation normalizes phone and email for storage', () => {
    const result = validatePublicRegistrationInput({
        phone: '01001234567', email: 'USER@Example.Test', password: 'long-enough-1', name: '  Nadia  ',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.phone, '+201001234567');
        assert.equal(result.email, 'user@example.test');
        assert.equal(result.name, 'Nadia');
    }
});

test('public registration still forces the student role', () => {
    assert.equal(resolvePublicRegistrationRole('admin'), 'student');
    assert.equal(resolvePublicRegistrationRole('instructor'), 'student');
});

// ---------------------------------------------------------------------------
// Register handler rejection paths
// ---------------------------------------------------------------------------

interface RegisterFixtures {
    phoneTaken?: boolean;
    emailTaken?: boolean;
    queried?: string[];
    inserted?: unknown[];
}

const makeRegisterDeps = (fixtures: RegisterFixtures): RegisterHandlerDeps => ({
    queryOne: async <T>(sql: string): Promise<T | null> => {
        fixtures.queried?.push(sql);
        if (sql.includes('phone IN')) return (fixtures.phoneTaken ? { id: 'u-1' } : null) as T | null;
        if (sql.includes('email = ?')) return (fixtures.emailTaken ? { id: 'u-2' } : null) as T | null;
        return null;
    },
    query: async (sql: string, params?: unknown[]): Promise<{ insertId: number; affectedRows: number }> => {
        fixtures.inserted?.push({ sql, params });
        return { insertId: 42, affectedRows: 1 };
    },
    hashPassword: async (password: string) => bcrypt.hash(password, 4),
});

const runRegister = async (fixtures: RegisterFixtures, body: unknown) => {
    const response = createResponse();
    await createRegisterHandler(makeRegisterDeps(fixtures))({ body } as Request, response);
    return response;
};

test('register rejects a weak password before any database access', async () => {
    const fixtures: RegisterFixtures = { queried: [] };
    const response = await runRegister(fixtures, { phone: '01001234567', password: 'short', name: 'N' });
    assert.equal(response.capturedStatus, 400);
    assert.deepEqual(fixtures.queried, []);
});

test('register rejects an invalid phone before any database access', async () => {
    const fixtures: RegisterFixtures = { queried: [] };
    const response = await runRegister(fixtures, { phone: ':::', password: 'long-enough-1', name: 'N' });
    assert.equal(response.capturedStatus, 400);
    assert.deepEqual(fixtures.queried, []);
});

test('register rejects a taken phone across format variants without naming the field', async () => {
    const fixtures: RegisterFixtures = { queried: [], inserted: [] };
    // National format input must still collide with a stored E.164 row.
    const response = await runRegister(
        { ...fixtures, phoneTaken: true },
        { phone: '01001234567', password: 'long-enough-1', name: 'N' },
    );
    assert.equal(response.capturedStatus, 409);
    assert.deepEqual(response.capturedBody, { error: 'An account with these details already exists' });
    assert.deepEqual(fixtures.inserted, []);
});

test('register rejects a taken email without naming the field', async () => {
    const response = await runRegister(
        { emailTaken: true }, { email: 'taken@example.test', password: 'long-enough-1', name: 'N' },
    );
    assert.equal(response.capturedStatus, 409);
    assert.deepEqual(response.capturedBody, { error: 'An account with these details already exists' });
});

test('register stores normalized identifiers and never honors a privileged role', async () => {
    const fixtures: RegisterFixtures = { inserted: [] };
    const response = await runRegister(
        fixtures,
        { phone: '01001234567', email: 'NEW@Example.Test', password: 'long-enough-1', name: 'Nadia', role: 'admin' },
    );
    assert.equal(response.capturedStatus, 201);
    const body = response.capturedBody as { token: string; user: Record<string, unknown> };
    assert.equal(body.user.role, 'student');
    assert.equal(body.user.phone, '+201001234567');
    assert.equal(body.user.email, 'new@example.test');
    assert.equal(body.user.password_hash, undefined);
    const decoded = jwt.verify(body.token, TEST_SECRET) as { tv: number; role: string };
    assert.equal(decoded.tv, 0);
    assert.equal(decoded.role, 'student');
    const insert = fixtures.inserted?.[0] as { params: unknown[] };
    assert.deepEqual(insert.params.slice(0, 2), ['new@example.test', '+201001234567']);
});

// ---------------------------------------------------------------------------
// Login rejection paths (enumeration + suspension + robustness)
// ---------------------------------------------------------------------------

interface LoginFixtures {
    user?: Record<string, unknown> | null;
    staff?: Record<string, unknown> | null;
    staffProfile?: Record<string, unknown> | null;
    compareCalls?: number;
}

const makeLoginDeps = (fixtures: LoginFixtures): LoginHandlerDeps => ({
    queryOne: async <T>(sql: string): Promise<T | null> => {
        if (sql.includes('FROM users')) return (fixtures.user ?? null) as T | null;
        if (sql.includes('accessible_pages FROM staff WHERE id')) return (fixtures.staffProfile ?? null) as T | null;
        if (sql.includes('FROM staff')) return (fixtures.staff ?? null) as T | null;
        return null;
    },
    comparePassword: async (password: string, hash: string) => {
        fixtures.compareCalls = (fixtures.compareCalls ?? 0) + 1;
        return bcrypt.compare(password, hash);
    },
    loadAdminPermissions: async () => [],
    loadAdminRoleCodes: async () => [],
});

const runLogin = async (fixtures: LoginFixtures, body: unknown) => {
    const response = createResponse();
    await createLoginHandler(makeLoginDeps(fixtures))({ body } as Request, response);
    return response;
};

const activeUser = (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1', email: 'user-1@example.test', phone: '+201000000001', name: 'User 1',
    role: 'student', is_active: 1, token_version: 0, suspension_active: 0,
    password_hash: fixtureHash, ...overrides,
});

test('login spends a comparison for an unknown identifier (no timing oracle)', async () => {
    const fixtures: LoginFixtures = {};
    const response = await runLogin(fixtures, { phone: '+209999999999', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, 401);
    assert.deepEqual(response.capturedBody, { error: 'Invalid credentials' });
    assert.equal(fixtures.compareCalls, 1);
});

test('login spends a comparison for an identity without a local credential', async () => {
    const { password_hash: _dropped, ...passwordless } = activeUser();
    const fixtures: LoginFixtures = { user: passwordless };
    const response = await runLogin(fixtures, { phone: '+201000000001', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, 401);
    assert.deepEqual(response.capturedBody, { error: 'Invalid credentials' });
    assert.equal(fixtures.compareCalls, 1);
});

test('login answers a wrong password exactly like an unknown identifier', async () => {
    const fixtures: LoginFixtures = { user: activeUser() };
    const response = await runLogin(fixtures, { phone: '+201000000001', password: 'wrong-password' });
    assert.equal(response.capturedStatus, 401);
    assert.deepEqual(response.capturedBody, { error: 'Invalid credentials' });
});

test('login refuses a suspended identity with a distinct code and no token', async () => {
    const fixtures: LoginFixtures = { user: activeUser({ suspension_active: 1 }) };
    const response = await runLogin(fixtures, { phone: '+201000000001', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, 403);
    assert.deepEqual(response.capturedBody, { error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
});

test('staff login tolerates a malformed accessible_pages row instead of crashing', async () => {
    const fixtures: LoginFixtures = {
        staff: {
            id: 'staff-a', name: 'Staff A', phone: '+201000000002', role: 'staff',
            accessible_pages: 'not-json{{{', is_active: 1, password_hash: fixtureHash,
        },
    };
    const response = await runLogin(fixtures, { phone: '+201000000002', password: FIXTURE_PASSWORD });
    assert.equal(response.capturedStatus, undefined);
    const body = response.capturedBody as { token: string; user: { accessible_pages: unknown } };
    assert.ok(body.token);
    assert.deepEqual(body.user.accessible_pages, []);
});

// ---------------------------------------------------------------------------
// Invitation redeem rejection paths
// ---------------------------------------------------------------------------

const VALID_INVITATION_TOKEN = 'a'.repeat(64);

const makeRedeemDeps = (
    result: InvitationRedeemResult,
    seen: { tokenHash?: string } = {},
): InvitationRedeemDeps => ({
    hashPassword: async (password: string) => bcrypt.hash(password, 4),
    consumeInvitation: async (tokenHash: string) => {
        seen.tokenHash = tokenHash;
        return result;
    },
});

const runRedeem = async (deps: InvitationRedeemDeps, body: unknown) => {
    const response = createResponse();
    await createRedeemHandler(deps)({ body } as Request, response);
    return response;
};

test('redeem rejects malformed tokens and weak passwords without touching storage', async () => {
    let consumed = 0;
    const deps: InvitationRedeemDeps = {
        hashPassword: async () => { throw new Error('must not hash invalid input'); },
        consumeInvitation: async () => { consumed += 1; return 'invalid'; },
    };
    const badToken = await runRedeem(deps, { token: 'short', password: 'long-enough-password-1' });
    assert.equal(badToken.capturedStatus, 400);
    const weakPassword = await runRedeem(deps, { token: VALID_INVITATION_TOKEN, password: 'short' });
    assert.equal(weakPassword.capturedStatus, 400);
    const tooLong = await runRedeem(
        deps, { token: VALID_INVITATION_TOKEN, password: 'x'.repeat(INVITATION_PASSWORD_MAX_LENGTH + 1) },
    );
    assert.equal(tooLong.capturedStatus, 400);
    assert.equal(consumed, 0);
});

test('redeem answers an unknown or expired invitation generically', async () => {
    const seen: { tokenHash?: string } = {};
    const response = await runRedeem(makeRedeemDeps('invalid', seen), {
        token: VALID_INVITATION_TOKEN, password: 'long-enough-password-1',
    });
    assert.equal(response.capturedStatus, 404);
    assert.deepEqual(response.capturedBody, { error: 'Invitation invalid or expired' });
    assert.equal(seen.tokenHash, createHash('sha256').update(VALID_INVITATION_TOKEN).digest('hex'));
});

test('redeem refuses a suspended account instead of reactivating it', async () => {
    const response = await runRedeem(makeRedeemDeps('suspended'), {
        token: VALID_INVITATION_TOKEN, password: 'long-enough-password-1',
    });
    assert.equal(response.capturedStatus, 403);
    assert.deepEqual(response.capturedBody, { error: 'Account is suspended', code: 'ACCOUNT_SUSPENDED' });
});

test('redeem succeeds for a live invitation', async () => {
    const response = await runRedeem(makeRedeemDeps('redeemed'), {
        token: VALID_INVITATION_TOKEN, password: 'long-enough-password-1',
    });
    assert.equal(response.capturedStatus, undefined);
    assert.deepEqual(response.capturedBody, { success: true });
});

// ---------------------------------------------------------------------------
// Phone helpers (enumeration surface depends on normalization)
// ---------------------------------------------------------------------------

test('phone normalization rejects non-Egyptian and malformed input', () => {
    assert.equal(normalizeEgyptianPhone('12345'), null);
    assert.equal(normalizeEgyptianPhone(''), null);
    assert.equal(normalizeEgyptianPhone('+12025550134'), null);
    assert.equal(normalizeEgyptianPhone('01001234567'), '+201001234567');
});

test('phone lookup covers every stored format variant', () => {
    const candidates = phoneLookupCandidates('01001234567');
    assert.ok(candidates.includes('+201001234567'));
    assert.ok(candidates.includes('01001234567'));
    assert.equal(phoneLookupCandidates('not-a-phone').length, 0);
});
