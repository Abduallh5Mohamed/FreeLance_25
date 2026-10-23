-- M2-B04 — private course-unit metadata foundation.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-B04 batch
-- (task client-m2-b04-course-unit-metadata-20261019-01): no database was
-- connected, no statement was executed, no seed/backfill ran, and no runtime
-- DDL exists in the application. Applying it is a separate, explicitly
-- authorized integration gate (see docs/streams/server/M2-B04-CONTRACT.md).
--
-- Additive only: one new table. No ALTER/DROP/TRUNCATE on an existing table,
-- no data backfill, no default unit, no index rebuild on another table and no
-- change to `courses`.
--
-- Policy encoded by this table (contract: docs/streams/server/M2-B04-CONTRACT.md):
--   * a unit belongs to exactly one COURSE; the tenant is DERIVED from that
--     course (`courses.tenant_id`) and is deliberately NOT duplicated in this
--     table, so an independent tenant_id column can never disagree with the
--     course relation;
--   * name is a trimmed free label of 1..255 characters and is deliberately
--     NOT unique: the unit id (UUID) is the identity, so duplicate names are
--     allowed and no uniqueness rule is inferred;
--   * display_order is a nonnegative signed 32-bit integer (0..2147483647).
--     The order MAY tie between two units: the unit id is the stable
--     tie-breaker of the keyset list, and no renumbering policy is implied;
--   * status is only 'active' or 'archived'. Archiving changes unit metadata
--     only; it grants or revokes no course, material, student or teacher
--     access, and it publishes nothing;
--   * created_at/updated_at are TIMESTAMP columns, so they carry an INSTANT
--     and are read with UNIX_TIMESTAMP(col) (the driver pool is configured
--     with timezone:'+02:00', which interprets the received wall time on the
--     client side and would otherwise shift every serialized instant). The
--     TIMESTAMP range (1970-01-01 00:00:01 UTC .. 2038-01-19 03:14:07 UTC)
--     bounds the representable epochs;
--   * no hard deletion, no move-to-course and no default-unit backfill are
--     provided here. A unit row carries no enrollment, entitlement, pricing,
--     drip, progress, capacity or contact data.
--
-- Indexes:
--   idx_course_units_page -> the bounded keyset list read
--                            (WHERE course_id=? AND (display_order>? OR
--                            (display_order=? AND id>?))
--                            ORDER BY display_order,id LIMIT ?)

CREATE TABLE IF NOT EXISTS course_units (
  id CHAR(36) PRIMARY KEY,
  course_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_course_units_course FOREIGN KEY (course_id) REFERENCES courses(id),
  CONSTRAINT chk_course_units_display_order CHECK (display_order >= 0),
  INDEX idx_course_units_page (course_id,display_order,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
