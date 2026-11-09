import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { Router } from 'express';
import { createStudentAccountLinkOwnerRouter, createStudentAccountLinkRequestRouter, isStudentAccountLinkEnabled } from '../src/routes/student-account-link';
import { invokeRoute } from './helpers/m2-harness';
const id = (n: number) => `b5200000-0000-4000-8000-${String(n).padStart(12, '0')}`, key = 'test-only-account-link-hmac-key-0123456789', phone = '+201012345678';
const contact = createHmac('sha256', key).update(phone).digest('hex'), inviteToken = 'a'.repeat(64), challengeId = 'b'.repeat(32);
let fixtureSequence = 0;
function fixture() {
    let data = { requests: [] as any[], operations: [] as any[], linked: false, submitted: false, audits: [] as any[], head: { head_seq: 0, head_entry_hash: null, head_row_id: null } };
    const flags = { enabled: true, schema: true, owner: true, proof: true, inviteLive: 1, proofBinding: {} as Record<string, unknown>, stale: false, wrongContact: false, occupied: false, course: false, studentChanged: false, expired: false, auditFailure: false, receiptFailure: false, requestFailure: false, lostCommit: false, commits: 0, rollbacks: 0, destroyed: 0 };
    const actor = { id: id(1), tenantId: id(2), role: 'instructor', identitySource: 'users', tokenVersion: 0 };
    const getConnection = async () => {
        let before: typeof data;
        return { beginTransaction: async () => { before = structuredClone(data); }, execute: async (sql: string, p: any[] = []) => {
                const q = sql.replace(/\s+/g, ' ').trim();
                if (q.includes('information_schema.TABLES'))
                    return [flags.schema ? ['student_account_link_requests', 'student_account_link_operations', 'identity_otp_challenges', 'student_enrollment_invites', 'students', 'users', 'tenants', 'student_courses', 'audit_events', 'audit_chain_head'].map(name => ({ name, engine: 'InnoDB' })) : [], []];
                if (q.includes('information_schema.COLUMNS')) {
                    const definitions = { student_account_link_requests: { id: ['char', 36], tenant_id: ['varchar', 64], user_id: ['varchar', 64], invite_id: ['char', 36], challenge_id: ['varchar', 64], contact_hash: ['char', 64], request_hash: ['char', 64], status: ['enum', null], expires_at: ['datetime', null], created_at: ['timestamp', null] }, student_account_link_operations: { tenant_id: ['varchar', 64], operation_id: ['char', 36], actor_user_id: ['varchar', 64], request_id: ['char', 36], student_id: ['char', 36], user_id: ['varchar', 64], request_hash: ['char', 64], created_at: ['timestamp', null] } };
                    return [Object.entries(definitions).flatMap(([tbl, fields]) => Object.entries(fields).map(([name, [type, len]]) => ({ tbl, name, type, len, nullable: 'NO', collation: 'utf8mb4_bin' }))), []];
                }
                if (q.includes('information_schema.STATISTICS'))
                    return [[...[
                                ['student_account_link_requests', 'PRIMARY', ['id']], ['student_account_link_requests', 'uq_account_link_challenge', ['challenge_id']], ['student_account_link_operations', 'PRIMARY', ['tenant_id', 'operation_id']], ['student_account_link_operations', 'uq_account_link_request', ['tenant_id', 'request_id']], ['student_account_link_operations', 'uq_account_link_student', ['tenant_id', 'student_id']],
                                ['students', 'uq_students_tenant_user', ['tenant_id', 'user_id']],
                            ].flatMap(([tbl, name, cols]) => (cols as string[]).map((col, i) => ({ tbl, name, col, seq: i + 1 })))], []];
                if (q.startsWith('SELECT t.owner_user_id'))
                    return [flags.owner && p[0] === id(2) && p[1] === id(1) ? [{ owner_user_id: id(1) }] : [], []];
                if (q.startsWith('SELECT i.id,i.tenant_id'))
                    return [[{ id: id(6), tenant_id: id(2), owner_user_id: id(1), expires_live: flags.inviteLive, revoked_at: null }], []];
                if (q.startsWith('SELECT id,phone,role,name FROM users'))
                    return [[{ id: p[0], phone, role: 'student', name: 'Account' }], []];
                if (q.startsWith('SELECT id,user_id,invite_id'))
                    return [data.requests.filter(r => r.id === p[0] && r.tenant_id === p[1]), []];
                if (q.startsWith('SELECT id,status,(expires_at>UTC_TIMESTAMP()) AS expires_live FROM student_account_link_requests'))
                    return [data.requests.filter(r => r.tenant_id === p[0] && r.user_id === p[1] && r.invite_id === p[2]).slice(-1), []];
                if (q.startsWith('SELECT id FROM students WHERE tenant_id'))
                    return [flags.occupied || data.linked ? [{ id: id(4) }] : [], []];
                if (q.startsWith('SELECT r.id FROM student_account_link_requests'))
                    return [data.requests.filter(r => r.tenant_id === p[0] && r.user_id === p[1] && r.status === 'pending'), []];
                if (q.startsWith('SELECT id,contact_hash'))
                    return [flags.proof ? [{ id: challengeId, contact_hash: contact, purpose: 'enrollment_join', tenant_id: id(2), identity_id: null, consumed_at: new Date(), submitted_at: data.submitted ? new Date() : null, expires_at: new Date(Date.now() + 100000), ...flags.proofBinding }] : [], []];
                if (q.startsWith('UPDATE identity_otp_challenges')) {
                    const affectedRows = data.submitted ? 0 : 1;
                    data.submitted = true;
                    return [{ affectedRows }, []];
                }
                if (q.startsWith('INSERT INTO student_account_link_requests')) {
                    if (flags.requestFailure)
                        throw Error('request failure');
                    data.requests.push({ id: p[0], tenant_id: p[1], user_id: p[2], invite_id: p[3], challenge_id: p[4], contact_hash: p[5], request_hash: p[6], status: 'pending', expires_live: 1 });
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('SELECT operation_id,actor_user_id'))
                    return [data.operations.filter(r => r.tenant_id === p[0] && r.operation_id === p[1]), []];
                if (q.startsWith('SELECT r.id,r.user_id,r.contact_hash')) {
                    const r = data.requests.find(r => r.id === p[0] && r.tenant_id === p[1] && r.status === 'pending');
                    return [r && !flags.expired ? [{ ...r, name: 'Account', phone, token_version: 0, expires_epoch: 1893456000 }] : [], []];
                }
                if (q.startsWith('SELECT s.id,s.name,s.phone'))
                    return [flags.studentChanged || data.linked || p[0] !== id(4) ? [] : [{ id: id(4), name: flags.stale ? 'Changed original record' : 'Original record', phone: flags.wrongContact ? '+201099999999' : phone, is_offline: 0, updated_epoch: 1 }], []];
                if (q.startsWith('SELECT course_id FROM student_courses'))
                    return [flags.course ? [{ course_id: id(8) }] : [], []];
                if (q.startsWith('UPDATE students SET user_id')) {
                    data.linked = true;
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('UPDATE student_account_link_requests SET')) {
                    const r = data.requests.find(r => r.id === p[0]);
                    if (!r)
                        return [{ affectedRows: 0 }, []];
                    r.status = q.includes("status='withdrawn'") ? 'withdrawn' : 'linked';
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('SELECT head_seq'))
                    return [[{ ...data.head }], []];
                if (q.startsWith('INSERT INTO audit_events')) {
                    if (flags.auditFailure)
                        throw Error('audit failure');
                    data.audits.push(p);
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('UPDATE audit_chain_head')) {
                    data.head = { head_seq: p[0], head_entry_hash: p[1], head_row_id: p[2] };
                    return [{ affectedRows: 1 }, []];
                }
                if (q.startsWith('INSERT INTO student_account_link_operations')) {
                    if (flags.receiptFailure)
                        throw Error('receipt failure');
                    data.operations.push(Object.fromEntries(['tenant_id', 'operation_id', 'actor_user_id', 'request_id', 'student_id', 'user_id', 'request_hash'].map((k, i) => [k, p[i]])));
                    return [{ affectedRows: 1 }, []];
                }
                throw Error('Unexpected SQL ' + q);
            }, commit: async () => {
                flags.commits++;
                if (flags.lostCommit)
                    throw Error('lost ack');
            }, rollback: async () => { flags.rollbacks++; data = before; }, release: () => { }, destroy: () => { flags.destroyed++; } };
    };
    const fixtureAddress = 'hermetic-link-' + (++fixtureSequence);
    const principal = Router();
    principal.use((req, res, next) => { (req as any).user = actor; (req as any).ip = fixtureAddress; (res as any).setHeader = (k: string, v: string) => (res as any).set(k, v); next(); });
    principal.use(createStudentAccountLinkOwnerRouter({ getConnection, otpKey: () => key, enabled: () => flags.enabled }));
    principal.use(createStudentAccountLinkRequestRouter({ getConnection, otpKey: () => key, enabled: () => flags.enabled, authenticate: (_req, _res, next) => next() }));
    const request = (url: string, body?: unknown) => invokeRoute(principal, { method: body ? 'POST' : 'GET', url, body });
    const submit = async () => { actor.id = id(3); actor.role = 'student'; const body = { operation_id: id(7), otp_challenge_id: challengeId, confirmed: true }; const r = await request('/join/' + inviteToken + '/account-link', body); assert.equal(r.statusCode, 201, JSON.stringify(r.body)); actor.id = id(1); actor.role = 'instructor'; return body; };
    const review = async () => { const r = await request('/account-link/review', { request_id: id(7), student_id: id(4) }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return { request_id: id(7), student_id: id(4), operation_id: id(9), review_token: (r.body as any).review_token, confirmed: true }; };
    return { flags, actor, request, submit, review, data: () => data };
}
test('student consumes bound proof and writes request plus sealed audit atomically; exact replay does not reuse OTP', async () => {
    const h = fixture(), body = await h.submit();
    assert.equal(h.data().submitted, true);
    assert.equal(h.data().requests.length, 1);
    assert.equal(h.data().linked, false);
    h.actor.id = id(3);
    h.actor.role = 'student';
    assert.equal((await h.request('/join/' + inviteToken + '/account-link', body)).statusCode, 200);
    assert.equal(h.data().audits.length, 1);
});
test('absent verification, wrong role, extra authority and already-used proof never create link request', async () => {
    for (const mode of ['proof', 'role', 'extra', 'consumed']) {
        const h = fixture();
        h.actor.id = id(3);
        h.actor.role = mode === 'role' ? 'instructor' : 'student';
        if (mode === 'proof')
            h.flags.proof = false;
        if (mode === 'consumed')
            h.data().submitted = true;
        const r = await h.request('/join/' + inviteToken + '/account-link', { operation_id: id(7), otp_challenge_id: challengeId, confirmed: true, ...mode === 'extra' ? { tenant_id: id(2) } : {} });
        assert.ok([400, 403].includes(r.statusCode!));
        assert.equal(h.data().requests.length, 0);
        assert.equal(h.flags.commits, 0);
    }
});
test('request/audit failure rolls back OTP submission so a failed transaction does not consume consent', async () => {
    for (const mode of ['request', 'audit']) {
        const h = fixture();
        h.actor.id = id(3);
        h.actor.role = 'student';
        if (mode === 'request')
            h.flags.requestFailure = true;
        else
            h.flags.auditFailure = true;
        assert.equal((await h.request('/join/' + inviteToken + '/account-link', { operation_id: id(7), otp_challenge_id: challengeId, confirmed: true })).statusCode, 503);
        assert.equal(h.data().submitted, false);
        assert.equal(h.data().requests.length, 0);
        assert.equal(h.data().audits.length, 0);
    }
});
test('owner review links original row only, updates request, seals and saves one receipt; replay and GET are historical', async () => {
    const h = fixture();
    await h.submit();
    const body = await h.review();
    assert.equal((await h.request('/account-link/apply', body)).statusCode, 201);
    assert.equal(h.data().linked, true);
    assert.equal(h.data().requests[0].status, 'linked');
    assert.equal(h.data().operations.length, 1);
    assert.equal(h.data().audits.length, 2);
    assert.equal((await h.request('/account-link/apply', body)).statusCode, 200);
    assert.equal((await h.request('/account-link/apply', Object.fromEntries(Object.entries(body).reverse()))).statusCode, 200);
    assert.equal((await h.request('/account-link/operations/' + id(9))).statusCode, 200);
    assert.equal((await h.request('/account-link/apply', { ...body, student_id: id(10) })).statusCode, 409);
    h.flags.enabled = false;
    assert.equal((await h.request('/account-link/operations/' + id(9))).statusCode, 200);
});
test('contact/record/assignment/request/owner/schema changes after review fail closed without a link', async () => {
    for (const mode of ['contact', 'student', 'stale', 'course', 'occupied', 'expiry', 'owner', 'schema']) {
        const h = fixture();
        await h.submit();
        const body = await h.review();
        if (mode === 'contact')
            h.flags.wrongContact = true;
        if (mode === 'student')
            h.flags.studentChanged = true;
        if (mode === 'stale')
            h.flags.stale = true;
        if (mode === 'course')
            h.flags.course = true;
        if (mode === 'occupied')
            h.flags.occupied = true;
        if (mode === 'expiry')
            h.flags.expired = true;
        if (mode === 'owner')
            h.flags.owner = false;
        if (mode === 'schema')
            h.flags.schema = false;
        assert.notEqual((await h.request('/account-link/apply', body)).statusCode, 201);
        assert.equal(h.data().linked, false);
        assert.equal(h.data().operations.length, 0);
    }
});
test('failure of owner audit or receipt rolls back same-row link, request and chain reservation', async () => {
    for (const mode of ['audit', 'receipt']) {
        const h = fixture();
        await h.submit();
        const body = await h.review(), head = h.data().head.head_seq;
        if (mode === 'audit')
            h.flags.auditFailure = true;
        else
            h.flags.receiptFailure = true;
        assert.equal((await h.request('/account-link/apply', body)).statusCode, 503);
        assert.equal(h.data().linked, false);
        assert.equal(h.data().requests[0].status, 'pending');
        assert.equal(h.data().operations.length, 0);
        assert.equal(h.data().head.head_seq, head);
    }
});
test('unknown owner COMMIT destroys connection without rollback; GET can recover committed receipt', async () => {
    const h = fixture();
    await h.submit();
    const body = await h.review(), rollbacks = h.flags.rollbacks;
    h.flags.lostCommit = true;
    assert.equal((await h.request('/account-link/apply', body)).statusCode, 500);
    assert.equal(h.flags.rollbacks, rollbacks);
    assert.equal(h.flags.destroyed, 1);
    assert.equal((await h.request('/account-link/operations/' + id(9))).statusCode, 200);
});
test('student can withdraw their pending consent and owner cannot subsequently link it', async () => {
    const h = fixture();
    await h.submit();
    const body = await h.review();
    h.actor.id = id(3);
    h.actor.role = 'student';
    const path = '/join/' + inviteToken + '/account-link/' + id(7) + '/withdraw';
    assert.equal((await h.request(path, { confirmed: true })).statusCode, 200);
    assert.equal(h.data().requests[0].status, 'withdrawn');
    assert.equal((await h.request(path, { confirmed: true })).statusCode, 200);
    h.actor.id = id(1);
    h.actor.role = 'instructor';
    assert.equal((await h.request('/account-link/apply', body)).statusCode, 409);
    assert.equal(h.data().linked, false);
});
test('purpose, tenant, contact, identity, expiration and missing-consumption proof mismatches reject requests', async () => {
    for (const binding of [{ purpose: 'password_recovery' }, { tenant_id: id(99) }, { contact_hash: '0'.repeat(64) }, { identity_id: id(3) }, { expires_at: new Date(0) }, { consumed_at: null }]) {
        const h = fixture();
        h.actor.id = id(3);
        h.actor.role = 'student';
        h.flags.proofBinding = binding;
        assert.equal((await h.request('/join/' + inviteToken + '/account-link', { operation_id: id(7), otp_challenge_id: challengeId, confirmed: true })).statusCode, 403);
        assert.equal(h.data().submitted, false);
        assert.equal(h.data().requests.length, 0);
    }
});
test('current-request read reports expiration and foreign account cannot recover or withdraw consent', async () => {
    const h = fixture();
    await h.submit();
    h.actor.id = id(3);
    h.actor.role = 'student';
    h.data().requests[0].expires_live = 0;
    let r = await h.request('/join/' + inviteToken + '/account-link');
    assert.equal((r.body as any).request.state, 'expired');
    h.actor.id = id(99);
    r = await h.request('/join/' + inviteToken + '/account-link/' + id(7));
    assert.equal(r.statusCode, 409);
    assert.equal((await h.request('/join/' + inviteToken + '/account-link/' + id(7) + '/withdraw', { confirmed: true })).statusCode, 409);
    assert.equal(h.data().requests[0].status, 'pending');
});
test('database expiry projection rejects expired or missing invitation validity without a Date fallback', async () => {
    for (const validity of [0, Number.NaN]) {
        const h = fixture();
        h.actor.id = id(3);
        h.actor.role = 'student';
        h.flags.inviteLive = validity;
        const response = await h.request('/join/' + inviteToken + '/account-link', { operation_id: id(7), otp_challenge_id: challengeId, confirmed: true });
        assert.equal(response.statusCode, 404);
        assert.equal(h.data().submitted, false);
        assert.equal(h.data().requests.length, 0);
    }
    const h = fixture();
    await h.submit();
    h.actor.id = id(3);
    h.actor.role = 'student';
    h.flags.inviteLive = 0;
    assert.equal(((await h.request('/join/' + inviteToken + '/account-link')).body as any).request.state, 'expired');
});
test('linking flag is explicit true only; deferred discovery works without link schema and new writes consume no proof', async () => {
    for (const value of ['', 'false', '1', 'TRUE', 'yes'])
        assert.equal(isStudentAccountLinkEnabled(value), false);
    assert.equal(isStudentAccountLinkEnabled('true'), true);
    const h = fixture();
    h.flags.enabled = false;
    h.flags.schema = false;
    const capability = await h.request('/account-link/capabilities');
    assert.equal(capability.statusCode, 200);
    assert.deepEqual(capability.body, { state: 'deferred' });
    assert.deepEqual((await h.request('/account-link-capabilities')).body, { state: 'deferred' });
    assert.equal((await h.request('/account-link/students')).statusCode, 409);
    h.actor.id = id(3);
    h.actor.role = 'student';
    assert.equal((await h.request('/join/' + inviteToken + '/account-link', { operation_id: id(7), otp_challenge_id: challengeId, confirmed: true })).statusCode, 409);
    assert.equal(h.data().submitted, false);
    assert.equal(h.data().requests.length, 0);
});
test('deferred flag keeps receipt reads and pending-consent withdrawal available; enabling it still requires proof', async () => {
    const h = fixture();
    await h.submit();
    const body = await h.review();
    h.flags.enabled = false;
    assert.equal((await h.request('/account-link/apply', body)).statusCode, 409);
    assert.equal(h.data().linked, false);
    h.actor.id = id(3);
    h.actor.role = 'student';
    assert.equal(((await h.request('/join/' + inviteToken + '/account-link/' + id(7))).body as any).request.state, 'pending');
    assert.equal((await h.request('/join/' + inviteToken + '/account-link/' + id(7) + '/withdraw', { confirmed: true })).statusCode, 200);
    const noProof = fixture();
    noProof.flags.proof = false;
    noProof.actor.id = id(3);
    noProof.actor.role = 'student';
    assert.equal((await noProof.request('/join/' + inviteToken + '/account-link', { operation_id: id(7), otp_challenge_id: challengeId, confirmed: true })).statusCode, 403);
});
