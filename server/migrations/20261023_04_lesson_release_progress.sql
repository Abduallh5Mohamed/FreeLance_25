-- M2-23 — scheduled lesson release, configured prerequisite progression and
-- per-enrollment lesson completion.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-23 batch
-- (task client-m2-23-student-learning-path-20261023-01): no database was
-- connected, no statement was executed, no seed/backfill ran and no runtime
-- DDL exists in the application. Applying it is a separate, explicitly
-- authorized integration gate (see docs/streams/server/M2-B15-CONTRACT.md).
--
-- Additive only: two nullable columns on `course_lessons`, one self-referencing
-- foreign key, one index, and one NEW table. No column is altered, dropped or
-- re-typed; no existing row is rewritten; there is NO backfill.
--
-- ---------------------------------------------------------------------------
-- Why every existing lesson stays immediately released
-- ---------------------------------------------------------------------------
--
-- `release_at` is NULLABLE and has NO DEFAULT. NULL means "no schedule": the
-- lesson is released the moment it becomes active. That is the only safe
-- reading of an existing row, because before this batch no lesson could carry a
-- release instant at all — so the absence of one cannot mean "withheld". A
-- NOT NULL default would have had to invent an instant (1970, or "now"), and
-- either would be a fabricated date rather than a recorded one.
--
-- `prerequisite_lesson_id` is likewise NULLABLE with no default: NULL means
-- "no prerequisite", which is the only truthful reading of a row written before
-- this batch. No lesson is retroactively gated behind another.
--
-- ---------------------------------------------------------------------------
-- Why the prerequisite is a single self-reference and not a join table
-- ---------------------------------------------------------------------------
--
-- The approved behaviour is one OPTIONAL earlier lesson of the SAME COURSE, not
-- an arbitrary dependency graph. A single nullable self-reference states
-- exactly that: at most one prerequisite per lesson, and the handler enforces
-- that it is an ACTIVE lesson of the same course that sorts strictly BEFORE the
-- target under the list's own total order `(display_order, id)`.
--
-- That ordering rule is what makes a cycle structurally unreachable through
-- this API: every permitted edge points strictly backwards in one fixed total
-- order, so a chain can never return to its start. The handler still walks the
-- stored chain (bounded) before writing, so a cycle introduced by an out-of-band
-- edit is detected and refused rather than extended.
--
-- The foreign key has NO ON DELETE clause. `course_lessons` rows are never hard
-- deleted by the application (archiving is a status change), so the constraint
-- only has to refuse an orphaning delete, not cascade one.
--
-- ---------------------------------------------------------------------------
-- Why the completion table is `course_lesson_completions` and NOT
-- `lesson_completions`
-- ---------------------------------------------------------------------------
--
-- `lesson_completions` ALREADY EXISTS. It was created by
-- `server/migrations/20261018_03_content_release_progress.sql` (task
-- m2-server-content-release-sequential-unlock-20261018-03) and has an
-- incompatible shape owned by a different feature:
--
--     lesson_completions(
--       id, tenant_id, student_enrollment_id, course_id, lecture_id,
--       source, completed_at
--     )
--
-- It records progress against the legacy `lectures` content pipeline, keyed by
-- `lecture_id`. The M2-23 learning path is about `course_lessons` rows of the
-- unit/lesson catalog, which is a different entity with a different lifecycle.
--
-- Reusing that table name would have been silently broken in two ways:
--   1. `CREATE TABLE IF NOT EXISTS lesson_completions (...)` would have been a
--      NO-OP on any database where 20261018_03 had already run, leaving the
--      legacy columns in place and NOT creating `lesson_id` at all — the route
--      would then fail at runtime with an unknown-column error rather than at
--      review time;
--   2. even if the shape had matched, one table cannot be the idempotency
--      ledger for two unrelated keys (`lecture_id` vs `lesson_id`) without an
--      ambiguous unique constraint and cross-feature rows.
--
-- This file therefore creates a DISTINCT table and never touches the legacy
-- one. `20261018_03` and the existing content-access routes are unmodified.
--
-- ---------------------------------------------------------------------------
-- Why completions are keyed by `student_enrollment_id`
-- ---------------------------------------------------------------------------
--
-- A student identity is global (`users`); each `students` row is one
-- TENANT-SCOPED enrollment (`students.tenant_id`). The authenticated student
-- principal carries a selected `student_enrollment_id`, which is exactly that
-- `students.id`.
--
-- Keying the ledger on `student_enrollment_id` rather than on a bare user id
-- means:
--   * the same human enrolled at two academies has two independent learning
--     paths, and a completion in one can never unlock a lesson in the other;
--   * the row cannot be written from a client-supplied user/student selector,
--     because the handler only ever binds the principal's own enrollment id;
--   * `student_courses` (which is keyed by `student_id` -> `students.id`) and
--     this ledger share one identity, so "is enrolled" and "has completed" are
--     asked about the same row.
--
-- The FK to `students(id)` is ON DELETE CASCADE: deleting an enrollment row is
-- an administrative erasure of that enrollment, and its progress must not
-- outlive it. The FK to `course_lessons(id)` is ON DELETE CASCADE for the same
-- reason; the application never hard-deletes a lesson (archiving is a status
-- change), so the clause is a safety net, not a normal path.
--
-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------
--
-- `UNIQUE KEY uq_course_lesson_completions_enrollment_lesson
--  (student_enrollment_id, lesson_id)` is the idempotency guarantee itself: a
-- second completion attempt for the same pair cannot insert a second row, so a
-- retried request can only ever read back the ORIGINAL instant. `completed_at`
-- is never updated on retry.
--
-- As in the accepted M2-B05 lesson table, the COURSE and the TENANT are NOT
-- duplicated here. They are derived through `course_lessons` -> `course_units`
-- -> `courses`, so an independent course_id/tenant_id column can never disagree
-- with the parent relation. A per-course progress read is a three-way join on
-- primary keys.
--
-- `completed_at` is a TIMESTAMP, so it carries an INSTANT and is read with
-- `UNIX_TIMESTAMP(col)`: the mysql2 pool is configured with `timezone:'+02:00'`
-- and interprets the wall time it receives on the client side, which would
-- otherwise shift every serialized instant. The TIMESTAMP range
-- (1970-01-01 00:00:01 UTC .. 2038-01-19 03:14:07 UTC) bounds the representable
-- epochs, and the handler refuses an instant outside it instead of storing a
-- truncated one.
--
-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
--   idx_course_lessons_prerequisite -> `prerequisite_lesson_id`, so the bounded
--       reverse lookup used by the cycle walk is an index read.
--   uq_course_lesson_completions_enrollment_lesson -> the idempotent insert AND
--       the per-course progress read (`student_enrollment_id` leads, so the
--       join to the lesson's unit/course is driven from the student's own rows).
--
-- No index is declared for `release_at`: the student path is always qualified by
-- course (through the unit), never by release instant alone, so an index on the
-- instant would not serve any statement this batch introduces.
--
-- No enrollment, entitlement, payment, capacity, asset or contact data is added
-- here. Completion grants no access beyond progression and creates no
-- enrollment.

ALTER TABLE course_lessons
  ADD COLUMN release_at TIMESTAMP NULL DEFAULT NULL AFTER status,
  ADD COLUMN prerequisite_lesson_id CHAR(36) NULL DEFAULT NULL AFTER release_at,
  ADD CONSTRAINT fk_course_lessons_prerequisite
    FOREIGN KEY (prerequisite_lesson_id) REFERENCES course_lessons(id),
  ADD INDEX idx_course_lessons_prerequisite (prerequisite_lesson_id);

-- Deliberately NOT `lesson_completions` (see the header): that name is already
-- owned by 20261018_03_content_release_progress.sql with an incompatible
-- `lecture_id`-keyed shape.
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
