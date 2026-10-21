# T3 schedules/attendance bounds + correction metadata — 2026-10-20

Task: OPENCODE-EXECUTION-PLAN-20261020.md T3, narrowed by OPENCODE-SCOPE-CONFIRMATION-20261020.md.
All work hermetic (injected deps, scripted SQL adapter), no DB/Docker/network/git mutations, no dependency changes.
Baseline = the mixed working tree as found (prior agents' edits preserved untouched).
CORRECTION PASS T3c (2026-10-20): the response-shape incompatibility reported by
OPENCODE-REVIEW-CORRECTIONS-20261020.md item 1 is repaired below — see the T3c section.

## Files changed (sha256 before → after, original T3 pass)

| File | BEFORE | AFTER |
|---|---|---|
| server/src/routes/schedules.ts | f881f8f275cae262bfac11e67f70245d2f049a0b972bfab8a9595b6a356dbfcb | 6f616e5200ade5fa6b0c7a8326f74096d4399e578823ee96e6522ccbfb66d5eb |
| server/src/services/schedules.ts | 3d8d940d559bb055e441645df7ec61325795455a99b5b64b6160900d72d345c9 | cac07600ad83a27e246dc8fc211e84d675c4d1a2a36c58bfc1cce2f0c572897d |
| server/src/routes/attendance-records.ts | dd248656f1b0eb77925e743726e719201ff1e0d933afbe89e97f74236e8d719 | 1527e52672cc6c9d6412d1293660a5f72d213e7559c77f8ba1a697f7d8924bcc |
| server/tests/m5-schedules.test.ts | 54099feaa4f12bfe46f88c1690eb119c0471af335e6395b273a70da36ff6abac | 5be7149b2aa4fcabdc0cf180ff38a4ca048666f7efa162492f20f27ae9273b23 |
| server/tests/m5-attendance-records.test.ts | 45c5dfce9d58a307079eccdfea9d702d2e80e01784848e846dac5edf088e1b0d | cbdfe53d3712afcf50cb424c4baa798232ff5ccb167ab993c60cbd719be6ec6d |

## Files changed (sha256 before → after, T3c correction pass — final state)

The T3c BEFORE hashes are the original pass AFTER hashes above; services and attendance service are untouched end to end.

| File | BEFORE (T3 pass out) | AFTER (T3c final) |
|---|---|---|
| server/src/routes/schedules.ts | 6f616e5200ade5fa6b0c7a8326f74096d4399e578823ee96e6522ccbfb66d5eb | 3662c4e2a11cefe2c8fbebca23df7af6937529d928c768f046422f73604748b1 |
| server/src/routes/attendance-records.ts | 1527e52672cc6c9d6412d1293660a5f72d213e7559c77f8ba1a697f7d8924bcc | 6a93785915d0d63ba2a31fc021cd671dc18cdc6f0e849fd38c939e9ead4e7020 |
| server/src/services/schedules.ts | cac07600ad83a27e246dc8fc211e84d675c4d1a2a36c58bfc1cce2f0c572897d | cac07600ad83a27e246dc8fc211e84d675c4d1a2a36c58bfc1cce2f0c572897d (unchanged) |
| server/tests/m5-schedules.test.ts | 5be7149b2aa4fcabdc0cf180ff38a4ca048666f7efa162492f20f27ae9273b23 | d28f2227ba81767b907c1c015d7eb394841f8c405b9f3321611b62318e8db09e |
| server/tests/m5-attendance-records.test.ts | cbdfe53d3712afcf50cb424c4baa798232ff5ccb167ab993c60cbd719be6ec6d | 08f3406c2a15fecba5cd69af739ba50b87f4b2997a34e4fd0b2de75123e3b340 |

server/src/services/attendance-records.ts: NOT changed (hash 81a0587954da58cd2b8c1073ad0e7b89723c86e002ed528fcef2e892ff6b01e2 before = after). The correction-metadata defect lived entirely in the route's UPDATE statement; the service's validation contract was already correct.

## What was implemented

### Defect 1 — silent LIMIT truncation on every list feed (FIXED)

New shared, pure helpers in server/src/services/schedules.ts (exported):
- `parseTimeRangeFilter(query)` — validates optional `from`/`to` query bounds. Accepts only real UTC `YYYY-MM-DD[ HH:MM[:SS]]` instants inside the storable DATETIME year range (1000..9999, the bound the schedules service already enforces); rejects non-strings, offsets, impossible calendar times and inverted ranges with 400. Mirrors the existing audit-log `from`/`to` contract (services/audit-log.ts:529-589) — no new duration/page policy invented.
- `buildTimeRangeConditions(column, range)` — `AND <col> >= ?` / `AND <col> <= ?` fragments, same shape as `buildAuditWhere`.

Route changes (caps reused from the existing contracts, one extra row fetched to detect truncation, deterministic id tiebreak; feeds are NOT redefined future-only — default pages keep their existing ordering and history stays reachable via explicit ranges). Response shapes below are the T3 pass shapes, superseded by the T3c correction:
- GET /student (routes/schedules.ts:566-590): cap 100, `ORDER BY starts_at ASC, id ASC`, range on `starts_at`.
- GET /sessions (routes/schedules.ts:370-403): cap 500, `ORDER BY starts_at ASC, id ASC`, range on `starts_at` (group_id selector preserved).
- GET / series (routes/schedules.ts:238-262): cap 200, `ORDER BY starts_on DESC, id DESC`, range on `starts_on`.
- GET /sessions/:sessionId/records (routes/attendance-records.ts:298-326): cap 500, `ORDER BY student_id ASC, id ASC`, range on `marked_at`.
- GET /me (routes/attendance-records.ts:485-522): cap 200, `ORDER BY ss.starts_at DESC, ss.id DESC`, range on `ss.starts_at`. (Same defect class as the enumerated feeds; fixed for consistency — flagged here in case the supervisor wants it held instead.)

### Defect 2 — POST /records/:id/correct left a stale public `reason` (FIXED)

routes/attendance-records.ts:456-460: the UPDATE now writes `reason=?` AND `correction_reason=?` with the same correction reason, exactly like the mark/bulk correction branch (routes/attendance-records.ts:243-247). The response's `reason` field and the audit's `newValue.reason` are now true of the stored row. No change to what students/parents may see: the /me SELECT list and all visibility filters are untouched.

## Reproduction evidence (failing test FIRST, then repair)

Before the fix, focused runs: m5-schedules.test.ts 46 pass / 9 fail; m5-attendance-records.test.ts 33 pass / 7 fail. All failures were the new tests (plus the updated series-list contract assertion); every pre-existing test kept passing.

Defect 1 tests (failed before, pass after):
- schedules: the student feed exposes truncation instead of silently dropping every session past the cap (120 past + 3 future sessions: `truncated: true`, 100 returned, `LIMIT 101`, `ORDER BY starts_at ASC, id ASC`)
- schedules: the student feed keeps full history reachable through explicit from/to ranges (`to` → 46 rows; `from` → the 3 future sessions; bounded window → 3 rows)
- schedules: the student feed rejects malformed or inverted from/to bounds with 400 and no feed query
- schedules: the student feed orders identical starts_at deterministically by id
- schedules: the staff session list exposes truncation and pages with from/to (505 pool → truncated, 500 returned; window → 6 rows; normalized UTC literals asserted)
- schedules: the staff session list rejects a malformed from bound with 400 and no list query
- schedules: the series list exposes truncation and filters by a starts_on range (205 pool → truncated, 200 returned; range → 70 rows)
- schedules: the series list rejects an inverted range with 400 and no list query
- schedules: list is tenant-scoped and returns rows (updated to the new `{ series, truncated }` envelope contract — contract update, not a weakening)
- attendance: the staff records list exposes truncation instead of silently dropping rows past the cap (505 pool → truncated, 500 returned)
- attendance: the staff records list pages with validated from/to bounds on marked_at
- attendance: the staff records list rejects a malformed to bound with 400 and no list query
- attendance: the student /me history exposes truncation instead of silently dropping records past the cap (205 pool → truncated, 200 returned)
- attendance: the student /me history pages with a from bound on the session start
- attendance: the student /me history rejects an inverted range with 400 and no feed query

Defect 2 test (failed before, pass after):
- attendance: the correction endpoint writes reason and correction_reason like the mark path (asserts `reason=?` in the UPDATE and params [state, reason, corrected_by, correction_reason, ...], plus audit newValue.reason)

## Focused test results (after the fix)

- `node node_modules/tsx/dist/cli.mjs --test server/tests/m5-schedules.test.ts` → 55 pass / 0 fail.
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m5-attendance-records.test.ts` → 40 pass / 0 fail.
- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` → exit 0, no output (provisional while other writers are active; no errors from any file).

(These are the T3 pass numbers; the final T3c numbers are in the T3c section below.)

---

# T3c correction pass — response-shape compatibility (2026-10-20)

Basis: OPENCODE-REVIEW-CORRECTIONS-20261020.md item 1. The first T3 pass changed the TOP-LEVEL RESPONSE SHAPE of the five list endpoints: the three bare-array feeds were wrapped in envelopes (`{ sessions, truncated }`, `{ series, truncated }`) and the two pre-existing envelopes gained a `truncated` key. Repair: every endpoint returns EXACTLY its pre-batch top-level shape and keys (determined from the committed code via read-only `git show HEAD:server/src/routes/{schedules,attendance-records}.ts`):
- GET /student: bare array (`res.json(rows)` at HEAD). RESTORED bare array.
- GET /sessions: bare array at HEAD. RESTORED bare array.
- GET / series: bare array at HEAD. RESTORED bare array.
- GET /sessions/:sessionId/records: `{ session_id, records }` at HEAD. RESTORED exact two keys (`truncated` key removed).
- GET /me: `{ student_id, records }` at HEAD. RESTORED exact two keys (`truncated` key removed).

Truncation metadata now lives in ONE response header, `X-Results-Truncated: true|false`, set via `res.set` on all five lists and present on every successful response (never silently absent). Kept unchanged: validated `from`/`to` filters, deterministic ordering, caps, cap+1 truncation detection, correction-metadata consistency, plan/scoped rejection paths (400s), and all visibility/audit behavior. No file was reset; the useful bounds fixes were preserved.

## T3c reproduction evidence (failing tests FIRST, then repair)

BEFORE the route repair, with the T3c tests in place (read-only, before any src edit):
- m5-schedules.test.ts: 49 pass / 9 fail — failing exactly the shape-carrier tests (12, 48, 49, 51, 52, 54) plus the 3 new compatibility regressions (56, 57, 58).
- m5-attendance-records.test.ts: 36 pass / 6 fail — failing the 2 envelope tests (34, 37), the 2 paged tests (35, 38), plus the 2 new compatibility regressions (41, 42).
Every pre-existing test not carrying shape assertions kept passing.

Updated (contract restore to pre-batch shapes — assertion strength preserved, truncation assertions moved to the header): the ten shape-carrier tests listed above. Added compatibility regressions:
- schedules: the student feed keeps its pre-batch bare-array shape and exposes truncation only in the header (Array.isArray + exact ids + header 'false' + LIMIT cap+1 retained)
- schedules: the staff session list keeps its pre-batch bare-array shape and exposes truncation only in the header
- schedules: the series list keeps its pre-batch bare-array shape and exposes truncation only in the header
- attendance: the staff records list keeps exactly its pre-batch envelope keys and exposes truncation only in the header (Object.keys deep-equal ['records','session_id'] + header 'false' + cap+1 retained)
- attendance: the /me history keeps exactly its pre-batch envelope keys and exposes truncation only in the header (Object.keys deep-equal ['records','student_id'] + pre-batch starts_at DESC ordering asserted)

## T3c focused test results (final)

- `node node_modules/tsx/dist/cli.mjs --test server/tests/m5-schedules.test.ts` → 58 pass / 0 fail.
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m5-attendance-records.test.ts` → 42 pass / 0 fail.
- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` → exit 0, no output (provisional while other writers are active; no errors from any file).

## T3c held items / limits

1. Cross-origin exposure of `X-Results-Truncated` to browser JS is PENDING: exposing a non-simple response header cross-origin requires `Access-Control-Expose-Headers` in the shared CORS/index configuration (server/src/index.ts), which is a FORBIDDEN file for this lane. The header is set correctly server-side on all five lists; browser clients may need the shared config change to read it.
2. Attendance T3b — HELD (unchanged held list below applies).
3. All other held policy items below are unchanged.
4. Runtime observation (environment, not the code): `tsx --test <file>` runs keep an open handle and do not exit at completion on this Windows/Node 22.19 host (the TAP summary reports fully; e.g. 49/9 mid-flight, then the process lingers), so focused runs here use `--test-force-exit`, which terminates the process cleanly after the summary. All reported pass/fail counts are complete-run results.
5. Hermetic-test limit unchanged below: SQL guards are asserted via statement text + bindings, not a live MySQL; header behavior is asserted through the injected-response `set` capture of the shared harness (helpers/m2-harness.ts unchanged).

## Held items (not implemented — undecided policy, per scope confirmation)

1. Correction of a cancelled session via POST /records/:id/correct — server/src/routes/attendance-records.ts:431-475. The handler never checks the session status, so it corrects records of cancelled sessions while mark/bulk return 409 (routes/attendance-records.ts:344, :386). No explicit contract settles whether correction of a cancelled session is allowed; decision D3 (lifecycle rules: future/cancelled/past marking) is undecided. HELD.
2. Clearing or replacing the public reason — server/src/routes/attendance-records.ts:431-475 and :226-247. Replacing is now consistent (both paths store the correction reason in `reason`); clearing a stored reason remains impossible (validateCorrectionInput requires a non-blank reason, services/attendance-records.ts:105-113) and no contract authorizes a clear. HELD (D4/D5 re-mark semantics).
3. Who may create schedules or mark attendance — unchanged (exact-assignment policy already implemented; not mine to alter).
4. Legacy attendance source of truth (D6) — unchanged.
5. Session overlap/double-booking rules (D7) — unchanged.
6. Branch eligibility vs feed visibility (S3/D1) — unchanged.
7. Student/parent visibility of `reason` (D4) — unchanged; /me still returns `a.reason` exactly as before.
8. T3b (attendance reports) — HELD, not this task.

## Limits (original T3 pass, updated by T3c)

- All tests are hermetic: SQL guards (range filters, ordering, LIMIT cap+1) are asserted via statement text + bindings against a scripted adapter, not a live MySQL. Real MySQL ordering, DATE-vs-DATETIME comparison of the normalized `starts_on` bounds, and concurrency are unproven.
- ~~The response envelopes of the five list feeds changed from bare arrays (student feed, staff sessions, series list) or gained a `truncated` field~~ (REPAIRED by the T3c correction pass above; every list returns exactly its pre-batch top-level shape and keys, truncation moves to the `X-Results-Truncated` header). No documented external contract for these shapes was found; flag if a frontend/client contract exists.
- The `from`/`to` filters are UTC-only (no offset suffixes), matching the audit-log filter contract they mirror.
