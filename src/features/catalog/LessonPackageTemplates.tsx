import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subscribeSessionChange } from '@/lib/session-events';
import { readCourseSessionPrincipal } from './course-management';
import { LessonPackageSources } from './LessonPackageSources';
import { lessonPackageReader, type PackageSnapshot } from './lesson-package-preview';
import { LessonTemplateTiming } from './LessonTemplateTiming';
import { type TimingChoice } from './lesson-template-timing';
import {
  createTemplateApplication, createTemplateLibrary, initialTemplateApplication, initialTemplateLibrary,
  templateApplicationTransport, templateLibraryTransport, type ApplicationReview, type TemplateRevisionSummary,
  type TemplateSummary,
} from './lesson-package-templates';
import type { PackageKind } from './lesson-package-preview';

type Selection = { kind: PackageKind; source_id: string };
type Chosen = { unitId: string; lessonId: string; title: string };

const principal = () => { try { return readCourseSessionPrincipal(localStorage); } catch { return null; } };
function subscribePrivateSession(listener: () => void) {
  const unsubscribe = subscribeSessionChange(listener);
  const storage = (event: StorageEvent) => { if (event.key === null || ['authToken', 'currentUser', 'currentStudentSpace'].includes(event.key)) listener(); };
  window.addEventListener('storage', storage);
  return () => { unsubscribe(); window.removeEventListener('storage', storage); };
}
const rowKey = (row: Selection) => row.kind + '/' + row.source_id;

function selectionRows(snapshot: PackageSnapshot) {
  return [
    ...snapshot.materials.map(row => ({ kind: 'material' as const, source_id: row.material_id, title: row.title, order: row.display_order })),
    ...snapshot.videos.filter(row => row.video_status !== 'unavailable' && row.title !== null)
      .map(row => ({ kind: 'video' as const, source_id: row.video_id, title: row.title as string, order: row.display_order })),
    ...snapshot.activities.filter(row => row.source_status !== 'unavailable' && row.title !== null)
      .map(row => ({ kind: row.kind, source_id: row.source_id, title: row.title as string, order: null })),
    ...(snapshot.announcement && snapshot.announcement.source_state !== 'unavailable' && snapshot.announcement.title !== null
      ? [{ kind: 'announcement' as const, source_id: snapshot.announcement.source_id, title: snapshot.announcement.title, order: null }] : []),
  ];
}

const ignoreLock = (_locked: boolean) => {};
export function LessonPackageTemplates({ courseId, onLockChange = ignoreLock }: { courseId: string; onLockChange?: (locked: boolean) => void }) {
  const [library, setLibrary] = useState(initialTemplateLibrary);
  const [panel, setPanel] = useState<'create' | 'revise' | 'apply' | null>(null);
  const [revising, setRevising] = useState<TemplateSummary | null>(null);
  const [destination, setDestination] = useState<Chosen | null>(null);
  const libraryRef = useRef<ReturnType<typeof createTemplateLibrary> | null>(null);
  const lockedRef = useRef(false);
  const identityRef = useRef(principal());
  const onInvalidSession = useCallback(() => libraryRef.current?.invalidate(), []);
  const onApplicationLock = useCallback((locked: boolean) => {
    if (!identityRef.current || principal() !== identityRef.current) { libraryRef.current?.invalidate(); return; }
    lockedRef.current = locked; libraryRef.current?.setLocked(locked);
  }, []);
  const canNavigate = () => { if (!identityRef.current || principal() !== identityRef.current) { onInvalidSession(); return false; } return !lockedRef.current; };

  useEffect(() => {
    const controller = createTemplateLibrary({ ...templateLibraryTransport(courseId), readPrincipal: principal, subscribeSession: subscribePrivateSession });
    libraryRef.current = controller;
    const unsubscribe = controller.subscribe(next => {
      lockedRef.current = next.saving || next.uncertain || next.locked || next.phase === 'loading' || next.phase === 'session-ended';
      onLockChange(next.phase !== 'session-ended' && (next.saving || next.uncertain || next.locked));
      setLibrary(next);
      if (next.saved && next.phase === 'idle') { setPanel(null); setRevising(null); setDestination(null); }
      if (next.phase === 'session-ended') { setPanel(null); setRevising(null); setDestination(null); }
    });
    void controller.refresh();
    return () => { unsubscribe(); controller.dispose(); libraryRef.current = null; onLockChange(false); };
  }, [courseId, onLockChange]);

  useEffect(() => {
    if (!library.saving && !library.uncertain && !library.locked) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [library.saving, library.uncertain, library.locked]);

  const frozen = library.saving || library.uncertain || library.locked || library.phase === 'loading' || library.phase === 'session-ended';
  if (library.phase === 'session-ended') return <p role="alert">تغيرت الجلسة وأُخفيت بيانات القوالب. افتح الدورة من جديد.</p>;

  return <section dir="rtl" className="space-y-3 rounded border p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <h4 className="font-semibold">قوالب الحصص المحفوظة</h4>
      <Button type="button" variant="outline" disabled={library.phase === 'loading' || frozen} onClick={() => { void libraryRef.current?.refresh(); }}>تحديث القوالب</Button>
    </div>
    <p>القالب مرجع خاص بهذه الدورة فقط، ويتطلب مراجعة جديدة قبل كل تطبيق. لا ينسخ المحتوى ولا يغيّر الجمهور الأصلي.</p>
    {library.message ? <p role="alert">{library.message}</p> : null}
    {library.uncertain ? <div role="alert"><p>نتيجة الحفظ غير محسومة. لا تعِد الكتابة ولا تغلق السياق قبل التحقق.</p><Button type="button" disabled={library.saving} onClick={() => { void libraryRef.current?.recover(); }}>التحقق من عملية الحفظ</Button><p>مغادرة الصفحة لا تلغي كتابة وصلت للخادم، وسياق الاستعلام الحالي محفوظ في الذاكرة فقط.</p></div> : null}
    {library.saved ? <p role="status">حُفظ «{library.saved.name}» كمراجعة رقم {library.saved.head_revision}. راجع القائمة قبل التطبيق.</p> : null}
    {library.phase === 'error' ? <p role="alert">تعذر تحميل القوالب. أعد المحاولة لاحقًا.</p> : null}
    {library.phase === 'ready' && !library.templates.length ? <p>لا توجد قوالب بعد.</p> : null}
    <ul className="space-y-2">
      {library.templates.map(template => <li key={template.id} className="rounded border p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>«{template.name}» — المراجعة {template.head_revision} — {template.status === 'active' ? 'نشط' : 'مؤرشف'}</span>
          <span className="flex gap-2">
            {template.status === 'active' ? <Button type="button" variant="outline" disabled={frozen}
              onClick={() => { if (!canNavigate()) return; setPanel('revise'); setRevising(template); setDestination(null); }}>إضافة مراجعة من مصدر</Button> : null}
            {template.status === 'active' ? <Button type="button" variant="outline" disabled={frozen}
              onClick={() => { if (!canNavigate()) return; setPanel('apply'); setRevising(null); }}>تطبيق على حصة</Button> : null}
            {template.status === 'active' ? <Button type="button" variant="outline" disabled={frozen}
              onClick={() => { if (!canNavigate()) return; if (window.confirm('أرشفة هذا القالب؟')) void libraryRef.current?.archive(template.id); }}>أرشفة</Button> : null}
          </span>
        </div>
      </li>)}
    </ul>
    {library.nextCursor ? <Button type="button" variant="outline" disabled={frozen} onClick={() => { void libraryRef.current?.next(); }}>الصفحة التالية</Button> : null}

    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={frozen} onClick={() => { if (!canNavigate()) return; setPanel(panel === 'create' ? null : 'create'); setDestination(null); }}>حفظ قالب من حصة</Button>
    </div>

    {panel === 'create' ? <LessonPackageSources courseId={courseId} destinationId="" renderSource={(source, onLockChange) =>
      <TemplateSourceEditor key={source.unitId + source.lessonId} courseId={courseId} source={source} saving={library.saving || library.uncertain} onLockChange={onLockChange} onInvalidSession={onInvalidSession}
        onSave={(name, selections) => { void libraryRef.current?.create(name, source.lessonId, selections); }} />} /> : null}

    {panel === 'revise' && revising ? <div className="space-y-2 rounded border p-2">
      <p>إضافة مراجعة جديدة للقالب «{revising.name}» من حصة مصدر. المراجعات السابقة لا تتغير.</p>
      <Button type="button" variant="outline" disabled={frozen} onClick={() => { if (!canNavigate()) return; setPanel(null); setRevising(null); }}>إغلاق</Button>
      <LessonPackageSources courseId={courseId} destinationId="" renderSource={(source, onLockChange) =>
        <TemplateSourceEditor key={source.unitId + source.lessonId} courseId={courseId} source={source} saving={library.saving || library.uncertain} onLockChange={onLockChange} onInvalidSession={onInvalidSession} revise
          onSave={(_name, selections) => { void libraryRef.current?.revise(revising.id, revising.head_revision, source.lessonId, selections); }} />} />
    </div> : null}

    {panel === 'apply' && !destination ? <div className="space-y-2 rounded border p-2">
      <p>اختر الحصة الوجهة. التطبيق سيضيف مراجع القالب إلى هذه الحصة فقط ويضبط توقيتها.</p>
      <Button type="button" variant="outline" disabled={frozen} onClick={() => { if (canNavigate()) setPanel(null); }}>إغلاق</Button>
      <LessonPackageSources courseId={courseId} destinationId="" renderSource={source =>
        <div key={source.unitId + source.lessonId} className="rounded border p-2">
          <p>الوجهة: «{source.title}»</p>
          <Button type="button" disabled={frozen} onClick={() => { if (canNavigate()) setDestination(source); }}>استخدام هذه الحصة كوجهة</Button>
        </div>} />
    </div> : null}

    {panel === 'apply' && destination
      ? <TemplateApplication courseId={courseId} destination={destination} templates={library.templates.filter(row => row.status === 'active')}
          onLockChange={onApplicationLock} onClose={() => { if (!canNavigate()) return; setPanel(null); setDestination(null); }} />
      : null}
  </section>;
}

export function TemplateSourceEditor({ courseId, source, saving, revise = false, onSave, onLockChange, onInvalidSession }: {
  courseId: string; source: Chosen; saving: boolean; revise?: boolean; onLockChange: (locked: boolean) => void; onInvalidSession: () => void;
  onSave: (name: string, selections: Selection[]) => void;
}) {
  const [snapshot, setSnapshot] = useState<PackageSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController(), identity = principal();
    const invalidate = () => { controller.abort(); setSnapshot(null); setSelected([]); setName(''); setFailed(true); onInvalidSession(); };
    const unsubscribe = subscribePrivateSession(invalidate);
    const timer = setTimeout(() => { if (principal() !== identity) invalidate(); else { controller.abort(); setFailed(true); } }, 25000);
    setSnapshot(null); setSelected([]); setFailed(false);
    lessonPackageReader(courseId, source.unitId)(source.lessonId, controller.signal)
      .then(value => { if (controller.signal.aborted) return; if (!identity || principal() !== identity) return invalidate(); setSnapshot(value); })
      .catch(() => { if (!controller.signal.aborted) { if (principal() !== identity) invalidate(); else setFailed(true); } }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); unsubscribe(); controller.abort(); };
  }, [courseId, source.unitId, source.lessonId, onInvalidSession]);

  useEffect(() => { onLockChange(saving); return () => onLockChange(false); }, [saving, onLockChange]);
  const rows = snapshot ? selectionRows(snapshot) : [];
  const selections = rows.filter(row => selected.includes(rowKey(row))).map(row => ({ kind: row.kind, source_id: row.source_id }));
  const ready = !saving && rows.length > 0 && selections.length > 0 && (revise || name.trim().length > 0);

  return <div className="space-y-2 rounded border p-2">
    <p>المصدر: «{source.title}»</p>
    {failed ? <p role="alert">تعذر تحميل مكونات الحصة المصدر.</p> : null}
    {!snapshot && !failed ? <p role="status">جارٍ تحميل المصدر…</p> : null}
    {!revise ? <label className="block">اسم القالب<input value={name} disabled={saving} maxLength={120} onChange={event => setName(event.target.value)}
      className="block w-full rounded border p-2" placeholder="قالب الحصة الأولى" /></label> : null}
    {rows.map(row => <label key={rowKey(row)} className="flex gap-2">
      <input type="checkbox" disabled={saving} checked={selected.includes(rowKey(row))}
        onChange={() => setSelected(old => old.includes(rowKey(row)) ? old.filter(key => key !== rowKey(row)) : [...old, rowKey(row)])} />
      <span>{row.title} — {row.kind}{row.order !== null ? ' #' + row.order : ''}</span>
    </label>)}
    <Button type="button" disabled={!ready} onClick={() => { if (!ready) return; onLockChange(true); onSave(name.trim(), selections); }}>
      {revise ? 'حفظ المراجعة الجديدة' : 'حفظ القالب'}
    </Button>
  </div>;
}

export function TemplateApplication({ courseId, destination, templates, onClose, onLockChange }: {
  courseId: string; destination: Chosen; templates: TemplateSummary[]; onClose: () => void; onLockChange: (locked: boolean) => void;
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionRequest, setRevisionRequest] = useState(0);
  const [revisions, setRevisions] = useState<TemplateRevisionSummary[]>([]);
  const [revisionError, setRevisionError] = useState(false);
  const [timing, setTiming] = useState<TimingChoice>({ mode: 'keep', release_at: null });
  const [state, setState] = useState(initialTemplateApplication);
  const [confirmed, setConfirmed] = useState(false);
  const appRef = useRef<ReturnType<typeof createTemplateApplication> | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    const controller = createTemplateApplication({
      ...templateApplicationTransport(courseId, destination.unitId, destination.lessonId),
      readPrincipal: principal, subscribeSession: subscribePrivateSession,
      newOperationId: () => crypto.randomUUID(),
    });
    appRef.current = controller;
    const unsubscribe = controller.subscribe(next => {
      locked.current = ['reviewing', 'applying', 'recovering', 'uncertain', 'session-ended'].includes(next.phase);
      onLockChange(locked.current);
      setState(next);
      if (next.phase === 'session-ended') { setRevisions([]); setTemplateId(''); setRevisionNumber(null); setConfirmed(false); }
    });
    return () => { unsubscribe(); controller.dispose(); appRef.current = null; onLockChange(false); };
  }, [courseId, destination.unitId, destination.lessonId, onLockChange]);

  useEffect(() => {
    if (!templateId) { setRevisions([]); return; }
    const controller = new AbortController(), identity = principal();
    const invalidate = () => { controller.abort(); setRevisions([]); setRevisionNumber(null); setNextCursor(null); setRevisionLoading(false); appRef.current?.invalidate(); };
    const unsubscribe = subscribePrivateSession(invalidate);
    const current = () => { if (controller.signal.aborted) return false; if (!identity || principal() !== identity) { invalidate(); return false; } return true; };
    setRevisionError(false); setRevisionLoading(true); setRevisions([]); setRevisionNumber(null); setNextCursor(null); appRef.current?.clear(); setConfirmed(false);
    const timer = setTimeout(() => { if (current()) { controller.abort(); setRevisionLoading(false); setRevisionError(true); } }, 25000);
    templateLibraryTransport(courseId).revisions(templateId, cursor, controller.signal)
      .then(page => {
        if (!current()) return;
        if (page.nextCursor !== null && page.nextCursor === cursor) throw Error('Repeated revision cursor');
        setRevisions(page.revisions);
        setNextCursor(page.nextCursor); setRevisionLoading(false);
      })
      .catch(() => { if (current()) { setRevisionError(true); setRevisionLoading(false); } }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); unsubscribe(); controller.abort(); };
  }, [courseId, templateId, cursor, revisionRequest]);

  const busy = ['reviewing', 'applying', 'recovering'].includes(state.phase);
  const frozen = busy || state.phase === 'uncertain' || state.phase === 'session-ended';
  const review: ApplicationReview | null = state.review;
  const reset = () => { appRef.current?.clear(); setConfirmed(false); };
  const canEdit = () => !locked.current && principal() !== null;
  if (state.phase === 'session-ended') return <p role="alert">تغيرت الجلسة وأُخفيت المراجعة والمصادر.</p>;

  if (!templates.length) return <div className="rounded border p-2"><p>لا توجد قوالب نشطة للتطبيق.</p><Button type="button" variant="outline" disabled={frozen} onClick={() => { if (canEdit()) onClose(); }}>إغلاق</Button></div>;

  return <div className="space-y-2 rounded border p-2">
    <div className="flex items-center justify-between gap-2"><h5 className="font-semibold">تطبيق قالب على «{destination.title}»</h5>
      <Button type="button" variant="outline" disabled={frozen} onClick={() => { if (canEdit()) onClose(); }}>إغلاق</Button></div>
    <label className="block">القالب<select value={templateId} disabled={frozen} className="block w-full rounded border p-2"
      onChange={event => { if (!canEdit()) return; reset(); setTemplateId(event.target.value); setCursor(null); setRevisionNumber(null); }}>
      {templates.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
    </select></label>
    <label className="block">المراجعة<select value={revisionNumber ?? ''} disabled={frozen || revisionLoading} className="block w-full rounded border p-2"
      onChange={event => { if (!canEdit()) return; const value = Number(event.target.value); if (!revisions.some(row => row.revision_number === value)) return; reset(); setRevisionNumber(value); }}>
      <option value="">اختر مراجعة من الصفحة الحالية</option>
      {revisions.map(row => <option key={row.revision_number} value={row.revision_number}>#{row.revision_number} — مراجع {row.reference_count} — وسائط {row.media_count}</option>)}
    </select></label>
    {revisionError ? <p role="alert">تعذر تحميل مراجعات القالب.</p> : null}
    <div className="flex gap-2">
      <Button type="button" variant="outline" disabled={frozen || revisionLoading} onClick={() => { if (!canEdit() || revisionLoading) return; reset(); setRevisionNumber(null); setCursor(null); setRevisionRequest(old => old + 1); }}>أول صفحة مراجعات وتحديث</Button>
      <Button type="button" variant="outline" disabled={frozen || revisionLoading || !nextCursor} onClick={() => { if (!canEdit() || revisionLoading || !nextCursor) return; reset(); setRevisionNumber(null); setCursor(nextCursor); }}>المراجعات التالية</Button>
    </div>
    <p>اختيار المراجعة صريح من الصفحة الحالية. مغادرة الصفحة لا تلغي كتابة وصلت للخادم؛ سياق التحقق محفوظ في الذاكرة فقط.</p>
    <LessonTemplateTiming value={timing} onChange={next => { if (!canEdit()) return; reset(); setTiming(next); }} review={review?.timing ?? null} disabled={frozen} />
    <Button type="button" disabled={!templateId || !revisionNumber || revisionLoading || revisionError || frozen} onClick={() => { if (!canEdit() || revisionLoading || revisionError || !revisionNumber || !revisions.some(row => row.revision_number === revisionNumber)) return; setConfirmed(false); void appRef.current?.review(templateId, revisionNumber, timing); }}>
      مراجعة التطبيق والتوقيت
    </Button>

    {review ? <div className="space-y-2 rounded border p-2">
      <p role="status">{review.can_apply ? 'جاهز للتطبيق بعد التأكيد.' : 'توجد تعارضات؛ لا يمكن التطبيق.'} — الوسائط المتوقعة {review.projected_media_count}.</p>
      <ul className="list-disc ps-5">
        {review.items.map(row => <li key={row.kind + '/' + row.source_id}>
          {row.title ?? 'مصدر غير متاح'} — {row.kind} — {row.outcome === 'add' ? 'إضافة' : row.outcome === 'present' ? 'موجود مسبقًا' : 'تعارض: ' + row.conflict}
          {row.audience ? ' — الجمهور الأصلي: ' + row.audience : ''}
        </li>)}
      </ul>
      <p>التوقيت الحالي: {review.timing.current_release_at ?? 'بلا توقيت'} — المقترح: {review.timing.proposed_release_at ?? 'بلا توقيت'}.</p>
      <p>لن يتغير الجمهور الأصلي ولن يصبح المرجع قابلًا للتسليم تلقائيًا.</p>
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={frozen || !review.can_apply}
        onChange={event => { if (canEdit()) setConfirmed(event.target.checked); }} />أؤكد مراجعة هذه القائمة والتوقيت</label>
      <Button type="button" disabled={!confirmed || frozen || !review.can_apply}
        onClick={() => { if (!canEdit() || !confirmed) return; setConfirmed(false); void appRef.current?.apply(true); }}>تأكيد التطبيق والتوقيت</Button>
    </div> : null}

    {state.phase === 'saved' && state.result ? <div role="status" className="rounded border p-2">
      <p>تم حفظ العملية بأمان: أُضيف {state.result.created}، وموجود مسبقًا {state.result.existing}.</p>
      <p>وقت الإتاحة الآن: {state.result.timing.release_at ?? 'بلا توقيت'} ({state.result.timing.mode}).</p>
      <p>حدّث أقسام الحصة والمقارنة؛ هذه النتيجة لا تدّعي تحديث القوائم المحلية.</p>
    </div> : null}
    {state.phase === 'uncertain' ? <div className="rounded border p-2">
      <p role="alert">انقطعت استجابة الحفظ. لا تعد المحاولة؛ تحقق من سجل العملية أولًا.</p>
      <Button type="button" disabled={busy} onClick={() => { void appRef.current?.recover(); }}>التحقق من نتيجة العملية دون إعادة الحفظ</Button>
    </div> : null}
    {state.message && !['saved', 'uncertain'].includes(state.phase) ? <p role="alert">{state.message}</p> : null}
  </div>;
}
