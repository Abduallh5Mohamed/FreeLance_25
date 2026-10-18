# Security Review — Milestones M2 & M3 (Tabweb Teachers)

Scope (read-only): tenancy/branch isolation, IDOR, authz, playback token weaknesses,
webhook/callback signatures, session-limit races, CSV import, host-header confusion,
SSRF, SQLi, non-idempotent/destructive migrations, secret leakage.

Files reviewed:
- routes: `content-access.ts`, `tenant-branding.ts`, `tenant-domains.ts`, `announcements.ts`,
  `student-import.ts`, `video-assets.ts`, `playback-sessions.ts`
- services: `content-release.ts`, `lesson-progress.ts`, `tenant-host.ts`, `announcements.ts`,
  `student-csv-import.ts`, `video-asset-lifecycle.ts`, `playback-entitlement.ts`,
  `video-usage-events.ts`, `playback-session-registry.ts`, `playback-watermark.ts`,
  `playback-progress.ts`, `domain-verification.ts`
- mounts: `server/src/index.ts` (~140–202) plus supporting guards
  (`middleware/auth.ts`, `middleware/tenant-authority-boundary.ts`,
  `middleware/student-workspace-boundary.ts`, `security/resource-branch.ts`, `db.ts`)
- migrations: `20261018_03..07`

Status: COMPLETE

---

## Findings

### F1 — MEDIUM: Client can raise its own playback concurrency/device limits (control bypass)
`server/src/routes/playback-sessions.ts:89-99` reads `body.policy` / `body.playbackPolicy`
and passes it into `registry.acquireSlot(...)`. `server/src/services/playback-session-registry.ts:233`
then uses that caller-supplied policy instead of the tenant policy:
`const policy = input.policy ? normalizePlaybackPolicy(input.policy, input.tenantId) : getPolicy(...)`.
`normalizePlaybackPolicy` only clamps to `> 0` (no ceiling), so a student can send
`{"policy":{"maxConcurrentSessions":1000,"maxDevices":1000}}` and defeat the V5 anti-sharing limits.
Verified: the route never strips/overrides the client policy.
Fix: ignore `body.policy` for non-privileged callers; always resolve policy server-side
(`getPolicy(tenantId)`), and clamp `maxConcurrentSessions`/`maxDevices` to a server maximum.

### F2 — MEDIUM: IDOR on device/session listing via `userId` query (within-tenant privacy leak)
`server/src/routes/playback-sessions.ts:337` (`GET /devices`) and `:400` (`GET /sessions`)
accept `req.query.userId` and pass it to `registry.listDevices/listSessions` with **no check
that the caller may read that user**, for every role (the only guard is the `tenantId` selector,
which is itself blocked by the global boundary). A student with a workspace can enumerate other
users' device fingerprints/labels (`:339`) and active sessions (`:403`) inside their tenant.
Verified: neither handler compares `userId` to `user.id` for non-privileged callers.
Fix: for non-privileged callers force `userId = user.id` (drop the query value), as already done
for the tenant dimension.

### F3 — MEDIUM: Playback entitlement tokens are issued but never verified; issuance is not access-checked
`server/src/routes/video-assets.ts:233-246` issues a bound, revocable token via
`deps.entitlement.issue(...)`, and `server/src/services/playback-entitlement.ts:212` exposes
`verify(...)`. A repo-wide search shows `PlaybackEntitlementService.verify` has **no callers** —
only `issue`, `load`, `revoke` are used (`video-assets.ts:233,263,270`). Actual playback gating is
the separate JWT scheme in `secure-video.ts` (`verifyVideoSessionToken`). Consequences:
(a) the M3 binding/expiry/revocation control is not enforced anywhere; (b) issuance only checks
`lesson.tenantId === principal.tenantId` (`video-assets.ts:229-232`) and never checks the lesson is
published or in the caller's course/audience, so any student in a tenant can mint a token for any
lesson of that tenant (including unpublished/archived).
Fix: have the streaming route call `entitlement.verify(token, {tenantId,lessonId,studentEnrollmentId,sessionId})`
before serving media, and reuse the composed content-access policy at issuance so only
in-audience, released lessons can be entitled.

### F4 — MEDIUM: Session/device/progress state is in-memory only; migration 07 tables are unused
`server/src/services/playback-session-registry.ts:113-117` and
`server/src/services/playback-progress.ts:113-116` hold all state in `Map`s; the production factories
never inject a DB store. `server/migrations/20261018_07_playback_sessions_progress.sql` creates
`playback_tenant_policies`, `playback_devices`, `playback_session_slots`, `playback_progress`, but no
code reads/writes them (grep shows no SQL adapter). Effects: limits, device revocations and resume
positions are lost on restart and are **per-process**, so a horizontally-scaled deployment lets a
user bypass the concurrent-session/device caps (and a revoked device re-plays) by hitting a different
instance. Verified: no `createSql*Store` exists for the registry/progress.
Fix: implement SQL-backed adapters and inject them, or run a single instance until then; document
the per-process limitation as a known control gap.

### F5 — LOW/MEDIUM: Any principal in a tenant can revoke another student's entitlement
`server/src/routes/video-assets.ts:263-270`: after `load(jti)`, revocation is allowed whenever
`record.tenantId === principal.tenantId` (or platform admin). There is no ownership check tying the
record's `studentEnrollmentId` to the caller. A student can revoke any other student's playback
entitlement in the same tenant (denial of playback, if F3 is fixed).
Fix: require the caller to own the record (`record.studentEnrollmentId === principal.studentEnrollmentId`)
or be a tenant admin/platform admin.

### F6 — LOW: Student CSV import is not atomic despite its idempotency guarantee
`server/src/routes/student-import.ts:92-94` defaults `runAtomic` to `fn(db)` and the production wiring
(`:429-436`) passes no `transaction`, so the INSERT/UPDATE loop + batch insert + audit run outside any
transaction (`db.ts` exposes no transaction helper). Race/replay path: `:250` and `:262` both miss the
batch, then `:265-285` insert students before the unique batch key (`20261018_05:100-101`) rejects the
second batch insert — leaving duplicate `students` rows committed with no batch record. The header/comment
claim of an atomic, idempotent import is therefore untrue.
Fix: wire a real transaction (connection with BEGIN/COMMIT) into `deps.transaction` and re-check idempotency
after acquiring it, or make the batch insert the first statement and rely on a rolled-back transaction.

### F7 — LOW: Unbounded watch-usage inflation via client-chosen `sessionId`
`server/src/routes/video-assets.ts:282-307` (`POST /usage/heartbeat`) derives the dedupe key from the
**client-supplied** `sessionId` (`video-usage-events.ts:63-73`) and accepts `deltaSeconds` up to 3600
(`:27`), with no per-principal rate limit. A student can issue unlimited distinct `sessionId`s and each
one records up to 3600 watch-seconds for their tenant, inflating usage aggregates and growing
`video_usage_events`.
Fix: bind heartbeats to a server-issued session id (or the entitlement/session registry), cap the
aggregate per enrollment/window, and rate-limit.

### F8 — LOW: Signed provider callbacks carrying `tenant_id` are rejected before signature verification
The global guard `server/src/index.ts:147` runs `enforceTenantAuthorityBoundary` for all `/api` paths,
and `server/src/middleware/tenant-authority-boundary.ts:4-23` rejects **any** body/query key named
`tenant_id`/`tenantId`/`tenant` with HTTP 400. Both provider callbacks read exactly that field:
`video-assets.ts:191` (`/callbacks/:provider`) and `:322` (`/usage/provider`). A legitimate provider
payload that includes `tenant_id` is therefore rejected 400 before the HMAC verifier can run, so the
tenant-attribution branch of the lifecycle is unreachable and signed callbacks fail closed-open.
Fix: exempt the unauthenticated callback routes from the tenant-selector boundary (or have them read the
tenant from a non-conflicting field / header), keeping the signature check as the trust anchor.

### F9 — LOW: Secret reuse for playback tokens
`server/src/routes/video-assets.ts:474` signs playback entitlements with
`process.env.VIDEO_PLAYBACK_SECRET || process.env.JWT_SECRET`. Falling back to the session-JWT secret
couples two independent token families to one key (different wire formats today, but a single
compromise/rotation now affects both).
Fix: require a dedicated `VIDEO_PLAYBACK_SECRET` and fail closed (already returns `secret-unavailable`)
rather than falling back to `JWT_SECRET`.

### F10 — LOW: `registerDevice` does not enforce `maxDevices` (unbounded in-memory growth)
`server/src/services/playback-session-registry.ts:160-165`: the limit check is an empty branch
("still create? deny...") and a new device row is created anyway; the real cap is applied later in
`acquireSlot` with a `>` comparison (`:236`). Varying the fingerprint creates unlimited device rows
even when no slot is granted (memory growth / no hard device ceiling).
Fix: reject registration at `>= maxDevices` (or evict oldest), and enforce the cap in `registerDevice`.

### F11 — LOW: Cross-tenant prerequisite lecture is not validated on release configuration
`server/src/routes/content-access.ts:665-675`: `PUT /releases/:lectureId` verifies authority and tenant
for the lesson, and rejects a self-prerequisite, but does not verify `prerequisite_lecture_id` belongs to
the same course/tenant. An owner/instructor can point a sequential gate at a lecture in another tenant.
No direct data exposure, but it breaks the tenant-scoped release invariant.
Fix: resolve the prerequisite lecture and require `course_id`/`tenant_id` to match the configured lecture.

---

## Checked and clean (verified, no finding)

- `server/src/services/content-release.ts` — pure clock/parsing; deny-by-default; invalid schedule/timezone
  denied; no request data. Clean.
- `server/src/services/lesson-progress.ts` — completion keyed on `(student_enrollment_id, lecture_id)`;
  writes tenant/enrollment/course/lecture only from server state; duplicate-key handled idempotently. Clean.
- `server/src/routes/content-access.ts` (aside from F11) — every read/write funnels through
  `evaluateContentAccess`; enrollment re-selected by verified principal + `user_id`; tenant/audience/branch
  are server-derived; denials 404 for enumeration, 403 only for not-yet-released/prerequisite. Staff scoping
  via `enforceStaffScope` + `resolveResourceBranchAccess`. Parameterized SQL. Clean.
- `server/src/security/resource-branch.ts` — branch authority derived only from server-written parent chains;
  client `requestedBranchId` is a constraint, never authority; conflicting/ambiguous links denied. Clean.
- `server/src/routes/tenant-branding.ts` and `server/src/routes/tenant-domains.ts` — owner-only via
  `resolveOwnedTenant` (`loadActiveTenantAuthority === 'owner'`); branding SQL builds only from a fixed
  column allow-list with bound params; domain claim cross-tenant gate enforced both pre-check and in
  `savePendingClaim` (conditional `ON DUPLICATE KEY UPDATE`), so the claim TOCTOU race is closed. Clean.
- `server/src/services/domain-verification.ts` — strict deny-by-default hostname validation (IP literals,
  localhost, internal TLDs, punycode, reserved labels); TXT challenge compared by exact equality; resolver
  errors fail closed (no SSRF to internal names). Clean.
- `server/src/services/tenant-host.ts` — deny-by-default host→tenant resolution with port stripping,
  single-label subdomain enforcement and verified-domain-only custom hosts. Note: **not referenced by any
  route** (grep: only self-references), so no live host-header tenant confusion exists. Clean/unused.
- `server/src/services/announcements.ts` and `server/src/routes/announcements.ts` — audience filters are
  static SQL with bound `branch_id`/`group_id`; student viewer's branch/group loaded from server rows;
  branch/group targets validated in-tenant before writes; optimistic version guards. Clean.
- `server/src/services/student-csv-import.ts` — hard byte/row/column limits; forbidden `password`/`hash`
  headers rejected; CSV formula-injection neutralized in exported cells (`neutralizeCsvCell`); branch scoping
  on the validated batch, no per-row foreign references; parameterized queries. Clean (see F6 for the
  route-level transaction gap).
- `server/src/services/playback-entitlement.ts` — token codec is HMAC-SHA256 with constant-time compare,
  bounded TTL (≤300s), strict claim parsing, and deny-by-default binding/expiry/revocation logic. The
  weakness is wiring (F3/F5), not the codec. Clean.
- `server/src/services/video-asset-lifecycle.ts` — signature checked before any state change, cross-tenant
  claim rejected against the stored row, idempotent callback ledger via `UNIQUE(provider, callback_id)`,
  bounded retries/dead-letter. Clean.
- `server/src/services/video-usage-events.ts` — per-event caps, bound dedupe keys, tenant from server
  principal; `sumFor` column is a fixed union, not user input. Clean (see F7 for the route/rate concern).
- `server/src/services/playback-watermark.ts` — only pseudonymous partial identity emitted, no full phone
  /email; no sensitive data returned beyond the caller's own identity. Clean.
- `server/src/services/playback-progress.ts` — monotonic high-water mark, duration clamp, rate limiting,
  keyed by `(tenant,enrollment,asset)`; state concerns in F4 only. Clean.
- `server/src/routes/video-assets.ts` callback HMAC verification (`:439-461`) — constant-time hex compare,
  distinct per-family message layout, missing secret/signature fails closed. Clean (route/boundary conflict
  is F8).
- `server/src/routes/playback-sessions.ts` concurrency acquisition (`registry.acquireSlot`) — check-and-insert
  occurs in one synchronous critical section (no `await` between), so no oversubscription race. Clean.
- Mounts `server/src/index.ts:147-202` — all M2/M3 routers are behind `/api` `optionalAuth` +
  tenant/student boundaries and each router's own `authenticateToken`; verification uses
  `algorithms:['HS256']` (no `none`). Clean (aside from F8, a boundary/route field conflict).
- Migrations `20261018_03..07` — no `DROP`/`TRUNCATE`/`DELETE`, no data rewrite; every statement is
  `information_schema`-guarded or `IF NOT EXISTS`; idempotent re-runs; callback/usage/idempotency unique
  keys present. Clean (see F4 for unused tables).
- SQL injection: all reviewed queries use `?` placeholders via `connection.execute`; the only interpolated
  identifiers are fixed allow-lists (`SUM(${column})`, branding column names, static filter SQL). Clean.
- Secret leakage: none of the reviewed files log secrets; `db.ts` masks the DB password. Clean.

---

## Residual / not in scope

- `secure-video.ts` JWT `generateVideoSessionToken`/`verifyVideoSessionToken` (IP/UA/fingerprint binding)
  was read for context only; the listed playback token service is `playback-entitlement.ts`.
- `principal-repository.ts` / `identity-scope.ts` (membership resolution feeding `req.user.tenantId`)
  were not in the assigned file list but underpin every isolation check above.
