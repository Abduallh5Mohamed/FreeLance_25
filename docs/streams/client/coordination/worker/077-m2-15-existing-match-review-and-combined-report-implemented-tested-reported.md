# 077 — M2-15 existing-match review + combined local report: implemented, tested, reported

Task: `client-m2-15-existing-match-review-report-20261021-01`
Lane: WorkBuddy native implementation worker (manual human copy/paste, per supervisor208)
Claim: `workerId workbuddy-native-m2-15-match-review-20261021`, team `frontend`
MCP report: submitted, `awaiting_supervisor`. **Not an acceptance.**

## Scope

The claim returned exactly the seven M2-15 handoff paths and they matched before
any edit. Only those seven were touched.

| Path | Change |
|---|---|
| `src/features/students/import-resolution.ts` | additive review model + five controller methods |
| `src/features/students/import-report.ts` | additive `existing-value-match` + `matched_fields`; version 1 → 2 |
| `src/features/students/StudentImportPreview.tsx` | additive review block + three per-row review controls |
| `src/features/students/server-resolution.ts` | **not modified** (read only) |
| `src/tests/m2-student-import-resolution.test.ts` | 71 → 77 tests |
| `src/tests/m2-student-import-server-resolution.test.ts` | 63 → 71 tests |
| `docs/streams/client/M2-15-CONTRACTS.md` | new |

No api-http, backend, router, schema, migration, auth, shared, package or config
change.

## What changed

**Review model.** `ServerMatchReviewState = 'pending' | 'kept' | 'excluded'` with
`ServerMatchReview { matched_fields, review, generation }` and
`ServerMatchCounts`. State gained `serverMatches`, `serverMatchCounts`,
`serverMatchGeneration`, `serverMatchSource`.

- `seedServerMatches` is the only way a review appears. It accepts only the
  current confirmed result, replaces the whole previous set atomically, and is a
  **no-op for the same result object** so a re-render never resets a user
  decision.
- Seeding **never changes a decision**: a matched included row keeps `included`
  and gains `review: 'pending'`. A result for an unknown, pending, excluded or
  invalid row is ignored, never invented.
- `keepServerMatch` requires the row to be `included`, so the model cannot hold
  the contradictory pair `kept` + `excluded`. `excludeServerMatch` is the only
  match → decision path and is always explicit. `undoServerMatch` returns the
  review to `pending` and re-includes a row it excluded.
- `currentServerMatchReview` returns `null` for an entry of a superseded
  generation, so a stale answer can neither paint a warning nor reach a report.
- `include()` / `exclude()` run `clearServerMatches` **before** the plain
  decision, so a within-file decision never coexists with a review set computed
  against a different inclusion set.

**Undo safety (why no conflict check is needed).** While a review set exists the
only decision changes available are keep (no change) and exclude (removal); any
plain decision retires the whole set first. So no other row can have been
included since the row was excluded, and re-including it cannot create a new
within-file conflict. Recorded in the contract.

**Report v2.** `IMPORT_REPORT_VERSION = 2`, `ImportReportRow.matched_fields`
(names only), and the documented reason `existing-value-match` appended only for
a row excluded by its **current** review. Every accepted M2-11 rule is preserved
verbatim: only non-included rows, fixed key order, byte-identical output for the
same decisions, size gate on the serialized text before any Blob, one object URL
and one link per click, revocation at most once, inert formula-looking text.

**UI.** A separate indigo block with its own heading and its own
pending/kept/excluded counts (stated exclusive and summing to the set size),
deliberately distinct from the slate local within-file conflict block. Three
explicit `type="button"` per-row controls — `إبقاء مُدرجًا`,
`استبعاد بسبب التطابق`, `تراجع` — keyed by physical row number, so a decision
taken on page 1 is the same decision on page 9. Keep/exclude are enabled only
while `pending`; undo only when not `pending`. Seeding lives in a `useEffect`
keyed on the server phase/result. No automatic request, no automatic download.

## Verification

```
npx tsx --test src/tests/m2-student-csv-preview.test.ts \
               src/tests/m2-student-import-resolution.test.ts \
               src/tests/m2-student-import-server-resolution.test.ts
→ 199 tests, 199 pass, 0 fail
```

The 51-test accepted `m2-student-csv-preview` suite is **unchanged** and green.

```
npx tsc --noEmit -p tsconfig.app.json
→ 11 diagnostics, all pre-existing and outside this batch
```

Known outside set: `NotificationBell.tsx`, `StudentHeader_OLD_BACKUP.tsx` (×2),
`ExamReports.tsx` (×2), `ExamResults.tsx`, `Fees.tsx` (×2),
`StudentBarcodes.tsx`, `StudentDashboard.tsx`, `versionChecker.ts`. **Zero**
diagnostics in the four feature files or either owned suite.

Coverage added: multi-field matches and documented field order, matches across
pages, keep/exclude/undo/reset, local-conflict interaction, new-reconciliation
replacement, malformed/failure holding no result, reversed completion order,
file/principal/session/close/dispose retirement, report exact rows/reasons/field
order/names-only/determinism/stale exclusion, bounded map, zero storage and zero
console, and that review actions issue no request.

One pre-existing assertion was legitimately extended: the fixed report row key
list now includes `matched_fields`, because the documented row shape grew in v2.

## Constraints honoured

No DB, network, browser, service, install, migration, deploy or Git write. No
branch switch. Pre-existing dirty files (`server/src/routes/tenant-self.ts`,
`src/lib/api-http.ts`, the seven `src/pages` files) and the untracked
`src/features` tree are untouched.

## Limits

Real browser download behaviour, DOM paint and RTL layout are not exercised
(injected boundaries only). No import commit path exists in this batch. No
platform uniqueness and no existing-record identity is claimed, requested or
stored.

## Open questions for the supervisor

1. Should a **malformed or failed** reconciliation retire the last confirmed
   review set, or preserve it? Implemented retirement, because the server seam
   drops the result to `null` on both outcomes and the handoff says a new
   reconciliation retires the old review/result.
2. Confirm that **keeping** a review must not retire an already-materialized
   report URL: keeping changes no decision and no `matched_fields`, so the report
   content is unchanged. Only exclude/undo and the plain decisions retire it.

No self-acceptance, no next task, no schedule change.
