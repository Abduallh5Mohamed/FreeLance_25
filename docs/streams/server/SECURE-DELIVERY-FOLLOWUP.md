# Secure delivery follow-up — server-owned entitlement on protected bytes

Task: `post-claude-secure-delivery-followup-20261018-01` (team `media`,
worker `wb-followup-secure-delivery-20261018-01`).
Branch `codex/workbuddy-server`, baseline HEAD `28288ed` plus the
uncommitted work already present in the shared worktree.
Scope: the proven F3 part-2 gap — `server/src/routes/secure-video.ts` served
manifest / media / segment / key and refreshed sessions without presenting or
verifying the server-owned playback entitlement. Issuance (`video-assets.ts`)
and the heartbeat check were already correct and are not reworked here.

No database, Docker, network, provider, migration, secret or `.env` was used.
No Git write was made. `parent-links` / `parent-views` / migration 13 and the
`assignments` / `certificates` surfaces were not touched.

## 1. Mapping — enforcement and the real video → lecture / material / course relation

The schema carries two independent link directions, and neither is unique:

- `videos.course_id NOT NULL`, `videos.lecture_id` and `videos.material_id`
  nullable with no foreign key (`server/migrations/20260920_11_video_system.sql:11-13`);
- `lectures.video_url = 'video://<videoId>'` and
  `course_materials.file_url = 'video://<videoId>'` (written by the lecture /
  material routes: `server/src/routes/lectures.ts:496,729`,
  `server/src/routes/materials.ts:550,660`).
- Upload init accepts `lecture_id` / `material_id` from the request body and
  writes them without validating the parent row
  (`server/src/routes/videos.ts:1533-1540,1603-1618`), so dangling and
  conflicting parent ids are possible server data.

| relationship case | current enforcement before this task | decision after this task |
| --- | --- | --- |
| video → course (always present) | Branch resolver treats the course as an explicit tenant-level parent and proves its tenant (`server/src/security/resource-branch.ts:732-738`). Access policy uses the video tenant else the course tenant (`server/src/security/video-access-policy.ts:209-211`). | Course is the tenant-level proof. A dangling course or unprovable course tenant is ambiguous and denied. |
| video → lecture via `videos.lecture_id` | Branch resolver loads the lecture, requires its tenant, and adds its branch (`resource-branch.ts:742-756`); a missing row is `dangling-lecture-parent` (`:744`). | Same branch decision is preserved. The new lesson resolver also treats a missing direct lecture as ambiguous. |
| video → lecture via `lectures.video_url = 'video://<id>'` | Access policy reads **one arbitrary** lecture with `LIMIT 1` (`video-access-policy.ts:349-353`). No uniqueness check. | The new resolver unions both directions and denies when more than one distinct lecture remains (`secure-video.ts:660-740`). |
| video → material via `videos.material_id` | Branch resolver loads the material and reconciles its group links (`resource-branch.ts:758-772`); a missing row is `dangling-material-parent` (`:760`). | Preserved for branch. The new resolver treats a missing direct material as ambiguous and rejects multiple materials. |
| video → material via `course_materials.file_url = 'video://<id>'` | The materials route only accepts the internal `video://` prefix (`materials.ts:550,660`); no uniqueness check exists. | The new resolver unions both directions and rejects multiple material parents. |
| ambiguous: video reachable from more than one lecture | Branch resolver may still return `tenant`; the access policy silently picks the first lecture (`LIMIT 1`). This is the proven arbitrary-parent defect. | **Denied** with `VIDEO_PARENT_AMBIGUOUS` for full-content sessions. Preview sessions remain confined to the truncated preview grant. |
| ambiguous: more than one material | Branch resolver reconciles branch links; a same-branch multi-material row can pass. | **Denied** with `VIDEO_PARENT_AMBIGUOUS`. |
| dangling: `videos.lecture_id` / `material_id` / `course_id` has no row | Branch resolver already denies the branch chain (`resource-branch.ts:733,744,760`). The access policy's `loadLecture` returns null and simply skips the lecture path. | **Denied** before the entitlement is bound; no "first parent" fallback. |
| conflicting: parent in another course | Branch resolver denies a group/course mismatch (`resource-branch.ts:573-575,626-628`); the video path checks `courseIds.size > 1` (`:778`). | **Denied** by the lesson resolver (`conflicting-course-provenance`). |
| conflicting: parent in another tenant | Branch resolver denies `conflicting-parent-tenant` (`resource-branch.ts:779`). | **Denied** by the lesson resolver (`conflicting-parent-tenant`). |
| conflicting: parent in another branch | Branch resolver denies `conflicting-branch-links` (`resource-branch.ts:780`). | Preserved unchanged; the entitlement check runs after the branch check. |
| legitimate tenant-level / independent video (course only, no lecture/material) | Branch resolver returns `scope: 'tenant'`; the existing exact-resource policy decides (`resource-branch.ts:782-794`). | **No lesson-bound entitlement exists.** The existing verified policy remains the authority; recorded as a product question below. |
| legitimate material-only video (no lecture) | Branch resolver returns `tenant` or `branch` from the material links; the access policy decides. | Same: no lesson to bind. Existing policy remains the authority; recorded as a product question. |
| preview offer (pending `instructor_video_offers`) | Preview session grants only `preview/playlist.m3u8`; the offer is rechecked on every refresh/delivery (`secure-video.ts:519-532`; path confinement at `:1385,1433`). | **Unchanged.** Preview sessions are exempt from the entitlement (no full-content grant), and the offer recheck is never weakened. |
| free flags (`lectures.is_free`, `course_materials.is_free`) | The secure-video path never consults `is_free`; publication/audience/release policy is the only grant. | No new free bypass is invented. `is_free` is not a playback grant in this path. |
| staff / instructor session (no `studentEnrollmentId`) | Existing verified policy (uploader / own lecture / assigned course / tenant owner / license) decides. | The per-student entitlement cannot bind a staff session; the existing policy remains the authority. Recorded as a product question. |

## 2. Defect and reproduction

**Defect.** The session token and the composed access policy were rechecked on
every manifest / media / key / refresh request, but the server-owned playback
entitlement (`playback_entitlements`) was never consulted on those paths. A
revocation of the entitlement (`POST /playback/entitlements/revoke`) therefore
stopped heartbeats but did not stop byte delivery while the session token and
the underlying access grant remained valid.

**Reproduction (real handlers, injected seams).** The new tests live in
`server/tests/m1-media-socket-regressions.test.ts` and drive
`createSecureVideoDeliveryRouter` as an Express router (real route matching,
real `req.params` / `req.query`, real handler code) with fake session,
entitlement, branch, policy, storage and clock seams. The client presents only
`sid` + `token`, exactly as today.

Pre-fix probe (the new checks temporarily short-circuited, all other code
unchanged) — `108 tests, 99 pass, 9 fail`, exit 1:

- `entitlement delivery: a valid session with no server-owned record is denied on manifest, media and key`
- `entitlement delivery: a revoked record denies the next request`
- `entitlement delivery: an expired record denies`
- `entitlement delivery: lesson, tenant and enrollment mismatches deny`
- `entitlement delivery: an ambiguous parent association denies even with a valid record`
- `entitlement session: a unique lesson issues a record bound to tenant, enrollment, lesson and session`
- `entitlement session: ambiguous parents deny before a session is created`
- `entitlement session: an issuance failure returns 503 and kills the session`
- `entitlement refresh: a revoked record denies and kills the session`

After the fix, the same file is `108 tests, 108 pass, 0 fail`, exit 0.
The positive control
(`entitlement delivery: a valid record serves the manifest, the segment and the key`)
serves all three byte paths with a valid record, so the enforcement is not a
blanket deny.

Additional mapping tests:
`video association: one lecture across both link directions resolves uniquely`,
`... two lectures are ambiguous, never "first match"`,
`... a dangling lecture id is ambiguous`,
`... a lecture in another course is conflicting provenance`,
`... a course-only (tenant-level) video has no lesson ...`,
`... a material-only video has no lesson ...`.

## 3. Fix

All changes are inside the approved paths.

- `server/src/routes/secure-video.ts`
  - `resolveVideoLessonAssociation` (`:660-740`) unions
    `videos.lecture_id` + `lectures.video_url` and
    `videos.material_id` + `course_materials.file_url`, checks the course and
    tenant of every parent, and returns `unique` / `none` / `ambiguous`.
    It never selects the first row.
  - `evaluateSessionEntitlement` (`:761-850`) loads the server records for the
    session and enforces: any revoked record denies; the newest record must
    match session + tenant + enrollment + the server-resolved lesson; it must
    be unexpired; a record inside the renewal window asks refresh to re-issue.
    Preview, staff (no enrollment) and lesson-less videos return
    `required: false` and keep the existing policy.
  - `createSecureVideoDeliveryRouter` (`:870`) builds the five routes over
    injected seams. The production export mounts the same factory with the real
    services (`:1562`), so the public paths and the `sid`/`token` contract are
    unchanged.
  - Session creation (`:1009`) resolves the lesson before creating the
    session, denies an ambiguous full-content association (`:1088-1095`), and
    issues the server-owned record bound to tenant / enrollment / lesson /
    session (`:1131-1150`). Issuance failure kills the session and returns
    `503 PLAYBACK_UNAVAILABLE`.
  - Refresh (`:1216`) re-resolves the association and rechecks the record
    (`:1266-1286`), re-issuing only when the valid record is near expiry
    (`:1288-1302`). A revoked/expired/mismatched record kills the session.
  - Manifest (`:1361`), media (`:1411`) and key (`:1454`) each check the
    record after the existing access + branch checks and before any bytes,
    URL or key leave the server (`:1381-1382`, `:1429-1430`, `:1485-1486`).
- `server/src/services/playback-entitlement.ts`
  - Optional `findBySessionId` on the store and service (`:229-243`,
    `:250-260`, `:326-329`) so delivery can read the server records without a
    client token. The SQL adapter reads `playback_entitlements` by
    `session_id`, newest first, bounded to 100 rows (`:401-445`). A store
    without the method fails closed (`store-unavailable`), it never skips the
    check.
- `server/tests/m1-media-socket-regressions.test.ts`
  - 21 additive tests: 15 delivery/session/refresh entitlement tests and 6
    video-association mapping tests, plus the shared harness. The existing
    dummy `MINIO_*` keys remain set before the first minio-constructing import
    (`:48-49`); the suite remains hermetic.
- `server/tests/m3-video-review-fixes.test.ts`
  - 2 additive tests for the delivery lookup seam: service delegation /
    session-id normalization and the SQL adapter's bounded newest-first read.

**Preserved bindings and failure codes.** The session JWT still binds
`sub` / `vid` / `sid` / IP hash / UA hash / fingerprint / screen resolution
(`server/src/middleware/auth.ts:390-464`). The active-session binding
(`isMediaSessionBound`), the composed access recheck, the branch recheck, the
preview confinement, the delivery rate limit and the suspension predicate are
unchanged. Existing 401/403/409/429 bodies are unchanged; the new denial adds a
`code` and `reason` field alongside the existing `error` string.

## 4. Commands actually run

Baseline (before any edit, HEAD `28288ed`):

| command | exit | counts | failures |
| --- | --- | --- | --- |
| `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/*.test.ts` (repo root) | 0 | tests 1804, pass 1804, fail 0 | none |
| `cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/*.test.ts` | 0 | tests 1804, pass 1804, fail 0 | none |
| `cd server && ../node_modules/.bin/tsc --noEmit` | 2 | 1 error | `src/services/parent-links.ts(429,31): TS18048` — sibling-owned file, outside this task |

Final (after the fix):

| command | exit | counts | failures |
| --- | --- | --- | --- |
| root suite | 0 | tests 1836, pass 1836, fail 0 | none |
| server-cwd suite | 0 | tests 1836, pass 1836, fail 0 | none |
| `cd server && ../node_modules/.bin/tsc --noEmit` | 2 | 1 error | the same `parent-links.ts(429,31): TS18048`; no error in any file this task touched |
| `git status --short && git diff --stat` | 0 | see below | only the allowed files from this task |

The suite total moved 1804 → 1836 (+32). This task added 23 tests: 21 in
`m1-media-socket-regressions.test.ts` (87 → 108 in that file) and 2 in
`m3-video-review-fixes.test.ts` (13 → 15). The remaining delta is from sibling
workers editing their own tests in the shared worktree (`m4-assignments`,
`m4-certificates`, etc.); none of those files were written by this task.

`git status` shows this task's changes only in:
`server/src/routes/secure-video.ts`,
`server/src/services/playback-entitlement.ts`,
`server/tests/m1-media-socket-regressions.test.ts`,
`server/tests/m3-video-review-fixes.test.ts`,
`docs/streams/server/SECURE-DELIVERY-FOLLOWUP.md`.
The sibling-modified files (`assignments.ts`, `certificates.ts`,
`attendance-records.ts`, `exam-versions.ts`, `gradebook.ts`,
`question-bank.ts`, `schedules.ts`, `student-enrollment.ts`, their tests,
`server/bootstrap/m1/manifest.json`, and the untracked `parent-*` / migration
13 files) were already modified or untracked when this run started and were
not touched.

## 5. Guarantees and residual dependencies

**Guarantees (verified hermetically).**

- A manifest, media/segment or key request with no server-owned record for the
  session is denied 403 before any content is read.
- A revoked or expired record denies the next request and kills the session.
- A record whose lesson, tenant or enrollment does not match the
  server-derived session facts denies.
- A video reachable from more than one lecture/material, or from a dangling /
  cross-course / cross-tenant parent, denies full-content session creation and
  delivery; the first parent is never chosen.
- A valid record serves the manifest, the segment and the key; the positive
  control is in the suite.
- The refresh path rechecks the record and only re-issues while a valid record
  is near expiry; a revoked record cannot be refreshed into a new grant.
- Preview sessions remain limited to the truncated preview and the existing
  pending-offer recheck; the entitlement is not an additional blanket gate.
- No client parameter was added and no existing client URL shape changed.

**Residual product / client / schema dependencies.**

1. **Product question — multi-lecture video ownership.** A video may be
   referenced by more than one lecture (both `videos.lecture_id` and
   `lectures.video_url` are non-unique). The server now denies full-content
   playback instead of picking one. Which lecture should own the entitlement:
   `videos.lecture_id` (the uploader's declared parent), a client-selected
   lesson (a contract change), or is multi-lecture reuse forbidden? Until
   decided, the ambiguous case is denied with `VIDEO_PARENT_AMBIGUOUS`.
2. **Product question — lesson-less and staff playback.** A course-only /
   material-only video has no lecture to bind, and a staff/instructor session
   has no `studentEnrollmentId`; the per-student entitlement model cannot
   represent either. Those paths keep the existing verified access policy.
   Should a separate non-student or resource-level entitlement family exist?
3. **Schema — session lookup index.** `playback_entitlements` has no index on
   `session_id` (`server/migrations/20261018_06_video_assets_entitlements.sql:106-120`).
   The delivery lookup is bounded to 100 rows, but a real deployment should add
   an index. Migrations are outside this task's write scope.
4. **Deployment — `VIDEO_PLAYBACK_SECRET`.** Delivery now fails closed when the
   secret is absent: a unique-lesson student session receives
   `503 PLAYBACK_UNAVAILABLE`. This matches the existing heartbeat/issuance
   fail-closed posture (F9); the secret must be configured before this ships.
5. **Client — refresh cadence.** No new parameter is required, but the client
   must keep calling `/refresh-token` (it already must, because the session
   token lives 60 s). That call is what renews the entitlement before its
   300 s TTL.
6. **No live verification.** The SQL adapter, the `playback_entitlements` row
   shape and the resolver queries are exercised through fakes only. No MySQL
   instance was contacted, so real column semantics and the missing index are
   not measured.
7. **Revocation granularity.** Revocation is per `jti`; the delivery path
   denies the session if any record for that session is revoked. A client that
   issues additional records through `POST /playback/entitlements` is still
   access-checked at issuance. A session-wide "revoke all" API does not exist
   and was not invented.
8. **Revoking the server-issued record.** The jti minted at secure-video
   session creation is deliberately not returned to the client (that would
   change the contract). An operator who needs to revoke that exact record can
   read its jti from `playback_entitlements` / the audit trail, or use the
   existing `POST /kill-session` (owner or verified platform capability) for a
   session-level stop. No new revocation endpoint was added.
9. **Per-request read cost.** A student delivery request now performs the
   lesson-association reads (up to five bounded queries) plus one
   `playback_entitlements` read, in addition to the existing access-policy and
   branch reads. No cache was introduced: a stale association could hide a
   newly ambiguous parent. A short-lived, invalidation-aware cache is a
   reasonable follow-up if profiling shows it is needed.
