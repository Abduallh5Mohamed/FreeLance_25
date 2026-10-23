/**
 * M2-11 — the LOCAL rejected/excluded-row JSON report.
 *
 * Scope (human180/152 delegation, `docs/streams/client/M2-11-HANDOFF.md`): turn
 * the current LOCAL decision set into ONE user-triggered JSON document that
 * lists every row that is NOT included, so the operator can fix the source file
 * and try again.
 *
 * What this module is NOT:
 *  - it is not an import: nothing is sent, committed, persisted or audited, and
 *    the report is never a claim that an import succeeded or that a value is
 *    unique in the platform;
 *  - it is not a spreadsheet: the payload is JSON only. No CSV/XLSX writer
 *    exists here, and no cell is ever handed to a spreadsheet engine, so a
 *    value such as `=cmd|'/C calc'!A0` stays inert text;
 *  - it does not evaluate or execute anything, and it never inserts raw HTML:
 *    every value is serialized by `JSON.stringify`, which escapes it;
 *  - it does not convert, validate or normalize a field: the exact permitted
 *    text from the parsed file is copied verbatim.
 *
 * Bounds: the accepted parser caps a file at 1000 records and 4096 characters
 * per cell, so the report is derived from at most ~24 MiB of raw text before
 * JSON escaping. The output cap below is therefore enforced on the SERIALIZED
 * text and BEFORE any Blob or object URL is created, so a hostile file cannot
 * allocate an unbounded document.
 *
 * Resource lifecycle: one click produces at most ONE Blob, ONE object URL and
 * ONE link. The link is removed in a STRUCTURED `finally`, so it is removed
 * exactly once even when the creation, the configuration or the click itself
 * failed, and the URL is revoked on the next scheduled tick (so the browser can
 * start the download), on every failure, on replacement by a newer click, on
 * every lifecycle retirement (a replaced file, a reset, a close, a lost
 * principal or a lost session) and on disposal — never leaked, and a URL is
 * revoked AT MOST ONCE.
 */
import type {
  ImportResolutionCounts,
  ImportResolutionRow,
  ImportResolutionState,
  ServerMatchReview,
} from './import-resolution';
import { currentServerMatchReview } from './import-resolution';
import type { StudentCsvDuplicateColumn } from './csv-preview';

/**
 * The documented payload version.
 *
 * Version 2 adds the M2-15 combined warning: a row excluded because of a
 * confirmed existing-value match now carries the documented reason
 * `existing-value-match` and the exact matched FIELD NAMES. The version is
 * bumped because the row shape and the reason vocabulary changed, so a v1
 * consumer never silently reads a v2 document.
 */
export const IMPORT_REPORT_VERSION = 2;

/** The documented payload discriminator. */
export const IMPORT_REPORT_KIND = 'student-import-rejected-rows';

/**
 * The output bound, in UTF-8 bytes, applied to the SERIALIZED document.
 *
 * Derived from the accepted input bound: 1 MiB of CSV can expand under JSON
 * escaping (a quote or a backslash becomes two characters, a control character
 * becomes six), so 16 MiB leaves room for the worst realistic expansion of a
 * bounded 1000-record file while still refusing an absurd document.
 */
export const IMPORT_REPORT_MAX_BYTES = 16 * 1024 * 1024;

/** A generic filename: it never carries the original name or any row value. */
export const IMPORT_REPORT_FILENAME = 'student-import-rejected-rows.json';

/** The statuses the report carries: exactly the NON-INCLUDED rows. */
export const IMPORT_REPORT_STATUSES = ['invalid', 'excluded', 'pending'] as const;

export type ImportReportStatus = (typeof IMPORT_REPORT_STATUSES)[number];

export interface ImportReportCandidate {
  readonly field: StudentCsvDuplicateColumn;
  readonly value: string;
  /** Every physical row of this file that carries the exact value. */
  readonly rowNumbers: readonly number[];
}

export interface ImportReportRow {
  /** The physical line the record starts on: the stable row reference. */
  readonly rowNumber: number;
  readonly status: ImportReportStatus;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly guardian_phone: string;
  readonly grade: string;
  readonly barcode: string;
  /** The documented local reasons this row is not included. */
  readonly reasons: readonly string[];
  /**
   * M2-15 — the exact matched FIELD NAMES of the confirmed reconciliation that
   * made this row excluded, in their documented order, or `[]`.
   *
   * These are names only. No stored value, record id, person name or count of
   * existing records is ever written here, and a review from a superseded
   * reconciliation is never trusted (see `currentServerMatchReview`).
   */
  readonly matched_fields: readonly string[];
  /** The within-file candidates that made the row non-includable or pending. */
  readonly candidates: readonly ImportReportCandidate[];
}

export interface ImportReportPayload {
  readonly report: typeof IMPORT_REPORT_KIND;
  readonly version: number;
  /** The report is a LOCAL preview artefact, never a server result. */
  readonly scope: 'local-preview';
  readonly counts: ImportResolutionCounts;
  readonly rows: readonly ImportReportRow[];
}

export type ImportReportBuildFailure = 'not-loaded' | 'empty' | 'too-large';

export type ImportReportBuildResult =
  | {
      readonly ok: true;
      readonly payload: ImportReportPayload;
      readonly text: string;
      readonly bytes: number;
      readonly rowCount: number;
    }
  | { readonly ok: false; readonly reason: ImportReportBuildFailure; readonly bytes: number };

/**
 * The exact UTF-8 byte length of a string, without allocating the encoded
 * buffer. The size gate must run BEFORE the Blob exists, so the encoded length
 * cannot be measured by encoding the text.
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
 * The documented local reasons of one non-included row, in a FIXED order.
 *
 * A reason is a statement about THIS local preview only. It is never a server
 * validation result and never a statement about an existing record — the M2-15
 * `existing-value-match` reason says only that a value already exists in the
 * tenant, which is a warning the user read, not an identity claim.
 */
const reasonsOf = (row: ImportResolutionRow, review: ServerMatchReview | null): string[] => {
  if (row.status === 'invalid') {
    const reasons: string[] = [];
    for (const issue of row.issues) {
      // The accepted parser's only row issue is a missing required name.
      if (issue.code === 'missing-name') reasons.push('missing-name');
    }
    // A structurally invalid row always carries at least one reason.
    if (reasons.length === 0) reasons.push('invalid-row');
    return reasons;
  }
  if (row.status === 'pending') {
    return ['duplicate-candidate-pending'];
  }
  // excluded
  const reasons = ['excluded-by-user'];
  if (row.duplicates.length > 0) reasons.push('duplicate-candidate');
  // The user excluded this row FROM a confirmed existing-value match: the
  // server-derived warning is part of WHY it is excluded.
  if (review !== null && review.review === 'excluded') reasons.push('existing-value-match');
  return reasons;
};

const candidatesOf = (row: ImportResolutionRow): ImportReportCandidate[] =>
  row.duplicates.map((candidate) => ({
    field: candidate.field,
    value: candidate.value,
    rowNumbers: candidate.rowNumbers.slice(),
  }));

/**
 * Builds the JSON document of the CURRENT decision set.
 *
 * Only NON-INCLUDED rows are carried, so an included row's private values can
 * never be exported by accident. Rows are ordered by physical line and the
 * object keys are written in a fixed order, so the same decisions always
 * produce byte-identical output.
 */
export function buildImportReport(state: ImportResolutionState): ImportReportBuildResult {
  if (!state.loaded) return { ok: false, reason: 'not-loaded', bytes: 0 };
  const rows: ImportReportRow[] = [];
  for (const row of state.rows) {
    if (row.status === 'included') continue;
    // Only a review from the CURRENT confirmed reconciliation is trusted, so a
    // superseded result can never leak its matched field names into a report.
    const review = currentServerMatchReview(state, row.rowNumber);
    rows.push({
      rowNumber: row.rowNumber,
      status: row.status,
      name: row.name,
      email: row.email,
      phone: row.phone,
      guardian_phone: row.guardian_phone,
      grade: row.grade,
      barcode: row.barcode,
      reasons: reasonsOf(row, review),
      matched_fields: review !== null && review.review === 'excluded' ? [...review.matched_fields] : [],
      candidates: candidatesOf(row),
    });
  }
  if (rows.length === 0) return { ok: false, reason: 'empty', bytes: 0 };
  // Deterministic order even if a caller hands over an unordered projection.
  rows.sort((left, right) => left.rowNumber - right.rowNumber);

  const payload: ImportReportPayload = {
    report: IMPORT_REPORT_KIND,
    version: IMPORT_REPORT_VERSION,
    scope: 'local-preview',
    counts: { ...state.counts },
    rows,
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const bytes = utf8ByteLength(text);
  // The cap is enforced BEFORE the Blob and before any object URL exists.
  if (bytes > IMPORT_REPORT_MAX_BYTES) return { ok: false, reason: 'too-large', bytes };
  return { ok: true, payload, text, bytes, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// The browser boundary and its resource lifecycle
// ---------------------------------------------------------------------------

/**
 * The minimal anchor the report needs. It is injected so the seam never
 * touches a real document, a real download or a real browser in a test.
 */
export interface ImportReportLink {
  href: string;
  download: string;
  rel: string;
  click(): void;
  remove(): void;
}

/**
 * The injected browser boundary. `schedule` is the deferred revocation step:
 * the URL must outlive the click for the browser to start the download, and it
 * must not outlive the panel.
 */
export interface ImportReportEnvironment {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  createLink: () => ImportReportLink;
  schedule: (task: () => void) => void;
}

export type ImportReportFailure = ImportReportBuildFailure | 'failed';

export type ImportReportResult =
  | {
      readonly ok: true;
      readonly url: string;
      readonly filename: string;
      readonly bytes: number;
      readonly rowCount: number;
    }
  | { readonly ok: false; readonly reason: ImportReportFailure; readonly bytes: number };

export interface ImportReportController {
  /** Materializes and hands over ONE report for the CURRENT decision set. */
  download(state: ImportResolutionState): ImportReportResult;
  /** The URL still awaiting revocation, or null. Diagnostics only. */
  liveUrl(): string | null;
  /**
   * Retires the outstanding URL IMMEDIATELY, without disposing the controller.
   *
   * A replaced file, a reset, a close, a lost principal or a lost session must
   * not leave a downloadable copy of the former scope's rows alive. The
   * controller stays usable afterwards: a later valid click may still produce
   * a new report.
   */
  retire(): void;
  dispose(): void;
}

/**
 * Creates the report lifecycle for ONE mounted panel.
 *
 * Every call first revokes the URL of a previous click, so two rapid clicks can
 * never leave two live URLs behind, and `dispose` revokes the last one. A URL is
 * revoked at most once, and only while it is still the live one.
 */
export function createImportReportController(
  environment: ImportReportEnvironment,
): ImportReportController {
  let live: string | null = null;
  let disposed = false;

  /**
   * Revokes ONE url, at most once.
   *
   * The reference is dropped first, so a second attempt on the same URL is a
   * no-op even when the revocation itself threw: a failed revocation leaves
   * nothing to retry, because the reference is already gone.
   */
  const revokeUrl = (url: string): void => {
    try {
      environment.revokeObjectURL(url);
    } catch {
      // A revocation that throws leaves nothing to retry: the reference is
      // already dropped, so no further state can be leaked.
    }
  };

  const revokeLive = (): void => {
    if (live === null) return;
    const url = live;
    live = null;
    revokeUrl(url);
  };

  return {
    download: (state) => {
      if (disposed) return { ok: false, reason: 'failed', bytes: 0 };
      // A newer click replaces the previous artefact: the old URL dies first.
      revokeLive();

      const built = buildImportReport(state);
      // `in` narrowing is used instead of a boolean discriminant because this
      // project compiles with `strict: false`, where `ok: true | false` widens
      // to `boolean` and the union stops being discriminated.
      if ('reason' in built) return { ok: false, reason: built.reason, bytes: built.bytes };

      let url: string | null = null;
      let link: ImportReportLink | null = null;
      // True when the scheduled revocation already released THIS call's URL.
      // A scheduled step may run synchronously, so the release has to be
      // observable: a URL is never revoked twice.
      let released = false;
      // True only when the whole materialization succeeded, i.e. when the URL
      // became the live one and the scheduled revocation took ownership of it.
      let succeeded = false;
      try {
        const blob = new Blob([built.text], { type: 'application/json' });
        url = environment.createObjectURL(blob);
        link = environment.createLink();
        link.href = url;
        link.download = IMPORT_REPORT_FILENAME;
        link.rel = 'noopener';
        link.click();
        const created = url;
        // The URL becomes the live one BEFORE the revocation is scheduled, so
        // a step that runs synchronously still finds the URL it owns.
        live = created;
        // The URL stays valid for one tick so the browser can start the
        // download, then it is revoked. Nothing outlives the panel.
        environment.schedule(() => {
          if (live !== created) return;
          released = true;
          revokeLive();
        });
        succeeded = true;
        return {
          ok: true,
          url: created,
          filename: IMPORT_REPORT_FILENAME,
          bytes: built.bytes,
          rowCount: built.rowCount,
        };
      } catch {
        // A failed materialization must not leave a URL behind.
        return { ok: false, reason: 'failed', bytes: built.bytes };
      } finally {
        // The URL is retired FIRST, so a link that cannot be removed can never
        // keep an object URL alive. A succeeded download keeps its URL for the
        // scheduled tick; a failed one is revoked here, exactly once.
        if (!succeeded && url !== null && !released) {
          if (live === url) live = null;
          revokeUrl(url);
        }
        // The link is removed exactly once, whatever failed above.
        if (link !== null) {
          try {
            link.remove();
          } catch {
            // A link that cannot be detached is the browser's problem: it was
            // never attached to the document in the first place.
          }
        }
      }
    },
    liveUrl: () => live,
    retire: () => {
      // The outstanding URL dies immediately, but the controller stays usable.
      revokeLive();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      revokeLive();
    },
  };
}
