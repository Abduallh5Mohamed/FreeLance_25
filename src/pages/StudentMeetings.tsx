import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Video, ExternalLink, Calendar, Clock, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import StudentHeader from "@/components/StudentHeader";
import axios from "axios";
import { subscribeSessionChange } from "@/lib/session-events";

// Helper to get API URL - same pattern as other pages.
// Vite injects `import.meta.env` at build time; it is absent when this module
// is imported outside Vite (isolated Node tests), hence the guards below.
const getApiUrl = () => {
    const viteEnv: ImportMetaEnv | undefined = import.meta.env;
    const envApiUrl = viteEnv?.VITE_API_URL;
    if (envApiUrl) return envApiUrl;

    // In production, use relative path (nginx proxies /api to backend)
    const currentHost = typeof window !== "undefined" ? window.location.hostname : "";
    if (currentHost !== "localhost" && currentHost !== "127.0.0.1" && currentHost !== "") {
        return '/api';
    }
    return 'http://localhost:3001/api';
};

const API_URL = getApiUrl();

/**
 * Canonical auth token key. The shared transport (src/lib/api-http.ts) reads
 * `authToken`; these pages previously read `token`, a key the auth flow never
 * writes, so every protected request went out as `Bearer null`. Aligning the
 * key is a correctness fix, not a style change.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const meetingAuthToken = (): string | null => localStorage.getItem("authToken");

/**
 * Authorization header for every protected meeting request. Returns an empty
 * object when no token is present, so a missing session fails closed instead of
 * sending `Bearer null` to the server.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const getMeetingAuthHeaders = (): Record<string, string> => {
  const token = meetingAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const readStoredUserId = (): string | null => {
  const raw = localStorage.getItem("currentUser");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { id?: unknown } | null;
    return typeof parsed?.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
};

/**
 * Security scope a meetings load is issued under: the signed-in user id plus the
 * current auth token. The load guard commits a settled response only while this
 * scope is unchanged, so a response issued under a rotated or cleared token
 * (re-authentication, tenant switch) is dropped instead of repopulating private
 * links — even when the user id itself is unchanged.
 *
 * A token/tenant change AFTER a load has already committed cannot be observed
 * from this file: the app exposes no reactive auth signal (no `storage` listener
 * and no auth context — AuthGuard reads localStorage once on mount). Clearing
 * already-committed links on such a change needs that missing upstream contract.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const meetingLoadScope = (): string | null => {
    const userId = readStoredUserId();
    const token = meetingAuthToken();
    return userId && token ? `${userId}:${token}` : null;
};

/** Shown when a protected meetings request is refused because there is no
 *  session scope at all (no user id or no token). */
export const NO_MEETING_SCOPE_MESSAGE = "لا توجد جلسة صالحة. سجّل الدخول مرة أخرى لعرض الاجتماعات.";

/**
 * A meeting link is private (it carries the join credentials for a class), so
 * joining/copying it is authorized against the scope the DISPLAYED list was
 * loaded under - not against whatever localStorage says at click time.
 */
export type MeetingActionRefusal = 'no-session' | 'scope-changed' | 'not-in-list' | 'unsafe-url';

export interface MeetingActionDecision {
    ok: boolean;
    reason?: MeetingActionRefusal;
    url?: string;
}

const MEETING_ACTION_REFUSAL_MESSAGE: Record<MeetingActionRefusal, string> = {
    'no-session': 'لا توجد جلسة صالحة. تم إخفاء الروابط، سجّل الدخول من جديد.',
    'scope-changed': 'تغيّرت جلسة المستخدم. تم إخفاء الروابط، أعد تحميل الصفحة.',
    'not-in-list': 'لم يعد هذا الرابط ضمن الاجتماعات المعروضة حالياً.',
    'unsafe-url': 'رابط الاجتماع غير صالح أو غير متاح.',
};

export interface MeetingActionGateDeps {
    /** Live canonical scope right now (user id + token); null = no session. */
    readScope: () => string | null;
    /** Is this link part of the list currently applied to the UI? */
    isMember: (link: string) => boolean;
    /** Drops the private links currently on screen. */
    clearLinks: () => void;
    /** Retires any in-flight load so a late response cannot repopulate them. */
    invalidateLoad: () => void;
    /** Injected side effects so the gate is testable without a browser. */
    openLink?: (url: string) => void;
    copyText?: (text: string) => Promise<void> | void;
    onRefused?: (reason: MeetingActionRefusal, message: string) => void;
}

/**
 * Action-time authorization for join / copy / open.
 *
 * Every path (the normal join, the copy button AND its non-secure-context
 * clipboard fallback, since the fallback lives inside the injected copyText)
 * must pass `authorize` first. The gate requires a NON-NULL live scope equal to
 * the scope the displayed list was applied under, and current list membership.
 * On a scope problem it clears the on-screen links and invalidates the loader,
 * so a refused action can neither open nor copy a private link.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const createMeetingActionGate = (deps: MeetingActionGateDeps) => {
    let appliedScope: string | null = null;
    let hasAppliedList = false;

    const refuse = (reason: MeetingActionRefusal): MeetingActionDecision => {
        if (reason === 'no-session' || reason === 'scope-changed') {
            deps.clearLinks();
            deps.invalidateLoad();
        }
        deps.onRefused?.(reason, MEETING_ACTION_REFUSAL_MESSAGE[reason]);
        return { ok: false, reason };
    };

    const authorize = (link: string): MeetingActionDecision => {
        const liveScope = deps.readScope();
        if (!liveScope) return refuse('no-session');
        if (!hasAppliedList || liveScope !== appliedScope) return refuse('scope-changed');
        if (!deps.isMember(link)) return refuse('not-in-list');
        if (!isSafeMeetingUrl(link)) return refuse('unsafe-url');
        return { ok: true, url: link.trim() };
    };

    return {
        applied(scope: string | null): void {
            appliedScope = scope;
            hasAppliedList = true;
        },
        clear(): void {
            appliedScope = null;
            hasAppliedList = false;
        },
        authorize,
        join(link: string): MeetingActionDecision {
            const decision = authorize(link);
            if (decision.ok) deps.openLink?.(decision.url as string);
            return decision;
        },
        async copy(link: string): Promise<MeetingActionDecision> {
            const decision = authorize(link);
            if (decision.ok) await deps.copyText?.(decision.url as string);
            return decision;
        },
    };
};

/** Session keys whose cross-tab change invalidates the displayed meetings. */
const SESSION_STORAGE_KEYS = new Set(['authToken', 'currentUser']);

export interface MeetingsScopeWatcherDeps {
    readScope: () => string | null;
    onScopeChange: () => void;
    getWindow?: () => (Window & typeof globalThis) | null;
    getDocument?: () => Document | null;
}

export interface MeetingsScopeWatcher {
    start(): void;
    stop(): void;
    check(): boolean;
}

/**
 * Detects a session/token change that happened AFTER the list was already on
 * screen - the case a load-time guard cannot cover. Focus, visibility and
 * cross-tab storage events are observed (no polling, no global monkeypatch);
 * on a change the caller clears the rows, the error state and the action gate
 * and invalidates any in-flight load.
 *
 * Limitation (documented, not silently claimed fixed): a same-document token
 * mutation performed while the page stays focused emits NO event, so already
 * rendered link text cannot be removed synchronously. Only the next event (or
 * an action attempt, which the gate refuses) reveals it.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const createMeetingsScopeWatcher = (deps: MeetingsScopeWatcherDeps): MeetingsScopeWatcher => {
    let lastScope: string | null = null;
    let started = false;
    const getWindow = () =>
        deps.getWindow ? deps.getWindow() : typeof window === 'undefined' ? null : window;
    const getDocument = () =>
        deps.getDocument ? deps.getDocument() : typeof document === 'undefined' ? null : document;

    const check = (): boolean => {
        const current = deps.readScope();
        if (current === lastScope) return false;
        lastScope = current;
        deps.onScopeChange();
        return true;
    };

    const onEvent = () => { check(); };
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || SESSION_STORAGE_KEYS.has(event.key)) check();
    };

    return {
        start() {
            if (started) return;
            started = true;
            lastScope = deps.readScope();
            getWindow()?.addEventListener('focus', onEvent);
            getWindow()?.addEventListener('storage', onStorage as EventListener);
            getDocument()?.addEventListener('visibilitychange', onEvent);
        },
        stop() {
            if (!started) return;
            started = false;
            getWindow()?.removeEventListener('focus', onEvent);
            getWindow()?.removeEventListener('storage', onStorage as EventListener);
            getDocument()?.removeEventListener('visibilitychange', onEvent);
        },
        check,
    };
};

/**
 * A meeting link may only be opened when it is an absolute http(s) URL with a
 * host. Every other scheme (javascript:, data:, blob:, file:, ...) is rejected
 * so a server-provided link can never execute script or navigate the student
 * away from the app.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const isSafeMeetingUrl = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return false;
    }
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
};

const extractHttpStatus = (error: unknown): number | undefined => {
    if (typeof error === "object" && error !== null && "response" in error) {
        const response = (error as { response?: { status?: unknown } }).response;
        if (typeof response?.status === "number") return response.status;
    }
    return undefined;
};

/**
 * Maps a failed meetings fetch to an honest Arabic message. A 401/403 must not
 * be presented as "no meetings": the student needs to know the list failed to
 * load (session expired / no permission) so they can retry or re-authenticate.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const describeMeetingsLoadError = (error: unknown): string => {
    const status = extractHttpStatus(error);
    if (status === 401) return "انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.";
    if (status === 403) return "لا تملك صلاحية عرض الاجتماعات.";
    if (typeof status === "number") return "تعذر تحميل الاجتماعات من الخادم. حاول مرة أخرى.";
    return "تعذر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.";
};

/**
 * Monotonic load token that also remembers the identity (user id) a load was
 * issued for. A settled response may only commit when its token is still the
 * latest AND the identity still matches, so:
 *   - a slower older response can never repopulate private join links after a
 *     newer load has already completed, and
 *   - a response issued for a previous student can never land after the
 *     signed-in user changed (or signed out).
 * `invalidate()` retires every in-flight token (used on unmount / logout).
 *
 * Mirrored in OnlineMeeting.tsx; the loader behaviour is pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
interface MeetingsLoadGuard {
    begin(identity: string | null): number;
    isCurrent(token: number, identity: string | null): boolean;
    invalidate(): void;
}

const createMeetingsLoadGuard = (): MeetingsLoadGuard => {
    let latest = 0;
    let latestIdentity: string | null = null;
    return {
        begin: (identity) => {
            latest += 1;
            latestIdentity = identity;
            return latest;
        },
        isCurrent: (token, identity) => token === latest && identity === latestIdentity,
        invalidate: () => {
            latest += 1;
            latestIdentity = null;
        },
    };
};

export interface MeetingsLoaderDeps<T> {
    /** Performs the request for the identity captured when the load began. */
    request: (identity: string | null) => Promise<T[]>;
    /** Reads the current identity (user id) at the moment a load begins. */
    readIdentity: () => string | null;
    /**
     * Optional full security scope (identity + token/tenant) the load is issued
     * under. Defaults to `readIdentity`. Used only to decide whether a settled
     * response is still relevant, so a token rotation for the same user is
     * detected even though the request identity (user id) is unchanged.
     */
    readScope?: () => string | null;
    /** Clears previously shown items before a new load, so stale links never persist. */
    onClear: () => void;
    onApply: (items: T[]) => void;
    onError: (message: string) => void;
    onLoadingChange?: (loading: boolean) => void;
}

export interface MeetingsLoader<T> {
    load(): Promise<void>;
    invalidate(): void;
}

export interface MeetingSessionGuardDeps {
    /** The page's meetings loader (null before the first load began). */
    getLoader: () => { invalidate: () => void } | null;
    /**
     * Clear the already-rendered private data and load state: the meeting
     * list is server-authoritative per identity and must not survive a
     * session change.
     */
    clearRenderedMeetings: () => void;
}

/**
 * Same-document session-change guard (supervisor/026/029): on a logout,
 * identity, token or scope change completed in this document, retire
 * in-flight meeting loads (so a stale response can never commit private
 * links) and clear the rendered private data. Returns the unsubscribe
 * function the caller must call on unmount.
 */
export const createMeetingSessionGuard = (deps: MeetingSessionGuardDeps): (() => void) =>
    subscribeSessionChange(() => {
        deps.getLoader()?.invalidate();
        deps.clearRenderedMeetings();
    });

/**
 * Loader that guarantees only the latest, still-relevant response commits.
 *
 * Every `load()` clears the previous items, claims a fresh token for the
 * identity read at that instant, then awaits the request. When the response
 * settles it is dropped unless its token is still the latest for the same
 * identity — so a reversed (out-of-order) completion, or a response for a user
 * that changed mid-flight, can never overwrite data, loading or error state.
 */
export function createMeetingsLoader<T>(deps: MeetingsLoaderDeps<T>): MeetingsLoader<T> {
    const guard = createMeetingsLoadGuard();
    const readScope = () => (deps.readScope ? deps.readScope() : deps.readIdentity());
    return {
        async load() {
            const identity = deps.readIdentity();
            const scope = readScope();
            const token = guard.begin(scope);
            deps.onLoadingChange?.(true);
            // Never show links from a previous student or scope while this one loads.
            deps.onClear();
            // No session scope at all: fail closed WITHOUT issuing a protected
            // request (empty headers would otherwise still reach the server).
            if (!scope) {
                deps.onError(NO_MEETING_SCOPE_MESSAGE);
                deps.onLoadingChange?.(false);
                return;
            }
            let items: T[] = [];
            let failure: unknown;
            let failed = false;
            try {
                items = await deps.request(identity);
            } catch (error) {
                failed = true;
                failure = error;
            }
            // A stale completion must not commit data, error or loading. Re-read
            // the scope so a response issued for a student or token that has since
            // changed (or signed out) is dropped too.
            if (!guard.isCurrent(token, readScope())) return;
            if (failed) {
                // Clear any previously shown private links and report the failure honestly.
                deps.onError(describeMeetingsLoadError(failure));
            } else {
                deps.onApply(items);
            }
            deps.onLoadingChange?.(false);
        },
        invalidate() {
            guard.invalidate();
        },
    };
}

interface Meeting {
    id: string;
    title: string;
    description: string;
    meeting_link: string;
    meeting_type: string;
    meeting_password: string;
    grade_id: string;
    group_id: string | null;
    scheduled_at: string;
    duration_minutes: number;
    grade_name: string;
    group_name: string | null;
    created_by_name: string;
}

const StudentMeetings = () => {
    const [meetings, setMeetings] = useState<Meeting[]>([]);
    const [meetingsError, setMeetingsError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const { toast } = useToast();
    const navigate = useNavigate();

    // Copy to clipboard with fallback for non-HTTPS
    const copyToClipboard = async (text: string) => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                toast({ title: "تم النسخ", description: "تم نسخ رابط الاجتماع" });
            } else {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                textArea.style.top = '-999999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    toast({ title: "تم النسخ", description: "تم نسخ رابط الاجتماع" });
                } catch (err) {
                    console.error('Fallback copy failed:', err);
                    toast({
                        title: "فشل النسخ",
                        description: "الرجاء نسخ الرابط يدوياً",
                        variant: "destructive"
                    });
                } finally {
                    textArea.remove();
                }
            }
        } catch (err) {
            console.error('Copy failed:', err);
            toast({
                title: "فشل النسخ",
                description: "الرجاء نسخ الرابط يدوياً",
                variant: "destructive"
            });
        }
    };

    const getUser = () => {
        const userData = localStorage.getItem('currentUser');
        return userData ? JSON.parse(userData) : null;
    };

    // Loader wires the request to component state. It clears the previous
    // student's links before every load and on failure, and only commits the
    // latest, still-relevant response — a reversed completion or a response for
    // a student that changed mid-flight is dropped instead of repopulating links.
    const meetingsRef = useRef<Meeting[]>([]);
    const meetingsLoaderRef = useRef<MeetingsLoader<Meeting> | null>(null);
    const actionGateRef = useRef<ReturnType<typeof createMeetingActionGate> | null>(null);

    meetingsLoaderRef.current ??= createMeetingsLoader<Meeting>({
        request: async (identity) => {
            const res = await axios.get(`${API_URL}/meetings/student/${identity}`, {
                headers: getMeetingAuthHeaders()
            });
            return res.data;
        },
        readIdentity: () => getUser()?.id ?? null,
        readScope: meetingLoadScope,
        onClear: () => {
            meetingsRef.current = [];
            setMeetings([]);
            setMeetingsError(null);
            // Nothing on screen may be joined/copied while a load is in flight.
            actionGateRef.current?.clear();
        },
        onApply: (list) => {
            meetingsRef.current = list;
            setMeetings(list);
            // Record the scope this list was applied under; actions are
            // authorized against it, not against a click-time storage read.
            actionGateRef.current?.applied(meetingLoadScope());
        },
        onError: (message) => {
            meetingsRef.current = [];
            setMeetings([]);
            setMeetingsError(message);
            actionGateRef.current?.clear();
        },
        onLoadingChange: (value) => setLoading(value),
    });

    actionGateRef.current ??= createMeetingActionGate({
        readScope: meetingLoadScope,
        isMember: (link) => meetingsRef.current.some((meeting) => meeting.meeting_link === link),
        clearLinks: () => {
            meetingsRef.current = [];
            setMeetings([]);
            setMeetingsError(null);
        },
        invalidateLoad: () => meetingsLoaderRef.current?.invalidate(),
        openLink: (url) => {
            // noopener/noreferrer prevents the opened meeting tab from reaching
            // back into this window (reverse tabnabbing).
            window.open(url, "_blank", "noopener,noreferrer");
        },
        copyText: copyToClipboard,
        onRefused: (reason, message) => {
            toast({
                title: reason === 'unsafe-url' ? "خطأ" : "تنبيه",
                description: message,
                variant: "destructive"
            });
        },
    });

    // A session/token change while the list is already on screen (another tab
    // signs in/out, the window regains focus after re-auth) must clear the
    // private links, the error/loading state and the gate, and retire any
    // in-flight load.
    const scopeWatcherRef = useRef<MeetingsScopeWatcher | null>(null);
    scopeWatcherRef.current ??= createMeetingsScopeWatcher({
        readScope: meetingLoadScope,
        onScopeChange: () => {
            meetingsRef.current = [];
            setMeetings([]);
            setMeetingsError(null);
            setLoading(false);
            actionGateRef.current?.clear();
            meetingsLoaderRef.current?.invalidate();
        },
    });

    useEffect(() => {
        scopeWatcherRef.current?.start();
        return () => scopeWatcherRef.current?.stop();
    }, []);

    const fetchMeetings = async () => {
        const user = getUser();
        if (!user) {
            navigate('/auth');
            return;
        }
        await meetingsLoaderRef.current!.load();
    };

    useEffect(() => {
        fetchMeetings();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // On unmount (e.g. logout) retire any in-flight load so a late response can
    // never commit private links or state after the page is gone.
    useEffect(() => {
        return () => {
            meetingsLoaderRef.current?.invalidate();
        };
    }, []);

    // Same-document session change (supervisor/026): on a logout, identity,
    // token or scope change completed in this document, retire in-flight
    // meeting loads (so a stale response can never commit private links) and
    // clear the already-rendered private data — the meeting list is
    // server-authoritative per identity and must not survive the change.
    useEffect(() => {
        const unsubscribe = createMeetingSessionGuard({
            getLoader: () => meetingsLoaderRef.current,
            clearRenderedMeetings: () => {
                setMeetings([]);
                setMeetingsError(null);
                setLoading(false);
            },
        });
        return unsubscribe;
    }, []);

    const joinMeeting = (link: string) => {
        // Authorized against the applied list scope; the gate opens the link
        // only when the session is unchanged and the link is still listed.
        actionGateRef.current!.join(link);
    };

    const formatDate = (dateString: string) => {
        if (!dateString) return '';
        const date = new Date(dateString);
        return date.toLocaleDateString('ar-EG', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    const getMeetingTypeLabel = (type: string) => {
        switch (type) {
            case 'zoom': return 'Zoom';
            case 'google_meet': return 'Google Meet';
            default: return 'أخرى';
        }
    };

    const getMeetingTypeColor = (type: string) => {
        switch (type) {
            case 'zoom': return 'bg-blue-500';
            case 'google_meet': return 'bg-green-500';
            default: return 'bg-gray-500';
        }
    };

    const isUpcoming = (dateString: string) => {
        const meetingDate = new Date(dateString);
        const now = new Date();
        return meetingDate > now;
    };

    const isLive = (dateString: string, durationMinutes: number) => {
        const meetingStart = new Date(dateString);
        const meetingEnd = new Date(meetingStart.getTime() + durationMinutes * 60000);
        const now = new Date();
        return now >= meetingStart && now <= meetingEnd;
    };

    // Sort meetings: live first, then upcoming, then past
    const sortedMeetings = [...meetings].sort((a, b) => {
        const aLive = isLive(a.scheduled_at, a.duration_minutes);
        const bLive = isLive(b.scheduled_at, b.duration_minutes);
        if (aLive && !bLive) return -1;
        if (!aLive && bLive) return 1;
        return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
    });

    return (
        <div className="min-h-screen bg-gradient-to-br from-amber-50/80 via-orange-50/60 to-yellow-50/80 dark:from-slate-900 dark:via-amber-950/30 dark:to-slate-900" dir="rtl">
            <StudentHeader />
            <div className="container mx-auto px-4 py-8">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                            <Video className="w-6 h-6 text-primary" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-foreground">الاجتماعات الأونلاين</h1>
                            <p className="text-muted-foreground">اجتماعات الفيديو المجدولة لك</p>
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="flex justify-center items-center py-12">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
                    </div>
                ) : meetingsError ? (
                    <Card className="shadow-soft">
                        <CardContent className="py-12">
                            <div className="text-center">
                                <p role="alert" className="text-destructive mb-4">{meetingsError}</p>
                                <Button variant="outline" onClick={fetchMeetings}>إعادة المحاولة</Button>
                            </div>
                        </CardContent>
                    </Card>
                ) : sortedMeetings.length === 0 ? (
                    <Card className="shadow-soft">
                        <CardContent className="py-12">
                            <div className="text-center">
                                <Video className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                                <h3 className="text-lg font-semibold mb-2">لا توجد اجتماعات مجدولة</h3>
                                <p className="text-muted-foreground">
                                    سيتم عرض الاجتماعات هنا عندما يقوم المدرس بجدولة اجتماع جديد
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid gap-4">
                        {sortedMeetings.map((meeting) => {
                            const live = isLive(meeting.scheduled_at, meeting.duration_minutes);
                            const upcoming = isUpcoming(meeting.scheduled_at);

                            return (
                                <Card
                                    key={meeting.id}
                                    className={`shadow-soft transition-all ${live ? 'ring-2 ring-green-500 bg-green-50/50 dark:bg-green-950/20' : ''}`}
                                >
                                    <CardContent className="p-6">
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-3 mb-3">
                                                    <div className={`w-3 h-3 rounded-full ${live ? 'bg-green-500 animate-pulse' : upcoming ? 'bg-yellow-500' : 'bg-gray-400'}`}></div>
                                                    <h3 className="font-bold text-xl">{meeting.title}</h3>
                                                    <span className={`text-xs px-3 py-1 rounded-full text-white ${getMeetingTypeColor(meeting.meeting_type)}`}>
                                                        {getMeetingTypeLabel(meeting.meeting_type)}
                                                    </span>
                                                    {live && (
                                                        <span className="text-xs px-3 py-1 rounded-full bg-green-500 text-white animate-pulse">
                                                            🔴 مباشر الآن
                                                        </span>
                                                    )}
                                                </div>

                                                {meeting.description && (
                                                    <p className="text-muted-foreground mb-4">{meeting.description}</p>
                                                )}

                                                <div className="flex flex-wrap gap-6 text-sm">
                                                    <div className="flex items-center gap-2 text-muted-foreground">
                                                        <Calendar className="w-4 h-4" />
                                                        <span>{formatDate(meeting.scheduled_at)}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-muted-foreground">
                                                        <Clock className="w-4 h-4" />
                                                        <span>{meeting.duration_minutes} دقيقة</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-muted-foreground">
                                                        <Users className="w-4 h-4" />
                                                        <span>{meeting.grade_name}</span>
                                                        {meeting.group_name && <span>- {meeting.group_name}</span>}
                                                    </div>
                                                </div>

                                                {meeting.meeting_password && (
                                                    <div className="mt-4 p-3 bg-muted/50 rounded-lg inline-block">
                                                        <span className="text-sm text-muted-foreground">كلمة المرور: </span>
                                                        <code className="font-mono font-bold">{meeting.meeting_password}</code>
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex flex-col gap-2 mr-6">
                                                <Button
                                                    size="lg"
                                                    className={live ? 'bg-green-600 hover:bg-green-700' : ''}
                                                    onClick={() => joinMeeting(meeting.meeting_link)}
                                                >
                                                    <ExternalLink className="w-5 h-5 ml-2" />
                                                    {live ? 'انضم الآن' : 'انضم للاجتماع'}
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    onClick={() => actionGateRef.current!.copy(meeting.meeting_link)}
                                                >
                                                    نسخ الرابط
                                                </Button>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

export default StudentMeetings;
