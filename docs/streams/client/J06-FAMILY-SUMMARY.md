# J06 — family portal, selected linked child

BUILD-56 continuation: [actual scoped evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-56.md). Parent schema applied only to synthetic demo after snapshot. Native runtime has zero links/tokens and no PARENT_VIEW_SECRET; empty/denied browser path verified. Positive original-router/MySQL/Chrome path uses injected fixture principal, seeded verified-link premise and in-memory secret inside outer ROLLBACK, not actual OTP/onboarding or durable-link acceptance. Original UI now distinguishes service503 from lost child access401/403/404; lost access clears summary, selected link and current option until fresh discovery. Discovery/session store failures return stable503 without driver payload logging. Backend59/frontend2275/types/build pass. Publication, channels, real identity, load/mobile and field usefulness remain open. Historical no-schema/no-browser statements below describe BUILD-39.

BUILD-39 mounts `/family` behind the actual `AuthGuard`. Navigation is available
in the existing main/admin, instructor and student headers. The access-control
map allows authenticated supported roles to reach this personal self-service
page; a role is not family authority. Billing-only remains denied. The backend
requires direct users-table identity and each child's verified own link.

## Journey

Load the existing latest-200 owned link headers, do not auto-open a child.
Parent explicitly selects an active link; request a short-lived scoped session
from its canonical existing endpoint, then fetch only
`/api/parent/family-summary`. The custom request uses **only** the scoped bearer,
not the normal login token or workspace selectors. Same-origin fixed URL,
no-store, omitted ambient cookies and redirect rejection; no credential in URL.
The scoped token stays in the current async call, not component/controller state,
localStorage/sessionStorage, a query cache or logs. No automatic token renewal.

Show child/current-group/course, last check time, a single evidence-backed
follow-up action, five separate attendance counts, optional session details and
next seven days' actual current-group session times. All displayed instants use
Africa/Cairo. Unmarked and excused attendance are not absence. Missing current
group is explicitly unknown, and an empty window makes no claim about other
periods. Grades are explicitly unavailable pending family-publication proof.
This is not a notification, booking, content grant, comprehension measure or
automatic merged agenda across children/institutions.

## Async and privacy boundaries

The strict adapter bounds links (200), history (100), agenda (100), exact DTO
keys, canonical UTC windows and source times, duplicate session/link IDs,
states/count agreement and deterministic next action. Added score/contact fields
or unsupported scopes are rejected. No row spreading into a public DTO.

Controller binds principal lifetime, request generation and selected link.
Switching a link hides the previous summary before requesting its own session;
late replies cannot replace another child's data. Unknown link IDs never request
sessions. Failed refresh clears evidence rather than presenting stale success.
25-second deadline aborts/fences reads. Session/scope/storage events clear all
private data and stop further work for that controller lifetime.

Displayed evidence is cleared at the lesser of token expiry and 60 seconds;
focus/background events clear it too. Refresh is explicit, reissues the scoped
session and rechecks current authority. This is a bounded stale-display policy,
not proof of immediate browser-side revocation. Hiding/unmounting disposes
timers/subscriptions and fences pending replies. No background delivery exists.

This initial journey uses **already verified links**. Creating a first link,
account policy for a parent without a student account, OTP/channel activation,
publication rules for grades/progress, delivery preferences/quiet hours and
cross-institution acceptance remain open. Link labels initially use ordinal
numbers; the selected child's name appears only after authorized reading.
At 200 returned links the page warns that the historical list may be incomplete.

The actual page is exercised through its canonical transports in a local hook
harness; this is not real browser/device/accessibility/parent usability
acceptance. See [server contract](../server/J06-FAMILY-SUMMARY.md) and
[BUILD-39](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-39.md).
