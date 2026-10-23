-- M2-B06 — private tenant branding metadata foundation.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-B06 batch
-- (task client-m2-12-private-branding-20261021-01): no database was
-- connected, no statement was executed, no seed/backfill ran, and no runtime
-- DDL exists in the application. Applying it is a separate, explicitly
-- authorized integration gate (see docs/streams/server/M2-B06-CONTRACT.md).
--
-- Additive only: one new table. No ALTER/DROP/TRUNCATE on an existing table,
-- no data backfill, no default branding row, no index rebuild on another table
-- and no change to `tenants` or any other accepted table.
--
-- Policy encoded by this table (contract: docs/streams/server/M2-B06-CONTRACT.md):
--   * one branding row per tenant. `tenant_id` IS the primary key, so the
--     one-row-per-tenant invariant is enforced by the database and no second
--     identity column (`id`) is introduced that could disagree with it;
--   * the table carries PRESENTATION METADATA only: two localized display
--     labels and one accent color. It stores no business identity, no owner,
--     no contact, no account, no access, no pricing, no billing, no student and
--     no credential field, and it renames nothing: `tenants.business_name`
--     remains the single business identity of a tenant;
--   * display_name_ar / display_name_en are nullable free labels. A NULL means
--     "inherit the existing presentation" and is deliberately NOT the empty
--     string: an empty string is never stored, so "inherit" has exactly one
--     representation. A present label is trimmed to 1..255 characters by the
--     handler; Unicode is permitted and no script/locale is guessed from the
--     column name (a caller may store Latin text in the Arabic column and
--     vice versa — the columns are two label slots, not a language policy);
--   * accent_color is CHAR(7): exactly `#RRGGBB`, canonical UPPERCASE, or
--     NULL. NULL means "inherit the existing presentation" and is not a
--     fabricated default color. The canonical-uppercase rule is enforced by the
--     handler and re-checked on every read; a lower/mixed-case or shorthand
--     value is never stored;
--   * created_at/updated_at are TIMESTAMP columns, so they carry an INSTANT
--     and are read with UNIX_TIMESTAMP(col) (the driver pool is configured
--     with timezone:'+02:00', which interprets the received wall time on the
--     client side and would otherwise shift every serialized instant). The
--     TIMESTAMP range (1970-01-01 00:00:01 UTC .. 2038-01-19 03:14:07 UTC)
--     bounds the representable epochs;
--   * there is no hard-delete, no archive flag and no version/revision column.
--     This batch makes NO lost-update-prevention, optimistic-concurrency or
--     CAS promise: the only serialization the API relies on is the row lock it
--     takes inside its own transaction, and that is a runtime property of the
--     handler, not a schema guarantee. No product conflict policy is implied
--     by this table.
--
-- The foreign key collation/engine match the declared M2-B03/M2-B04/M2-B05
-- parent (`tenants`: InnoDB, utf8mb4/utf8mb4_unicode_ci, CHAR(36) id). The
-- foreign key has NO ON DELETE clause, so deleting a tenant that still owns a
-- branding row is refused by the database instead of silently orphaning or
-- cascading it.
--
-- Indexes:
--   The primary key on `tenant_id` is the ONLY access path: every read and
--   write in the API is `WHERE tenant_id = ?` on the server-selected tenant,
--   so no secondary index is declared. There is no list, search or range read.

CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id CHAR(36) NOT NULL,
  display_name_ar VARCHAR(255) NULL,
  display_name_en VARCHAR(255) NULL,
  accent_color CHAR(7) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tenant_branding_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_tenant_branding_accent_color
    CHECK (accent_color IS NULL OR accent_color REGEXP '^#[0-9A-F]{6}$'),
  CONSTRAINT chk_tenant_branding_display_name_ar
    CHECK (display_name_ar IS NULL OR CHAR_LENGTH(display_name_ar) BETWEEN 1 AND 255),
  CONSTRAINT chk_tenant_branding_display_name_en
    CHECK (display_name_en IS NULL OR CHAR_LENGTH(display_name_en) BETWEEN 1 AND 255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
