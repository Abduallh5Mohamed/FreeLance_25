# M2-B05 UUID identity correction — implemented, tested, reported

Task `client-m2-b05-uuid-correction-20261021-01` (backend, `taskKind:
correction`, `implementationWorker: opencode`), the exact seven B05 paths of
[182](../supervisor/182-m2-b05-uuid-identity-correction.md) and
[M2-B05-HANDOFF](../../../server/M2-B05-HANDOFF.md). Worker
`opencode-b05-uuid-identity-correction`. Timestamp 2026-10-20T22:04Z
(2026-10-21 01:04 Cairo). Reported through MCP; **not acceptance**.

Native session id: the supervisor's dispatch record
([184](../supervisor/184-review-unit-accepted-lesson-correction-and-next-ui.md))
names native launch 21204 / session `ses_ea4b11e2cffeErppZ8txhIZQk1` for this
task and worker id; this CLI run does not expose its own runtime session id,
so nothing further is claimed.

## Before / after

- Before: a valid **uppercase** lesson uuid matched the lowercase stored row
  in SQL (the declared `utf8mb4_unicode_ci` collation) but was not found again
  by the case-sensitive JavaScript locked-row map, so the reorder answered
  **500**. Two spellings of one id evaded the duplicate check, reached the
  connection and the locks, and answered **404** from the row-count mismatch
  instead of the **400** a duplicate batch owes before any connection.
- After: the batch works on **one canonical identity** — the lowercase form of
  a valid uuid — for the uniqueness check, the lock order, the SQL binds and
  the locked-row lookup. An uppercase uuid addresses the stored row and
  answers **200** with the canonical DTO; two spellings of one id are a
  **duplicate batch** and are refused **400 before a connection is taken**; a
  locked row that cannot be found under its canonical identity answers the
  identical **404** instead of crashing. The **stored** id is what the
  response DTO and the audit event carry.

Everything else is untouched: the verified-owner authority, the parent
course/unit proof, the strict payload, the bounds (1..100 items, integer
positions), the deterministic lock order, the "all ids proven before any
write" rule, the no-op rows, the one audit event per changed row, the single
commit, the epoch projection, the release/destroy lifecycle and the other
three routes.

## Changed paths (four of the seven)

- `server/src/routes/course-lessons.ts` — `canonicalUuidIdentity` (the
  lowercase identity of a valid uuid, documented against the declared
  collation); `parseReorderItems` dedups and emits the canonical id; the
  reorder handler sorts/binds the canonical ids, indexes the locked rows by
  their canonical identity, answers the identical 404 for a row that cannot
  be found that way, and names the **stored** id in the `UPDATE` bind and in
  the audit event.
- `server/tests/helpers/m2-course-lessons-harness.ts` — the fixture now
  emulates the **declared** collation of the `CHAR(36)` id columns
  (`sameStoredId`, `canonicalStoredId`, `compareStoredIds`) instead of a
  byte-exact comparison, for the lesson id, the unit qualification, the
  `id IN (…)` batch statements and the keyset tie-break.
- `server/tests/m2-course-lessons-reorder.test.ts` — **7 new regressions**:
  the fixture's own case-insensitive comparison; an uppercase uuid addressing
  the stored row (canonical bind, stored DTO id, stored audit id, one commit,
  one release); the four case-variant duplicate shapes refused 400 with **no**
  connection, **no** statement and **no** transaction; a mixed-case selection
  writing and auditing every row once in canonical bind order; a mixed-case
  batch with a foreign id keeping the identical 404 with zero writes, zero
  audits, one rollback and one release; an unknown uuid keeping the identical
  404; a stored id that is not lowercase answered with the **stored** identity.
- `docs/streams/server/M2-B05-CONTRACT.md` — the identity rule, the status
  row, the atomic-order steps 5–7, the correction section and the corrected
  evidence/limits.

**Not** changed by this correction: `server/src/routes/tenant-self.ts` (the
additive mount, last write 2026-10-21 00:41 Cairo, before this claim) and
`server/migrations/20261021_01_course_lessons.sql` (the schema FILE, last
write 2026-10-21 00:49 Cairo, before this claim). The migration was still
**not applied**. No other path was touched; the accepted dirty work and the
WorkBuddy frontend paths are preserved.

## Commands and outcomes (from `server/`, repository-local binaries, no fetch)

- `./node_modules/.bin/tsx --test tests/m2-course-lessons.test.ts` — 48 tests,
  48 passing, 0 failing.
- `./node_modules/.bin/tsx --test tests/m2-course-lessons-reorder.test.ts` —
  33 tests, 33 passing, 0 failing (26 of the B05 batch + 7 of this
  correction).
- `./node_modules/.bin/tsx --test tests/m2-course-lessons.test.ts tests/m2-course-lessons-reorder.test.ts`
  — 81 tests, 81 passing, 0 failing.
- `./node_modules/.bin/tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts`
  — 164 tests, 164 passing, 0 failing (the accepted M2-B01/B02/B03/B04 suites,
  unchanged).
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — exit 0, 0 diagnostics.
- `./node_modules/.bin/tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/182-m2-b05-uuid-probes.test.ts`
  — the independent public probe, run **unmodified** from `server/`: 3 tests,
  3 passing, 0 failing (uppercase → 200 with the canonical DTO and a commit;
  case-variant duplicate → 400 with the connection never acquired; lowercase
  control → 200 with exactly one safe release and the exact event order). It
  was 1/3 before this correction.

The whole set was re-run after the last source edit; only the contract
document was edited afterwards (Markdown, outside the TypeScript program).

Not run, on purpose: the legacy `auth-boundary` / `m1-expanded-tenant-admin`
suites, the default-DB / dotenv / provider startup paths, any live service,
DB, network, browser, install, migration application, Git write or deploy, any
optional lint, and any TEMP/source-reconstruction or source-disable probe. The
public probe was read and executed only; it was not edited.

## Limits (no overclaim)

- The declared collation is **emulated by the fixture's comparison rule**, not
  evaluated by a real MySQL: no real collation, no real `id IN (…)` matching,
  no real case-insensitive primary-key uniqueness. The regression is proved
  against the production handler, not against a database.
- No live MySQL, no real row locking or concurrency, no HTTP transport, no
  migration execution, no provider/Docker/install. The fixture still replays
  the transaction (snapshot on begin, restore on rollback), so atomicity
  evidence remains the decision boundary plus the restored state.
- No latency, throughput or scalability measurement was taken; no such claim
  is made. The bounds are the source-visible ones (one lock read, at most 100
  updates, 100 audit inserts, one read-back, one connection acquisition and
  one release-or-destroy per request).
- The correction does not change the *path* ids of the other three routes:
  `courseId`/`unitId`/`lessonId` in the URL are validated by pattern and
  compared by SQL only, so they already resolve case-insensitively against the
  declared schema. Their DTO identity remains the stored one. This was left
  alone deliberately — it is outside the 182 finding.
- The migration FILE was **not applied**; the schema and its deployment
  compatibility remain a separate authorized rollout gate.
- No self-acceptance is claimed.

## Next owner action

Codex: independent review of the four changed paths against 182 and of the
actual code/contract/tests. Any further correction belongs to a same-scope
scoped task; this worker is stopped and holds no further edits. The WorkBuddy
M2-10 frontend task stays disjoint and may use the existing B05 contract
provisionally; integration acceptance awaits this correction.
