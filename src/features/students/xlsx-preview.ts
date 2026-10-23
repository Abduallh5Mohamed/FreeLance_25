/**
 * M2-17 — the bounded local XLSX student preview seam.
 *
 * Scope (`docs/streams/client/M2-17-HANDOFF.md`): a READ-ONLY, LOCAL decode of
 * the instructor's own `.xlsx` workbook, mapped onto the SAME canonical
 * preview rows the accepted CSV path produces. Nothing here creates, updates
 * or imports a student: there is no `createStudent` call, no bulk endpoint, no
 * persistence (localStorage, sessionStorage or IndexedDB) and no network of
 * any kind. The seam prepares local input only, so the audited import commit
 * remains the only way anything leaves the browser.
 *
 * Why this module exists: XLSX was a recorded C12 gap, which forced
 * instructors to convert their spreadsheet outside the product. This decoder
 * removes that step WITHOUT widening the trust boundary — the file is decoded
 * in memory, from the first declared worksheet only, and every bound below is
 * enforced before a single byte is inflated.
 *
 * Design rules, in the order they are enforced:
 *
 *  1. CONTAINER. Only `.xlsx` is accepted. Legacy `.xls`, macro `.xlsm` and
 *     template variants are refused by name. An OLE2 compound container (an
 *     encrypted workbook) is refused as password-protected: a modern `.xlsx`
 *     is a ZIP archive, and the legacy containers were already refused by
 *     name, so an OLE2 file carrying the `.xlsx` name is an encrypted one.
 *  2. AUDIT BEFORE INFLATION. The ZIP central directory is walked once with
 *     inflation switched OFF. Entry count, declared uncompressed total, the
 *     compression method of every entry, duplicate CANONICAL paths, traversal
 *     paths and the unsupported workbook parts are all decided from the
 *     directory alone. A refused archive therefore never inflates anything at
 *     all.
 *  3. INFLATE ONLY WHAT IS NEEDED. `xl/workbook.xml`, its relationships, the
 *     shared string table and the resolved first worksheet — nothing else.
 *  4. FAIL CLOSED. Every malformed construct produces a truthful file-level
 *     diagnostic and no rows, never a partially accepted workbook.
 *
 * The module imports the accepted column vocabulary, bounds and canonical row
 * builder from `csv-preview`. The reverse import (the dual-format dispatch)
 * makes the pair a cycle; it is safe because both sides only reach for each
 * other's exports from inside function bodies, never while initialising.
 */

import { unzipSync } from 'fflate';
import {
  STUDENT_CSV_MAX_CELL_CHARS,
  STUDENT_CSV_MAX_COLUMNS,
  STUDENT_CSV_MAX_RECORDS,
  buildStudentPreviewFromRecords,
  parseStudentCsv,
} from './csv-preview';
import type {
  StudentCsvError,
  StudentCsvParseResult,
  StudentCsvSourceRecord,
} from './csv-preview';

// ---------------------------------------------------------------------------
// Bounds (implementation limits, NOT business entitlements)
// ---------------------------------------------------------------------------

/**
 * The maximum size of the SELECTED FILE (1 MiB). It is the same bound the
 * accepted CSV path uses, and it is checked on the declared size before the
 * file is read at all.
 */
export const STUDENT_XLSX_MAX_BYTES = 1024 * 1024;

/** The maximum number of entries the archive may declare. */
export const STUDENT_XLSX_MAX_ZIP_ENTRIES = 128;

/** The maximum total DECLARED uncompressed size of the whole archive (4 MiB). */
export const STUDENT_XLSX_MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;

/** The maximum DECLARED uncompressed size of one relevant XML entry (2 MiB). */
export const STUDENT_XLSX_MAX_XML_ENTRY_BYTES = 2 * 1024 * 1024;

/** The maximum number of shared strings the workbook may declare. */
export const STUDENT_XLSX_MAX_SHARED_STRINGS = 6001;

/** The maximum number of worksheet rows, INCLUDING the header row. */
export const STUDENT_XLSX_MAX_ROWS = 1001;

/** The highest spreadsheet column index this decoder understands (XFD). */
const MAX_COLUMN_INDEX = 16384;

/** The highest spreadsheet row index this decoder understands. */
const MAX_ROW_INDEX = 1048576;

/** The compression methods a spreadsheet may use: stored and deflate. */
const SUPPORTED_COMPRESSION = [0, 8];

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Every spreadsheet extension the picker routes to THIS decoder. Anything
 * other than `.xlsx` is refused here with a truthful `unsupported-format`,
 * so a legacy `.xls` or a macro `.xlsm` never reaches the CSV parser and is
 * never mistaken for a comma separated file.
 */
export const STUDENT_SPREADSHEET_EXTENSIONS = [
  '.xlsx',
  '.xlsm',
  '.xls',
  '.xltx',
  '.xltm',
] as const;

/** The single extension this decoder accepts. */
export const STUDENT_XLSX_EXTENSION = '.xlsx';

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
};

/** True for any spreadsheet extension, including the refused ones. */
export const isStudentSpreadsheetFileName = (name: string): boolean => {
  if (typeof name !== 'string') return false;
  return (STUDENT_SPREADSHEET_EXTENSIONS as readonly string[]).indexOf(extensionOf(name)) !== -1;
};

/** True only for the extension this decoder actually decodes. */
export const isStudentXlsxFileName = (name: string): boolean => {
  if (typeof name !== 'string') return false;
  return extensionOf(name) === STUDENT_XLSX_EXTENSION;
};

// ---------------------------------------------------------------------------
// A small, bounded, deterministic XML scanner
// ---------------------------------------------------------------------------

/**
 * The workbook parts are XML, but this module may not pull in a DOM (the
 * decoder must run identically in the browser and in the hermetic Node test
 * runner), so it carries its own scanner. It is deliberately minimal: a
 * single forward pass, no regular expressions, no backtracking and no
 * recursion, so a hostile document can only ever cost the work of reading it
 * once.
 *
 * The scanner still enforces well-formedness where it matters: it keeps the
 * stack of open elements, so a closing tag that matches nothing, a stray
 * closing tag and an element left open at the end of the part are all
 * refusals. A flat token stream would silently reinterpret a mis-nested part
 * as a different structure, which is exactly the guess this decoder refuses
 * to make.
 */
type XmlToken =
  | {
      readonly kind: 'open';
      readonly name: string;
      readonly attrs: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
    }
  | { readonly kind: 'close'; readonly name: string }
  | { readonly kind: 'text'; readonly value: string };

class MalformedXml extends Error {}

const NAME_TERMINATORS = ' \t\r\n/=<>';

const isNameTerminator = (character: string): boolean =>
  NAME_TERMINATORS.indexOf(character) !== -1;

/** The four XML whitespace characters. */
const isXmlWhitespace = (character: string): boolean =>
  character === ' ' || character === '\t' || character === '\r' || character === '\n';

/** Decodes the five XML entities and both numeric forms. */
const decodeXmlEntities = (raw: string): string => {
  if (raw.indexOf('&') === -1) return raw;
  let out = '';
  let index = 0;
  while (index < raw.length) {
    const character = raw[index];
    if (character !== '&') {
      out += character;
      index += 1;
      continue;
    }
    const semi = raw.indexOf(';', index + 1);
    // An entity reference is at most a few characters long. A distant `;`
    // means the `&` is a literal ampersand, not the start of a reference.
    if (semi === -1 || semi - index > 32) {
      out += character;
      index += 1;
      continue;
    }
    const body = raw.slice(index + 1, semi);
    if (body === 'amp') out += '&';
    else if (body === 'lt') out += '<';
    else if (body === 'gt') out += '>';
    else if (body === 'quot') out += '"';
    else if (body === 'apos') out += "'";
    else if (body.length > 1 && body[0] === '#') {
      const digits = body[1] === 'x' || body[1] === 'X' ? body.slice(2) : body.slice(1);
      const radix = body[1] === 'x' || body[1] === 'X' ? 16 : 10;
      const code = parseInt(digits, radix);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new MalformedXml('character reference out of range');
      }
      out += String.fromCodePoint(code);
    } else {
      throw new MalformedXml('unknown entity reference');
    }
    index = semi + 1;
  }
  return out;
};

class XmlScanner {
  private readonly text: string;
  private position = 0;
  /**
   * The elements that are currently open, innermost last.
   *
   * XML requires every closing tag to match the element it closes, so a
   * mismatch, a stray closing tag or an element left open at the end of the
   * part is MALFORMED — not a construct the decoder may reinterpret. The stack
   * is what turns that rule into a refusal instead of a silent guess: without
   * it a mis-nested part would simply be re-read as a different structure.
   */
  private readonly openElements: string[] = [];

  constructor(text: string) {
    this.text = text;
  }

  /** The next token, or null once the document is exhausted. */
  next(): XmlToken | null {
    while (this.position < this.text.length) {
      if (this.text[this.position] !== '<') return this.readText();
      const token = this.readMarkup();
      // Comments, processing instructions and doctype declarations carry no
      // data: they are skipped and the loop continues.
      if (token !== null) return token;
    }
    // A part that ends with an element still open is not well formed.
    if (this.openElements.length > 0) {
      throw new MalformedXml(`unclosed <${this.openElements[this.openElements.length - 1]}>`);
    }
    return null;
  }

  private readText(): XmlToken {
    const start = this.position;
    while (this.position < this.text.length && this.text[this.position] !== '<') {
      this.position += 1;
    }
    return { kind: 'text', value: decodeXmlEntities(this.text.slice(start, this.position)) };
  }

  private readMarkup(): XmlToken | null {
    const text = this.text;
    if (text.startsWith('<!--', this.position)) {
      const end = text.indexOf('-->', this.position + 4);
      if (end === -1) throw new MalformedXml('unterminated comment');
      this.position = end + 3;
      return null;
    }
    if (text.startsWith('<![CDATA[', this.position)) {
      const end = text.indexOf(']]>', this.position + 9);
      if (end === -1) throw new MalformedXml('unterminated CDATA section');
      // CDATA content is taken verbatim: entities inside it are literal.
      const value = text.slice(this.position + 9, end);
      this.position = end + 3;
      return { kind: 'text', value };
    }
    if (text.startsWith('<?', this.position)) {
      const end = text.indexOf('?>', this.position + 2);
      if (end === -1) throw new MalformedXml('unterminated processing instruction');
      this.position = end + 2;
      return null;
    }
    if (text.startsWith('<!', this.position)) {
      const end = text.indexOf('>', this.position + 2);
      if (end === -1) throw new MalformedXml('unterminated declaration');
      this.position = end + 1;
      return null;
    }
    if (text.startsWith('</', this.position)) {
      const end = text.indexOf('>', this.position + 2);
      if (end === -1) throw new MalformedXml('unterminated closing tag');
      const name = text.slice(this.position + 2, end).trim();
      if (name === '') throw new MalformedXml('empty closing tag');
      const open = this.openElements.pop();
      if (open === undefined || open !== name) {
        throw new MalformedXml(`a closing </${name}> matches no open element`);
      }
      this.position = end + 1;
      return { kind: 'close', name };
    }
    return this.readOpenTag();
  }

  private readOpenTag(): XmlToken {
    const text = this.text;
    let cursor = this.position + 1;
    const nameStart = cursor;
    while (cursor < text.length && !isNameTerminator(text[cursor])) cursor += 1;
    const name = text.slice(nameStart, cursor);
    if (name === '') throw new MalformedXml('empty element name');
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (cursor < text.length) {
      while (cursor < text.length && isXmlWhitespace(text[cursor])) cursor += 1;
      if (cursor >= text.length) throw new MalformedXml('unterminated opening tag');
      if (text[cursor] === '>') {
        cursor += 1;
        break;
      }
      if (text[cursor] === '/' && text[cursor + 1] === '>') {
        selfClosing = true;
        cursor += 2;
        break;
      }      const attrStart = cursor;
      while (cursor < text.length && !isNameTerminator(text[cursor])) cursor += 1;
      const attrName = text.slice(attrStart, cursor);
      if (attrName === '') throw new MalformedXml('malformed attribute name');
      while (cursor < text.length && isXmlWhitespace(text[cursor])) cursor += 1;
      let value = '';
      if (text[cursor] === '=') {
        cursor += 1;
        while (cursor < text.length && isXmlWhitespace(text[cursor])) cursor += 1;
        const quote = text[cursor];
        if (quote !== '"' && quote !== "'") throw new MalformedXml('unquoted attribute value');
        const valueStart = cursor + 1;
        const valueEnd = text.indexOf(quote, valueStart);
        if (valueEnd === -1) throw new MalformedXml('unterminated attribute value');
        value = decodeXmlEntities(text.slice(valueStart, valueEnd));
        cursor = valueEnd + 1;
      }
      attrs.set(attrName, value);
    }
    this.position = cursor;
    // A self-closing element opens and closes at once, so it never enters the
    // stack; anything else stays open until its own closing tag arrives.
    if (!selfClosing) this.openElements.push(name);
    return { kind: 'open', name, attrs, selfClosing };
  }
}

// ---------------------------------------------------------------------------
// The ZIP container: audit first, inflate second
// ---------------------------------------------------------------------------

/** One entry as declared by the central directory, before any inflation. */
interface ZipEntryDeclaration {
  readonly name: string;
  /** The compressed size declared by the directory. */
  readonly compressedSize: number;
  /** The uncompressed size declared by the directory. */
  readonly declaredSize: number;
  readonly compression: number;
}

/** Thrown by the audit pass; carries the truthful file-level diagnostic. */
class ArchiveRefusal extends Error {
  constructor(readonly refusal: StudentCsvError) {
    super(refusal.code);
  }
}

const refuseArchive = (
  code: StudentCsvError['code'],
  detail: string | null = null,
): never => {
  throw new ArchiveRefusal({ code, line: null, detail });
};

/**
 * The workbook parts this decoder refuses on sight. Every one of them either
 * executes code, pulls data from outside the file, or renders content the
 * decoder does not model — and each is recognised from its NAME alone, so the
 * refusal happens before a single byte of it is inflated.
 */
const UNSUPPORTED_PART_PREFIXES: readonly string[] = [
  // Data pulled from outside the workbook.
  'xl/externallinks/',
  'xl/externallink/',
  'xl/connections.xml',
  'xl/querytables/',
  // Rendered objects the decoder does not model.
  'xl/drawings/',
  'xl/media/',
  'xl/charts/',
  // Interactive controls and pivot machinery.
  'xl/ctrlprops/',
  'xl/activex/',
  'xl/pivottables/',
  'xl/pivotcache/',
  'xl/slicers/',
  // A ListObject can inject a totals row into the sheet's data, which is
  // indistinguishable from a real record, so it is refused rather than guessed.
  'xl/tables/',
];

/** Parts recognised by their file NAME, wherever they sit in the archive. */
const UNSUPPORTED_PART_NAMES: readonly string[] = [
  // A VBA project is executable code.
  'vbaproject.bin',
];

/**
 * The ONE canonical identity of a ZIP entry.
 *
 * The central directory of a hostile or careless writer may spell the same part
 * in more than one way: Excel resolves part names case-insensitively, and a
 * ZIP may prefix a name with `./`. Lower-casing the name and stripping every
 * leading `./` therefore gives the single identity this decoder uses for
 * duplicate detection, for refusing unsupported parts and for selecting the
 * parts it inflates.
 *
 * Using a different spelling for any one of those would let one part be
 * declared twice: `xl/worksheets/sheet1.xml` and `XL/WORKSHEETS/SHEET1.XML`
 * would both pass a raw-name duplicate audit, and the second entry would then
 * silently overwrite the first in the canonical output map — a workbook the
 * instructor never wrote.
 */
const canonicalZipPath = (name: string): string => {
  let path = name.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  return path.toLowerCase();
};

const isUnsupportedPart = (raw: string): boolean => {
  const path = canonicalZipPath(raw);
  for (const prefix of UNSUPPORTED_PART_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  for (const name of UNSUPPORTED_PART_NAMES) {
    if (path === name || path.endsWith(`/${name}`)) return true;
  }
  return false;
};

/**
 * A path is unsafe when it escapes the archive: a traversal segment, an
 * absolute path, a drive letter or a backslash separator. A directory entry
 * is not unsafe, it is simply not a file.
 */
const isUnsafeZipPath = (raw: string): boolean => {
  if (raw === '') return true;
  if (raw.indexOf('\\') !== -1) return true;
  if (raw.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(raw)) return true;
  for (const segment of raw.split('/')) {
    if (segment === '..') return true;
  }
  return false;
};

const isDirectoryEntry = (raw: string): boolean => raw.endsWith('/');

/** The OLE2 compound-file magic: an encrypted workbook, never a modern ZIP. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const hasOle2Magic = (bytes: Uint8Array): boolean => {
  if (bytes.length < OLE2_MAGIC.length) return false;
  for (let index = 0; index < OLE2_MAGIC.length; index += 1) {
    if (bytes[index] !== OLE2_MAGIC[index]) return false;
  }
  return true;
};

const hasZipMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

/**
 * Walks the central directory with inflation switched OFF and decides every
 * container-level rule from the declarations alone.
 *
 * The filter returns `false` for EVERY entry, so nothing is inflated: a
 * refused archive never allocates an output buffer at all. The entry
 * declarations are returned so the inflation pass can select the parts it
 * needs without walking the directory a second time for metadata.
 */
const auditZipEntries = (bytes: Uint8Array): ZipEntryDeclaration[] => {
  const declarations: ZipEntryDeclaration[] = [];
  const seenPaths = new Set<string>();
  let declaredTotal = 0;
  let entryCount = 0;

  unzipSync(bytes, {
    filter(info) {
      entryCount += 1;
      if (entryCount > STUDENT_XLSX_MAX_ZIP_ENTRIES) {
        refuseArchive('too-many-zip-entries', String(STUDENT_XLSX_MAX_ZIP_ENTRIES));
      }
      const name = info.name;
      if (!isDirectoryEntry(name) && isUnsafeZipPath(name)) refuseArchive('unsafe-zip-path');
      if (isUnsupportedPart(name)) refuseArchive('unsupported-workbook-part');
      if (!isDirectoryEntry(name)) {
        if (SUPPORTED_COMPRESSION.indexOf(info.compression) === -1) {
          refuseArchive('unsupported-compression', String(info.compression));
        }
        // The duplicate identity is the SAME canonical path the inflation pass
        // selects on, so a case-only or leading-`./` variant of a declared
        // part is the same part and is refused here, before anything is
        // inflated.
        const canonical = canonicalZipPath(name);
        if (seenPaths.has(canonical)) refuseArchive('duplicate-zip-entry');
        seenPaths.add(canonical);
        declaredTotal += info.originalSize;
        if (declaredTotal > STUDENT_XLSX_MAX_UNCOMPRESSED_BYTES) {
          refuseArchive('archive-too-large', String(STUDENT_XLSX_MAX_UNCOMPRESSED_BYTES));
        }
        declarations.push({
          name,
          compressedSize: info.size,
          declaredSize: info.originalSize,
          compression: info.compression,
        });
      }
      // Nothing is inflated during the audit.
      return false;
    },
  });

  return declarations;
};

/**
 * Inflates exactly the named parts of an ALREADY AUDITED archive. The bounds
 * were enforced by `auditZipEntries`; this pass re-checks the per-entry bound
 * defensively and then returns only the parts the caller asked for.
 */
const inflateParts = (
  bytes: Uint8Array,
  wanted: readonly string[],
): Map<string, Uint8Array> => {
  const wantedPaths = new Set(wanted.map((name) => canonicalZipPath(name)));
  const selectedPaths = new Set<string>();
  const files = unzipSync(bytes, {
    filter(info) {
      if (isDirectoryEntry(info.name)) return false;
      // Both the selection and the identity of the result are canonical, so the
      // same part can only ever appear once. The audit already refused every
      // collision; this backstop keeps the output map from ever overwriting
      // one selected part with another even if the audit is refactored.
      const path = canonicalZipPath(info.name);
      if (!wantedPaths.has(path)) return false;
      if (selectedPaths.has(path)) refuseArchive('duplicate-zip-entry');
      if (info.originalSize > STUDENT_XLSX_MAX_XML_ENTRY_BYTES) {
        refuseArchive('entry-too-large', String(STUDENT_XLSX_MAX_XML_ENTRY_BYTES));
      }
      selectedPaths.add(path);
      return true;
    },
  });
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    out.set(canonicalZipPath(name), data);
  }
  return out;
};

/** The canonical part paths of a workbook. */
const WORKBOOK_PART = 'xl/workbook.xml';
const WORKBOOK_RELS_PART = 'xl/_rels/workbook.xml.rels';
const SHARED_STRINGS_PART = 'xl/sharedstrings.xml';

// ---------------------------------------------------------------------------
// The workbook parts
// ---------------------------------------------------------------------------

/**
 * Decodes a UTF-8 XML part. A part that is not valid UTF-8 is malformed, so
 * the decode is fatal rather than silently replacing bytes.
 */
const utf8Text = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuseArchive('malformed-xml');
  }
};

/** A malformed XML part is always a truthful file-level refusal. */
const scanPart = (bytes: Uint8Array): XmlScanner => {
  try {
    return new XmlScanner(utf8Text(bytes));
  } catch {
    refuseArchive('malformed-xml');
  }
};

interface FirstSheetTarget {
  /** The relationship id the first declared sheet points at. */
  readonly relationshipId: string;
}

/**
 * Reads `xl/workbook.xml` for two things only: whether the workbook is
 * password protected, and the relationship id of the FIRST declared sheet.
 *
 * The first sheet in document order is the answer — no sheet is guessed, no
 * sheets are merged and the active tab is irrelevant.
 */
const readWorkbook = (bytes: Uint8Array): FirstSheetTarget => {
  const scanner = scanPart(bytes);
  let insideSheets = false;
  let relationshipId: string | null = null;

  for (let token = scanner.next(); token !== null; token = scanner.next()) {
    if (token.kind === 'open') {
      // A password on the workbook structure is a refusal: the decoder never
      // opens a protected workbook, not even read-only.
      if (token.name === 'workbookProtection') {
        if (token.attrs.has('workbookPassword') || token.attrs.has('revisionsPassword')) {
          refuseArchive('password-protected');
        }
        continue;
      }
      if (token.name === 'sheets') {
        // `<sheets/>` is never legitimate, but a self-closing tag must not
        // leave the "inside" flag stuck on for the rest of the document.
        insideSheets = !token.selfClosing;
        continue;
      }
      // The FIRST `<sheet>` in document order wins. No sheet is guessed, no
      // sheets are merged and the active tab is irrelevant.
      if (insideSheets && token.name === 'sheet' && relationshipId === null) {
        const id = token.attrs.get('r:id') ?? token.attrs.get('id');
        if (id === undefined || id === '') refuseArchive('missing-worksheet');
        relationshipId = id as string;
      }
      continue;
    }
    if (token.kind === 'close' && token.name === 'sheets') insideSheets = false;
  }

  if (relationshipId === null) refuseArchive('missing-worksheet');
  return { relationshipId };
};

/** Resolves a relationship target against the part that declared it. */
const resolvePartPath = (target: string): string => {
  let path = target.replace(/\\/g, '/');
  if (path.startsWith('/')) return path.slice(1).toLowerCase();
  // A workbook relationship target is relative to `xl/`.
  return `xl/${path}`.toLowerCase();
};

/**
 * Reads `xl/_rels/workbook.xml.rels` into an id → { target, type } map.
 * A relationship that cannot be read is not fatal on its own: the sheet's own
 * relationship is what has to resolve.
 */
const readWorkbookRelationships = (
  bytes: Uint8Array,
): Map<string, { target: string; type: string }> => {
  const scanner = scanPart(bytes);
  const relationships = new Map<string, { target: string; type: string }>();
  for (let token = scanner.next(); token !== null; token = scanner.next()) {
    if (token.kind !== 'open' || token.name !== 'Relationship') continue;
    const id = token.attrs.get('Id');
    const target = token.attrs.get('Target');
    if (id === undefined || target === undefined) continue;
    relationships.set(id, { target, type: token.attrs.get('Type') ?? '' });
  }
  return relationships;
};

/** Resolves the first declared sheet's relationship to a concrete part path. */
const resolveWorksheetPart = (
  relationshipId: string,
  relationships: Map<string, { target: string; type: string }>,
  available: readonly ZipEntryDeclaration[],
): string => {
  const relationship = relationships.get(relationshipId);
  if (relationship === undefined) refuseArchive('missing-worksheet');
  // A chartsheet or a dialog sheet is not a worksheet this decoder models.
  if (!relationship.type.endsWith('/worksheet')) refuseArchive('unsupported-workbook-part');
  const path = resolvePartPath(relationship.target);
  const known = available.some((entry) => canonicalZipPath(entry.name) === path);
  if (!known) refuseArchive('missing-worksheet');
  return path;
};

/**
 * Reads `xl/sharedStrings.xml` into an ordered array. The text of a shared
 * string is the concatenation of its runs in document order, taken verbatim:
 * the accepted trim happens later, in the canonical row mapping.
 *
 * A phonetic run (`<rPh>`) carries pronunciation hints, not content, so its
 * text is skipped.
 */
const readSharedStrings = (bytes: Uint8Array): string[] => {
  const scanner = scanPart(bytes);
  const strings: string[] = [];
  /** Depth of nested `<si>` elements (0 or 1 in a well formed table). */
  let siDepth = 0;
  /** Depth of nested `<t>` elements inside the current `<si>`. */
  let textDepth = 0;
  /** Whether the scanner is inside a phonetic run, whose text is not content. */
  let insidePhonetic = false;
  let current = '';

  const closeText = (): void => {
    if (textDepth > 0) textDepth -= 1;
  };
  const closeString = (): void => {
    if (siDepth === 0) return;
    siDepth -= 1;
    if (strings.length >= STUDENT_XLSX_MAX_SHARED_STRINGS) {
      refuseArchive('too-many-shared-strings', String(STUDENT_XLSX_MAX_SHARED_STRINGS));
    }
    strings.push(current);
    current = '';
  };

  for (let token = scanner.next(); token !== null; token = scanner.next()) {
    if (token.kind === 'text') {
      if (siDepth > 0 && textDepth > 0 && !insidePhonetic) current += token.value;
      continue;
    }
    if (token.kind === 'open') {
      const name = token.name;
      // A self-closing tag is an open immediately followed by its close.
      const closes = token.selfClosing;
      if (name === 'si') {
        if (siDepth > 0) refuseArchive('malformed-xml');
        siDepth += 1;
        current = '';
        if (closes) closeString();
        continue;
      }
      if (siDepth === 0) continue;
      if (name === 't') {
        if (textDepth > 0) refuseArchive('malformed-xml');
        textDepth += 1;
        if (closes) closeText();
        continue;
      }
      if (name === 'rPh' || name === 'phoneticPr') {
        insidePhonetic = true;
        continue;
      }
      continue;
    }
    // closing tag
    if (token.name === 't') closeText();
    else if (token.name === 'rPh' || token.name === 'phoneticPr') insidePhonetic = false;
    else if (token.name === 'si') closeString();
  }
  if (siDepth !== 0 || textDepth !== 0) refuseArchive('malformed-xml');
  return strings;
};

// ---------------------------------------------------------------------------
// The first worksheet
// ---------------------------------------------------------------------------

/** Splits `BC12` into its column index and its physical row number. */
const splitCellReference = (
  reference: string,
): { column: number; row: number } | null => {
  let cursor = 0;
  let column = 0;
  while (cursor < reference.length) {
    const code = reference.charCodeAt(cursor);
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (!upper && !lower) break;
    column = column * 26 + (upper ? code - 64 : code - 96);
    if (column > MAX_COLUMN_INDEX) return null;
    cursor += 1;
  }
  // A reference with no letters, or with letters and no digits, is malformed.
  if (cursor === 0 || cursor === reference.length) return null;
  let row = 0;
  for (let index = cursor; index < reference.length; index += 1) {
    const code = reference.charCodeAt(index);
    if (code < 48 || code > 57) return null;
    row = row * 10 + (code - 48);
    if (row > MAX_ROW_INDEX) return null;
  }
  if (row < 1) return null;
  return { column, row };
};

/** A single decoded cell of the worksheet grid. */
interface DecodedCell {
  /** The 1-based column index the cell occupies. */
  readonly column: number;
  /** The RAW text of the cell, exactly as the workbook stored it. */
  readonly value: string;
}

/** A decoded worksheet row. A row with no cells at all is a blank row. */
interface DecodedRow {
  /** The physical worksheet row number. */
  readonly rowNumber: number;
  readonly cells: DecodedCell[];
}

interface DecodedSheet {
  readonly rows: DecodedRow[];
}

/**
 * Reads the first worksheet into a dense grid.
 *
 * The decoder is deliberately literal about what a cell MEANS:
 *
 *  - `t="s"` → the shared string at that index.
 *  - `t="inlineStr"` → the inline string's runs, concatenated verbatim.
 *  - `t="n"` or no type → the XML lexical text of `<v>`, so `007` survives
 *    only when the workbook really stored it as text.
 *  - `t="str"` → REFUSED. It is a cached formula result, and the decoder
 *    never uses one.
 *  - a `<f>` element → REFUSED. Formulas are not executed and never guessed.
 *  - `t="b"` or `t="e"` → REFUSED. A boolean or an error is not a student
 *    value, and rendering it would be a guess.
 *
 * Dates and styles are unsupported rather than guessed: a date is an ordinary
 * number in the file, and without interpreting `styles.xml` the decoder cannot
 * know, so it surfaces the raw number instead of inventing a calendar date.
 */
const readWorksheet = (bytes: Uint8Array, sharedStrings: readonly string[]): DecodedSheet => {
  const scanner = scanPart(bytes);
  const rows: DecodedRow[] = [];

  /** Physical row count, blank rows included: the row bound is on ROWS. */
  let rowCount = 0;
  let currentRow: { rowNumber: number; cells: DecodedCell[]; occupied: Set<number> } | null = null;

  // --- the cell currently being read --------------------------------------
  let cellColumn: number | null = null;
  let cellType = 'n';
  let cellValue = '';
  let cellHasFormula = false;
  let cellHasValue = false;
  let cellInlineDepth = 0;
  let insideValue = false;
  let insidePhonetic = false;
  let insideSheetData = false;

  const finishCell = (): void => {
    if (cellColumn === null) return;
    if (cellHasFormula) refuseArchive('formula-cell');
    if (cellType === 'str') refuseArchive('formula-cell');
    if (cellType === 'b' || cellType === 'e') refuseArchive('unsupported-cell-type');

    let value: string;
    if (!cellHasValue && cellInlineDepth === 0) {
      // A present but empty cell: it occupies its column and contributes an
      // empty value, exactly as an absent cell would.
      value = '';
    } else if (cellType === 's') {
      const trimmed = cellValue.trim();
      const index = Number(trimmed);
      if (trimmed === '' || !Number.isInteger(index) || index < 0) refuseArchive('malformed-xml');
      const shared = sharedStrings[index];
      if (shared === undefined) refuseArchive('malformed-xml');
      value = shared;
    } else {
      // Numeric: the XML lexical text is the value, taken exactly as the
      // workbook wrote it, so `007` survives only when it was stored as text.
      value = cellValue;
    }

    if (value.length > STUDENT_CSV_MAX_CELL_CHARS) {
      refuseArchive('cell-too-long', String(STUDENT_CSV_MAX_CELL_CHARS));
    }
    if (currentRow !== null && !currentRow.occupied.has(cellColumn)) {
      currentRow.cells.push({ column: cellColumn, value });
      currentRow.occupied.add(cellColumn);
    }

    cellColumn = null;
    cellType = 'n';
    cellValue = '';
    cellHasFormula = false;
    cellHasValue = false;
    cellInlineDepth = 0;
  };

  const finishRow = (): void => {
    if (currentRow === null) return;
    // A row that carries no cell at all is a blank row: the spreadsheet
    // equivalent of a blank CSV line. Skipping it keeps the physical row
    // numbers of the records that follow it pointing at real rows.
    if (currentRow.cells.length > 0) {
      currentRow.cells.sort((left, right) => left.column - right.column);
      rows.push({ rowNumber: currentRow.rowNumber, cells: currentRow.cells });
    }
    currentRow = null;
  };

  for (let token = scanner.next(); token !== null; token = scanner.next()) {
    if (token.kind === 'text') {
      if (cellColumn !== null && (insideValue || cellInlineDepth > 0) && !insidePhonetic) {
        cellValue += token.value;
      }
      continue;
    }
    if (token.kind === 'open') {
      const name = token.name;
      const closes = token.selfClosing;

      if (name === 'sheetData') {
        finishRow();
        insideSheetData = !closes;
        continue;
      }
      if (!insideSheetData) continue;

      if (name === 'row') {
        // A new row always closes the previous one.
        finishRow();
        rowCount += 1;
        if (rowCount > STUDENT_XLSX_MAX_ROWS) {
          refuseArchive('too-many-records', String(STUDENT_CSV_MAX_RECORDS));
        }
        const declared = token.attrs.get('r');
        let rowNumber: number;
        if (declared === undefined || declared === '') {
          // A row without a reference is numbered by its position.
          rowNumber = rowCount;
        } else {
          const parsed = Number(declared);
          if (!Number.isInteger(parsed) || parsed < 1) refuseArchive('malformed-xml');
          rowNumber = parsed;
        }
        if (rowNumber > STUDENT_XLSX_MAX_ROWS) {
          refuseArchive('too-many-records', String(STUDENT_CSV_MAX_RECORDS));
        }
        if (closes) continue;
        currentRow = { rowNumber, cells: [], occupied: new Set<number>() };
        continue;
      }

      if (name === 'c') {
        finishCell();
        if (currentRow === null) refuseArchive('malformed-xml');
        const reference = token.attrs.get('r');
        let column: number;
        if (reference === undefined || reference === '') {
          // A cell with no reference takes the next free column of the row.
          column = currentRow.cells.length + 1;
        } else {
          const split = splitCellReference(reference);
          if (split === null) refuseArchive('malformed-xml');
          column = split.column;
          if (split.row !== currentRow.rowNumber) refuseArchive('malformed-xml');
        }
        cellColumn = column;
        cellType = token.attrs.get('t') ?? 'n';
        if (closes) finishCell();
        continue;
      }

      if (cellColumn === null) continue;

      if (name === 'f') {
        cellHasFormula = true;
        continue;
      }
      if (name === 'v') {
        insideValue = !closes;
        if (closes) cellHasValue = true;
        continue;
      }
      if (name === 'is') {
        // An inline string element is content even when it is empty, so the
        // cell is never mistaken for a present-but-empty one.
        cellHasValue = true;
        cellInlineDepth += 1;
        if (closes) cellInlineDepth -= 1;
        continue;
      }
      if (name === 'rPh' || name === 'phoneticPr') {
        insidePhonetic = true;
        continue;
      }
      continue;
    }

    // --- closing tag -------------------------------------------------------
    const name = token.name;
    if (name === 'sheetData') {
      finishRow();
      finishCell();
      insideSheetData = false;
      continue;
    }
    if (name === 'row') {
      finishRow();
      continue;
    }
    if (name === 'c') {
      finishCell();
      continue;
    }
    if (name === 'v') {
      insideValue = false;
      cellHasValue = true;
      continue;
    }
    if (name === 'is' && cellInlineDepth > 0) cellInlineDepth -= 1;
    if (name === 'rPh' || name === 'phoneticPr') insidePhonetic = false;
  }

  finishRow();
  if (insideSheetData) refuseArchive('malformed-xml');
  return { rows };
};

// ---------------------------------------------------------------------------
// Grid → canonical records, and the entry points
// ---------------------------------------------------------------------------

/**
 * Turns the decoded grid into the container-neutral records the canonical row
 * builder consumes.
 *
 * The header record keeps its own width, so a workbook with more than six
 * header columns is refused exactly as a CSV file with seven columns is. A
 * data record narrower than the header is PADDED with empty strings: an
 * absent trailing cell is an empty cell, not a ragged record. A data record
 * WIDER than the header keeps its width, so the canonical builder refuses it
 * as a ragged record — again exactly as the CSV path does.
 */
const buildRecordsFromSheet = (sheet: DecodedSheet): StudentCsvSourceRecord[] => {
  const records: StudentCsvSourceRecord[] = [];
  let headerWidth = 0;
  for (const row of sheet.rows) {
    const fields: string[] = [];
    for (const cell of row.cells) {
      while (fields.length < cell.column - 1) fields.push('');
      fields[cell.column - 1] = cell.value;
    }
    if (records.length === 0) {
      if (fields.length > STUDENT_CSV_MAX_COLUMNS) {
        refuseArchive('too-many-columns', String(STUDENT_CSV_MAX_COLUMNS));
      }
      headerWidth = fields.length;
      records.push({ line: row.rowNumber, fields });
      continue;
    }
    while (fields.length < headerWidth) fields.push('');
    records.push({ line: row.rowNumber, fields });
  }
  return records;
};

/**
 * Decodes a bounded local `.xlsx` workbook into the canonical preview rows.
 *
 * The order of the guards is the whole point of the module: the container is
 * audited before anything is inflated, only the parts that are actually read
 * are inflated, and every malformed construct fails closed.
 */
export function parseStudentXlsx(bytes: Uint8Array): StudentCsvParseResult {
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, error: { code: 'unsupported-format', line: null, detail: null } };
  }
  try {
    // --- 1. the container --------------------------------------------------
    // A modern `.xlsx` is a ZIP archive. An OLE2 compound file carrying the
    // `.xlsx` name is an encrypted workbook: the legacy containers were
    // already refused by extension, so this is the only possibility left.
    if (hasOle2Magic(bytes)) refuseArchive('password-protected');
    if (!hasZipMagic(bytes)) refuseArchive('unreadable-archive');

    // --- 2. audit the archive with inflation switched OFF ------------------
    const declarations = auditZipEntries(bytes);

    // --- 3. the workbook and its relationships -----------------------------
    const coreParts = inflateParts(bytes, [WORKBOOK_PART, WORKBOOK_RELS_PART]);
    const workbookPart = coreParts.get(WORKBOOK_PART);
    if (workbookPart === undefined) refuseArchive('missing-workbook-part');
    const firstSheet = readWorkbook(workbookPart);
    const relsPart = coreParts.get(WORKBOOK_RELS_PART);
    const relationships =
      relsPart === undefined
        ? new Map<string, { target: string; type: string }>()
        : readWorkbookRelationships(relsPart);
    const worksheetPath = resolveWorksheetPart(firstSheet.relationshipId, relationships, declarations);

    // --- 4. the shared string table and the first worksheet ----------------
    const wanted: string[] = [worksheetPath];
    if (declarations.some((entry) => canonicalZipPath(entry.name) === SHARED_STRINGS_PART)) {
      wanted.push(SHARED_STRINGS_PART);
    }
    const dataParts = inflateParts(bytes, wanted);
    const sharedPart = dataParts.get(SHARED_STRINGS_PART);
    const sharedStrings = sharedPart === undefined ? [] : readSharedStrings(sharedPart);
    const worksheetPart = dataParts.get(worksheetPath);
    if (worksheetPart === undefined) refuseArchive('missing-worksheet');
    const sheet = readWorksheet(worksheetPart, sharedStrings);

    // --- 5. the canonical rows ---------------------------------------------
    return buildStudentPreviewFromRecords(buildRecordsFromSheet(sheet));
  } catch (error) {
    // Every refusal raised inside this module is a truthful file-level
    // diagnostic. A scanner that ran out of input, met a mismatched closing
    // tag or an unknown entity is a MALFORMED part, not an unreadable
    // archive, so it is reported as exactly that. Anything else that escaped
    // is an archive the decoder could not read, which is what
    // `unreadable-archive` means.
    if (error instanceof ArchiveRefusal) return { ok: false, error: error.refusal };
    if (error instanceof MalformedXml) {
      return { ok: false, error: { code: 'malformed-xml', line: null, detail: null } };
    }
    return { ok: false, error: { code: 'unreadable-archive', line: null, detail: null } };
  }
}

/**
 * M2-17: the dual-format dispatch used by the preview controller.
 *
 * A spreadsheet name is routed to the XLSX decoder, which refuses every
 * extension other than `.xlsx` itself — so a legacy `.xls` or a macro
 * `.xlsm` never falls through to the CSV parser and is never mistaken for a
 * comma separated file. Everything else is a CSV file, and a CSV file that
 * arrived as raw bytes is refused rather than guessed at.
 */
export function parseStudentPreviewFile(
  name: string,
  data: string | Uint8Array,
): StudentCsvParseResult {
  const fileName = typeof name === 'string' ? name : '';
  if (isStudentSpreadsheetFileName(fileName)) {
    if (!isStudentXlsxFileName(fileName)) {
      return { ok: false, error: { code: 'unsupported-format', line: null, detail: null } };
    }
    if (!(data instanceof Uint8Array)) {
      return { ok: false, error: { code: 'read-failed', line: null, detail: null } };
    }
    return parseStudentXlsx(data);
  }
  if (typeof data !== 'string') {
    return { ok: false, error: { code: 'read-failed', line: null, detail: null } };
  }
  return parseStudentCsv(data);
}
