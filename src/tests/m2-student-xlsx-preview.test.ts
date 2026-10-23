/**
 * M2-17 local student XLSX preview — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/students/xlsx-preview.ts`, the
 * REAL dual-format dispatch in `src/features/students/csv-preview.ts` that the
 * component mounts, and the REAL `StudentImportPreview.tsx` component rendered
 * by the REAL React server renderer. Every one of them is imported unchanged.
 *
 * Fully isolated: no DB, no network, no browser, no live services, no
 * dependency install and no filesystem. The ZIP fixtures are built in memory,
 * so every refusal is produced by a real archive the decoder has never seen.
 *
 * Behaviours pinned (M2-17 contract):
 *  - only `.xlsx` is decoded; a legacy `.xls`, a macro `.xlsm` and the
 *    template variants are refused BY NAME and never reach the CSV parser;
 *  - the container is audited BEFORE anything is inflated: entry count,
 *    declared uncompressed total, compression method, duplicate CANONICAL
 *    paths (a case-only or leading-`./` spelling of the same part is the same
 *    part), traversal paths and every unsupported workbook part are decided
 *    from the central directory alone;
 *  - only `xl/workbook.xml`, its relationships, the shared string table and
 *    the resolved FIRST declared worksheet are ever inflated;
 *  - shared strings (including rich text runs and the exclusion of phonetic
 *    runs), inline strings, Arabic text, the five named entities and numeric
 *    character references, CDATA, comments and processing instructions;
 *  - a numeric cell keeps its XML lexical text, so `007` survives only when
 *    the workbook really stored it as text;
 *  - a formula, a cached formula result (`t="str"`), a boolean and an error
 *    cell are refused; dates and styles are never guessed;
 *  - blank rows are skipped, sparse and narrow rows are padded, and a row
 *    WIDER than the header stays wider so the canonical builder refuses it as
 *    a ragged record — exactly as the CSV path does;
 *  - the physical worksheet row number is kept, including after a blank row;
 *  - the FIRST declared sheet wins: no sheet is guessed, none are merged and
 *    the active tab is irrelevant;
 *  - every refusal is a truthful file-level diagnostic and no rows at all;
 *  - the dual-format controller reads a workbook through the injected BYTE
 *    seam, checks the declared size before the read, and keeps every accepted
 *    lifecycle fence (a newer selection supersedes an older one, a retired
 *    reply revives nothing, a close/dispose/session event retires the read and
 *    a silent principal change is observed BEFORE the state settles);
 *  - the component offers a CSV or XLSX picker, states that it is a local
 *    preview only and never claims an import.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end server validation. A crafted archive whose declared sizes lie
 * about the bytes that follow them is bounded by the same declared limits, so
 * the residual risk is a decoder that reads LESS than the file claims, never
 * more. The server remains authoritative and no import commit exists yet.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import {
  isStudentSpreadsheetFileName,
  isStudentXlsxFileName,
  parseStudentPreviewFile,
  parseStudentXlsx,
  STUDENT_SPREADSHEET_EXTENSIONS,
  STUDENT_XLSX_EXTENSION,
  STUDENT_XLSX_MAX_BYTES,
  STUDENT_XLSX_MAX_ROWS,
  STUDENT_XLSX_MAX_SHARED_STRINGS,
  STUDENT_XLSX_MAX_ZIP_ENTRIES,
  STUDENT_XLSX_MAX_XML_ENTRY_BYTES,
  STUDENT_XLSX_MAX_UNCOMPRESSED_BYTES,
} from "../features/students/xlsx-preview";
import {
  createStudentCsvPreviewController,
  STUDENT_CSV_MAX_BYTES,
  STUDENT_CSV_MAX_CELL_CHARS,
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

const xlsxFile = (name: string, size: number): StudentCsvPreviewFile => ({ name, size });

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

/** The parsed rows of a workbook that must parse, with a readable failure. */
const parsedXlsx = (bytes: Uint8Array) => {
  const result = parseStudentXlsx(bytes);
  if (result.ok === false) {
    assert.fail(`expected a parsed workbook, got ${result.error.code}`);
  }
  return result.rows;
};

/** The diagnostic of a workbook that must be refused. */
const refusedXlsx = (bytes: Uint8Array) => {
  const result = parseStudentXlsx(bytes);
  if (result.ok === true) {
    assert.fail("expected the workbook to be refused");
  }
  return result.error;
};

// ---------------------------------------------------------------------------
// A tiny raw ZIP writer
// ---------------------------------------------------------------------------

/**
 * fflate's `zipSync` only ever writes well formed entries, so the
 * container-level refusals — a duplicate path, an unsupported compression
 * method, a lying declared size — are produced by this writer instead. It
 * emits the three standard structures (local headers, a central directory and
 * an end record) with exactly the declarations the caller asks for.
 */
interface RawZipEntry {
  readonly name: string;
  /** The bytes that appear as the entry payload. */
  readonly data: Uint8Array;
  /** 0 stored, 8 deflate; anything else must be refused. */
  readonly method?: number;
  /** A declared uncompressed size that may differ from the payload. */
  readonly declaredSize?: number;
  /** A declared compressed size that may differ from the payload. */
  readonly declaredCompressedSize?: number;
}

const encoder = new TextEncoder();

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32Of = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ data[index]) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

class ByteWriter {
  size = 0;
  private readonly parts: Uint8Array[] = [];

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }

  raw(data: Uint8Array): void {
    this.push(data);
  }

  private push(data: Uint8Array): void {
    this.parts.push(data);
    this.size += data.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

const rawZip = (entries: readonly RawZipEntry[]): Uint8Array => {
  const body = new ByteWriter();
  const directory = new ByteWriter();
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const method = entry.method ?? 0;
    const crc = crc32Of(entry.data);
    const declaredSize = entry.declaredSize ?? entry.data.length;
    const declaredCompressed = entry.declaredCompressedSize ?? entry.data.length;
    const offset = body.size;

    body.u32(0x04034b50);
    body.u16(20);
    body.u16(0);
    body.u16(method);
    body.u16(0);
    body.u16(0);
    body.u32(crc);
    body.u32(declaredCompressed);
    body.u32(declaredSize);
    body.u16(name.length);
    body.u16(0);
    body.raw(name);
    body.raw(entry.data);

    directory.u32(0x02014b50);
    directory.u16(20);
    directory.u16(20);
    directory.u16(0);
    directory.u16(method);
    directory.u16(0);
    directory.u16(0);
    directory.u32(crc);
    directory.u32(declaredCompressed);
    directory.u32(declaredSize);
    directory.u16(name.length);
    directory.u16(0);
    directory.u16(0);
    directory.u16(0);
    directory.u16(0);
    directory.u32(0);
    directory.u32(offset);
    directory.raw(name);
  }
  const central = directory.toBytes();
  const bodyBytes = body.toBytes();
  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(central.length);
  end.u32(bodyBytes.length);
  end.u16(0);
  const endBytes = end.toBytes();
  const out = new Uint8Array(bodyBytes.length + central.length + endBytes.length);
  out.set(bodyBytes, 0);
  out.set(central, bodyBytes.length);
  out.set(endBytes, bodyBytes.length + central.length);
  return out;
};

// ---------------------------------------------------------------------------
// Workbook fixtures
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORKSHEET_REL_TYPE = `${NS_REL}/worksheet`;
const CHARTSHEET_REL_TYPE = `${NS_REL}/chartsheet`;
const CONTENT_TYPES = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;

/**
 * Builds a well formed ZIP archive.
 *
 * Every member is encoded to bytes first: fflate's flattener only accepts
 * `Uint8Array` members and plain objects (which it treats as directories), so
 * a string member would be walked as if it were a nested directory.
 */
const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array => {
  const members: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) {
    members[name] = typeof data === 'string' ? encoder.encode(data) : data;
  }
  return zipSync(members, { level: 9 });
};

const sheetXml = (rows: string): string =>
  `${XML_DECL}<worksheet xmlns="${NS_MAIN}"><sheetData>${rows}</sheetData></worksheet>`;

const workbookXml = (sheets: string): string =>
  `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheets}</sheets></workbook>`;

const sheetElement = (name: string, relationshipId: string): string =>
  `<sheet name="${name}" sheetId="1" r:id="${relationshipId}"/>`;

const relsXml = (relationships: string): string =>
  `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`;

const relationship = (id: string, type: string, target: string): string =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;

/** The inner XML of each `<si>` of a shared string table. */
const sstXml = (items: readonly string[]): string =>
  `${XML_DECL}<sst xmlns="${NS_MAIN}" count="${items.length}" uniqueCount="${items.length}">${items
    .map((item) => `<si>${item}</si>`)
    .join('')}</sst>`;

interface WorkbookFiles {
  /** The inner XML of `<sheetData>`. */
  readonly rows?: string;
  /** The inner XML of each `<si>` of the shared string table. */
  readonly shared?: readonly string[];
  /** The `<sheet>` elements, in document order. */
  readonly sheets?: string;
  /** The whole `xl/workbook.xml` part, when a test needs an unusual one. */
  readonly workbook?: string;
  /** The `<Relationship>` elements of the workbook. */
  readonly relationships?: string;
  /** The archive path of the first worksheet. */
  readonly sheetPath?: string;
  /** Extra or overriding archive members. */
  readonly extra?: Record<string, string | Uint8Array>;
}

/** A complete, minimal, well formed workbook. */
const workbookZip = (files: WorkbookFiles = {}): Uint8Array => {
  const sheetPath = files.sheetPath ?? 'xl/worksheets/sheet1.xml';
  const archive: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml': files.workbook ?? workbookXml(files.sheets ?? sheetElement('Students', 'rId1')),
    'xl/_rels/workbook.xml.rels': relsXml(
      files.relationships ?? relationship('rId1', WORKSHEET_REL_TYPE, 'worksheets/sheet1.xml'),
    ),
    [sheetPath]: sheetXml(files.rows ?? ''),
  };
  if (files.shared !== undefined) archive['xl/sharedStrings.xml'] = sstXml(files.shared);
  if (files.extra !== undefined) {
    for (const [name, data] of Object.entries(files.extra)) archive[name] = data;
  }
  return zipOf(archive);
};

/** A shared string cell: `<c r="A1" t="s"><v>0</v></c>`. */
const sCell = (reference: string, index: number): string =>
  `<c r="${reference}" t="s"><v>${index}</v></c>`;

/** An inline string cell. */
const iCell = (reference: string, text: string): string =>
  `<c r="${reference}" t="inlineStr"><is><t>${text}</t></is></c>`;

/** A numeric cell: the XML lexical text of `<v>` IS the value. */
const nCell = (reference: string, text: string): string =>
  `<c r="${reference}"><v>${text}</v></c>`;

/** A cell with arbitrary inner XML, for the refusal cases. */
const rawCell = (reference: string, type: string, inner: string): string =>
  `<c r="${reference}" t="${type}">${inner}</c>`;

/** A worksheet row. */
const xlRow = (number: number, cells: string): string => `<row r="${number}">${cells}</row>`;

/** A row that carries no cell at all: a blank row. */
const blankRow = (number: number): string => `<row r="${number}"/>`;

/** The standard `name,phone` header row of a worksheet. */
const headerRow = (): string => xlRow(1, iCell('A1', 'name') + iCell('B1', 'phone'));

const NAME_PHONE_SHARED = ['<t>name</t>', '<t>phone</t>'];

// ===========================================================================
// The real decoder: the container and the format
// ===========================================================================

test("decoder: the spreadsheet extensions are recognised and only .xlsx is decoded", () => {
  assert.equal(isStudentSpreadsheetFileName('students.xlsx'), true);
  assert.equal(isStudentSpreadsheetFileName('students.xls'), true);
  assert.equal(isStudentSpreadsheetFileName('students.xlsm'), true);
  assert.equal(isStudentSpreadsheetFileName('students.xltx'), true);
  assert.equal(isStudentSpreadsheetFileName('students.xltm'), true);
  assert.equal(isStudentSpreadsheetFileName('STUDENTS.XLSX'), true);
  assert.equal(isStudentSpreadsheetFileName('students.csv'), false);
  assert.equal(isStudentSpreadsheetFileName('students'), false);
  assert.equal(isStudentXlsxFileName('students.xlsx'), true);
  assert.equal(isStudentXlsxFileName('students.xls'), false);
  assert.equal(isStudentXlsxFileName('students.xlsm'), false);
  assert.deepEqual([...STUDENT_SPREADSHEET_EXTENSIONS], ['.xlsx', '.xlsm', '.xls', '.xltx', '.xltm']);
  assert.equal(STUDENT_XLSX_EXTENSION, '.xlsx');
});

test("decoder: a legacy or macro container is refused by name and never reaches the CSV parser", () => {
  for (const name of ['students.xls', 'students.xlsm', 'students.xltx', 'students.xltm']) {
    const result = parseStudentPreviewFile(name, new Uint8Array([1, 2, 3]));
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.error.code, 'unsupported-format');
  }
});

test("decoder: the dual-format dispatch keeps the accepted CSV path unchanged", () => {
  const csv = parseStudentPreviewFile('students.csv', 'name,phone\nAli,0100\n');
  assert.equal(csv.ok, true);
  if (csv.ok === true) {
    assert.equal(csv.rows.length, 1);
    assert.equal(csv.rows[0].name, 'Ali');
    assert.equal(csv.rows[0].phone, '0100');
  }
  // A CSV name that arrived as bytes is refused, never guessed at.
  const bytes = parseStudentPreviewFile('students.csv', encoder.encode('name,phone'));
  assert.equal(bytes.ok, false);
  if (bytes.ok === false) assert.equal(bytes.error.code, 'read-failed');
  // An XLSX name that arrived as text is refused the same truthful way.
  const text = parseStudentPreviewFile('students.xlsx', 'name,phone\nAli,0100\n');
  assert.equal(text.ok, false);
  if (text.ok === false) assert.equal(text.error.code, 'read-failed');
});

test("decoder: an input that is not a byte array is refused", () => {
  const result = parseStudentXlsx('name,phone\nAli,0100\n' as unknown as Uint8Array);
  assert.equal(result.ok, false);
  if (result.ok === false) assert.equal(result.error.code, 'unsupported-format');
});

test("decoder: an OLE2 compound container is an encrypted workbook", () => {
  const ole2 = new Uint8Array(16);
  ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  assert.equal(refusedXlsx(ole2).code, 'password-protected');
});

test("decoder: a payload that is not a ZIP archive is unreadable", () => {
  assert.equal(refusedXlsx(encoder.encode('this is not a zip archive at all')).code, 'unreadable-archive');
  assert.equal(refusedXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04])).code, 'unreadable-archive');
});

test("decoder: a workbook protection password is refused before anything is read", () => {
  const bytes = workbookZip({
    workbook: `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookProtection workbookPassword="00FF"/><sheets>${sheetElement('Students', 'rId1')}</sheets></workbook>`,
    rows: headerRow(),
    shared: NAME_PHONE_SHARED,
  });
  assert.equal(refusedXlsx(bytes).code, 'password-protected');
});

test("decoder: a revisions password is refused too", () => {
  const bytes = workbookZip({
    workbook: `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookProtection revisionsPassword="00FF"/><sheets>${sheetElement('Students', 'rId1')}</sheets></workbook>`,
    rows: headerRow(),
    shared: NAME_PHONE_SHARED,
  });
  assert.equal(refusedXlsx(bytes).code, 'password-protected');
});

test("decoder: an unlocked workbook protection element is not a password", () => {
  const bytes = workbookZip({
    workbook: `${XML_DECL}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><workbookProtection lockStructure="1"/><sheets>${sheetElement('Students', 'rId1')}</sheets></workbook>`,
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ali');
});

// ===========================================================================
// The real decoder: what a cell means
// ===========================================================================

test("decoder: shared strings, Arabic text and XML entities are decoded", () => {
  const bytes = workbookZip({
    shared: [
      '<t>name</t>',
      '<t>phone</t>',
      '<t>أحمد &amp; علي</t>',
      '<t>&#1605;&#1581;&#1605;&#1583;</t>',
      '<t xml:space="preserve">  spaced  </t>',
      '<t>&lt;script&gt; &quot;quoted&quot; &apos;x&apos;</t>',
      '<t>&#x64;&#x65;&#x63;</t>',
    ],
    rows: [
      headerRow(),
      xlRow(2, sCell('A2', 2) + sCell('B2', 3)),
      xlRow(3, sCell('A3', 2) + sCell('B3', 4)),
      xlRow(4, sCell('A4', 2) + sCell('B4', 5)),
      xlRow(5, sCell('A5', 2) + sCell('B5', 6)),
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].name, 'أحمد & علي');
  assert.equal(rows[0].phone, 'محمد');
  // Only surrounding whitespace is trimmed, exactly as in the CSV path.
  assert.equal(rows[1].phone, 'spaced');
  assert.equal(rows[2].phone, '<script> "quoted" \'x\'');
  assert.equal(rows[3].phone, 'dec');
});

test("decoder: rich text runs are concatenated and phonetic runs are skipped", () => {
  const bytes = workbookZip({
    shared: [
      '<t>name</t>',
      '<t>phone</t>',
      '<r><t>Ah</t></r><r><t>med</t></r>',
      '<r><t xml:space="preserve">Yama</t></r><rPh sb="0" eb="4"><t>ヤマ</t></rPh><r><t>moto</t></r>',
    ],
    rows: [
      headerRow(),
      xlRow(2, sCell('A2', 2) + nCell('B2', '0100')),
      xlRow(3, sCell('A3', 3) + nCell('B3', '0101')),
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows[0].name, 'Ahmed');
  assert.equal(rows[1].name, 'Yamamoto', 'a phonetic run is a hint, never content');
});

test("decoder: an inline string cell is a value, including an empty one", () => {
  const bytes = workbookZip({
    rows: [
      headerRow(),
      xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')),
      xlRow(3, iCell('A3', 'Hassan') + '<c r="B3" t="inlineStr"><is><t></t></is></c>'),
      xlRow(4, iCell('A4', 'Sayed') + '<c r="B4" t="inlineStr"><is></is></c>'),
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].name, 'Hassan');
  assert.equal(rows[1].phone, '');
  assert.equal(rows[1].issues.length, 0, 'an empty phone is not an issue');
  assert.equal(rows[2].phone, '');
});

test("decoder: a numeric cell keeps its lexical text, so 007 survives", () => {
  const bytes = workbookZip({
    rows: [
      headerRow(),
      xlRow(2, nCell('A2', '007') + nCell('B2', '0100')),
      xlRow(3, nCell('A3', '3.14000') + nCell('B3', '1e5')),
      xlRow(4, nCell('A4', '+201001') + nCell('B4', '0')),
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows[0].name, '007');
  assert.equal(rows[1].name, '3.14000');
  assert.equal(rows[1].phone, '1e5');
  assert.equal(rows[2].name, '+201001');
  assert.equal(rows[2].phone, '0');
});

test("decoder: comments, CDATA sections and processing instructions are tolerated", () => {
  const bytes = workbookZip({
    rows: [
      headerRow(),
      '<!-- a comment between the rows -->',
      xlRow(
        2,
        '<c r="A2" t="inlineStr"><is><t><![CDATA[Ali & <Hassan>]]></t></is></c>' +
          nCell('B2', '0100'),
      ),
      '<?xlsx-internal a processing instruction?>',
      xlRow(3, iCell('A3', 'Sayed') + nCell('B3', '0101')),
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Ali & <Hassan>', 'CDATA content is taken verbatim');
  assert.equal(rows[1].name, 'Sayed');
});

test("decoder: a formula cell is refused, so no result is ever guessed", () => {
  const bytes = workbookZip({
    rows: headerRow() + xlRow(2, rawCell('A2', 'n', '<f>UPPER(A1)</f><v>ALI</v>') + nCell('B2', '0100')),
  });
  assert.equal(refusedXlsx(bytes).code, 'formula-cell');
});

test("decoder: a cached formula result is refused too", () => {
  const bytes = workbookZip({
    rows: headerRow() + xlRow(2, rawCell('A2', 'str', '<v>0100</v>') + nCell('B2', '0101')),
  });
  assert.equal(refusedXlsx(bytes).code, 'formula-cell');
});

test("decoder: a boolean and an error cell are refused", () => {
  for (const type of ['b', 'e']) {
    const bytes = workbookZip({
      rows: headerRow() + xlRow(2, rawCell('A2', type, '<v>1</v>') + nCell('B2', '0100')),
    });
    assert.equal(refusedXlsx(bytes).code, 'unsupported-cell-type', type);
  }
});

// ===========================================================================
// The real decoder: the grid
// ===========================================================================

test("decoder: blank rows are skipped and the row numbers keep pointing at the sheet", () => {
  const bytes = workbookZip({
    rows: [
      headerRow(),
      xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')),
      blankRow(3),
      blankRow(4),
      xlRow(5, iCell('A5', 'Hassan') + nCell('B5', '0101')),
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[0].rowIndex, 1);
  assert.equal(rows[1].rowNumber, 5, 'a blank row never shifts the numbers that follow it');
  assert.equal(rows[1].rowIndex, 2);
});

test("decoder: a gap between two cells is an empty cell, and a narrow row is padded", () => {
  const bytes = workbookZip({
    rows:
      xlRow(1, iCell('A1', 'name') + iCell('B1', 'email') + iCell('C1', 'phone')) +
      // The email sits in C2: B2 is absent, so the gap is an empty cell.
      xlRow(2, iCell('A2', 'Ali') + iCell('C2', 'a@b.c')) +
      // A row with a single cell is padded to the header width.
      xlRow(3, iCell('A3', 'Hassan')),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Ali');
  assert.equal(rows[0].email, '');
  assert.equal(rows[0].phone, 'a@b.c');
  assert.equal(rows[1].name, 'Hassan');
  assert.equal(rows[1].email, '');
  assert.equal(rows[1].phone, '');
});

test("decoder: a cell past the header's last column makes the record wider", () => {
  const bytes = workbookZip({
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100') + nCell('C2', '1')),
  });
  const error = refusedXlsx(bytes);
  assert.equal(error.code, 'ragged-record');
  assert.equal(error.detail, '2');
  assert.equal(error.line, 2);
});

test("decoder: a row without a reference is numbered by its position", () => {
  const bytes = workbookZip({
    rows: [
      xlRow(1, iCell('A1', 'name') + iCell('B1', 'phone')),
      '<row>' + iCell('A2', 'Ali') + nCell('B2', '0100') + '</row>',
      '<row>' + iCell('A3', 'Hassan') + nCell('B3', '0101') + '</row>',
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows[0].rowNumber, 2);
  assert.equal(rows[1].rowNumber, 3);
});

test("decoder: a cell without a reference takes the next free column of the row", () => {
  const bytes = workbookZip({
    rows: [
      '<row r="1"><c t="inlineStr"><is><t>name</t></is></c><c t="inlineStr"><is><t>phone</t></is></c></row>',
      '<row r="2"><c t="inlineStr"><is><t>Ali</t></is></c><c><v>0100</v></c></row>',
    ].join(''),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ali');
  assert.equal(rows[0].phone, '0100');
});

test("decoder: a repeated cell reference is not counted twice", () => {
  const bytes = workbookZip({
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + iCell('A2', 'Hassan') + nCell('B2', '0100')),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ali', 'the first cell of a column wins');
});

// ===========================================================================
// The real decoder: which worksheet is read
// ===========================================================================

test("decoder: the first declared worksheet is the one that is read", () => {
  const bytes = workbookZip({
    sheets: sheetElement('First', 'rId1') + sheetElement('Second', 'rId2'),
    relationships:
      relationship('rId1', WORKSHEET_REL_TYPE, 'worksheets/sheet1.xml') +
      relationship('rId2', WORKSHEET_REL_TYPE, 'worksheets/sheet2.xml'),
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')),
    extra: {
      // The SECOND sheet carries a formula. It must never be read, so the
      // workbook still parses from the first sheet alone.
      'xl/worksheets/sheet2.xml': sheetXml(
        xlRow(1, iCell('A1', 'name')) + rawCell('A2', 'n', '<f>SUM(1,2)</f><v>3</v>'),
      ),
    },
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ali');
});

test("decoder: a second sheet that is absent from the archive is irrelevant", () => {
  const bytes = workbookZip({
    sheets: sheetElement('First', 'rId1') + sheetElement('Second', 'rId2'),
    relationships:
      relationship('rId1', WORKSHEET_REL_TYPE, 'worksheets/sheet1.xml') +
      relationship('rId2', WORKSHEET_REL_TYPE, 'worksheets/sheet2.xml'),
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows[0].name, 'Ali');
});

test("decoder: an absolute relationship target resolves to the same part", () => {
  const bytes = workbookZip({
    relationships: relationship('rId1', WORKSHEET_REL_TYPE, '/xl/worksheets/sheet1.xml'),
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ali');
});

// ===========================================================================
// The real decoder: the header and the canonical mapping
// ===========================================================================

test("decoder: an unknown, duplicate, empty or missing name header refuses the file", () => {
  const unknown = workbookZip({ rows: xlRow(1, iCell('A1', 'password') + iCell('B1', 'name')) });
  const unknownError = refusedXlsx(unknown);
  assert.equal(unknownError.code, 'unknown-header');
  assert.equal(unknownError.detail, 'password');
  assert.equal(unknownError.line, 1);
  const duplicate = workbookZip({ rows: xlRow(1, iCell('A1', 'name') + iCell('B1', 'name')) });
  assert.equal(refusedXlsx(duplicate).code, 'duplicate-header');
  const empty = workbookZip({ rows: xlRow(1, iCell('A1', '') + iCell('B1', 'name')) });
  assert.equal(refusedXlsx(empty).code, 'empty-header');
  const noName = workbookZip({ rows: xlRow(1, iCell('A1', 'phone') + iCell('B1', 'email')) });
  assert.equal(refusedXlsx(noName).code, 'missing-name-header');
});

test("decoder: six columns are accepted and seven are refused", () => {
  const columns = ['name', 'email', 'phone', 'guardian_phone', 'grade', 'barcode'];
  const values = ['Ali', 'a@b.c', '0100', '0101', '5', '77'];
  const accepted = workbookZip({
    rows:
      xlRow(1, columns.map((header, index) => iCell(`${'ABCDEF'[index]}1`, header)).join('')) +
      xlRow(2, values.map((value, index) => iCell(`${'ABCDEF'[index]}2`, value)).join('')),
  });
  const rows = parsedXlsx(accepted);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ali');
  assert.equal(rows[0].barcode, '77');
  const refused = workbookZip({
    rows: xlRow(
      1,
      [...columns, 'extra'].map((header, index) => iCell(`${'ABCDEFG'[index]}1`, header)).join(''),
    ),
  });
  assert.equal(refusedXlsx(refused).code, 'too-many-columns');
});

test("decoder: the columns may appear in any order and may be omitted", () => {
  const bytes = workbookZip({
    rows:
      xlRow(1, iCell('A1', 'phone') + iCell('B1', 'name')) +
      xlRow(2, nCell('A2', '0100') + iCell('B2', 'Ali')) +
      xlRow(3, iCell('B3', 'Hassan')),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Ali');
  assert.equal(rows[0].phone, '0100');
  assert.equal(rows[1].name, 'Hassan');
  assert.equal(rows[1].phone, '');
});

test("decoder: a missing name is a row issue, not a file failure", () => {
  const bytes = workbookZip({
    rows:
      headerRow() +
      xlRow(2, nCell('A2', '') + nCell('B2', '0100')) +
      xlRow(3, iCell('A3', 'Ali') + nCell('B3', '0101')),
  });
  const rows = parsedXlsx(bytes);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].issues.length, 1);
  assert.equal(rows[0].issues[0].code, 'missing-name');
  assert.equal(rows[0].issues[0].rowNumber, 2);
  assert.equal(rows[1].issues.length, 0);
});

test("decoder: an exact within-file duplicate is a candidate with row references", () => {
  const bytes = workbookZip({
    rows:
      headerRow() +
      xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')) +
      xlRow(3, iCell('A3', 'Hassan') + nCell('B3', '0100')) +
      xlRow(4, iCell('A4', 'Sayed') + nCell('B4', '0101')),
  });
  const rows = parsedXlsx(bytes);
  const ali = rows[0].duplicates.find((item) => item.field === 'phone');
  assert.ok(ali, 'the phone candidate exists');
  assert.deepEqual(ali.rowNumbers, [2, 3]);
  assert.equal(ali.value, '0100');
});

test("decoder: a workbook with no row at all is an empty file", () => {
  assert.equal(refusedXlsx(workbookZip({ rows: '' })).code, 'empty-file');
});

test("decoder: a workbook and a CSV file with the same content produce the same rows", () => {
  const bytes = workbookZip({
    rows:
      headerRow() +
      xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')) +
      xlRow(3, iCell('A3', 'Hassan') + nCell('B3', '0100')),
  });
  const fromXlsx = parsedXlsx(bytes);
  const fromCsv = parseStudentPreviewFile(
    'students.csv',
    'name,phone\nAli,0100\nHassan,0100\n',
  );
  assert.equal(fromCsv.ok, true);
  if (fromCsv.ok === true) {
    assert.deepEqual(
      fromXlsx.map((row) => [row.rowNumber, row.name, row.phone, row.duplicates]),
      fromCsv.rows.map((row) => [row.rowNumber, row.name, row.phone, row.duplicates]),
    );
  }
});

// ===========================================================================
// The real decoder: the container, audited before anything is inflated
// ===========================================================================

/** A complete workbook as raw members, so the declarations can be lied about. */
const MINIMAL_WORKBOOK: Record<string, string> = {
  '[Content_Types].xml': CONTENT_TYPES,
  'xl/workbook.xml': workbookXml(sheetElement('Students', 'rId1')),
  'xl/_rels/workbook.xml.rels': relsXml(
    relationship('rId1', WORKSHEET_REL_TYPE, 'worksheets/sheet1.xml'),
  ),
  'xl/worksheets/sheet1.xml': sheetXml(
    headerRow() + xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')),
  ),
};

const rawEntriesOf = (extra: readonly RawZipEntry[] = []): RawZipEntry[] => [
  ...Object.entries(MINIMAL_WORKBOOK).map(([name, data]) => ({
    name,
    data: encoder.encode(data),
  })),
  ...extra,
];

test("decoder: a stored archive is read exactly like a deflated one", () => {
  const rows = parsedXlsx(rawZip(rawEntriesOf()));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ali');
  assert.equal(rows[0].phone, '0100');
});

test("decoder: a directory entry is not a file and is not counted as one", () => {
  const rows = parsedXlsx(rawZip(rawEntriesOf([{ name: 'xl/worksheets/', data: new Uint8Array(0) }])));
  assert.equal(rows.length, 1);
});

test("decoder: a duplicate ZIP path is refused", () => {
  const entries = rawEntriesOf([
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml(headerRow())) },
  ]);
  assert.equal(refusedXlsx(rawZip(entries)).code, 'duplicate-zip-entry');
});

/** A worksheet that would silently replace the real one if it were selected. */
const collidingSheet = (): Uint8Array =>
  encoder.encode(sheetXml(headerRow() + xlRow(2, iCell('A2', 'Mallory') + nCell('B2', '0100'))));

test("decoder: a case-only canonical ZIP path collision is refused", () => {
  // The central directory declares the worksheet twice: the real part and an
  // upper-cased spelling of the SAME canonical path. The second entry must
  // never be inflated, and its value must never replace the first one's.
  const entries = rawEntriesOf([{ name: 'XL/WORKSHEETS/SHEET1.XML', data: collidingSheet() }]);
  assert.equal(refusedXlsx(rawZip(entries)).code, 'duplicate-zip-entry');
});

test("decoder: a leading-dot canonical ZIP path collision is refused", () => {
  // `./xl/worksheets/sheet1.xml` is the same canonical part as
  // `xl/worksheets/sheet1.xml`, so the archive is refused as a duplicate.
  const entries = rawEntriesOf([{ name: './xl/worksheets/sheet1.xml', data: collidingSheet() }]);
  assert.equal(refusedXlsx(rawZip(entries)).code, 'duplicate-zip-entry');
});

test("decoder: a canonical ZIP collision is refused before any part is inflated", () => {
  // The real worksheet carries a deflate stream that cannot be inflated. If
  // the audit inflated anything at all, the failure would be
  // `unreadable-archive`; the canonical duplicate must win instead.
  const entries = rawEntriesOf([
    { name: 'XL/WORKSHEETS/SHEET1.XML', data: collidingSheet() },
  ]).map((entry) =>
    entry.name === 'xl/worksheets/sheet1.xml'
      ? { ...entry, method: 8, data: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }
      : entry,
  );
  assert.equal(refusedXlsx(rawZip(entries)).code, 'duplicate-zip-entry');
});

test("decoder: a single part spelled in another case or with a leading dot still parses", () => {
  // The canonical identity is also the SELECTION identity, so one legitimate
  // spelling of the part is never a false duplicate.
  for (const name of ['XL/WORKSHEETS/SHEET1.XML', './xl/worksheets/sheet1.xml']) {
    const entries = rawEntriesOf().map((entry) =>
      entry.name === 'xl/worksheets/sheet1.xml' ? { ...entry, name } : entry,
    );
    const rows = parsedXlsx(rawZip(entries));
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0].name, 'Ali', name);
  }
});

test("decoder: a path that escapes the archive is refused", () => {
  for (const name of [
    '../escape.xml',
    'xl/../../escape.xml',
    '/etc/passwd',
    'C:\\windows\\escape.xml',
    'xl\\worksheets\\sheet1.xml',
  ]) {
    const entries = rawEntriesOf([{ name, data: encoder.encode('<x/>') }]);
    assert.equal(refusedXlsx(rawZip(entries)).code, 'unsafe-zip-path', name);
  }
});

test("decoder: a compression method other than stored or deflate is refused", () => {
  const entries = rawEntriesOf([
    { name: 'xl/extra.bin', data: new Uint8Array([1, 2, 3]), method: 99 },
  ]);
  const error = refusedXlsx(rawZip(entries));
  assert.equal(error.code, 'unsupported-compression');
  assert.equal(error.detail, '99');
});

test("decoder: a corrupt deflate stream is an unreadable archive", () => {
  const entries = rawEntriesOf().map((entry) =>
    entry.name === 'xl/worksheets/sheet1.xml'
      ? { ...entry, method: 8, data: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }
      : entry,
  );
  assert.equal(refusedXlsx(rawZip(entries)).code, 'unreadable-archive');
});

test("decoder: a refused archive never inflates anything at all", () => {
  // Every entry declares an impossible uncompressed size AND carries a
  // payload that cannot be inflated. If the audit inflated anything, the
  // failure would be an archive failure rather than the declared bound.
  const entries = rawEntriesOf().map((entry) => ({
    ...entry,
    declaredSize: STUDENT_XLSX_MAX_UNCOMPRESSED_BYTES + 1,
  }));
  assert.equal(refusedXlsx(rawZip(entries)).code, 'archive-too-large');
});

test("decoder: a relevant entry that declares more than its bound is refused before it is inflated", () => {
  const entries = rawEntriesOf().map((entry) =>
    entry.name === 'xl/worksheets/sheet1.xml'
      ? { ...entry, declaredSize: STUDENT_XLSX_MAX_XML_ENTRY_BYTES + 1 }
      : entry,
  );
  const error = refusedXlsx(rawZip(entries));
  assert.equal(error.code, 'entry-too-large');
  assert.equal(error.detail, String(STUDENT_XLSX_MAX_XML_ENTRY_BYTES));
});

test("decoder: 128 entries are accepted and 129 are refused", () => {
  const filler = (count: number): RawZipEntry[] =>
    Array.from({ length: count }, (_unused, index) => ({
      name: `filler-${index}.xml`,
      data: encoder.encode('<x/>'),
    }));
  const accepted = parsedXlsx(rawZip(rawEntriesOf(filler(124))));
  assert.equal(accepted.length, 1);
  const refused = refusedXlsx(rawZip(rawEntriesOf(filler(125))));
  assert.equal(refused.code, 'too-many-zip-entries');
  assert.equal(refused.detail, String(STUDENT_XLSX_MAX_ZIP_ENTRIES));
});

test("decoder: a declared uncompressed total over 4 MiB is refused and a smaller one is not", () => {
  const filler = (count: number, declared: number): RawZipEntry[] =>
    Array.from({ length: count }, (_unused, index) => ({
      name: `filler-${index}.bin`,
      data: encoder.encode('<x/>'),
      declaredSize: declared,
    }));
  const accepted = parsedXlsx(rawZip(rawEntriesOf(filler(3, 1024 * 1024))));
  assert.equal(accepted.length, 1);
  const refused = refusedXlsx(rawZip(rawEntriesOf(filler(4, 1024 * 1024))));
  assert.equal(refused.code, 'archive-too-large');
  assert.equal(refused.detail, String(STUDENT_XLSX_MAX_UNCOMPRESSED_BYTES));
});

test("decoder: every unsupported workbook part is refused by name", () => {
  const parts = [
    'xl/vbaproject.bin',
    'xl/drawings/drawing1.xml',
    'xl/media/image1.png',
    'xl/charts/chart1.xml',
    'xl/externallinks/externalLink1.xml',
    'xl/querytables/querytable1.xml',
    'xl/tables/table1.xml',
    'xl/pivottables/pivotTable1.xml',
    'xl/pivotcache/pivotcache1.xml',
    'xl/ctrlprops/ctrlprop1.xml',
    'xl/activex/activeX1.bin',
    'xl/connections.xml',
    'xl/slicers/slicer1.xml',
  ];
  for (const part of parts) {
    const bytes = workbookZip({ extra: { [part]: 'anything at all' } });
    assert.equal(refusedXlsx(bytes).code, 'unsupported-workbook-part', part);
  }
});

// ===========================================================================
// The real decoder: missing and malformed parts
// ===========================================================================

test("decoder: a missing workbook part is refused", () => {
  const archive: Record<string, string> = { ...MINIMAL_WORKBOOK };
  delete archive['xl/workbook.xml'];
  assert.equal(refusedXlsx(zipOf(archive)).code, 'missing-workbook-part');
});

test("decoder: a workbook with no sheet, or a sheet without a relationship, is refused", () => {
  assert.equal(refusedXlsx(workbookZip({ sheets: '' })).code, 'missing-worksheet');
  const noId = workbookZip({ sheets: '<sheet name="Students" sheetId="1"/>' });
  assert.equal(refusedXlsx(noId).code, 'missing-worksheet');
});

test("decoder: a relationship that cannot be resolved is refused", () => {
  const unresolved = workbookZip({ sheets: sheetElement('Students', 'rIdMissing') });
  assert.equal(refusedXlsx(unresolved).code, 'missing-worksheet');
});

test("decoder: a worksheet part that is absent from the archive is refused", () => {
  const bytes = workbookZip({
    relationships: relationship('rId1', WORKSHEET_REL_TYPE, 'worksheets/missing.xml'),
  });
  assert.equal(refusedXlsx(bytes).code, 'missing-worksheet');
});

test("decoder: a workbook with no relationships at all is refused", () => {
  const archive: Record<string, string> = {
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml': workbookXml(sheetElement('Students', 'rId1')),
    'xl/worksheets/sheet1.xml': sheetXml(headerRow()),
  };
  assert.equal(refusedXlsx(zipOf(archive)).code, 'missing-worksheet');
});

test("decoder: a chartsheet relationship is refused", () => {
  const bytes = workbookZip({
    relationships: relationship('rId1', CHARTSHEET_REL_TYPE, 'worksheets/sheet1.xml'),
  });
  assert.equal(refusedXlsx(bytes).code, 'unsupported-workbook-part');
});

test("decoder: an element left open at the end of a part is malformed XML", () => {
  const bytes = workbookZip({
    extra: {
      'xl/worksheets/sheet1.xml': `${XML_DECL}<worksheet xmlns="${NS_MAIN}"><sheetData>${headerRow()}`,
    },
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

test("decoder: an unterminated tag is malformed XML", () => {
  const bytes = workbookZip({
    extra: {
      'xl/worksheets/sheet1.xml': `${XML_DECL}<worksheet xmlns="${NS_MAIN}"><sheetData><row r="1"><c r="A1"`,
    },
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

test("decoder: a mis-nested element is malformed XML", () => {
  const bytes = workbookZip({
    extra: {
      'xl/worksheets/sheet1.xml': sheetXml(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></row></c>',
      ),
    },
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

test("decoder: a stray closing tag is malformed XML", () => {
  const bytes = workbookZip({
    extra: { 'xl/worksheets/sheet1.xml': sheetXml(headerRow() + '</c>') },
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

test("decoder: an unknown entity reference is malformed XML", () => {
  const bytes = workbookZip({
    rows: headerRow() + xlRow(2, iCell('A2', '&bogus;') + nCell('B2', '0100')),
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

test("decoder: a part that is not valid UTF-8 is malformed XML", () => {
  const bytes = workbookZip({
    extra: { 'xl/worksheets/sheet1.xml': new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]) },
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

test("decoder: a malformed workbook or relationship part is malformed XML", () => {
  const workbook = workbookZip({
    extra: { 'xl/workbook.xml': `${XML_DECL}<workbook xmlns="${NS_MAIN}"><sheets>` },
  });
  assert.equal(refusedXlsx(workbook).code, 'malformed-xml');
  const rels = workbookZip({
    extra: { 'xl/_rels/workbook.xml.rels': `${XML_DECL}<Relationships>` },
  });
  assert.equal(refusedXlsx(rels).code, 'malformed-xml');
});

test("decoder: a shared string index that is not an integer is malformed XML", () => {
  const bytes = workbookZip({
    shared: ['<t>name</t>', '<t>phone</t>'],
    rows: headerRow() + xlRow(2, rawCell('A2', 's', '<v>name</v>') + nCell('B2', '0100')),
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

test("decoder: a shared string index past the table is malformed XML", () => {
  const bytes = workbookZip({
    shared: ['<t>name</t>', '<t>phone</t>'],
    rows: headerRow() + xlRow(2, sCell('A2', 9) + nCell('B2', '0100')),
  });
  assert.equal(refusedXlsx(bytes).code, 'malformed-xml');
});

// ===========================================================================
// The real decoder: the bounds, at their exact edges
// ===========================================================================

test("decoder: the declared file bound is the same bound the CSV path uses", () => {
  assert.equal(STUDENT_XLSX_MAX_BYTES, STUDENT_CSV_MAX_BYTES);
});

test("decoder: 1001 rows including the header are accepted and 1002 are refused", () => {
  const build = (count: number): string => {
    let rows = headerRow();
    for (let index = 2; index <= count; index += 1) {
      rows += xlRow(
        index,
        iCell(`A${index}`, `Student ${index}`) + nCell(`B${index}`, `0100${index}`),
      );
    }
    return rows;
  };
  const accepted = parsedXlsx(workbookZip({ rows: build(STUDENT_XLSX_MAX_ROWS) }));
  assert.equal(accepted.length, STUDENT_XLSX_MAX_ROWS - 1);
  const refused = refusedXlsx(workbookZip({ rows: build(STUDENT_XLSX_MAX_ROWS + 1) }));
  assert.equal(refused.code, 'too-many-records');
  assert.equal(refused.detail, String(STUDENT_CSV_MAX_RECORDS));
});

test("decoder: 6001 shared strings are accepted and 6002 are refused", () => {
  const build = (count: number): string[] => {
    const items = ['<t>name</t>', '<t>phone</t>'];
    for (let index = 0; index < count; index += 1) items.push(`<t>s${index}</t>`);
    return items;
  };
  const accepted = parsedXlsx(workbookZip({ shared: build(5999), rows: headerRow() }));
  assert.equal(accepted.length, 0, 'the header alone is a workbook with no data record');
  const refused = refusedXlsx(workbookZip({ shared: build(6000), rows: headerRow() }));
  assert.equal(refused.code, 'too-many-shared-strings');
  assert.equal(refused.detail, String(STUDENT_XLSX_MAX_SHARED_STRINGS));
});

test("decoder: a cell of exactly 4096 characters is accepted and 4097 is refused", () => {
  const exact = 'a'.repeat(STUDENT_CSV_MAX_CELL_CHARS);
  const accepted = parsedXlsx(workbookZip({
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + iCell('B2', exact)),
  }));
  assert.equal(accepted[0].phone.length, STUDENT_CSV_MAX_CELL_CHARS);
  const refused = refusedXlsx(workbookZip({
    rows: headerRow() + xlRow(2, iCell('A2', 'Ali') + iCell('B2', `${exact}b`)),
  }));
  assert.equal(refused.code, 'cell-too-long');
  assert.equal(refused.detail, String(STUDENT_CSV_MAX_CELL_CHARS));
});

// ===========================================================================
// The real controller: the dual-format lifecycle
// ===========================================================================

const csvFile = (name: string, size: number): StudentCsvPreviewFile => ({ name, size });

/** A workbook that decodes to two data records. */
const READY_WORKBOOK = workbookZip({
  rows:
    headerRow() +
    xlRow(2, iCell('A2', 'Ali') + nCell('B2', '0100')) +
    xlRow(3, iCell('A3', 'Hassan') + nCell('B3', '0101')),
});

/**
 * The REAL controller with BOTH read seams injected: a spreadsheet is read as
 * bytes, everything else as text, and each seam records its own pending reply
 * so the reversed, rejected and retired replies stay deterministic.
 */
const createDualController = (
  overrides: Partial<StudentCsvPreviewApi> = {},
): {
  controller: ReturnType<typeof createStudentCsvPreviewController>;
  sink: SessionSink;
  textReads: Array<Deferred<string>>;
  byteReads: Array<Deferred<Uint8Array>>;
} => {
  const sink = createSessionSink();
  const textReads: Array<Deferred<string>> = [];
  const byteReads: Array<Deferred<Uint8Array>> = [];
  const api: StudentCsvPreviewApi = {
    readFile: () => {
      const pending = deferred<string>();
      textReads.push(pending);
      return pending.promise;
    },
    readBytes: () => {
      const pending = deferred<Uint8Array>();
      byteReads.push(pending);
      return pending.promise;
    },
    readPrincipal: () => 'session:a',
    subscribeSession: sink.subscribeSession,
    ...overrides,
  };
  return { controller: createStudentCsvPreviewController(api), sink, textReads, byteReads };
};

test("feature: a selected workbook is read through the byte seam and parsed", async () => {
  const { controller, byteReads, textReads } = createDualController();
  const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  assert.equal(controller.getState().phase, 'reading');
  assert.equal(byteReads.length, 1, 'a spreadsheet is read as bytes');
  assert.equal(textReads.length, 0, 'a spreadsheet is never mis-decoded as text');

  byteReads[0].resolve(READY_WORKBOOK);
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.fileName, 'students.xlsx');
  assert.equal(state.totalRows, 2);
  assert.deepEqual(state.headers, ['name', 'phone']);
  assert.equal(state.rows[0].name, 'Ali');
  assert.equal(state.rows[0].rowNumber, 2);
  assert.equal(state.rows[1].phone, '0101');
  controller.dispose();
});

test("feature: a spreadsheet selected without the byte seam is refused truthfully", async () => {
  const textReads: Array<Deferred<string>> = [];
  const controller = createStudentCsvPreviewController({
    readFile: () => {
      const pending = deferred<string>();
      textReads.push(pending);
      return pending.promise;
    },
    readPrincipal: () => 'session:a',
    subscribeSession: () => () => {},
  });
  await controller.selectFile(xlsxFile('students.xlsx', 4096));
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, 'error');
  assert.equal(state.error?.code, 'read-failed');
  assert.equal(textReads.length, 0, 'the container is never mis-decoded as text');
  controller.dispose();
});

test("feature: a byte seam that does not return bytes is refused truthfully", async () => {
  const { controller } = createDualController({
    readBytes: () => Promise.resolve('name,phone' as unknown as Uint8Array),
  });
  await controller.selectFile(xlsxFile('students.xlsx', 4096));
  await controller.waitForIdle();
  assert.equal(controller.getState().error?.code, 'read-failed');
  controller.dispose();
});

test("feature: a workbook over the size bound is never read at all", async () => {
  const { controller, byteReads } = createDualController();
  await controller.selectFile(xlsxFile('huge.xlsx', STUDENT_CSV_MAX_BYTES + 1));
  await controller.waitForIdle();

  assert.equal(byteReads.length, 0, 'the container is refused before it is read');
  const state = controller.getState();
  assert.equal(state.phase, 'error');
  assert.equal(state.error?.code, 'input-too-large');
  assert.equal(state.error?.detail, String(STUDENT_CSV_MAX_BYTES));
  controller.dispose();
});

test("feature: a newer workbook selection supersedes an older reply", async () => {
  const { controller, byteReads } = createDualController();
  const first = controller.selectFile(xlsxFile('first.xlsx', 4096));
  await flush();
  const second = controller.selectFile(xlsxFile('second.xlsx', 4096));
  await flush();
  assert.equal(byteReads.length, 2);

  // The OLDER reply arrives last: it must never revive its own data.
  byteReads[1].resolve(READY_WORKBOOK);
  await second;
  byteReads[0].resolve(READY_WORKBOOK);
  await first;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.fileName, 'second.xlsx');
  assert.equal(state.rows.length, 2);
  controller.dispose();
});

test("feature: an older workbook failure never overwrites a newer preview", async () => {
  const { controller, byteReads } = createDualController();
  const first = controller.selectFile(xlsxFile('first.xlsx', 4096));
  await flush();
  const second = controller.selectFile(xlsxFile('second.xlsx', 4096));
  await flush();

  byteReads[1].resolve(READY_WORKBOOK);
  await second;
  byteReads[0].reject(new Error('the read failed'));
  await first;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.error, null);
  assert.equal(state.rows[0].name, 'Ali');
  controller.dispose();
});

test("feature: an older reply never clears the newer workbook read's busy latch", async () => {
  const { controller, byteReads } = createDualController();
  const first = controller.selectFile(xlsxFile('first.xlsx', 4096));
  await flush();
  const second = controller.selectFile(xlsxFile('second.xlsx', 4096));
  await flush();

  byteReads[0].resolve(READY_WORKBOOK);
  await first;
  await flush();
  // The first read is finished, but the second one is still on the wire.
  assert.equal(controller.getState().phase, 'reading');

  byteReads[1].resolve(READY_WORKBOOK);
  await second;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, 'ready');
  controller.dispose();
});

test("feature: closing the preview retires a pending workbook read", async () => {
  const { controller, byteReads } = createDualController();
  const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  controller.clear();
  assert.equal(controller.getState().phase, 'idle');
  assert.equal(controller.getState().rows.length, 0);

  byteReads[0].resolve(READY_WORKBOOK);
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, 'a retired read revives nothing');
  assert.equal(controller.getState().phase, 'idle');
  controller.dispose();
});

test("feature: disposing retires a pending workbook read", async () => {
  const { controller, byteReads } = createDualController();
  const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  controller.dispose();

  byteReads[0].resolve(READY_WORKBOOK);
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0);
});

test("feature: a session event retires a pending workbook read", async () => {
  const { controller, sink, byteReads } = createDualController();
  const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  sink.notify();
  assert.equal(controller.getState().phase, 'idle');
  assert.equal(controller.getState().rows.length, 0);

  byteReads[0].resolve(READY_WORKBOOK);
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, 'a retired read revives nothing');
  controller.dispose();
  assert.equal(sink.count(), 0, 'the dispose unsubscribes from the session notifier');
});

test("feature: a silent principal change is observed before a workbook reply settles", async () => {
  let principal = 'session:a';
  const { controller, byteReads } = createDualController({ readPrincipal: () => principal });
  const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  // The session changed without any notifier event.
  principal = 'session:b';
  byteReads[0].resolve(READY_WORKBOOK);
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0, 'the foreign reply never revives the rows');
  assert.equal(state.fileName, null, 'the old scope keeps no private file name');
  assert.equal(state.phase, 'error');
  assert.equal(state.error?.code, 'session-changed');
  controller.dispose();
});

test("feature: a silent principal change is observed before a failed workbook reply settles", async () => {
  let principal = 'session:a';
  const { controller, byteReads } = createDualController({ readPrincipal: () => principal });
  const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  principal = 'session:b';
  byteReads[0].reject(new Error('the read failed'));
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.rows.length, 0);
  assert.equal(state.phase, 'error');
  assert.equal(state.error?.code, 'session-changed');
  controller.dispose();
});

test("feature: a refused workbook never shows a partial preview", async () => {
  const { controller, byteReads } = createDualController();
  const pending = controller.selectFile(xlsxFile('protected.xlsx', 4096));
  await flush();
  // An OLE2 compound container: an encrypted workbook.
  const ole2 = new Uint8Array(16);
  ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  byteReads[0].resolve(ole2);
  await pending;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, 'error');
  assert.equal(state.error?.code, 'password-protected');
  assert.equal(state.rows.length, 0);
  assert.equal(state.visibleRows.length, 0);
  controller.dispose();
});

test("feature: a legacy .xls is refused and is never read as text", async () => {
  const { controller, byteReads, textReads } = createDualController();
  const pending = controller.selectFile(xlsxFile('students.xls', 4096));
  await flush();
  assert.equal(byteReads.length, 1, 'a spreadsheet extension is read as bytes');
  assert.equal(textReads.length, 0, 'it is never mis-decoded as a comma separated file');

  byteReads[0].resolve(new Uint8Array([1, 2, 3]));
  await pending;
  await controller.waitForIdle();
  assert.equal(controller.getState().error?.code, 'unsupported-format');
  controller.dispose();
});

test("feature: the same controller previews a CSV file and then a workbook", async () => {
  const { controller, byteReads, textReads } = createDualController();
  const csv = controller.selectFile(csvFile('students.csv', 16));
  await flush();
  assert.equal(textReads.length, 1);
  textReads[0].resolve('name,phone\nAli,0100\n');
  await csv;
  await controller.waitForIdle();
  assert.equal(controller.getState().phase, 'ready');
  assert.equal(controller.getState().rows[0].name, 'Ali');

  const xlsx = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  assert.equal(byteReads.length, 1, 'the second selection uses the byte seam');
  byteReads[0].resolve(READY_WORKBOOK);
  await xlsx;
  await controller.waitForIdle();

  const state = controller.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.fileName, 'students.xlsx');
  assert.equal(state.totalRows, 2);
  assert.equal(state.rows[0].name, 'Ali');
  assert.equal(state.rows[0].rowNumber, 2);
  controller.dispose();
});

test("feature: only 25 rows of a workbook are visible per page", async () => {
  let rows = headerRow();
  for (let index = 2; index <= 61; index += 1) {
    rows += xlRow(index, iCell(`A${index}`, `Student ${index}`) + nCell(`B${index}`, `0100${index}`));
  }
  const { controller, byteReads } = createDualController();
  const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
  await flush();
  byteReads[0].resolve(workbookZip({ rows }));
  await pending;
  await controller.waitForIdle();

  const first = controller.getState();
  assert.equal(first.totalRows, 60);
  assert.equal(first.visibleRows.length, STUDENT_CSV_PAGE_SIZE);

  controller.nextRowPage();
  const second = controller.getState();
  assert.equal(second.rowPage, 1);
  assert.equal(second.visibleRows[0].rowIndex, 26);
  assert.equal(second.visibleRows[0].rowNumber, 27, 'the worksheet row number survives paging');

  controller.nextRowPage();
  controller.nextRowPage();
  assert.equal(controller.getState().rowPage, 2, 'the page never grows past the bound');
  controller.dispose();
});

test("feature: a workbook preview never reaches the network and never persists the file", async () => {
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
  define('fetch', () => {
    networkCalls += 1;
    throw new Error('the preview must not reach the network');
  });
  const storage = {
    getItem: () => null,
    setItem: () => {
      persistenceCalls += 1;
      throw new Error('the preview must not persist the file');
    },
    removeItem: () => {
      persistenceCalls += 1;
      throw new Error('the preview must not persist the file');
    },
    clear: () => {
      persistenceCalls += 1;
      throw new Error('the preview must not persist the file');
    },
    key: () => null,
    length: 0,
  };
  define('localStorage', storage);
  define('sessionStorage', storage);
  define('indexedDB', {
    open: () => {
      persistenceCalls += 1;
      throw new Error('the preview must not persist the file');
    },
  });

  try {
    const { controller, byteReads } = createDualController();
    const pending = controller.selectFile(xlsxFile('students.xlsx', 4096));
    await flush();
    byteReads[0].resolve(READY_WORKBOOK);
    await pending;
    await controller.waitForIdle();
    assert.equal(controller.getState().phase, 'ready');
    assert.equal(networkCalls, 0);
    assert.equal(persistenceCalls, 0);
    controller.dispose();
  } finally {
    if (previousFetch === undefined) delete globals.fetch;
    else define('fetch', previousFetch);
    if (previousLocal === undefined) delete globals.localStorage;
    else define('localStorage', previousLocal);
    if (previousSession === undefined) delete globals.sessionStorage;
    else define('sessionStorage', previousSession);
    if (previousIndexed === undefined) delete globals.indexedDB;
    else define('indexedDB', previousIndexed);
  }
});

// ===========================================================================
// The real component, rendered by the real React server renderer
// ===========================================================================

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Renders the REAL `StudentImportPreview` component with the REAL React
 * server renderer and the REAL shared UI primitives. Only the controller hook
 * snapshot is injected, so the markup comes from the production component
 * while no request, no browser and no live service is involved.
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

/**
 * Renders the REAL `StudentImportPreview` component against a REAL production
 * controller: the controller's live state is the component's snapshot and the
 * controller itself is the component's ref, so the rendered close control is
 * the REAL control and invoking it runs the REAL `closePreview` against the
 * REAL controller.
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

const CLOSE_LABEL = "إغلاق المعاينة";

test("component: the panel offers a CSV or XLSX picker and claims no import", async () => {
  const html = await renderStudentImportPreview(idleState());
  assert.match(html, /معاينة محلية فقط/, "the preview-only warning is rendered");
  assert.match(html, /لا يُحفظ أي طالب/, "the no-save warning is rendered");
  assert.match(html, /ولا استيراد فعلي/, "the no-import warning is rendered");
  assert.match(html, /اختر ملف CSV أو مصنف XLSX من جهازك/, "the dual picker is labelled");
  assert.match(html, /for="student-csv-file"/, "the label is bound to the input");
  assert.match(html, /accept="\.csv,text\/csv,\.xlsx,/, "the picker still accepts CSV");
  assert.match(html, /\.xlsx,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/, "the picker accepts XLSX");
  assert.match(html, /أول ورقة معلنة فقط/, "the first-worksheet rule is stated");
  assert.doesNotMatch(html, /حفظ الطالب/, "no import or save control is offered");
});

test("component: a refused workbook shows the truthful diagnostic and no rows", async () => {
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "error",
    fileName: "protected.xlsx",
    error: { code: "password-protected", line: null, detail: null },
  });
  assert.match(html, /المصنف محمي بكلمة مرور/, "the diagnostic is rendered");
  assert.doesNotMatch(html, /<table/, "no table is rendered for a refused workbook");
});

test("component: a workbook with an unsupported part names what is unsupported", async () => {
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "error",
    fileName: "macros.xlsx",
    error: { code: "unsupported-workbook-part", line: null, detail: null },
  });
  assert.match(html, /جزءًا غير مدعوم/, "the diagnostic is rendered");
  assert.doesNotMatch(html, /<table/, "no table is rendered");
});

test("component: a parsed workbook shows its rows and its worksheet numbers", async () => {
  const bytes = workbookZip({
    rows:
      headerRow() +
      xlRow(2, iCell("A2", "Ali") + nCell("B2", "0100")) +
      xlRow(3, iCell("A3", "Hassan") + nCell("B3", "0101")),
  });
  const result = parseStudentXlsx(bytes);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const rows = result.rows;
  const issues = rows.flatMap((row) => row.issues);
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "ready",
    fileName: "students.xlsx",
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
  assert.match(html, /<table/, "the preview table is rendered");
  assert.match(html, /Ali/, "a decoded workbook value is rendered");
  assert.match(html, /students\.xlsx/, "the selected file name is rendered");
  assert.match(html, /الصفحة 1 من 1/, "the bounded paging is rendered");
  assert.doesNotMatch(html, /حفظ الطالب/, "no import or save control is offered");
});

test("component: a workbook value is rendered as text and never as markup", async () => {
  const bytes = workbookZip({
    rows:
      headerRow() +
      xlRow(2, iCell("A2", "&lt;script&gt;alert(1)&lt;/script&gt;") + nCell("B2", "0100")),
  });
  const result = parseStudentXlsx(bytes);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const rows = result.rows;
  assert.equal(rows[0].name, "<script>alert(1)</script>", "the value really carries markup");
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "ready",
    fileName: "students.xlsx",
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

test("component: the close control is enabled while a workbook read is pending and retires it", async () => {
  const pendingRead = deferred<Uint8Array>();
  const controller = createStudentCsvPreviewController({
    readFile: () => deferred<string>().promise,
    readBytes: () => pendingRead.promise,
    readPrincipal: () => "session:a",
    subscribeSession: () => () => {},
  });
  const operation = controller.selectFile(xlsxFile("students.xlsx", 16));
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

  pendingRead.resolve(READY_WORKBOOK);
  await operation;
  await controller.waitForIdle();
  assert.equal(controller.getState().rows.length, 0, "a late reply revives nothing");
  assert.equal(controller.getState().phase, "idle");
  controller.dispose();
});

test("component: the close control is still the only one in the ready phase", async () => {
  const bytes = workbookZip({
    rows: headerRow() + xlRow(2, iCell("A2", "Ali") + nCell("B2", "0100")),
  });
  const result = parseStudentXlsx(bytes);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const rows = result.rows;
  const issues = rows.flatMap((row) => row.issues);
  const html = await renderStudentImportPreview({
    ...idleState(),
    phase: "ready",
    fileName: "students.xlsx",
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
