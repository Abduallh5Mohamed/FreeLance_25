import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cairoDisplay, parseReleaseInstant, parseTiming, renderReleaseInstant, timingEpoch, timingReview,
} from '../src/services/lesson-package-timing';

test('release instants accept only canonical explicit UTC values', () => {
  assert.equal(parseReleaseInstant('2026-11-10T18:00:00Z'), 1_794_333_600);
  assert.equal(parseReleaseInstant('2026-11-10T18:00:00.500Z'), 1_794_333_600);
  for (const raw of ['2026-11-10T18:00:00+02:00', '2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-11-10T24:00:00Z', '2026-11-10 18:00:00Z', '', null, 12])
    assert.equal(parseReleaseInstant(raw), null);
  assert.equal(renderReleaseInstant(null), null);
  assert.equal(renderReleaseInstant(undefined), null);
  assert.equal(renderReleaseInstant(1_794_333_600), '2026-11-10T18:00:00.000Z');
  assert.equal(renderReleaseInstant(0), undefined);
  assert.equal(renderReleaseInstant(2_147_483_648), undefined);
  assert.equal(renderReleaseInstant('1_794_333_600'), undefined);
});

test('timing bodies are exact and normalize to canonical UTC', () => {
  assert.deepEqual(parseTiming({ mode: 'keep' }), { mode: 'keep', release_at: null });
  assert.deepEqual(parseTiming({ mode: 'keep', release_at: null }), { mode: 'keep', release_at: null });
  assert.equal(parseTiming({ mode: 'keep', release_at: '2026-11-10T18:00:00Z' }), null);
  assert.deepEqual(parseTiming({ mode: 'clear', release_at: null }), { mode: 'clear', release_at: null });
  assert.equal(parseTiming({ mode: 'clear' }), null);
  assert.equal(parseTiming({ mode: 'clear', release_at: '2026-11-10T18:00:00Z' }), null);
  assert.deepEqual(parseTiming({ mode: 'set', release_at: '2026-11-10T18:00:00Z' }), { mode: 'set', release_at: '2026-11-10T18:00:00.000Z' });
  assert.equal(parseTiming({ mode: 'set' }), null);
  assert.equal(parseTiming({ mode: 'set', release_at: null }), null);
  assert.equal(parseTiming({ mode: 'set', release_at: '2026-11-10T18:00:00+02:00' }), null);
  assert.equal(parseTiming({ mode: 'set', release_at: '2026-11-10T18:00:00Z', extra: 1 }), null);
  assert.equal(parseTiming({ mode: 'later', release_at: null }), null);
  assert.equal(parseTiming(null), null);
});

test('effective timing never changes an unrelated instant in keep mode', () => {
  const current = 1_794_333_600;
  assert.equal(timingEpoch({ mode: 'keep', release_at: null }, current), current);
  assert.equal(timingEpoch({ mode: 'keep', release_at: null }, null), null);
  assert.equal(timingEpoch({ mode: 'clear', release_at: null }, current), null);
  assert.equal(timingEpoch({ mode: 'set', release_at: '2026-12-01T10:00:00Z' }, current), 1_796_119_200);
  assert.deepEqual(timingReview({ mode: 'set', release_at: '2026-12-01T10:00:00Z' }, current), {
    mode: 'set', current_release_at: '2026-11-10T18:00:00.000Z', proposed_release_at: '2026-12-01T10:00:00.000Z',
  });
});

test('Cairo display is a label only and never feeds validation', () => {
  const label = cairoDisplay('2026-11-10T18:00:00.000Z');
  assert.match(label as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.notEqual(label, '2026-11-10 18:00');
  assert.equal(cairoDisplay(null), null);
  assert.equal(cairoDisplay('not-a-date'), null);
});
