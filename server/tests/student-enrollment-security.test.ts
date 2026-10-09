import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEgyptianPhone, phoneLookupCandidates } from '../src/security/phone';

test('Egyptian mobile numbers normalize to a single E.164 identity', () => {
  assert.equal(normalizeEgyptianPhone('010 1234 5678'), '+201012345678');
  assert.equal(normalizeEgyptianPhone('201012345678'), '+201012345678');
  assert.equal(normalizeEgyptianPhone('+20 (10) 1234-5678'), '+201012345678');
});

test('invalid and non-Egyptian identifiers are rejected', () => {
  assert.equal(normalizeEgyptianPhone('12345'), null);
  assert.equal(normalizeEgyptianPhone('+14155552671'), null);
});

test('legacy phone lookup candidates support migration without changing identity', () => {
  assert.deepEqual(phoneLookupCandidates('01012345678'), ['+201012345678', '01012345678', '201012345678']);
});
