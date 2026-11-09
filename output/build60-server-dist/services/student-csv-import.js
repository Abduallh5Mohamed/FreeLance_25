"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORBIDDEN_HEADERS = exports.OPTIONAL_HEADERS = exports.REQUIRED_HEADERS = exports.MAX_HEADER_COLUMNS = exports.MAX_FIELD_LENGTH = exports.MAX_CSV_ROWS = exports.MAX_CSV_BYTES = void 0;
exports.normalizeDuplicateResolution = normalizeDuplicateResolution;
exports.parseStudentCsv = parseStudentCsv;
exports.validateStudentRow = validateStudentRow;
exports.analyzeStudentCsv = analyzeStudentCsv;
exports.planImport = planImport;
exports.hashCsvContent = hashCsvContent;
exports.neutralizeCsvCell = neutralizeCsvCell;
exports.toRejectedReportCsv = toRejectedReportCsv;
const crypto_1 = require("crypto");
exports.MAX_CSV_BYTES = 512 * 1024;
exports.MAX_CSV_ROWS = 1000;
exports.MAX_FIELD_LENGTH = 500;
exports.MAX_HEADER_COLUMNS = 40;
exports.REQUIRED_HEADERS = ['name'];
exports.OPTIONAL_HEADERS = ['phone', 'email', 'grade', 'parent_phone', 'notes'];
exports.FORBIDDEN_HEADERS = ['password', 'password_hash', 'pass', 'pwd', 'hash'];
const ALLOWED_HEADERS = new Set([...exports.REQUIRED_HEADERS, ...exports.OPTIONAL_HEADERS]);
const FORBIDDEN_HEADER_SET = new Set(exports.FORBIDDEN_HEADERS);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[0-9()\-\s]{5,30}$/;
function normalizeDuplicateResolution(value) {
    return value === 'update' || value === 'error' ? value : 'skip';
}
/** Iterate CSV cells without any dependency; quoted fields may span lines. */
function parseCsvCells(text) {
    const rows = [];
    let row = [];
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
const isEmptyRecord = (record) => record.every((cell) => cell.trim() === '');
/**
 * Parse and validate the CSV envelope: byte size, non-empty header row,
 * bounded column count, no duplicate/unknown/forbidden headers, a required
 * `name` column, and bounded row count. Row-level type validation is separate
 * so a single bad row is reported, not fatal.
 */
function parseStudentCsv(text) {
    if (typeof text !== 'string' || text.trim() === '')
        return { ok: false, error: 'CSV content is required' };
    if (Buffer.byteLength(text, 'utf8') > exports.MAX_CSV_BYTES) {
        return { ok: false, error: `CSV exceeds the ${exports.MAX_CSV_BYTES}-byte limit` };
    }
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const rawRows = parseCsvCells(withoutBom).filter((record) => !isEmptyRecord(record));
    if (rawRows.length === 0)
        return { ok: false, error: 'CSV is empty' };
    const headers = rawRows[0].map((cell) => cell.trim().toLowerCase());
    if (headers.length > exports.MAX_HEADER_COLUMNS)
        return { ok: false, error: 'Too many columns' };
    const seen = new Set();
    for (const header of headers) {
        if (!header)
            return { ok: false, error: 'CSV contains an empty header' };
        if (FORBIDDEN_HEADER_SET.has(header)) {
            return { ok: false, error: `CSV must not contain a "${header}" column` };
        }
        if (!ALLOWED_HEADERS.has(header))
            return { ok: false, error: `Unknown column "${header}"` };
        if (seen.has(header))
            return { ok: false, error: `Duplicate column "${header}"` };
        seen.add(header);
    }
    for (const required of exports.REQUIRED_HEADERS) {
        if (!seen.has(required))
            return { ok: false, error: `Missing required column "${required}"` };
    }
    const records = rawRows.slice(1);
    if (records.length === 0)
        return { ok: false, error: 'CSV has no data rows' };
    if (records.length > exports.MAX_CSV_ROWS)
        return { ok: false, error: `CSV exceeds the ${exports.MAX_CSV_ROWS}-row limit` };
    return { ok: true, headers, records };
}
function cellFor(headers, record, column) {
    const index = headers.indexOf(column);
    if (index < 0)
        return '';
    return (record[index] ?? '').trim();
}
const orNull = (value) => (value === '' ? null : value);
/**
 * Validate one parsed row. Any error is reported for that row; the row is not
 * silently coerced. There is deliberately no group/reference column: an import
 * row can never reference (or be tricked into referencing) a foreign-tenant
 * entity, and branch scoping is enforced on the validated batch, not per row.
 */
function validateStudentRow(headers, record, rowNumber) {
    const errors = [];
    if (record.length !== headers.length)
        errors.push('column count does not match the header');
    const name = cellFor(headers, record, 'name');
    const phone = orNull(cellFor(headers, record, 'phone'));
    const email = orNull(cellFor(headers, record, 'email'));
    const grade = orNull(cellFor(headers, record, 'grade'));
    const parentPhone = orNull(cellFor(headers, record, 'parent_phone'));
    const notes = orNull(cellFor(headers, record, 'notes'));
    if (!name)
        errors.push('name is required');
    if (name.length > 255)
        errors.push('name is too long');
    if (phone && !PHONE_RE.test(phone))
        errors.push('phone is not a valid number');
    if (email && (!EMAIL_RE.test(email) || email.length > 255))
        errors.push('email is not valid');
    if (grade && grade.length > 100)
        errors.push('grade is too long');
    if (parentPhone && !PHONE_RE.test(parentPhone))
        errors.push('parent_phone is not a valid number');
    if (notes && notes.length > 1000)
        errors.push('notes is too long');
    for (const value of [name, phone, email, grade, parentPhone, notes]) {
        if (value && value.length > exports.MAX_FIELD_LENGTH)
            errors.push('a field exceeds the length limit');
    }
    if (errors.length > 0)
        return { errors };
    const normalizedPhone = phone ? phone.replace(/[\s()-]/g, '') : null;
    const key = normalizedPhone ?? (email ? email.toLowerCase() : name.toLowerCase());
    return {
        row: { rowNumber, name, phone, email, grade, parentPhone, notes, key },
        errors,
    };
}
/**
 * Full analysis: envelope parse, per-row validation, in-file duplicate
 * detection, then a caller-injected existing-key lookup. Rejected rows carry a
 * machine-readable error list; duplicates are reported separately so the route
 * can apply the requested resolution policy.
 */
async function analyzeStudentCsv(text, existing) {
    const parsed = parseStudentCsv(text);
    if (!parsed.ok)
        return { ok: false, error: parsed.error };
    const rows = [];
    const rejected = [];
    parsed.records.forEach((record, index) => {
        const result = validateStudentRow(parsed.headers, record, index + 2);
        if (result.row)
            rows.push(result.row);
        else
            rejected.push({ rowNumber: index + 2, errors: result.errors, cells: record });
    });
    const duplicates = [];
    const seenInFile = new Map();
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
/**
 * Apply the duplicate-resolution policy:
 *  - `error`  : any duplicate rejects the whole plan (route returns 409).
 *  - `skip`   : duplicates are skipped and the remaining rows are inserted.
 *  - `update` : rows matching an existing student are updated; in-file
 *               duplicates are always skipped (there is nothing to update).
 */
function planImport(analysis, resolution) {
    if (resolution === 'error' && analysis.duplicates.length > 0) {
        return { ok: false, error: 'Duplicate students found; resolve them before importing' };
    }
    const duplicateRows = new Map(analysis.duplicates.map((entry) => [entry.rowNumber, entry]));
    const toInsert = [];
    const toUpdate = [];
    const skipped = [];
    for (const row of analysis.rows) {
        const duplicate = duplicateRows.get(row.rowNumber);
        if (!duplicate) {
            toInsert.push(row);
        }
        else if (resolution === 'update' && duplicate.reason === 'existing') {
            toUpdate.push(row);
        }
        else {
            skipped.push(duplicate);
        }
    }
    return { ok: true, plan: { toInsert, toUpdate, skipped } };
}
/** Stable content hash used for import idempotency. */
function hashCsvContent(text) {
    return (0, crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
const FORMULA_LEADING = /^[=+\-@\t\r]/;
/**
 * Neutralize CSV formula injection: a cell that would be interpreted as a
 * formula by a spreadsheet is prefixed with a single quote. Applied to every
 * exported report cell.
 */
function neutralizeCsvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return FORMULA_LEADING.test(text) ? `'${text}` : text;
}
function csvField(value) {
    const neutralized = neutralizeCsvCell(value);
    return /[",\r\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}
/** Render the rejected-row report as a formula-safe CSV document. */
function toRejectedReportCsv(rejected, headers) {
    const lines = [['row', 'errors', ...headers].map(csvField).join(',')];
    for (const row of rejected) {
        const cells = headers.map((_header, index) => row.cells[index] ?? '');
        lines.push([row.rowNumber, row.errors.join('; '), ...cells].map(csvField).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}
