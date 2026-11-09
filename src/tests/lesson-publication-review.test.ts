import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicationReview, initialPublicationReview, reviewLessonPublication } from '../features/catalog/lesson-publication-review';
import type { PackageSnapshot } from '../features/catalog/lesson-package-preview';
const snapshot = (): PackageSnapshot => ({ materials: [{ content_id: 'm1', material_id: 'm2', title: 'PDF', material_type: 'pdf', display_order: 0 }],
  videos: [{ content_id: 'v1', video_id: 'v2', title: 'Video', video_status: 'ready', display_order: 1 }],
  activities: [{ content_id: 'q1', source_id: 'q2', kind: 'quiz', title: 'Quiz', source_status: 'published', audience: 'restricted' },
    { content_id: 'h1', source_id: 'h2', kind: 'homework', title: 'Homework', source_status: 'draft', audience: 'course' }],
  quizPin: { content_id: 'q1', exam_version_id: 'q3', version_number: 1, status: 'published' },
  announcement: { content_id: 'a1', source_id: 'a2', title: 'Announcement', source_state: 'published', group_id: 'g', group_name: 'Group', student_visibility: 'unconfigured' } });
test('mixed review never equates processing/publication with delivery and distinguishes draft, audience and immutable quiz pin', () => {
  const rows = reviewLessonPublication(snapshot());
  assert.equal(rows.length, 5); assert.equal(rows.filter(r => r.state === 'blocked').length, 1);
  assert.ok(rows.every(r => ['blocked', 'review'].includes(r.state)));
  assert.match(rows.find(r => r.kind === 'video')!.notes.join(' '), /جلسة طالب/);
  assert.match(rows.find(r => r.kind === 'quiz')!.notes.join(' '), /جمهور مقيد/);
  assert.match(rows.find(r => r.kind === 'material')!.notes.join(' '), /تحققًا مستقلًا/);
  assert.match(rows.find(r => r.kind === 'announcement')!.notes.join(' '), /لا يثبت الوصول/);
});
test('missing/mismatched quiz pin, unavailable source and processing video are blockers rather than empty successful references', () => {
  const s = snapshot(); s.quizPin = null; s.videos[0].video_status = 'processing';
  s.announcement!.source_state = 'unavailable'; s.announcement!.title = null;
  assert.equal(reviewLessonPublication(s).filter(r => r.state === 'blocked').length, 4);
  s.quizPin = { content_id: 'foreign', exam_version_id: 'x', version_number: 2, status: 'published' };
  assert.equal(reviewLessonPublication(s).find(r => r.kind === 'quiz')!.state, 'blocked');
});
function fixture() {
  let principal = 'A', event = () => {}, state = initialPublicationReview();
  const deps = { read: async (_signal: AbortSignal) => snapshot(), readPrincipal: () => principal, subscribeSession: (fn: () => void) => { event = fn; return () => {}; } };
  const c = createPublicationReview(deps); c.subscribe(s => state = s);
  return { c, deps, state: () => state, event: () => event(), replace: () => { principal = 'B'; } };
}
test('refresh clears stale evidence on failure and empty reference list remains explicit', async () => {
  const h = fixture(); await h.c.refresh(); assert.equal(h.state().rows.length, 5);
  h.deps.read = async () => { throw Error('source failed'); }; await h.c.refresh();
  assert.equal(h.state().phase, 'error'); assert.equal(h.state().checkedAt, null); assert.deepEqual(h.state().rows, []);
  h.deps.read = async () => ({ materials: [], videos: [], activities: [], announcement: null, quizPin: null });
  await h.c.refresh(); assert.equal(h.state().phase, 'ready'); assert.deepEqual(h.state().rows, []); h.c.dispose();
});
test('deadline releases display state and fences late results from transports ignoring cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = fixture(); let done!: (s: PackageSnapshot) => void;
  h.deps.read = () => new Promise(r => { done = r; }); const work = h.c.refresh(); t.mock.timers.tick(25000);
  assert.equal(h.state().phase, 'error'); done(snapshot()); await work; assert.deepEqual(h.state().rows, []); h.c.dispose();
});
test('principal replacement/session event and disposal hide private references before late completion', async () => {
  for (const kind of ['principal', 'event', 'dispose']) {
    const h = fixture(); let done!: (s: PackageSnapshot) => void; h.deps.read = () => new Promise(r => { done = r; }); const work = h.c.refresh();
    if (kind === 'principal') h.replace(); else if (kind === 'event') h.event(); else h.c.dispose();
    done(snapshot()); await work; assert.deepEqual(h.state().rows, []); if (kind !== 'dispose') assert.equal(h.state().phase, 'session-ended'); h.c.dispose();
  }
});
