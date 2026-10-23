-- M2-B07 — private academic-period planning catalog.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-B07 batch
-- (task client-m2-13-private-academic-periods-20261021-01): no database was
-- connected, no statement was executed, no seed/backfill ran, and no runtime
-- DDL exists in the application. Applying it is a separate, explicitly
-- authorized integration gate (see docs/streams/server/M2-B07-CONTRACT.md).
--
-- Additive only: one new table. No ALTER/DROP/TRUNCATE on an existing table,
-- no data backfill, no seeded period, no index rebuild on another table and no
-- change to `tenants`, `courses`, `course_units`, `course_lessons`,
-- `tenant_branding` or any other accepted table.
--
-- What this table IS (contract: docs/streams/server/M2-B07-CONTRACT.md):
--   * a PRIVATE PLANNING CATALOG of academic periods for one tenant. A row is a
--     label plus two date-only bounds, owned by the tenant the server selected.
--     It is owner-managed private metadata, never published to a student.
--   * `starts_on` / `ends_on` are DATE columns, i.e. CALENDAR DATES WITHOUT A
--     TIME AND WITHOUT A TIME ZONE. They are read with DATE_FORMAT(col,'%Y-%m-%d')
--     so the serialized value is the stored calendar date itself and never a
--     driver-interpreted instant. No UTC conversion, no local-midnight instant
--     and no duration is derived from them anywhere in the API.
--   * `is_archived` is a REVERSIBLE PLANNING VISIBILITY FLAG. Archiving hides a
--     period from the default catalog view; it is NOT a cancellation, NOT a
--     status transition, NOT an enrollment/access/billing effect and it changes
--     nothing for any student. Nothing in the application transitions it
--     automatically.
--
-- What this table deliberately is NOT:
--   * it carries NO enrollment, registration, roster, group, grade, course,
--     lesson, invoice, price, payment, access-window or capacity column, and no
--     foreign key to any of them. Attaching enrollments or access windows to a
--     period is NOT part of this batch and is NOT implied by the schema;
--   * it declares NO uniqueness on `name` and NO overlap constraint on the date
--     range. Duplicated names and overlapping periods are PERMITTED, because no
--     uniqueness or overlap product policy has been approved. Nothing in the
--     API rejects a duplicate or an overlap;
--   * it has NO hard-delete path in the API (archive is the reversible flag) and
--     NO version/revision column. This batch makes NO lost-update-prevention,
--     optimistic-concurrency, idempotency or CAS promise: the only serialization
--     the API relies on is the row lock it takes inside its own transaction, and
--     that is a runtime property of the handler, not a schema guarantee.
--
-- `id` is a server-generated UUID (CHAR(36)). The client never supplies it, so
-- two periods of the same tenant with the same name and the same dates are two
-- distinct rows with two distinct identities.
--
-- The foreign key collation/engine match the declared M2-B03/M2-B04/M2-B05/B06
-- parent (`tenants`: InnoDB, utf8mb4/utf8mb4_unicode_ci, CHAR(36) id). The
-- foreign key has NO ON DELETE clause, so deleting a tenant that still owns a
-- period is refused by the database instead of silently orphaning or cascading
-- the row.
--
-- Indexes:
--   `idx_academic_periods_tenant_catalog` (tenant_id, is_archived, starts_on, id)
--   is the ONE access path of the bounded list: every page is
--   `WHERE tenant_id = ? AND is_archived = ? ORDER BY starts_on, id LIMIT ? OFFSET ?`
--   on the server-selected tenant, so the index covers the tenant filter, the
--   archive filter and the total order in one prefix. There is no unbounded
--   scan, no total-count query and no cross-tenant read path.

CREATE TABLE IF NOT EXISTS academic_periods (
  id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_academic_periods_tenant_catalog (tenant_id, is_archived, starts_on, id),
  CONSTRAINT fk_academic_periods_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_academic_periods_name
    CHECK (CHAR_LENGTH(name) BETWEEN 1 AND 255),
  CONSTRAINT chk_academic_periods_starts_on
    CHECK (starts_on >= '1000-01-01'),
  CONSTRAINT chk_academic_periods_ends_on
    CHECK (ends_on >= '1000-01-01'),
  CONSTRAINT chk_academic_periods_range
    CHECK (starts_on <= ends_on),
  CONSTRAINT chk_academic_periods_archived
    CHECK (is_archived IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
