/**
 * C12 student CSV import domain policy.
 *
 * Pure, deterministic and I/O-free except for the injected duplicate lookup.
 * The parser is a small RFC 4180-style reader (quoted fields, escaped quotes,
 * CR/LF/CRLF, BOM) with hard byte/row/column limits. It validates headers,
 * types and every row, produces a rejected-row report, resolves duplicates
 * against caller-injected existing keys, and always neutralizes CSV formula
 * injection in any exported cell. No password/hash column is ever accepted,
 * stored or echoed.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

import { createHash } from 'crypto';

export const MAX_CSV_BYTES = 512 * 1024;
export const MAX_CSV_ROWS = 1000;
export const MAX_FIELD_LENGTH = 500;
export const MAX_HEADER_COLUMNS = 40;

export const REQUIRED_HEADERS = ['name'] as const;
export const OPTIONAL_HEADERS = ['phone', 'email', 'grade', 'parent_phone', 'notes'] as const;
export const FORBIDDEN_HEADERS = ['password', 'password_hash', 'pass', 'pwd', 'hash'] as const;

const ALLOWED_HEADERS = new Set<string>([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);
const FORBIDDEN_HEADER_SET = new Set<string>(FORBIDDEN_HEADERS);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[0-9()\-\s]{5,30}$/;

export type DuplicateResolution = 'skip' | 'update' | 'error';

export function normalizeDuplicateResolution(value: unknown): DuplicateResolution {
    return value === 'update' || value === 'error' ? value : 'skip';
}

export interface StudentImportRow {
    rowNumber: number;
    name: string;
    phone: string | null;
    email: string | null;
    grade: string | null;
    parentPhone: string | null;
    notes: string | null;
    /** Duplicate key: phone, else lowercased email, else lowercased name. */
    key: string;
}

export interface RejectedImportRow {
    rowNumber: number;
    errors: string[];
    /** Original cell values, in header order (never a password/hash column). */
    cells: string[];
}

export interface DuplicateImportRow {
    rowNumber: number;
    key: string;
    reason: 'file-duplicate' | 'existing';
}

export interface StudentImportAnalysis {
    headers: string[];
    rows: StudentImportRow[];
    rejected: RejectedImportRow[];
    duplicates: DuplicateImportRow[];
}

export type ParseResult =
    | { ok: true; headers: string[]; records: string[][] }
    | { ok: false; error: string };

/** Iterate CSV cells without any dependency; quoted fields may span lines. */
function parseCsvCells(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i += 1;
                continue;
            }
            field += ch;
            i += 1;
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            i += 1;
            continue;
        }
        if (ch === ',') {
            row.push(field);
            field = '';
            i += 1;
            continue;
        }
        if (ch === '\r' || ch === '\n') {
            row.push(field);
            field = '';
            rows.push(row);
            row = [];
            i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
            continue;
        }
        field += ch;
        i += 1;
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

const isEmptyRecord = (record: string[]): boolean => record.every((cell) => cell.trim() === '');

/**
 * Parse and validate the CSV envelope: byte size, non-empty header row,
 * bounded column count, no duplicate/unknown/forbidden headers, a required
 * `name` column, and bounded row count. Row-level type validation is separate
 * so a single bad row is reported, not fatal.
 */
export function parseStudentCsv(text: unknown): ParseResult {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'CSV content is required' };
    if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) {
        return { ok: false, error: `CSV exceeds the ${MAX_CSV_BYTES}-byte limit` };
    }
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const rawRows = parseCsvCells(withoutBom).filter((record) => !isEmptyRecord(record));
    if (rawRows.length === 0) return { ok: false, error: 'CSV is empty' };

    const headers = rawRows[0].map((cell) => cell.trim().toLowerCase());
    if (headers.length > MAX_HEADER_COLUMNS) return { ok: false, error: 'Too many columns' };
    const seen = new Set<string>();
    for (const header of headers) {
        if (!header) return { ok: false, error: 'CSV contains an empty header' };
        if (FORBIDDEN_HEADER_SET.has(header)) {
            return { ok: false, error: `CSV must not contain a "${header}" column` };
        }
        if (!ALLOWED_HEADERS.has(header)) return { ok: false, error: `Unknown column "${header}"` };
        if (seen.has(header)) return { ok: false, error: `Duplicate column "${header}"` };
        seen.add(header);
    }
    for (const required of REQUIRED_HEADERS) {
        if (!seen.has(required)) return { ok: false, error: `Missing required column "${required}"` };
    }

    const records = rawRows.slice(1);
    if (records.length === 0) return { ok: false, error: 'CSV has no data rows' };
    if (records.length > MAX_CSV_ROWS) return { ok: false, error: `CSV exceeds the ${MAX_CSV_ROWS}-row limit` };
    return { ok: true, headers, records };
}

function cellFor(headers: string[], record: string[], column: string): string {
    const index = headers.indexOf(column);
    if (index < 0) return '';
    return (record[index] ?? '').trim();
}

const orNull = (value: string): string | null => (value === '' ? null : value);

/**
 * Validate one parsed row. Any error is reported for that row; the row is not
 * silently coerced. There is deliberately no group/reference column: an import
 * row can never reference (or be tricked into referencing) a foreign-tenant
 * entity, and branch scoping is enforced on the validated batch, not per row.
 */
export function validateStudentRow(
    headers: string[],
    record: string[],
    rowNumber: number,
): { row?: StudentImportRow; errors: string[] } {
    const errors: string[] = [];
    if (record.length !== headers.length) errors.push('column count does not match the header');

    const name = cellFor(headers, record, 'name');
    const phone = orNull(cellFor(headers, record, 'phone'));
    const email = orNull(cellFor(headers, record, 'email'));
    const grade = orNull(cellFor(headers, record, 'grade'));
    const parentPhone = orNull(cellFor(headers, record, 'parent_phone'));
    const notes = orNull(cellFor(headers, record, 'notes'));

    if (!name) errors.push('name is required');
    if (name.length > 255) errors.push('name is too long');
    if (phone && !PHONE_RE.test(phone)) errors.push('phone is not a valid number');
    if (email && (!EMAIL_RE.test(email) || email.length > 255)) errors.push('email is not valid');
    if (grade && grade.length > 100) errors.push('grade is too long');
    if (parentPhone && !PHONE_RE.test(parentPhone)) errors.push('parent_phone is not a valid number');
    if (notes && notes.length > 1000) errors.push('notes is too long');
    for (const value of [name, phone, email, grade, parentPhone, notes]) {
        if (value && value.length > MAX_FIELD_LENGTH) errors.push('a field exceeds the length limit');
    }

    if (errors.length > 0) return { errors };
    const normalizedPhone = phone ? phone.replace(/[\s()-]/g, '') : null;
    const key = normalizedPhone ?? (email ? email.toLowerCase() : name.toLowerCase());
    return {
        row: { rowNumber, name, phone, email, grade, parentPhone, notes, key },
        errors,
    };
}

export type ExistingKeyLookup = (row: { phone: string | null; email: string | null }) => Promise<boolean>;

/**
 * Full analysis: envelope parse, per-row validation, in-file duplicate
 * detection, then a caller-injected existing-key lookup. Rejected rows carry a
 * machine-readable error list; duplicates are reported separately so the route
 * can apply the requested resolution policy.
 */
export async function analyzeStudentCsv(
    text: unknown,
    existing: ExistingKeyLookup,
): Promise<{ ok: true; analysis: StudentImportAnalysis } | { ok: false; error: string }> {
    const parsed = parseStudentCsv(text);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const rows: StudentImportRow[] = [];
    const rejected: RejectedImportRow[] = [];
    parsed.records.forEach((record, index) => {
        const result = validateStudentRow(parsed.headers, record, index + 2);
        if (result.row) rows.push(result.row);
        else rejected.push({ rowNumber: index + 2, errors: result.errors, cells: record });
    });

    const duplicates: DuplicateImportRow[] = [];
    const seenInFile = new Map<string, number>();
    for (const row of rows) {
        const firstRow = seenInFile.get(row.key);
        if (firstRow !== undefined) {
            duplicates.push({ rowNumber: row.rowNumber, key: row.key, reason: 'file-duplicate' });
            continue;
        }
        seenInFile.set(row.key, row.rowNumber);
        if (await existing({ phone: row.phone, email: row.email })) {
            duplicates.push({ rowNumber: row.rowNumber, key: row.key, reason: 'existing' });
        }
    }

    return { ok: true, analysis: { headers: parsed.headers, rows, rejected, duplicates } };
}

export interface ImportPlan {
    toInsert: StudentImportRow[];
    toUpdate: StudentImportRow[];
    skipped: DuplicateImportRow[];
}

/**
 * Apply the duplicate-resolution policy:
 *  - `error`  : any duplicate rejects the whole plan (route returns 409).
 *  - `skip`   : duplicates are skipped and the remaining rows are inserted.
 *  - `update` : rows matching an existing student are updated; in-file
 *               duplicates are always skipped (there is nothing to update).
 */
export function planImport(
    analysis: StudentImportAnalysis,
    resolution: DuplicateResolution,
): { ok: true; plan: ImportPlan } | { ok: false; error: string } {
    if (resolution === 'error' && analysis.duplicates.length > 0) {
        return { ok: false, error: 'Duplicate students found; resolve them before importing' };
    }
    const duplicateRows = new Map(analysis.duplicates.map((entry) => [entry.rowNumber, entry]));
    const toInsert: StudentImportRow[] = [];
    const toUpdate: StudentImportRow[] = [];
    const skipped: DuplicateImportRow[] = [];
    for (const row of analysis.rows) {
        const duplicate = duplicateRows.get(row.rowNumber);
        if (!duplicate) {
            toInsert.push(row);
        } else if (resolution === 'update' && duplicate.reason === 'existing') {
            toUpdate.push(row);
        } else {
            skipped.push(duplicate);
        }
    }
    return { ok: true, plan: { toInsert, toUpdate, skipped } };
}

/** Stable content hash used for import idempotency. */
export function hashCsvContent(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

const FORMULA_LEADING = /^[=+\-@\t\r]/;

/**
 * Neutralize CSV formula injection: a cell that would be interpreted as a
 * formula by a spreadsheet is prefixed with a single quote. Applied to every
 * exported report cell.
 */
export function neutralizeCsvCell(value: unknown): string {
    const text = value === null || value === undefined ? '' : String(value);
    return FORMULA_LEADING.test(text) ? `'${text}` : text;
}

function csvField(value: unknown): string {
    const neutralized = neutralizeCsvCell(value);
    return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

/** Render the rejected-row report as a formula-safe CSV document. */
export function toRejectedReportCsv(rejected: RejectedImportRow[], headers: string[]): string {
    const lines = [['row', 'errors', ...headers].map(csvField).join(',')];
    for (const row of rejected) {
        const cells = headers.map((_header, index) => row.cells[index] ?? '');
        lines.push([row.rowNumber, row.errors.join('; '), ...cells].map(csvField).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}
