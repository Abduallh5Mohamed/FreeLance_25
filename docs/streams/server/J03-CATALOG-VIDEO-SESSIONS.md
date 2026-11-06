# J03 — catalog-bound secure video sessions

Continuation: [BUILD-21 student player](../client/J03-STUDENT-CATALOG-VIDEO-PLAYER.md)
adds the actual UI and `session_required` candidate status. It also moves the
explicit missing-consent challenge before resolution, retaining fresh consent
proof. UI-specific pending statements below describe the BUILD-20 checkpoint.

Local implementation: **2026-11-06, BUILD-20**. Continues the
[student reference proof](J03-STUDENT-CATALOG-VIDEO-PROOF.md).
This contract describes backend behavior, not production acceptance or a
completed student playback interface.

## Issuance and authority

The existing mounted `POST /api/secure-video/session` accepts an alternative
exact body:

```json
{
  "catalog": {
    "course_id": "<course UUID>",
    "lesson_id": "<lesson UUID>",
    "content_id": "<lesson video reference UUID>"
  },
  "fingerprint": "<existing device fingerprint>",
  "screenRes": "<existing screen resolution>"
}
```

Catalog selectors have exactly three UUID fields. Additional body selectors,
query parameters, direct video IDs, offers, tenant/enrollment/branch IDs or
source metadata are rejected. Fingerprint and resolution are required bounded
strings. The authenticated principal supplies identity and selected workspace.
All responses from the delivery-router factory declare `no-store`.

`catalog-video-session.ts` resolves the source through the BUILD-19 shared live
student/lesson/reference/group/branch proof. It additionally requires a live
login-session row for the exact caller/version, current video consent, actual
required schema/engines/primary keys, a ready encrypted same-course/tenant source,
the producer's exact `<videoId>/playlist.m3u8` namespace, a distinct original
key and a valid AES-128 key. Missing authority or schema fails closed; malformed
requests are 400, unavailable proof infrastructure 503, unproven references 404.

The existing device, suspension, video-access, resource-branch, preview,
entitlement and token policies remain in force. Catalog playback is full
authorized student playback, never a preview. The selected catalog lesson is
the explicit entitlement lesson; it is not passed to the legacy parent resolver.

## Durable context and refresh

File-only migration `20261106_02_catalog_video_session_context.sql` adds nullable
JSON `video_sessions.catalog_context`. It has **not been applied**. Existing
legacy inserts do not reference the new column. A catalog insert includes context
in the original single session INSERT; there is no subsequent context attachment.
Exactly one acknowledged affected row is required before cache publication.
An uncertain insert acknowledgement returns unavailable and publishes no token
or cache grant; it may leave a durable row requiring normal session cleanup.

Private context contains course/lesson/reference, user/tenant/enrollment, login
session/version, branch/membership version and a SHA-256 fingerprint of source
metadata. It contains no raw storage key or encryption secret and is never
returned to the client. The cached context is copied and frozen.

Issuance rechecks the durable context after creation and before returning the
response. Refresh requires the authenticated caller's login session, tenant,
enrollment, version and branch context to match, then performs fresh proof before
returning refreshed credentials. Stored context is a selector/binding, not an
access grant or a cached authorization result.

## Delivery and generic fallback

On manifest, segment and encryption-key requests, the server compares the cached
binding to the active durable session row pinned by session/user/video. It repeats
live login/consent/catalog/source proof on a new read transaction and compares the
full context. Existing token/device, current video access, resource branch,
entitlement, durable liveness and rate controls still apply. Heartbeat also checks
the current catalog binding before recording activity.

Manifest buffers and segment streams are checked again after provider acquisition;
keys are checked again after the key query. A denial sends no acquired bytes and
destroys a denied segment stream. There is no claim that revocation can recall
bytes already delivered or atomically cancel a stream after it starts.

A video with a current catalog reference cannot start or continue an unbound
generic session, including a preview. The generic binding check runs at issuance,
refresh, heartbeat and delivery. A missing reference/context never downgrades a
catalog session into generic access. Absent catalog-binding schema preserves
legacy-only behavior; a partial/unreadable binding schema denies. The existing
`videos.ts` direct key/stream/refresh endpoints already return 410 before their
unreachable historical implementations; they were inspected and remain disabled.

## Limits and next work

- The student metadata DTO remains `playback_status:unconfigured`; this slice
  adds no student play button or browser player integration.
- The source fingerprint binds stored metadata/revision/key identity, **not**
  provider object bytes, object-version immutability or scanner evidence.
- Memory session ownership/restart behavior is unchanged; this is not a
  distributed cache restoration design. Login binding proves a live login row,
  not a separate ledger of the browser's currently selected workspace.
- Readiness and repeated fresh proofs introduce database work per media request.
  Real SQL/FK/index/transaction/query-plan/load and provider HLS acceptance are
  unverified. No performance improvement is claimed.
- Schemas remain unapplied; no provider, live DB or deployment was used. Lesson
  progress is unchanged and stays separate from legacy progress.

Next: integrate an explicit catalog session request into the actual student
player with lifecycle/session fences and honest unavailable/consent/error states,
then authorized schema/provider/device acceptance. Do not expose a public media
URL or silently reuse a generic session when catalog proof fails.
