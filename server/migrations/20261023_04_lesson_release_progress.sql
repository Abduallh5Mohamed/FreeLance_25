-- M2-23 — scheduled lesson release, configured prerequisite progression and
-- per-student lesson completion.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-23 batch
-- (task client-m2-23-student-learning-path-20261023-01): no database was
-- connected, no statement was executed, no seed/backfill ran and no runtime
-- DDL exists in the application. Applying it is a separate, explicitly
-- authorized integration gate (see docs/streams/server/M2-B15-CONTRACT.md).
--
-- Additive only: two nullable columns on `course_lessons`, one self-referencing
-- foreign key, one index, and one new table. No column is altered, dropped or
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
-- Why completions are their own table
-- ---------------------------------------------------------------------------
--
-- Completion is a fact about ONE STUDENT and ONE LESSON, recorded once, with the
-- SERVER's instant. It is deliberately NOT a mutable column on `student_courses`
-- (which is an enrollment, not a progress ledger) and NOT a counter.
--
-- `UNIQUE KEY uq_lesson_completions_student_lesson (student_id, lesson_id)` is
-- the idempotency guarantee itself: a second completion attempt for the same
-- pair cannot insert a second row, so a retried request can only ever read back
-- the ORIGINAL instant. The instant is never updated on a retry.
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
-- (1970-01-01 00:00:01 UTC .. 2038-01-19 03:14:07 UTC) bounds the
-- representable epochs, and the handler refuses an instant outside it instead of
-- storing a truncated one.
--
-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
--   idx_course_lessons_prerequisite -> `prerequisite_lesson_id`, so the bounded
--       reverse lookup used by the cycle walk is an index read.
--   uq_lesson_completions_student_lesson -> the idempotent insert AND the
--       per-course progress read (`student_id` leads, so the join to the
--       lesson's unit/course is driven from the student's own rows).
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

CREATE TABLE IF NOT EXISTS lesson_completions (
  id CHAR(36) PRIMARY KEY,
  student_id CHAR(36) NOT NULL,
  lesson_id CHAR(36) NOT NULL,
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_lesson_completions_student
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT fk_lesson_completions_lesson
    FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE,
  UNIQUE KEY uq_lesson_completions_student_lesson (student_id, lesson_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
