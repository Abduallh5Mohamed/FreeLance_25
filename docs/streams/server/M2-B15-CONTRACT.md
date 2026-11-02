# M2-B15 — scheduled lesson release, prerequisite progression and the student course path

Task: `client-m2-23-student-learning-path-20261023-01`
Stream: server (implemented in `server/src/routes/course-lessons.ts`,
`server/src/routes/student-course-access.ts`, `server/src/index.ts`,
`server/migrations/20261023_04_lesson_release_progress.sql`)
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. What this surface is

Two things that share one rule set but never share one authority:

1. **A teaching-side configuration WRITE** on the existing private lesson
   surface: an optional explicit UTC `release_at` and an optional
   `prerequisite_lesson_id`, edited by the same owner that can already edit that
   lesson.
2. **A student-side read/completion surface** (`/api/student-course-access/*`)
   that projects the fixed learning path of ONE enrolled, published, active
   course of the student's OWN selected workspace, and records an explicit
   completion with the server's instant.

A lesson is **accessible** to a student when, and only when, all three hold at
the moment the server evaluates the statement:

- the lesson and its unit are `active`;
- `release_at IS NULL OR release_at <= UTC_TIMESTAMP()`;
- `prerequisite_lesson_id IS NULL` **or** a `course_lesson_completions` row
  exists for **this exact** `student_enrollment_id` and that prerequisite.

Accessible means **readable and completable**. It does NOT mean paid, enrolled in
anything else, scheduled for a live session, delivered, notified or audited as
attendance.

Explicitly out of scope and NOT implemented here: OTP / signup / registration,
enrollment creation or approval, payment or subscription, provider / upload /
stream / media delivery, notification, live sessions, search or recommendation,
M3, migration application, and any live DB / network / browser / service /
deploy activity.

## 2. Migration

`server/migrations/20261023_04_lesson_release_progress.sql` — **FILE ONLY, NEVER
APPLIED** by this batch.

| Change | Shape |
| --- | --- |
| `course_lessons.release_at` | `TIMESTAMP NULL DEFAULT NULL`, after `status` |
| `course_lessons.prerequisite_lesson_id` | `CHAR(36) NULL DEFAULT NULL`, after `release_at`, FK → `course_lessons(id)` |
| `idx_course_lessons_prerequisite` | `(prerequisite_lesson_id)` |
| `course_lesson_completions` | NEW table, see below |

```sql
CREATE TABLE IF NOT EXISTS course_lesson_completions (
  id CHAR(36) PRIMARY KEY,
  student_enrollment_id CHAR(36) NOT NULL,
  lesson_id CHAR(36) NOT NULL,
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_course_lesson_completions_enrollment
    FOREIGN KEY (student_enrollment_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_course_lesson_completions_lesson
    FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE,
  UNIQUE KEY uq_course_lesson_completions_enrollment_lesson (student_enrollment_id, lesson_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 2.1 The completion table is NOT `lesson_completions`

`server/migrations/20261018_03_content_release_progress.sql` already creates a
table named **`lesson_completions`** keyed by `(tenant_id, student_enrollment_id,
course_id, lecture_id, source, …)` for the content-release pipeline. That name is
taken, and its shape is incompatible with this feature: it keys a **lecture**
inside the content pipeline, not a **course lesson** in the teaching catalog.

A partial version of this batch tried `CREATE TABLE IF NOT EXISTS
lesson_completions (… student_id, lesson_id, completed_at)` and that would have
failed in two distinct ways, both silent:

1. **`IF NOT EXISTS` makes the whole statement a no-op.** The legacy table
   already exists, so no column of the new shape would ever be created, and the
   first completion write would fail at runtime with an unknown column — in
   production, after the batch was declared done.
2. **The names would collide semantically.** `lesson_completions` is written by
   the content pipeline against `lecture_id`; a lesson-keyed writer sharing the
   name would make two unrelated facts indistinguishable in one table and would
   break the legacy writer's constraints.

Therefore the distinct table **`course_lesson_completions`** is created, keyed by
`student_enrollment_id` + `lesson_id`. `20261018_03` and every existing
content-access route are **untouched**.

### 2.2 Why `student_enrollment_id`, not a user or a client-selected student

The row is keyed by the `students.id` the authenticated principal actually
carries (`student_enrollment_id`), never by a user id and never by a student id
supplied by the caller. One human enrolled at two academies therefore has **two
independent paths**: a completion recorded for one enrollment can never unlock a
lesson for the other. This is proven by a dedicated test.

### 2.3 Idempotency and the immutable instant

The pair is `UNIQUE (student_enrollment_id, lesson_id)`, so there is exactly one
completion per lesson per enrollment. The insert deliberately omits
`completed_at`, so the column default (`CURRENT_TIMESTAMP`) is the **only**
instant authority: no client value and no driver `Date` is ever written. A retry
answers the **original** stored instant and writes nothing — not a new row, not a
new instant, not a second audit event.

### 2.4 No backfill

Both lesson columns are nullable and default to `NULL`, and no `UPDATE` runs.
Every lesson created before this batch therefore means exactly what it always
meant: **no schedule, no prerequisite** — immediately released once active.

## 3. Time handling

The mysql2 pool is configured `timezone: '+02:00'`, which makes the driver
*interpret* wall time on the client side. This surface therefore never writes or
reads a driver `Date`:

- **Writes** use `FROM_UNIXTIME(?)` with an integer epoch second.
- **Reads** use `UNIX_TIMESTAMP(col)` and render
  `new Date(epoch * 1000).toISOString()`, which is always the canonical
  `YYYY-MM-DDTHH:MM:SS.sssZ` projection.
- **Access decisions** compare two EPOCH values in the same statement —
  `release_at IS NULL OR UNIX_TIMESTAMP(release_at) <= UNIX_TIMESTAMP()` — so the
  instant still comes from the DATABASE clock (a skewed browser or Node clock can
  never open a scheduled lesson early) while the comparison is independent of the
  SQL session time zone.

  This is a correction, not a stylistic choice. `release_at` is a `TIMESTAMP`, and
  MySQL renders a `TIMESTAMP` in the **session** zone before comparing it with a
  `DATETIME`. `release_at <= UTC_TIMESTAMP()` was therefore only correct on a
  session whose `time_zone` is UTC, and nothing in this application pins one: the
  pool's `timezone:'+02:00'` is a CLIENT-side decoder option, not a
  `SET SESSION time_zone`. On a `+02:00` server the old form released every lesson
  two hours late (and on a negative offset, early). Both the path read and the
  completion lock use the epoch form, and the server suite proves the same
  before/at/after answer under `0`, `+02:00`, `-05:00` and `+05:30`.

`release_at` must be an **explicit UTC instant** on input:
`YYYY-MM-DDTHH:MM:SS[.sss]Z`. A local wall time, an offset such as `+02:00`, a
date-only value and a bare epoch are all **refused with 400** — converting any of
them would mean the server inventing a time zone. Values are floored to whole
seconds, and an instant outside the `TIMESTAMP` range
(`1 … 2147483647`, i.e. `1970-01-01T00:00:01Z … 2038-01-19T03:14:07Z`) is refused
rather than truncated.

## 4. Teaching-side configuration

`POST /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons` and
`PATCH …/lessons/:lessonId` accept two additional **optional** keys:

| Key | Absent | `null` | Value |
| --- | --- | --- | --- |
| `release_at` | keep (create: no schedule) | clears the schedule | explicit UTC instant |
| `prerequisite_lesson_id` | keep (create: no prerequisite) | clears the prerequisite | canonical lesson id |

The lesson DTO grows from eight to **ten** fields; the two new ones are
`release_at: string | null` and `prerequisite_lesson_id: string | null`. No other
field, and no tenant/owner/contact field, is added.

A prerequisite is accepted only when it is:

- **not the target** — compared on canonical identity, so a case variant of the
  target's own id is still the target;
- **in the same course**;
- **`status = 'active'`**;
- **in an ACTIVE unit** — the student path reads active units only, so a lesson of
  an archived unit is not on the path at all and an edge to it could never be
  satisfied;
- **strictly earlier** than the target under the ONE learning-path order, judged
  against the target's **FINAL** position when a single patch changes both the
  position and the prerequisite.

### 4.1 The ONE order

There is exactly one definition of "earlier", and it is the order the student path
reads: **`(unit.display_order, unit.id, lesson.display_order, lesson.id)`**.

The unit comes FIRST because that is how the path is traversed. A lesson of an
earlier unit may therefore gate a lesson of a later unit, and the reverse is never
allowed — whatever the two in-unit positions say. Comparing only
`(lesson.display_order, lesson.id)`, as the first M2-23 implementation did, accepted
cross-unit edges that the student path then read in the opposite order.

Because every permitted edge points strictly backwards under one fixed total order,
a cycle is unreachable through the API. A bounded stored-chain walk
(`PREREQUISITE_CHAIN_MAX = 512`) additionally catches an out-of-band cycle
introduced by a direct database write before the row is committed.

### 4.2 The final-state invariant

`display_order` is part of that order, so any write that MOVES a lesson has to be
proved not to invert an edge before it commits. Two directions are checked:

1. the moved lesson's **own** stored prerequisite must still sort strictly before
   its final position — this covers a `display_order`-only `PATCH`, which the first
   implementation never re-validated;
2. every ACTIVE lesson that points **into** a moved lesson must still sort strictly
   after it. Only lessons of the same unit can be affected, because a reorder never
   changes a unit's own position. A dependent set larger than
   `PREREQUISITE_DEPENDENTS_MAX = 1000` cannot be proved in one bounded read and is
   refused rather than assumed ordered.

An inversion is `409 { "error": "Course lesson prerequisite order would be
invalidated" }`, and **nothing is written**: no `UPDATE`, no audit row, no commit.
The same proof runs for a `PATCH` that moves one lesson and for a reorder batch,
and the batch is refused as a whole.

A stored edge that is being **kept unchanged** by an unrelated edit (a retitle, a
description) is not re-asserted: a pre-existing inconsistency must not block a
write that does not touch the order.

### 4.3 Archival policy

Archiving takes a lesson — or a whole unit — off the student path. An edge into it
would then be unsatisfiable and the dependent lesson would be locked forever, so:

- a lesson that is the prerequisite of an **ACTIVE** lesson cannot be archived →
  `409 { "error": "Course lesson is a prerequisite of an active lesson" }`;
- a unit that holds such a lesson cannot be archived →
  `409 { "error": "Course unit contains a prerequisite of an active lesson" }`.

**Prerequisites are never erased automatically.** The owner clears the edge
explicitly (a `PATCH` with `prerequisite_lesson_id: null`, which is a visible
decision and an audited change) and only then archives. No alternative unlock rule
is invented, and archiving a lesson or unit whose dependents are already archived
still succeeds.

The unit-archive guard is the ONE statement in `course-units.ts` that reads
`course_lessons.prerequisite_lesson_id`, so unit archival now requires the additive
`20261023_04` migration. On a database without it that statement fails closed (500)
instead of archiving a unit that would strand a dependent lesson.

The actual change and its sanitized audit event (`old_value` / `new_value` with
exactly the nine documented keys, both new fields included) share **one
transaction**. An identical retry is a truthful **no-op**: no `UPDATE`, no audit
row, and the current DTO is returned. A lost commit acknowledgement does not
claim success: the uncertain connection is destroyed rather than reused.

## 5. The student surface

Mounted at **`/api/student-course-access`** in `server/src/index.ts`, behind the
same `/api` guards as every other route (`optionalAuth` →
`enforceTenantAuthorityBoundary` → `enforceStudentWorkspaceBoundary`). It is a
**separate router** so the owner-only teaching catalog is never widened by it.

### 5.1 Identity

The router accepts **no** tenant, student or enrollment selector from the body,
the query string or the headers. `tenantId` and `studentEnrollmentId` are derived
**only** from the verified `req.user`, and the enrollment predicate is re-proved
on the same connection that reads. Consequences:

- anonymous → `401 Authentication required`;
- a non-student principal → `403 Student access required`;
- no selected workspace → `409 Select an instructor workspace first`
  (`STUDENT_SPACE_REQUIRED`, raised by the boundary before the router);
- any supplied selector (including the caller's OWN student id) →
  `400 Workspace context is resolved from the authenticated session`.

No enrollment is ever created, approved or repaired here.

### 5.2 `GET /courses`

```json
{ "courses": [{ "course_id": "…", "name": "…", "subject": null, "grade": null }], "truncated": false }
```

Exactly the four documented keys per course. Only courses with an **active**
`student_courses` row for this enrollment AND `courses.is_active = TRUE` AND
`courses.publication_state = 'published'` in the principal's tenant, ordered by
`(name, id)`, bounded to `COURSE_LIST_MAX = 100` rows (`LIMIT 101`, sliced).
`Cache-Control: no-store` is set before any read.

### 5.3 `GET /courses/:courseId`

```json
{
  "course": { "course_id": "…", "name": "…", "subject": null, "grade": null },
  "units": [
    { "unit_id": "…", "name": "…", "display_order": 0,
      "lessons": [
        { "lesson_id": "…", "title": "…", "display_order": 0,
          "release_at": null, "prerequisite_lesson_id": null,
          "accessible": true, "lock_reason": null,
          "completed": false, "completed_at": null,
          "description": "…" }
      ] }
  ],
  "truncated": false
}
```

- One bounded statement, `ORDER BY u.display_order, u.id, l.display_order, l.id`
  — deterministic, no client sort and no cursor.
- Only `active` units and `active` lessons.
- At most `PATH_MAX_LESSONS = 500` lessons.
- `description` is bounded in SQL (`SUBSTRING(…, 1, 600)`) and is emitted **only
  when the lesson is accessible**. A locked or unreleased lesson carries
  `description: null` **in the DTO itself**, so the private wording never leaves
  the server and the renderer has nothing to hide.
- `lock_reason` is `null` for an accessible lesson, otherwise `not_released`
  (checked first) or `prerequisite_incomplete`.
- A non-UUID `courseId` is refused **before any statement**; a foreign,
  unpublished, archived, unenrolled or absent course answers an
  **indistinguishable** `404 Course not found`.

### 5.4 `POST /courses/:courseId/lessons/:lessonId/completion`

- The body must be **absent, `null`, or an object with zero keys**; anything else
  is `400 Invalid completion payload` before a connection is taken.
- A non-UUID course or lesson id is `404` before any statement.
- The course is re-proved (enrollment + published + active) and the lesson must
  belong to it and be `active`, otherwise `404 Lesson not found`.
- A locked lesson is `409 { "error": "Lesson is not accessible yet",
  "code": "LESSON_LOCKED", "reason": "not_released" | "prerequisite_incomplete" }`.
- An existing completion row is read back **inside** the transaction (with
  `FOR UPDATE`, so two concurrent retries serialize) and answered with the
  **stored** instant, `commit: false`, no insert.
- Otherwise exactly one row is inserted with `(id, student_enrollment_id,
  lesson_id)`; `completed_at` comes from the column default. The row is read back
  in the same transaction and rendered from its epoch.
- The response is `{ "completion": { "lesson_id": "…", "completed_at": "…" } }`.
- It grants **no** enrollment, payment status or authorization. It records one
  progression fact.

## 6. Documented answers

| Status | Body `error` | When |
| --- | --- | --- |
| 400 | `Workspace context is resolved from the authenticated session` | a selector was supplied |
| 400 | `Invalid completion payload` | a non-empty completion body |
| 400 | `Invalid course lesson release` / `Invalid course lesson prerequisite` | teaching-side malformed value |
| 401 | `Authentication required` (router), `Token expired`, `Invalid token`, `No token provided`, `Session revoked`, `Selected workspace is no longer active` | authentication / workspace |
| 403 | `Student access required` | a non-student principal |
| 403 | `Forbidden` | teaching-side non-owner |
| 404 | `Workspace not found`, `Course not found`, `Lesson not found` | indistinguishable scope misses |
| 409 | `Select an instructor workspace first` (`STUDENT_SPACE_REQUIRED`) | no selected workspace |
| 409 | `Lesson is not accessible yet` (`LESSON_LOCKED`) | unreleased / prerequisite unmet |
| 409 | `Course lesson prerequisite order would be invalidated` | a `PATCH` or reorder would invert a stored edge |
| 409 | `Course lesson is a prerequisite of an active lesson` | archiving a lesson an active lesson waits on |
| 409 | `Course unit contains a prerequisite of an active lesson` | archiving a unit that holds such a lesson |
| 500 | `Failed to load courses`, `Failed to load learning path`, `Failed to record lesson completion` | unreadable projection or write failure |

The shared transport throws the server's `error` message **without** the HTTP
status and **without** the `code`, so only these documented messages classify an
outcome on the client. No status is fabricated there.

## 7. What is NOT claimed

- The migration is **not applied**. On a real deployment without it, every
  student read and every lesson write answers a truthful error; no fallback data
  is invented.
- No enrollment, payment, subscription, notification, live session, upload,
  streaming or media delivery exists on this surface.
- No tenant, student or enrollment selector is trusted from the client, and no
  lesson capability is inferred from a local role, a profile or a tenant status.
- Nothing here asserts that the whole platform, or all of M2, is complete.
