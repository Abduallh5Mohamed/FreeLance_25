# J02 — explicit owner lesson-video preparation (BUILD-17)

## BUILD-18 continuation — actual owner editor

Implemented locally 2026-11-06: the actual `CourseLessonManager` mounts a collapsed `LessonVideoManager` per lesson. Opening binds an immutable course/unit/lesson controller and reads video references, material positions and one eligible-video page. No per-row requests occur while closed. Fixed DTO parsing rejects extra locator/provider fields, malformed states, duplicate sources/orders and malformed selector pages. The editor displays processing/unavailable-source labels; it has no player, playback URL or entitlement action.

Local guards check the combined material/video count and occupied positions from the latest separate reads; the server repeats the actual transactional proof. Source page changes are explicit and clear selection. Link removal requires a separate confirmation and preserves the original source. The ordinary material panel also explains the shared limit/order namespace. Neither component claims the two metadata reads form an atomic snapshot, so another editor can cause a legitimate server conflict.

Writes are single-flight; confirmed save/failed refresh is distinct, clears obsolete rows and blocks another write until validated refresh. A later successful read removes obsolete refresh-failure copy. Unknown/malformed acknowledgements never cause automatic resend: explicit current-state read is required before another decision. It is not a historical receipt or proof that an earlier request cannot later commit. The browser does not persist drafts, operation payloads or recovery keys in this editor.

Principal/session/storage notifications, keyed targets and disposal fence old reads/writes and abort transport. Authority loss clears private rows/options/forms; absent schema is unavailable, not empty. Unavailable-source references remain removable when returned by the authorized server list. The actual parent/editor/controller/API browser journey and scoped regressions are recorded in [BUILD-18](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-18.md).

The backend-only/UI-pending statements below preserve the original BUILD-17 checkpoint; this continuation supersedes them for owner preparation UI. Catalog-aware **student playback remains pending** and the migration remains unapplied.

Local backend implementation: **2026-11-06**. Continues material preparation in [J02](J02-LESSON-MATERIAL-BINDING-CONTRACT.md). Multiple contents per lesson and separate catalog/legacy progress are the owner's recorded choices. This slice adds owner metadata preparation only; owner video UI and student playback remain pending.

## Source decision and scope

Current `videos` rows already carry a course and tenant and are managed by mounted video routes. The newer provider-neutral `video_assets` lifecycle is a different surface without proven course provenance/default mounting. This contract uses explicit `videos.id` references and does not equate them with `video_assets.id`, lecture IDs or catalog lesson IDs.

`course_lesson_videos` is an additive typed relation parallel to the existing material relation. It does not modify `videos.lecture_id`, `videos.material_id`, `lectures.video_url`, material URLs or the legacy parent resolver. No new `video://` string convention, title/order-based source lookup, backfill or global lesson inference is introduced. The same course video may be prepared in more than one catalog lesson; a future playback request must therefore name and re-prove its explicit catalog context rather than choose a global parent.

## Actual mounted API

Relative to `/api/tenants/me/catalog`:

| Method/path | Input / successful response |
|---|---|
| `GET /courses/:courseId/units/:unitId/lessons/:lessonId/videos` | `{videos: VideoReference[]}` |
| `GET` same + `/available-videos` | Optional single UUID `cursor`; `{videos:[{video_id,title}],next_cursor:UUID|null}` |
| `POST` base path | Exactly `{video_id:UUID,display_order:integer}`; 201 `{content:VideoReference,unchanged:false}`; identical existing source/order is 200 with `unchanged:true` |
| `DELETE` base + `/:contentId` | No body/query; `{detached:true,content_id}` |

All responses are no-store. Path UUIDs, exact query/body keys and order bounds 0..2,147,483,647 are checked before acquiring a connection. Billing-only/missing selected identity is denied. Every operation proves the current active tenant owner from users/tenant rows, active same-tenant course, same-course unit and same-unit lesson on the existing transaction connection. Mutation proof locks those parents, including the lesson row shared with material writes. Archived unit/lesson metadata follows existing owner-management behavior; preparing metadata is not publication or student access.

`VideoReference` has exactly `content_id,video_id,display_order,title,video_status`. A live same-course/same-tenant video supplies title and its processing state (`uploading`, `processing`, `ready`, `failed`). A missing or foreign source has `title:null,video_status:'unavailable'`; its name is not fetched from another scope. Here `ready` is the stored processing state, **not permission to play**. No storage locator, encryption key, playback token, uploader/contact, tenant or provider payload is projected.

## Selection and write proof

The selector returns at most 25 rows with a 26-row lookahead, UUID keyset order and no automatic page draining. It restricts videos to the proved course and tenant, `ready` processing status, null direct lecture/material parents and no reverse legacy lecture/material URL references. Names/IDs only are returned. A listed selector is not write authority.

POST rechecks the selected source under lock and repeats the bounded reverse checks (LIMIT 2 per parent type) before any insertion. Missing, foreign, not-ready or legacy-associated source is indistinguishable 404 with no write. A missing video tenant is not inferred from the course. The source's stored canonical ID is used. Reusing a UUID with different case names the same video.

New and existing material writes share a **combined maximum of 20 references** and one display-order namespace. Both mutation paths lock the same lesson; same video/order is a no-op, while changed order, duplicate source, occupied position or full capacity is 409. Corrupt/overflowing mixed state is refused. Detaching an identifiable reference is allowed even after source loss or a mixed-position conflict, so an owner can remove the reference without editing/deleting the video. This is not atomic reorder or replacement.

Reference mutation and sanitized audit are atomic on one connection. Audit contains lesson/video IDs and order, never titles or storage data. Insert/audit failure rolls back; COMMIT uncertainty returns `PERSISTENCE_UNCERTAIN` and destroys the connection with no blind retry or claimed rollback. GET can inspect references; a later explicit identical POST is a current-state no-op only while source proof remains valid. This slice has no immutable historical attempt receipt, payload storage or browser recovery contract.

## Schema and compatibility

`server/migrations/20261106_01_course_lesson_videos.sql` is **unapplied**: ID primary key, explicit lesson/video FKs, nonnegative order, unique `(lesson_id,video_id)` and `(lesson_id,display_order)` indexes. Parent types/charset/collation/engine must be verified against an actual catalog before application. No live DDL or data change occurred.

Runtime checks actual required relation columns, InnoDB for the eleven involved authority/source/audit/reference tables, singleton video ID primary key and exact unique relation indexes. Missing/partial proof returns `LESSON_VIDEOS_UNAVAILABLE` for video preparation. Missing source columns fail closed on actual reads; file presence is not readiness.

When the new relation is wholly absent, existing material preparation keeps its previous behavior. When present and ready, material POST reads video positions too, enforcing combined capacity/order. Partial or nontransactional new schema blocks material attachment instead of ignoring existing video references. Existing material DTOs and student material/PDF APIs remain unchanged. Existing GET-only material lists still project their material subset, not a complete mixed lesson package.

## Limits and next work

No student path/material projection, secure-video session, entitlement, manifest/key/media handler or either progress ledger changed. No provider or file processing was activated. The legacy parent resolver still does not understand catalog lesson references; using its lesson ID as a catalog ID would be incorrect. A later student playback contract must re-prove catalog enrollment, course publication, lesson release/prerequisite, source/branch/group rules and explicit reference at issuance and delivery, including withdrawal/session fences.

Source eligibility is a preparation-time observation. Existing legacy writers do not all participate in the new parent-lock protocol; later legacy changes can invalidate it and must be checked afresh before delivery. No exclusive global ownership of a video is claimed. Real FK/check behavior, unique-collation semantics, lock waits/deadlocks, reverse-lookup indexes/query plans and load remain unverified; row LIMITs do not prove bounded scan cost. The new restrictive FK can prevent hard deletion of a referenced video; existing deletion/provider cleanup handlers were not changed, so detach/deletion ordering must be reviewed before schema activation. Deletion/cleanup/retention remains separate.

Next bounded slice: actual owner selector/reference UI, then an explicit catalog-aware student playback path. [Scoped evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-17.md).
