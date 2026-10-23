import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Scan, CheckCircle, XCircle, MessageCircle, Calendar, Send, DollarSign, AlertTriangle } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import axios from 'axios';
import { classifyAttendanceError, createSubmissionGuard, createResponseSequence } from '@/pages/QRAttendance';
import {
  instantToDayKey,
  isScheduledOnDayKey,
  parseScheduleWeekdays,
  previousScheduledDayKey,
  todayDayKey,
} from '@/lib/attendance-calendar';

// `import.meta.env` exists under Vite but not under a plain Node test runner,
// so it is read defensively and falls back to the relative /api path.
const API_URL = (import.meta.env as { VITE_API_URL?: string } | undefined)?.VITE_API_URL || '/api';

// ---------------------------------------------------------------------------
// Canonical authentication contract for the protected requests of this page.
//
// src/lib/api-http.ts (the canonical client) reads the session token from
// localStorage['authToken']. The legacy 'token' key is NOT the canonical
// session source, so reading it here produced unauthenticated requests.
//
// Every protected call must carry `Authorization: Bearer <authToken>`, and when
// the token is absent the request must fail closed BEFORE the transport is
// touched (never `Bearer null`, never an unauthenticated call). The adapter is
// exported so the isolated tests can drive the real request construction with
// an injected transport.
// ---------------------------------------------------------------------------
export const AUTH_TOKEN_STORAGE_KEY = 'authToken';

export class MissingAuthTokenError extends Error {
  readonly code = 'MISSING_AUTH_TOKEN';
  constructor(message = 'missing auth token') {
    super(message);
    this.name = 'MissingAuthTokenError';
  }
}

export const isMissingAuthTokenError = (error: unknown): boolean =>
  error instanceof MissingAuthTokenError ||
  (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'MISSING_AUTH_TOKEN');

/** Reads the canonical session token; absent or blank means "no session". */
export const readAuthToken = (storage?: Storage | null): string | null => {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    if (!store) return null;
    const raw = store.getItem(AUTH_TOKEN_STORAGE_KEY);
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  } catch {
    return null;
  }
};

export interface ProtectedTransportDeps {
  http: {
    get: (url: string, config?: any) => Promise<any>;
    post: (url: string, data?: any, config?: any) => Promise<any>;
  };
  getToken: () => string | null;
}

/**
 * Page-scoped protected transport. The token is resolved at call time and the
 * bearer header attached here; with no token the call rejects with
 * MissingAuthTokenError without ever reaching the transport.
 */
export const createProtectedTransport = ({ http, getToken }: ProtectedTransportDeps) => {
  const authorize = (config: any = {}) => {
    const token = getToken();
    if (!token) throw new MissingAuthTokenError();
    return { ...config, headers: { ...(config.headers || {}), Authorization: `Bearer ${token}` } };
  };
  return {
    get: async (url: string, config?: any) => http.get(url, authorize(config)),
    post: async (url: string, data?: any, config?: any) => http.post(url, data, authorize(config)),
  };
};

/**
 * The transport used by the page. Kept in a mutable holder so the isolated
 * tests can inject a fake transport without a module reload.
 */
export const barcodeTransport = {
  current: createProtectedTransport({ http: axios, getToken: readAuthToken }),
};

export type BarcodeScanErrorKind =
  | 'missing_token'
  | 'duplicate'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'server'
  | 'network';

export interface ClassifiedBarcodeScanError {
  kind: BarcodeScanErrorKind;
  status?: number;
  serverMessage?: string;
  /** User-facing Arabic message, always safe to display. */
  message: string;
}

/**
 * Scoped classifier: a missing session is reported distinctly (no request was
 * sent at all) while every real server/network failure keeps the shared
 * classification, so the UI never turns a rejection into a success.
 */
export const classifyBarcodeScanError = (error: unknown): ClassifiedBarcodeScanError => {
  if (isMissingAuthTokenError(error)) {
    return { kind: 'missing_token', status: 401, message: 'انتهت الجلسة، سجّل الدخول من جديد' };
  }
  return classifyAttendanceError(error);
};

/**
 * A failed scan must stay actionable: the operator keeps the barcode in the
 * input so the same scan can be retried after the single-flight guard is
 * released. Only an already-recorded scan (nothing left to retry) clears it.
 */
export const shouldClearBarcodeInputAfterFailure = (kind: BarcodeScanErrorKind): boolean =>
  kind === 'duplicate';

export interface ScopedResponseGuard {
  /** Starts a load for `scope` and returns its token. */
  begin(scope: string): number;
  /** True only while the token is the newest one AND `scope` is still applied. */
  isCurrent(token: number, scope: string): boolean;
  /** Retires every outstanding token without starting a replacement request. */
  invalidate(): void;
}

/**
 * Stale-response fence used by the group-scoped loaders of this page: a
 * response may commit only when it belongs to the newest load AND to the scope
 * that is still selected. `invalidate()` retires an in-flight load on a scope
 * clear/unmount even when no replacement request is issued, so a late
 * completion (data or failure) cannot repopulate/overwrite the current state.
 */
export const createScopedResponseGuard = (
  sequence: ReturnType<typeof createResponseSequence> = createResponseSequence(),
): ScopedResponseGuard => {
  let captured: string | null = null;
  return {
    begin(scope: string): number {
      captured = scope;
      return sequence.next();
    },
    isCurrent(token: number, scope: string): boolean {
      return sequence.isCurrent(token) && scope === captured;
    },
    invalidate(): void {
      sequence.invalidate();
    },
  };
};

// Helper: given schedule_days JSON and a reference calendar-day key, return
// the previous scheduled day as YYYY-MM-DD. Delegates to the shared
// Africa/Cairo attendance business-day calendar (supervisor/026): the caller
// supplies the Cairo reference day, and the walk-back is pure calendar
// arithmetic (the weekday of a calendar day needs no timezone).
const getPreviousScheduledDay = (referenceDate: string, schedule_days: any): string | null => {
  const weekdays = parseScheduleWeekdays(schedule_days);
  return previousScheduledDayKey(referenceDate, weekdays);
};

// Helper: check if today (Africa/Cairo business day, supervisor/026) matches
// a group's schedule_days. No schedule = available every day (preserved).
const isTodayScheduled = (schedule_days: any): boolean => {
  if (!schedule_days) return true;
  let days: unknown = schedule_days;
  if (typeof schedule_days === 'string') {
    try { days = JSON.parse(schedule_days); } catch { return true; }
  }
  if (!Array.isArray(days) || days.length === 0) return true;
  return isScheduledOnDayKey(todayDayKey(), parseScheduleWeekdays(days));
};

// Helper: get Arabic day name from schedule_days
const getScheduleDaysArabic = (schedule_days: any): string => {
  if (!schedule_days) return 'كل يوم';
  let days: string[] = [];
  if (typeof schedule_days === 'string') {
    try { days = JSON.parse(schedule_days); } catch { return 'كل يوم'; }
  } else if (Array.isArray(schedule_days)) {
    days = schedule_days;
  }
  if (days.length === 0) return 'كل يوم';
  const arabicDays: { [k: string]: string } = { sun: 'الأحد', mon: 'الاثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت' };
  return days.map(d => arabicDays[d.toLowerCase()] || d).join(' و ');
};

// ---------------------------------------------------------------------------
// Group-scoped production loader/controller.
//
// This orchestration used to live inline in the component, which made the
// behaviour that matters impossible to exercise without a DOM: clearing the
// previous group's already-committed rows/maps on an A -> B scope change,
// retiring them when the selected scope's load fails (401/403/network), and
// representing an unavailable payment / previous-attendance lookup as UNKNOWN
// instead of a confirmed unpaid/absent result.
//
// Extracting the minimum orchestration into an injectable controller lets the
// isolated tests drive the REAL code with an injected transport and state
// sinks (no DOM, no browser, no network).
//
// Date semantics are the Africa/Cairo attendance business day
// (supervisor/026): BOTH loaders use the same Cairo day key, so the
// today-attendance load and the absent computation can never disagree about
// which day "today" is near midnight. Payment month/year lookups keep their
// existing billing convention and are deliberately untouched.
// ---------------------------------------------------------------------------

export type PaymentAvailability = 'paid' | 'unpaid' | 'unknown';

// ---------------------------------------------------------------------------
// Rendering decisions consumed by BOTH table consumers.
//
// Regression: the absent table read the PaymentAvailability string directly
// (`const hasPaid = monthlyPayments[id]`), so 'unpaid' and 'unknown' — both
// truthy strings — rendered as "مدفوع" and hid the legitimate payment action,
// and 'unknown' authorized a payment that could double-charge. The decision is
// now a small explicit-state production helper: paid/unpaid/unknown map to
// distinct badges, and ONLY a verified 'unpaid' state exposes the payment
// action — unknown never authorizes payment and never implies paid/unpaid.
// ---------------------------------------------------------------------------
export type PaymentPresentation =
  | { state: 'paid'; allowPayment: false }
  | { state: 'unpaid'; allowPayment: true }
  | { state: 'unknown'; allowPayment: false };

export const describePaymentPresentation = (
  payment: PaymentAvailability | undefined,
): PaymentPresentation => {
  if (payment === 'paid') return { state: 'paid', allowPayment: false };
  if (payment === 'unpaid') return { state: 'unpaid', allowPayment: true };
  // Missing (never loaded) or 'unknown' (lookup failed): neither paid nor
  // unpaid may be implied, and no payment action may be offered.
  return { state: 'unknown', allowPayment: false };
};

// ---------------------------------------------------------------------------
// Previous-session rendering decision.
//
// Regression: the absent table rendered `_attended` truthiness only, so an
// entry whose lookup FAILED (`_attended: null` + `_unavailable: true`) showed
// "لم يحضر آخر حصة" — presenting an unavailable read as a confirmed absence.
// A failed lookup must render "غير متاح" instead.
// ---------------------------------------------------------------------------
export type LastAttendancePresentation =
  | { state: 'never' }
  | { state: 'unavailable' }
  | { state: 'attended' }
  | { state: 'absent' };

export const describeLastAttendancePresentation = (
  entry: LastAttendanceEntry | undefined,
): LastAttendancePresentation => {
  if (!entry) return { state: 'never' };
  if (entry._unavailable || entry._attended === null) return { state: 'unavailable' };
  return entry._attended ? { state: 'attended' } : { state: 'absent' };
};

export interface LastAttendanceEntry {
  _scheduledDate: string;
  /** `true`/`false` when the server answered; `null` when the lookup failed. */
  _attended: boolean | null;
  /** `true` means the previous-session lookup could not be determined. */
  _unavailable: boolean;
  status?: string;
  [key: string]: any;
}

export interface BarcodeLoadState {
  loading: boolean;
  error: ClassifiedBarcodeScanError | null;
}

export interface BarcodeAttendanceSinks {
  setAttendanceRows(rows: any[]): void;
  setAbsentRows(rows: any[]): void;
  replaceLastAttendance(map: Record<string, LastAttendanceEntry>): void;
  replaceMonthlyPayments(map: Record<string, PaymentAvailability>): void;
  setTodayLoad(state: BarcodeLoadState): void;
  setAbsentLoad(state: BarcodeLoadState): void;
}

export interface BarcodeAttendanceControllerDeps {
  http: { get: (url: string, config?: any) => Promise<any> };
  apiUrl: string;
  readScope: () => string;
  readStudents: () => any[];
  readGroups: () => any[];
  now?: () => Date;
  sinks: BarcodeAttendanceSinks;
}

export interface BarcodeAttendanceController {
  /**
   * Retire every in-flight load, clear the previous scope's committed
   * rows/maps and reset the load states. Called on every group transition
   * (including A -> B) and on scope clear, WITHOUT issuing a request.
   */
  resetScope(): void;
  /** Retire every outstanding load (unmount / teardown). */
  invalidate(): void;
  loadTodayAttendance(): Promise<void>;
  loadAbsentStudents(): Promise<void>;
}

export const createBarcodeAttendanceController = (
  deps: BarcodeAttendanceControllerDeps,
): BarcodeAttendanceController => {
  const { http, apiUrl, readScope, readStudents, readGroups, sinks } = deps;
  const now = deps.now ?? (() => new Date());
  const todayGuard = createScopedResponseGuard();
  const absentGuard = createScopedResponseGuard();

  // Rows committed by the newest successful today-load for the current scope.
  let committedRows: any[] = [];
  // Whether that load actually succeeded; absent computation is only honest
  // when we know who was present.
  let todayCommitted = false;
  // Per-scope merged lookup maps. The original page merged each loader's
  // entries into the previous state (`prev => ({ ...prev, ...next })`), and
  // the page renders the present table from the today-load's map while the
  // absent table renders from the absent-load's map — replacing the whole map
  // in one loader would erase the other table's entries. The controller
  // therefore owns the merge and publishes full snapshots; a scope change
  // clears both maps entirely.
  let committedLastAttendance: Record<string, LastAttendanceEntry> = {};
  let committedPayments: Record<string, PaymentAvailability> = {};

  const clearCommitted = () => {
    committedRows = [];
    todayCommitted = false;
    committedLastAttendance = {};
    committedPayments = {};
    sinks.setAttendanceRows([]);
    sinks.setAbsentRows([]);
    sinks.replaceLastAttendance({});
    sinks.replaceMonthlyPayments({});
  };

  // Fence every absent computation that derives from the authoritative
  // attendance snapshot: once that snapshot is replaced or discarded, an
  // in-flight absent loop must not repopulate rows/maps from data it can no
  // longer vouch for, and its loading state must be cleared coherently.
  const fenceDependentAbsentLoads = () => {
    absentGuard.invalidate();
    sinks.setAbsentLoad({ loading: false, error: null });
  };

  const resetLoadStates = () => {
    sinks.setTodayLoad({ loading: false, error: null });
    sinks.setAbsentLoad({ loading: false, error: null });
  };

  const readPreviousAttendance = async (
    student: any,
    groups: any[],
    referenceDay: string,
    isCurrent: () => boolean,
  ): Promise<LastAttendanceEntry | null | 'superseded'> => {
    const group = groups.find((g: any) => g.id === student.group_id);
    const lastScheduledDate = getPreviousScheduledDay(referenceDay, group?.schedule_days);
    if (!lastScheduledDate) return null;
    if (!isCurrent()) return 'superseded';
    try {
      const attResponse = await http.get(`${apiUrl}/attendance`, {
        params: { student_id: student.id, date: lastScheduledDate },
      });
      if (!isCurrent()) return 'superseded';
      const list = Array.isArray(attResponse.data) ? attResponse.data : [];
      return list.length > 0
        ? { ...list[0], _scheduledDate: lastScheduledDate, _attended: list[0].status === 'present', _unavailable: false }
        : { _scheduledDate: lastScheduledDate, _attended: false, status: 'absent', _unavailable: false };
    } catch (err) {
      if (!isCurrent()) return 'superseded';
      // Denied/unknown must NOT be presented as a confirmed absence.
      return { _scheduledDate: lastScheduledDate, _attended: null, _unavailable: true };
    }
  };

  const loadTodayAttendance = async (): Promise<void> => {
    const groupId = readScope();
    const token = todayGuard.begin(groupId);
    const isCurrent = () => todayGuard.isCurrent(token, readScope());
    sinks.setTodayLoad({ loading: true, error: null });
    try {
      // Africa/Cairo business day (supervisor/026): the same day the server
      // records, identical for every operator regardless of host timezone.
      const today = todayDayKey(now());
      const response = await http.get(`${apiUrl}/attendance`, {
        params: { date: today, group_id: groupId || undefined },
      });
      if (!isCurrent()) return; // scope changed/cleared while the load was in flight
      const rows = Array.isArray(response.data) ? response.data : [];
      committedRows = rows;
      todayCommitted = true;
      sinks.setAttendanceRows(rows);
      // A refreshed snapshot supersedes absent computations derived from the
      // previous one: fence them before this load's own nested reads commit.
      fenceDependentAbsentLoads();

      const students = readStudents();
      const groups = readGroups();
      const reference = now();
      const currentYear = reference.getFullYear();
      const currentMonth = reference.getMonth() + 1;
      const payments: Record<string, PaymentAvailability> = {};
      const lastAttendance: Record<string, LastAttendanceEntry> = {};

      for (const record of rows) {
        // Never issue another nested read (or commit) for a superseded scope.
        if (!isCurrent()) return;
        const student = students.find((s: any) => s.id === record.student_id);
        if (!student) continue;

        if (!(student.id in payments)) {
          try {
            const feeResponse = await http.get(`${apiUrl}/fees`, {
              params: { phone: student.phone, status: 'paid' },
            });
            if (!isCurrent()) return;
            const fees = Array.isArray(feeResponse.data) ? feeResponse.data : [];
            payments[student.id] = fees.some(
              (fee: any) => fee.payment_year === currentYear && fee.payment_month === currentMonth,
            )
              ? 'paid'
              : 'unpaid';
          } catch (err) {
            if (!isCurrent()) return;
            payments[student.id] = 'unknown';
          }
        }

        const previous = await readPreviousAttendance(student, groups, today, isCurrent);
        if (previous === 'superseded') return;
        if (previous) lastAttendance[student.id] = previous;
      }

      // Re-check after the per-student awaits: the maps must not land on a
      // scope that was changed while they were being collected.
      if (!isCurrent()) return;
      // Merge (not replace) into the scope's maps so the absent loader's
      // entries for the same scope survive, mirroring the original page.
      committedPayments = { ...committedPayments, ...payments };
      committedLastAttendance = { ...committedLastAttendance, ...lastAttendance };
      sinks.replaceMonthlyPayments({ ...committedPayments });
      sinks.replaceLastAttendance({ ...committedLastAttendance });
      sinks.setTodayLoad({ loading: false, error: null });
    } catch (error) {
      // A failure of a superseded load must not surface as the current state.
      if (!isCurrent()) return;
      // A failed load for the selected scope must not leave the previous
      // scope's committed rows/maps on screen.
      clearCommitted();
      // The authoritative snapshot is gone: dependent absent computations
      // are fenced and their loading state cleared coherently.
      fenceDependentAbsentLoads();
      sinks.setTodayLoad({ loading: false, error: classifyBarcodeScanError(error) });
    }
  };

  const loadAbsentStudents = async (): Promise<void> => {
    const groupId = readScope();
    const token = absentGuard.begin(groupId);
    const isCurrent = () => absentGuard.isCurrent(token, readScope());

    // Without a successful attendance load for this scope we cannot know who
    // is absent; never present every student as absent.
    if (!todayCommitted) {
      sinks.setAbsentRows([]);
      sinks.setAbsentLoad({ loading: false, error: null });
      return;
    }

    sinks.setAbsentLoad({ loading: true, error: null });
    try {
      const reference = now();
      // Same Africa/Cairo business-day key as the today loader above, so the
      // previous-scheduled-day lookup cannot straddle midnight differently.
      const today = todayDayKey(reference);
      // Payment month/year deliberately keep the existing billing convention
      // (supervisor/026: no payment_date/payment_month/year change).
      const currentYear = reference.getFullYear();
      const currentMonth = reference.getMonth() + 1;

      const students = readStudents();
      const groups = readGroups();
      const groupStudents = students.filter((s: any) => s.group_id === groupId && s.is_active);
      const presentIds = new Set(
        committedRows.filter((a: any) => a.status === 'present').map((a: any) => a.student_id),
      );
      const absent = groupStudents.filter((s: any) => !presentIds.has(s.id));

      const lastAttendance: Record<string, LastAttendanceEntry> = {};
      const payments: Record<string, PaymentAvailability> = {};

      for (const student of absent) {
        if (!isCurrent()) return;

        const previous = await readPreviousAttendance(student, groups, today, isCurrent);
        if (previous === 'superseded') return;
        if (previous) lastAttendance[student.id] = previous;

        if (!isCurrent()) return;
        try {
          const feeResponse = await http.get(`${apiUrl}/fees`, {
            params: { phone: student.phone, status: 'paid' },
          });
          if (!isCurrent()) return;
          const fees = Array.isArray(feeResponse.data) ? feeResponse.data : [];
          payments[student.id] = fees.some(
            (fee: any) => fee.payment_year === currentYear && fee.payment_month === currentMonth,
          )
            ? 'paid'
            : 'unpaid';
        } catch (err) {
          if (!isCurrent()) return;
          payments[student.id] = 'unknown';
        }
      }

      if (!isCurrent()) return;
      // Merge (not replace) into the scope's maps so the today loader's
      // entries for the same scope survive, mirroring the original page.
      committedPayments = { ...committedPayments, ...payments };
      committedLastAttendance = { ...committedLastAttendance, ...lastAttendance };
      sinks.setAbsentRows(absent);
      sinks.replaceLastAttendance({ ...committedLastAttendance });
      sinks.replaceMonthlyPayments({ ...committedPayments });
      sinks.setAbsentLoad({ loading: false, error: null });
    } catch (error) {
      if (!isCurrent()) return;
      sinks.setAbsentRows([]);
      sinks.setAbsentLoad({ loading: false, error: classifyBarcodeScanError(error) });
    }
  };

  return {
    resetScope() {
      todayGuard.invalidate();
      absentGuard.invalidate();
      clearCommitted();
      resetLoadStates();
    },
    invalidate() {
      todayGuard.invalidate();
      absentGuard.invalidate();
      resetLoadStates();
    },
    loadTodayAttendance,
    loadAbsentStudents,
  };
};

const BarcodeAttendance = () => {
  const [groups, setGroups] = useState([]);
  const [grades, setGrades] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [todayAttendance, setTodayAttendance] = useState([]);
  const [students, setStudents] = useState([]);
  const [absentStudents, setAbsentStudents] = useState([]);
  const [lastAttendance, setLastAttendance] = useState<Record<string, LastAttendanceEntry>>({});
  const [monthlyPayments, setMonthlyPayments] = useState<Record<string, PaymentAvailability>>({});
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [selectedStudentForPayment, setSelectedStudentForPayment] = useState<any>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  // Cross-group warning dialog state
  const [crossGroupWarning, setCrossGroupWarning] = useState<{ open: boolean; student: any; studentGroup: any; } | null>(null);
  const { toast } = useToast();

  // Duplicate scan/submission suppression: one attendance POST in flight at a time.
  const submitGuard = useRef(createSubmissionGuard());
  const [submitting, setSubmitting] = useState(false);
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  // Filter groups to only show those scheduled for today
  const todayGroups = groups.filter((g: any) => isTodayScheduled(g.schedule_days));

  // Non-group-scoped list loaders keep their own stale-response fences.
  const groupsSequence = useRef(createResponseSequence());
  const gradesSequence = useRef(createResponseSequence());
  const studentsSequence = useRef(createResponseSequence());
  const selectedGroupIdRef = useRef(selectedGroupId);
  const studentsRef = useRef<any[]>([]);
  const groupsRef = useRef<any[]>([]);

  // Honest current loading/error state for the two group-scoped loads.
  const [todayLoad, setTodayLoad] = useState<BarcodeLoadState>({ loading: false, error: null });
  const [absentLoad, setAbsentLoad] = useState<BarcodeLoadState>({ loading: false, error: null });

  useEffect(() => {
    studentsRef.current = students;
  }, [students]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // The group-scoped orchestration lives in the injectable production
  // controller (defined above) so the isolated tests can drive the real
  // loader behaviour with an injected transport and state sinks.
  const controller = useRef<BarcodeAttendanceController | null>(null);
  if (!controller.current) {
    controller.current = createBarcodeAttendanceController({
      http: { get: (url: string, config?: any) => barcodeTransport.current.get(url, config) },
      apiUrl: API_URL,
      readScope: () => selectedGroupIdRef.current,
      readStudents: () => studentsRef.current,
      readGroups: () => groupsRef.current,
      sinks: {
        setAttendanceRows: (rows) => setTodayAttendance(rows),
        setAbsentRows: (rows) => setAbsentStudents(rows),
        replaceLastAttendance: (map) => setLastAttendance(map),
        replaceMonthlyPayments: (map) => setMonthlyPayments(map),
        setTodayLoad,
        setAbsentLoad,
      },
    });
  }

  const fetchTodayAttendance = () => controller.current!.loadTodayAttendance();
  const fetchAbsentStudents = () => controller.current!.loadAbsentStudents();

  // Honest retry for a failed group-scoped load: re-issue the real request for
  // the scope that is still selected (never a fabricated/empty success).
  const retryTodayAttendance = () => {
    if (!selectedGroupIdRef.current) return;
    void controller.current!.loadTodayAttendance();
    void controller.current!.loadAbsentStudents();
  };

  useEffect(() => {
    fetchGroups();
    fetchGrades();
    fetchStudents();
  }, []);

  useEffect(() => {
    selectedGroupIdRef.current = selectedGroupId;
    // A scope change (including A -> B) retires the previous group's in-flight
    // loads AND clears its committed rows/maps immediately, so group A's
    // records can never be shown while group B is selected.
    controller.current!.resetScope();
    if (selectedGroupId) {
      void controller.current!.loadTodayAttendance();
    }
  }, [selectedGroupId]);

  // Unmount / page teardown: retire every outstanding load.
  useEffect(
    () => () => {
      controller.current?.invalidate();
      groupsSequence.current.invalidate();
      gradesSequence.current.invalidate();
      studentsSequence.current.invalidate();
    },
    [],
  );

  // تحديث الغائبين تلقائياً عند تغيير الحضور أو الطلاب أو المجموعة
  useEffect(() => {
    if (selectedGroupId) {
      void controller.current!.loadAbsentStudents();
    }
  }, [todayAttendance, selectedGroupId, students]);

  // Re-enabling a disabled input drops focus; restore it so the operator can
  // keep scanning (also makes a failed submission immediately actionable).
  useEffect(() => {
    if (!submitting) barcodeInputRef.current?.focus();
  }, [submitting]);

  // Shared failure reporter for the non-scan protected requests. A missing or
  // rejected session is reported as such instead of as a generic load error.
  const reportRequestFailure = (error: any, fallbackDescription: string) => {
    const classified = classifyBarcodeScanError(error);
    if (classified.kind === 'missing_token' || classified.kind === 'auth') {
      toast({
        title: "انتهت الجلسة",
        description: classified.message,
        variant: "destructive",
      });
      return classified;
    }
    toast({
      title: "خطأ",
      description: classified.serverMessage ?? fallbackDescription,
      variant: "destructive",
    });
    return classified;
  };

  const fetchGroups = async () => {
    const token = groupsSequence.current.next();
    try {
      const response = await barcodeTransport.current.get(`${API_URL}/groups`);
      if (!groupsSequence.current.isCurrent(token)) return; // superseded load
      setGroups((response.data || []).filter((g: any) => g.is_active));
    } catch (error) {
      if (!groupsSequence.current.isCurrent(token)) return;
      console.error('Error fetching groups:', error);
      reportRequestFailure(error, 'فشل تحميل المجموعات');
    }
  };

  const fetchGrades = async () => {
    const token = gradesSequence.current.next();
    try {
      const response = await barcodeTransport.current.get(`${API_URL}/grades`);
      if (!gradesSequence.current.isCurrent(token)) return;
      setGrades((response.data || []).filter((g: any) => g.is_active));
    } catch (error) {
      if (!gradesSequence.current.isCurrent(token)) return;
      console.error('Error fetching grades:', error);
    }
  };

  const fetchStudents = async () => {
    const token = studentsSequence.current.next();
    try {
      const response = await barcodeTransport.current.get(`${API_URL}/students`);
      if (!studentsSequence.current.isCurrent(token)) return;
      setStudents((response.data || []).filter((s: any) => s.is_active));
    } catch (error) {
      if (!studentsSequence.current.isCurrent(token)) return;
      console.error('Error fetching students:', error);
      reportRequestFailure(error, 'فشل تحميل الطلاب');
    }
  };

  // The group-scoped today-attendance load is implemented by the injectable
  // production controller above (`createBarcodeAttendanceController`); the page
  // only wires its sinks and calls `fetchTodayAttendance()` (see the refs
  // section). The controller clears committed rows/maps on every scope change,
  // retires them on a failed load, stops superseded loops before nested reads,
  // and reports an unavailable payment / previous attendance as `unknown`.

  // ارسال واتساب إلى رقم ولي الأمر (أولوية) ثم رقم الطالب إن لم يتوفر
  const sendWhatsAppNotification = (student: any, status: string) => {
    const message = status === 'present'
      ? `السلام عليكم،\n\nنفيدكم بأن الطالب/ة ${student.name} حضر اليوم ${new Date().toLocaleDateString('ar-EG')}\n\nشكراً لتعاونكم.`
      : `السلام عليكم،\n\nنفيدكم بأن الطالب/ة ${student.name} لم يحضر اليوم ${new Date().toLocaleDateString('ar-EG')}\n\nيرجى متابعة السبب.`;

    const rawPhone = student.guardian_phone || student.phone || '';
    if (!rawPhone) {
      toast({ title: 'لا يوجد رقم', description: 'لا يتوفر رقم لولي الأمر أو الطالب', variant: 'destructive' });
      return;
    }
    // إزالة كل الحروف وإبقاء الأرقام فقط
    let phoneNumber = rawPhone.replace(/[^0-9]/g, '');
    // إضافة كود مصر إذا كان الرقم يبدأ بـ 0
    if (phoneNumber.startsWith('0')) {
      phoneNumber = '+20' + phoneNumber.substring(1);
    } else if (!phoneNumber.startsWith('20')) {
      phoneNumber = '+20' + phoneNumber;
    } else {
      phoneNumber = '+' + phoneNumber;
    }
    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/${phoneNumber}?text=${encodedMessage}`, '_blank');
  };

  // تسجيل حضور فقط (لم نعد ندعم إدخال غياب يدوي من الواجهة)
  const recordAttendance = async (barcodeId: string) => {
    if (submitGuard.current.busy) return; // a submission is already in flight
    try {
      const student = students.find((s: any) => s.barcode_id === barcodeId || s.barcode === barcodeId);

      if (!student) {
        toast({
          title: "خطأ",
          description: "الباركود غير صحيح",
          variant: "destructive",
        });
        setBarcodeInput("");
        return;
      }

      // Check if student belongs to a different group than selected
      if (selectedGroupId && student.group_id && student.group_id !== selectedGroupId) {
        const studentGroup = groups.find((g: any) => g.id === student.group_id);
        setCrossGroupWarning({ open: true, student, studentGroup });
        setBarcodeInput("");
        return;
      }

      await doRecordAttendance(student, student.group_id);
    } catch (error: any) {
      handleAttendanceError(error);
    }
  };

  // Actual attendance recording logic (used by both normal and cross-group flows)
  const doRecordAttendance = async (student: any, groupId: string) => {
    if (!submitGuard.current.tryAcquire()) return;
    setSubmitting(true);
    try {
      // Africa/Cairo business day (supervisor/026): the explicit day key is
      // preserved by the server, so the write lands on the same calendar day
      // the operator sees.
      const today = todayDayKey();

      const response = await barcodeTransport.current.post(`${API_URL}/attendance`, {
        student_id: student.id,
        group_id: groupId,
        attendance_date: today,
        status: 'present'
      });

      if (response.data) {
        toast({
          title: "تم التسجيل",
          description: `تم تسجيل حضور ${student.name} بنجاح`,
        });

        fetchTodayAttendance();
        setBarcodeInput("");
      }
    } catch (error: any) {
      handleAttendanceError(error);
    } finally {
      setSubmitting(false);
      submitGuard.current.release();
    }
  };

  const handleAttendanceError = (error: any) => {
    console.error('Error recording attendance:', error);
    const classified = classifyBarcodeScanError(error);

    if (classified.kind === 'duplicate') {
      toast({
        title: "تنبيه",
        description: "تم تسجيل الحضور مسبقاً اليوم",
        variant: "default",
      });
    } else if (classified.kind === 'missing_token' || classified.kind === 'auth') {
      toast({
        title: "انتهت الجلسة",
        description: classified.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: "خطأ",
        description: classified.serverMessage ?? classified.message,
        variant: "destructive",
      });
    }
    // The single-flight guard has already been released by the caller, so a
    // retryable failure keeps the scanned barcode in the input: the operator
    // can press Enter (or rescan) to retry the same student. Only an
    // already-recorded scan has nothing left to retry.
    if (shouldClearBarcodeInputAfterFailure(classified.kind)) {
      setBarcodeInput("");
    }
  };

  // Handle cross-group confirmation
  const handleCrossGroupAccept = async () => {
    if (crossGroupWarning?.student) {
      await doRecordAttendance(crossGroupWarning.student, crossGroupWarning.student.group_id);
    }
    setCrossGroupWarning(null);
  };

  const handleCrossGroupReject = () => {
    toast({
      title: "تم الرفض",
      description: "لم يتم تسجيل حضور الطالب",
    });
    setCrossGroupWarning(null);
  };

  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Suppress the Enter that follows an auto-submitted 25-char scan.
    if (barcodeInput.trim() && !submitGuard.current.busy) {
      recordAttendance(barcodeInput.trim());
    }
  };

  const handleBarcodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim().toUpperCase();
    setBarcodeInput(value);

    // Auto-submit when barcode is exactly 25 characters
    if (value.length === 25 && !submitGuard.current.busy) {
      recordAttendance(value);
    }
  };

  const sendWhatsAppToAbsentStudents = async () => {
    if (!selectedGroupId) {
      toast({
        title: "تنبيه",
        description: "الرجاء اختيار مجموعة أولاً",
        variant: "destructive",
      });
      return;
    }

    try {
      // Africa/Cairo business day (supervisor/026): notify-absent audits the
      // same calendar day the attendance marks were written under.
      const today = todayDayKey();

      const response = await barcodeTransport.current.post(`${API_URL}/attendance/notify-absent`, {
        group_id: selectedGroupId,
        date: today
      });

      const data = response.data;

      if (data.absent === 0) {
        toast({
          title: "لا يوجد غياب",
          description: "جميع الطلاب حضروا اليوم!",
        });
        return;
      }

      // Open all WhatsApp links
      data.whatsapp_links.forEach((link: any, index: number) => {
        setTimeout(() => {
          window.open(link.link, '_blank');
        }, index * 500); // Delay to avoid popup blocker
      });

      toast({
        title: "تم إرسال الإشعارات",
        description: `تم إرسال ${data.notifications_sent} رسالة واتساب للطلاب الغائبين`,
      });

    } catch (error: any) {
      console.error('Error sending WhatsApp to absent students:', error);
      reportRequestFailure(error, "حدث خطأ أثناء إرسال الإشعارات");
    }
  };

  const handleQuickPayment = (student: any) => {
    setSelectedStudentForPayment(student);
    setPaymentAmount("");
    setIsPaymentDialogOpen(true);
  };

  const processQuickPayment = async () => {
    if (!selectedStudentForPayment || !paymentAmount) {
      toast({
        title: "خطأ",
        description: "الرجاء إدخال المبلغ",
        variant: "destructive",
      });
      return;
    }

    try {
      const amount = parseFloat(paymentAmount);

      if (amount <= 0) {
        toast({
          title: "خطأ",
          description: "الرجاء إدخال مبلغ صحيح",
          variant: "destructive",
        });
        return;
      }

      const currentYear = new Date().getFullYear();
      const currentMonth = new Date().getMonth() + 1;

      // Create fee record
      await barcodeTransport.current.post(`${API_URL}/fees`, {
        student_name: selectedStudentForPayment.name,
        phone: selectedStudentForPayment.phone,
        guardian_phone: selectedStudentForPayment.guardian_phone,
        grade_id: selectedStudentForPayment.grade_id,
        group_id: selectedStudentForPayment.group_id,
        barcode: selectedStudentForPayment.barcode,
        amount: amount,
        paid_amount: amount,
        status: 'paid',
        payment_method: 'cash',
        is_offline: false,
        payment_year: currentYear,
        payment_month: currentMonth,
        payment_date: new Date().toISOString().split('T')[0],
        notes: `دفع سريع من صفحة الحضور`
      });

      toast({
        title: "✅ تم تسجيل الدفع",
        description: `تم تسجيل دفع ${amount} ج.م لـ ${selectedStudentForPayment.name} لشهر ${currentMonth}/${currentYear}`,
      });

      setIsPaymentDialogOpen(false);
      setSelectedStudentForPayment(null);
      setPaymentAmount("");

      // Refresh payment status
      fetchTodayAttendance();
      fetchAbsentStudents();

    } catch (error: any) {
      console.error('Error processing quick payment:', error);

      const classified = classifyBarcodeScanError(error);
      if (classified.kind === 'missing_token' || classified.kind === 'auth') {
        reportRequestFailure(error, "انتهت الجلسة، سجّل الدخول من جديد");
        return;
      }

      if (error.response?.status === 400 && error.response?.data?.error?.includes('تم الدفع مسبقاً')) {
        toast({
          title: "تم الدفع مسبقاً",
          description: error.response.data.message || "الطالب قام بالدفع بالفعل لهذا الشهر",
          variant: "destructive",
        });
      } else {
        toast({
          title: "خطأ",
          description: error.response?.data?.message || "حدث خطأ أثناء تسجيل الدفع",
          variant: "destructive",
        });
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <Scan className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">تسجيل الحضور بالباركود</h1>
            <p className="text-muted-foreground">امسح باركود الطالب لتسجيل الحضور تلقائياً</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Scan className="h-5 w-5" />
                مسح الباركود
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleBarcodeSubmit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block">
                    اختر المجموعة
                  </label>
                  <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر المجموعة" />
                    </SelectTrigger>
                    <SelectContent>
                      {todayGroups.length === 0 ? (
                        <div className="p-3 text-center text-sm text-muted-foreground">
                          لا توجد مجموعات مجدولة لهذا اليوم
                        </div>
                      ) : (
                        todayGroups.map((group: any) => (
                          <SelectItem key={group.id} value={group.id}>
                            {group.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                  {todayGroups.length === 0 && groups.length > 0 && (
                    <div className="mt-2 p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
                      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-4 w-4" />
                        <p className="text-sm font-medium">لا توجد مجموعات مجدولة اليوم</p>
                      </div>
                      <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">المجموعات المتاحة لها أيام محددة أخرى</p>
                    </div>
                  )}
                </div>

                <div>
                  <label htmlFor="barcode-attendance-input" className="text-sm font-medium mb-2 block">
                    امسح أو أدخل رقم الباركود
                  </label>
                  <Input
                    id="barcode-attendance-input"
                    ref={barcodeInputRef}
                    value={barcodeInput}
                    onChange={handleBarcodeChange}
                    placeholder="YX6CKWVPB835S2HPKSP57R9PO"
                    autoFocus
                    className="text-lg font-mono"
                    maxLength={25}
                    disabled={submitting}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    سيتم التسجيل تلقائياً عند إدخال 25 رقم
                  </p>
                </div>
              </form>

              <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
                <h3 className="font-medium mb-2 text-sm">ملاحظات:</h3>
                <ul className="text-xs space-y-1 text-muted-foreground">
                  <li>• اختر المجموعة أولاً</li>
                  <li>• ضع المؤشر في حقل الباركود</li>
                  <li>• امسح باركود الطالب (25 رقم)</li>
                  <li>• سيتم تسجيل الحضور تلقائياً عند اكتمال الباركود</li>
                  <li>• لإرسال واتساب للغائبين: اضغط الزر الأزرق ←</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                إحصائيات اليوم
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">الحضور</p>
                  <p className="text-3xl font-bold text-green-600">
                    {todayAttendance.filter((a: any) => a.status === 'present').length}
                  </p>
                </div>
                <div className="p-4 bg-red-50 dark:bg-red-950/20 rounded-lg">
                  <p className="text-sm text-muted-foreground">الغياب</p>
                  <p className="text-3xl font-bold text-red-600">
                    {selectedGroupId && !todayLoad.loading && !todayLoad.error
                      ? students.filter((s: any) => s.group_id === selectedGroupId && s.is_active).length
                      - todayAttendance.filter((a: any) => a.status === 'present').length
                      : '—'
                    }
                  </p>
                </div>
              </div>

              <Button
                onClick={sendWhatsAppToAbsentStudents}
                disabled={!selectedGroupId}
                className="w-full bg-blue-600 hover:bg-blue-700"
              >
                <Send className="ml-2 h-4 w-4" />
                إرسال واتساب للطلاب الغائبين
              </Button>

              <p className="text-xs text-muted-foreground mt-2 text-center">
                سيتم إرسال رسالة واتساب لولي أمر كل طالب غائب
              </p>
            </CardContent>
          </Card>
        </div>

        {/* حسابات مشتقة للحضور والغياب لتجنب التكرار */}
        {(() => {
          const presentRecords = todayAttendance.filter((r: any) => r.status === 'present');
          const presentIds = new Set(presentRecords.map((r: any) => r.student_id));
          // Without a successful attendance load for the selected scope we
          // cannot know who is absent; never derive "everyone is absent" from
          // an empty or failed load.
          const attendanceReady = !todayLoad.loading && !todayLoad.error;
          const filteredAbsentStudents = selectedGroupId && attendanceReady
            ? students.filter((s: any) => s.group_id === selectedGroupId && s.is_active && !presentIds.has(s.id))
            : [];
          return (
            <>
              <Card className="shadow-soft">
                <CardHeader>
                  <CardTitle>سجل الحضور اليوم</CardTitle>
                </CardHeader>
                <CardContent>
                  {todayLoad.loading && (
                    <p className="text-sm text-muted-foreground mb-3">جارٍ تحميل سجل الحضور…</p>
                  )}
                  {todayLoad.error && (
                    <div className="mb-3 p-3 bg-red-50 dark:bg-red-950/20 rounded-lg border border-red-200 dark:border-red-800 flex items-center justify-between gap-3">
                      <p className="text-sm text-red-700 dark:text-red-400">{todayLoad.error.message}</p>
                      <Button variant="outline" size="sm" onClick={retryTodayAttendance}>
                        إعادة المحاولة
                      </Button>
                    </div>
                  )}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>الطالب</TableHead>
                        <TableHead>رقم التلفون</TableHead>
                        <TableHead>رقم ولي الأمر</TableHead>
                        <TableHead>الباركود</TableHead>
                        <TableHead>الحالة</TableHead>
                        <TableHead>حضر آخر حصة؟</TableHead>
                        <TableHead>حالة الدفع</TableHead>
                        <TableHead>الوقت</TableHead>
                        <TableHead>الإجراءات</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {presentRecords.map((record: any) => {
                        const student = students.find((s: any) => s.id === record.student_id);
                        const payment = monthlyPayments[student?.id] ?? 'unknown';
                        const lastAtt = lastAttendance[student?.id];
                        return (
                          <TableRow key={record.id}>
                            <TableCell className="font-medium">{student?.name || 'غير معروف'}</TableCell>
                            <TableCell className="font-mono text-sm">{student?.phone || '-'}</TableCell>
                            <TableCell className="font-mono text-sm">{student?.guardian_phone || '-'}</TableCell>
                            <TableCell className="font-mono text-sm">{student?.barcode || student?.barcode_id || '-'}</TableCell>
                            <TableCell>
                              <Badge variant="default">
                                <CheckCircle className="ml-1 h-3 w-3" /> حاضر
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {lastAtt ? (
                                <div className="flex flex-col gap-1">
                                  {lastAtt._unavailable ? (
                                    <Badge variant="secondary">غير متاح</Badge>
                                  ) : (
                                    <Badge variant={lastAtt._attended ? 'default' : 'destructive'}>
                                      {lastAtt._attended ? (
                                        <><CheckCircle className="ml-1 h-3 w-3" /> حضر</>
                                      ) : (
                                        <><XCircle className="ml-1 h-3 w-3" /> غائب</>
                                      )}
                                    </Badge>
                                  )}
                                  {lastAtt._scheduledDate && (
                                    <span className="text-xs text-muted-foreground">
                                      {new Date(lastAtt._scheduledDate).toLocaleDateString('ar-SA')}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <Badge variant="secondary">لم يحضر من قبل</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              {payment === 'paid' ? (
                                <Badge variant="default">
                                  <CheckCircle className="ml-1 h-3 w-3" /> مدفوع
                                </Badge>
                              ) : payment === 'unpaid' ? (
                                <Badge variant="destructive">
                                  <XCircle className="ml-1 h-3 w-3" /> غير مدفوع
                                </Badge>
                              ) : (
                                <Badge variant="secondary">غير متاح</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-sm">
                              {new Date(record.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                {payment === 'unpaid' && (
                                  <Button
                                    variant="default"
                                    size="sm"
                                    onClick={() => student && handleQuickPayment(student)}
                                    className="bg-green-600 hover:bg-green-700"
                                  >
                                    <DollarSign className="ml-1 h-3 w-3" />
                                    دفع
                                  </Button>
                                )}
                                {student && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => sendWhatsAppNotification(student, 'present')}
                                  >
                                    <MessageCircle className="ml-1 h-3 w-3" />
                                    واتساب
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {presentRecords.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                            لم يتم تسجيل أي حضور اليوم بعد
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              {selectedGroupId && filteredAbsentStudents.length > 0 && (
                <Card className="shadow-soft mt-6">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <XCircle className="h-5 w-5 text-red-600" />
                      الطلاب الغائبين ({filteredAbsentStudents.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>الطالب</TableHead>
                          <TableHead>رقم التلفون</TableHead>
                          <TableHead>رقم ولي الأمر</TableHead>
                          <TableHead>آخر حصة</TableHead>
                          <TableHead>حالة الدفع</TableHead>
                          <TableHead>الإجراءات</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredAbsentStudents.map((student: any) => {
                          const paymentPresentation = describePaymentPresentation(
                            monthlyPayments[student.id],
                          );
                          const lastAttendancePresentation = describeLastAttendancePresentation(
                            lastAttendance[student.id],
                          );
                          return (
                            <TableRow key={student.id}>
                              <TableCell className="font-medium">{student.name}</TableCell>
                              <TableCell className="font-mono text-sm">{student.phone || '-'}</TableCell>
                              <TableCell className="font-mono text-sm">{student.guardian_phone || '-'}</TableCell>
                              <TableCell className="text-sm">
                                {lastAttendancePresentation.state === 'never' ? (
                                  <span className="text-muted-foreground">لم يحضر من قبل</span>
                                ) : lastAttendancePresentation.state === 'unavailable' ? (
                                  <Badge variant="secondary" className="w-fit">غير متاح</Badge>
                                ) : (
                                  <div className="flex flex-col gap-1">
                                    <Badge
                                      variant={lastAttendancePresentation.state === 'attended' ? 'default' : 'destructive'}
                                      className="w-fit"
                                    >
                                      {lastAttendancePresentation.state === 'attended' ? (
                                        <><CheckCircle className="ml-1 h-3 w-3" /> حضر آخر حصة</>
                                      ) : (
                                        <><XCircle className="ml-1 h-3 w-3" /> لم يحضر آخر حصة</>
                                      )}
                                    </Badge>
                                    {lastAttendance[student.id]?._scheduledDate && (
                                      <span className="text-xs text-muted-foreground">
                                        {new Date(lastAttendance[student.id]._scheduledDate).toLocaleDateString('ar-SA')}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                {paymentPresentation.state === 'paid' ? (
                                  <Badge variant="default">
                                    <CheckCircle className="ml-1 h-3 w-3" /> مدفوع
                                  </Badge>
                                ) : paymentPresentation.state === 'unpaid' ? (
                                  <Badge variant="destructive">
                                    <XCircle className="ml-1 h-3 w-3" /> غير مدفوع
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary">غير متاح</Badge>
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="flex gap-2">
                                  {paymentPresentation.allowPayment && (
                                    <Button
                                      variant="default"
                                      size="sm"
                                      onClick={() => handleQuickPayment(student)}
                                      className="bg-green-600 hover:bg-green-700"
                                    >
                                      <DollarSign className="ml-1 h-3 w-3" />
                                      دفع
                                    </Button>
                                  )}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => sendWhatsAppNotification(student, 'absent')}
                                  >
                                    <MessageCircle className="ml-1 h-3 w-3" />
                                    واتساب
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </>
          );
        })()}
      </div>

      {/* Cross-Group Warning Dialog */}
      <Dialog open={crossGroupWarning?.open || false} onOpenChange={(open) => { if (!open) setCrossGroupWarning(null); }}>
        <DialogContent className="sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              تنبيه: طالب من مجموعة أخرى
            </DialogTitle>
            <DialogDescription>
              هذا الطالب مسجل في مجموعة مختلفة. هل تريد تسجيل حضوره في مجموعته الأصلية؟
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">اسم الطالب:</span>
                  <span className="font-medium">{crossGroupWarning?.student?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">مجموعته الأصلية:</span>
                  <span className="font-medium text-amber-700 dark:text-amber-400">{crossGroupWarning?.studentGroup?.name || 'غير محددة'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">المجموعة الحالية:</span>
                  <span className="font-medium">{groups.find((g: any) => g.id === selectedGroupId)?.name}</span>
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <Button variant="destructive" onClick={handleCrossGroupReject}>
                <XCircle className="ml-1 h-4 w-4" />
                رفض
              </Button>
              <Button onClick={handleCrossGroupAccept} className="bg-green-600 hover:bg-green-700">
                <CheckCircle className="ml-1 h-4 w-4" />
                موافقة (تسجيل في مجموعته)
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment Dialog */}
      <Dialog open={isPaymentDialogOpen} onOpenChange={setIsPaymentDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>دفع سريع - {selectedStudentForPayment?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>اسم الطالب</Label>
              <Input value={selectedStudentForPayment?.name || ''} disabled />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>رقم التلفون</Label>
                <Input value={selectedStudentForPayment?.phone || '-'} disabled className="font-mono" />
              </div>
              <div className="space-y-2">
                <Label>رقم ولي الأمر</Label>
                <Input value={selectedStudentForPayment?.guardian_phone || '-'} disabled className="font-mono" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>الصف</Label>
                <Input value={grades.find((g: any) => g.id === selectedStudentForPayment?.grade_id)?.name || '-'} disabled />
              </div>
              <div className="space-y-2">
                <Label>المجموعة</Label>
                <Input value={groups.find((g: any) => g.id === selectedStudentForPayment?.group_id)?.name || '-'} disabled />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="paymentAmount">المبلغ المدفوع *</Label>
              <Input
                id="paymentAmount"
                type="number"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                placeholder="أدخل المبلغ بالجنيه"
                min="0"
                step="0.01"
                autoFocus
              />
            </div>

            <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
              <p className="text-sm text-blue-700 dark:text-blue-300">
                📅 الشهر الحالي: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </p>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setIsPaymentDialogOpen(false)}>
                إلغاء
              </Button>
              <Button onClick={processQuickPayment} className="bg-green-600 hover:bg-green-700">
                <DollarSign className="ml-1 h-4 w-4" />
                تأكيد الدفع
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default BarcodeAttendance;
