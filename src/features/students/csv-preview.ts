/**
 * M2-08 — the local student CSV preview seam.
 *
 * Scope (human152 delegation, `docs/streams/client/M2-08-HANDOFF.md`): a
 * READ-ONLY, LOCAL preview of the instructor's own student CSV file. Nothing
 * in this module creates, updates or imports a student: there is no
 * `createStudent` call, no bulk endpoint, no persistence (localStorage,
 * sessionStorage or IndexedDB) and no network of any kind. The seam prepares
 * local input only and shows what the file structurally contains, which rows
 * are structurally problematic and where an EXACT duplicate value appears
 * inside the file. Server validity, existing-record duplicates, XLSX and the
 * audited import commit remain separate recorded gaps.
 *
 * Two seams live in this file:
 *
 *  - `parseStudentCsv`: the PURE, BOUNDED parser. It fails CLOSED with a
 *    truthful diagnostic on malformed quoting, an unknown/duplicate header, a
 *    missing `name` header, a ragged record, an unsupported format or any
 *    exceeded limit. It never guesses a column mapping and never coerces a
 *    value: `007` stays `007` and `+20…` stays `+20…`.
 *  - `createStudentCsvPreviewController`: the injected LIFECYCLE seam. The
 *    read is injected (`readFile`), the canonical principal is read-only and
 *    the canonical session notifier is read-only. A newer selection
 *    supersedes an older one, a silent principal change is observed BEFORE
 *    any visible state is settled, and a retired read never revives data and
 *    never releases a newer read's busy latch.
 *
 * The limits below are explicit implementation bounds, NOT business
 * entitlements: 1 MiB of UTF-8 text, 1000 data records, 6 columns, 4096
 * characters per cell and 25 rendered rows per page. They are enforced while
 * parsing and before any unbounded work, so an over-limit file is rejected
 * outright instead of producing a misleading successful partial preview.
 */

import { readInstructorSessionPrincipal } from '../enrollment/instructor-students';
import type { InstructorSessionStorage } from '../enrollment/instructor-students';
// M2-17: the bounded local XLSX decoder. The cycle is deliberate and safe:
// both modules only reach for each other's exports from inside function
// bodies, never at module-initialisation time.
import {
  isStudentSpreadsheetFileName,
  parseStudentPreviewFile,
} from './xlsx-preview';

export { readInstructorSessionPrincipal } from '../enrollment/instructor-students';
export type { InstructorSessionStorage } from '../enrollment/instructor-students';
export {
  isStudentSpreadsheetFileName,
  isStudentXlsxFileName,
  STUDENT_XLSX_MAX_BYTES,
  STUDENT_XLSX_MAX_ZIP_ENTRIES,
  STUDENT_XLSX_MAX_UNCOMPRESSED_BYTES,
  STUDENT_XLSX_MAX_XML_ENTRY_BYTES,
  STUDENT_XLSX_MAX_SHARED_STRINGS,
  STUDENT_XLSX_MAX_ROWS,
} from './xlsx-preview';

/**
 * M2-17: reads a spreadsheet container as bytes through the injected byte
 * seam. A missing seam is a truthful `read-failed`: the container is never
 * mis-decoded as text to paper over the wiring.
 */
const readSpreadsheetBytes = async (
  api: StudentCsvPreviewApi,
  file: StudentCsvPreviewFile,
): Promise<Uint8Array> => {
  if (typeof api.readBytes !== 'function') {
    throw new Error('the byte read seam is unavailable');
  }
  const bytes = await api.readBytes(file);
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('the byte read seam did not return bytes');
  }
  return bytes;
};

// ---------------------------------------------------------------------------
// Bounds and the accepted column vocabulary
// ---------------------------------------------------------------------------

/** The maximum UTF-8 size of the selected file (1 MiB). */
export const STUDENT_CSV_MAX_BYTES = 1024 * 1024;
/** The maximum number of data records (the header is not a data record). */
export const STUDENT_CSV_MAX_RECORDS = 1000;
/** The maximum number of columns in the file. */
export const STUDENT_CSV_MAX_COLUMNS = 6;
/** The maximum number of characters in a single cell. */
export const STUDENT_CSV_MAX_CELL_CHARS = 4096;
/** The number of rows and issues rendered per page. */
export const STUDENT_CSV_PAGE_SIZE = 25;

/** Every column the preview understands, in the documented order. */
export const STUDENT_CSV_COLUMNS = [
  'name',
  'email',
  'phone',
  'guardian_phone',
  'grade',
  'barcode',
] as const;

export type StudentCsvColumn = (typeof STUDENT_CSV_COLUMNS)[number];

/** The only required column. */
export const STUDENT_CSV_REQUIRED_COLUMN: StudentCsvColumn = 'name';

/**
 * The columns whose EXACT trimmed value is compared inside the file for
 * duplicate CANDIDATES. A blank value never matches anything.
 */
export const STUDENT_CSV_DUPLICATE_COLUMNS = ['phone', 'email', 'barcode'] as const;

export type StudentCsvDuplicateColumn = (typeof STUDENT_CSV_DUPLICATE_COLUMNS)[number];

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * Every reason the preview can refuse a file. Each one is a STRUCTURAL
 * failure of the file as a whole: the preview fails closed and never shows a
 * partially accepted file as if it were ready.
 */
export type StudentCsvErrorCode =
  | 'empty-file'
  | 'unsupported-format'
  | 'unsupported-encoding'
  | 'input-too-large'
  | 'too-many-records'
  | 'too-many-columns'
  | 'cell-too-long'
  | 'malformed-quote'
  | 'unknown-header'
  | 'empty-header'
  | 'duplicate-header'
  | 'missing-name-header'
  | 'ragged-record'
  | 'read-failed'
  | 'session-changed'
  // --- M2-17: the bounded local XLSX decoder -------------------------------
  // The XLSX decoder deliberately reuses the CSV diagnostic vocabulary for
  // every rule that means the same thing in both formats (a too-long cell, an
  // unknown header, a ragged record, …) and adds the codes below for the
  // failures that only a spreadsheet container can produce. One union keeps
  // the dual-format preview state, its rendering and its tests simple.
  /** A password-protected workbook (a workbookProtection password). */
  | 'password-protected'
  /** The container is not a readable ZIP archive. */
  | 'unreadable-archive'
  /** More than STUDENT_XLSX_MAX_ZIP_ENTRIES entries. */
  | 'too-many-zip-entries'
  /** The declared uncompressed size of the whole archive exceeds its bound. */
  | 'archive-too-large'
  /** One relevant XML entry declares more than its bound. */
  | 'entry-too-large'
  /** The same ZIP path is declared twice. */
  | 'duplicate-zip-entry'
  /** A ZIP path escapes the archive (traversal, absolute or a drive letter). */
  | 'unsafe-zip-path'
  /** A compression method other than stored/deflate. */
  | 'unsupported-compression'
  /** xl/workbook.xml is absent or unusable. */
  | 'missing-workbook-part'
  /** No worksheet, or a relationship that cannot be resolved. */
  | 'missing-worksheet'
  /** A relevant XML part is not well formed. */
  | 'malformed-xml'
  /** A workbook construct the decoder refuses: macros, external links,
   *  drawings, media, charts, controls, pivot tables or query tables. */
  | 'unsupported-workbook-part'
  /** A formula, or a cached formula result, where a literal value is required. */
  | 'formula-cell'
  /** A cell type the decoder refuses: boolean or error. */
  | 'unsupported-cell-type'
  /** More than STUDENT_XLSX_MAX_SHARED_STRINGS shared strings. */
  | 'too-many-shared-strings';

export interface StudentCsvError {
  readonly code: StudentCsvErrorCode;
  /** The physical line the problem was found on, when the problem has one. */
  readonly line: number | null;
  /**
   * A short truthful detail: the offending column name, the offending row
   * number or the exceeded limit. It never contains a student value.
   */
  readonly detail: string | null;
}

/** The only row-level issue the preview reports: a missing required name. */
export type StudentCsvRowIssueCode = 'missing-name';

export interface StudentCsvRowIssue {
  readonly code: StudentCsvRowIssueCode;
  readonly field: 'name';
  /** The physical line the record starts on. */
  readonly rowNumber: number;
}

/**
 * An EXACT, within-file duplicate. It is a CANDIDATE only: the preview never
 * merges, deletes or auto-resolves anything and never claims that a value is
 * unique in the database.
 */
export interface StudentCsvDuplicateCandidate {
  readonly field: StudentCsvDuplicateColumn;
  /** The exact trimmed value shared by the rows. */
  readonly value: string;
  /** Every row number in this file that carries this exact trimmed value. */
  readonly rowNumbers: number[];
}

export interface StudentCsvRow {
  /**
   * The physical line in the ORIGINAL file where this record starts. A
   * record whose quoted cell spans several lines is numbered by its FIRST
   * line, so the number always points at a real line of the file.
   */
  readonly rowNumber: number;
  /** The 1-based index of the record among the data records. */
  readonly rowIndex: number;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly guardian_phone: string;
  readonly grade: string;
  readonly barcode: string;
  /** The row-level problems of this record. */
  readonly issues: StudentCsvRowIssue[];
  /** The within-file duplicate candidates of this record. */
  readonly duplicates: StudentCsvDuplicateCandidate[];
}

export type StudentCsvParseResult =
  | { readonly ok: true; readonly headers: StudentCsvColumn[]; readonly rows: StudentCsvRow[] }
  | { readonly ok: false; readonly error: StudentCsvError };

// ---------------------------------------------------------------------------
// The bounded parser
// ---------------------------------------------------------------------------

interface RawRecord {
  /** The physical line the record starts on. */
  readonly line: number;
  readonly fields: string[];
}

/**
 * M2-17: a decoded record, independent of the container it came from.
 *
 * `fields` are the RAW cell texts of the record in file order, already
 * extracted from the container but NOT yet trimmed. `line` is the physical
 * line (CSV) or the physical worksheet row number (XLSX) the record starts
 * on, so it always points at a real place in the file the instructor opened.
 */
export interface StudentCsvSourceRecord {
  readonly line: number;
  readonly fields: readonly string[];
}

const isColumn = (value: string): value is StudentCsvColumn =>
  (STUDENT_CSV_COLUMNS as readonly string[]).indexOf(value) !== -1;

/**
 * The exact UTF-8 byte length of a string, computed without allocating an
 * encoded buffer. An unpaired surrogate counts as the three bytes the
 * replacement character needs, which is what the encoder produces.
 */
const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
};

/**
 * Splits the text into records with a single bounded pass.
 *
 * The scanner never uses a regular expression and never splits the whole
 * text into an unbounded array: the cell length, the column count and the
 * record count are all enforced WHILE the text is scanned, so an over-limit
 * file is refused before the work is done.
 */
const scanRecords = (
  text: string,
): { records: RawRecord[] } | { error: StudentCsvError } => {
  const records: RawRecord[] = [];
  let fields: string[] = [];
  let cell = '';
  let cellLength = 0;
  let inQuotes = false;
  let afterClosingQuote = false;
  let recordLine = 1;
  let recordHasContent = false;
  /**
   * Whether the CURRENT record carries an explicitly QUOTED field. A quoted
   * field is an explicit data record even when its value is empty, so it is
   * never mistaken for a blank physical line.
   */
  let recordHasQuotedField = false;
  let line = 1;

  const fail = (code: StudentCsvErrorCode, detail: string | null, atLine: number): { error: StudentCsvError } => ({
    error: { code, line: atLine, detail },
  });

  const pushField = (): boolean => {
    if (fields.length >= STUDENT_CSV_MAX_COLUMNS) return false;
    fields.push(cell);
    cell = '';
    cellLength = 0;
    return true;
  };

  const endRecord = (): 'ok' | 'too-many-columns' | 'too-many-records' => {
    if (fields.length >= STUDENT_CSV_MAX_COLUMNS) return 'too-many-columns';
    fields.push(cell);
    cell = '';
    cellLength = 0;
    // A record that carries exactly one empty field is a BLANK line: it is
    // skipped, so a blank line never shifts the row numbers of the records
    // that follow it and never counts against the record bound.
    //
    // A QUOTED empty (or whitespace-only) field is NOT a blank line: the
    // quotes make it an explicit data record, so it is KEPT and reported as
    // a row with a missing name. Silently dropping it would lose a record
    // the file actually carries.
    if (fields.length === 1 && fields[0].trim() === '' && !recordHasQuotedField) {
      fields = [];
      recordHasContent = false;
      recordHasQuotedField = false;
      return 'ok';
    }
    records.push({ line: recordLine, fields });
    // The header is one of the records, so the data records are the rest.
    if (records.length > STUDENT_CSV_MAX_RECORDS + 1) return 'too-many-records';
    fields = [];
    recordHasContent = false;
    recordHasQuotedField = false;
    return 'ok';
  };

  const failOn = (
    status: 'ok' | 'too-many-columns' | 'too-many-records',
  ): { error: StudentCsvError } | null => {
    if (status === 'ok') return null;
    return {
      error: {
        code: status,
        line: recordLine,
        detail:
          status === 'too-many-records'
            ? String(STUDENT_CSV_MAX_RECORDS)
            : String(STUDENT_CSV_MAX_COLUMNS),
      },
    };
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          if (cellLength + 1 > STUDENT_CSV_MAX_CELL_CHARS) {
            return fail('cell-too-long', String(STUDENT_CSV_MAX_CELL_CHARS), recordLine);
          }
          cell += '"';
          cellLength += 1;
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
        continue;
      }
      if (character === '\n') line += 1;
      if (cellLength + 1 > STUDENT_CSV_MAX_CELL_CHARS) {
        return fail('cell-too-long', String(STUDENT_CSV_MAX_CELL_CHARS), recordLine);
      }
      cell += character;
      cellLength += 1;
      continue;
    }

    if (afterClosingQuote) {
      // After a closing quote only a separator, a line break or the end of the
      // text may follow. Anything else is a malformed quoting.
      if (character === ',') {
        if (!pushField()) return fail('too-many-columns', String(STUDENT_CSV_MAX_COLUMNS), recordLine);
        afterClosingQuote = false;
        recordHasContent = true;
        continue;
      }
      if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        const failure = failOn(endRecord());
        if (failure) return failure;
        line += 1;
        recordLine = line;
        afterClosingQuote = false;
        continue;
      }
      return fail('malformed-quote', null, recordLine);
    }

    if (character === '"') {
      // A quote may only open a field: a quote inside an unquoted field is a
      // malformed quoting, never a guess.
      if (cellLength > 0) return fail('malformed-quote', null, recordLine);
      inQuotes = true;
      recordHasContent = true;
      recordHasQuotedField = true;
      continue;
    }

    if (character === ',') {
      if (!pushField()) return fail('too-many-columns', String(STUDENT_CSV_MAX_COLUMNS), recordLine);
      recordHasContent = true;
      continue;
    }

    if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      if (recordHasContent || fields.length > 0 || cellLength > 0) {
        const failure = failOn(endRecord());
        if (failure) return failure;
      }
      line += 1;
      recordLine = line;
      continue;
    }

    if (cellLength + 1 > STUDENT_CSV_MAX_CELL_CHARS) {
      return fail('cell-too-long', String(STUDENT_CSV_MAX_CELL_CHARS), recordLine);
    }
    cell += character;
    cellLength += 1;
    recordHasContent = true;
  }

  if (inQuotes) return fail('malformed-quote', null, recordLine);
  if (afterClosingQuote || recordHasContent || fields.length > 0 || cellLength > 0) {
    const failure = failOn(endRecord());
    if (failure) return failure;
  }
  return { records };
};

/**
 * The exact within-file duplicate candidates.
 *
 * The values are grouped with a map, so the work is linear in the number of
 * rows: no all-pairs comparison is ever performed. A blank value never
 * matches anything and the comparison is EXACT (case sensitive) after the
 * surrounding whitespace has been trimmed.
 */
const collectDuplicates = (rows: StudentCsvRow[]): void => {
  const groups = new Map<StudentCsvDuplicateColumn, Map<string, number[]>>();
  for (const row of rows) {
    for (const field of STUDENT_CSV_DUPLICATE_COLUMNS) {
      const value = row[field];
      if (value === '') continue;
      let byValue = groups.get(field);
      if (!byValue) {
        byValue = new Map<string, number[]>();
        groups.set(field, byValue);
      }
      const existing = byValue.get(value);
      if (existing) existing.push(row.rowNumber);
      else byValue.set(value, [row.rowNumber]);
    }
  }
  if (groups.size === 0) return;
  const byRowNumber = new Map<number, StudentCsvRow>();
  for (const row of rows) byRowNumber.set(row.rowNumber, row);
  for (const [field, byValue] of groups) {
    for (const [value, rowNumbers] of byValue) {
      if (rowNumbers.length < 2) continue;
      for (const rowNumber of rowNumbers) {
        const row = byRowNumber.get(rowNumber);
        if (!row) continue;
        row.duplicates.push({ field, value, rowNumbers });
      }
    }
  }
};

/**
 * M2-17: maps a decoded record list onto the canonical preview rows.
 *
 * This is the ONE place where the six-column vocabulary, the required `name`
 * header, the missing-name issue and the within-file duplicate candidates are
 * decided. The CSV scanner and the XLSX worksheet decoder both hand their
 * records here, so a spreadsheet and a CSV file with identical content
 * produce byte-identical `headers`, `rows`, `issues` and `duplicates`.
 *
 * The mapping FAILS CLOSED exactly as the CSV parser always did: an unknown,
 * empty, duplicated or `name`-less header, a ragged record or an exceeded
 * column bound produces a diagnostic and no rows at all.
 */
export function buildStudentPreviewFromRecords(
  records: readonly StudentCsvSourceRecord[],
): StudentCsvParseResult {
  if (records.length === 0) {
    return { ok: false, error: { code: 'empty-file', line: null, detail: null } };
  }

  // --- the header row -----------------------------------------------------
  const headerRecord = records[0];
  const headerValues = headerRecord.fields.map((field) => field.trim());
  const headers: StudentCsvColumn[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < headerValues.length; index += 1) {
    const header = headerValues[index];
    if (header === '') {
      return { ok: false, error: { code: 'empty-header', line: headerRecord.line, detail: null } };
    }
    if (!isColumn(header)) {
      return { ok: false, error: { code: 'unknown-header', line: headerRecord.line, detail: header } };
    }
    if (seen.has(header)) {
      return { ok: false, error: { code: 'duplicate-header', line: headerRecord.line, detail: header } };
    }
    seen.set(header, index);
    headers.push(header);
  }
  if (!seen.has(STUDENT_CSV_REQUIRED_COLUMN)) {
    return { ok: false, error: { code: 'missing-name-header', line: headerRecord.line, detail: null } };
  }

  // --- the data records ---------------------------------------------------
  const rows: StudentCsvRow[] = [];
  const issues: StudentCsvRowIssue[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    if (record.fields.length !== headerValues.length) {
      return {
        ok: false,
        error: { code: 'ragged-record', line: record.line, detail: String(record.line) },
      };
    }
    const values: Record<string, string> = {};
    for (let column = 0; column < headerValues.length; column += 1) {
      values[headerValues[column]] = record.fields[column].trim();
    }
    const rowIssues: StudentCsvRowIssue[] = [];
    const name = values.name ?? '';
    if (name === '') {
      rowIssues.push({ code: 'missing-name', field: 'name', rowNumber: record.line });
    }
    const row: StudentCsvRow = {
      rowNumber: record.line,
      rowIndex: rows.length + 1,
      name,
      email: values.email ?? '',
      phone: values.phone ?? '',
      guardian_phone: values.guardian_phone ?? '',
      grade: values.grade ?? '',
      barcode: values.barcode ?? '',
      issues: rowIssues,
      duplicates: [],
    };
    rows.push(row);
    for (const issue of rowIssues) issues.push(issue);
  }

  collectDuplicates(rows);

  return { ok: true, headers, rows };
}

/**
 * Parses a student CSV file into a bounded preview.
 *
 * The parser FAILS CLOSED: a file that is structurally wrong produces a
 * diagnostic and no rows at all, never a partially accepted file.
 */
export function parseStudentCsv(input: string): StudentCsvParseResult {
  if (typeof input !== 'string') {
    return { ok: false, error: { code: 'unsupported-format', line: null, detail: null } };
  }
  // The encoded bound is checked at the parser entry, so a file that reached
  // the parser as text can still be refused for its real byte size.
  if (input.length > STUDENT_CSV_MAX_BYTES) {
    return { ok: false, error: { code: 'input-too-large', line: null, detail: String(STUDENT_CSV_MAX_BYTES) } };
  }
  if (utf8ByteLength(input) > STUDENT_CSV_MAX_BYTES) {
    return { ok: false, error: { code: 'input-too-large', line: null, detail: String(STUDENT_CSV_MAX_BYTES) } };
  }

  // An optional UTF-8 byte order mark is consumed; it is not part of the
  // first header name.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  // A binary container (XLSX, XLS, an image, …) is not a CSV file.
  if (text.indexOf('\u0000') !== -1) {
    return { ok: false, error: { code: 'unsupported-format', line: null, detail: null } };
  }
  // The decoder replaces invalid UTF-8 with the replacement character.
  if (text.indexOf('\ufffd') !== -1) {
    return { ok: false, error: { code: 'unsupported-encoding', line: null, detail: null } };
  }
  if (text.trim() === '') {
    return { ok: false, error: { code: 'empty-file', line: null, detail: null } };
  }

  const scanned = scanRecords(text);
  if ('error' in scanned) return { ok: false, error: scanned.error };
  const records = scanned.records;
  if (records.length === 0) {
    return { ok: false, error: { code: 'empty-file', line: null, detail: null } };
  }

  return buildStudentPreviewFromRecords(records);
}

// ---------------------------------------------------------------------------
// The injected lifecycle controller
// ---------------------------------------------------------------------------

export type StudentCsvPreviewPhase = 'idle' | 'reading' | 'ready' | 'empty' | 'error';

/** The minimal surface of the selected file the seam needs. */
export interface StudentCsvPreviewFile {
  readonly name: string;
  readonly size: number;
}

export interface StudentCsvPreviewState {
  readonly phase: StudentCsvPreviewPhase;
  /** The name of the selected file (display only). */
  readonly fileName: string | null;
  /** Every parsed data record (bounded by STUDENT_CSV_MAX_RECORDS). */
  readonly rows: StudentCsvRow[];
  /** The columns the file actually carries, in file order. */
  readonly headers: StudentCsvColumn[];
  /** The row-level issues of the file. */
  readonly issues: StudentCsvRowIssue[];
  /** The structural diagnostic of a refused file, or null. */
  readonly error: StudentCsvError | null;
  /** The current page of rows (0 based). */
  readonly rowPage: number;
  /** The current page of issues (0 based). */
  readonly issuePage: number;
  /** At most STUDENT_CSV_PAGE_SIZE rows: the DOM never grows with the file. */
  readonly visibleRows: StudentCsvRow[];
  /** At most STUDENT_CSV_PAGE_SIZE issues. */
  readonly visibleIssues: StudentCsvRowIssue[];
  readonly totalRows: number;
  readonly issueCount: number;
  readonly duplicateRowCount: number;
  readonly duplicateGroupCount: number;
}

export interface StudentCsvPreviewApi {
  /** The injected async read seam: it resolves with the decoded text. */
  readFile: (file: StudentCsvPreviewFile) => Promise<string>;
  /**
   * M2-17: the injected async BYTE read seam, used only for a spreadsheet
   * container. It stays optional so the accepted CSV wiring keeps working
   * unchanged; a spreadsheet selected without it is refused with a truthful
   * `read-failed` instead of being silently mis-decoded.
   */
  readBytes?: (file: StudentCsvPreviewFile) => Promise<Uint8Array>;
  /** The canonical principal reader. It is READ-ONLY here. */
  readPrincipal: () => string | null;
  /** The canonical session notifier. It is READ-ONLY here. */
  subscribeSession: (listener: () => void) => () => void;
}

export interface StudentCsvPreviewController {
  getState(): StudentCsvPreviewState;
  subscribe(listener: (state: StudentCsvPreviewState) => void): () => void;
  /**
   * Selects a file. The declared size is checked BEFORE the read starts, so
   * an over-sized file is never even read.
   */
  selectFile(file: StudentCsvPreviewFile): Promise<void>;
  /** Closes the preview: the private rows and issues are cleared. */
  clear(): void;
  nextRowPage(): void;
  previousRowPage(): void;
  nextIssuePage(): void;
  previousIssuePage(): void;
  waitForIdle(): Promise<void>;
  dispose(): void;
}

const emptyState = (): StudentCsvPreviewState => ({
  phase: 'idle',
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

const pageOf = <T,>(items: T[], page: number, size: number): T[] => {
  const start = Math.max(0, page) * size;
  return items.slice(start, start + size);
};

const maxPageOf = (total: number, size: number): number =>
  total <= 0 ? 0 : Math.ceil(total / size) - 1;

export function createStudentCsvPreviewController(
  api: StudentCsvPreviewApi,
): StudentCsvPreviewController {
  let state = emptyState();
  let disposed = false;
  const listeners = new Set<(state: StudentCsvPreviewState) => void>();
  const pending = new Set<Promise<unknown>>();
  /** Read generation: every selection, clear, session change or dispose
   *  advances it, so an older reply can no longer commit. */
  let readGeneration = 0;
  /** The read that owns the visible busy phase. A retired read releases only
   *  its own latch, so it can never clear a newer read's busy presentation. */
  let busyOwner = 0;
  const readPrincipal = (): string | null => api.readPrincipal();
  let observedPrincipal = readPrincipal();

  const patch = (changes: Partial<StudentCsvPreviewState>): void => {
    state = { ...state, ...changes };
    state = {
      ...state,
      visibleRows: pageOf(state.rows, state.rowPage, STUDENT_CSV_PAGE_SIZE),
      visibleIssues: pageOf(state.issues, state.issuePage, STUDENT_CSV_PAGE_SIZE),
    };
    for (const listener of [...listeners]) listener(state);
  };

  const track = (operation: Promise<unknown>): void => {
    pending.add(operation);
    void operation.then(
      () => { pending.delete(operation); },
      () => { pending.delete(operation); },
    );
  };

  /** Clears every private trace of the preview (rows, issues, file name). */
  const clearPrivateState = (): Partial<StudentCsvPreviewState> => ({
    phase: 'idle',
    fileName: null,
    rows: [],
    headers: [],
    issues: [],
    error: null,
    rowPage: 0,
    issuePage: 0,
    totalRows: 0,
    issueCount: 0,
    duplicateRowCount: 0,
    duplicateGroupCount: 0,
  });

  /**
   * Adopts an observed principal change (a silent logout or scope swap that
   * produced no notifier event). The private rows and issues are cleared
   * BEFORE anything else is settled, and every in-flight read is retired.
   */
  const adoptPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    readGeneration += 1;
    busyOwner = 0;
    patch(clearPrivateState());
    return true;
  };

  /**
   * Adopts an observed principal change on behalf of a RETIRED read.
   *
   * A retired read observes the canonical principal BEFORE it settles any
   * visible state, so a silent logout that happened while its reply was on
   * the wire is never revived by it. The busy latch is deliberately NOT
   * released here: every read releases its own latch in its `finally`.
   */
  const adoptRetiredPrincipalChange = (observed: string | null): boolean => {
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    readGeneration += 1;
    patch(clearPrivateState());
    return true;
  };

  const settleError = (generation: number, error: StudentCsvError): void => {
    if (generation !== readGeneration) return;
    if (busyOwner !== generation) return;
    patch({ ...clearPrivateState(), phase: 'error', fileName: state.fileName, error });
  };

  const settleReady = (
    generation: number,
    headers: StudentCsvColumn[],
    rows: StudentCsvRow[],
    issues: StudentCsvRowIssue[],
  ): void => {
    if (generation !== readGeneration) return;
    if (busyOwner !== generation) return;
    let duplicateRowCount = 0;
    let duplicateGroupCount = 0;
    const groups = new Set<string>();
    for (const row of rows) {
      if (row.duplicates.length > 0) duplicateRowCount += 1;
      for (const candidate of row.duplicates) {
        const key = `${candidate.field} ${candidate.value}`;
        if (!groups.has(key)) {
          groups.add(key);
          duplicateGroupCount += 1;
        }
      }
    }
    patch({
      phase: rows.length === 0 ? 'empty' : 'ready',
      headers,
      rows,
      issues,
      error: null,
      rowPage: 0,
      issuePage: 0,
      totalRows: rows.length,
      issueCount: issues.length,
      duplicateRowCount,
      duplicateGroupCount,
    });
  };

  const selectFile = async (file: StudentCsvPreviewFile): Promise<void> => {
    if (disposed) return;
    const generation = ++readGeneration;
    busyOwner = generation;
    // Entry observation: a silent principal change (a logout or a scope swap
    // that produced no notifier event) is adopted BEFORE the read starts, so
    // the previous principal's private rows are cleared first.
    const entryPrincipal = readPrincipal();
    if (entryPrincipal !== observedPrincipal) {
      observedPrincipal = entryPrincipal;
      patch(clearPrivateState());
    }

    patch({
      ...clearPrivateState(),
      phase: 'reading',
      fileName: file.name,
    });

    try {
      // The declared size is checked BEFORE the file is read at all.
      if (file.size > STUDENT_CSV_MAX_BYTES) {
        settleError(generation, {
          code: 'input-too-large',
          line: null,
          detail: String(STUDENT_CSV_MAX_BYTES),
        });
        return;
      }
      const spreadsheet = isStudentSpreadsheetFileName(file.name);
      const read = spreadsheet
        ? await readSpreadsheetBytes(api, file)
        : await api.readFile(file);
      if (disposed) return;
      if (generation !== readGeneration) {
        // A newer selection owns the preview now: this reply is never
        // committed. The canonical principal is observed BEFORE any visible
        // state is settled, so a silent logout is never revived by it.
        const observed = readPrincipal();
        if (observed !== entryPrincipal && adoptRetiredPrincipalChange(observed)) return;
        return;
      }
      // Completion observation: a principal swapped while the read was on the
      // wire makes this reply foreign.
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== entryPrincipal) {
        // The OLD scope's private file metadata is GONE: the captured file
        // name is deliberately NOT restored, not even to decorate the
        // session-changed diagnostic.
        adoptPrincipalChange(committedPrincipal);
        patch({
          ...clearPrivateState(),
          phase: 'error',
          error: { code: 'session-changed', line: null, detail: null },
        });
        return;
      }
      const parsed = parseStudentPreviewFile(file.name, read);
      if (parsed.ok === false) {
        settleError(generation, parsed.error);
        return;
      }
      const issues: StudentCsvRowIssue[] = [];
      for (const row of parsed.rows) for (const issue of row.issues) issues.push(issue);
      settleReady(generation, parsed.headers, parsed.rows, issues);
    } catch {
      if (disposed) return;
      if (generation !== readGeneration) {
        // The canonical principal is observed BEFORE any visible state is
        // settled on the failure path too, so a silent logout is never
        // revived by a retired reply.
        const observed = readPrincipal();
        if (observed !== entryPrincipal && adoptRetiredPrincipalChange(observed)) return;
        return;
      }
      const committedPrincipal = readPrincipal();
      if (committedPrincipal !== entryPrincipal) {
        // The OLD scope's private file metadata is GONE: the captured file
        // name is deliberately NOT restored, not even to decorate the
        // session-changed diagnostic.
        adoptPrincipalChange(committedPrincipal);
        patch({
          ...clearPrivateState(),
          phase: 'error',
          error: { code: 'session-changed', line: null, detail: null },
        });
        return;
      }
      settleError(generation, { code: 'read-failed', line: null, detail: null });
    } finally {
      // Only its own latch: a retired read's `finally` can never release a
      // NEWER read's busy latch.
      if (busyOwner === generation) busyOwner = 0;
    }
  };

  const clear = (): void => {
    readGeneration += 1;
    busyOwner = 0;
    patch(clearPrivateState());
  };

  const unsubscribeSession = api.subscribeSession(() => {
    // A session change clears the private preview and retires the pending
    // read, so a reply that arrives afterwards can revive nothing.
    readGeneration += 1;
    busyOwner = 0;
    observedPrincipal = readPrincipal();
    patch(clearPrivateState());
  });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    selectFile: (file) => {
      const operation = selectFile(file);
      track(operation);
      return operation;
    },
    clear,
    nextRowPage: () => {
      const next = Math.min(state.rowPage + 1, maxPageOf(state.totalRows, STUDENT_CSV_PAGE_SIZE));
      if (next !== state.rowPage) patch({ rowPage: next });
    },
    previousRowPage: () => {
      const next = Math.max(state.rowPage - 1, 0);
      if (next !== state.rowPage) patch({ rowPage: next });
    },
    nextIssuePage: () => {
      const next = Math.min(state.issuePage + 1, maxPageOf(state.issueCount, STUDENT_CSV_PAGE_SIZE));
      if (next !== state.issuePage) patch({ issuePage: next });
    },
    previousIssuePage: () => {
      const next = Math.max(state.issuePage - 1, 0);
      if (next !== state.issuePage) patch({ issuePage: next });
    },
    waitForIdle: async () => {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      readGeneration += 1;
      busyOwner = 0;
      unsubscribeSession();
      listeners.clear();
      patch(clearPrivateState());
    },
  };
}

/**
 * The canonical principal reader, exactly as the accepted enrollment page
 * uses it. It is re-exported so the component does not build a second,
 * parallel session state.
 */
export const readStudentCsvSessionPrincipal = readInstructorSessionPrincipal;

/** The storage surface the canonical principal reader needs. */
export type StudentCsvSessionStorage = InstructorSessionStorage;
