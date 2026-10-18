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

No mount path is an exact match of, or a path-segment prefix of, another mount.

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
401/403 to an anonymous caller with zero storage access.
