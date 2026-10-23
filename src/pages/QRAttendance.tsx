import { useState, useRef, useEffect } from 'react';
import { getStudents, getAttendance, markAttendance, getGroups } from '@/lib/api-http';
import { instantToDayKey } from '@/lib/attendance-calendar';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Calendar } from '@/components/ui/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Barcode, Check, AlertCircle, Users, CalendarIcon } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';

export const BARCODE_LENGTH = 25;

export const sanitizeBarcode = (value: string) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export const formatLocalDate = (date: Date | string) => {
  const d = typeof date === 'string' ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// ---------------------------------------------------------------------------
// Shared attendance scan/error helpers.
// Used by the attendance pages (this file, BarcodeAttendance, Attendance,
// AttendanceLog) and by the isolated M1 tests
// (src/tests/m1-sprint-attendance-ui.test.ts). No env, no network, no DOM.
// ---------------------------------------------------------------------------

/**
 * In-flight guard that suppresses duplicate scan/submission attempts:
 * a second submission while one is still running is dropped, a later one
 * after release is allowed.
 */
export interface SubmissionGuard {
  tryAcquire(): boolean;
  release(): void;
  readonly busy: boolean;
}

export function createSubmissionGuard(): SubmissionGuard {
  let busy = false;
  return {
    tryAcquire(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    release(): void {
      busy = false;
    },
    get busy(): boolean {
      return busy;
    },
  };
}

/**
 * Per-key in-flight guard for mutations that are keyed by an entity id (e.g.
 * one student can be marked present/absent, but two same-tick submissions for
 * the SAME student must collapse to one). The claim is synchronous, so it
 * closes the pre-render window that a React state flag (e.g. a
 * `pendingStudentIds` array) leaves open between two calls in one tick.
 */
export interface KeyedSubmissionGuard {
  tryAcquire(key: string): boolean;
  release(key: string): void;
  isBusy(key: string): boolean;
}

export function createKeyedSubmissionGuard(): KeyedSubmissionGuard {
  const busy = new Set<string>();
  return {
    tryAcquire(key: string): boolean {
      if (busy.has(key)) return false;
      busy.add(key);
      return true;
    },
    release(key: string): void {
      busy.delete(key);
    },
    isBusy(key: string): boolean {
      return busy.has(key);
    },
  };
}

/**
 * Monotonic token sequence so an older async response (e.g. after the user
 * changed the selected date mid-flight) cannot overwrite newer state.
 * `invalidate()` supersedes every outstanding token WITHOUT issuing a new one,
 * which is what a scope-clear (deselecting a student/group) needs: a late
 * completion of the cleared scope must be dropped even when no replacement
 * request is started.
 */
export interface ResponseSequence {
  next(): number;
  isCurrent(token: number): boolean;
  invalidate(): void;
}

export function createResponseSequence(): ResponseSequence {
  let latest = 0;
  return {
    next(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
    invalidate(): void {
      // Bump the generation so all previously issued tokens are now stale.
      latest += 1;
    },
  };
}

/**
 * Resolves a student's guardian contact number from the canonical API field
 * (`guardian_phone`, the field the /students endpoint actually returns).
 * A legacy `parent_phone` record is intentionally NOT read here: the backend
 * contract exposes `guardian_phone` only, so reading another source would risk
 * acting on data the server does not own. Returns a trimmed number, or '' when
 * absent/blank so the caller fails closed instead of opening a WhatsApp link
 * with no number.
 *
 * The parameter is `unknown` because callers hold loosely-typed student rows
 * (e.g. a legacy record shaped `{ name, phone, parent_phone }`); the field is
 * validated structurally here rather than relying on a caller-side cast.
 */
export function resolveGuardianPhone(student: unknown): string {
  if (student === null || typeof student !== 'object') return '';
  const phone = (student as { guardian_phone?: unknown }).guardian_phone;
  return typeof phone === 'string' ? phone.trim() : '';
}

export type AttendanceErrorKind =
  | 'duplicate'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'server'
  | 'network';

export interface ClassifiedAttendanceError {
  kind: AttendanceErrorKind;
  status?: number;
  serverMessage?: string;
  /** User-facing Arabic message, always safe to display. */
  message: string;
}

const HTTP_STATUS_MESSAGE = /^HTTP \d{3}$/;

const ERROR_FALLBACKS: Record<AttendanceErrorKind, string> = {
  duplicate: 'تم تسجيل الحضور مسبقاً',
  auth: 'انتهت الجلسة أو لا تملك الصلاحية، سجّل الدخول من جديد',
  validation: 'بيانات غير صحيحة',
  not_found: 'العنصر المطلوب غير موجود',
  server: 'خطأ في الخادم، حاول مرة أخرى',
  network: 'تعذر الاتصال بالخادم، تحقق من الشبكة',
};

function extractErrorStatus(error: unknown): number | undefined {
  const response = (error as { response?: { status?: unknown } } | null | undefined)?.response;
  if (response && typeof response.status === 'number') {
    return response.status;
  }
  // The shared HTTP client throws Error(`HTTP ${status}`) when the server
  // sends no error text.
  if (error instanceof Error) {
    const match = /^HTTP (\d{3})$/.exec(error.message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function extractServerMessage(error: unknown): string | undefined {
  const data = (error as { response?: { data?: { error?: unknown; message?: unknown } } } | null | undefined)
    ?.response?.data;
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error.trim() !== '') return data.error;
    if (typeof data.message === 'string' && data.message.trim() !== '') return data.message;
  }
  if (error instanceof Error && !HTTP_STATUS_MESSAGE.test(error.message) && error.message.trim() !== '') {
    return error.message;
  }
  return undefined;
}

/**
 * Classifies an API failure so the UI can tell a server rejection (duplicate,
 * validation, forbidden) apart from a session/auth problem and from a network
 * outage. Covers both error shapes used by the attendance pages: axios errors
 * (`error.response.status`) and the shared HTTP client (Error with the server
 * message text or `HTTP <status>`).
 */
export function classifyAttendanceError(error: unknown): ClassifiedAttendanceError {
  const status = extractErrorStatus(error);
  const serverMessage = extractServerMessage(error);

  let kind: AttendanceErrorKind;
  if (status === 409 || (serverMessage !== undefined && serverMessage.includes('already recorded'))) {
    kind = 'duplicate';
  } else if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (status === 400) {
    kind = 'validation';
  } else if (status === 404) {
    kind = 'not_found';
  } else if (status !== undefined) {
    kind = 'server';
  } else {
    kind = 'network';
  }

  return { kind, status, serverMessage, message: ERROR_FALLBACKS[kind] };
}

export interface AttendanceMarkInput {
  student_id: string;
  attendance_date: Date;
  status: 'present' | 'absent';
}

export interface AttendanceMarkDeps {
  markAttendance: (input: AttendanceMarkInput) => Promise<unknown>;
  /** Re-reads the server's authoritative attendance rows (must not reject). */
  refreshAttendance: () => Promise<void>;
}

export type AttendanceMarkOutcome =
  | { kind: 'recorded' }
  | { kind: 'duplicate'; classified: ClassifiedAttendanceError }
  | { kind: 'error'; classified: ClassifiedAttendanceError }
  | { kind: 'ignored' };

/**
 * Production single-flight attendance submission used by Attendance.tsx.
 *
 * The keyed guard is claimed synchronously BEFORE the first await, so two
 * calls in the same tick for the same student cannot both issue a write; the
 * loser returns `{ kind: 'ignored' }` and performs no I/O. A server rejection
 * is classified (duplicate vs auth vs network) and the server rows are
 * re-read on every failure so the UI reflects what the server actually holds
 * (fail closed, no false success). The guard is always released.
 */
export async function submitAttendanceMark(
  request: { studentId: string; status: 'present' | 'absent'; date: Date },
  deps: AttendanceMarkDeps,
  guard: KeyedSubmissionGuard,
): Promise<AttendanceMarkOutcome> {
  if (!guard.tryAcquire(request.studentId)) {
    return { kind: 'ignored' };
  }
  try {
    await deps.markAttendance({
      student_id: request.studentId,
      attendance_date: request.date,
      status: request.status,
    });
    await deps.refreshAttendance();
    return { kind: 'recorded' };
  } catch (error) {
    const classified = classifyAttendanceError(error);
    await deps.refreshAttendance();
    return classified.kind === 'duplicate'
      ? { kind: 'duplicate', classified }
      : { kind: 'error', classified };
  } finally {
    guard.release(request.studentId);
  }
}

export interface BarcodeScanStudent {
  id: string;
  name: string;
  barcode?: string | null;
}

export interface BarcodeScanRecord {
  student_id: string;
  attendance_date: string | Date;
}

export interface BarcodeScanDeps {
  loadStudents: () => Promise<BarcodeScanStudent[]>;
  loadAttendanceForDate: (date: Date) => Promise<BarcodeScanRecord[]>;
  markAttendance: (barcode: string, date: Date) => Promise<unknown>;
}

export type BarcodeScanOutcome =
  | { kind: 'recorded'; studentName: string }
  | { kind: 'duplicate'; studentName: string }
  | { kind: 'unknown_barcode' }
  | { kind: 'invalid_length'; expected: number; actual: number }
  | { kind: 'error'; classified: ClassifiedAttendanceError };

/**
 * Real barcode-scan pipeline with injected production dependencies:
 * validates the barcode, resolves the student, checks for an existing
 * record on the selected date (comparing Africa/Cairo business days, since
 * attendance_date arrives as a datetime), and marks attendance.
 * Every failure is classified instead of surfacing a generic error.
 */
export async function processBarcodeScan(
  input: { barcode: string; date: Date },
  deps: BarcodeScanDeps,
): Promise<BarcodeScanOutcome> {
  const normalizedBarcode = sanitizeBarcode(input.barcode);

  if (normalizedBarcode.length !== BARCODE_LENGTH) {
    return { kind: 'invalid_length', expected: BARCODE_LENGTH, actual: normalizedBarcode.length };
  }

  try {
    const students = await deps.loadStudents();
    const student = students.find((s) => sanitizeBarcode(s.barcode ?? '') === normalizedBarcode);
    if (!student) {
      return { kind: 'unknown_barcode' };
    }

    const records = await deps.loadAttendanceForDate(input.date);
    // Compare Africa/Cairo business days (supervisor/026): the scan date and
    // the stored attendance_date datetime are both reduced to the Cairo
    // calendar day they denote — the same day the server records — instead of
    // host-local date parts, which disagree with the server near midnight.
    const dateKey = instantToDayKey(input.date);
    const existingRecord = dateKey
      ? records.find(
          (r) => r.student_id === student.id && instantToDayKey(r.attendance_date) === dateKey,
        )
      : undefined;
    if (existingRecord) {
      return { kind: 'duplicate', studentName: student.name };
    }

    await deps.markAttendance(normalizedBarcode, input.date);
    return { kind: 'recorded', studentName: student.name };
  } catch (error) {
    return { kind: 'error', classified: classifyAttendanceError(error) };
  }
}

type ScanMessage = { type: 'success' | 'error'; text: string };

export default function BarcodeAttendance() {
  const [barcodeInput, setBarcodeInput] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [groups, setGroups] = useState([]);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const barcodeInputRef = useRef(null);
  const scanGuard = useRef(createSubmissionGuard());
  const attendanceSequence = useRef(createResponseSequence());
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    barcodeInputRef.current?.focus();
    loadGroups();
  }, []);

  useEffect(() => {
    loadAttendanceByDate(selectedDate);
  }, [selectedDate]);

  // Never leave a pending success-clear timer behind (leak / stale wipe).
  useEffect(() => () => {
    if (messageTimerRef.current !== null) clearTimeout(messageTimerRef.current);
  }, []);

  const showMessage = (next: ScanMessage) => {
    if (messageTimerRef.current !== null) {
      clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    setMessage(next);
    if (next.type === 'success') {
      messageTimerRef.current = setTimeout(() => {
        setMessage(null);
        messageTimerRef.current = null;
      }, 3000);
    }
  };

  const loadGroups = async () => {
    try {
      const groupsData = await getGroups();
      setGroups(groupsData || []);
    } catch (error) {
      console.error('Error loading groups:', error);
      showMessage({ type: 'error', text: classifyAttendanceError(error).message });
    }
  };

  const loadAttendanceByDate = async (date: Date) => {
    const token = attendanceSequence.current.next();
    try {
      // Send the Africa/Cairo business day as an explicit calendar-day key
      // (supervisor/026): the server preserves explicit keys, so the load
      // matches the day marks are recorded under on every host. The
      // getAttendanceByDate(Date) helper formats host-local date parts and
      // lives in the shared api-http module outside this task's
      // allowedPaths, so this page switches call sites instead.
      const dayKey = instantToDayKey(date);
      if (!dayKey) return; // unusable selection: fail closed, no request
      const records = await getAttendance({ date: dayKey });
      // Ignore a stale response that belongs to a superseded date selection.
      if (!attendanceSequence.current.isCurrent(token)) return;
      const normalized = (records || []).map((record) => ({
        ...record,
        attendance_date: new Date(record.attendance_date),
      }));
      setAttendanceRecords(normalized);
    } catch (error) {
      if (!attendanceSequence.current.isCurrent(token)) return;
      console.error('Error loading attendance:', error);
      showMessage({ type: 'error', text: classifyAttendanceError(error).message });
    }
  };

  const getFilteredRecords = () => {
    if (selectedGroup === 'all') return attendanceRecords;
    if (selectedGroup === 'no-group') {
      return attendanceRecords.filter(r => !r.group_id);
    }
    return attendanceRecords.filter(r => r.group_id === selectedGroup);
  };

  const filteredRecords = getFilteredRecords();

  const processBarcode = async (barcode: string) => {
    // Duplicate scan/submission suppression: drop input while a scan is running.
    if (!scanGuard.current.tryAcquire()) {
      return;
    }
    setLoading(true);
    try {
      const outcome = await processBarcodeScan(
        { barcode, date: selectedDate },
        {
          loadStudents: () => getStudents(),
          // Africa/Cairo business-day key (supervisor/026), matching the
          // duplicate comparison inside processBarcodeScan and the day the
          // server records; the shared getAttendanceByDate(Date) helper
          // formats host-local date parts and stays outside this task.
          loadAttendanceForDate: (date) => {
            const dayKey = instantToDayKey(date);
            return dayKey ? getAttendance({ date: dayKey }) : Promise.resolve([]);
          },
          markAttendance: (normalizedBarcode, date) =>
            markAttendance({ barcode: normalizedBarcode, attendance_date: date, status: 'present' }),
        },
      );

      switch (outcome.kind) {
        case 'recorded':
          showMessage({ type: 'success', text: `✓ تم تسجيل حضور ${outcome.studentName}` });
          await loadAttendanceByDate(selectedDate);
          break;
        case 'duplicate':
          showMessage({ type: 'error', text: `${outcome.studentName} مسجل بالفعل في هذا اليوم` });
          break;
        case 'unknown_barcode':
          showMessage({ type: 'error', text: 'باركود غير صحيح' });
          break;
        case 'invalid_length':
          showMessage({
            type: 'error',
            text: outcome.actual === 0
              ? 'أدخل الباركود'
              : `الباركود يجب أن يكون ${outcome.expected} رمزًا`,
          });
          break;
        case 'error':
          showMessage({ type: 'error', text: outcome.classified.message });
          break;
      }
    } finally {
      scanGuard.current.release();
      setLoading(false);
      barcodeInputRef.current?.focus();
    }
  };

  const handleBarcodeInput = async (value: string) => {
    const sanitized = sanitizeBarcode(value);
    setBarcodeInput(sanitized);

    if (sanitized.length >= BARCODE_LENGTH) {
      await processBarcode(sanitized);
      setBarcodeInput('');
    }
  };

  const handlePaste = async (e) => {
    e.preventDefault();
    const pastedText = sanitizeBarcode(e.clipboardData.getData('text'));
    if (pastedText) {
      await processBarcode(pastedText);
      setBarcodeInput('');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      <div className="max-w-6xl mx-auto px-4 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <Barcode className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-4xl font-bold text-foreground">تسجيل الحضور</h1>
              <p className="text-muted-foreground">امسح باركود الطالب لتسجيل الحضور</p>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft h-full">
              <CardHeader className="border-b border-primary/20">
                <CardTitle className="text-primary">ماسح الباركود</CardTitle>
              </CardHeader>
              <CardContent className="p-8">
                <div className="space-y-4">
                  <p className="text-muted-foreground text-sm">الصق الباركود أو اضغط Enter بعد المسح</p>
                  <Input
                    ref={barcodeInputRef}
                    type="text"
                    value={barcodeInput}
                    onChange={(e) => { void handleBarcodeInput(e.target.value); }}
                    onPaste={handlePaste}
                    placeholder="ضع الماسح هنا..."
                    aria-label="حقل مسح الباركود"
                    disabled={loading}
                    className="bg-white dark:bg-slate-700 border-primary/30 dark:border-primary/50 text-foreground text-xl py-6 placeholder-muted-foreground focus:border-primary"
                    autoFocus
                  />
                </div>

                {message && (
                  <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
                    className={`mt-6 p-4 rounded-lg flex items-center gap-3 ${
                      message.type === 'success'
                        ? 'bg-green-100 dark:bg-green-500/20 border border-green-300 dark:border-green-500/50 text-green-700 dark:text-green-300'
                        : 'bg-red-100 dark:bg-red-500/20 border border-red-300 dark:border-red-500/50 text-red-700 dark:text-red-300'
                    }`}>
                    {message.type === 'success' ? <Check className="w-5 h-5 flex-shrink-0" /> : <AlertCircle className="w-5 h-5 flex-shrink-0" />}
                    <span className="font-medium">{message.text}</span>
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft h-full">
              <CardHeader className="border-b border-primary/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-primary">
                    <Users className="w-5 h-5" />
                    <CardTitle className="text-lg">قائمة الحضور</CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-4">
                <div className="mb-4">
                  <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="اختر المجموعة" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4" />
                          الكل ({attendanceRecords.length})
                        </div>
                      </SelectItem>
                      {groups.map(group => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name} ({attendanceRecords.filter(r => r.group_id === group.id).length})
                        </SelectItem>
                      ))}
                      <SelectItem value="no-group">
                        بدون مجموعة ({attendanceRecords.filter(r => !r.group_id).length})
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="mb-4 text-center">
                  <div className="text-3xl font-bold text-primary mb-1">{filteredRecords.length}</div>
                  <p className="text-muted-foreground text-sm">طالب مسجل</p>
                </div>
                <div className="max-h-[400px] overflow-y-auto space-y-2">
                  {filteredRecords.length === 0 ? (
                    <div className="text-center text-muted-foreground py-8">
                      <p>لا يوجد حضور في هذه المجموعة</p>
                    </div>
                  ) : (
                    filteredRecords.map((record, i) => (
                      <motion.div
                        key={record.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.02 }}
                        className="flex items-center justify-between p-3 bg-primary/5 dark:bg-primary/10 rounded-lg hover:bg-primary/10 dark:hover:bg-primary/20 transition"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 bg-primary/20 rounded-full flex items-center justify-center">
                            <span className="text-primary font-bold text-sm">{i + 1}</span>
                          </div>
                          <span className="text-foreground font-medium">{record.student_name || record.student_id}</span>
                        </div>
                        <span className="text-muted-foreground text-xs">
                          {new Date(record.attendance_date).toLocaleTimeString('ar-EG', { 
                            hour: '2-digit', 
                            minute: '2-digit' 
                          })}
                        </span>
                      </motion.div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="mt-6">
          <Card className="bg-white dark:bg-slate-800 border-primary/20 shadow-soft">
            <CardHeader className="border-b border-primary/20">
              <div className="flex items-center gap-2 text-primary">
                <CalendarIcon className="w-5 h-5" />
                <CardTitle>اختر التاريخ</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-6 flex justify-center">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={(date) => date && setSelectedDate(date)}
                locale={ar}
                className="rounded-md border border-primary/20"
              />
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
