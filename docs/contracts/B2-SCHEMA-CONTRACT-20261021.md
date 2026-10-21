# B2-SCHEMA contract — exam manual grading / progress publication (+ internal ledger gate) — 2026-10-21

Task: B2-C-SCHEMA (sole owner). This contract separates AUTHORING (SQL files written
here) from APPLICATION (no SQL was executed; applying needs a separately approved
live step). It records the verified inventory the new migrations build on, the
exact table/column/key names migrations 20261021_01/02 define, and the units,
so B2-C-PERSISTENCE and B2-C-INTEGRATION can rely on one canonical naming source.

Nothing in this file is executed, verified against a live MySQL, or registered in
`server/bootstrap/m1/manifest.json` (manifest registration is owned by
B2-C-INTEGRATION after review).

## 1. Verified inventory (read from source files; nothing assumed)

### 1.1 Exam snapshot/grading baseline (server/migrations/20261018_09_exam_snapshots_grading.sql)

Table `exam_versions`: `id CHAR(36) PK, exam_id CHAR(36), tenant_id CHAR(36),
version INT, status ENUM('draft','published','archived'), duration_seconds INT,
opens_at/closes_at DATETIME, grace_seconds INT, total_points DECIMAL(10,2),
passing_points DECIMAL(10,2), scoring_policy JSON, published_at, created_by,
created_at/updated_at TIMESTAMP, version_lock INT; UNIQUE (exam_id, version)`.

Table `exam_version_questions`: `id CHAR(36) PK, exam_version_id CHAR(36),
tenant_id CHAR(36), position INT, question_id/question_version/source_version_id,
question_type ENUM('single_choice','multiple_choice','true_false','essay'),
question_text, options, correct_answers, points DECIMAL(6,2), explanation,
content_hash CHAR(64); UNIQUE (exam_version_id, position) — no UNIQUE on `id`
alone beyond the PK`.

Table `exam_versioned_attempts` (columns that EXIST, verified):
`id CHAR(36) PK, tenant_id CHAR(36), exam_id CHAR(36), exam_version_id CHAR(36),
student_enrollment_id CHAR(36), student_user_id CHAR(36),
status ENUM('in_progress','pending_review','graded','expired'),
started_at/deadline_at DATETIME, submitted_at DATETIME, auto_submitted,
auto_score DECIMAL(10,2) NULL, score DECIMAL(10,2) NULL, manual_required,
grading_fingerprint CHAR(64), graded_at DATETIME NULL, passed TINYINT(1) NULL,
created_at TIMESTAMP, version INT NOT NULL DEFAULT 0;
UNIQUE (exam_id, student_enrollment_id)`.

Verified present and sufficient for the CAS: `status` (contains
`pending_review`) and `version INT DEFAULT 0`. The store's expected-version CAS
needs NO new attempt columns for the guard itself.

Verified MISSING (what the finalize write needs to persist):
`reviewer_user_id` — there is no reviewer column on attempts (only
`grading_fingerprint`, auto-grader provenance). This is the one guarded
`ADD COLUMN` on an existing table in migration 01. `graded_at`/`passed`/`score`
already exist and are reused as-is.

Table `exam_versioned_answers`: `id CHAR(36) PK, tenant_id, attempt_id,
exam_version_id, question_ref CHAR(36) COMMENT 'exam_version_questions.id',
question_type, response JSON, awarded_points DECIMAL(6,2) NULL,
is_correct, manual_review TINYINT(1); UNIQUE (attempt_id, question_ref)`.
Verified MISSING for manual grading: no `revision` number, no integer-hundredths
award, no reviewer/feedback columns — and the rows are meant to stay the
auto-grader's record, so manual grades go to a NEW append-only revision table,
never an UPDATE of `exam_versioned_answers`.

Table `exam_grading_runs`: `id CHAR(36) PK, tenant_id, attempt_id,
exam_version_id, idempotency_key CHAR(64), auto_score DECIMAL(10,2),
manual_required, applied, created_by, created_at; UNIQUE (attempt_id,
idempotency_key)` — auto-grader idempotency; not reused for manual revisions.

### 1.2 Gradebook/publication baseline (20261018_10_gradebook_certificates.sql)

`gradebook_policies` UNIQUE (tenant_id, course_id);
`gradebook_scores` — no UNIQUE at all;
`certificates` UNIQUE (tenant_id, student_enrollment_id, course_id) — the
established per-scope pattern the publication table follows. No publication
table existed before batch 2.

### 1.3 Id/table conventions proven by existing migrations

- Id columns: `CHAR(36)` UUIDs everywhere (`users.id`, `students.id`,
  `courses.id`, `tenants.id`, all 20261018_* tables). `tenants.id CHAR(36) PK`
  (20260921_saas_foundation). `students.id CHAR(36) PK` is the enrollment id
  used by `exam_versioned_attempts.student_enrollment_id` and by the authority
  SQL in `server/src/routes/progress-reports.ts` (`WHERE s.id=? AND s.tenant_id=?`).
- Foreign keys to legacy tables are established precedent:
  `REFERENCES tenants(id)` (20261017_01), `REFERENCES users(id)`,
  `REFERENCES students(id)`, `REFERENCES courses(id)` (legacy baseline,
  20260925_01, 20261018_11, 20261018_13). Migration 01 therefore only references
  tables/columns whose uniqueness is already proven: PKs, and the existing
  `UNIQUE (attempt_id, question_ref)` on `exam_versioned_answers`.
- Engine/charset baseline: `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci` for every 20261018_* table; the same is used
  here so FKs between them and the legacy CHAR(36) columns are valid.
- Money/points units: exam points are `DECIMAL(x,2)` columns; the
  manual-grading domain (`server/src/services/exam-manual-grading.ts`) computes
  in exact integer HUNDREDTHS (`awarded_hundredths`, `scoreHundredths`) and
  serializes via `formatHundredths`. Migration 01 stores revision awards as
  integer hundredths (INT, non-negative), consistent with `toHundredths` of
  the existing point columns; no float anywhere.
- DDL style: every statement guarded by INFORMATION_SCHEMA probes
  (TABLES/COLUMNS/STATISTICS/TABLE_CONSTRAINTS) + `SET @sql = IF(...)` +
  `PREPARE/EXECUTE/DEALLOCATE`, per 20261017_01 and 20261018_22. No
  DROP/TRUNCATE/DELETE, no `FOREIGN_KEY_CHECKS` manipulation, additive only.
- Time: absolute UTC instants stored as DATETIME (the 20261018_09 convention
  for server-minted instants); `created_at` of revisions is supplied
  explicitly by the store (`AppendAnswerGradeRevisionInput.createdAt`).

### 1.4 Injected store contracts the schema must serve (read as code)

`server/src/services/exam-manual-grading.ts` (ManualGradingStore):
- `ManualGradeRevisionRow` projectable columns: `question_ref`, `revision`,
  `awarded_hundredths` (safe non-negative integer), `reviewer_user_id`,
  `feedback` (nullable, <= MAX_MANUAL_FEEDBACK_LENGTH = 2000 chars), `created_at`.
- Append input: `tenantId, attemptId, questionRef, revision` (planned as
  `max(existing)+1` before the transaction), `awardedHundredths`,
  `reviewerUserId`, `feedback`, `createdAt`, CAS `expectedAttemptStatus`
  (must equal `pending_review`) and `expectedAttemptVersion`.
- `finalizeAttempt` writes: `score` (hundredths projected to the existing
  `DECIMAL(10,2)` column), `passed` (existing column), `reviewer_user_id` (new
  column), `graded_at` (existing column), `version+1`; CAS
  `(status='pending_review', version=expected)`; after finalize no revision may land.
- Failure reasons the storage layer must be able to produce:
  `attempt_missing`, `attempt_not_pending`, `attempt_version_conflict`,
  `duplicate_revision` (the UNIQUE (attempt_id, question_ref, revision) is the
  backstop that makes `duplicate_revision` impossible to miss).

`server/src/services/progress-publication.ts` + `server/src/routes/progress-reports.ts`
(PublicationStore):
- One row per `(tenant_id, student_enrollment_id, course_id)`; never-written
  scope means "draft at version 0", so the row may be absent or present.
- Columns: `state ENUM('draft','published')`, `published_by` (actor of the most
  recent publish, NULL while draft), `published_at` (same), `version INT`
  monotonic counter; camelCase in the TypeScript record maps to snake_case
  columns (`tenantId` to `tenant_id`, `studentEnrollmentId` to
  `student_enrollment_id`, `courseId` to `course_id`, `publishedBy` to
  `published_by`, `publishedAt` to `published_at`, `version` to `version`).
- Transitions are version-guarded (`expectedVersion`; affected rows 0 means
  conflict, no write) and run in the same transaction as their audit event.
- Initial-row race: `transition` reads NULL for a missing row (expected
  version 0). The SQL adapter (B2-C-PERSISTENCE) must race two concurrent
  initial publishes through INSERT against `UNIQUE (tenant_id,
  student_enrollment_id, course_id)`; the loser of the INSERT conflict or the
  version CAS gets `conflict`/re-read. The schema supplies the UNIQUE key; the
  race semantics are an adapter obligation, not schema magic.

### 1.5 db/unit context (server/src/db.ts, read-only)

Pool-based `query/queryOne/execute` + `withTransaction(PoolConnection)`.
PERSISTENCE must run CAS+INSERT+audit on ONE connection (the transaction
handle); this contract makes no atomicity claim beyond schema constraints.

## 2. Migration 20261021_01_exam_manual_publication.sql (canonical names)

New table `exam_manual_answer_revisions` — append-only answer-grade history:

| Column | Type | Notes |
|---|---|---|
| id | CHAR(36) PK | |
| tenant_id | CHAR(36) NOT NULL | FK to tenants(id) |
| attempt_id | CHAR(36) NOT NULL | FK to exam_versioned_attempts(id) |
| question_ref | CHAR(36) NOT NULL | same value domain as exam_versioned_answers.question_ref |
| revision | INT NOT NULL DEFAULT 1 | planned max+1 |
| awarded_hundredths | INT NOT NULL | integer hundredths; CHECK >= 0 |
| reviewer_user_id | CHAR(36) NOT NULL | FK to users(id) |
| feedback | VARCHAR(2000) NULL | MAX_MANUAL_FEEDBACK_LENGTH bound |
| created_at | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | store-supplied instant |

Keys: `UNIQUE uq_manual_answer_revision (attempt_id, question_ref, revision)`;
`KEY idx_manual_revisions_tenant (tenant_id, attempt_id)`; composite FK
`fk_manual_revision_answer (attempt_id, question_ref) REFERENCES
exam_versioned_answers(attempt_id, question_ref)` — proven by the EXISTING
UNIQUE key, no rebuild. The states `attempt_not_pending` and
`attempt_version_conflict` are enforced by the adapter's CAS predicates on the
existing attempt columns (`status`, `version`), not by schema defaults.

Guarded ALTER (only because verified missing):
`exam_versioned_attempts ADD COLUMN reviewer_user_id CHAR(36) NULL` + FK
`fk_exam_attempts_reviewer` to `users(id)` (nullable: the auto-grader path
never sets it). NO other attempt column is added.

New table `progress_report_publications`:

| Column | Type | Notes |
|---|---|---|
| id | CHAR(36) PK | |
| tenant_id | CHAR(36) NOT NULL | FK to tenants(id) |
| student_enrollment_id | CHAR(36) NOT NULL | FK to students(id) (enrollment identity) |
| course_id | CHAR(36) NOT NULL | FK to courses(id) |
| state | ENUM('draft','published') NOT NULL DEFAULT 'draft' | |
| published_by | CHAR(36) NULL | FK ON DELETE SET NULL to users(id) |
| published_at | DATETIME NULL | |
| version | INT NOT NULL DEFAULT 0 | |
| created_at/updated_at | TIMESTAMP | |

Keys: `UNIQUE uq_progress_publication (tenant_id, student_enrollment_id,
course_id)` (race/lookup key), `KEY idx_progress_publications_course
(tenant_id, course_id)` (the listPublications order).

Cross-scope consistency obligation (NOT schema-provable here; documented):
a publication row ties an enrollment to a course; whether that (enrollment,
course) relation exists is proven by the route authority / mayActOnEnrollment
at service time. No composite FK into `student_courses` etc. is added — the
existing keys prove a student or a course, not an enrollment-in-course, and a
destructive rebuild to create such a key is forbidden.

## 3. Migration 20261021_02_internal_financial_ledger.sql (written)

Written ONLY after `docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md`
existed (it does, 404 lines). Part C is a faithful DDL transcription of that
contract; nothing was invented beyond the contract + the constraints already
fixed from the batch scope. Nothing is executed; the manifest is untouched.

New tables (all `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_unicode_ci`, `tenant_id CHAR(36) NOT NULL` + FK to
`tenants(id)`, money as exact BIGINT/BIGINT UNSIGNED minor units with NO
FLOAT/DOUBLE/fractional DECIMAL anywhere):

- `billing_accounts` — `id CHAR(36) PK`, `kind ENUM('platform_receivable',
  'platform_cash','merchant_pending','merchant_available','merchant_reserved',
  'subscription_credit','cash_receipt_clearing')`, `normal_side
  ENUM('debit','credit')`, `currency CHAR(3)`, `balance_minor BIGINT NOT NULL
  DEFAULT 0 CHECK (>= 0)` (signed normal-side balance), `version BIGINT
  UNSIGNED DEFAULT 0` (CAS counter), `created_at`/`updated_at TIMESTAMP(3)`.
  Keys: `uq_billing_account_tenant_kind_currency (tenant_id, kind, currency)`,
  `uq_billing_account_id_tenant (id, tenant_id)` (composite-FK target),
  `idx_billing_account_tenant (tenant_id, kind)`.
- `billing_journals` — INSERT-only header; no `updated_at`.
  `journal_type ENUM('standard','reversal') DEFAULT 'standard'`,
  `reversal_of_journal_id CHAR(36) NULL`, `reference VARCHAR(200) NULL`,
  `description VARCHAR(500) NULL`, `created_at TIMESTAMP(3)`. Keys:
  `uq_billing_journal_id_tenant (id, tenant_id)` (composite-FK target),
  `uq_billing_journal_reversal (tenant_id, reversal_of_journal_id)` (a journal
  is reversed at most once per tenant; MySQL allows many NULLs),
  `idx_billing_journal_tenant_created (tenant_id, created_at)`, composite FK
  `(reversal_of_journal_id, tenant_id) -> billing_journals(id, tenant_id)`,
  `CHECK ((journal_type='reversal') = (reversal_of_journal_id IS NOT NULL))`.
- `billing_journal_lines` — `PK (journal_id, line_no)` (posting order),
  `line_no SMALLINT UNSIGNED CHECK (>= 1)`, `account_kind
  ENUM(...same 7 kinds...)` snapshot at posting time, `direction
  ENUM('debit','credit')`, `amount_minor BIGINT UNSIGNED CHECK (> 0 AND
  <= 1000000000000000)` (= MAX_AMOUNT_MINOR = 10^15, from the domain bound),
  `created_at TIMESTAMP(3)`. Keys:
  `idx_billing_line_tenant_account (tenant_id, account_id)` (per-account
  balance sums), composite FKs `(journal_id, tenant_id) ->
  billing_journals(id, tenant_id)` and `(account_id, tenant_id) ->
  billing_accounts(id, tenant_id)` — the physical anti-foreign-money lock.
- `billing_reservations` — `currency CHAR(3)`, `amount_minor BIGINT UNSIGNED
  CHECK (> 0 AND <= 10^15)`, `available_account_id`/`reserved_account_id`,
  `status ENUM('reserved','released','consumed') DEFAULT 'reserved'`,
  `version BIGINT UNSIGNED DEFAULT 0` (CAS), `reserve_journal_id`,
  `release_journal_id NULL`, `consume_journal_id NULL`,
  `consume_counter_account_id NULL`, `reference VARCHAR(200) NULL`,
  `description VARCHAR(500) NULL`, `created_at`/`updated_at TIMESTAMP(3)`.
  Keys: `uq_billing_reservation_id_tenant (id, tenant_id)` (composite-FK
  target), `idx_billing_reservation_tenant_status (tenant_id, status)`;
  composite FKs to the two/three accounts and the three journals (all
  `(column, tenant_id) -> ...(id, tenant_id)`); CHECKs `available_account_id
  <> reserved_account_id`, `(status <> 'released') OR (release_journal_id IS
  NOT NULL)`, `(status <> 'consumed') OR (consume_journal_id IS NOT NULL)`,
  `version >= 0`. Couples: amount/currency/available/reserved accounts/
  reserve journal/reference/description are immutable after insert; only
  status/version/release journal/consume journal/counter account change, via
  the version CAS (adapter obligation).
- `billing_idempotency_keys` — `scope VARCHAR(32)`
  ('journal' | 'reservation'), `idempotency_key VARCHAR(128)`,
  `payload_hash CHAR(64)` (lowercase SHA-256 hex), `journal_id NULL`,
  `reservation_id NULL`, `created_at TIMESTAMP(3)`. PK `(tenant_id, scope,
  idempotency_key)` is the race arbiter; `uq_billing_idem_journal (journal_id)`
  and `uq_billing_idem_reservation (reservation_id)`; composite FKs to journals
  and reservations; `CHECK ((journal_id IS NULL) <> (reservation_id IS NULL))`.
- `billing_reservation_events` — `event_type
  ENUM('reserve','release','consume','reversal')`, `amount_minor BIGINT
  UNSIGNED CHECK (> 0 AND <= 10^15)`, `journal_id`, `version_after BIGINT
  UNSIGNED`, `idempotency_key VARCHAR(128)`, `created_at TIMESTAMP(3)`.
  Keys: `uq_billing_reservation_event_key (tenant_id, idempotency_key)`,
  `uq_billing_reservation_event_type (reservation_id, event_type,
  idempotency_key)` (the §10-question-2 option: reserve/release/consume have
  deterministic single keys; reversal events may repeat with distinct keys —
  the reversal business path is held in the domain anyway),
  `idx_billing_reservation_event (tenant_id, reservation_id, created_at)`;
  composite FKs to reservations and journals. INSERT-only; never
  updated/deleted.

### 3.1 Interpretations recorded (contract-faithful, flagged to supervisor)

- Reservation replay keys (contract §4.4 "Canonical key registry for journals
  and reservations"): the reservation row does NOT duplicate
  `reservation_key`/`payload_hash`; the registry row `(tenant, 'reservation',
  key, payload_hash, reservation_id)` arbitrates `findReservationByKey` /
  `insertReservation` (domain duplicate_key). The TS domain's
  `ReservationRecord.reservationKey/payloadHash` are served by the registry.
- The contract §10-cross-table CHECK `(journal_id IS NULL) <>
  (reservation_id IS NULL)` is written in full: creation order puts both
  target tables before the registry table, so no `scope`-split fallback is
  needed.
- TIMESTAMP(3) chosen (§10 question 3; the contract's own tables list
  TIMESTAMP(3)); baseline convention keeps DATETIME for exam/report instants.
- The events amount bound (`<= 10^15`) is applied beyond the per-table lines
  because §2 states the MAX_AMOUNT_MINOR bound is SQL-CHECK-enforced for every
  money amount.

### 3.2 Append-only obligation (DDL limit, documented)

MySQL 8.0 has no statement-grant DDL to deny UPDATE/DELETE per table inside a
migration, and no trigger is written here (syntax/privilege cannot be proven
safely in an authoring-batch; the contract itself does not require them).
The obligation is therefore contractual: application privileges must deny
UPDATE/DELETE on `billing_journals`, `billing_journal_lines`,
`billing_reservation_events` (and DELETE everywhere; corrections are reversal
journals only; `billing_accounts` writes only balance+version through a
posting; `billing_reservations` changes only via the CAS transition).
Enforcement is a live-deployment step, separately approved.

## 4. Held (owned elsewhere or by later approvals)

- Migration application/verification, backfills, purge: NEVER done here
  (authoring-only).
- Manifest registration: B2-C-INTEGRATION.
- SQL adapters (exam-manual-grading-sql.ts, progress-publication-sql.ts,
  billing-ledger-sql.ts): B2-C-PERSISTENCE after contract freeze.
- Dispute/fee/payout/invoice/price-version tables, commission/cooling/
  certificate policy: excluded by docs/19 until the owner decides.
