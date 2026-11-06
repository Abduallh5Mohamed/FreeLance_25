# J03 — student catalog lesson video player (BUILD-21)

Local checkpoint: **2026-11-06**. Builds on the
[session contract](../server/J03-CATALOG-VIDEO-SESSIONS.md).

## Actual student journey

Accessible rows in `StudentContent.tsx` now mount `StudentLessonVideos`. The panel
is collapsed initially: it makes no metadata request or playback request until
opened. Its canonical authenticated read is
`GET /api/student-course-access/courses/:courseId/lessons/:lessonId/videos`.

The fixed bounded DTO still contains only `lesson_id` and up to twenty ordered
`{content_id,title,display_order,playback_status}` items. No video ID, source key,
token, tenant or provider locator is added to metadata. Eligible candidates now
report **`session_required`**: this means a fresh session request is required,
not that the schema/provider/device is verified ready. The client understands
the earlier `unconfigured` value and offers no playback action for it.

Selecting a confirmed row mounts the existing `SecureVideoPlayer` in catalog
mode with exactly course/lesson/reference selectors. Its prop contract excludes
direct URL, video ID and preview offer in this mode. It sends the explicit
BUILD-20 catalog body; a failed request never falls back to a generic session.
Unknown or stale rows cannot be selected. Refreshing metadata closes an active
selection rather than retaining stale reference authority.

## Consent, readiness and errors

The actual session route challenges an unconsented student with the existing
428/current-terms response **before** catalog resolution also checks consent.
Without this ordering an unconsented student received a 404 and could not reach
the existing consent UI. The server still repeats the consent proof during
resolution and delivery; this change grants no access by itself.

Only the explicit consent button posts acceptance. A duplicate click is latched;
an unconfirmed acknowledgement stays at consent with a retry message and does not
issue a session automatically. Confirmed acceptance starts one new catalog request.

The player accepts only an exact same-origin private manifest URL with matching
session/token query values and a valid source video UUID. Preview, arbitrary
external URLs, extra/duplicate query parameters and changed refresh bindings are
rejected. Initial issuance also requires the server's forensic watermark fields;
the canvas displays that server-projected watermark. Media requests do not forward
the login bearer to a returned URL.

An authorized source uses the existing HLS player, or native HLS support when
available. The user starts playback explicitly, including mobile catalog mode.
Initial/renewed source loading has a 30-second readiness deadline. Each API POST
has a 20-second abort deadline. Existing heartbeat (5 seconds) and token refresh
(40 seconds) run only for an established catalog session. Refresh preserves
position/play intent and cannot switch source video or session.

Unavailable session infrastructure, denial/revocation, malformed responses,
transport failure, unsupported HLS and fatal media errors stop playback with an
honest message. Ordinary playback failure does not clear the login or report a
security violation. There is no background generic retry and no completion write.

## Lifecycle ownership

`createCatalogPlayback` owns one selected reference, one canonical login/workspace
incarnation, pending requests and its timers. It fences replies after headers/body
and after awaited work. Same-document session events, relevant cross-tab storage
events, observed principal changes, unmount and explicit close abort pending work,
clear timers, detach media and destroy HLS. Old responses cannot attach a source;
old manifest/media callbacks carry both a lifetime check and source generation.

Metadata has its own matching lifetime fence. On a scope change it removes rows
and the selected player. It never treats a local identity selector as authority;
the server's live catalog/session proof remains the access decision.

## Verification boundary

Controller/transport tests and actual TSX panel/player effects/button callbacks
are exercised with synthetic responses, hook/media/HLS fixtures and SSR markup.
These are **not browser or real provider acceptance**. Native HLS, mobile devices,
actual SQL/migrations, object bytes/version behavior, rate/load, interruption
policy and authorized sample playback remain open. Existing catalog/legacy
progress stays separate; watching does not mark a lesson complete.
