# M2/M3 Router Mounting

This document records the mount contract for the M2/M3 routers newly wired into
`server/src/index.ts`, behind the existing `/api` guard chain.

## Shared guard chain

Every path below is mounted **after** the single line:

```ts
app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
```

so each request is processed by, in order:

1. `optionalAuth` — resolves a supplied credential to a verified principal; no
   token still proceeds anonymously.
2. `enforceTenantAuthorityBoundary` — rejects client-supplied tenant/instructor
   selectors (`x-tenant-id`, `x-instructor-id`, `tenant_id`/`tenantId`/`tenant`
   in body/query) with 400.
3. `enforceStudentWorkspaceBoundary` — rejects student identity/workspace
   substitution.
4. Router-level `authenticateToken` (wired in each route module) — denies an
   anonymous caller with 401 before any handler or storage access.

"Staff" below means the handler additionally resolves a server-owned tenant
authority (owner / active instructor membership) or an owner-only check.

## Mounts

| Router | Mount path | Source |
| --- | --- | --- |
| content access (C6/C7) | `/api/content` | `server/src/routes/content-access.ts` |
| tenant branding | `/api/tenant/branding` | `server/src/routes/tenant-branding.ts` |
| tenant domains | `/api/tenant/domains` | `server/src/routes/tenant-domains.ts` |
| announcements + schedules (C11) | `/api/announcements` | `server/src/routes/announcements.ts` |
| student CSV import (C12) | `/api/student-import` | `server/src/routes/student-import.ts` |
| video assets (V1/V3/V8) | `/api/video-assets` | `server/src/routes/video-assets.ts` |
| playback sessions (V4/V5/V6) | `/api/playback` | `server/src/routes/playback-sessions.ts` |
| question bank (M4) | `/api/question-bank` | `server/src/routes/question-bank.ts` |
| assignments (M4) | `/api/assignments` | `server/src/routes/assignments.ts` |
| exam versions (M4 A2/A3) | `/api/exam-versions` | `server/src/routes/exam-versions.ts` |
| gradebook (M4) | `/api/gradebook` | `server/src/routes/gradebook.ts` |
| certificates (M4 A8) | `/api/certificates` | `server/src/routes/certificates.ts` |
| schedules (M5 G2) | `/api/schedules` | `server/src/routes/schedules.ts` |
| attendance records (M5 G3) | `/api/attendance-records` | `server/src/routes/attendance-records.ts` |

No mount path is an exact match of, or a path-segment prefix of, another mount.
(`/api/attendance-records` is a distinct segment from the legacy `/api/attendance`,
which stays mounted as-is.)

## Endpoints

### `/api/content` — content access

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/content/lessons/:id` | `authenticateToken`; student access policy, staff branch authority |
| GET | `/api/content/courses/:courseId/lessons` | `authenticateToken`; student or staff branch authority |
| POST | `/api/content/lessons/:id/complete` | `authenticateToken`; student only |
| PUT | `/api/content/releases/:lectureId` | `authenticateToken`; owner/instructor/admin |
| POST | `/api/content/courses/:courseId/releases/run` | `authenticateToken`; owner/instructor/admin |

### `/api/tenant/branding` — tenant branding

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/tenant/branding` | `authenticateToken`; tenant owner |
| GET | `/api/tenant/branding/branding` | `authenticateToken`; tenant owner |
| GET | `/api/tenant/branding/me` | `authenticateToken`; tenant owner |
| PUT | `/api/tenant/branding` | `authenticateToken`; tenant owner |
| PUT | `/api/tenant/branding/branding` | `authenticateToken`; tenant owner |
| PUT | `/api/tenant/branding/me` | `authenticateToken`; tenant owner |
| PATCH | `/api/tenant/branding` | `authenticateToken`; tenant owner |
| PATCH | `/api/tenant/branding/branding` | `authenticateToken`; tenant owner |
| PATCH | `/api/tenant/branding/me` | `authenticateToken`; tenant owner |

### `/api/tenant/domains` — tenant custom domains

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/tenant/domains` | `authenticateToken`; tenant owner |
| GET | `/api/tenant/domains/domains` | `authenticateToken`; tenant owner |
| POST | `/api/tenant/domains` | `authenticateToken`; tenant owner |
| POST | `/api/tenant/domains/claim` | `authenticateToken`; tenant owner |
| POST | `/api/tenant/domains/domains` | `authenticateToken`; tenant owner |
| POST | `/api/tenant/domains/:hostname/verify` | `authenticateToken`; tenant owner |
| POST | `/api/tenant/domains/verify` | `authenticateToken`; tenant owner |
| DELETE | `/api/tenant/domains/:hostname` | `authenticateToken`; tenant owner |
| DELETE | `/api/tenant/domains/revoke` | `authenticateToken`; tenant owner |
| DELETE | `/api/tenant/domains/domains/:hostname` | `authenticateToken`; tenant owner |

### `/api/announcements` — announcements + schedules

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/announcements` | `authenticateToken`; tenant staff authority |
| POST | `/api/announcements` | `authenticateToken`; tenant staff authority |
| PATCH | `/api/announcements/:id` | `authenticateToken`; tenant staff authority |
| POST | `/api/announcements/:id/retract` | `authenticateToken`; tenant staff authority |
| GET | `/api/announcements/schedules` | `authenticateToken`; tenant staff authority |
| POST | `/api/announcements/schedules` | `authenticateToken`; tenant staff authority |
| PATCH | `/api/announcements/schedules/:id` | `authenticateToken`; tenant staff authority |
| POST | `/api/announcements/schedules/:id/cancel` | `authenticateToken`; tenant staff authority |
| GET | `/api/announcements/student` | `authenticateToken`; student viewer (own audience) |
| GET | `/api/announcements/schedules/student` | `authenticateToken`; student viewer (own audience) |

### `/api/student-import` — CSV import

| Method | Path | Guard / authority |
| --- | --- | --- |
| POST | `/api/student-import/preview` | `authenticateToken`; tenant staff authority |
| POST | `/api/student-import/commit` | `authenticateToken`; tenant staff authority |
| GET | `/api/student-import/batches` | `authenticateToken`; tenant staff authority |
| GET | `/api/student-import/batches/:id/report.csv` | `authenticateToken`; tenant staff authority |

### `/api/video-assets` — video assets

| Method | Path | Guard / authority |
| --- | --- | --- |
| POST | `/api/video-assets/assets` | `authenticateToken`; staff |
| GET | `/api/video-assets/assets/:assetId` | `authenticateToken`; owner/admin |
| POST | `/api/video-assets/assets/:assetId/processing` | `authenticateToken`; owner/admin |
| POST | `/api/video-assets/callbacks/:provider` | **signature-gated** (no `authenticateToken`; unverified payloads are ignored) |
| POST | `/api/video-assets/playback/entitlements` | `authenticateToken`; student workspace |
| POST | `/api/video-assets/playback/entitlements/revoke` | `authenticateToken`; tenant/platform scope |
| POST | `/api/video-assets/usage/heartbeat` | `authenticateToken`; student workspace |
| POST | `/api/video-assets/usage/provider` | **signature-gated** (no `authenticateToken`; unverified payloads are ignored) |
| GET | `/api/video-assets/usage/summary` | `authenticateToken`; staff |

The two `callbacks`/`provider` endpoints are provider webhooks: they are
intentionally unauthenticated and instead verify an HMAC signature through an
injected verifier that fails closed. They still pass through the shared `/api`
guard chain above. The anonymous-denial test uses authenticated endpoints and
does not assert 401/403 on these two.

### `/api/playback` — playback sessions

| Method | Path | Guard / authority |
| --- | --- | --- |
| POST | `/api/playback/sessions` | `authenticateToken` |
| POST | `/api/playback/sessions/start` | `authenticateToken` |
| POST | `/api/playback/start` | `authenticateToken` |
| POST | `/api/playback/sessions/:sessionId/heartbeat` | `authenticateToken` |
| POST | `/api/playback/heartbeat` | `authenticateToken` |
| POST | `/api/playback/sessions/:sessionId/progress` | `authenticateToken` |
| POST | `/api/playback/progress` | `authenticateToken` |
| GET | `/api/playback/sessions/:sessionId/resume` | `authenticateToken` |
| GET | `/api/playback/resume` | `authenticateToken` |
| POST | `/api/playback/resume` | `authenticateToken` |
| DELETE | `/api/playback/sessions/:sessionId` | `authenticateToken` |
| POST | `/api/playback/sessions/:sessionId/revoke` | `authenticateToken` |
| POST | `/api/playback/sessions/:sessionId/self-revoke` | `authenticateToken` |
| POST | `/api/playback/sessions/:sessionId/support-revoke` | `authenticateToken` |
| GET | `/api/playback/devices` | `authenticateToken` |
| POST | `/api/playback/devices/:deviceId/revoke` | `authenticateToken` |
| GET | `/api/playback/policy` | `authenticateToken` |
| GET | `/api/playback/policy/:tenantId` | `authenticateToken` |
| GET | `/api/playback/sessions` | `authenticateToken` |

### `/api/question-bank` — reusable question bank (M4)

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/question-bank/questions` | `authenticateToken`; tenant staff authority |
| POST | `/api/question-bank/questions` | `authenticateToken`; tenant staff authority |
| GET | `/api/question-bank/questions/:id` | `authenticateToken`; tenant staff authority |
| GET | `/api/question-bank/questions/:id/versions` | `authenticateToken`; tenant staff authority |
| PATCH | `/api/question-bank/questions/:id` | `authenticateToken`; tenant staff authority |
| POST | `/api/question-bank/questions/:id/archive` | `authenticateToken`; tenant staff authority |
| GET | `/api/question-bank/export` | `authenticateToken`; tenant staff authority |
| POST | `/api/question-bank/import` | `authenticateToken`; tenant staff authority |

### `/api/assignments` — assignments and submissions (M4)

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/assignments` | `authenticateToken`; tenant staff authority |
| POST | `/api/assignments` | `authenticateToken`; tenant staff authority |
| GET | `/api/assignments/student` | `authenticateToken`; enrolled student |
| POST | `/api/assignments/:id/submissions` | `authenticateToken`; enrolled student |
| GET | `/api/assignments/:id/submissions/mine` | `authenticateToken`; enrolled student |
| GET | `/api/assignments/:id/submissions` | `authenticateToken`; tenant staff authority |
| POST | `/api/assignments/:id/submissions/:submissionId/revoke` | `authenticateToken`; tenant staff authority |
| GET | `/api/assignments/:id` | `authenticateToken`; staff or enrolled student |
| PATCH | `/api/assignments/:id` | `authenticateToken`; tenant staff authority |
| POST | `/api/assignments/:id/publish` | `authenticateToken`; tenant staff authority |
| POST | `/api/assignments/:id/archive` | `authenticateToken`; tenant staff authority |

### `/api/exam-versions` — versioned exam snapshots and grading (M4)

| Method | Path | Guard / authority |
| --- | --- | --- |
| POST | `/api/exam-versions/exams/:examId/versions` | `authenticateToken`; tenant staff authority |
| GET | `/api/exam-versions/exams/:examId/versions` | `authenticateToken`; tenant staff authority |
| GET | `/api/exam-versions/exams/:examId/versions/:versionId` | `authenticateToken`; tenant staff authority |
| POST | `/api/exam-versions/exams/:examId/versions/:versionId/publish` | `authenticateToken`; tenant staff authority |
| POST | `/api/exam-versions/exams/:examId/versions/:versionId/attempts` | `authenticateToken`; enrolled student (own audience) |
| GET | `/api/exam-versions/attempts/:attemptId` | `authenticateToken`; owner student or tenant staff authority |
| POST | `/api/exam-versions/attempts/:attemptId/submit` | `authenticateToken`; owner student |
| POST | `/api/exam-versions/attempts/:attemptId/regrade` | `authenticateToken`; tenant staff authority |

### `/api/gradebook` — weighting policy and scores (M4)

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/gradebook/policy/:courseId` | `authenticateToken`; tenant staff authority |
| PUT | `/api/gradebook/policy/:courseId` | `authenticateToken`; tenant staff authority |
| POST | `/api/gradebook/scores` | `authenticateToken`; tenant staff authority |
| GET | `/api/gradebook/scores` | `authenticateToken`; tenant staff authority |
| GET | `/api/gradebook/me` | `authenticateToken`; enrolled student |
| GET | `/api/gradebook/students/:enrollmentId` | `authenticateToken`; tenant staff authority |
| GET | `/api/gradebook/export` | `authenticateToken`; tenant staff authority |
| GET | `/api/gradebook/progress` | `authenticateToken`; enrolled student |

### `/api/certificates` — issuance, revocation and public verification (M4)

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/certificates/verify/:verificationId` | **public** (no `authenticateToken`); rate-limited (`certificates-verify`, 30/min per client address); returns minimal public facts only |
| GET | `/api/certificates` | `authenticateToken`; tenant staff authority |
| POST | `/api/certificates` | `authenticateToken`; tenant staff authority |
| POST | `/api/certificates/:id/revoke` | `authenticateToken`; tenant staff authority |
| GET | `/api/certificates/:id` | `authenticateToken`; tenant staff authority |

`/api/certificates/verify/:verificationId` is the single anonymous surface. It is
registered **before** `router.use(deps.authenticate)`, is rate-limited, and only
projects the allowlisted public facts (verification id, status, issued-at,
course/tenant display names, final score and tenant branding) — never internal
ids, enrollment ids or issuer identities. Every other path on this mount rejects
an anonymous caller at `authenticateToken` before any handler or storage access.

### `/api/schedules` — calendar series and sessions (M5 G2)

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/schedules` | `authenticateToken`; tenant staff authority |
| POST | `/api/schedules/series` | `authenticateToken`; tenant staff authority |
| GET | `/api/schedules/sessions` | `authenticateToken`; tenant staff authority |
| POST | `/api/schedules/sessions/:id/cancel` | `authenticateToken`; tenant staff authority |
| POST | `/api/schedules/sessions/:id/reschedule` | `authenticateToken`; tenant staff authority |
| GET | `/api/schedules/student` | `authenticateToken`; enrolled student (own audience) |

### `/api/attendance-records` — manual attendance (M5 G3)

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/attendance-records/sessions/:sessionId/records` | `authenticateToken`; tenant staff authority |
| POST | `/api/attendance-records/sessions/:sessionId/records` | `authenticateToken`; tenant staff authority |
| POST | `/api/attendance-records/sessions/:sessionId/records/bulk` | `authenticateToken`; tenant staff authority |
| POST | `/api/attendance-records/records/:recordId/correct` | `authenticateToken`; tenant staff authority |
| GET | `/api/attendance-records/me` | `authenticateToken`; enrolled student |

## Production wiring added to factory-only modules

`announcements.ts`, `student-import.ts` and `playback-sessions.ts` previously
exported only factories. Each now also has a default-wired router instance at
the bottom of the file using the real pool (lazily imported), `authenticateToken`
and the module's real authority/audit dependencies. Their existing named factory
exports and behavior are unchanged; `playback-sessions.ts` keeps
`createPlaybackSessionsRouter`, `createPlaybackSessionRouter` and
`createPlaybackSessions` as named exports and now defaults to a wired instance
(no test imports its default as a factory).

## Verification

`server/tests/m2-m3-mounting.test.ts` asserts statically that every mount above
exists in `server/src/index.ts` after the guard chain, that no mount path
collides (segment-aware), and hermetically that each mounted path returns
401/403 to an anonymous caller with zero storage access. The one exception is
`/api/certificates/verify/:verificationId`: it is asserted to be reachable
anonymously (one storage read, not a denial) and to expose only the allowlisted
public facts.

## M6 parent-link / consent / discussion mounts (appended 2026-10-18)

Three M6 routers are now mounted in `server/src/index.ts`. Two use normal JWT
authentication and therefore sit **after** the shared `/api` guard chain, like the
M2–M5 mounts above:

| Router | Mount path | Source |
| --- | --- | --- |
| parent-link verification (M6 P1) | `/api/parent-links` | `server/src/routes/parent-links.ts` |
| notification consent ledger (M6 P3) | `/api/notification-consent` | `server/src/routes/notification-consent.ts` |
| lesson comments / Q&A (M6 P6) | `/api/lesson-discussions` | `server/src/routes/lesson-discussions.ts` |

`/api/parent` (read-only parent views, M6 P2) is mounted **before** the guard
chain on purpose. It authenticates with its own scoped opaque HMAC token
(`pv1.<base64url payload>.<base64url signature>`), not a JWT. `optionalAuth`
runs `jwt.verify` on any supplied Bearer value and would reject the opaque token
with `401 Invalid token`, so the parent-views router must resolve its own
credential first.

Mount order in `index.ts`:

```ts
app.use('/api/parent', parentViewsRoutes);              // opaque pv1 token
app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
app.use('/api/parent-links', parentLinksRoutes);
app.use('/api/notification-consent', notificationConsentRoutes);
app.use('/api/lesson-discussions', lessonDiscussionsRoutes);
```

No path is an exact match of, or a path-segment prefix of, another mount.
`/api/parent` and `/api/parent-links` are distinct segments; neither shadows the
other.

### `/api/lesson-discussions` — endpoints

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/lesson-discussions/lessons/:lectureId/threads` | `authenticateToken`; server-resolved lesson access |
| POST | `/api/lesson-discussions/lessons/:lectureId/threads` | `authenticateToken`; allowed lesson access, per-user limiter |
| GET | `/api/lesson-discussions/threads/:threadId` | `authenticateToken`; thread's lesson access |
| POST | `/api/lesson-discussions/threads/:threadId/replies` | `authenticateToken`; thread's lesson access, per-user limiter |
| DELETE | `/api/lesson-discussions/threads/:threadId` | `authenticateToken`; author or tenant staff |
| DELETE | `/api/lesson-discussions/replies/:replyId` | `authenticateToken`; author or tenant staff |
| POST | `/api/lesson-discussions/threads/:threadId/moderate` | `authenticateToken`; tenant staff (hide/restore/delete) |
| POST | `/api/lesson-discussions/replies/:replyId/moderate` | `authenticateToken`; tenant staff (hide/restore/delete) |
| POST | `/api/lesson-discussions/reports` | `authenticateToken`; accessible target, per-user limiter |
| GET | `/api/lesson-discussions/blocks` | `authenticateToken`; own block list |
| POST | `/api/lesson-discussions/blocks` | `authenticateToken`; own block list, per-user limiter |
| DELETE | `/api/lesson-discussions/blocks/:blockedUserId` | `authenticateToken`; own block list |

See `docs/streams/server/M6-P6-DELIVERY.md` for the access, moderation,
retention, report/block and notification rules.

### Verification addendum

`server/tests/m2-m3-mounting.test.ts` (appended tests) asserts that the three
post-guard M6 mounts are ordered after the guard chain and before the 404
handler, that `/api/parent` precedes `optionalAuth`, that the new paths collide
with no existing mount, and hermetically that an anonymous caller reaches
neither SQL storage nor any injected store on any of the four surfaces.

## M7 platform mounts (appended 2026-10-19)

Three M7 routers are now mounted in `server/src/index.ts`, after the shared
`/api` guard chain and before the 404 handler:

| Router | Mount path | Source |
| --- | --- | --- |
| feature flags (M7 O1) | `/api/platform/flags` | `server/src/routes/platform-flags.ts` |
| audit log read/export (M7 O2) | `/api/audit-logs` | `server/src/routes/audit-logs.ts` |
| content moderation (M7 O4) | `/api/moderation` | `server/src/routes/moderation.ts` |

Mount order in `index.ts`:

```ts
app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);
// ...
app.use('/api/platform/flags', platformFlagsRoutes);
app.use('/api/audit-logs', auditLogsRoutes);
app.use('/api/moderation', moderationRoutes);
```

No path is an exact match of, or a path-segment prefix of, another mount
(`/api/platform/flags` is unrelated to the existing `/api/admin/platform`;
`/api/audit-logs` and `/api/moderation` are new segments).

### `/api/platform/flags` — feature flags

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/platform/flags` | `authenticateToken`; verified `platform_flags.read` permission |
| POST | `/api/platform/flags` | `authenticateToken`; verified `platform_flags.manage` permission |
| GET | `/api/platform/flags/:id` | `authenticateToken`; verified `platform_flags.read` permission |
| GET | `/api/platform/flags/:id/versions` | `authenticateToken`; verified `platform_flags.read` permission |
| POST | `/api/platform/flags/:id/versions` | `authenticateToken`; verified `platform_flags.manage` permission |
| POST | `/api/platform/flags/:id/versions/:versionId/publish` | `authenticateToken`; verified `platform_flags.manage` permission |
| POST | `/api/platform/flags/:id/versions/:versionId/rollback` | `authenticateToken`; verified `platform_flags.manage` permission |
| POST | `/api/platform/flags/:id/archive` | `authenticateToken`; verified `platform_flags.manage` permission |

### `/api/audit-logs` — audit log read + export

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/audit-logs` | `authenticateToken`; verified platform reader or verified tenant owner (pinned to own tenant) |
| GET | `/api/audit-logs/export.csv` | `authenticateToken`; verified platform reader or verified tenant owner; the export itself is audited |
| GET | `/api/audit-logs/verify` | `authenticateToken`; verified platform reader (hash-chain verification) |

### `/api/moderation` — content moderation queue

| Method | Path | Guard / authority |
| --- | --- | --- |
| GET | `/api/moderation/cases` | `authenticateToken`; verified platform moderator or tenant staff (pinned to own tenant) |
| GET | `/api/moderation/cases/:id` | `authenticateToken`; same scope; cross-tenant ids are 404 |
| POST | `/api/moderation/cases` | `authenticateToken`; same scope; report target must be provable |
| POST | `/api/moderation/cases/:id/assign` | `authenticateToken`; same scope; reviewer must be a verified moderator of the case tenant |
| POST | `/api/moderation/cases/:id/decision` | `authenticateToken`; same scope; reporter cannot decide their own report |
| POST | `/api/moderation/cases/:id/appeal` | `authenticateToken`; the report's reporter or the target author (one appeal per case) |
| POST | `/api/moderation/cases/:id/appeal-decision` | `authenticateToken`; same scope; reviewer must differ from the original decider and the appellant |

See `docs/streams/server/M7-O4-DELIVERY.md` for the queue, evidence-snapshot,
reviewer, decision, appeal and audit rules.

### Verification addendum (M7)

`server/tests/m2-m3-mounting.test.ts` (appended M7 tests) asserts that the three
M7 mounts are ordered after the guard chain and before the 404 handler, that the
new paths collide with no existing mount, and hermetically that an anonymous
caller is denied (401/403) with zero storage access on all three surfaces.
`server/tests/m7-moderation.test.ts` covers the moderation router's allow/deny/
cross-tenant/validation/failure cases, and `server/tests/m7-feature-flags.test.ts`
and `server/tests/m7-audit-logs.test.ts` cover the other two.

