import { listLessonContents, listLessonVideos, listLessonActivities, readLessonQuizVersion } from '../../lib/api-http';
import { parseLessonContents, type LessonContent } from './lesson-contents';
import { parseLessonVideos, type LessonVideo } from './lesson-videos';
import { parseActivityList, type LessonActivity } from './lesson-activities';
import { lessonAnnouncementTransport, parseLessonAnnouncement, type LessonAnnouncement } from './lesson-announcements';
import { parseQuizPin, type QuizVersionPin } from './lesson-quiz-versions';

export interface PackageSnapshot {
  materials: LessonContent[];
  videos: LessonVideo[];
  activities: LessonActivity[];
  announcement: LessonAnnouncement | null;
  quizPin: QuizVersionPin | null;
}
export type PackageKind = 'material' | 'video' | 'homework' | 'quiz' | 'announcement';
export type PackageIssue = 'position' | 'different-position' | 'occupied' | 'unavailable' | 'capacity'
  | 'restricted-audience' | 'draft' | 'version-review' | 'different-version' | 'publication-review' | 'readiness-unverified';
export interface PackageComparisonRow {
  kind: PackageKind; sourceId: string; title: string | null; order: number | null;
  status: 'present' | 'conflict' | 'review'; issues: PackageIssue[];
}
export interface PackageComparison {
  rows: PackageComparisonRow[]; destinationCount: number; proposedCount: number;
  destinationNeedsRepair: boolean;
  sourceVersion: number | null; destinationVersion: number | null;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function validateMixed(snapshot: PackageSnapshot) {
  const positions = [...snapshot.materials, ...snapshot.videos].map(row => row.display_order);
  if (positions.length > 20 || new Set(positions).size !== positions.length) throw Error('Invalid mixed lesson package');
}
/** Advisory comparison only. No permission, publication or write plan is produced. */
export function compareLessonPackages(source: PackageSnapshot, destination: PackageSnapshot): PackageComparison {
  validateMixed(source); validateMixed(destination);
  const sourceMedia = [
    ...source.materials.map(row => ({ kind: 'material' as const, sourceId: row.material_id, title: row.title, order: row.display_order, unavailable: false })),
    ...source.videos.map(row => ({ kind: 'video' as const, sourceId: row.video_id, title: row.title, order: row.display_order, unavailable: row.video_status !== 'ready' })),
  ].sort((a, b) => a.order - b.order);
  const targetMedia = [
    ...destination.materials.map(row => ({ kind: 'material', sourceId: row.material_id, order: row.display_order })),
    ...destination.videos.map(row => ({ kind: 'video', sourceId: row.video_id, order: row.display_order })),
  ];
  const proposedCount = targetMedia.length + sourceMedia.filter(row => !targetMedia.some(target => target.kind === row.kind && same(target.sourceId, row.sourceId))).length;
  const rows: PackageComparisonRow[] = sourceMedia.map(row => {
    const existing = targetMedia.find(target => target.kind === row.kind && same(target.sourceId, row.sourceId));
    const issues: PackageIssue[] = ['readiness-unverified'];
    if (row.unavailable) issues.push('unavailable');
    if (existing && existing.order !== row.order) issues.push('different-position');
    if (targetMedia.some(target => target.order === row.order && !(target.kind === row.kind && same(target.sourceId, row.sourceId)))) issues.push('position');
    if (!existing && proposedCount > 20) issues.push('capacity');
    const conflict = issues.some(issue => ['unavailable', 'different-position', 'position', 'capacity'].includes(issue));
    return { kind: row.kind, sourceId: row.sourceId, title: row.title, order: row.order, issues, status: conflict ? 'conflict' : existing ? 'present' : 'review' };
  });
  for (const row of source.activities) {
    const existing = destination.activities.find(target => target.kind === row.kind);
    const issues: PackageIssue[] = [];
    if (row.source_status === 'unavailable') issues.push('unavailable');
    if (row.source_status === 'draft') issues.push('draft');
    if (row.audience === 'restricted') issues.push('restricted-audience');
    if (existing && !same(existing.source_id, row.source_id)) issues.push('occupied');
    if (row.kind === 'quiz') {
      issues.push('version-review');
      if (source.quizPin?.status !== 'published') issues.push('unavailable');
      if (destination.quizPin && source.quizPin && !same(destination.quizPin.exam_version_id, source.quizPin.exam_version_id)) issues.push('different-version');
    }
    const conflict = issues.some(issue => ['unavailable', 'occupied', 'different-version'].includes(issue));
    rows.push({ kind: row.kind, sourceId: row.source_id, title: row.title, order: null, issues, status: conflict ? 'conflict' : existing ? 'present' : 'review' });
  }
  if (source.announcement) {
    const row = source.announcement, existing = destination.announcement;
    const issues: PackageIssue[] = ['restricted-audience', 'publication-review'];
    if (row.source_state === 'unavailable') issues.push('unavailable');
    if (row.source_state === 'draft') issues.push('draft');
    if (existing && !same(existing.source_id, row.source_id)) issues.push('occupied');
    rows.push({ kind: 'announcement', sourceId: row.source_id, title: row.title, order: null, issues,
      status: issues.some(issue => ['unavailable', 'occupied'].includes(issue)) ? 'conflict' : existing ? 'present' : 'review' });
  }
  return { rows, destinationCount: targetMedia.length, proposedCount,
    destinationNeedsRepair: destination.videos.some(row => row.video_status !== 'ready')
      || destination.activities.some(row => row.source_status === 'unavailable' || row.kind === 'quiz' && destination.quizPin?.status !== 'published')
      || destination.announcement?.source_state === 'unavailable',
    sourceVersion: source.quizPin?.version_number ?? null, destinationVersion: destination.quizPin?.version_number ?? null };
}

/** At most four independent reference reads and one conditional version read per lesson. */
export function lessonPackageReader(courseId: string, unitId: string) {
  if (![courseId, unitId].every(id)) throw Error('Invalid package scope');
  return async (lessonId: string, signal: AbortSignal): Promise<PackageSnapshot> => {
    if (!id(lessonId)) throw Error('Invalid lesson');
    const [materials, videos, activities, announcement] = await Promise.all([
      listLessonContents(courseId, unitId, lessonId, signal).then(parseLessonContents),
      listLessonVideos(courseId, unitId, lessonId, signal).then(parseLessonVideos),
      listLessonActivities(courseId, unitId, lessonId, signal).then(parseActivityList),
      lessonAnnouncementTransport(courseId, unitId, lessonId).read(signal).then(parseLessonAnnouncement),
    ]);
    const quiz = activities.find(row => row.kind === 'quiz');
    const quizPin = quiz ? parseQuizPin(await readLessonQuizVersion(courseId, unitId, lessonId, quiz.content_id, signal), quiz.content_id) : null;
    const snapshot = { materials, videos, activities, announcement, quizPin };
    validateMixed(snapshot);
    return snapshot;
  };
}

export interface PackagePreviewState {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'session-ended';
  sourceId: string | null; result: PackageComparison | null;
}
export const initialPackagePreview = (): PackagePreviewState => ({ phase: 'idle', sourceId: null, result: null });
export function createPackagePreview(deps: {
  destinationId: string; sourceIds: string[];
  read: (lessonId: string, signal: AbortSignal) => Promise<PackageSnapshot>;
  readSource?: (lessonId: string, signal: AbortSignal) => Promise<PackageSnapshot>;
  readPrincipal: () => string | null; subscribeSession: (listener: () => void) => () => void;
}) {
  let state = initialPackagePreview(), disposed = false, epoch = 0, active: AbortController | null = null;
  const listeners = new Set<(value: PackagePreviewState) => void>();
  const principal = deps.readPrincipal();
  const allowed = new Set(deps.sourceIds.filter(id).map(value => value.toLowerCase()));
  const set = (value: PackagePreviewState) => { state = value; if (!disposed) listeners.forEach(listener => listener(state)); };
  const cancel = () => { epoch++; active?.abort(); active = null; };
  const invalidate = () => { cancel(); set({ phase: 'session-ended', sourceId: null, result: null }); };
  const unsubscribe = deps.subscribeSession(invalidate);
  return {
    subscribe(listener: (value: PackagePreviewState) => void) { listeners.add(listener); listener(state); return () => { listeners.delete(listener); }; },
    clear() { cancel(); if (state.phase !== 'session-ended') set(initialPackagePreview()); },
    async preview(sourceId: string) {
      if (disposed || state.phase === 'session-ended') return;
      cancel();
      if (!principal || deps.readPrincipal() !== principal) { invalidate(); return; }
      if (!id(deps.destinationId) || !id(sourceId) || same(sourceId, deps.destinationId) || !allowed.has(sourceId.toLowerCase())) {
        set({ phase: 'error', sourceId: null, result: null }); return;
      }
      const flight = epoch, controller = new AbortController(); active = controller;
      set({ phase: 'loading', sourceId, result: null });
      const current = () => !disposed && epoch === flight && !controller.signal.aborted;
      const timer = setTimeout(() => { if (current()) { cancel(); set({ phase: 'error', sourceId: null, result: null }); } }, 25000);
      try {
        const [source, destination] = await Promise.all([(deps.readSource ?? deps.read)(sourceId, controller.signal), deps.read(deps.destinationId, controller.signal)]);
        if (!current()) return;
        if (deps.readPrincipal() !== principal) { invalidate(); return; }
        set({ phase: 'ready', sourceId, result: compareLessonPackages(source, destination) });
      } catch {
        if (current()) {
          if (deps.readPrincipal() !== principal) invalidate();
          else { controller.abort(); set({ phase: 'error', sourceId: null, result: null }); }
        }
      } finally { clearTimeout(timer); if (active === controller) active = null; }
    },
    invalidate,
    dispose() { disposed = true; cancel(); unsubscribe(); listeners.clear(); state = initialPackagePreview(); },
  };
}
