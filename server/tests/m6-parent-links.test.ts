/**
 * M6 P1 — parent-student verified linking (hermetic, no MySQL/network).
 *
 * The REAL route factory, the REAL identity-otp service and the REAL
 * parent-links service run over an in-memory SQL interpreter and a fake
 * delivery adapter. No database, provider or network is contacted; the OTP
 * code is only captured by the fake delivery and never returned by a route.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Router, type RequestHandler } from 'express';
import { AuthRequest } from '../src/middleware/auth';
import { IdentityOtpService, type IdentityOtpDeps, type OtpChallengeRow, type OtpDelivery } from '../src/security/identity-otp';
import { createParentLinksRouter, type ParentLinksDataAccess } from '../src/routes/parent-links';
import {
    canonicalContact,
    createSqlParentLinksStore,
    isStudentEnrollmentActive,
    normalizeParentViewTtl,
    parseLinkRequestInput,
    parseVerifyInput,
    signParentViewToken,
    verifyParentViewToken,
    type ParentLinkRow,
    type ParentLinksStore,
    type ParentViewTokenRecord,
    type StudentContactRow,
} from '../src/services/parent-links';
import { invokeRoute, type CapturedResponse } from './helpers/m2-harness';

const OTP_KEY = 'm6-parent-links-otp-hmac-key-0001';
const VIEW_SECRET = 'm6-parent-view-secret-000123456789abcdef';
const TENANT = 'tenant-a';
const ENROLLMENT = 'enrollment-1';
const PARENT = 'parent-user-1';
const OTHER_PARENT = 'parent-user-2';
const STUDENT_USER = 'student-user-1';
const GUARDIAN_PHONE = '+201000000123';
const GUARDIAN_EMAIL = 'guardian@example.test';

interface Clock {
    now(): Date;
    advance(seconds: number): void;
}

const makeClock = (): Clock => {
    let current = new Date('2026-10-18T12:00:00.000Z');
    return {
        now: () => current,
        advance: (seconds) => { current = new Date(current.getTime() + seconds * 1000); },
    };
};

interface FakeState {
    students: StudentContactRow[];
    links: ParentLinkRow[];
    tokens: ParentViewTokenRecord[];
    otp: OtpChallengeRow[];
    executed: { sql: string; params: unknown[]; kind: 'query' | 'queryOne' | 'execute' }[];
    failWith: Error | null;
    authority: Map<string, string>;
    /** Audit inserts captured verbatim so tests can inspect the whole payload. */
    audit: { params: unknown[] }[];
    /** Forces only the audit_events insert to fail (domain writes still succeed). */
    failAudit: boolean;
}

const makeState = (): FakeState => ({
    students: [],
    links: [],
    tokens: [],
    otp: [],
    executed: [],
    failWith: null,
    authority: new Map(),
    audit: [],
    failAudit: false,
});

const seedStudent = (state: FakeState): StudentContactRow => {
    const student: StudentContactRow = {
        id: ENROLLMENT,
        tenant_id: TENANT,
        name: 'Child One',
        phone: '+201000000999',
        email: null,
        guardian_phone: GUARDIAN_PHONE,
        parent_phone: null,
        is_active: 1,
        approval_status: 'approved',
        enrollment_status: 'active',
        enrollment_start_date: null,
        enrollment_end_date: null,
        user_id: STUDENT_USER,
        group_id: null,
        grade_id: null,
        term: '2026 Term 1',
    };
    state.students.push(student);
    return student;
};

const makeFakeDb = (state: FakeState, clock: Clock): ParentLinksDataAccess => {
    const run = (sql: string, params: unknown[], kind: 'query' | 'queryOne' | 'execute') => {
        state.executed.push({ sql, params, kind });
        if (state.failWith) throw state.failWith;
    };

    const findOtp = (id: string) => state.otp.find((row) => row.id === id) ?? null;
    const findLink = (id: string) => state.links.find((row) => row.id === id) ?? null;
    const findToken = (jti: string) => state.tokens.find((row) => row.jti === jti) ?? null;

    const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
        run(sql, params, 'query');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();

        if (upper.includes('FROM STUDENTS')) {
            const student = state.students.find((row) => row.id === params[0]);
            return (student ? [student] : []) as T[];
        }
        if (upper.includes('FROM PARENT_LINKS')) {
            if (upper.includes('WHERE ID = ? AND TENANT_ID = ?')) {
                const link = state.links.find((row) => row.id === params[0] && row.tenant_id === params[1]);
                return (link ? [link] : []) as T[];
            }
            if (upper.includes('WHERE ID = ? LIMIT 1')) {
                const link = findLink(String(params[0]));
                return (link ? [link] : []) as T[];
            }
            if (upper.includes("AND STATUS = 'ACTIVE'")) {
                const link = state.links.find((row) => row.tenant_id === params[0]
                    && row.student_enrollment_id === params[1] && row.parent_user_id === params[2] && row.status === 'active');
                return (link ? [link] : []) as T[];
            }
            if (upper.includes('WHERE PARENT_USER_ID = ?')) {
                return state.links.filter((row) => row.parent_user_id === params[0]) as T[];
            }
            return [] as T[];
        }
        if (upper.includes('FROM PARENT_VIEW_TOKENS')) {
            const token = findToken(String(params[0]));
            return (token ? [token] : []) as T[];
        }
        if (upper.includes('FROM IDENTITY_OTP_CHALLENGES')) {
            if (upper.startsWith('SELECT COUNT(*)')) {
                const total = state.otp.filter((row) => row.contact_hash === params[0] && row.purpose === params[1]
                    && new Date(String(row.created_at ?? 0)).getTime() >= new Date(String(params[2])).getTime()).length;
                return [{ total }] as T[];
            }
            if (upper.includes('CONSUMED_AT IS NULL AND EXPIRES_AT > UTC_TIMESTAMP()')) {
                const matches = state.otp.filter((row) => row.contact_hash === params[0] && row.purpose === params[1]
                    && (row.tenant_id ?? null) === (params[2] ?? null) && row.consumed_at === null
                    && new Date(row.expires_at).getTime() > clock.now().getTime());
                const latest = matches.length ? matches[matches.length - 1] : null;
                return (latest ? [latest] : []) as T[];
            }
            const challenge = findOtp(String(params[0]));
            return (challenge ? [challenge] : []) as T[];
        }
        throw new Error(`fake db: unhandled SELECT: ${sql}`);
    };

    const execute = async (sql: string, params: unknown[] = []): Promise<{ insertId?: number; affectedRows?: number }> => {
        run(sql, params, 'execute');
        const upper = sql.replace(/\s+/g, ' ').toUpperCase();

        if (upper.includes('INSERT INTO IDENTITY_OTP_CHALLENGES')) {
            const [id, contact_hash, purpose, tenant_id, identity_id, code_hash, attempts, max_attempts,
                resend_available_at, expires_at, consumed_at, submitted_at, created_ip] = params;
            state.otp.push({
                id: String(id), contact_hash: String(contact_hash), purpose: String(purpose),
                tenant_id: tenant_id === null ? null : String(tenant_id), identity_id: identity_id === null ? null : String(identity_id),
                code_hash: String(code_hash), attempts: Number(attempts), max_attempts: Number(max_attempts),
                resend_available_at, expires_at, consumed_at: consumed_at === null ? null : consumed_at,
                submitted_at: submitted_at === null ? null : submitted_at,
                created_ip: created_ip === null ? null : String(created_ip),
                created_at: clock.now(),
            } as OtpChallengeRow);
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('UPDATE IDENTITY_OTP_CHALLENGES SET ATTEMPTS')) {
            const challenge = findOtp(String(params[1]));
            if (!challenge) return { affectedRows: 0, insertId: 0 };
            challenge.attempts += 1;
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('UPDATE IDENTITY_OTP_CHALLENGES SET CONSUMED_AT')) {
            const challenge = findOtp(String(params[1]));
            if (!challenge || challenge.consumed_at !== null) return { affectedRows: 0, insertId: 0 };
            challenge.consumed_at = params[0];
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('UPDATE IDENTITY_OTP_CHALLENGES SET SUBMITTED_AT')) {
            const challenge = findOtp(String(params[1]));
            if (!challenge || challenge.consumed_at === null || challenge.submitted_at !== null) return { affectedRows: 0, insertId: 0 };
            challenge.submitted_at = params[0];
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('INSERT INTO PARENT_LINKS')) {
            const [id, tenant_id, student_enrollment_id, parent_user_id, contact_hash, status, version] = params;
            state.links.push({
                id: String(id), tenant_id: String(tenant_id), student_enrollment_id: String(student_enrollment_id),
                parent_user_id: String(parent_user_id), contact_hash: String(contact_hash),
                status: String(status), version: Number(version), revoked_at: null, revoked_by: null,
                created_at: clock.now(),
            });
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('UPDATE PARENT_LINKS SET STATUS')) {
            const link = state.links.find((row) => row.id === params[2] && row.tenant_id === params[3] && row.status === 'active');
            if (!link) return { affectedRows: 0, insertId: 0 };
            link.status = 'revoked';
            link.revoked_at = params[0];
            link.revoked_by = String(params[1]);
            link.version += 1;
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('INSERT INTO AUDIT_EVENTS')) {
            if (state.failAudit) throw new Error('simulated audit outage');
            state.audit.push({ params: [...params] });
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('INSERT INTO PARENT_VIEW_TOKENS')) {
            const [jti, link_id, tenant_id, student_enrollment_id, parent_user_id, issued_at, expires_at] = params;
            state.tokens.push({
                jti: String(jti), link_id: String(link_id), tenant_id: String(tenant_id),
                student_enrollment_id: String(student_enrollment_id), parent_user_id: String(parent_user_id),
                issued_at, expires_at, revoked_at: null, revoked_reason: null,
            } as ParentViewTokenRecord);
            return { affectedRows: 1, insertId: 0 };
        }
        if (upper.includes('UPDATE PARENT_VIEW_TOKENS SET REVOKED_AT')) {
            const token = findToken(String(params[2]));
            if (!token || token.revoked_at !== null) return { affectedRows: 0, insertId: 0 };
            token.revoked_at = params[0];
            token.revoked_reason = String(params[1]);
            return { affectedRows: 1, insertId: 0 };
        }
        throw new Error(`fake db: unhandled WRITE: ${sql}`);
    };

    const queryOne = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
        const rows = await query<T>(sql, params);
        return (rows[0] ?? null) as T | null;
    };

    return { query, queryOne, execute };
};

interface Harness {
    router: Router;
    state: FakeState;
    clock: Clock;
    sent: { contact: string; code: string; purpose: string }[];
    tokenFor: (user: { id: string; role: string; tenantId?: string; studentEnrollmentId?: string }) => string;
    setSecret: (secret: string | undefined) => void;
    setOtpAvailable: (available: boolean) => void;
    setAuthority: (userId: string, tenantId: string, authority: string) => void;
    close: () => Promise<void>;
}

const buildHarness = async (state: FakeState): Promise<Harness> => {
    const clock = makeClock();
    const db = makeFakeDb(state, clock);
    const sent: { contact: string; code: string; purpose: string }[] = [];
    const delivery: OtpDelivery = { send: async (contact, code, purpose) => { sent.push({ contact, code, purpose }); } };
    const otpDeps: IdentityOtpDeps = {
        insertChallenge: async (row) => { await db.execute(
            `INSERT INTO identity_otp_challenges (id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at,created_ip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [row.id, row.contact_hash, row.purpose, row.tenant_id, row.identity_id, row.code_hash, row.attempts, row.max_attempts, row.resend_available_at, row.expires_at, row.consumed_at, row.submitted_at ?? null, row.created_ip]); },
        findChallengeById: async (id) => db.queryOne<OtpChallengeRow>('SELECT id FROM identity_otp_challenges WHERE id = ?', [id]),
        findLatestActiveChallenge: async (contactHash, purpose, tenantId) => db.queryOne<OtpChallengeRow>(
            'SELECT id FROM identity_otp_challenges WHERE contact_hash = ? AND purpose = ? AND (tenant_id <=> ?) AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY created_at DESC LIMIT 1',
            [contactHash, purpose, tenantId]),
        incrementAttempts: async (id) => { await db.execute('UPDATE identity_otp_challenges SET attempts = attempts + 1 WHERE id = ?', [id]); },
        consumeChallenge: async (id, now) => Number((await db.execute('UPDATE identity_otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [now, id])).affectedRows ?? 0),
        consumeSubmission: async (id, now) => Number((await db.execute('UPDATE identity_otp_challenges SET submitted_at = ? WHERE id = ? AND consumed_at IS NOT NULL AND submitted_at IS NULL', [now, id])).affectedRows ?? 0),
        countRecentChallenges: async (contactHash, purpose, since) => {
            const row = await db.queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM identity_otp_challenges WHERE contact_hash = ? AND purpose = ? AND created_at >= ?', [contactHash, purpose, since]);
            return Number(row?.total ?? 0);
        },
        now: () => clock.now(),
    };
    const otpService = new IdentityOtpService(otpDeps, OTP_KEY, delivery);

    const tokenMap = new Map<string, { id: string; role: string; tenantId?: string; studentEnrollmentId?: string }>();
    const tokenFor = (user: { id: string; role: string; tenantId?: string; studentEnrollmentId?: string }) => {
        const token = `token:${user.id}:${user.role}`;
        tokenMap.set(token, user);
        return token;
    };
    const authenticate: RequestHandler = (req, res, next) => {
        const header = (req as { headers?: Record<string, string> }).headers?.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
        const user = token ? tokenMap.get(token) : undefined;
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        (req as AuthRequest).user = {
            id: user.id, email: null, phone: null, role: user.role,
            tenantId: user.tenantId, studentEnrollmentId: user.studentEnrollmentId,
        };
        next();
    };

    let secret: string | undefined = VIEW_SECRET;
    let otpAvailable = true;
    const setSecret = (value: string | undefined) => { secret = value; };
    const setOtpAvailable = (available: boolean) => { otpAvailable = available; };
    const setAuthority = (userId: string, tenantId: string, authority: string) => {
        state.authority.set(`${userId}:${tenantId}`, authority);
    };

    const transactionalStore = createSqlParentLinksStore(db);
    // Simulated single-connection transaction: domain writes (link, view
    // token, audit) roll back together, while the OTP consumption that
    // happened before BEGIN stays consumed, exactly like the production seam.
    const transaction = async <T>(
        fn: (store: ParentLinksStore, txExecute?: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>) => Promise<T>,
    ): Promise<T> => {
        const snapshot = {
            links: state.links.map((row) => ({ ...row })),
            tokens: state.tokens.map((row) => ({ ...row })),
            audit: state.audit.map((row) => ({ params: [...row.params] })),
        };
        try {
            return await fn(transactionalStore, db.execute);
        } catch (error) {
            state.links = snapshot.links;
            state.tokens = snapshot.tokens;
            state.audit = snapshot.audit;
            throw error;
        }
    };

    const router = createParentLinksRouter({
        db,
        authenticate,
        loadActiveTenantAuthority: async (userId, tenantId) => {
            const authority = state.authority.get(`${userId}:${tenantId}`);
            return authority ? { authority } : null;
        },
        getOtpService: () => (otpAvailable ? otpService : null),
        getSecret: () => secret,
        now: () => clock.now(),
        transaction,
    });

    return { router, state, clock, sent, tokenFor, setSecret, setOtpAvailable, setAuthority, close: async () => undefined };
};

const withHarness = async <T>(seed: (state: FakeState) => void, fn: (h: Harness) => Promise<T>): Promise<T> => {
    const state = makeState();
    seed(state);
    const harness = await buildHarness(state);
    return fn(harness);
};

const request = (h: Harness, method: string, url: string, token?: string | null, body?: unknown): Promise<CapturedResponse> =>
    invokeRoute(h.router, { method, url, token, body });

// ---------------------------------------------------------------------------
// Pure domain policy
// ---------------------------------------------------------------------------

test('canonicalContact accepts an Egyptian phone and an email, rejects junk', () => {
    assert.deepEqual(canonicalContact('01000000123'), { kind: 'phone', value: '+201000000123' });
    assert.deepEqual(canonicalContact('Guardian@Example.TEST '), { kind: 'email', value: 'guardian@example.test' });
    assert.equal(canonicalContact('not-a-contact'), null);
    assert.equal(canonicalContact(''), null);
    assert.equal(canonicalContact(null), null);
    assert.equal(canonicalContact(42), null);
});

test('link request/verify validation rejects malformed payloads', () => {
    assert.equal(parseLinkRequestInput(null).ok, false);
    assert.equal(parseLinkRequestInput({}).ok, false);
    assert.equal(parseLinkRequestInput({ student_enrollment_id: 'x', contact: 'nope' }).ok, false);
    const good = parseLinkRequestInput({ student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
    assert.equal(good.ok, true);
    assert.equal(parseVerifyInput({ challenge_id: 'c', code: 'X' }).ok, false);
    assert.equal(parseVerifyInput({ challenge_id: 'c', code: 'X', student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE }).ok, true);
});

test('enrollment activity is deny-by-default', () => {
    const base: StudentContactRow = {
        id: 'e', tenant_id: TENANT, name: 'n', phone: null, email: null, guardian_phone: null, parent_phone: null,
        is_active: 1, approval_status: 'approved', enrollment_status: 'active', enrollment_start_date: null,
        enrollment_end_date: null, user_id: null, group_id: null, grade_id: null, term: null,
    };
    const now = new Date('2026-10-18T12:00:00.000Z');
    assert.equal(isStudentEnrollmentActive(base, now), true);
    assert.equal(isStudentEnrollmentActive({ ...base, is_active: 0 }, now), false);
    assert.equal(isStudentEnrollmentActive({ ...base, approval_status: 'pending' }, now), false);
    assert.equal(isStudentEnrollmentActive({ ...base, enrollment_status: 'revoked' }, now), false);
    assert.equal(isStudentEnrollmentActive({ ...base, enrollment_start_date: '2026-10-19 00:00:00' }, now), false);
    assert.equal(isStudentEnrollmentActive({ ...base, enrollment_end_date: '2026-10-18 11:00:00' }, now), false);
    assert.equal(isStudentEnrollmentActive(null, now), false);
});

test('parent view token round-trips, rejects tampering, and clamps TTL', () => {
    const claims = {
        jti: 'jti-1', link_id: 'link-1', tenant_id: TENANT,
        student_enrollment_id: ENROLLMENT, parent_user_id: PARENT,
        iat: Date.now(), exp: Date.now() + 60_000,
    };
    const token = signParentViewToken(VIEW_SECRET, claims);
    assert.deepEqual(verifyParentViewToken(VIEW_SECRET, token), { ok: true, claims });
    assert.equal(verifyParentViewToken('other-secret-000123456789abcdef', token).ok, false);
    assert.equal(verifyParentViewToken(VIEW_SECRET, `${token}x`).ok, false);
    assert.equal(normalizeParentViewTtl(undefined), 900);
    assert.equal(normalizeParentViewTtl(10_000), 900);
    assert.equal(normalizeParentViewTtl(60), 60);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('request: anonymous caller is 401 and never touches storage', async () => {
    await withHarness(seedStudent, async (h) => {
        const response = await request(h, 'POST', '/request', null, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(response.statusCode, 401);
        assert.equal(h.state.executed.length, 0);
    });
});

test('request: invalid body is 400 with no write', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        assert.equal((await request(h, 'POST', '/request', token, { student_enrollment_id: 'bad id', contact: GUARDIAN_PHONE })).statusCode, 400);
        assert.equal((await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: 'nope' })).statusCode, 400);
        assert.equal(h.state.otp.length, 0);
    });
});

test('request: unknown student and unregistered contact are 404', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        const missing = await request(h, 'POST', '/request', token, { student_enrollment_id: 'missing', contact: GUARDIAN_PHONE });
        assert.equal(missing.statusCode, 404);
        const mismatch = await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: '+201000000999' });
        assert.equal(mismatch.statusCode, 404);
        assert.equal(h.state.otp.length, 0);
    });
});

test('request: a verified contact issues one challenge whose code never leaves delivery', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        const response = await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(response.statusCode, 202);
        assert.equal(h.sent.length, 1);
        assert.equal(h.sent[0].contact, GUARDIAN_PHONE);
        assert.equal(h.sent[0].purpose, 'contact_verification');
        assert.equal((response.body as { challenge_id?: string }).challenge_id, h.state.otp[0].id);
        assert.equal(JSON.stringify(response.body).includes(h.sent[0].code), false);
    });
});

test('request: an already linked student short-circuits without a new challenge', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({
            id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT,
            contact_hash: 'hash', status: 'active', version: 0, revoked_at: null, revoked_by: null,
        });
    }, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        const response = await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(response.statusCode, 200);
        assert.equal((response.body as { already_linked?: boolean }).already_linked, true);
        assert.equal(h.state.otp.length, 0);
    });
});

test('request: a missing OTP key fails closed with 503 and writes nothing', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        h.setOtpAvailable(false);
        const response = await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(response.statusCode, 503);
        assert.equal(h.state.otp.length, 0);
    });
});

test('verify: a missing view secret fails closed with 503 after proof', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        h.setSecret(undefined);
        const response = await request(h, 'POST', '/verify', token, {
            challenge_id: h.state.otp[0].id, code: h.sent[0].code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE,
        });
        assert.equal(response.statusCode, 503);
    });
});

test('verify: wrong code is 400 and creates no link', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        const challengeId = h.state.otp[0].id;
        const response = await request(h, 'POST', '/verify', token, { challenge_id: challengeId, code: 'WRONGCOD', student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(response.statusCode, 400);
        assert.equal(h.state.links.length, 0);
    });
});

test('verify: correct code creates one link and issues a scoped token', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        const issued = await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        const challengeId = (issued.body as { challenge_id: string }).challenge_id;
        const response = await request(h, 'POST', '/verify', token, { challenge_id: challengeId, code: h.sent[0].code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(response.statusCode, 201);
        assert.equal(h.state.links.length, 1);
        const link = h.state.links[0];
        assert.equal(link.tenant_id, TENANT);
        assert.equal(link.student_enrollment_id, ENROLLMENT);
        assert.equal(link.parent_user_id, PARENT);
        assert.equal(link.status, 'active');
        assert.equal(link.version, 0);
        assert.equal(link.revoked_at, null);
        assert.equal(h.state.tokens.length, 1);
        assert.equal(typeof (response.body as { token?: string }).token, 'string');
    });
});

test('verify: a consumed challenge cannot be reused for a second link', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        const challengeId = h.state.otp[0].id;
        const first = await request(h, 'POST', '/verify', token, { challenge_id: challengeId, code: h.sent[0].code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(first.statusCode, 201);
        const replay = await request(h, 'POST', '/verify', token, { challenge_id: challengeId, code: h.sent[0].code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(replay.statusCode, 400);
        assert.equal(h.state.links.length, 1);
    });
});

test('verify: a challenge bound to another tenant is denied', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        const challengeId = h.state.otp[0].id;
        h.state.students[0].tenant_id = 'tenant-b';
        const response = await request(h, 'POST', '/verify', token, { challenge_id: challengeId, code: h.sent[0].code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        assert.equal(response.statusCode, 400);
        assert.equal(h.state.links.length, 0);
    });
});

test('list: a parent only sees their own links', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push(
            { id: 'link-a', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null },
            { id: 'link-b', tenant_id: TENANT, student_enrollment_id: 'enrollment-2', parent_user_id: OTHER_PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null },
        );
    }, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        const response = await request(h, 'GET', '/', token);
        assert.equal(response.statusCode, 200);
        const ids = (response.body as { id: string }[]).map((row) => row.id);
        assert.deepEqual(ids, ['link-a']);
    });
});

test('revoke: the owner can revoke and an already revoked link is 409', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        const first = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(first.statusCode, 200);
        assert.equal(h.state.links[0].status, 'revoked');
        assert.equal(h.state.links[0].revoked_by, PARENT);
        const second = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(second.statusCode, 409);
    });
});

test('revoke: a non-owner, non-staff, non-student gets 404', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        const token = h.tokenFor({ id: OTHER_PARENT, role: 'student' });
        const response = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(response.statusCode, 404);
        assert.equal(h.state.links[0].status, 'active');
    });
});

test('revoke: tenant staff authority can revoke', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        h.setAuthority('staff-1', TENANT, 'instructor');
        const token = h.tokenFor({ id: 'staff-1', role: 'instructor' });
        const response = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(response.statusCode, 200);
        assert.equal(h.state.links[0].status, 'revoked');
    });
});

test('revoke: the linked student can revoke', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        const token = h.tokenFor({ id: STUDENT_USER, role: 'student', tenantId: TENANT, studentEnrollmentId: ENROLLMENT });
        const response = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(response.statusCode, 200);
        assert.equal(h.state.links[0].status, 'revoked');
    });
});

test('revoke: a student of another enrollment cannot revoke', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        const token = h.tokenFor({ id: 'other-student', role: 'student', tenantId: TENANT, studentEnrollmentId: 'enrollment-2' });
        const response = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(response.statusCode, 404);
    });
});

test('session: only the owner can mint a fresh view token', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        const other = await request(h, 'POST', '/link-1/session', h.tokenFor({ id: OTHER_PARENT, role: 'student' }));
        assert.equal(other.statusCode, 404);
        const owner = await request(h, 'POST', '/link-1/session', h.tokenFor({ id: PARENT, role: 'student' }));
        assert.equal(owner.statusCode, 200);
        assert.ok((owner.body as { token?: string }).token);
        assert.equal(h.state.tokens.length, 1);
    });
});

test('session: a revoked link cannot mint a token', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'h', status: 'revoked', version: 1, revoked_at: new Date(), revoked_by: PARENT });
    }, async (h) => {
        const response = await request(h, 'POST', '/link-1/session', h.tokenFor({ id: PARENT, role: 'student' }));
        assert.equal(response.statusCode, 404);
    });
});

test('audit: creating a verified link writes exactly one audit row without contact, OTP or secret values', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        const code = h.sent[0].code;
        const response = await request(h, 'POST', '/verify', token, {
            challenge_id: h.state.otp[0].id, code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE,
        });
        assert.equal(response.statusCode, 201);
        assert.equal(h.state.audit.length, 1);
        const [id, actor, tenant, action, resourceType, resourceId, oldValue, newValue, reason] = h.state.audit[0].params;
        assert.ok(id);
        assert.equal(actor, PARENT);
        assert.equal(tenant, TENANT);
        assert.equal(action, 'parent_link.verified');
        assert.equal(resourceType, 'parent_link');
        assert.equal(resourceId, h.state.links[0].id);
        assert.equal(oldValue, null);
        assert.equal(newValue, null);
        assert.equal(reason, null);
        const serialized = JSON.stringify(h.state.audit[0].params);
        for (const forbidden of [GUARDIAN_PHONE, GUARDIAN_EMAIL, code, VIEW_SECRET, h.state.links[0].contact_hash]) {
            assert.equal(serialized.includes(forbidden), false, `audit payload must not contain ${forbidden}`);
        }
    });
});

test('audit: verifying an existing active link writes exactly one audit row and hides contact data', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        const code = h.sent[0].code;
        h.state.links.push({
            id: 'link-existing', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT,
            contact_hash: 'existing-hash', status: 'active', version: 0, revoked_at: null, revoked_by: null,
        });
        const response = await request(h, 'POST', '/verify', token, {
            challenge_id: h.state.otp[0].id, code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE,
        });
        assert.equal(response.statusCode, 200);
        assert.equal(h.state.audit.length, 1);
        assert.equal(h.state.audit[0].params[1], PARENT);
        assert.equal(h.state.audit[0].params[2], TENANT);
        assert.equal(h.state.audit[0].params[3], 'parent_link.verified');
        assert.equal(h.state.audit[0].params[4], 'parent_link');
        assert.equal(h.state.audit[0].params[5], 'link-existing');
        const serialized = JSON.stringify(h.state.audit[0].params);
        for (const forbidden of [GUARDIAN_PHONE, GUARDIAN_EMAIL, code, VIEW_SECRET, 'existing-hash']) {
            assert.equal(serialized.includes(forbidden), false, `audit payload must not contain ${forbidden}`);
        }
    });
});

test('audit: revoking a link writes exactly one audit row and a replay writes none', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'hash-1', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        const response = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(response.statusCode, 200);
        assert.equal(h.state.audit.length, 1);
        assert.equal(h.state.audit[0].params[1], PARENT);
        assert.equal(h.state.audit[0].params[2], TENANT);
        assert.equal(h.state.audit[0].params[3], 'parent_link.revoked');
        assert.equal(h.state.audit[0].params[4], 'parent_link');
        assert.equal(h.state.audit[0].params[5], 'link-1');
        const serialized = JSON.stringify(h.state.audit[0].params);
        for (const forbidden of [GUARDIAN_PHONE, GUARDIAN_EMAIL, VIEW_SECRET, 'hash-1']) {
            assert.equal(serialized.includes(forbidden), false, `audit payload must not contain ${forbidden}`);
        }
        const replay = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(replay.statusCode, 409);
        assert.equal(h.state.audit.length, 1);
    });
});

test('audit: a failed audit write rolls back a new parent link and its view token', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        h.state.failAudit = true;
        const response = await request(h, 'POST', '/verify', token, {
            challenge_id: h.state.otp[0].id, code: h.sent[0].code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE,
        });
        assert.equal(response.statusCode, 500);
        assert.equal(h.state.links.length, 0, 'the link insert must roll back with the failed audit');
        assert.equal(h.state.tokens.length, 0, 'the view token insert must roll back with the failed audit');
        assert.equal(h.state.audit.length, 0);
    });
});

test('audit: a failed audit write rolls back a view token minted for an existing link', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE });
        h.state.links.push({
            id: 'link-existing', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT,
            contact_hash: 'existing-hash', status: 'active', version: 0, revoked_at: null, revoked_by: null,
        });
        h.state.failAudit = true;
        const response = await request(h, 'POST', '/verify', token, {
            challenge_id: h.state.otp[0].id, code: h.sent[0].code, student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE,
        });
        assert.equal(response.statusCode, 500);
        assert.equal(h.state.tokens.length, 0, 'a token minted alongside a failed audit must roll back');
        assert.equal(h.state.links[0].status, 'active');
        assert.equal(h.state.audit.length, 0);
    });
});

test('audit: a failed audit write rolls back a parent-link revocation', async () => {
    await withHarness((state) => {
        seedStudent(state);
        state.links.push({ id: 'link-1', tenant_id: TENANT, student_enrollment_id: ENROLLMENT, parent_user_id: PARENT, contact_hash: 'hash-1', status: 'active', version: 0, revoked_at: null, revoked_by: null });
    }, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        h.state.failAudit = true;
        const response = await request(h, 'POST', '/link-1/revoke', token);
        assert.equal(response.statusCode, 500);
        assert.equal(h.state.links[0].status, 'active');
        assert.equal(h.state.links[0].version, 0);
        assert.equal(h.state.links[0].revoked_at, null);
        assert.equal(h.state.audit.length, 0);
    });
});

test('failure: a storage error surfaces as 500 and writes nothing unaudited', async () => {
    await withHarness(seedStudent, async (h) => {
        const token = h.tokenFor({ id: PARENT, role: 'student' });
        h.state.failWith = new Error('simulated outage');
        assert.equal((await request(h, 'POST', '/request', token, { student_enrollment_id: ENROLLMENT, contact: GUARDIAN_PHONE })).statusCode, 500);
        assert.equal((await request(h, 'GET', '/', token)).statusCode, 500);
        assert.equal((await request(h, 'POST', '/link-1/revoke', token)).statusCode, 500);
    });
});
