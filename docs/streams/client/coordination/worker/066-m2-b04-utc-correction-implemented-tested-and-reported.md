# M2-B04 UTC/pagination correction implemented, tested and reported

**Task:** `client-m2-b04-utc-correction-20261020-01` (backend, write) — claimed
by worker `opencode-worker-b04-utc-20261020` on 2026-10-20, implemented against
the same five approved paths of `docs/streams/server/M2-B04-HANDOFF.md`.
**Findings addressed:** supervisor
[173](../supervisor/173-m2-b04-review-utc-and-pagination-truth.md)
F1 (exact-UTC guarantee) and F2 (mutable-order pagination claim).
**Contract:** `docs/streams/server/M2-B04-CONTRACT.md`.
**Branch:** `codex/human-client` — all pre-existing dirty work (M2-B01/B02/B03
and the client batches) was preserved; no file outside the approved scope was
edited. **Report written:** 2026-10-19T21:19:35Z (2026-10-20 00:19 Cairo).

## Changed paths (exactly the five approved ones)

- `server/src/routes/course-units.ts` — **corrected** (F1 + F2).
- `server/tests/m2-course-units.test.ts` — **corrected/extended** (8 new
  regressions, 61 → 69 tests).
- `docs/streams/server/M2-B04-CONTRACT.md` — **corrected** (UTC section,
  pagination section, status table, evidence, limits, provenance).
- `server/migrations/20261019_02_course_units.sql` — **comment only** (the
  `TIMESTAMP`/epoch semantics); still a FILE, still **never applied**.
- `server/src/routes/tenant-self.ts` — **not touched in this correction**
  (last write 2026-10-19T23:50 local, i.e. the predecessor's accepted mount;
  the additive `router.use('/catalog', createCourseUnitsRouter({ getConnection }))`
  after `router.use(deps.authenticate)` is intact and byte-unchanged).

## F1 — exact-UTC serialization

**Before:** the unit rows were read as `u.created_at` / `u.updated_at` and the
DTO rendered the driver-decoded `Date`. The pool sets mysql2
`timezone:'+02:00'`, which makes the installed decoder *interpret* the
received wall time on the client side; it is **not** a `SET SESSION time_zone`
and configures no SQL session offset. A UTC-session TIMESTAMP of
`2026-10-20 12:00:00` was therefore serialized as `2026-10-20T10:00:00.000Z` —
a two-hour shift on every route.

**After:**

- All unit read projections (keyset list, PATCH current row `FOR UPDATE`,
  POST read-back, PATCH read-back) select
  `UNIX_TIMESTAMP(u.created_at) AS created_at_epoch` and
  `UNIX_TIMESTAMP(u.updated_at) AS updated_at_epoch`. The raw datetime
  columns are no longer selected.
- `toUtcTimestamp` accepts only a valid finite epoch (`number` or a strict
  numeric string) and renders `new Date(epoch*1000).toISOString()`. A missing,
  malformed, non-positive (epoch `0` is not a representable TIMESTAMP) or
  unrepresentable epoch is **refused**: no 1970 instant, no "now", no `null`
  date, and no guessed 2/3-hour offset.
- `courseUnitDto` returns `null` when a projection is unreadable, so a caller
  cannot answer with a half-truthful DTO. The DTO keeps exactly the **seven**
  public fields; the `*_epoch` aliases never leak into a response.
- The write paths materialize the DTO **inside the transaction and before the
  commit**: an unreadable instant rolls the write back and answers 500 instead
  of committing a row whose date could only be guessed. The PATCH no-op path
  refuses the same way (and still writes and audits nothing).
- No shared db/timezone/config change, no pooled `SET SESSION` statement, no
  guessed offset, no change to the DTO shape or to the accepted owner/lock/
  audit/cleanup semantics.

## F2 — truthful mutable-order pagination

**Before:** the GET comment and the contract stated that the keyset predicate
means "no offset can skip or duplicate a row under concurrent writes", and that
the `(display_order, id)` order is "a total, stable order". Both claims were
false: `display_order` is mutable.

**After:** the router comment and the contract state the truth — the cursor is
a **position, not a snapshot**. Each page is deterministic for the rows that
request reads and bounded (default 25, max 100, one `limit+1` read), and the
cursor carries only a position and never authority. A unit moved **after** a
page was served may **reappear** on a later page; a unit moved **before** the
cursor position may be **omitted**. No cross-request snapshot, no stable-once
guarantee, no snapshot token, no version column, no ordering freeze and no
cursor/API change is invented or promised.

## Before / after behaviour

| Case | Before | After |
|---|---|---|
| Stored instant `2026-10-20 12:00:00` (UTC session), driver offset +02 | `2026-10-20T10:00:00.000Z` (2 h early) | `2026-10-20T12:00:00.000Z` (the stored instant) |
| Epoch projection missing / `null` / `0` / `NaN` / non-numeric | not representable (raw column only) | 500 + rollback, no commit on the write paths, no fabricated date |
| Page 2 after the first unit was moved behind the cursor | claimed impossible | documented and regression-tested: the unit reappears |
| Page 2 after a unit was moved before the cursor | claimed impossible | documented and regression-tested: the unit is omitted |

## Commands and outcomes (actually executed)

All from `server/` unless stated otherwise.

| Command | Result |
|---|---|
| `npx tsx --test tests/m2-course-units.test.ts` | **69 tests, 69 pass, 0 fail** (61 before + 8 new) |
| `npx tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts` | **164 tests, 164 pass, 0 fail** (the 95 accepted M2-B01/B02/B03 tests unchanged + the 69 unit tests) |
| `npx tsc --noEmit -p server/tsconfig.json` (from the repo root) | **0 diagnostics, exit 0** |
| `npx tsx --test "C:/Users/BaraaWael/TabwebClientSupervisor/173-m2-b04-utc-probes.test.ts"` (read-only, unchanged file) | **4 tests, 4 pass, 0 fail** — it was **1/4** before this correction |

No pre-existing or outside failure was observed. The legacy `auth-boundary` and
`m1-expanded-tenant-admin` suites were deliberately **not** re-run: they are
outside the handoff's named scope. No optional lint, no TEMP/debug diagnostic,
no source reconstruction, no source-disable probe, no `npx` fetch, no default
DB, no live network, no service, no install, no Git write, no migration
application and no schedule change.

## What the new regressions actually prove

- **Driver-offset independence (all routes):** the fixture hands the handler
  the raw datetime columns decoded with the installed driver's `+02:00`
  interpretation (two hours earlier) *next to* the epoch projection. The DTO
  must ignore the shifted column; the suite asserts the serialized value is
  the stored instant and that the raw value differs.
- **DST/offset independence:** two instants exactly one hour apart across the
  2026-03-29 daylight-saving start stay exactly 3 600 000 ms apart and are
  rendered from their epochs, so a wall-clock based serialization could not
  render both.
- **Malformed epoch cleanup:** `null`, `0`, `NaN`, a non-numeric string and an
  absent alias each fail the list, the create and the update with the route's
  500 answer, roll back, release exactly once and — on the write paths —
  **never commit**. No response contains `1970` or a `null` date.
- **Mutable-order truth (real handlers, real mount):** a unit reordered after
  a page was served reappears on the later page; a unit reordered before the
  cursor position is omitted by the later pages; two identical requests still
  read the same rows in the same order.
- **Isolation preserved:** the `src/db`, `src/services/minio`,
  `src/services/subscription-renewal` and `dotenv` bodies are still
  intercepted before any app module import, the unit module is still loaded
  alone and first with an empty interception log, and the sentinel counter is
  still re-asserted empty in `after`.

## Limits and blockers (no self-acceptance)

- No real MySQL, no real HTTP, no provider, no Docker, **no migration
  execution**: a real `UNIX_TIMESTAMP` evaluation, a real session time zone,
  real row locking, real keyset index usage and the real FK/`ENUM`/`CHECK`
  constraints remain unproven. The injected fixtures prove the decision
  boundary, not the physical effect.
- The epoch projection assumes the columns are `TIMESTAMP` (instant
  semantics), as the migration file declares; a `DATETIME` column would be
  interpreted in the session time zone instead and needs its own authorized
  runtime preflight. The MySQL `TIMESTAMP` range bounds the representable
  epochs; epoch `0` is not representable and is refused.
- `server/src/db.ts` was neither read nor changed; the pool's
  `timezone:'+02:00'` is untouched, and no pooled `SET SESSION time_zone`
  was issued.
- The mutable-order regressions run the real handlers against fixture rows:
  they document and pin the behaviour, they do not prove a physical concurrent
  reorder against a live InnoDB index.
- The migration FILE was **not applied**; the physical FK/collation/
  server-timezone/query-plan compatibility still needs a later authorized
  runtime preflight.
- No performance or throughput claim is made and **no measurement was taken**.
  The only bounds claimed are the ones visible in the source: one page read of
  `limit+1 ≤ 101` rows, one unit row per write, one connection acquisition and
  exactly one release-or-destroy per request.
- **No blocker.** No scope expansion, no shared db/config/middleware change, no
  new product, snapshot or ordering policy, no self-acceptance.

## Next owner action

Codex independent source/architecture/contract/type/test review of the five
paths and of the unchanged 173 probes, then acceptance or a same-scope
correction claim. The worker timer `Tabweb-OpenCode-Worker-15min` is
**DISABLED** (`State: Disabled`, `Enabled=False`, last run 2026-10-19 20:48:59,
last result 0); the enabled reviewer is `Tabweb-Codex-Supervisor-10min`.
