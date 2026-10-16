import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTxtRecordName,
  buildTxtRecordValue,
  canClaimDomain,
  createMemoryDomainClaimStore,
  createSqlDomainClaimStore,
  generateVerificationToken,
  normalizeHostname,
  txtRecordsProveOwnership,
  validateCustomHostname,
  verifyDomainOwnership,
  type DomainClaimDb,
  type HostnameRejectCode,
  type TxtResolver,
} from '../src/services/domain-verification';

function codeOf(raw: unknown): HostnameRejectCode | 'OK' {
  const r = validateCustomHostname(raw);
  return r.ok ? 'OK' : r.code;
}

test('accepts and canonicalizes valid public hostnames', () => {
  assert.deepEqual(validateCustomHostname('Academy.Example-School.COM.'), {
    ok: true,
    hostname: 'academy.example-school.com',
  });
  assert.deepEqual(validateCustomHostname('  learn.school.io '), { ok: true, hostname: 'learn.school.io' });
});

test('rejects non-string and empty input', () => {
  for (const v of [undefined, null, 42, {}, '', '   ']) assert.equal(codeOf(v), 'EMPTY');
  assert.equal(normalizeHostname(5), null);
  assert.equal(codeOf('.'), 'TOO_LONG');
});

test('rejects IP literals in all common shapes', () => {
  for (const v of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '8.8.8.8', '999.1.1.1', '::1', '[::1]', '2001:db8::1', '::ffff:127.0.0.1']) {
    assert.equal(codeOf(v), 'IP_ADDRESS', v);
  }
  for (const v of ['2130706433', '0x7f.0.0.1', '127.1', '0177.0.0.1.']) {
    assert.notEqual(codeOf(v), 'OK', v);
  }
});

test('rejects host:port and URL-shaped input', () => {
  for (const v of ['example.com:8080', 'https://example.com', 'example.com/path', 'user@example.com']) {
    assert.equal(codeOf(v), 'INVALID_CHARACTERS', v);
  }
});

test('rejects localhost and internal TLDs', () => {
  for (const v of ['localhost', 'LOCALHOST', 'app.localhost', 'localhost.']) assert.equal(codeOf(v), 'LOCALHOST', v);
  for (const v of ['printer.local', 'db.internal', 'a.lan', 'x.corp', 'x.home', 'a.example', 'a.test', 'a.invalid', 'a.onion', 'host.localdomain']) {
    assert.equal(codeOf(v), 'INTERNAL_TLD', v);
  }
});

test('rejects reserved first labels but allows them deeper', () => {
  for (const v of ['admin.school.com', 'api.school.com', 'root.school.com', 'support.school.com', 'platform.school.com']) {
    assert.equal(codeOf(v), 'RESERVED_SUBDOMAIN', v);
  }
  assert.equal(codeOf('academy.admin.school.com'), 'OK');
});

test('rejects punycode and unicode abuse, including case-fold homographs', () => {
  assert.equal(codeOf('xn--e1afmkfd.com'), 'PUNYCODE');
  assert.equal(codeOf('sub.xn--80ak6aa92e.com'), 'PUNYCODE');
  assert.equal(codeOf('XN--abc.com'), 'PUNYCODE');
  assert.equal(codeOf('пример.com'), 'PUNYCODE');
  assert.equal(codeOf('exаmple.com'), 'PUNYCODE'); // Cyrillic a
  // KELVIN SIGN lowercases to ASCII "k": must not silently alias "kbank.com".
  assert.equal(codeOf('Kbank.com'), 'PUNYCODE');
  assert.equal(codeOf('exam​ple.com'), 'PUNYCODE');
});

test('rejects malformed names', () => {
  assert.equal(codeOf('exa mple.com'), 'INVALID_CHARACTERS');
  assert.equal(codeOf('exa_mple.com'), 'INVALID_CHARACTERS');
  assert.equal(codeOf('a..com'), 'BAD_LABEL');
  assert.equal(codeOf('.example.com'), 'BAD_LABEL');
  assert.equal(codeOf('-a.example.com'), 'BAD_LABEL');
  assert.equal(codeOf('a-.example.com'), 'BAD_LABEL');
  assert.equal(codeOf('example.com..'), 'BAD_LABEL');
  assert.equal(codeOf('intranet'), 'SINGLE_LABEL');
  assert.equal(codeOf('example.c'), 'BAD_TLD');
  assert.equal(codeOf('example.123'), 'BAD_TLD');
  assert.equal(codeOf(`${'a'.repeat(64)}.com`), 'BAD_LABEL');
  assert.equal(codeOf(`${'a'.repeat(63)}.com`), 'OK');
  assert.equal(codeOf(`${'a.'.repeat(130)}com`), 'TOO_LONG');
});

test('verification tokens are random 64-hex and challenge format is stable', () => {
  const a = generateVerificationToken();
  const b = generateVerificationToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(generateVerificationToken(() => Buffer.alloc(32, 0xab)), 'ab'.repeat(32));
  assert.equal(buildTxtRecordName('school.com'), '_tabweb-verify.school.com');
  assert.equal(buildTxtRecordValue('t0k'), 'tabweb-verify=t0k');
});

test('txtRecordsProveOwnership requires exact match', () => {
  assert.equal(txtRecordsProveOwnership(['tabweb-verify=tok'], 'tok'), true);
  assert.equal(txtRecordsProveOwnership([['tabweb-', 'verify=tok']], 'tok'), true);
  assert.equal(txtRecordsProveOwnership(['"tabweb-verify=tok"'], 'tok'), true);
  assert.equal(txtRecordsProveOwnership(['  tabweb-verify=tok  '], 'tok'), true);
  assert.equal(txtRecordsProveOwnership(['v=spf1', 'tabweb-verify=tok'], 'tok'), true);
  assert.equal(txtRecordsProveOwnership(['tabweb-verify=tok2'], 'tok'), false);
  assert.equal(txtRecordsProveOwnership(['x tabweb-verify=tok'], 'tok'), false);
  assert.equal(txtRecordsProveOwnership(['tabweb-verify=TOK'], 'tok'), false);
  assert.equal(txtRecordsProveOwnership([], 'tok'), false);
});

test('empty expected token never verifies', () => {
  assert.equal(txtRecordsProveOwnership(['tabweb-verify='], ''), false);
});

test('verifyDomainOwnership uses fake resolver and queries the challenge name', async () => {
  const seen: string[] = [];
  const resolveTxt: TxtResolver = async (fqdn) => {
    seen.push(fqdn);
    return [['tabweb-verify=', 'tok']];
  };
  const r = await verifyDomainOwnership({ hostname: 'School.com', expectedToken: 'tok', resolveTxt });
  assert.deepEqual(r, { verified: true });
  assert.deepEqual(seen, ['_tabweb-verify.school.com']);
});

test('verifyDomainOwnership fails closed on mismatch, DNS error and invalid host', async () => {
  const mismatch = await verifyDomainOwnership({
    hostname: 'school.com',
    expectedToken: 'tok',
    resolveTxt: async () => ['tabweb-verify=other'],
  });
  assert.deepEqual(mismatch, { verified: false, reason: 'TXT_MISMATCH' });

  const failing = await verifyDomainOwnership({
    hostname: 'school.com',
    expectedToken: 'tok',
    resolveTxt: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.deepEqual(failing, { verified: false, reason: 'DNS_LOOKUP_FAILED' });

  let called = false;
  const invalid = await verifyDomainOwnership({
    hostname: '127.0.0.1',
    expectedToken: 'tok',
    resolveTxt: async () => {
      called = true;
      return ['tabweb-verify=tok'];
    },
  });
  assert.deepEqual(invalid, { verified: false, reason: 'INVALID_HOSTNAME' });
  assert.equal(called, false);
});

test('canClaimDomain denies any other tenant, pending or verified', async () => {
  const store = createMemoryDomainClaimStore();
  assert.deepEqual(canClaimDomain(await store.findByHostname('school.com'), 'A'), { allowed: true });
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 'A', token: 't1', txtName: '_tabweb-verify.school.com' });
  const pending = await store.findByHostname('school.com');
  assert.deepEqual(canClaimDomain(pending, 'A'), { allowed: true });
  assert.deepEqual(canClaimDomain(pending, 'B'), { allowed: false, reason: 'CLAIMED_BY_ANOTHER_TENANT' });
  await store.markVerified('school.com', 'A');
  assert.deepEqual(canClaimDomain(await store.findByHostname('school.com'), 'B'), {
    allowed: false,
    reason: 'CLAIMED_BY_ANOTHER_TENANT',
  });
});

test('memory store: cross-tenant overwrite, verify and delete are blocked', async () => {
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 'A', token: 't1', txtName: 'n' });
  await store.markVerified('school.com', 'A');

  await assert.rejects(store.savePendingClaim({ hostname: 'school.com', tenantId: 'B', token: 't2', txtName: 'n' }));
  assert.equal(await store.markVerified('school.com', 'B'), null);
  assert.equal(await store.deleteClaim('school.com', 'B'), false);

  const kept = await store.findByHostname('school.com');
  assert.equal(kept?.tenantId, 'A');
  assert.equal(kept?.status, 'verified');
  assert.equal(kept?.token, 't1');
  assert.deepEqual(await store.listByTenant('B'), []);
  assert.equal((await store.listByTenant('A')).length, 1);
});

test('memory store: same tenant refresh resets to pending, preserves createdAt', async () => {
  const store = createMemoryDomainClaimStore();
  const first = await store.savePendingClaim({ hostname: 'school.com', tenantId: 'A', token: 't1', txtName: 'n' });
  await store.markVerified('school.com', 'A');
  const again = await store.savePendingClaim({ hostname: 'school.com', tenantId: 'A', token: 't2', txtName: 'n' });
  assert.equal(again.status, 'pending');
  assert.equal(again.verifiedAt, null);
  assert.equal(again.token, 't2');
  assert.equal(again.createdAt, first.createdAt);
  assert.equal(await store.deleteClaim('school.com', 'A'), true);
  assert.equal(await store.findByHostname('school.com'), null);
});

test('memory store returns copies, not live references', async () => {
  const store = createMemoryDomainClaimStore();
  const c = await store.savePendingClaim({ hostname: 'school.com', tenantId: 'A', token: 't1', txtName: 'n' });
  c.tenantId = 'B';
  assert.equal((await store.findByHostname('school.com'))?.tenantId, 'A');
});

test('sql store: upsert cannot steal or reset another tenant claim; mutations are tenant scoped', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: DomainClaimDb = {
    queryOne: async <T,>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return null as T | null;
    },
    query: async <T,>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [] as T[];
    },
    execute: async (sql, params = []) => {
      calls.push({ sql, params });
      return { affectedRows: 0 };
    },
  };
  const store = createSqlDomainClaimStore(db);

  await assert.rejects(store.savePendingClaim({ hostname: 'school.com', tenantId: 'B', token: 't', txtName: 'n' }));
  const upsert = calls[0].sql;
  assert.match(upsert, /ON DUPLICATE KEY UPDATE/);
  assert.doesNotMatch(upsert, /\n\s*tenant_id=/); // tenant_id is never reassigned
  for (const col of ['verification_token', 'status', 'verified_at', 'txt_name']) {
    assert.match(upsert, new RegExp(`${col}=IF\\(tenant_id=VALUES\\(tenant_id\\)`), col);
  }

  assert.equal(await store.markVerified('school.com', 'B'), null);
  assert.match(calls[calls.length - 2].sql, /WHERE hostname=\? AND tenant_id=\?/);
  assert.deepEqual(calls[calls.length - 2].params, ['school.com', 'B']);
  assert.equal(await store.deleteClaim('school.com', 'B'), false);
  assert.deepEqual(calls[calls.length - 1].params, ['school.com', 'B']);
});
