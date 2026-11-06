import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
const require = Module.createRequire(import.meta.url);
import { cairoLabel, canonicalTiming, parseTimingInstant, timingLabel } from '../features/catalog/lesson-template-timing';
import { LessonTemplateTiming } from '../features/catalog/LessonTemplateTiming';

test('client timing validation accepts only explicit UTC and normalizes it', () => {
  assert.equal(parseTimingInstant('2026-11-10T18:00:00Z'), '2026-11-10T18:00:00.000Z');
  assert.equal(parseTimingInstant('2026-11-10T18:00:00.500Z'), '2026-11-10T18:00:00.000Z');
  assert.equal(parseTimingInstant(null), null);
  assert.equal(parseTimingInstant(''), null);
  for (const raw of ['2026-11-10T18:00:00+02:00', '2026-02-30T10:00:00Z', '2026-11-10 18:00:00Z', '2026-13-01T10:00:00Z', '2026-11-10T18:60:00Z', '2026-11-10T18:00:60Z', '2040-01-01T00:00:00Z', 'not-a-date'])
    assert.equal(parseTimingInstant(raw), undefined);
  assert.deepEqual(canonicalTiming('keep', 'ignored'), { mode: 'keep', release_at: null });
  assert.deepEqual(canonicalTiming('clear', '2026-11-10T18:00:00Z'), { mode: 'clear', release_at: null });
  assert.deepEqual(canonicalTiming('set', '2026-11-10T18:00:00Z'), { mode: 'set', release_at: '2026-11-10T18:00:00.000Z' });
  assert.throws(() => canonicalTiming('set', null));
  assert.throws(() => canonicalTiming('set', '2026-11-10T18:00:00+02:00'));
});

test('Cairo labels are display-only and clear timing says so', () => {
  assert.match(cairoLabel('2026-11-10T18:00:00.000Z') as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(cairoLabel(null), null);
  assert.match(timingLabel(null), /بلا جدولة/);
  assert.match(timingLabel('2026-11-10T18:00:00.000Z'), /UTC/);
});

function find(node: any, predicate: (props: any) => boolean): any {
  if (!node || typeof node !== 'object') return null;
  if (node.props && predicate(node.props)) return node;
  for (const child of [node.props?.children].flat(6)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

test('actual timing editor exposes explicit UTC input and never silently invents a mode', () => {
  (globalThis as any).React = require('react');
  const changes: any[] = [];
  const tree = LessonTemplateTiming({
    value: { mode: 'set', release_at: '2026-11-10T18:00:00Z' },
    onChange: next => changes.push(next),
    review: { mode: 'keep', current_release_at: null, proposed_release_at: null },
    disabled: false,
  });
  const input = find(tree, props => props['aria-label'] === 'وقت الإتاحة UTC');
  assert.ok(input);
  input.props.onChange({ target: { value: '2026-12-01T10:00:00Z' } });
  assert.deepEqual(changes.at(-1), { mode: 'set', release_at: '2026-12-01T10:00:00Z' });
  const radios = find(tree, props => props.type === 'radio' && props.checked === false);
  assert.ok(radios);
  radios.props.onChange();
  assert.ok(changes.at(-1).mode === 'keep' || changes.at(-1).mode === 'clear');
  const disabledTree = LessonTemplateTiming({
    value: { mode: 'keep', release_at: null }, onChange: () => { }, review: null, disabled: true,
  });
  assert.equal(find(disabledTree, props => props['aria-label'] === 'توقيت إتاحة الحصة الوجهة').props.disabled, true);
});
