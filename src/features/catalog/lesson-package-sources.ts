import { listCourseUnits, listCourseLessons } from '../../lib/api-http';
import { parseCourseUnitList } from './course-units';
import { parseCourseLessonList } from './course-lessons';
export interface PackageSourceRow {
    id: string;
    title: string;
    status: 'active' | 'archived';
}
export interface PackageSourceState {
    phase: 'idle' | 'loading' | 'ready' | 'error' | 'session-ended';
    units: PackageSourceRow[];
    lessons: PackageSourceRow[];
    unitId: string | null;
    chosen: {
        unitId: string;
        lessonId: string;
        title: string;
    } | null;
    unitCursor: string | null;
    lessonCursor: string | null;
    locked: boolean;
}
export const initialPackageSources = (): PackageSourceState => ({ phase: 'idle', units: [], lessons: [], unitId: null, chosen: null, unitCursor: null, lessonCursor: null, locked: false });
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const unique = (rows: PackageSourceRow[]) => new Set(rows.map(row => row.id.toLowerCase())).size === rows.length;
export function packageSourceTransport(courseId: string) {
    if (!uuid(courseId))
        throw Error('Invalid source course');
    return {
        units: async (cursor: string | null, signal: AbortSignal) => {
            const page = parseCourseUnitList(await listCourseUnits(courseId, { cursor, signal }), courseId);
            if (!page.ok)
                throw Error('Invalid source unit page');
            return { rows: page.units.map(row => ({ id: row.id, title: row.name, status: row.status })), cursor: page.nextCursor };
        },
        lessons: async (unitId: string, cursor: string | null, signal: AbortSignal) => {
            if (!uuid(unitId))
                throw Error('Invalid source unit');
            const page = parseCourseLessonList(await listCourseLessons(courseId, unitId, { cursor, signal }), unitId);
            if (!page.ok)
                throw Error('Invalid source lesson page');
            return { rows: page.lessons.map(row => ({ id: row.id, title: row.title, status: row.status })), cursor: page.nextCursor };
        },
    };
}
export function createPackageSources(deps: ReturnType<typeof packageSourceTransport> & {
    destinationId: string;
    readPrincipal: () => string | null;
    subscribeSession: (listener: () => void) => () => void;
}) {
    let state = initialPackageSources(), epoch = 0, active: AbortController | null = null, disposed = false;
    const principal = deps.readPrincipal(), listeners = new Set<(value: PackageSourceState) => void>();
    const set = (value: PackageSourceState) => { state = value; if (!disposed)
        listeners.forEach(fn => fn(state)); };
    const cancel = () => { epoch++; active?.abort(); active = null; };
    const invalidate = () => { cancel(); set({ ...initialPackageSources(), phase: 'session-ended' }); };
    const unsubscribe = deps.subscribeSession(invalidate);
    const permitted = () => {
        if (disposed || state.locked || state.phase === 'session-ended')
            return false;
        if (!principal || deps.readPrincipal() !== principal) {
            invalidate();
            return false;
        }
        return true;
    };
    async function load(kind: 'units' | 'lessons', cursor: string | null, unitId: string | null) {
        if (!permitted())
            return;
        cancel();
        const flight = epoch, controller = new AbortController();
        active = controller;
        set({ ...state, phase: 'loading', chosen: null, lessons: [], lessonCursor: null,
            ...(kind === 'units' ? { units: [], unitId: null, unitCursor: null } : { unitId }) });
        const current = () => !disposed && flight === epoch && !controller.signal.aborted;
        const timeout = setTimeout(() => { if (current()) {
            cancel();
            set({ ...state, phase: 'error', chosen: null });
        } }, 25000);
        try {
            const page = kind === 'units' ? await deps.units(cursor, controller.signal) : await deps.lessons(unitId!, cursor, controller.signal);
            if (!current())
                return;
            if (deps.readPrincipal() !== principal) {
                invalidate();
                return;
            }
            if (page.rows.length > 25 || !unique(page.rows) || page.rows.some(row => !uuid(row.id) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 255 || !['active', 'archived'].includes(row.status))
                || page.cursor !== null && (typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > 256 || page.cursor === cursor))
                throw Error('Invalid source page');
            set({ ...state, phase: 'ready', ...(kind === 'units' ? { units: page.rows, unitCursor: page.cursor } : { lessons: page.rows, lessonCursor: page.cursor }) });
        }
        catch {
            if (current()) {
                if (deps.readPrincipal() !== principal)
                    invalidate();
                else
                    set({ ...state, phase: 'error', chosen: null });
            }
        }
        finally {
            clearTimeout(timeout);
            if (active === controller)
                active = null;
        }
    }
    return {
        subscribe(fn: (value: PackageSourceState) => void) { listeners.add(fn); fn(state); return () => { listeners.delete(fn); }; },
        firstUnits() { return load('units', null, null); },
        nextUnits() { return state.phase === 'ready' && state.unitCursor ? load('units', state.unitCursor, null) : Promise.resolve(); },
        chooseUnit(unitId: string) {
            if (!permitted())
                return Promise.resolve();
            if (!state.units.some(row => same(row.id, unitId) && row.status === 'active')) {
                cancel();
                set({ ...state, phase: 'ready', chosen: null, unitId: null, lessons: [], lessonCursor: null });
                return Promise.resolve();
            }
            return load('lessons', null, unitId);
        },
        firstLessons() { return state.unitId ? load('lessons', null, state.unitId) : Promise.resolve(); },
        nextLessons() { return state.phase === 'ready' && state.unitId && state.lessonCursor ? load('lessons', state.lessonCursor, state.unitId) : Promise.resolve(); },
        chooseLesson(lessonId: string) {
            if (!permitted() || state.phase !== 'ready')
                return;
            const row = state.lessons.find(row => same(row.id, lessonId) && row.status === 'active' && !same(row.id, deps.destinationId));
            set({ ...state, chosen: row && state.unitId ? { unitId: state.unitId, lessonId: row.id, title: row.title } : null });
        },
        setLocked(locked: boolean) { if (!disposed && state.locked !== locked)
            set({ ...state, locked }); },
        invalidate, dispose() { disposed = true; cancel(); unsubscribe(); listeners.clear(); state = initialPackageSources(); },
    };
}
