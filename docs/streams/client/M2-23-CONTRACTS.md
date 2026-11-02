# M2-23 — client contracts: scheduled release, prerequisite progression and the student learning path

Task: `client-m2-23-student-learning-path-20261023-01`
Server contract: `docs/streams/server/M2-B15-CONTRACT.md`
Status: implemented and reported by the WorkBuddy worker. **A worker report is
not acceptance.**

## 1. Modules touched

| Path | Role |
| --- | --- |
| `src/lib/api-http.ts` | Canonical transport: `CourseLesson` grows to ten fields and the create/update inputs forward `release_at` / `prerequisite_lesson_id`; the student adapters and their DTO types are added (additive only; `request` and every existing adapter are unchanged) |
| `src/features/catalog/course-lessons.ts` | The accepted M2-10 controller, extended with the release draft, the prerequisite draft, their strict parsers and their change detection. Every pre-existing behaviour is untouched |
| `src/features/catalog/CourseLessonManager.tsx` | Two new form controls: a UTC release input and a prerequisite selector restricted to provably earlier active lessons |
| `src/features/catalog/student-learning-path.ts` | NEW — the server-authoritative student controller: bounded course list, bounded learning path, ONE completion write at a time, strict DTO parsing and every lifetime fence |
| `src/pages/StudentContent.tsx` | Replaces the localStorage student/material selector with the learning-path controller |
| `src/tests/m2-course-lesson-ui.test.ts` | The corrected `Headers` assertion plus the M2-23 parse/write/component block (the 76 pre-existing tests still pass) |
| `src/tests/m2-student-learning-path.test.ts` | NEW — production-path tests for the student controller and its parsers |

## 2. Transport

```ts
createCourseLesson(courseId, unitId, { title, description?, display_order?, release_at?, prerequisite_lesson_id? })
updateCourseLesson(courseId, unitId, lessonId, { title?, description?, display_order?, status?, release_at?, prerequisite_lesson_id? })

listStudentCourses()                       -> GET  /api/student-course-access/courses
getStudentLearningPath(courseId)           -> GET  /api/student-course-access/courses/:courseId
completeStudentLesson(courseId, lessonId)  -> POST /api/student-course-access/courses/:courseId/lessons/:lessonId/completion
```

- An **absent** `release_at` / `prerequisite_lesson_id` is never invented: the
  key is added to the body only when the caller passed something other than
  `undefined`. An explicit `null` **is** forwarded, because `null` is the clear.
- The completion body is exactly `{}` — completion is a fact with no attributes,
  so no instant, lesson, student or enrollment is ever stated by the client.
- The course and lesson ids are **resource selectors**, never authority. There is
  no tenant, student or enrollment selector in any header, query or body.
- `request` sends a real `Headers` instance. The canonical authenticated read
  assertion therefore reads it through `new Headers(call.init.headers)` instead
  of casting it to a plain object; the `Authorization` and `Content-Type` values
  are still asserted verbatim, so the canonical behaviour is unchanged and not
  weakened.

## 3. Strict DTO parsing

`CourseLesson` (teaching side) is exactly ten keys, and `parseCourseLesson`
refuses the whole row when `release_at` is neither `null` nor a canonical
`YYYY-MM-DDTHH:MM:SS.sssZ` instant that is also a **real** instant, or when
`prerequisite_lesson_id` is neither `null` nor a UUID.

Student side, all exported for test:

| Parser | Enforces |
| --- | --- |
| `parseStudentCourseSummary` | exactly `{course_id,name,subject,grade}`; UUID id; non-blank 1..255 name; nullable 1..255 subject/grade |
| `parseStudentLesson` | exactly the ten documented keys; UUID lesson id; 1..255 title; integer `display_order` in `0..2147483647`; `null` or canonical instant for `release_at`/`completed_at`; `null` or UUID prerequisite that is **not** the lesson itself; `accessible`/`completed` are real booleans; `lock_reason` is one of the two documented reasons; **`accessible` ⇒ no lock reason, locked ⇒ exactly one reason**; **locked ⇒ `description === null`**; `completed` ⇔ `completed_at !== null`; description at most 600 characters |
| `parseStudentUnit` | exactly `{unit_id,name,display_order,lessons}` |
| `parseStudentCourseListEnvelope` | exactly `{courses,truncated}`; at most 100 courses; no duplicate `course_id` |
| `parseStudentLearningPathEnvelope` | exactly `{course,truncated,units}`; no duplicate unit or lesson id; at most 500 lessons **checked before any row is copied** |
| `parseStudentCompletionEnvelope` | exactly `{completion:{lesson_id,completed_at}}`; the answered lesson must be the **requested** one; a canonical server instant |

A body that claims a description for a locked lesson is **malformed and refused
whole**, so a leak cannot be rendered even by accident.

## 4. Teaching-side editor

- `parseCourseLessonRelease(draft)` — `''` is `null` ("no schedule"); a non-empty
  value must be `YYYY-MM-DDTHH:MM[:SS][.sss]Z`, a real calendar instant, and
  inside the `TIMESTAMP` range; the result is normalised to the canonical
  projection. A local time, an offset, a date-only value, a bare epoch, an
  impossible date and an out-of-range instant are refused locally with
  `COURSE_LESSON_RELEASE_INVALID_MESSAGE`.
- `parseCourseLessonPrerequisite(draft)` — `''` is `null`; a non-empty value must
  be a UUID and is canonicalised to lowercase.
- **Change detection runs on the normalised value**, so re-typing the same
  instant in another accepted shape (`…T09:00Z` vs `…T09:00:00.000Z`) is a
  truthful local no-op instead of a write the server would report as unchanged.
  The prerequisite is compared on its canonical identity for the same reason.
- `openEditForm` seeds both drafts from the stored row, so opening the form never
  silently drops a configuration the teacher did not touch.
- The prerequisite `<select>` offers only lessons of the current page that are
  **active** and **strictly earlier** than the edited lesson under
  `(display_order, id)`, judged against the position the lesson will actually
  have (the typed draft, otherwise the stored one). Two cases cannot be proven
  from the browser and are therefore **not guessed**:
  - a lesson being **created with no stated position** is stored at position `0`
    and the tie is broken by an id the browser cannot know, so the selector is
    disabled and the form explains why;
  - a candidate at exactly the target's position is earlier only when its id
    sorts first, which is knowable only when the target already exists.
  The list is a convenience, never the authority: the server revalidates every
  edge against the final position and a rejection is shown as its own message.

### 4.1 The server's order is wider than this selector (M2-23 batch 5)

The authoritative order is **`(unit.display_order, unit.id, lesson.display_order,
lesson.id)`** — the order the student path reads. Two consequences the editor does
not hide:

- the selector offers only lessons of the **current page**, i.e. of one unit, so it
  is deliberately **narrower** than the server: a cross-unit prerequisite that the
  server accepts (an earlier unit gating a later one) cannot be expressed in this
  form. That is a missing convenience, not a contradiction — the server never
  widens what the browser offers and the browser never claims to be the authority;
- the server now also **refuses** writes the old handler accepted:
  - `409 Course lesson prerequisite order would be invalidated` — a position change
    (this form's `display_order` field, or a reorder) would put a lesson at or
    before its prerequisite, or a dependent at or before the lesson it waits on.
    Nothing is written. The form shows the message and keeps the draft, so the
    owner can correct the position instead of losing it;
  - `409 Course lesson is a prerequisite of an active lesson` — archiving a lesson
    that an active lesson still waits on. The prerequisite is **never** cleared
    automatically: the owner clears it explicitly first, which is an audited
    change rather than a silent one.

  Both are ordinary `409`s carrying the documented `error` message, so
  `ApiRequestError` surfaces them unchanged; no new client state or retry path is
  introduced. The completion flow is untouched: a `Lesson is not accessible yet`
  refusal is still definite and never retried.

## 5. Student controller

`createStudentLearningPathController(api)` owns every request and every decision
boundary; `StudentContent.tsx` only renders the published snapshot.

State: `courses` / `coursesPhase` (bounded list) and `courseId` / `course` /
`units` / `phase` (bounded path), plus `refreshError`, `lastCompletion` and the
single `mutation`.

| Method | Behaviour |
| --- | --- |
| `open()` | the bounded course list, then the first enrolled course's path. Nothing is requested before this |
| `refreshCourses()` | re-reads the list and the path of the current (or first) course |
| `selectCourse(id)` | invalidates **every** in-flight reply, drops the old path **before** the new read, then reads that course |
| `refreshPath()` | re-reads the current course path |
| `completeLesson(id)` | ONE write at a time; a lesson outside the shown path is refused locally |
| `reconcile()` | a deliberate read-only re-read after an uncertain write |
| `waitForIdle()` / `dispose()` | wait for every tracked operation / clear everything and retire it |

Lifetimes fenced:

- **session** — the canonical principal is re-read at entry and at completion of
  every read and write, on the success and failure path, and a retired operation
  observes it before settling any visible state. A session change clears the
  courses, the path, the selection and the mutation;
- **course** — the path is bound to one course id; a reply for another course is
  **malformed**, never rendered;
- **request** — each read advances a generation; a reply commits only while its
  generation is current, its principal matches and the controller is alive. The
  bounded list and path reads are single-flight, so a double `open()` issues one
  read;
- **write** — the latch is taken **synchronously** before the first await, so a
  double click or a click+Enter sends exactly one request, and an older `finally`
  can never release a newer write's latch. It is released as soon as the server
  **confirms** the completion, before the bounded follow-up read;
- **dispose** — clears everything and resolves `waitForIdle()`.

Honesty rules:

- a confirmed completion uses the validated server envelope only. The matching
  lesson is marked `completed` with the **server's** instant; `accessible` and
  `lock_reason` are **not** touched, because the client never decides that a
  prerequisite edge is now satisfied. What the completion unlocks is whatever the
  bounded follow-up read says;
- a `Lesson is not accessible yet` refusal is **definite** (not uncertain) and is
  never retried;
- a `500`, a network failure or an unreadable body is **uncertain**: the path is
  preserved, nothing is retried automatically, and only an explicit read
  reconciliation is offered — which never claims the earlier write succeeded;
- a failed follow-up read after a confirmed completion sets `refreshError` and
  never turns the confirmed completion into a failure.

## 6. `StudentContent.tsx`

The page no longer reads a student id from `localStorage` and no longer calls
`getStudentMaterials`. It renders:

- the bounded course selector (the server's own enrolled/published list), with
  `aria-pressed` per course;
- the learning path grouped by unit, with a lock icon, the **server's** lock
  reason, the position, the completion badge and the raw UTC `release_at` /
  `completed_at` values (rendered `dir="ltr"`, never converted into a local time);
- the description **only** when the lesson is accessible — a locked row has no
  description to render because the server withholds it;
- one `تسجيل الإتمام` control per accessible, not-yet-completed lesson, disabled
  while a write is in flight, plus the `aria-live` feedback region and the
  explicit reconciliation control after an uncertain write;
- honest phases for `loading` / `empty` / `malformed` / `error` / `unauthorized`
  / `forbidden` / `no-workspace` / `missing-course`, and the truncation notice at
  the server's own bounds (100 courses, 500 lessons).

The page never creates an enrollment, never offers OTP or signup, and never
decides who the student is or which lesson is unlocked.

## 7. What is NOT claimed

- The migration is **not applied**; a real deployment answers truthful errors.
- No OTP, signup, enrollment/payment/subscription creation, upload, streaming or
  media delivery is added.
- No lesson capability, enrollment or unlock is inferred from a local role, a
  profile, a course selection or a tenant status.
- DOM paint, real RTL layout, real HTTP, a real database and end-to-end
  authorization are **not** proven here; the server remains authoritative.
- Nothing here asserts that the whole platform, or all of M2, is complete.
