-- M2-B05 — private course-lesson metadata foundation.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-B05 batch
-- (task client-m2-b05-lesson-catalog-20261021-01): no database was
-- connected, no statement was executed, no seed/backfill ran, and no runtime
-- DDL exists in the application. Applying it is a separate, explicitly
-- authorized integration gate (see docs/streams/server/M2-B05-CONTRACT.md).
--
-- Additive only: one new table. No ALTER/DROP/TRUNCATE on an existing table,
-- no data backfill, no default lesson, no index rebuild on another table and
-- no change to `courses` or `course_units`.
--
-- Policy encoded by this table (contract: docs/streams/server/M2-B05-CONTRACT.md):
--   * a lesson belongs to exactly one UNIT (`course_units`); the COURSE and
--     the TENANT are DERIVED through that unit and its course
--     (`course_units.course_id` -> `courses.tenant_id`) and are deliberately
--     NOT duplicated here, so an independent course_id/tenant_id column can
--     never disagree with the parent relation;
--   * title is a trimmed free label of 1..255 characters and is deliberately
--     NOT unique: the lesson id (UUID) is the identity, so duplicate titles
--     are allowed and no uniqueness rule is inferred;
--   * description is nullable free text with a 10000-character engineering
--     bound enforced by the handler. It is stored verbatim and carries no
--     content, asset, URL or delivery semantics: this table references no
--     file, video, material or provider object;
--   * display_order is a nonnegative signed 32-bit integer (0..2147483647).
--     The order MAY tie between two lessons: the lesson id is the stable
--     tie-breaker of the keyset list, and no renumbering or normalisation
--     policy is implied by a partial batch reorder;
--   * status is only 'active' or 'archived'. Archiving changes lesson
--     metadata only; it grants or revokes no course, unit, material, student
--     or teacher access, publishes nothing and affects no progress, drip or
--     pricing rule;
--   * created_at/updated_at are TIMESTAMP columns, so they carry an INSTANT
--     and are read with UNIX_TIMESTAMP(col) (the driver pool is configured
--     with timezone:'+02:00', which interprets the received wall time on the
--     client side and would otherwise shift every serialized instant). The
--     TIMESTAMP range (1970-01-01 00:00:01 UTC .. 2038-01-19 03:14:07 UTC)
--     bounds the representable epochs;
--   * no hard deletion, no move-to-unit, no move-to-course and no
--     default-lesson backfill are provided here. A lesson row carries no
--     enrollment, entitlement, pricing, drip, progress, capacity, asset or
--     contact data.
--
-- The foreign key collation/engine match the declared M2-B04 parent
-- (`course_units`: InnoDB, utf8mb4/utf8mb4_unicode_ci, CHAR(36) id). The
-- foreign key has NO ON DELETE clause, so deleting a unit that still owns
-- lessons is refused by the database instead of silently orphaning or
-- cascading them.
--
-- Indexes:
--   idx_course_lessons_page -> the bounded keyset list read
--                              (WHERE unit_id=? AND (display_order>? OR
--                              (display_order=? AND id>?))
--                              ORDER BY display_order,id LIMIT ?)
-- The deterministic batch lock/read-back selects `id IN (...)` on the primary
-- key, so no additional index is declared here.

CREATE TABLE IF NOT EXISTS course_lessons (
  id CHAR(36) PRIMARY KEY,
  unit_id CHAR(36) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  display_order INT NOT NULL DEFAULT 0,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_course_lessons_unit FOREIGN KEY (unit_id) REFERENCES course_units(id),
  CONSTRAINT chk_course_lessons_display_order CHECK (display_order >= 0),
  INDEX idx_course_lessons_page (unit_id,display_order,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
