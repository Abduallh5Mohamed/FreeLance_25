-- M2-16 — the audited idempotent student-row import batch record.
--
-- SCHEMA FILE ONLY. This file was NOT applied by the M2-16 batch
-- (task client-m2-16-audited-idempotent-student-import-20261021-01): no
-- database was connected, no statement was executed, no seed/backfill ran and
-- no runtime DDL exists in the application. Applying it is a separate,
-- explicitly authorized integration gate (see
-- docs/streams/server/M2-B09-CONTRACT.md).
--
-- Additive only: one new table. No ALTER/DROP/TRUNCATE on an existing table, no
-- data backfill, no seeded batch, no index rebuild on another table and no
-- change to `students`, `tenants`, `users` or any other accepted table.
--
-- What this table IS (contract: docs/streams/server/M2-B09-CONTRACT.md):
--   * the ONE sanitized audit/idempotency record of one committed student-row
--     import batch. It is written INSIDE the same transaction as the student
--     rows it describes, so the record and the students commit atomically or
--     not at all: a partial batch never exists;
--   * `idempotency_key` is an opaque, unpredictable token MINTED BY THE CLIENT
--     for one canonical batch. Together with `tenant_id` it is UNIQUE, and that
--     uniqueness is the serialization point of concurrent same-key attempts:
--     exactly one of them can be the first writer, and every other one answers
--     from the stored record instead of inserting again;
--   * `payload_digest` is the SHA-256 of the CANONICAL payload (a JSON array of
--     arrays in the fixed documented key order), so the same rows always
--     produce the same digest regardless of how the client serialized them.
--     Same tenant + same key + same digest is a REPLAY that returns the stored
--     result without another insert; same tenant + same key + a DIFFERENT
--     digest is a conflict (409) and is never silently treated as a replay;
--   * `created_count` and `row_numbers` are the FINAL sanitized result: the
--     number of student rows created and the submitted physical row numbers.
--     They are known before the students are inserted, so the record is final
--     on write and never has to be updated.
--
-- What this table deliberately is NOT:
--   * it stores NO CSV value: no name, email, phone, guardian phone, grade or
--     barcode of any submitted row, and no created student id. A digest is not
--     a value: it is one-way, and the canonical payload it was taken from is
--     never stored here;
--   * it stores NO existing-record identity. When a batch is refused because a
--     submitted value already exists, nothing about the existing record is
--     recorded or returned;
--   * it is NOT an account, login, password, invitation, OTP, enrollment,
--     group/course/branch, payment or access record, and it has no foreign key
--     to any of them. It creates no access of any kind;
--   * it is NOT a retry queue. An uncertain commit is never turned into a
--     retryable success here: a row exists only after the transaction that
--     created the students committed.
--
-- `id` is a server-generated UUID (CHAR(36)). The client never supplies it, so
-- two batches of the same tenant are always two distinct records.
--
-- The foreign key collation/engine match the declared parent (`tenants`:
-- InnoDB, utf8mb4/utf8mb4_unicode_ci, CHAR(36) id). The foreign key has NO ON
-- DELETE clause, so deleting a tenant that still owns a batch record is refused
-- by the database instead of silently orphaning the audit trail.
--
-- Indexes:
--   `uq_student_import_batches_tenant_key` (tenant_id, idempotency_key) is the
--   UNIQUE key that makes the idempotency decision safe under concurrency: the
--   commit route reads it FOR UPDATE inside its transaction, and the insert of
--   the record itself collides if a concurrent attempt won the race.
--
-- Bounds are declared so a malformed record cannot be stored even by a future
-- writer: the key is 16..128 URL-safe characters, the digest is exactly 64
-- hexadecimal characters, the count is 1..1000 rows and the row numbers are
-- between the first and the last physical line of an accepted CSV file.

CREATE TABLE IF NOT EXISTS student_import_batches (
  id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  payload_digest CHAR(64) NOT NULL,
  created_count INT NOT NULL,
  row_numbers JSON NOT NULL,
  created_by CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_student_import_batches_tenant_key (tenant_id, idempotency_key),
  KEY idx_student_import_batches_tenant_created (tenant_id, created_at),
  CONSTRAINT fk_student_import_batches_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_student_import_batches_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_student_import_batches_key
    CHECK (CHAR_LENGTH(idempotency_key) BETWEEN 16 AND 128),
  CONSTRAINT chk_student_import_batches_digest
    CHECK (CHAR_LENGTH(payload_digest) = 64),
  CONSTRAINT chk_student_import_batches_created_count
    CHECK (created_count BETWEEN 1 AND 1000),
  CONSTRAINT chk_student_import_batches_created_by
    CHECK (CHAR_LENGTH(created_by) = 36)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
