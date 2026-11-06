# J03 — fresh student catalog-video proof (BUILD-19)

Continuation: [BUILD-20 catalog sessions](J03-CATALOG-VIDEO-SESSIONS.md) now adds
mounted issuance/refresh/delivery checks with durable context. The historical
slice below describes BUILD-19 only. [BUILD-21](../client/J03-STUDENT-CATALOG-VIDEO-PLAYER.md)
adds the student player and changes candidates to `session_required`; actual
schema/provider/browser acceptance remains open.

Local backend checkpoint: **2026-11-06**. Continues [owner preparation/editor](J02-LESSON-VIDEO-PREPARATION.md). This slice implements an actual authenticated student metadata endpoint and a shared selected-reference proof. It **does not issue playback sessions, tokens or media**; integration with protected issuance/refresh/delivery remains next.

## Why a separate catalog proof

The existing secure-video parent resolver maps videos to legacy lecture/material parents. A catalog `course_lessons.id` is not a legacy lecture ID. Owner preparation also allows one source video in several catalog lessons, so choosing a global first parent would be incorrect. No legacy resolver, provider-neutral asset, session table, preview offer, entitlement or media endpoint is changed in this slice.

## Mounted HTTP contract

`GET /api/student-course-access/courses/:courseId/lessons/:lessonId/videos` uses the real existing authentication/tenant/workspace router. All responses declare `no-store`. UUID course/lesson selectors identify the requested resources only. No query/body/header identity, tenant, enrollment, branch, video ID, limit or provider selector is accepted. Nonstudents, anonymous callers and unselected workspaces retain the existing boundary refusals.

Successful fixed DTO:

```json
{"lesson_id":"<verified catalog lesson UUID>","videos":[{"content_id":"<reference UUID>","title":"<authorized title>","display_order":0,"playback_status":"unconfigured"}]}
```

There are at most 20 metadata items, in stored display order. No underlying video ID, source key, URL, encryption secret, session ID, token, uploader, tenant/enrollment/group/contact or provider payload is returned. `unconfigured` is explicit because no catalog playback issuer/delivery is wired here, even when an eligible processing/source candidate exists. Empty videos means the successful authorized read found no eligible candidates; missing schema is 503, never an invented empty lesson.

## Shared request proof

`student-lesson-videos.ts` reuses `proveStudentLesson` and the existing resource-branch policy. Every call performs fresh database reads on the caller's transaction connection:

1. The supplied principal must be the server-authenticated student/users identity and match the server-derived user/tenant/enrollment scope. Active users row, token version and SQL suspension predicate are checked again. This is not replacement authentication: callers still require the existing live login/workspace middleware or a future equivalent session proof.
2. Enrollment is active, approved, in its own database-clock window, belongs to this user/tenant and has an active `student_courses` link. Course is active and published in that tenant. The catalog lesson/unit are active; release and this enrollment's own prerequisite completion are proved by the existing shared helper.
3. Required actual video-reference/source/material schema, engines, video PK and relation unique indexes are verified using the owner helper. Additional enrollment/progress/group/branch/membership tables must be actual InnoDB.
4. The enrollment's own stored group must resolve exactly once to this course/tenant. This is an **additional audience/context restriction**, consistent with existing student-material handling; it is not a video-to-group assignment and does not derive a video's branch by enumerating all course groups. No group, foreign/duplicate/unclassified group or denied live branch proof yields indistinguishable 404.
5. The existing resource policy evaluates that verified group with prefetched live branch/membership data: active same-tenant branch, current user membership/status, selected branch and membership version where applicable. There is no owner/platform bypass for this student surface.
6. One bounded joined query reads all references with exact video course/tenant, ready state, null direct legacy parents and no reverse legacy URL parents. Combined material/video positions/count and duplicate reference/source/order are validated with bounded reads. The source needs an encrypted flag and nonempty distinct HLS/original keys before it is even advertised as a future candidate. Missing/withdrawn/foreign/legacy-associated/not-ready/unencrypted sources are withheld.

Branch and source checks are batched, not one database pass per video: the same statement count is tested for one and twenty references. Query row limits are not a claim about scan cost or database latency. Storage keys are used only for internal readiness checks and never leave the service's private row conversion. These metadata checks do not prove actual encrypted bytes or a provider response.

## Selected-reference proof and limits

`proveStudentCatalogVideo` selects exactly one authorized `content_id` from a fresh invocation of the same proof and returns server-private canonical user/tenant/enrollment/course/lesson plus reference/video IDs and title/order. Invalid, foreign, removed or inaccessible references expose no source ID. The metadata handler uses the same underlying implementation; this is not a second copied access policy.

The selected proof is prepared for future issuance and delivery, but **is not mounted as an issuer or credential**. Returning its object internally does not establish a durable session, device binding, consent, watermark, rate control, entitlement, current login session or media lease. Those must retain/prove their own lifecycle. A future delivery path must call fresh catalog proof at each protected operation and implement appropriate source/version and post-provider checks, not cache this result or trust its original IDs forever. A transaction read snapshot can become stale; no continuous revocation or race-free byte delivery is claimed here.

## Readiness and next work

There is no new migration, provider wiring, frontend play action or progress change. The previous video reference migration is still unapplied. No media/storage/session write or consent bypass occurs. The existing legacy secure-video behavior is untouched; catalog metadata does not expose a video ID that could be passed to it.

Next: explicit catalog-bound session issuance and refresh, delivery-time proof (manifest/segment/key), durable context and conservative handling of old/noncatalog access so a catalog lock cannot be bypassed through a generic video session. Only then add a student player action. Real schema, HLS bytes, query plans/locks/load and provider acceptance remain gates. [Evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-19.md).
