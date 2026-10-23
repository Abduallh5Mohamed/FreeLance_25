# 076 — M2-13 canonical-name correction: implemented, tested, reported

**Task:** `client-m2-13-canonical-name-correction-20261021-01` (team `integration`,
`taskKind: correction`, approvalVersion 2).
**Worker:** `opencode-native-m2-13-canonical-name-20261021`.
**Branch:** `codex/human-client`. **Status:** implemented, tested, **reported** —
**this is not acceptance**; Codex independently reviews.

## Before → after

Before: the server's stored-row projection (`academicPeriodDto`) validated
`name.trim()` but returned the ORIGINAL stored string, and the client parser
(`parseAcademicPeriod`) validated the trimmed value but returned the ORIGINAL
transported string. A stored/transported name such as `"  October  "` was
therefore emitted and confirmed although every write path canonicalizes names.

After: a stored name that is not already canonical is **refused** by the server
read projection, and a transported name that is not already canonical is
**refused** by the client parser. Neither is emitted raw and neither is
normalized into a confirmed DTO. The request side is unchanged: the name the
user typed is still trimmed before it is sent, exactly as the server trims it.

## Paths changed (exactly the six allowedPaths)

| Path | Change |
|---|---|
| `server/src/routes/academic-periods.ts` | `academicPeriodDto` now refuses a stored name that is not exactly its own trimmed form (`name !== name.trim()` → no DTO) |
| `server/tests/m2-academic-periods.test.ts` | +4 regressions (91 → 95) |
| `src/features/tenant/academic-periods.ts` | `parseAcademicPeriod` now refuses a transported name that is not exactly its own trimmed form; the confirmed DTO copies the proven-canonical name |
| `src/tests/m2-academic-periods-ui.test.ts` | +9 regressions (104 → 113) |
| `docs/streams/server/M2-B07-CONTRACT.md` | new §7a "The stored name is canonical or the row is refused"; §5, §8 and §10 updated |
| `docs/streams/client/M2-13-CONTRACTS.md` | §3 (canonical transported name + the request/confirm asymmetry), §6 (two new outcome rows), §8 updated |

Not touched: `server/src/routes/tenant-self.ts`, the migration FILE, the
dashboard mount, `AcademicPeriodsCard.tsx`, `src/lib/api-http.ts`, the harness,
`server/tests/m2-academic-periods-failures.test.ts`, the branding paths, the
CSV/student-import sources, any shared/auth/router/index/provider/package
/config file, and any schedule.

## Behaviour

**Server** (`server/src/routes/academic-periods.ts:213`): the DTO projection
refuses a stored name whose trimmed form differs from the stored string, so the
row yields NO DTO. The consequence is identical to an unreadable epoch or
impossible date, and no existing rule was changed:

* `GET` list — the page fails with `500 {error:'Failed to list academic periods'}`
  and **no partial page**; the non-canonical name never appears in the body;
* `PATCH` — the locked read of the current row is refused before any write, so
  there is no `UPDATE`, no audit event, no commit, and the stored row is left
  exactly as it was;
* `POST` — unchanged and still trims: a request name `"  October  "` is stored
  and confirmed as `"October"`, and the read-back is compared with that trimmed
  value.

A non-canonical stored row is deliberately **not** repairable through this API:
the merged effective values of a `PATCH` must be read from a row the module can
describe truthfully, and it never writes a normalized name over a stored one.
This mirrors the accepted behaviour for a stored impossible date.

**Client** (`src/features/tenant/academic-periods.ts:344`): `parseAcademicPeriod`
refuses a transported name that is not exactly its own trimmed form, so:

* one non-canonical row fails the **whole** page — no partial render;
* a read that carries a non-canonical name is the `malformed` phase with no
  rows rendered and no confirmed period;
* a write that CONFIRMS with a non-canonical name is `uncertain` — the draft is
  preserved, nothing is applied, `lastConfirmed` stays `null`, nothing is
  retried;
* the REQUEST side is untouched: `buildAcademicPeriodCreate` /
  `buildAcademicPeriodPatch` still trim the typed name, and a whitespace-only
  name difference is still not a change (no request is issued).

Canonical means "exactly its own trimmed form" — it is NOT a rule about internal
spacing, which stays a legitimate free label.

## Commands and results

| Command | Result |
| --- | --- |
| `npx tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/207-m2-13-canonical-name-probes.test.ts` | **2 pass / 0 fail** (baseline before the edit: 1 pass / 1 fail) |
| `cd server && npx tsx --test tests/m2-academic-periods.test.ts tests/m2-academic-periods-failures.test.ts` | 127 pass / 0 fail (95 + 32) |
| `cd server && npx tsx --test` on the 8 unchanged accepted suites | 324 pass / 0 fail (unchanged) |
| `cd server && npx tsc --noEmit` | 0 diagnostics |
| `npx tsx --test src/tests/m2-academic-periods-ui.test.ts` | 113 pass / 0 fail |
| `npx tsx --test` on the 6 accepted nearby client suites | 330 pass / 0 fail (unchanged) |
| `npx tsx --test` on the 3 accepted CSV suites | 173 pass / 0 fail (unchanged) |
| `npx tsx --test src/tests/m2-tenant-branding-ui.test.ts` | 89 pass / 0 fail (unchanged nearby set) |
| `npx tsc --noEmit -p tsconfig.app.json` | 0 scoped diagnostics; the same 11 pre-existing errors outside scope |

New tests: **13** (4 server + 9 client).

The repository-root `tsconfig.json` has `"files": []` and no `include`, so the
real frontend check is `npx tsc --noEmit -p tsconfig.app.json`. The 11 outside
errors are unchanged and in files this correction does not touch:
`NotificationBell` 1, `StudentHeader_OLD_BACKUP` 2, `ExamReports` 2,
`ExamResults` 1, `Fees` 2, `StudentBarcodes` 1, `StudentDashboard` 1,
`versionChecker` 1.

## Evidence limits

* The public immutable probe is the independent before/after evidence for the
  client half: it was observed **failing** (1/2) on the unmodified source and
  **passing** (2/2) after the edit. No source mutation was used to re-prove the
  pre-fix failure, per the standing no-TEMP-mutation rule.
* The server half has no public probe. The pre-fix behaviour is the one
  supervisor207 documented by source review (the raw stored string was
  returned). The new server tests assert the inverse behaviour on the real
  production route through the real composition, so they are non-vacuous by
  construction — but this correction did not independently re-observe the
  pre-fix server failure.
* No live MySQL, no real concurrency, no row-lock contention, no HTTP, no
  listener, no socket, no browser and no app startup. The fixture models the
  statements and the transaction replay only.
* The migration FILE `server/migrations/20261021_03_academic_periods.sql` is
  still **NOT applied**; nothing was executed against a database.
* No performance, scalability or latency claim, and no whole-C8/M2/C2
  completion claim. No enrollment, access, billing, audit-schema, provider or
  runtime-policy change.
* No Git write, no install, no npx fetch, no lint, no deploy, no schedule
  change, no credentials, no account change. All uncommitted work (including
  the accepted M2-12 branding correction and the M2-13 batch) is preserved.

## Open questions for the reviewer

1. Should a non-canonical stored row become repairable through `PATCH` (a
   dedicated repair that reads the raw row without the DTO)? That needs an
   approved contract; this correction keeps the accepted "refuse what cannot be
   described truthfully" rule instead.
2. Should the client distinguish a non-canonical name from any other malformed
   body in its user-facing wording? It currently shares the documented
   malformed-response message; no new wording was invented here.
3. The 207 probe file was readable for EXECUTION but denied for direct reading
   by the current tool permission set, so its assertions were not inspected
   here; the failure was observed and the pass observed, which is the evidence
   this report claims.

Codex independently reviews source, architecture, contracts, tests and bounds.
This note is **not** acceptance.
