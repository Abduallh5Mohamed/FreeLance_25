# W5 — `video://` write-time binding + parent-resolution recovery

Task: `server-w5-video-link-binding-recovery-20261020-01`
Worker: `wb-w5-link-binding-recovery-20261021-01` · team `backend` · accessMode `write`
Repo: `C:/Users/abdua/OneDrive/سطح المكتب/FreeLance_25-1`, branch `codex/workbuddy-server`
Controlling scope: `docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md` §W5 (explicit expansion to
`materials.ts` + `video-access-policy.ts`, ambiguity deny, no product rule about multi-lesson videos)
Pre-claim baseline: `WorkBuddySupervisorBridge/handoff/WORKBUDDY-W5-RECOVERY-BASELINE-20261021.md`

Status: implementation + focused hermetic tests + typecheck complete. **Not accepted** — this document is a
report, not an acceptance record.

---

## Section A — Inherited state I verified (not authored by me)

Captured immediately after the claim, before any edit, with
`sha256sum` / `stat -c %s` over the seven `allowedPaths`:

| path | sha256 (inherited) | bytes | matches pre-claim baseline? |
|---|---|---|---|
| `server/src/routes/lectures.ts` | `ff3b593067d6f0c8fe155862bf97b3b3ecffb7a71a8a8e00d53bb9564d0ed15a` | 42884 | yes, byte-identical |
| `server/src/routes/videos.ts` | `8c6f79a82ae4fbb8f642c14e0f0c5801810af55549fb6a0ee7f4893e50eccc4d` | 109287 | yes, byte-identical |
| `server/src/routes/materials.ts` | `157717868e1b8c56e8f7d721aee1ebca9ba55ee0a47111f183b0b0be9e013dab` | 39411 | yes, byte-identical |
| `server/src/security/video-access-policy.ts` | `0acc2149a0a3a0a2feff70ff54e236224bec15cb00bf5096cfd2ba3deccd7df4` | 21590 | yes, byte-identical |
| `server/tests/m1-video-link-binding.test.ts` | ABSENT | — | yes, absent |
| `server/tests/m1-video-link-policy.test.ts` | ABSENT | — | yes, absent |
| `docs/streams/server/W5-VIDEO-LINK-BINDING-20261020.md` | ABSENT | — | yes, absent |

I did **not** author those four source files' inherited bytes, and I did not author any other file in the
working tree. The tree is shared with other lanes; their dirty files (including `src/index.ts`,
`middleware/auth.ts`, the W3 files and the untracked `routes/exam-manual-grading.ts`) are not mine and were
left untouched.

Defect confirmed at the inherited revision (line numbers verified, not assumed):

- `lectures.ts:496` (create) and `:729` (update) — `startsWith('video://')` only. No existence, tenant,
  actor-authority or duplicate-parent check.
- `materials.ts:550` (create) and `:660` (update) — same prefix-only pattern.
- `video-access-policy.ts:349-352` — `WHERE video_url = CONCAT('video://', ?) LIMIT 1`, no `ORDER BY`:
  arbitrary parent when several lectures name one video.
- `video-access-policy.ts:411-416` — `premium_lecture_access ... LIMIT 1`, no `ORDER BY` (see §B for why this
  one is an existence proof rather than a parent authority).
- Schema facts verified in `server/migrations`: `lectures.video_url` is `TEXT` with indexes on
  `course_id` / `instructor_id` / `(is_published, grade_id, group_id)` only
  (`20261017_02_missing_core_tables.sql:8`); `course_materials.file_url` is `VARCHAR(500)` with no unique key
  (`20260920_00_legacy_baseline.sql:178`); `videos.tenant_id` is nullable
  (`20260922_00_tenant_media_and_subscription_requests.sql:41`). There is **no** uniqueness contract on the
  association, in either table.

`videos.ts`: no `video://` association write exists. Its only `video://` references are reads
(`:2228`, `:2259`, `:2422`) and an archive-by-URL update (`:2427`). `/upload/init` (`:1534-1618`) writes the
legacy mirror columns `videos.lecture_id` / `videos.material_id` from the request body without validating
them; that mirror is not consulted by the resolution path and is out of this task's `video://` scope — it is
raised as a finding in §E, not changed.

---

## Section B — Changes I made

| path | before sha256 / bytes | after sha256 / bytes |
|---|---|---|
| `server/src/routes/lectures.ts` | `ff3b5930…0ed15a` / 42884 | `367c6a62050d72fb8708e225a4df3b3a15f5947576d971101d47473b8d91705c` / 46170 |
| `server/src/routes/materials.ts` | `15771786…013dab` / 39411 | `c37f2e3657b4051c4b7dd4ed126b4cd03524b14cf3a18743fdcbde225bcc7fd4` / 44217 |
| `server/src/security/video-access-policy.ts` | `0acc2149…cd7df4` / 21590 | `4d53537c8f333f42a8461e6d3a043768759f6630de2d56a016058c488cc7aee6` / 36240 |
| `server/src/routes/videos.ts` | `8c6f79a8…0eccc4d` / 109287 | **unchanged** (no `video://` association write to harden) |
| `server/tests/m1-video-link-binding.test.ts` | absent | `dd749749ca96061958d8c4d99f9ab992f050423db324267d180704f1483b96af` / 36821 |
| `server/tests/m1-video-link-policy.test.ts` | absent | `b1b9dba63f7df595e5b16e8ece1f95b7bfa5fc190347f06310e2ed22013ff33f` / 14414 |

### B.1 `video-access-policy.ts` — parent resolution and the binding check

1. **Candidate resolution replaces first-parent selection.** New `VideoAccessParentResolution`
   (`none` / `single` / `ambiguous`) and an optional `loadParentLecture` repository method.
   `evaluateVideoAccess` now denies the whole evaluation when the parent is ambiguous, before any
   lesson-derived grant. There is no tie-break and no ORDER BY heuristic.
2. **The SQL has no `LIMIT` at all.** The aggregate is read in the same statement and the row is only joined
   when the count is exactly one:

   ```sql
   SELECT candidates.candidate_count AS candidate_count, l.id, l.instructor_id, …
   FROM (SELECT COUNT(*) AS candidate_count FROM lectures WHERE video_url = CONCAT('video://', ?)) AS candidates
   LEFT JOIN lectures l ON l.video_url = CONCAT('video://', ?) AND candidates.candidate_count = 1
   ```

   At most one row is returned by construction; `COUNT(*) = 0` → `none`, `> 1` → `ambiguous`.
3. **The single-row seam stays fail-closed.** `loadLecture` (kept for injected single-row fixtures) is
   derived from the same resolution and returns `null` on ambiguity, so it can never hand out an arbitrary
   parent. It is only consulted when a repository does not implement `loadParentLecture`; the production
   adapter always implements it.
4. **`loadStudentPurchase` is now ordered** (`ORDER BY pla.id ASC`) and documented as an existence proof:
   every matching row satisfies the same predicate (this enrollment bought a premium lecture embedding this
   video) and no field of the chosen row is used for authority, so there is no "wrong parent" consequence —
   but the read is no longer an unordered first-row pick.
5. **New `validateVideoBinding`** (pure, over an injected transaction-scoped reader) implements the write
   contract: `video://` parse → locking read of `videos` (`FOR UPDATE`) → tenant (with the course fallback for
   a null `videos.tenant_id`) → actor authority via the **existing** `evaluateVideoAccess` (no new permission
   model) → conflict probe across `lectures` and `course_materials`. Any thrown read fails closed.
6. Module header documents the association contract, including that the single-parent rule is an *ambiguity*
   rule and not a product rule.

### B.2 `lectures.ts`

- Create: the binding check runs as the first statement inside the existing write transaction, before
  `INSERT INTO lectures`.
- Update: the check runs inside the transaction after the `FOR UPDATE` row read, and **only when the update
  actually changes `video_url`** — re-validating an unchanged legacy link would block unrelated edits.
- New optional dep `hasVerifiedPlatformCapability` (default deny) wired in the production export to the
  existing `isSuperAdmin` / `getAdminPermissions('security.manage')` helpers. It preserves the router's
  existing platform-admin path (a platform admin has no selected tenant to compare).

### B.3 `materials.ts`

- Create/update of a `video` material: same binding check, on the same transaction.
- New **optional** `transaction` dep, wired in the production export to a real pool connection
  (`beginTransaction` / `commit` / `rollback` / `release`, same shape as `lectures.ts`). The check and the
  INSERT/UPDATE now share one transaction. When a harness does not supply it, the two steps still run in
  order but are **not** atomic — stated in §D.
- Update validates only when a new video reference is written (`file_url` changed, or the type flips to
  `video`).

### B.4 Error codes introduced (stable, machine-readable, in the JSON body as `code`)

| code | status | meaning |
|---|---|---|
| `VIDEO_NOT_FOUND` | 404 | the referenced video row does not exist |
| `VIDEO_FOREIGN_TENANT` | 403 | video tenant ≠ writer's server-selected tenant (or no provable tenant) |
| `VIDEO_UNAUTHORIZED` | 403 | the existing playback policy denies the actor on this video |
| `VIDEO_ALREADY_BOUND` | 409 | the video is already linked to another lecture **or** material |
| `VIDEO_BINDING_UNVERIFIABLE` | 503 | the check could not be performed (read error / store unavailable) — fail closed |
| `VIDEO_LINK_INVALID` | 400 | value is not a `video://` reference (defensive; routes keep their existing 400 first) |

Unchanged: `http://` / `https://` still returns the pre-existing **400**
`External video links are not allowed. Upload the video to the platform.` with no `code`, before any video
read. Existing 410 (archived) and the licensed-replacement 409 guard keep their precedence.

---

## Section C — Test evidence

Commands (from the repo root), all hermetic (`M1_NETWORK_MODE=hermetic`, network guard preloaded):

```
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m1-video-link-binding.test.ts
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m1-video-link-policy.test.ts
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

### C.1 New suites — failing first, then passing

| suite | before fix | after fix |
|---|---|---|
| `m1-video-link-binding.test.ts` | 20 tests → **6 pass / 14 fail** | **21 tests → 21 pass / 0 fail** |
| `m1-video-link-policy.test.ts` | 10 tests → **2 pass / 8 fail** | **10 tests → 10 pass / 0 fail** |

Failing-first output summary (the failures were the required behaviour, not harness noise):

- `allow: a lecture may link an existing video of the caller tenant (201)` — failed on
  `video row is read FOR UPDATE` (the 201 itself already worked: the defect is that *any* string was
  accepted).
- `deny: an unknown video id is 404` / `another tenant is 403` / `already linked … is 409` — `201 !== 404/403/409`:
  the inherited handler accepted every `video://` string.
- `failure: a read error during validation rejects the write (503)` — `201 !== 503`.
- `concurrency: two simultaneous binds … one 201 and one 409` — got `[201, 201]`.
- policy `a single parent lecture is resolved …` — `the parent read resolves candidates` (the emitted SQL had
  no aggregate).
- policy `two parents … deny, even for the first parent instructor` — returned `true` (the bare `LIMIT 1`
  picked the first parent and granted through it).
- policy `the ambiguous parent read reports the candidate count` — `loadParentLecture` did not exist.
- policy `the purchased-license read is ordered` and `policy source: no … LIMIT 1` — the unordered read was
  still present.

The 21st binding test (`same-tenant actor without a grant … VIDEO_UNAUTHORIZED`) was added after the fix and
was green on its first run; it is not part of the failing-first count above.

### C.2 What the suites actually exercise

Both drive production code, not a re-implementation:

- binding suite: `createLectureRouter` / `createMaterialsRouter` with the **real** handlers, the **real**
  auth middleware (`createOptionalAuth` / `createAuthenticateToken` over an injected `PrincipalRepository`),
  the **real** `validateVideoBinding` and the **real** `createSqlVideoAccessRepository` +
  `evaluateVideoAccess`; only the data access is a fixture adapter answering the SQL the handlers emit.
- policy suite: `evaluateVideoAccess` over the **real** `createSqlVideoAccessRepository`, with a recording
  executor that mirrors the WHERE semantics of whatever SQL the adapter emits (aggregate → count; bare
  `LIMIT 1` → first row).

Matrix coverage (all in `m1-video-link-binding.test.ts` unless noted): 1 allow (lecture + material + both
update paths, plus the null-`videos.tenant_id` course fallback), 2 → 404, 3 → 403 foreign tenant, 3b → 403
`VIDEO_UNAUTHORIZED`, 4 → 409 lecture conflict, 5 → 409 material conflict, 6 → 503, 7 → 400 `https://`,
8 concurrency, 9/10 policy (`m1-video-link-policy.test.ts`), plus "unchanged binding is not re-validated".

### C.3 Pre-existing suites covering the touched routes

Run together (9 files) before and after:

| run | tests | pass | fail |
|---|---|---|---|
| baseline (before my edits) | 402 | 402 | 0 |
| after my edits | 402 | **395** | **7** |

The 7 failures are all in files outside my `allowedPaths` and all encode the **old prefix-only contract**
(a create with a `video://` value that has no `videos` row must return 201). They are the intended
consequence of the required 404 contract, not a defect in the change:

1. `m1-expanded-lecture-authority.test.ts` — `instructor create with its own course succeeds and binds its own instructor id`
2. … — `tenant teacher create derives the lecture owner from the verified principal`
3. … — `instructor create with the default course path succeeds (no course_id)`
4. … — `platform admin create keeps the pre-existing platform-wide course path`
5. … — `multi-tenant instructor may create under a course in their selected (non-owned) tenant`
6. … — `database failure on create surfaces 500` (it throws only on `INSERT INTO lectures`; the create now
   stops at 404 before the INSERT is reached)
7. `m2-c5-lectures-reorder-audit.test.ts` — `lecture create and its audit are issued through the same transaction data seam`

No assertion in those files was weakened, deleted or skipped; I did not edit them. They need their fixtures to
model a `videos` row (or their expectation to become 404) — that is a coordination item, see §E.

Unaffected and still green: `m1-materials-boundary` (all), `m1-video-route-boundary` (all),
`m1-media-socket-regressions` (all), `m1-security-videos`, `m1-upload-contract`,
`m1-video-processing-recovery`, `m1-schema-reconciliation`.

### C.4 Typecheck

`node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` → **0 errors**.

The stated baseline expected exactly 2 errors at `server/src/routes/exam-manual-grading.ts:461`
(cols 47, 64). They are **not present** in this run: that file is untracked, mtime `2026-10-21 18:34:43`
(after the 18:33 baseline capture) and was rewritten by the other lane. It is outside my `allowedPaths`,
I did not touch it, and I did not "fix" anything to make the count go down. `server/tsconfig.json` includes
`src/**/*` only, so the test files are not part of this typecheck.

---

## Section D — Concurrency assumption, limits, and the I2 requirement

**Implemented.** Both lecture paths and both material paths run `validateVideoBinding` inside the same
transaction as the write, and the first statement of that check is
`SELECT id, tenant_id, course_id, uploaded_by FROM videos WHERE id = ? FOR UPDATE`. Two writers binding the
same video therefore serialize on the `videos` row: the second waits for the first to commit, then its
conflict probe sees the new parent and returns 409.

**This is provisional, by construction.** There is no unique constraint on the association and I am forbidden
from writing migrations. The guarantee holds **only** if every writer that creates a `video://` association
goes through this seam:

- `POST /lectures` and `PUT /lectures/:id` (this task),
- `POST /materials` and `PUT /materials/:id` (this task),
- **not** `/upload/init`'s `videos.lecture_id` / `videos.material_id` mirror, and **not** any direct SQL,
  script, backfill or admin tool. Those do not take the lock and can still create a second parent.

A unique index on `lectures` alone would **not** protect the association across tables: the second parent can
be a `course_materials` row, and a partial/legacy duplicate already present in the data would make such an
index unappliable without reconciliation.

**I2 requirement (not implemented here):** a real constraint — a unique key on the association (for example
a dedicated binding table with a unique key on `video_id`, replacing `lectures.video_url` /
`course_materials.file_url` as the source of truth) — is what turns the check-then-write into a guarantee and
what would let the platform safely support more than one parent. Until then, the code-level guarantee is
"serialized for writers that use this seam", not "impossible to double-bind".

Test evidence for this section is deliberately split: the concurrency test runs two requests through a
harness that serializes transactions the way InnoDB serializes two locking readers of one row, and separately
asserts the emitted SQL contains `FOR UPDATE`. That proves the handler's ordering logic; it is **not** a live
SQL proof and must not be read as one.

---

## Section E — Contract impact, limitations, what I could not prove

**Contract additions (announced here before reliance):**

- `POST/PUT` on lectures and materials can now return **404 / 403 / 409 / 503** where they previously returned
  201/200. Bodies carry `{ error, code }` with the codes in §B.4. Success response shapes are unchanged.
- Ambiguous playback (a video with more than one parent lecture) now **denies** every grant path, including
  the uploader/owner paths, because no path can prove which parent's context applies. This only affects data
  that is already ambiguous; it is fail-closed, and it is the reason a second parent is refused at write time.
- A lecture/material update that does not change the video reference is **not** re-validated, so existing
  legacy links (e.g. a video with a null tenant and no course) keep working for unrelated edits.

**Limitations / what I could not prove:**

1. No live database, no migration, no integration run: the SQL is asserted by text/params and by a recording
   executor, not executed against MySQL. Column types and indexes were read from the migration files.
2. The concurrency guarantee is the seam-scoped one described in §D; it is not a DB-level guarantee.
3. `/upload/init` (`videos.ts:1534-1618`) accepts `lecture_id` / `material_id` from the body and writes them
   into `videos` with no existence/tenant/conflict check. Those columns are not consulted by the resolution
   path, so this is not a `video://` binding and I did not change it (changing `videos.ts` behaviour was not
   in the required behaviour list and would risk the accepted W3 upload tests). It is a real gap for I2:
   either validate it like the `video://` writes or drop the mirror columns.
4. `videos.ts:2228` still contains a `LIMIT 1` parent read inside the local `checkVideoAccess` helper. Every
   caller of that helper is unreachable (the routes return 410 before the legacy block: `:1466`, `:2092`,
   `:2277`), so it cannot authorize anything today; I left the dead code alone rather than rewrite unreachable
   paths in a file owned for a different change. Flagged for cleanup with I2.
5. Ambiguity is detected from `lectures` only. A video bound to one lecture and one material is rejected at
   write time (matrix case 5), but if such a pair already exists in the data, playback resolution is *not*
   ambiguous (the material is not a parent in the policy) and is unaffected.
6. The 7 pre-existing test failures in §C.3 are unresolved by design: their fixtures predate this contract and
   the files are outside my `allowedPaths`. They must be updated by their owner before the full suite runs.
7. Platform admins with a verified capability skip the tenant-equality check (they have no selected tenant),
   preserving the router's existing platform-wide admin path. Actor authority is still required from the
   playback policy. If the batch wants admins held to a tenant boundary too, that is a separate decision.

---

## Section F — Correction 2026-10-21: target-resource tenant equality, canonical references, fixture repairs

Task: `server-w5-target-tenant-fixture-correction-20261021-01`
Worker: `wb-w5-tenant-fixture-correction-20261021-01` · team `backend` · accessMode `write`
Pre-claim baseline (authoritative for attribution): `WorkBuddySupervisorBridge/handoff/WORKBUDDY-W5-CORRECTION-BASELINE-20261021.md`
Review that found the two defects: `WorkBuddySupervisorBridge/handoff/WORKBUDDY-CLOSURE-BATCH1-DELIVERY-20261020.md` §5a.

Status: correction implemented, focused suites + typecheck green, **reported — not accepted**.

### F.0 Inherited vs authored (attribution)

The bytes this correction started from are those of the previous W5 worker
(`wb-w5-link-binding-recovery-20261021-01`, reported 2026-10-21 18:52). Verified at claim time with
`sha256sum`, all nine paths byte-identical to the pre-claim baseline:

| path | inherited sha256 | inherited bytes | authored by me? |
|---|---|---|---|
| `server/src/routes/lectures.ts` | `367c6a62050d72fb8708e225a4df3b3a15f5947576d971101d47473b8d91705c` | 46170 | inherited; I changed it |
| `server/src/routes/videos.ts` | `8c6f79a82ae4fbb8f642c14e0f0c5801810af55549fb6a0ee7f4893e50eccc4d` | 109287 | inherited; I changed it (mirror only) |
| `server/src/routes/materials.ts` | `c37f2e3657b4051c4b7dd4ed126b4cd03524b14cf3a18743fdcbde225bcc7fd4` | 44217 | inherited; I changed it |
| `server/src/security/video-access-policy.ts` | `4d53537c8f333f42a8461e6d3a043768759f6630de2d56a016058c488cc7aee6` | 36240 | inherited; I changed it |
| `server/tests/m1-video-link-binding.test.ts` | `dd749749ca96061958d8c4d99f9ab992f050423db324267d180704f1483b96af` | 36821 | inherited; I changed it |
| `server/tests/m1-video-link-policy.test.ts` | `b1b9dba63f7df595e5b16e8ece1f95b7bfa5fc190347f06310e2ed22013ff33f` | 14414 | inherited; **unchanged** |
| `docs/streams/server/W5-VIDEO-LINK-BINDING-20261020.md` | `3321a381183908ceb549cdc0800e7efb85273700319b7fbe2d02eada013eb23b` | 20141 | inherited; I appended this section |
| `server/tests/m1-expanded-lecture-authority.test.ts` | `d446cb5ae5d54d810f467695df914650e8ccf1a3e7bdbcbe7a54433f0d876ed9` | 46777 | pre-existing (2026-10-18); I repaired fixtures |
| `server/tests/m2-c5-lectures-reorder-audit.test.ts` | `a5e11b0109e6d0b7350779b7e0e9e58e22d0b4dac08147edd0681b2e6bc340b6` | 25401 | pre-existing (2026-10-18); I repaired one fixture |

Sections A–E above are the previous worker's report. Where this section contradicts them, this section is
the current behaviour: specifically E.7 (platform admins no longer skip tenant equality), E.3 and D
(`/upload/init` is now validated), and C.3 (the seven fixtures are repaired, not left failing).

### F.1 Correction 1 — target-resource tenant equality

**Rule as implemented** (`validateVideoBinding`, `server/src/security/video-access-policy.ts`). Everything
below runs inside the caller's write transaction, over the same transaction-scoped reader as the INSERT /
UPDATE.

1. **Video tenant from declared authorities only.**
   - `SELECT id, tenant_id, course_id, uploaded_by FROM videos WHERE id = ? FOR UPDATE` → `videos.tenant_id`.
   - If `videos.course_id` is set: `SELECT tenant_id FROM courses WHERE id = ?` → the course authority.
   - Both present and different → **deny** `VIDEO_TENANT_CONFLICT` (409).
   - Neither present → **deny** `VIDEO_TENANT_UNPROVEN` (403).
   - One present → that one is the video tenant. The actor's tenant is never substituted.
2. **Actor authority to write** (unchanged shape): a non-platform actor must have a selected tenant equal to
   the video tenant → else `VIDEO_FOREIGN_TENANT` (403). A missing actor tenant is only acceptable for a
   verified platform capability.
3. **Destination tenant from server rows.**
   - Create: the route passes the server-derived course (`actualCourseId` in `lectures.ts`, `course_id` in
     `materials.ts`) as `targetCourseId`.
   - Update: `targetCourseId` is omitted, and the validator reads the target row itself —
     `SELECT course_id FROM lectures WHERE id = ? FOR UPDATE` or
     `SELECT course_id FROM course_materials WHERE id = ? FOR UPDATE`. A course move therefore re-proves the
     binding even when `video_url` is unchanged.
   - Then `SELECT tenant_id FROM courses WHERE id = ?` → the destination tenant. No row, or a null tenant →
     **deny** `VIDEO_TENANT_UNPROVEN` (403). The client body is never a source of the destination tenant.
4. **Exact equality, for everyone.** `destinationTenant !== videoTenant` → **deny**
   `VIDEO_TARGET_TENANT_MISMATCH` (403). This branch is reached for a verified platform operator too: a
   capability satisfies *actor* authority, it never relaxes tenant equality.
5. Unchanged and still enforced: `evaluateVideoAccess` actor authority (`VIDEO_UNAUTHORIZED` 403), the
   duplicate-parent conflict probe (`VIDEO_ALREADY_BOUND` 409), the ambiguity deny in parent resolution, and
   the catch-all `VIDEO_BINDING_UNVERIFIABLE` (503).

**New denial codes** (added to the stable set; the previous six keep their statuses):

| code | status | meaning |
|---|---|---|
| `VIDEO_TENANT_CONFLICT` | 409 | `videos.tenant_id` and `videos.course_id -> courses.tenant_id` disagree |
| `VIDEO_TENANT_UNPROVEN` | 403 | no server row proves the video tenant or the destination tenant |
| `VIDEO_TARGET_TENANT_MISMATCH` | 403 | destination resource tenant ≠ video tenant (every actor, incl. platform operators) |

**Ordering note (deliberate).** The actor-tenant check runs before the destination proof, so an ordinary
actor binding a foreign video still receives `VIDEO_FOREIGN_TENANT` — the pre-existing, already-documented
denial — rather than the newer code. Both deny with no mutation; the code differs only by which proof failed
first. A platform operator has no actor-tenant check, so their cross-tenant attempt always surfaces as
`VIDEO_TARGET_TENANT_MISMATCH`.

### F.2 Correction 2 — one canonical `video://` reference

**Rule.** `video://` immediately followed by a non-empty id containing no whitespace at all. Exported as
`parseVideoReference(value)` and used by lecture create, lecture update, material create, material update and
`videos.ts` (which parses no `video://` value — see F.4). The id is **not** trimmed; a value that would need
trimming is rejected instead. Opaque id formats are preserved — there is no UUID-only rule.

**Exact 400 predicate** (`parseVideoReference`): reject when the value does not start with `video://`
(`reason: 'not-a-reference'`, keeping the pre-existing external-link message), or when the remainder is
empty or matches `/\s/` (`reason: 'non-canonical'`). Routes apply it before the transaction, so a rejected
reference produces **zero** INSERT/UPDATE statements; `validateVideoBinding` applies the same rule again
(defence in depth) and returns `VIDEO_LINK_INVALID` 400.

**What is persisted.** The routes now store `binding.videoUrl` — the canonical reconstruction
`'video://' + videoId` — not the raw request string. For every accepted value the two are identical by
construction (anything that would differ was rejected), so a stored binding is always visible to the exact
conflict probe and to `CONCAT('video://', ?)` resolution.

**Documented legacy gap (no rewrite performed).** Values stored before this rule — e.g. `video:// x ` — are
still in the tables and are still invisible to the exact conflict probe and to
`CONCAT('video://', ?)`. This correction does **not** rewrite data, does not run any SQL, and does not
migrate: an existing malformed row keeps its wrong-parent exposure until an owner-approved data repair
(and the I2 constraint) lands. An update that leaves `video_url` untouched still skips validation, so such a
legacy row keeps working for unrelated edits; an update that supplies a non-canonical value is refused 400.

### F.3 Correction 3 — the seven regression fixtures

Each failure was reproduced before any edit: `m1-expanded-lecture-authority` 44 tests / **38 pass / 6 fail**,
`m2-c5-lectures-reorder-audit` 25 tests / **24 pass / 1 fail**, every failure `expected 201, actual 404`
(the fixture linked a `video://` value with no `videos` row). Fixtures were repaired; **no guard was
loosened and no assertion was changed, weakened, skipped or deleted.**

`server/tests/m1-expanded-lecture-authority.test.ts` — added a `videos` map to the fixture store and the
reads the real binding check + playback policy emit (`videos` row, `users` policy row, course tenant /
instructor reads, tenant-authority `UNION ALL`, `candidate_count` parent resolution, conflict probe,
instructor-share read), plus a `platformCapable` harness option (default `false`). Rows:

| fixture row | value | used by |
|---|---|---|
| `videos['video-a-create']` | tenant-a / course-a / uploaded_by `instructor-a` | own-course create; default-course create; the DB-failure test |
| `videos['video-teacher-a']` | tenant-a / course-a / uploaded_by `teacher-a` | tenant-teacher create (the teacher needs a video they are authorized on) |
| `videos['video-b-create']` | tenant-b / course-b / uploaded_by `instructor-a` | multi-tenant create under course-b |
| `videos['video-platform-b']` | tenant-b / course-b / uploaded_by `instructor-b` | verified platform operator create under course-b |

Only the `video_url` of those five create tests changed (`video://new-video` → the owned row above); the
platform-admin test additionally injects `platformCapable: (id) => id === 'platform-admin'`, i.e. the
verified capability production resolves from `isSuperAdmin` / `security.admin_permissions`. All original
assertions (status 201, `instructor_id`, `price`, INSERT params, default-course INSERT params, audit
ordering, `assertNoWrite` on the negative paths) are untouched.

The `database failure on create surfaces 500` case keeps its injected failure and now proves it again: the
failure is thrown on **`INSERT INTO lectures`** — the statement the create flow actually executes once the
binding check has passed for a real row. The test additionally asserts the video read ran first, so the 500
is provably the write failing, not the validation short-circuiting.

`server/tests/m2-c5-lectures-reorder-audit.test.ts` — the create test's responder gained a real
`videos['lesson']`-equivalent row (`id: 'lesson', tenant_id: 'tenant-a', course_id: 'course-a',
uploaded_by: 'instructor-a'`) and the tenant/course/authority/parent reads. The fixture answers the new reads
with tenant-consistent rows; it does not "return active for any query" and the expectation was not flipped
to 404. Insert-then-audit ordering assertions are unchanged.

### F.4 Correction 4 — `videos.ts` `/upload/init` mirror verdict

**Verdict: active, reachable, and now validated.** Not dead code:

- the router is the file's default export (`server/src/routes/videos.ts:2699`) and is mounted at
  `/api/videos` (`server/src/index.ts:227`);
- `router.post('/upload/init', authenticateToken, …)` (`:1534`) is registered on that router with no earlier
  terminating middleware, and it performs `INSERT INTO videos (… lecture_id, material_id …)` (`:1602`).

Change (minimal, no column dropped, no schema change): before the INSERT, a non-empty `lecture_id` is proven
with `SELECT c.tenant_id FROM lectures l INNER JOIN courses c ON c.id = l.course_id WHERE l.id = ?`, and a
non-empty `material_id` with the equivalent `course_materials` read. A missing row → 404
(`Lecture not found` / `Material not found`); a null or different tenant → 403 (`Lecture is outside this
workspace` / `Material is outside this workspace`). The comparison target is the video's own tenant — the
server-selected `req.user.tenantId` that the same INSERT writes into `videos.tenant_id` — so a foreign or
unproven target reference is refused before the row exists. The upload policy
(`evaluateCourseUploadPolicy(req.user!, course_id, courseUploadPolicyReader)`) and every existing check are
untouched; `m1-upload-contract` (94/94) and the static wiring assertions in `m1-media-socket-regressions`
stay green.

### F.5 Verification — actual counts and hashes

Commands, run from the repo root with the hermetic network guard preloaded:

```
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m1-video-link-binding.test.ts tests/m1-video-link-policy.test.ts
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m1-expanded-lecture-authority.test.ts
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m2-c5-lectures-reorder-audit.test.ts
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

| suite | before this correction | after |
|---|---|---|
| `m1-video-link-binding.test.ts` | 21 tests, 21 pass | **37 tests, 37 pass / 0 fail** |
| `m1-video-link-policy.test.ts` | 10 tests, 10 pass | **10 tests, 10 pass / 0 fail** (file unchanged) |
| `m1-expanded-lecture-authority.test.ts` | 44 tests, 38 pass / 6 fail | **44 tests, 44 pass / 0 fail** |
| `m2-c5-lectures-reorder-audit.test.ts` | 25 tests, 24 pass / 1 fail | **25 tests, 25 pass / 0 fail** |
| `m1-materials-boundary` | 42 pass | **42 pass** |
| `m1-video-route-boundary` | 35 pass | **35 pass** |
| `m2-content-release` | 72 pass | **72 pass** |
| `m1-media-socket-regressions` | 111 pass | **111 pass** |
| `m1-upload-contract` | 94 pass | **94 pass** |

The 16 new binding tests are: platform operator same-tenant allow (201) · platform operator cross-tenant deny
(`VIDEO_TARGET_TENANT_MISMATCH`, no write) · update re-proves the destination from the lecture row
(`VIDEO_TARGET_TENANT_MISMATCH`, no UPDATE) · `VIDEO_TENANT_CONFLICT` · `VIDEO_TENANT_UNPROVEN` (video) ·
`VIDEO_TENANT_UNPROVEN` (destination, platform path) · legacy two-parent video refused · five lecture-create
non-canonical variants (400, zero writes) · material-create non-canonical sweep (400, zero writes) ·
lecture-update non-canonical · material-update non-canonical · canonical persistence + conflict-probe
consistency.

`tsc --noEmit -p server/tsconfig.json` → **exit 0, zero diagnostics**. No pre-existing error from another
lane was present in this run; nothing outside my paths was touched.

Post-correction hashes (recomputed from disk):

| path | after sha256 | bytes |
|---|---|---|
| `server/src/routes/lectures.ts` | `5b8c5acadf6fe522709fde8c1fe11eb68987f43675f0105aac0902aec55e6b4d` | 47604 |
| `server/src/routes/videos.ts` | `cace5732ff9ae7666a8264db19c3a9fa9d6aaf9026c3b03a3818165d56d0303c` | 111107 |
| `server/src/routes/materials.ts` | `a3aaf909572d14cd926a8616dd8148a3770b0287ae6608b5b3385632bb4fd1ae` | 46042 |
| `server/src/security/video-access-policy.ts` | `91186fb538fa1a29b71fe9e3dd66f0ab78dad8d7c41894043cb1b35748b4032b` | 43722 |
| `server/tests/m1-video-link-binding.test.ts` | `aa7abcc2032e4fae1fec70e08aa4afbab07fdc2fe076db686ecb77e401d077be` | 48656 |
| `server/tests/m1-video-link-policy.test.ts` | `b1b9dba63f7df595e5b16e8ece1f95b7bfa5fc190347f06310e2ed22013ff33f` | 14414 |
| `server/tests/m1-expanded-lecture-authority.test.ts` | `fbae7be8690762f20cccad71847e2ea249f4c7f10197e8679f18db1b846f5e2b` | 52532 |
| `server/tests/m2-c5-lectures-reorder-audit.test.ts` | `f9ceb599c185ad5b6dbcdd27e5cf01f780e80ae1a3bc71960468934200db6d39` | 26883 |

This document's own hash cannot appear in its own content; its pre-correction hash is
`3321a381183908ceb549cdc0800e7efb85273700319b7fbe2d02eada013eb23b` (20141 bytes) and the appended section is
the only change to it.

### F.6 The exact remaining I2 constraint gap

No unique index, no binding table and no migration was added — the schema is untouched. What is still
**unprotected**:

1. **No database-level uniqueness on the association.** `lectures.video_url` and
   `course_materials.file_url` have no unique key (verified in the migrations by the previous worker, §A).
   Serialization rests entirely on `SELECT … FROM videos WHERE id = ? FOR UPDATE` inside each write
   transaction, and only for writers that use this seam. A direct SQL statement, a backfill script, an admin
   tool, or the `videos.lecture_id` / `material_id` mirror (now tenant-validated but still not part of the
   `video://` conflict probe) can still create a second parent.
2. **Cross-table duplication remains possible.** The conflict probe reads both tables, so this seam refuses
   a lecture-plus-material pair; but a unique index on `lectures` alone would not cover it, and no
   constraint enforces it.
3. **Legacy malformed references remain invisible** (F.2): `video:// x ` stored before the canonical rule is
   not seen by the exact conflict probe or by `CONCAT('video://', ?)`. Only a data repair plus a normalized
   constraint closes this.
4. **A unique constraint is not appliable as-is** to the current columns: any pre-existing duplicate or
   malformed value would have to be reconciled first, and a normalized binding table (unique on `video_id`)
   is the shape that would actually make the guarantee hold.

Until that lands, the honest statement is: *"serialized for writers that use this seam, and
tenant-consistent for every binding this seam accepts"* — not *"impossible to double-bind"*.
