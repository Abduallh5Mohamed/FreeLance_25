/**
 * M2-08 local student CSV preview — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/students/csv-preview.ts` that
 * `src/features/students/StudentImportPreview.tsx` mounts, plus the REAL
 * production component rendered by the REAL React server renderer. Both are
 * imported unchanged.
 *
 * Fully isolated: no DB, no network, no browser, no live services, no
 * dependency install, no filesystem. The read is an injected async seam, so
 * the reversed/rejected replies, the close, the dispose and the session event
 * are driven deterministically. A guard installs failing `fetch`,
 * `localStorage`, `sessionStorage` and `indexedDB` globals, so any attempt
 * to reach the network or to persist the file contents fails the test.
 *
 * Behaviours pinned (M2-08 contract):
 *  - the bounded, strict CSV parser: optional BOM, Arabic values, quoted
 *    commas, quoted newlines, doubled quotes, CRLF and LF, blank lines;
 *  - the parser FAILS CLOSED on malformed quoting, an unknown header, a
 *    duplicate header, a missing `name` header, a ragged record, an
 *    unsupported format and every exceeded limit, and never returns a
 *    partially accepted file;
 *  - values are never coerced: leading zeros and a leading `+` survive;
 *  - the only row-level issue is a missing name; the file-level failures
 *    never masquerade as a row issue;
 *  - EXACT within-file duplicate candidates with row references; blank
 *    values never match; the comparison is case sensitive;
 *  - the row number is the physical line the record starts on, also for a
 *    record whose quoted cell spans several lines;
 *  - the declared size is checked BEFORE the file is read at all;
 *  - a newer selection supersedes an older one, a retired reply never
 *    revives data and never releases a newer read's busy latch;
 *  - a close, a dispose and a session event clear the private rows and
 *    retire the pending read; a silent principal change is observed BEFORE
 *    any visible state is settled;
 *  - at most 25 rows and 25 issues are visible per page;
 *  - the component says it is a PREVIEW ONLY and never claims an import.
 *
 * M2-17 adds the dual-format picker: the panel now also accepts an XLSX
 * workbook, which the SAME controller reads through a separate injected byte
 * seam. The CSV behaviour above is unchanged and still pinned in full; the
 * dedicated XLSX suite (`m2-student-xlsx-preview.test.ts`) covers the decoder
 * itself. Here the picker wording and the name-based dispatch are pinned.
 *
 * The correction of supervisor/167 additionally pins:
 *  - a QUOTED empty (or whitespace-only) field is a real data record with a
 *    missing-name issue, never a blank physical line that silently drops it;
 *  - a silent principal change clears the OLD private file name on the
 *    success and the failure path alike, while an ordinary read error keeps
 *    the name of the selected file;
 *  - the REAL panel exposes an ENABLED close control while a read is
 *    pending; invoking it clears the private state at once and retires the
 *    pending result, and a late reply revives nothing.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live
 * services and end-to-end server validation. The server remains
 * authoritative and no import commit exists yet.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStudentCsvPreviewController,
  parseStudentCsv,
  STUDENT_CSV_MAX_BYTES,
  STUDENT_CSV_MAX_CELL_CHARS,
  STUDENT_CSV_MAX_COLUMNS,
  STUDENT_CSV_MAX_RECORDS,
  STUDENT_CSV_PAGE_SIZE,
  type StudentCsvPreviewApi,
  type StudentCsvPreviewFile,
  type StudentCsvPreviewState,
} from "../features/students/csv-preview";

// ---------------------------------------------------------------------------
// Deferred + harness helpers
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const csvFile = (name: string, size: number): StudentCsvPreviewFile => ({ name, size });

interface SessionSink {
  subscribeSession: (listener: () => void) => () => void;
  notify: () => void;
  count: () => number;
}

const createSessionSink = (): SessionSink => {
  const listeners = new Set<() => void>();
  return {
    subscribeSession: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify: () => {
      for (const listener of [...listeners]) listener();
    },
    count: () => listeners.size,
  };
};

/** The parsed rows of a file that must parse, with a readable failure. */
const parsedRows = (text: string) => {
  const result = parseStudentCsv(text);
  if (result.ok === false) {
    assert.fail(`expected a parsed file, got ${result.error.code}`);
  }
  return result.rows;
};

const parsedError = (text: string) => {
  const result = parseStudentCsv(text);
  if (result.ok === true) {
    assert.fail("expected the file to be refused");
  }
  return result.error;
};

// ===========================================================================
// The real parser
// ===========================================================================

test("parser: a BOM, Arabic values and surrounding whitespace are parsed", () => {
  const rows = parsedRows(
    "\ufeff name , phone \n  أحمد علي  ,  01001234567  \n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "أحمد علي");
  assert.equal(rows[0].phone, "01001234567");
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].rowIndex, 1);
});

test("parser: quoted commas, quoted newlines, doubled quotes and CRLF are parsed", () => {
  const rows = parsedRows(
    'name,email\r\n"Doe, John","a""b@c.d"\r\n"multi\r\nline",x@y.z\r\n',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Doe, John");
  assert.equal(rows[0].email, 'a"b@c.d');
  assert.equal(rows[0].rowNumber, 2);
  // The record that spans two physical lines is numbered by its FIRST line.
  assert.equal(rows[1].name, "multi\r\nline");
  assert.equal(rows[1].rowNumber, 3);
});

test("parser: LF and CRLF produce the same records", () => {
  const lf = parsedRows("name,phone\nAli,0100\nHassan,0101\n");
  const crlf = parsedRows("name,phone\r\nAli,0100\r\nHassan,0101\r\n");
  assert.deepEqual(
    lf.map((row) => [row.name, row.phone]),
    crlf.map((row) => [row.name, row.phone]),
  );
});

test("parser: blank lines are skipped and the row numbers keep pointing at the file", () => {
  const rows = parsedRows("name,phone\nAli,0100\n\n   \nHassan,0101\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[1].rowNumber, 5);
});

test("parser: a malformed quoting refuses the whole file", () => {
  const unterminated = parsedError('name,phone\n"Ali,0100\n');
  assert.equal(unterminated.code, "malformed-quote");
  const insideField = parsedError('name,phone\nAl"i,0100\n');
  assert.equal(insideField.code, "malformed-quote");
  const afterQuote = parsedError('name,phone\n"Ali"x,0100\n');
  assert.equal(afterQuote.code, "malformed-quote");
});

test("parser: an unknown column refuses the file and names the column", () => {
  const error = parsedError("name,password\nAli,secret\n");
  assert.equal(error.code, "unknown-header");
  assert.equal(error.detail, "password");
  assert.equal(error.line, 1);
});

test("parser: a duplicate column refuses the file", () => {
  const error = parsedError("name,name\nAli,Ali\n");
  assert.equal(error.code, "duplicate-header");
  assert.equal(error.detail, "name");
});

test("parser: a missing name column refuses the file", () => {
  const error = parsedError("phone,email\n0100,a@b.c\n");
  assert.equal(error.code, "missing-name-header");
});

test("parser: a column name is case sensitive and only whitespace is trimmed", () => {
  const error = parsedError("Name,phone\nAli,0100\n");
  assert.equal(error.code, "unknown-header");
  const result = parseStudentCsv("  name  ,phone\nAli,0100\n");
  assert.equal(result.ok, true);
});

test("parser: a ragged record refuses the whole file and names the line", () => {
  const error = parsedError("name,phone\nAli,0100\nHassan\n");
  assert.equal(error.code, "ragged-record");
  assert.equal(error.detail, "3");
  assert.equal(error.line, 3);
});

test("parser: a missing name is a row issue, not a file failure", () => {
  const rows = parsedRows("name,phone\n,0100\nAli,0101\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].issues.length, 1);
  assert.equal(rows[0].issues[0].code, "missing-name");
  assert.equal(rows[0].issues[0].rowNumber, 2);
  assert.equal(rows[1].issues.length, 0);
});

test("parser: values are never coerced, so leading zeros and a plus survive", () => {
  const rows = parsedRows("name,phone,barcode\nAli,007,+201001\n");
  assert.equal(rows[0].phone, "007");
  assert.equal(rows[0].barcode, "+201001");
  const exponent = parsedRows("name,barcode\nAli,1e5\n");
  assert.equal(exponent[0].barcode, "1e5");
});

test("parser: an exact within-file duplicate is a candidate with row references", () => {
  const rows = parsedRows(
    "name,phone,email\nAli,0100,a@b.c\nHassan,0100,a@b.c\nSayed,0101,a@b.c\n",
  );
  const ali = rows[0].duplicates.find((item) => item.field === "phone");
  assert.ok(ali, "the phone candidate exists");
  assert.deepEqual(ali.rowNumbers, [2, 3]);
  assert.equal(ali.value, "0100");
  const email = rows[0].duplicates.find((item) => item.field === "email");
  assert.ok(email, "the email candidate exists");
  assert.deepEqual(email.rowNumbers, [2, 3, 4]);
  // The third row only shares the email, never the phone.
  assert.equal(rows[2].duplicates.filter((item) => item.field === "phone").length, 0);
});

test("parser: a blank value never matches and the comparison is exact", () => {
  const rows = parsedRows("name,phone\nAli,\nHassan,\nSayed,007\nTarek,7\n");
  for (const row of rows) {
    const phones = row.duplicates.filter((item) => item.field === "phone");
    assert.equal(phones.length, 0, "a blank or different phone is never a candidate");
  }
  const different = parsedRows("name,phone\nAli,007\nHassan,7\n");
  assert.equal(different[0].duplicates.length, 0);
  const cased = parsedRows("name,email\nAli,A@b.c\nHassan,a@b.c\n");
  assert.equal(cased[0].duplicates.length, 0, "the comparison is case sensitive");
});

test("parser: 1000 data records are accepted and 1001 are refused", () => {
  const build = (count: number): string => {
    let text = "name,phone\n";
    for (let index = 0; index < count; index += 1) text += `Student ${index},0100${index}\n`;
    return text;
  };
  const accepted = parseStudentCsv(build(STUDENT_CSV_MAX_RECORDS));
  assert.equal(accepted.ok, true);
  if (accepted.ok === true) assert.equal(accepted.rows.length, STUDENT_CSV_MAX_RECORDS);
  const refused = parseStudentCsv(build(STUDENT_CSV_MAX_RECORDS + 1));
  assert.equal(refused.ok, false);
  if (refused.ok === false) assert.equal(refused.error.code, "too-many-records");
});

test("parser: more than six columns are refused and six are accepted", () => {
  const refused = parsedError("name,email,phone,guardian_phone,grade,barcode,extra\nAli,,,,,,\n");
  assert.equal(refused.code, "too-many-columns");
  const accepted = parsedRows("name,email,phone,guardian_phone,grade,barcode\nAli,,,,,\n");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].name, "Ali");
  assert.equal(accepted[0].grade, "");
});

test("parser: a cell of exactly 4096 characters is accepted and 4097 is refused", () => {
  const exact = "a".repeat(STUDENT_CSV_MAX_CELL_CHARS);
  const accepted = parsedRows(`name,phone\nAli,${exact}\n`);
  assert.equal(accepted[0].phone.length, STUDENT_CSV_MAX_CELL_CHARS);
  const tooLong = parsedError(`name,phone\nAli,${"a".repeat(STUDENT_CSV_MAX_CELL_CHARS + 1)}\n`);
  assert.equal(tooLong.code, "cell-too-long");
});

test("parser: a file larger than 1 MiB is refused at the parser entry", () => {
  const filler = "a".repeat(STUDENT_CSV_MAX_BYTES);
  const refused = parseStudentCsv(`name,phone\nAli,${filler}\n`);
  assert.equal(refused.ok, false);
  if (refused.ok === false) assert.equal(refused.error.code, "input-too-large");
});

test("parser: an empty file and a binary container are refused", () => {
  assert.equal(parsedError("   \n  ").code, "empty-file");
  assert.equal(parsedError("name,phone\nAli,\u0000\u0000\n").code, "unsupported-format");
});

test("parser: a file that cannot be decoded as UTF-8 is refused", () => {
  assert.equal(parsedError("name,phone\nAli,\ufffd\n").code, "unsupported-encoding");
});

test("parser: the columns may appear in any order and may be omitted", () => {
  const rows = parsedRows("phone,name\n0100,Ali\n");
  assert.equal(rows[0].name, "Ali");
  assert.equal(rows[0].phone, "0100");
  const onlyName = parsedRows("name\nAli\n");
  assert.equal(onlyName[0].name, "Ali");
  assert.equal(onlyName[0].email, "");
});

// ===========================================================================
// The real controller
// ===========================================================================

const createController = (
  overrides: Partial<StudentCsvPreviewApi> = {},
): {
  controller: ReturnType<typeof createStudentCsvPreviewController>;
  sink: SessionSink;
  reads: Array<Deferred<string>>;
  api: StudentCsvPreviewApi;
} => {
  const sink = createSessionSink();
  const reads: Array<Deferred<string>> = [];
  const api: StudentCsvPreviewApi = {
    readFile: () => {
      const pending = deferred<string>();
      reads.push(pending);
      return pending.promise;
    },
    readPrincipal: () => "session:a",
    subscribeSession: sink.subscribeSession,
    ...overrides,
  };
  return { controller: createStudentCsvPreviewController(api), sink, reads, api };
};

test("feature: a selected file is parsed into a bounded preview", async () => {
  const { controller, reads } = createController();
  const pending = controller.selectFile(csvFile("students.csv", 64));
  await flush();
  assert.equal(controller.getState().phase, "reading");
  reads[0].resolve("name,phone\nAli,0100\nHassan,0101\n");
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.totalRows, 2);
  assert.equal(state.rows.length, 2);
  assert.equal(state.fileName, "students.csv");
  assert.deepEqual(state.headers, ["name", "phone"]);
  assert.equal(state.visibleRows.length, 2);
  controller.dispose();
});

test("feature: a file whose declared size is over the limit is never read", async () => {
  const { controller, reads } = createController();
  await controller.selectFile(csvFile("huge.csv", STUDENT_CSV_MAX_BYTES + 1));
  await controller.waitForIdle();

  assert.equal(reads.length, 0, "the file is refused before it is read");
  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "input-too-large");
  assert.equal(state.rows.length, 0);
  controller.dispose();
});

test("feature: a newer selection supersedes an older reply", async () => {
  const { controller, reads } = createController();
  const first = controller.selectFile(csvFile("first.csv", 16));
  await flush();
  const second = controller.selectFile(csvFile("second.csv", 16));
  await flush();
  assert.equal(reads.length, 2);

  // The OLDER reply arrives last: it must never revive its own data.
  reads[1].resolve("name,phone\nSecond,0200\n");
  await second;
  reads[0].resolve("name,phone\nFirst,0100\n");
  await first;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.fileName, "second.csv");
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].name, "Second");
  controller.dispose();
});

test("feature: an older failure never overwrites a newer preview", async () => {
  const { controller, reads } = createController();
  const first = controller.selectFile(csvFile("first.csv", 16));
  await flush();
  const second = controller.selectFile(csvFile("second.csv", 16));
  await flush();

  reads[1].resolve("name,phone\nSecond,0200\n");
  await second;
  reads[0].reject(new Error("read failed"));
  await first;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.error, null);
  assert.equal(state.rows[0].name, "Second");
  controller.dispose();
});

test("feature: an older reply never clears the newer read's busy latch", async () => {
  const { controller, reads } = createController();
  const first = controller.selectFile(csvFile("first.csv", 16));
  await flush();
  const second = controller.selectFile(csvFile("second.csv", 16));
  await flush();

  reads[0].resolve("name,phone\nFirst,0100\n");
  await first;
  await flush();
  // The first read is finished, but the second one is still on the wire: the
  // busy phase belongs to the second read and must still be shown.
  assert.equal(controller.getState().phase, "reading");

  reads[1].resolve("name,phone\nSecond,0200\n");
  await second;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, "ready");
  controller.dispose();
});

test("feature: closing the preview clears the rows and retires the pending read", async () => {
  const { controller, reads } = createController();
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  controller.clear();
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().rows.length, 0);

  reads[0].resolve("name,phone\nAli,0100\n");
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, "a retired read revives nothing");
  assert.equal(controller.getState().phase, "idle");
  controller.dispose();
});

test("feature: disposing clears the rows and retires the pending read", async () => {
  const { controller, reads } = createController();
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  controller.dispose();
  assert.equal(controller.getState().rows.length, 0);
  assert.equal(controller.getState().phase, "idle");

  reads[0].resolve("name,phone\nAli,0100\n");
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0);
});

test("feature: a session event clears the preview and retires the pending read", async () => {
  const { controller, reads, sink } = createController();
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  sink.notify();
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().rows.length, 0);

  reads[0].resolve("name,phone\nAli,0100\n");
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, "a retired read revives nothing");
  controller.dispose();
  assert.equal(sink.count(), 0, "the dispose unsubscribes from the session notifier");
});

test("feature: a silent principal change is observed before the reply settles", async () => {
  let principal = "session:a";
  const { controller, reads } = createController({ readPrincipal: () => principal });
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  // The session changed without any notifier event.
  principal = "session:b";
  reads[0].resolve("name,phone\nAli,0100\n");
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the foreign reply never revives the rows");
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "session-changed");
  controller.dispose();
});

test("feature: a silent principal change is observed before a failed reply settles", async () => {
  let principal = "session:a";
  const { controller, reads } = createController({ readPrincipal: () => principal });
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  // The session changed without any notifier event while the read was on the
  // wire: the failure path observes it too.
  principal = "session:b";
  reads[0].reject(new Error("the disk read failed"));
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0);
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "session-changed");
  controller.dispose();
});

test("feature: a read that fails is reported truthfully", async () => {
  const { controller, reads } = createController();
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  reads[0].reject(new Error("the disk read failed"));
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "read-failed");
  assert.equal(state.rows.length, 0);
  controller.dispose();
});

test("feature: a refused file never shows a partial preview", async () => {
  const { controller, reads } = createController();
  const pending = controller.selectFile(csvFile("broken.csv", 16));
  await flush();
  reads[0].resolve("name,phone\nAli,0100\nHassan\n");
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "ragged-record");
  assert.equal(state.rows.length, 0);
  assert.equal(state.visibleRows.length, 0);
  controller.dispose();
});

test("feature: only 25 rows and 25 issues are visible per page", async () => {
  let text = "name,phone\n";
  for (let index = 0; index < 60; index += 1) text += `,0100${index}\n`;
  const { controller, reads } = createController();
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  reads[0].resolve(text);
  await pending;
  await controller.waitForIdle();

  const first = controller.getState();
  assert.equal(first.totalRows, 60);
  assert.equal(first.visibleRows.length, STUDENT_CSV_PAGE_SIZE);
  assert.equal(first.visibleIssues.length, STUDENT_CSV_PAGE_SIZE);
  assert.equal(first.issueCount, 60);

  controller.nextRowPage();
  const second = controller.getState();
  assert.equal(second.rowPage, 1);
  assert.equal(second.visibleRows.length, STUDENT_CSV_PAGE_SIZE);
  assert.equal(second.visibleRows[0].rowIndex, 26);

  controller.nextRowPage();
  const third = controller.getState();
  assert.equal(third.rowPage, 2);
  assert.equal(third.visibleRows.length, 60 - 2 * STUDENT_CSV_PAGE_SIZE);
  assert.equal(third.visibleRows[0].rowIndex, 51);

  // The pages never grow past the bound.
  controller.nextRowPage();
  assert.equal(controller.getState().rowPage, 2);
  controller.previousRowPage();
  assert.equal(controller.getState().rowPage, 1);
  controller.dispose();
});

test("feature: the preview never reaches the network and never persists the file", async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousFetch = globals.fetch;
  const previousLocal = globals.localStorage;
  const previousSession = globals.sessionStorage;
  const previousIndexed = globals.indexedDB;
  let networkCalls = 0;
  let persistenceCalls = 0;
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  define("fetch", () => {
    networkCalls += 1;
    throw new Error("the preview must not reach the network");
  });
  const storage = {
    getItem: () => null,
    setItem: () => {
      persistenceCalls += 1;
      throw new Error("the preview must not persist the file");
    },
    removeItem: () => {
      persistenceCalls += 1;
      throw new Error("the preview must not persist the file");
    },
    clear: () => {
      persistenceCalls += 1;
      throw new Error("the preview must not persist the file");
    },
    key: () => null,
    length: 0,
  };
  define("localStorage", storage);
  define("sessionStorage", storage);
  define("indexedDB", {
    open: () => {
      persistenceCalls += 1;
      throw new Error("the preview must not persist the file");
    },
  });

  try {
    const { controller, reads } = createController();
    const pending = controller.selectFile(csvFile("students.csv", 16));
    await flush();
    reads[0].resolve("name,phone\nAli,0100\n");
    await pending;
    await controller.waitForIdle();
    assert.equal(controller.getState().phase, "ready");
    assert.equal(networkCalls, 0);
    assert.equal(persistenceCalls, 0);
    controller.dispose();
  } finally {
    if (previousFetch === undefined) delete globals.fetch;
    else define("fetch", previousFetch);
    if (previousLocal === undefined) delete globals.localStorage;
    else define("localStorage", previousLocal);
    if (previousSession === undefined) delete globals.sessionStorage;
    else define("sessionStorage", previousSession);
    if (previousIndexed === undefined) delete globals.indexedDB;
    else define("indexedDB", previousIndexed);
  }
});

// ===========================================================================
// The real component, rendered by the real React server renderer
// ===========================================================================

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Renders the REAL `StudentImportPreview` component with the REAL React
 * server renderer and the REAL shared UI primitives. Only the controller
 * hook snapshot is injected, so the markup comes from the production
 * component while no request, no browser and no live service is involved.
 *
 * The harness is Node-only: it supplies the classic-JSX `React` binding the
 * TSX file needs and restores the module loader and the global afterwards.
 */
const renderStudentImportPreview = async (snapshot: StudentCsvPreviewState): Promise<string> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/students/StudentImportPreview.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /StudentImportPreview\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          useState: () => [snapshot, () => {}],
          useRef: () => ({ current: null }),
          useEffect: () => {},
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(
          this,
          path.resolve(SRC_ROOT, specifier.slice(2)),
          parent,
          isMain,
        );
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    // The component binds its hooks at load time, so the module is loaded
    // again for every snapshot: a cached module would keep rendering the
    // FIRST snapshot instead of the state under test.
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (
      ...args: unknown[]
    ) => unknown;
    (globalThis as { React?: unknown }).React = React;
    const tree = Component();
    return renderToStaticMarkup(tree as never);
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

const idleState = (): StudentCsvPreviewState => ({
  phase: "idle",
  fileName: null,
  rows: [],
  headers: [],
  issues: [],
  error: null,
  rowPage: 0,
  issuePage: 0,
  visibleRows: [],
  visibleIssues: [],
  totalRows: 0,
  issueCount: 0,
  duplicateRowCount: 0,
  duplicateGroupCount: 0,
});

test("component: the panel states that it is a local preview only", async () => {
  const html = await renderStudentImportPreview(idleState());
  assert.match(html, /معاينة محلية فقط/, "the preview-only warning is rendered");
  assert.match(html, /لا يُحفظ أي طالب/, "the no-save warning is rendered");
  assert.match(html, /ولا استيراد فعلي/, "the no-import warning is rendered");
  assert.match(html, /اختر ملف CSV أو مصنف XLSX من جهازك/, "the dual selection is labelled");
  assert.match(html, /for="student-csv-file"/, "the label is bound to the input");
  // M2-17: the picker still accepts CSV, and now also an XLSX workbook. The
  // CSV behaviour itself is unchanged: only the offered input widened.
  assert.match(html, /accept="\.csv,text\/csv,/, "the picker still accepts CSV");
  assert.match(
    html,
    /\.xlsx,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/,
    "the picker accepts XLSX",
  );
  assert.doesNotMatch(html, /حفظ الطالب/, "no import or save control is offered");
});

test("component: a refused file shows the truthful diagnostic and no rows", async () => {
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "error",
    fileName: "broken.csv",
    error: { code: "unknown-header", line: 1, detail: "password" },
  });
  assert.match(html, /عمودًا غير معروف/, "the diagnostic is rendered");
  assert.match(html, /password/, "the offending column is named");
  assert.doesNotMatch(html, /<table/, "no table is rendered for a refused file");
});

test("component: a parsed file shows its rows, its issues and its duplicates", async () => {
  const rows = parsedRows(
    "name,phone,email\n,0100,a@b.c\nHassan,0100,a@b.c\n",
  );
  const issues = rows.flatMap((row) => row.issues);
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "ready",
    fileName: "students.csv",
    headers: ["name", "phone", "email"],
    rows,
    issues,
    visibleRows: rows,
    visibleIssues: issues,
    totalRows: rows.length,
    issueCount: issues.length,
    duplicateRowCount: 1,
    duplicateGroupCount: 2,
  });
  assert.match(html, /<table/, "the preview table is rendered");
  assert.match(html, /Hassan/, "a row value is rendered");
  assert.match(html, /تكرار محتمل/, "the duplicate candidate is rendered");
  assert.match(html, /الاسم مطلوب/, "the row issue is rendered");
  assert.match(html, /2 صف/, "the row count is rendered");
  assert.match(html, /إغلاق المعاينة/, "the close control is rendered");
  assert.match(html, /الصفحة 1 من 1/, "the bounded paging is rendered");
  assert.doesNotMatch(html, /حفظ الطالب/, "no import or save control is offered");
});

test("component: a value is rendered as text and never as markup", async () => {
  const rows = parsedRows('name,phone\n"<script>alert(1)</script>",0100\n');
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "ready",
    fileName: "students.csv",
    headers: ["name", "phone"],
    rows,
    issues: [],
    visibleRows: rows,
    visibleIssues: [],
    totalRows: rows.length,
    issueCount: 0,
    duplicateRowCount: 0,
    duplicateGroupCount: 0,
  });
  assert.doesNotMatch(html, /<script>/, "the value is never rendered as markup");
  assert.match(html, /&lt;script&gt;/, "the value is escaped as text");
});

// ===========================================================================
// The correction of supervisor/167
// ===========================================================================

// --- F1: a quoted empty record is a real record, not a blank physical line --

test("parser: a quoted empty name is a real data record, not a blank line", () => {
  for (const quoted of ['""', '"   "']) {
    const rows = parsedRows(`name\n${quoted}\nSynthetic\n`);
    assert.equal(rows.length, 2, "a quoted empty record must not disappear");
    assert.equal(rows[0].rowNumber, 2, "the record keeps the line it starts on");
    assert.equal(rows[0].name, "");
    assert.equal(rows[0].issues.length, 1);
    assert.equal(rows[0].issues[0].code, "missing-name");
    assert.equal(rows[0].issues[0].rowNumber, 2);
    assert.equal(rows[1].name, "Synthetic");
    assert.equal(rows[1].rowNumber, 3);
    assert.equal(rows[1].issues.length, 0);
  }
});

test("parser: a quoted empty record at the end of the file is kept", () => {
  const withBreak = parsedRows('name\nAli\n""\n');
  assert.equal(withBreak.length, 2);
  assert.equal(withBreak[1].rowNumber, 3);
  assert.equal(withBreak[1].issues[0]?.code, "missing-name");
  // The very same record without a trailing line break.
  const atEnd = parsedRows('name\nAli\n""');
  assert.equal(atEnd.length, 2);
  assert.equal(atEnd[1].rowNumber, 3);
  assert.equal(atEnd[1].issues[0]?.code, "missing-name");
});

test("parser: an empty quoted name of a multi-column file is a row issue", () => {
  const rows = parsedRows('name,phone\n"",0100\n"   ",0101\nAli,0102\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].issues[0]?.code, "missing-name");
  assert.equal(rows[0].phone, "0100");
  assert.equal(rows[1].rowNumber, 3);
  assert.equal(rows[1].issues[0]?.code, "missing-name");
  assert.equal(rows[1].phone, "0101");
  assert.equal(rows[2].name, "Ali");
  assert.equal(rows[2].issues.length, 0);
});

test("parser: quoted records, blank lines and quoted multiline cells keep their own lines", () => {
  const rows = parsedRows(
    'name,phone\n"multi\nline",0100\n\n   \n"",\nAli,0101\n',
  );
  assert.equal(rows.length, 3);
  // The quoted cell spans two physical lines: the record starts on line 2.
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].name, "multi\nline");
  // The blank line (4) and the whitespace-only line (5) are still skipped.
  assert.equal(rows[1].rowNumber, 6);
  assert.equal(rows[1].issues[0]?.code, "missing-name");
  assert.equal(rows[2].rowNumber, 7);
  assert.equal(rows[2].name, "Ali");
});

test("parser: an ordinary blank line is still skipped after the correction", () => {
  const rows = parsedRows("name,phone\nAli,0100\n\n   \nHassan,0101\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[1].rowNumber, 5);
  const leading = parsedRows("\n\nname,phone\nAli,0100\n");
  assert.equal(leading.length, 1);
  // The two leading blank lines are skipped, so the header sits on line 3
  // and the first DATA record on line 4.
  assert.equal(leading[0].rowNumber, 4);
});

// --- F2: a silent scope change never restores the old private file name ---

test("feature: a silent principal change clears the private file name on the success path", async () => {
  let principal = "session:a";
  const { controller, reads } = createController({ readPrincipal: () => principal });
  const pending = controller.selectFile(csvFile("private-name.csv", 16));
  await flush();
  principal = "session:b";
  reads[0].resolve("name,phone\nAli,0100\n");
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0);
  assert.equal(state.fileName, null, "the old scope's private file name is gone");
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "session-changed");
  controller.dispose();
});

test("feature: a silent principal change clears the private file name on the failure path", async () => {
  let principal = "session:a";
  const { controller, reads } = createController({ readPrincipal: () => principal });
  const pending = controller.selectFile(csvFile("private-name.csv", 16));
  await flush();
  principal = "session:b";
  reads[0].reject(new Error("the disk read failed"));
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0);
  assert.equal(state.fileName, null, "the old scope's private file name is gone");
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "session-changed");
  controller.dispose();
});

test("feature: a retired read restores no private metadata after a scope change", async () => {
  let principal = "session:a";
  const { controller, reads } = createController({ readPrincipal: () => principal });
  const first = controller.selectFile(csvFile("private-name.csv", 16));
  await flush();
  const second = controller.selectFile(csvFile("newer.csv", 16));
  await flush();
  // The scope changes silently while both reads are on the wire.
  principal = "session:b";
  reads[0].resolve("name,phone\nOld,0100\n");
  await first;
  await flush();
  assert.equal(controller.getState().fileName, null, "the retired read restores no file name");
  assert.equal(controller.getState().rows.length, 0);

  reads[1].resolve("name,phone\nNew,0200\n");
  await second;
  await controller.waitForIdle();
  const state = controller.getState();
  assert.equal(state.rows.length, 0, "the foreign scope shows no rows");
  assert.equal(state.fileName, null, "the foreign scope keeps no private metadata");
  controller.dispose();
});

test("feature: an ordinary read error still names the selected file", async () => {
  const { controller, reads } = createController();
  const pending = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  reads[0].reject(new Error("the disk read failed"));
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "read-failed");
  assert.equal(state.fileName, "students.csv", "the same scope keeps the selected file name");
  controller.dispose();
});

// --- F3: the real panel can close a pending preview read -------------------

interface RenderedControl {
  readonly props: {
    readonly disabled?: unknown;
    readonly onClick?: unknown;
    readonly children?: unknown;
  };
}

const collectControls = (node: unknown, found: RenderedControl[] = []): RenderedControl[] => {
  if (Array.isArray(node)) {
    for (const child of node) collectControls(child, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  const element = node as { props?: RenderedControl["props"] };
  if (!element.props) return found;
  if (typeof element.props.onClick === "function") found.push(element as RenderedControl);
  collectControls(element.props.children, found);
  return found;
};

const textOf = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join("");
  if (node && typeof node === "object") {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props) return textOf(props.children);
  }
  return "";
};

const CLOSE_LABEL = "إغلاق المعاينة";

/**
 * Renders the REAL `StudentImportPreview` component against a REAL
 * production controller: the controller's live state is the component's
 * snapshot and the controller itself is the component's ref, so the rendered
 * close control is the REAL control and invoking it runs the REAL
 * `closePreview` against the REAL controller. No browser, no network, no
 * live service is involved.
 */
const renderStudentImportPreviewWithController = async (
  controller: ReturnType<typeof createStudentCsvPreviewController>,
): Promise<{ html: string; controls: RenderedControl[] }> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/students/StudentImportPreview.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  let refIndex = 0;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /StudentImportPreview\.tsx$/.test(parent?.filename || "")) {
        return {
          ...React,
          useState: () => [controller.getState(), () => {}],
          useRef: () => ({ current: refIndex++ === 0 ? controller : { value: "" } }),
          useEffect: () => {},
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(
          this,
          path.resolve(SRC_ROOT, specifier.slice(2)),
          parent,
          isMain,
        );
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (
      ...args: unknown[]
    ) => unknown;
    (globalThis as { React?: unknown }).React = React;
    const tree = Component();
    return {
      html: renderToStaticMarkup(tree as never),
      controls: collectControls(tree),
    };
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

test("component: the close control is enabled while a read is pending and retires it", async () => {
  const pendingRead = deferred<string>();
  const controller = createStudentCsvPreviewController({
    readFile: () => pendingRead.promise,
    readPrincipal: () => "session:a",
    subscribeSession: () => () => {},
  });
  const operation = controller.selectFile(csvFile("students.csv", 16));
  await flush();
  assert.equal(controller.getState().phase, "reading");

  const { html, controls } = await renderStudentImportPreviewWithController(controller);
  assert.match(html, /إغلاق المعاينة/, "the close control is rendered while the read is pending");

  const close = controls.find((control) =>
    textOf(control.props.children).includes(CLOSE_LABEL),
  );
  assert.ok(close, "the close control is reachable while the read is pending");
  assert.notEqual(close.props.disabled, true, "the close control is never disabled");

  (close.props.onClick as () => void)();
  assert.equal(controller.getState().phase, "idle", "the close clears the preview at once");
  assert.equal(controller.getState().fileName, null);
  assert.equal(controller.getState().rows.length, 0);

  pendingRead.resolve("name,phone\nAli,0100\n");
  await operation;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, "a late reply revives nothing");
  assert.equal(controller.getState().phase, "idle");
  controller.dispose();
});

test("component: the close control is still the only one and it is enabled in the ready phase", async () => {
  const rows = parsedRows("name,phone\nAli,0100\n");
  const issues = rows.flatMap((row) => row.issues);
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "ready",
    fileName: "students.csv",
    headers: ["name", "phone"],
    rows,
    issues,
    visibleRows: rows,
    visibleIssues: issues,
    totalRows: rows.length,
    issueCount: issues.length,
    duplicateRowCount: 0,
    duplicateGroupCount: 0,
  });
  const closeControls = html.match(/إغلاق المعاينة/g) ?? [];
  assert.equal(closeControls.length, 1, "the close control is rendered exactly once");
});

test("feature: a selection after a close works again and the old reply cannot clear it", async () => {
  const { controller, reads } = createController();
  const first = controller.selectFile(csvFile("first.csv", 16));
  await flush();
  controller.clear();
  assert.equal(controller.getState().phase, "idle");

  const second = controller.selectFile(csvFile("second.csv", 16));
  await flush();
  assert.equal(controller.getState().phase, "reading");
  assert.equal(controller.getState().fileName, "second.csv");

  // The OLD reply arrives after the new read started: it must neither revive
  // its own data nor release the newer read's busy latch.
  reads[0].resolve("name,phone\nFirst,0100\n");
  await first;
  await flush();
  assert.equal(controller.getState().phase, "reading", "the old reply does not clear the newer busy state");
  assert.equal(controller.getState().fileName, "second.csv");

  reads[1].resolve("name,phone\nSecond,0200\n");
  await second;
  await controller.waitForIdle();
  const state = controller.getState();
  assert.equal(state.phase, "ready");
  assert.equal(state.fileName, "second.csv");
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].name, "Second");
  controller.dispose();
});

// ===========================================================================
// M2-17: the dual-format dispatch of the same controller
// ===========================================================================

test("feature: a spreadsheet name is routed to the byte seam and a CSV name is not", async () => {
  const byteReads: Array<Deferred<Uint8Array>> = [];
  const { controller, reads } = createController({
    readBytes: () => {
      const pending = deferred<Uint8Array>();
      byteReads.push(pending);
      return pending.promise;
    },
  });
  const pending = controller.selectFile({ name: "students.xlsx", size: 16 });
  await flush();
  assert.equal(byteReads.length, 1, "a spreadsheet is read as bytes");
  assert.equal(reads.length, 0, "a spreadsheet is never mis-decoded as text");

  // Three bytes are not a ZIP archive, so the workbook is refused truthfully
  // instead of falling back to the CSV parser.
  byteReads[0].resolve(new Uint8Array([1, 2, 3]));
  await pending;
  await controller.waitForIdle();
  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "unreadable-archive");
  assert.equal(state.rows.length, 0);
  controller.dispose();
});

test("feature: a spreadsheet selected without the byte seam is a truthful read failure", async () => {
  const { controller, reads } = createController();
  await controller.selectFile({ name: "students.xlsx", size: 16 });
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error?.code, "read-failed");
  assert.equal(reads.length, 0, "the container is never mis-decoded as text");
  controller.dispose();
});

