# Media delivery & storage — remaining gap review (2026-10-20)

Task: `server-media-storage-gap-review-20261020-01` (team media, worker
`wb-server-media-storage-gap-review-20261020-01`). **Read-only source audit.**
No implementation file, test file, migration, config or shared doc was edited.
The only write of this task is this report.

- Repo: `C:/Users/abdua/OneDrive/سطح المكتب/FreeLance_25-1`
- Branch: `codex/workbuddy-server`, HEAD `03b7707bdf3a3e0c19a24768ed83d6e0d5ce40c3`
- Working tree was already dirty from earlier tasks; every other change is
  preserved untouched.
- Certificates are excluded by owner decision and are not assessed here.
- No provider was chosen, no new product feature is required by this review,
  and no acceptance is claimed. `reported` is not `accepted`.

## 1. Method and evidence classes

Every row below was proven against the **current** line of source at the HEAD
above; no finding is carried over from an earlier report. Earlier repairs were
re-read and, where they hold, they are listed as *closed* in §3 so they are not
re-reported.

Evidence classes used in the matrix:

| Class | Meaning |
|---|---|
| `source` | The behaviour is readable in the current source. No execution. |
| `hermetic` | A named test in the repo exercises the behaviour with injected seams (no DB, no network). Not executed by this task. |
| `live-unverified` | The outcome depends on a deployed provider, bucket ACL, process count or nginx file that source cannot prove. |

**Limitations of this review.** No test was run (other workers are writing; no
full suite now). No DB, Docker, migration, network, provider account or live
environment was touched. A `hermetic` label means *the test exists and asserts
this behaviour*, not that it passed today. Nothing here proves a MinIO/S3
provider property.

## 2. Sources audited (sha256, current tree)

```
33095f533612e1bb7f47b1dbd1c81c27477a7464d9d56c6e15bdeb0116f08035  server/src/routes/secure-video.ts
6de765b970b023c5ca0da64af4a960d8602255b757ef027f9a15a2dcbfac55e5  server/src/services/playback-entitlement.ts
172303e29033f753c4ed68491135d7a190b7c19df117c67d6a00ae719776dfda  server/src/services/video-security.ts
d5eef5f9508b991536f2139bb08c8b6868417963a875823a1be8db87c4aa15dc  server/src/services/minio.ts
6a5271092097252fb7aed7f25e6d2517d5999525cee937d58bd7521203bb648a  server/src/services/assignment-storage.ts
5f79f133829c5d7a23b2940729cda3d45f56a1718e347f3a4f6005c9e4bad0b5  server/src/routes/assignments.ts
5e0a8a007f6d295f0e6c7c47ed0bb4520575911d70d181ab60512551a06ab6b5  server/src/services/assignments.ts
99253d021659cd1d9dacfafc6dd30e8c4aecfdf1680dc5900a6c8cc43e02558f  server/src/routes/playback-sessions.ts
7a20560fd59bcb7a4d59f27c4713b6b2714d834f937d2200ecfb3511e9952183  server/src/services/playback-session-registry.ts
96c7fe7b76309d6452d96fcf40c3b6a51159f4d5516f6a2abaecffe1a86c129d  server/src/services/playback-progress.ts
60036ec32df7519c46991488ec4003cc465c9d95b4570b401e2d788a0de754ce  server/src/routes/video-assets.ts
ff3b593067d6f0c8fe155862bf97b3b3ecffb7a71a8a8e00d53bb9564d0ed15a  server/src/routes/lectures.ts
```

Also read (not hashed): `server/src/routes/parent-views.ts`,
`server/src/services/parent-links.ts`, `server/src/services/video-processor.ts`,
`server/src/services/tenant-export.ts`, `server/src/index.ts`,
`server/migrations/20261018_06_video_assets_entitlements.sql`,
`20261018_08_question_bank_assignments.sql`,
`20261018_15_playback_entitlement_indexes.sql`,
`20261017_02_missing_core_tables.sql`, `nginx-alqaed-fixed.conf`,
`nginx-hardened-v4.conf`, `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md`,
`docs/streams/server/ASSIGNMENT-STORAGE-COMPLETION-20261019.md`.

## 3. Prior repairs verified in the current source (deliberately not re-reported)

These were named as already repaired; each was re-proven here and is **closed**.
They appear in the matrix only where a residual defect remains.

| # | Claim | Proof in current source |
|---|---|---|
| P1 | Delivery re-checks the same access policy per request, not just at token issue | `routes/secure-video.ts:1368,1418,1477` call `evaluateDeliveryAccess` on manifest/media/key; branch re-derived at `:1375,1425,1481` |
| P2 | Server-owned entitlement is checked per byte request; one revocation denies | `routes/secure-video.ts:1381,1429,1485`; `:790-793` denies on any revoked record; `services/playback-entitlement.ts:317` reads revocation from the store on verify |
| P3 | Preview sessions cannot reach full media by path | `routes/secure-video.ts:1385,1433` plus strict path regexes `:1386,1434` (no traversal; `..` cannot match) |
| P4 | Ambiguous video parents deny instead of "pick the first" | `routes/secure-video.ts:660-724`; denied at session create `:1089-1095` and at delivery `:770-772` |
| P5 | Entitlement secret has no JWT fallback | `routes/secure-video.ts:1556` (`process.env.VIDEO_PLAYBACK_SECRET` only) |
| P6 | Private assignment bucket, no policy capability | `services/minio.ts:96-124` (surface is `bucketExists`/`makeBucket` only), `:131` |
| P7 | Finalize verifies key binding, size, stored type, magic bytes from storage | `routes/assignments.ts:885-960` |
| P8 | In-request object-version re-check (ETag + size) before any write | `routes/assignments.ts:1010-1026` |
| P9 | Scanner absence fails closed (`pending_scan`, never `clean`) | `routes/assignments.ts:968-1002,1450` |
| P10 | Bounded scan (wall clock, timer cleared) | `services/assignment-storage.ts:120-136` |
| P11 | Parent view tokens are per-link, re-verified per request, single child only | `routes/parent-views.ts:94-119`; each query scoped by token tenant + enrollment `:186-258` |

Note (documentation drift only, no defect): `services/playback-entitlement.ts:433-436`
still says the table "has no session_id index yet"; `migrations/20261018_15_playback_entitlement_indexes.sql:47-62`
adds `idx_playback_entitlements_session` and `idx_playback_entitlements_tenant_session`.

## 4. Gap matrix

Verdict: `closed` = no remaining defect in this requirement;
`partially` = the stated property holds on one path but not all reachable paths;
`open` = the defect exists in the current source.

### 4.1 Secure video delivery, entitlement, playback sessions

| # | Requirement | Current source | Evidence | Verdict | Concrete remaining defect |
|---|---|---|---|---|---|
| V1 | Revocation enforced per request | `routes/secure-video.ts:1381,1429,1485` → `:761-825` → `services/playback-entitlement.ts:447-453` | source + hermetic (`tests/m1-media-socket-regressions.test.ts:2364-2375`, "a revoked record denies the next request") | **closed** (enrollment-bound sessions) | None on this path. |
| V2 | Entitlement coverage outside the per-student model | `routes/secure-video.ts:767` (preview), `:773` (no tenant/enrollment → staff), `:774` (no unique lesson) | source | **partially** | For staff, preview and non-unique-parent sessions no entitlement record exists, so `required:false` and the only gate is the video-access policy + branch. A revoked `jti` is meaningless there and the model gives no per-session revocation handle for staff playback. Recorded as a product question at `:756-759`; the code does not silently widen, but coverage is narrower than the requirement's wording. |
| V3 | A playback-session revocation ends delivery | `routes/playback-sessions.ts:300-331` → `services/playback-session-registry.ts:313,744` | source | **open** | `revokeSession` writes only the playback-registry tables; it never calls `killSession` and never touches `video_sessions` or the in-memory map in `services/video-security.ts:63-64`. `support-revoke` returns `{revoked:true}` while manifest/segment/key delivery keeps serving. |
| V4 | Multi-parent ambiguity: which parent may see what | resolver `routes/secure-video.ts:660-724`; reverse lookups `:633-652`; write path `routes/lectures.ts:490-498,572-582` | source + hermetic (ambiguous denies: `tests/m1-media-socket-regressions.test.ts:2438`, `:2482`) | **partially** | Detection is correct and deny-by-default, but nothing prevents the ambiguous state at write time: `lectures.ts` accepts any `video://<id>` without checking that the video exists, is ready, is in the caller's tenant, or is not already linked, and `migrations/20261017_02_missing_core_tables.sql:8` declares `video_url TEXT NULL` with no uniqueness. Any instructor in any tenant can create one lecture row pointing at a foreign video and make that video unplayable for everyone, including its owner (see R1). |
| V5 | Private storage policy (bucket visibility, object ACLs) | `services/minio.ts:96-124,131`; `nginx-alqaed-fixed.conf:46-89`; `nginx-hardened-v4.conf:131-136` | source + **live-unverified** | **partially** | Source proves the server never grants a policy and creates buckets privately. It cannot prove the deployed buckets have no out-of-band policy. Two nginx configs in the repo disagree: `nginx-alqaed-fixed.conf:46-89` proxies `/storage/` straight to `minio` with no auth (`proxy_pass http://minio`), while `nginx-hardened-v4.conf:131-136` denies it. If the permissive file is the deployed one, the HLS/originals buckets are protected only by their ACL. |
| V6 | Revocation and delivery state survive process boundaries | `services/video-security.ts:63-64,156-183` | source + **live-unverified** | **open** (conditional) | Sessions live in per-process `Map`s. With more than one backend instance, a `killSession` on instance A does not stop delivery on instance B, and a request routed to B sees `getActiveSession → null` (401). Single-process is the only safe deployment shape today and is not asserted anywhere. |
| V7 | Preview containment | `routes/secure-video.ts:1385,1433,1454-1511`; `services/video-processor.ts:413-419` | source | **partially** | The preview rendition is encrypted with the **same** key as the full rendition (`video-processor.ts:416` reuses `encryptionKeyInfo`), and the key route has no preview scope. Containment of a preview viewer therefore rests entirely on the `preview/` path check in the manifest/media handlers. Acceptable as defence in depth, but there is no second barrier. |
| V8 | Entitlement store fails closed on missing state | `services/playback-entitlement.ts:447-453` | source | **open** (low) | `isRevoked` returns `false` when the row is absent, so a token whose record was pruned still verifies on the token path (`verify`, used by `routes/video-assets.ts:370`). The delivery path is safe because `findBySessionId` returning `[]` denies (`:786-788`). No prune path exists today, so reachability is theoretical. |
| V9 | Issued-at is validated | `services/playback-entitlement.ts:183-204` | source | **open** (low) | Only `expiresAtMs` is compared to now; a future-dated `issuedAtMs` is accepted. Requires clock skew or a forged store write. |

### 4.2 Assignment upload, finalize, scanning, storage

| # | Requirement | Current source | Evidence | Verdict | Concrete remaining defect |
|---|---|---|---|---|---|
| A1 | `pending_upload` is a real state with an exit | `routes/assignments.ts:697-710` (row created `status='submitted'`, size 0); `services/assignments.ts:429-435` | source + hermetic (state derivation `tests/m4-assignment-storage.test.ts:130`) | **open** | An abandoned upload has no exit: no cancel, no expiry, no sweep. The row counts as an active submission, so `resubmission_policy='block'` answers `RESUBMISSION_BLOCKED` forever and `max_submissions` is silently consumed by attempts that never stored a byte. A browser crash between create and PUT permanently locks a student out of that assignment. |
| A2 | Byte size is bounded at admission | `routes/assignments.ts:417-445` (`max_bytes` is a response field only); `services/assignment-storage.ts:371-374` (`presignedPutObject`, no conditions); `services/assignments.ts:51` (`MAX_FILE_BYTES_LIMIT` 2 GiB) | source | **open** | SigV4 presigned PUT cannot bind `Content-Length`; nothing bounds the bytes a client may write to the private bucket inside the URL window (up to 600 s). Enforcement happens only at finalize (`:924-935`), i.e. after the bytes are already stored, and only if the client ever calls finalize. |
| A3 | A finalized object cannot change | `routes/assignments.ts:863-865` (idempotent short-circuit, no re-stat); `:761-836` (re-auth refused once size > 0, but an earlier URL is not revoked) | source + hermetic (`tests/m4-assignment-storage.test.ts:739,771` cover only the in-request window) | **partially** | The in-request ETag re-stat closes stat→scan→write. It does not close write→**after**: the key is deterministic and a URL issued at create stays valid after finalize, so the same student can re-PUT different bytes to the same key. The row keeps the old `file_size_bytes`/`scan_status` and `finalize` short-circuits without re-stating, so persisted facts no longer describe the stored object. Latent today only because no read path exists; it becomes a real leak the moment a download or scan worker is added. |
| A4 | `pending_scan` reaches a verdict | `routes/assignments.ts:968-1002,1443-1450`; no worker (`index.ts:389,412,430` are unrelated timers) | source | **open** (by design, operational) | Production injects no scanner, so every verified upload is `pending_scan` (202) permanently and `clean` is unreachable. The contract's download gate (`docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md:195-200`) therefore denies all submissions forever. Deliberate fail-closed behaviour, but the feature is not usable end-to-end. |
| A5 | Bounded scanner failures | `services/assignment-storage.ts:120-136`; `routes/assignments.ts:971-1002` | source + hermetic (`tests/m4-assignment-storage.test.ts:813` "exceeds the wall-clock bound fails closed", `:539` "scanner that cannot answer is 502") | **partially** | Timeout and error handling are correct and bounded. There is no retry policy at all: one attempt, no attempt counter, no backoff, no queue, no rate limit on `finalize`. Recovery depends on the client re-calling finalize, and an unlimited number of re-calls is accepted. |
| A6 | Byte-size, content-type and magic-byte checks | `routes/assignments.ts:924-960`; `services/assignment-storage.ts:207-292`; `services/assignments.ts:328-342` | source + hermetic (`tests/m4-assignment-storage.test.ts:365,382,395,411,420`) | **closed** | None. Size is integer-bounded both ways, stored MIME must equal the expected MIME for the extension, and the bounded 4 KiB prefix must match the magic bytes; every failure removes the object best-effort. |
| A7 | Client-supplied object facts are rejected | `services/assignments.ts:277-279,305-319`; `routes/assignments.ts:867-870` | source + hermetic (`:139,326,434`) | **closed** | None. |
| A8 | The private key never leaves the API | `routes/assignments.ts:360-362,481-505` | source | **open** (low) | The submission projections exclude `storage_key`, but the tenant export selects it verbatim (`services/tenant-export.ts:183`, typed at `:262`) into a downloadable owner-scoped artifact. The key is useless without bucket credentials, but it contradicts the stated invariant. |
| A9 | State machine matches persisted values | `services/assignments.ts:45,292-297`; `routes/assignments.ts:863-865,1075-1082` | source | **open** (low) | `scan_status='failed'` is declared and mapped to `quarantined`, but no code writes it (a failed scan leaves the row untouched), so that branch is dead. A quarantined row returns `422` on first finalize and `200` on retry, so a client that only checks the status code reads a quarantined file as accepted. |
| A10 | A staff member can retrieve a submission | no route exists | source | **not a gap** | Declared future work by the contract (`:195-200`); excluded here because it would be a new product feature. Listed as a question in §7. |

## 5. Reachability of the open items

| # | Reachable today by a real request? | Path / precondition |
|---|---|---|
| V3 | **Yes** | An admin calls `POST /api/playback/sessions/:id/support-revoke` (`routes/playback-sessions.ts:331`) while the same user plays through `/api/secure-video/*`; delivery continues. |
| V4 | **Yes** | Any instructor with a course in their own tenant calls lecture create (`routes/lectures.ts:572`) with `video_url = 'video://<foreign video id>'`; the owner's next session create returns `403 VIDEO_PARENT_AMBIGUOUS` (`routes/secure-video.ts:1089-1095`). No data is disclosed; availability is. |
| V5 | **Conditional** | Requires the deployed nginx to be `nginx-alqaed-fixed.conf` **and** the bucket to carry an out-of-band policy. Both are live facts, not source facts. |
| V6 | **Conditional** | Requires more than one backend process behind the proxy. |
| V8 | **No** | No prune/delete path exists for `playback_entitlements`. |
| V9 | **No** | Requires a future-dated row, which the issuer never writes. |
| A1 | **Yes** | A student creates a submission and the browser dies before the PUT; with `resubmission_policy='block'` the next attempt is `403 RESUBMISSION_BLOCKED` (`services/assignments.ts:430-432`). |
| A2 | **Yes** | The student PUTs an arbitrarily large body to the issued URL; storage accepts it until finalize rejects and removes it, or forever if finalize is never called. |
| A3 | **Yes** | The student finalizes, then re-PUTs to the same key with the still-valid URL (≤ 600 s). Persisted size/scan no longer match the object. |
| A4 | **Yes, always** | Every finalized upload in production is `pending_scan`. |
| A5 | **Yes** | Repeated `POST /:id/submissions/:sid/finalize` calls are accepted without limit once a scanner exists; today the 202 path is cheap. |
| A8 | **Yes** | Tenant owner starts an export (`routes/tenant-export.ts:159`) and downloads it (`:236`). |
| A9 | **Yes** | Any client that treats `200` from finalize as success. |

## 6. Real provider evidence — what is proven vs assumed

No code in this repo proves a provider behaviour. Specifically:

| Assumption | Where it is asserted | Proven? |
|---|---|---|
| `makeBucket` yields a bucket with no anonymous access | `services/minio.ts:89-106` comment; `tests/m1-storage-config.test.ts` static guard | **No.** Only "no `setBucketPolicy` call exists" is proven. The live ACL is unverified. |
| A presigned PUT cannot bind `Content-Type` / `Content-Length` | `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md:240-242` | **No.** Stated as fact; no audit note and no test, unlike the SDK stream audit at `services/minio.ts:278-287`. |
| `getPartialObject(key, 0, n)` returns at most `n` bytes | `services/assignment-storage.ts:349-369` | **No.** The adapter trims defensively, so the outcome is bounded either way, but the provider contract is assumed. |
| `statObject().metaData` exposes the stored content type under a case-insensitive `content-type` key | `services/assignment-storage.ts:312-320` | **No.** Handled case-insensitively, so a naming difference is tolerated, but not verified. |
| `/storage/` reaches MinIO without authentication | `nginx-alqaed-fixed.conf:46-89` | **Unverified** which nginx file is deployed. |
| The backend runs as one process | implied by `services/video-security.ts:63-64` | **No.** Nothing in source asserts the deployment shape. |

## 7. Proposed follow-ups (file-disjoint, ordered by risk)

All are proposals. None is approved by this report, and each needs its own
approved scope. Sizes are scope sizes, not durations.

**F1 — Validate the video→lecture/material binding at write time (risk: high).**
Prevents the cross-tenant availability attack in V4 and removes the accidental
self-DoS.
- `allowedPaths`: `server/src/routes/lectures.ts`, `server/src/routes/materials.ts`, `server/tests/m4-lecture-parent-binding.test.ts` (new)
- `dependencies`: none
- Acceptance: creating a lecture with a `video://` id that does not exist, is
  not `ready`, belongs to another tenant, or is already linked is rejected with
  a stable code; a legitimate link still succeeds; a test proves the resolver
  never reports `ambiguous` for a link created through the API.
- Size: **S–M** (2 route files + 1 test file).
- Note: a DB uniqueness constraint is **not** included (a shared migration).

**F2 — Give `pending_upload` an exit (risk: high).**
- `allowedPaths`: `server/src/services/assignments.ts`, `server/src/routes/assignments.ts`, `server/tests/m4-assignments.test.ts`
- `dependencies`: none
- Acceptance: an abandoned `pending_upload` version no longer blocks
  resubmission and no longer consumes `max_submissions`; the rule is applied in
  one place (the pure policy), covered for both `block` and `allow`; no
  client-supplied state can trigger it.
- Size: **M**.

**F3 — Bound bytes at admission (risk: high).**
- `allowedPaths`: `server/src/services/assignment-storage.ts`, `server/src/routes/assignments.ts`, `server/tests/m4-assignment-storage.test.ts`
- `dependencies`: **F2** (same route file — see §8)
- Acceptance: a PUT larger than the assignment limit is refused by storage
  before the body is stored, or the adapter no longer issues a capability that
  cannot be bounded; the chosen mechanism is recorded in the contract; the
  oversize finalize path stays as defence in depth.
- Size: **M** (may need a provider capability decision — see Q3).

**F4 — Make a finalized object immutable (risk: medium-high).**
- `allowedPaths`: `server/src/routes/assignments.ts`, `server/src/services/assignment-storage.ts`, `server/tests/m4-assignment-storage.test.ts`
- `dependencies`: none in code; a persisted-provenance migration is **excluded** and must be its own task
- Acceptance: after a successful finalize, a re-PUT to the recorded key cannot
  produce an object that the row still vouches for (key rotation per attempt, or
  a re-stat on every read, or a documented denial); a test drives
  finalize → overwrite → read and proves the mismatch is detected.
- Size: **M**.

**F5 — Bridge playback-registry revocation to delivery (risk: medium).**
- `allowedPaths`: `server/src/routes/playback-sessions.ts`, `server/tests/m7-playback-revocation.test.ts` (new)
- `dependencies`: none (imports `killSession` read-only)
- Acceptance: `support-revoke` and self-revoke end byte delivery for the
  corresponding secure-video session, or the API stops claiming revocation; a
  test proves the delivery handler denies after the revoke.
- Size: **S**.

**F6 — Fail closed on missing entitlement state (risk: low).**
- `allowedPaths`: `server/src/services/playback-entitlement.ts`, `server/tests/m3-video-review-fixes.test.ts`
- `dependencies`: none
- Acceptance: a valid signature over a non-existent `jti` is denied on the
  token path; `issuedAtMs` in the future is denied; existing delivery tests stay
  green.
- Size: **S**.

**F7 — Stop exporting the private object key (risk: low).**
- `allowedPaths`: `server/src/services/tenant-export.ts`, `server/tests/m8-tenant-export.test.ts`
- `dependencies`: none
- Acceptance: the export manifest no longer contains `storage_key`; the export
  still lists every submission row and its verified size/scan status.
- Size: **S**.

**F8 — Align the submission state machine with its documentation (risk: low).**
- `allowedPaths`: `server/src/services/assignments.ts`, `server/src/routes/assignments.ts`, `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md`
- `dependencies`: **F2** (same files)
- Acceptance: `scan_status='failed'` is either written or removed from the enum
  and the derivation; a quarantined retry does not answer `200`.
- Size: **S**.

**F9 — Operations, no application code (risk: high, but not a code task).**
- `allowedPaths`: none in `server/src`; an infra-owned change plus a verification note
- Acceptance: the deployed nginx denies `/storage/` and `/uploads/` object
  paths (matching `nginx-hardened-v4.conf:131-136`), and an anonymous GET
  against every bucket returns 403. Evidence must come from the live host, not
  from a config file in the repo.
- Size: **S** (verification-heavy).

## 8. Shared-file conflicts between the proposals

`server/src/routes/assignments.ts` is needed by **F2, F3, F4 and F8**;
`server/tests/m4-assignment-storage.test.ts` by **F3 and F4**;
`server/src/services/assignments.ts` by **F2 and F8**.

Recommendation: **serial ownership** of the assignment chain in the order
F2 → F3 → F4 → F8, one claim at a time. F1, F5, F6 and F7 are disjoint from
that chain and from each other, so they can run in parallel with it. F9 touches
no application file.

## 9. Commands run

Read-only only. No test, build, migration, DB, Docker, network or provider call.

```
git status --porcelain ; git branch --show-current ; git rev-parse HEAD
sha256sum <the 12 sources listed in §2>
grep -rn / sed -n / wc -l over the modules, routes, migrations, nginx configs and docs listed in §2
```

## 10. Blockers and questions

No blocker: the audit is complete and the report is written.

1. **Q1 (V5/F9):** which nginx file is deployed? `nginx-alqaed-fixed.conf`
   proxies `/storage/` to MinIO unauthenticated; `nginx-hardened-v4.conf`
   denies it. Source cannot decide this, and the answer changes V5 from
   "partially, latent" to "open, live".
2. **Q2 (V6):** is the backend guaranteed to run as a single process? If not,
   the in-memory session store needs to become shared before revocation can be
   claimed per request.
3. **Q3 (A2/F3):** bounding bytes at admission needs a provider capability
   (S3 POST policy with `content-length-range`, or a server-proxied upload).
   Both are product/provider decisions, so this review deliberately does not
   choose one.
4. **Q4 (A4):** is a scanner being procured? Until then `pending_scan` is
   terminal and the assignment feature is unusable end-to-end by design.
5. **Q5 (A10):** is a staff download endpoint in scope for M4, or is
   "no download" the accepted product state? This review treats it as a
   product question, not a gap.
6. **Q6 (V2):** should staff playback receive its own revocable entitlement, or
   is the video-access policy the accepted authority for staff? The code records
   this as an open product question at `routes/secure-video.ts:756-759`.
