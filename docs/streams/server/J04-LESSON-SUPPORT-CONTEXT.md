# J04 — verified lesson context on support requests, BUILD-12

Local continuation of [reliable support writes](J04-SUPPORT-WRITE-RELIABILITY.md), 2026-11-05. This slice links a student's request to a lesson; it does not assign the request to a teacher, change platform-support authority or grant content access.

## Inputs and endpoints

- `GET /api/student-course-access/courses/:courseId/lessons/:lessonId/support-context`: empty body/query, authenticated student with a selected server-resolved workspace. Returns exactly `{context}` after source/schema proof. Client tenant/enrollment/student selectors are refused.
- Existing keyed `POST /api/support-tickets` accepts optional `context: {kind:'catalog_lesson',course_id,lesson_id}`. These three keys are exact; no caller tenant, enrollment, title, URL or other context field is accepted. Tenant/enrollment are derived from the live authenticated principal and canonical enrollment row. A generic request omits context.
- `GET /api/support-tickets/:id/context`: ticket owner or verified platform `support.read` authority, no query selector. Returns exactly `{state,context}`. State is `available`, `none`, `unavailable` or `unconfigured`. Only `available` has a context object.

The context DTO is exactly `kind,course_id,lesson_id,course_name,lesson_title`. It includes no tenant/enrollment/user selector, description, contact, material/storage URL, payment data or assessment answers. Existing learning-path, material, ticket and write acknowledgement DTOs are unchanged. All new reads declare `no-store`.

## Source and transactional proof

`student-lesson-access.ts` extracts the existing enrollment/course/private-material lesson proof into a pure shared helper. The real private material read and new context proof use it. Enrollment must belong to the same user and tenant, be active/approved and within its database-clock window, and its tenant must be active. Its `student_courses` link must be active. Course must be active/published in that tenant; lesson/unit must be active in that course. Release uses Unix epochs and prerequisites use only that enrollment's completion ledger.

Preflight does not grant persistence authority. Creation repeats proof in the same transaction as ticket insertion, context binding and sanitized audit. Enrollment/tenant, course enrollment, course, unit and lesson reads lock their source rows. Context sources must be InnoDB; missing/unreadable proof fails closed before ticket insertion. No provider I/O occurs inside these transactions.

Stored references are immutable within this slice. A same-key replay compares requested course/lesson and server workspace against the original binding; omission or changed binding conflicts. A confirmed original contextual write remains reconcilable after withdrawal: its ordinary ticket acknowledgement contains no lesson metadata and does not re-grant access. Lost COMMIT still returns uncertain and destroys the connection; audit failure rolls back ticket and binding together.

Context reads recheck the ticket and resolve the original requester/context scope from stored rows. A student requester must also be in that same currently selected tenant/enrollment; switching workspace does not expose names from another workspace. Verified platform support can read the bounded reference for this authorized ticket only, after rechecking requester liveness and that requester's current lesson eligibility. Source expiry, archive, withdrawal or unmet prerequisite returns `unavailable` with null context; stored IDs alone never authorize a fresh title lookup. Names come from the current proof, not a historical title snapshot. Course/lesson metadata can change after a snapshot; no real-time revocation/polling is claimed. Free-form historical ticket text remains ticket data, not proof of lesson access.

## Schema and compatibility

Unapplied additive file: `server/migrations/20261105_02_support_lesson_context.sql`. Five nullable columns on `support_tickets` store kind plus tenant/enrollment/course/lesson references. Existing records default to all-null and are not backfilled as verified contexts. The CHECK requires all-none or a complete reference. Historical references deliberately do not cascade-delete tickets or grant access when source rows disappear.

Actual column presence is probed, not inferred from the file. Missing all five leaves contextual requests/preflight unavailable, while ordinary generic support creation still works; ticket context reads return `unconfigured`. Partial schema or corrupt binding fails closed. Integrity/retention/schema-loss handling remains an operator gate, not automatic repair. No migration was applied or live schema verified.

## UI and lifecycle

Only a server-accessible lesson shows **request lesson help** on the actual student learning path. Its link carries course/lesson UUID selectors only. Support validates the pair, fetches fresh preflight and opens the request form. An invalid, locked or unconfigured reference cannot silently become a generic request: the user must explicitly choose **continue with general support**. No request is sent merely by opening the link.

The actual create payload carries references only after verified preflight, and source proof is repeated on POST. Pending-attempt recovery remains independent of draft context: the original confirmed ticket can be recovered by GET even when a newly requested context is unavailable. Account/operation attempt keys remain opaque; private draft text is not added to browser storage.

Draft-target changes dispose the prior create/context controller; ticket selection changes retire old context reads. Session changes and denied ticket-context reads clear private views; denied draft preflight only disables that context and permits explicit generic fallback. Verified names never render under a different draft target, and the existing reply/history workflow remains available. The modal has bounded vertical scrolling and wraps context names on mobile.

## Remaining gates

Follow-up: [private support notes](J04-SUPPORT-PRIVATE-NOTES.md) were subsequently implemented locally in BUILD-13, with a separate unapplied table migration. Assignment and staff mapping remain open; the following paragraph preserves the original checkpoint.

Actual schema application and MySQL locking/check/query-plan evidence remain unverified. Platform-support assignment/transfer, private notes, response-time policy, teacher-owner context creation, parent/attempt/transfer contexts and staff identity mapping are separate work. This is not an automatic teacher inbox or a financial/provider action.
