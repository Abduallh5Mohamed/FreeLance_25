# M3 Video Security Fixes (review-m2-m3)

Remediation of findings F3, F5, F7, F8 and F9 from
`docs/agent-reports/review-m2-m3.md`. Scope is limited to the video-asset
playback entitlement/usage surface and the shared tenant authority boundary.

## Files changed

- `server/src/services/playback-entitlement.ts` — added `verifyPlaybackEntitlement` helper.
- `server/src/services/video-usage-events.ts` — heartbeat clamp, per-enrollment aggregate/count store reads, `heartbeatLimit` gate, new caps.
- `server/src/routes/video-assets.ts` — access-checked issuance, ownership-scoped revocation, entitlement-bound heartbeats, dedicated secret wiring, tenant-admin capability.
- `server/src/middleware/tenant-authority-boundary.ts` — narrow callback exemption.
- `server/tests/m3-video-lifecycle.test.ts` — updated to the new contracts.
- `server/tests/m3-video-review-fixes.test.ts` — new rejection-path tests (F3/F5/F7/F8/F9).
- `docs/streams/server/M3-FIXES.md` — this document.

## F3 — issuance is access-checked; playback tokens are verified

- `POST /playback/entitlements` now resolves the lesson's composed
  content-access facts through the injected `resolveLessonScope` and runs the
  **existing `evaluateContentAccess` policy** before minting a token. A token is
  only issued for a lesson that is published, released (scheduled/sequential
  gates included), in the caller's enrollment/audience and branch. Denials map
  through `contentAccessDenialStatus` (404 for missing/unpublished/out-of-audience,
  403 for not-yet-released/prerequisite). A cross-tenant or absent lesson stays 404.
- New helper `verifyPlaybackEntitlement(service, request)` in
  `server/src/services/playback-entitlement.ts` normalizes the four
  server-derived facts and delegates to `PlaybackEntitlementService.verify`,
  failing closed on any missing/mismatched binding.

### Exact integration point for `secure-video.ts` (NOT edited here)

`secure-video.ts` is out of this batch's allowed files. When it is wired, the
media-delivery handlers must verify the entitlement **before serving bytes**,
after `validateMediaSession(req, videoId)` succeeds and before
`evaluateDeliveryAccess`:

- `GET /manifest/:videoId/*` — immediately after `validateMediaSession`.
- `GET /media/:videoId` — immediately after `validateMediaSession`.
- `GET /key/:videoId` — after `verifyVideoSessionToken` + session binding, before the key is read.

The client must present the entitlement token alongside the existing
`sid`/`token` query params (e.g. a new `entitlement` param threaded into the
rewritten manifest/segment URLs). The call is:

```ts
import { verifyPlaybackEntitlement } from '../services/playback-entitlement';

const decision = await verifyPlaybackEntitlement(entitlement, {
    token: req.query.entitlement,
    tenantId: session.tenantId,               // server-derived at session creation
    lessonId: resolvedLessonIdForVideo,       // resolved from server rows, never the request
    studentEnrollmentId: session.studentEnrollmentId,
    sessionId: session.id,
});
if (!decision.allowed) {
    await killSession(sessionId, 'entitlement_denied');
    return res.status(403).json({ error: 'Playback entitlement denied' });
}
```

`lessonId` must come from the video→lecture association resolved server-side;
it is never taken from a client field. A denial reason from the helper
(`expired`, `revoked`, `tenant-mismatch`, `lesson-mismatch`, `student-mismatch`,
`session-mismatch`, `invalid-signature`, `malformed`) can be logged/audited.

## F5 — revocation requires ownership or a verified admin

`POST /playback/entitlements/revoke` now allows a caller only when:

- the record's `studentEnrollmentId` equals the caller's verified
  `studentEnrollmentId` (the record owner), **or**
- `isTenantAdmin(userId, tenantId)` verifies the caller owns the record's tenant, **or**
- `isPlatformAdmin(userId)` verifies a platform capability.

Same-tenant staff who neither own the enrollment nor hold a verified admin
capability are now denied (403). Production `isTenantAdmin` is bound to the
tenant owner (`tenants.owner_user_id` / active `tenant_memberships.role_key = 'owner'`).

## F7 — heartbeat dedupe, binding, caps and rate limiting

`POST /usage/heartbeat` now requires a server-issued playback entitlement
(`token` + `lessonId` + `sessionId`). The heartbeat is accepted only when
`verifyPlaybackEntitlement` matches the principal's tenant/enrollment and the
lesson/session bindings, so a client can no longer invent a `sessionId`. The
recorded watch time is additionally bounded:

- `deltaSeconds` is clamped to one dedupe window (`clampHeartbeatSeconds`), so a
  single heartbeat can never account for more than the window.
- A per-enrollment **aggregate cap** (default 7200 s / 3600 s window) and a
  per-enrollment **event rate limit** (default 240 / window) are enforced by
  `VideoUsageEventService.heartbeatLimit`, backed by
  `sumWatchSecondsForEnrollment` / `countWatchEventsForEnrollment`. Exceeding
  either returns HTTP 429 with the reason.

`occurred_at` is now written from the injected clock so the rolling window is
deterministic and testable. Limits are configurable via
`VideoAssetsDeps.heartbeatLimits` for deployment tuning.

## F8 — tenant authority boundary exemption (callbacks only)

`enforceTenantAuthorityBoundary` continues to reject the `x-tenant-id` /
`x-instructor-id` headers on **every** path. The body/query tenant-selector rule
is now exempted **only** for the two unauthenticated, signature-verified
provider callbacks:

- `/api/video-assets/callbacks/:provider`
- `/api/video-assets/usage/provider`

On those two paths the tenant is read from the HMAC-verified payload (the
signature is the trust anchor and is checked before any state change). Every
other path — including sibling paths such as `/api/video-assets/assets` and
deeper path variants — remains strict.

## F9 — dedicated playback secret

`VIDEO_PLAYBACK_SECRET` is now required for signing playback entitlements.
The `JWT_SECRET` fallback was removed from the production wiring; an unset or
blank `VIDEO_PLAYBACK_SECRET` fails closed (`issue` returns `secret-unavailable`,
`verify` denies). This keeps the playback-token family on an independent key.

## Tests

- `server/tests/m3-video-review-fixes.test.ts` adds rejection-path coverage for
  each finding (access-denied issuance, ownership/admin revocation, heartbeat
  binding/clamp/cap/rate-limit, boundary exemptions, secret fail-closed).
- Full suite green (1534 tests) and typecheck clean.
