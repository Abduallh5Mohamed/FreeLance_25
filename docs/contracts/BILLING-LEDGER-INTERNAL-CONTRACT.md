# B2-C-LEDGER — internal financial ledger data contract (2026-10-21)

Status: **authoring contract only**. This file is the interface between the
ledger domain worker (B2-C-LEDGER) and the schema worker (B2-C-SCHEMA, target
migration `20261021_02_internal_financial_ledger.sql`). It is
implementation-neutral: it names tables, columns, keys, units and invariants,
but it is **not** SQL, not a migration, and not evidence that any database
object exists. No SQL is executed by this task.

Governing sources: `docs/19-commercial-registration-wallet-agreement-ar.md`
lines 64-111, `docs/17-full-feature-backlog.md` (B7/B8/B12/F1/F2), and
`docs/streams/server/BATCH2-IMPLEMENTATION-SCOPE-20261021.md` (B2-C-LEDGER).

## 1. Scope and non-goals

In scope: a tenant-scoped, append-only double-entry record of internal
balances (platform receivable, merchant pending/available/reserved, and
subscription credit), plus exactly-once reservation transitions.

Out of scope (HELD, do not encode here): fees, commission (the approved rate
is **zero**; no commission account or split is added), dispute/cooling
periods, refund rules, payout rules, provider codes, invoices, recurring
debits, tax, HTTP routes, and any live collection. The legacy
`instructor_wallets` / `services/service-credit.ts` balance is **not** a
merchant or center wallet and must never be mapped into these tables.

## 2. Conventions

- Engine: InnoDB, `utf8mb4`, MySQL 8.0+.
- Identifiers: `CHAR(36)` application-generated UUID strings (same convention
  as existing `tenants`/`users` tables). All `*_id` columns are `CHAR(36)`.
  The domain also rejects a tenant/account/journal/reservation identifier longer
  than 36 characters, so no accepted input can exceed the column width.
- Tenant scope: every table carries `tenant_id CHAR(36) NOT NULL`. A row of
  one tenant is never referenced by another tenant; composite foreign keys
  enforce this where a child carries `tenant_id`.
- Money: **integer minor units** only. EGP minor unit = piaster (1 EGP = 100
  piasters). No `FLOAT`, `DOUBLE` or fractional money in these tables.
  - `billing_journal_lines.amount_minor`: `BIGINT UNSIGNED NOT NULL`, > 0.
  - `billing_accounts.balance_minor`: `BIGINT NOT NULL` (signed; normal-side
    balance, see §5), >= 0.
  - Domain bound per line/operation: `MAX_AMOUNT_MINOR = 1_000_000_000_000_000`
    (10^15 minor units), enforced by the domain and by SQL `CHECK`.
  - Serialization at every API/code boundary is a decimal **string** of minor
    units (`"1250"`), never a JavaScript `number`.
- Timestamps: UTC `TIMESTAMP(3)`; ledger rows are append-only and keep
  `created_at`; mutable rows also keep `updated_at`.
- Currency: `CHAR(3)` ISO-4217 uppercase (approved default `EGP`). One
  journal has exactly one currency and every line account must have the same
  currency. Cross-currency journals are rejected; a tenant holds one balance
  row per (kind, currency).

## 3. Account kinds (`billing_accounts.kind`)

`ENUM('platform_receivable','platform_cash','merchant_pending',
'merchant_available','merchant_reserved','subscription_credit',
'cash_receipt_clearing')`

Normal side (stored in `normal_side`, derived from kind at creation):

| kind | normal_side | meaning |
|---|---|---|
| `platform_receivable` | `debit` | debt owed by the tenant to the platform |
| `platform_cash` | `debit` | verified money held/cleared by the platform |
| `merchant_pending` | `credit` | student money awaiting settlement |
| `merchant_available` | `credit` | settled money available to the tenant |
| `merchant_reserved` | `credit` | available money held for one reservation |
| `subscription_credit` | `credit` | platform credit that only offsets platform receivables |
| `cash_receipt_clearing` | `credit` | physical-cash receipt clearing, explicitly non-withdrawable |

The first five names are mandated by the batch scope. `platform_cash` is the
counter account required for double entry. `cash_receipt_clearing` is a
contra/non-withdrawable clearing account used only to prove that a cash
receipt does not touch `merchant_available`. It is not a wallet, not a payout
account and not spendable e-money.

Structural domain guards (must also be mirrored by review, but they are code
guards, not database business rules):

- A journal may never contain both `subscription_credit` and any of
  `merchant_pending` / `merchant_available` / `merchant_reserved`.
  `subscription_credit` can therefore never become withdrawable or enter a
  merchant wallet.
- A journal may never contain both `cash_receipt_clearing` and any merchant
  wallet kind (same list). A cash receipt cannot increase
  `merchant_available`.
- A journal line never targets an account of another tenant; accounts are not
  auto-created, in this or any other tenant.

## 4. Tables

### 4.1 `billing_accounts`

| column | type | constraints |
|---|---|---|
| `id` | `CHAR(36)` | `NOT NULL` |
| `tenant_id` | `CHAR(36)` | `NOT NULL` |
| `kind` | `ENUM(...)` | `NOT NULL` |
| `normal_side` | `ENUM('debit','credit')` | `NOT NULL` |
| `currency` | `CHAR(3)` | `NOT NULL` |
| `balance_minor` | `BIGINT` | `NOT NULL DEFAULT 0`, `CHECK (balance_minor >= 0)` |
| `version` | `BIGINT UNSIGNED` | `NOT NULL DEFAULT 0` |
| `created_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` |
| `updated_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)` |

Keys:

- `PRIMARY KEY (id)`
- `UNIQUE KEY uq_billing_account_tenant_kind_currency (tenant_id, kind, currency)`
- `UNIQUE KEY uq_billing_account_id_tenant (id, tenant_id)` — target of the
  composite line/child foreign keys.
- `KEY idx_billing_account_tenant (tenant_id, kind)`
- `FOREIGN KEY (tenant_id) REFERENCES tenants(id)`

One account row per (tenant, kind, currency). Multiple sub-accounts per kind
are HELD. Accounts are provisioned explicitly by an authorized admin/bootstrap
path; the ledger domain never auto-creates an account.

### 4.2 `billing_journals`

| column | type | constraints |
|---|---|---|
| `id` | `CHAR(36)` | `NOT NULL` |
| `tenant_id` | `CHAR(36)` | `NOT NULL` |
| `currency` | `CHAR(3)` | `NOT NULL` |
| `journal_type` | `ENUM('standard','reversal')` | `NOT NULL DEFAULT 'standard'` |
| `reversal_of_journal_id` | `CHAR(36)` | `NULL` |
| `reference` | `VARCHAR(200)` | `NULL` |
| `description` | `VARCHAR(500)` | `NULL` |
| `created_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` |

Keys:

- `PRIMARY KEY (id)`
- `UNIQUE KEY uq_billing_journal_reversal (tenant_id, reversal_of_journal_id)`
  (MySQL permits multiple `NULL`s; one journal is reversed at most once).
- `KEY idx_billing_journal_tenant_created (tenant_id, created_at)`
- `FOREIGN KEY (tenant_id) REFERENCES tenants(id)`
- `FOREIGN KEY (reversal_of_journal_id, tenant_id) REFERENCES billing_journals(id, tenant_id)`
  (requires an additional `UNIQUE KEY uq_billing_journal_id_tenant (id, tenant_id)`).
- `CHECK ((journal_type = 'reversal') = (reversal_of_journal_id IS NOT NULL))`

No `updated_at`: the row is append-only.

### 4.3 `billing_journal_lines`

| column | type | constraints |
|---|---|---|
| `journal_id` | `CHAR(36)` | `NOT NULL` |
| `line_no` | `SMALLINT UNSIGNED` | `NOT NULL`, >= 1 |
| `tenant_id` | `CHAR(36)` | `NOT NULL` |
| `account_id` | `CHAR(36)` | `NOT NULL` |
| `account_kind` | `ENUM(...)` | `NOT NULL` (snapshot at posting time) |
| `direction` | `ENUM('debit','credit')` | `NOT NULL` |
| `amount_minor` | `BIGINT UNSIGNED` | `NOT NULL`, `CHECK (amount_minor > 0)` |
| `created_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` |

Keys:

- `PRIMARY KEY (journal_id, line_no)`
- `KEY idx_billing_line_tenant_account (tenant_id, account_id)`
- `FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals(id, tenant_id)`
- `FOREIGN KEY (account_id, tenant_id) REFERENCES billing_accounts(id, tenant_id)`
- `CHECK (line_no >= 1)`

The composite account FK is the physical guarantee that a line cannot point at
another tenant's account. The domain still validates kind and currency.

### 4.4 `billing_idempotency_keys`

Canonical key registry for journals and reservations.

| column | type | constraints |
|---|---|---|
| `tenant_id` | `CHAR(36)` | `NOT NULL` |
| `scope` | `VARCHAR(32)` | `NOT NULL` (`journal` / `reservation`) |
| `idempotency_key` | `VARCHAR(128)` | `NOT NULL` |
| `payload_hash` | `CHAR(64)` | `NOT NULL` (lowercase SHA-256 hex) |
| `journal_id` | `CHAR(36)` | `NULL` |
| `reservation_id` | `CHAR(36)` | `NULL` |
| `created_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` |

Keys:

- `PRIMARY KEY (tenant_id, scope, idempotency_key)`
- `UNIQUE KEY uq_billing_idem_journal (journal_id)` (nullable)
- `UNIQUE KEY uq_billing_idem_reservation (reservation_id)` (nullable)
- `FOREIGN KEY (tenant_id) REFERENCES tenants(id)`
- `FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals(id, tenant_id)`
- `FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations(id, tenant_id)`
- `CHECK ((journal_id IS NULL) <> (reservation_id IS NULL))` — exactly one
  target. This check is deferred to the point both target tables exist; if
  MySQL's ordering makes it awkward, the schema worker may express it as two
  separate partial checks (`scope='journal'` / `scope='reservation'`).

Semantics:

- Same `(tenant, scope, key)` + same `payload_hash` → return the recorded
  result, no new journal/reservation.
- Same `(tenant, scope, key)` + different `payload_hash` → deterministic
  conflict error, no write.
- The unique primary key is the race arbiter; the adapter must catch the
  duplicate, read the existing row and compare hashes.

Payload hash scope for journals covers tenant, currency, reference,
description, and the ordered list of `(account_id, direction, amount_minor)`.
For reservations it covers tenant, reservation key, currency, amount,
available account, reserved account, and reference.

### 4.5 `billing_reservations`

| column | type | constraints |
|---|---|---|
| `id` | `CHAR(36)` | `NOT NULL` |
| `tenant_id` | `CHAR(36)` | `NOT NULL` |
| `currency` | `CHAR(3)` | `NOT NULL` |
| `amount_minor` | `BIGINT UNSIGNED` | `NOT NULL`, `CHECK (amount_minor > 0)` |
| `available_account_id` | `CHAR(36)` | `NOT NULL` |
| `reserved_account_id` | `CHAR(36)` | `NOT NULL` |
| `status` | `ENUM('reserved','released','consumed')` | `NOT NULL DEFAULT 'reserved'` |
| `version` | `BIGINT UNSIGNED` | `NOT NULL DEFAULT 0` |
| `reserve_journal_id` | `CHAR(36)` | `NOT NULL` |
| `release_journal_id` | `CHAR(36)` | `NULL` |
| `consume_journal_id` | `CHAR(36)` | `NULL` |
| `consume_counter_account_id` | `CHAR(36)` | `NULL` |
| `reference` | `VARCHAR(200)` | `NULL` |
| `description` | `VARCHAR(500)` | `NULL` |
| `created_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` |
| `updated_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)` |

Keys:

- `PRIMARY KEY (id)`
- `UNIQUE KEY uq_billing_reservation_id_tenant (id, tenant_id)`
- `KEY idx_billing_reservation_tenant_status (tenant_id, status)`
- `FOREIGN KEY (tenant_id) REFERENCES tenants(id)`
- `FOREIGN KEY (available_account_id, tenant_id) REFERENCES billing_accounts(id, tenant_id)`
- `FOREIGN KEY (reserved_account_id, tenant_id) REFERENCES billing_accounts(id, tenant_id)`
- `FOREIGN KEY (consume_counter_account_id, tenant_id) REFERENCES billing_accounts(id, tenant_id)`
- `FOREIGN KEY (reserve_journal_id, tenant_id) REFERENCES billing_journals(id, tenant_id)`
- `FOREIGN KEY (release_journal_id, tenant_id) REFERENCES billing_journals(id, tenant_id)`
- `FOREIGN KEY (consume_journal_id, tenant_id) REFERENCES billing_journals(id, tenant_id)`
- `CHECK (status IN ('reserved','released','consumed'))`
- `CHECK (available_account_id <> reserved_account_id)`
- `CHECK ((status <> 'released') OR (release_journal_id IS NOT NULL))`
- `CHECK ((status <> 'consumed') OR (consume_journal_id IS NOT NULL))`
- `CHECK (version >= 0)`

Invariants: `amount_minor`, `currency`, `available_account_id`,
`reserved_account_id`, `reserve_journal_id`, `reference`, `description` are
immutable after insert. Only `status`, `version`, `release_journal_id`,
`consume_journal_id`, `consume_counter_account_id`, `updated_at` may change,
through the CAS transition.

### 4.6 `billing_reservation_events`

Append-only transition log.

| column | type | constraints |
|---|---|---|
| `id` | `CHAR(36)` | `NOT NULL` |
| `tenant_id` | `CHAR(36)` | `NOT NULL` |
| `reservation_id` | `CHAR(36)` | `NOT NULL` |
| `event_type` | `ENUM('reserve','release','consume','reversal')` | `NOT NULL` |
| `amount_minor` | `BIGINT UNSIGNED` | `NOT NULL`, > 0 |
| `journal_id` | `CHAR(36)` | `NOT NULL` |
| `version_after` | `BIGINT UNSIGNED` | `NOT NULL` |
| `idempotency_key` | `VARCHAR(128)` | `NOT NULL` |
| `created_at` | `TIMESTAMP(3)` | `NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` |

Keys:

- `PRIMARY KEY (id)`
- `UNIQUE KEY uq_billing_reservation_event_key (tenant_id, idempotency_key)`
- `UNIQUE KEY uq_billing_reservation_event_type (reservation_id, event_type)`
  for `reserve` / `release` / `consume`; if `reversal` needs more than one row,
  the schema worker may split this into a unique key on
  `(reservation_id, event_type, idempotency_key)` plus a domain check.
- `KEY idx_billing_reservation_event (tenant_id, reservation_id, created_at)`
- `FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations(id, tenant_id)`
- `FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals(id, tenant_id)`
- `CHECK (amount_minor > 0)`

No `updated_at`; no update/delete.

## 5. Balance and posting rules

`billing_accounts.balance_minor` is the **normal-side balance**:

- debit-normal (`platform_receivable`, `platform_cash`):
  `balance += amount` on debit, `balance -= amount` on credit.
- credit-normal (all merchant kinds, `subscription_credit`,
  `cash_receipt_clearing`):
  `balance += amount` on credit, `balance -= amount` on debit.

Every posting therefore computes, per account, a signed delta and then asserts
the resulting normal-side balance is `>= 0`. A journal is balanced when, per
journal currency, `sum(debit amount_minor) == sum(credit amount_minor)` as
exact `BIGINT`. A journal has at least 2 and at most 100 lines.

Canonical templates (all tenant-scoped and same-currency):

- verified electronic student receipt:
  `debit platform_cash, credit merchant_pending`;
- settlement:
  `debit merchant_pending, credit merchant_available`;
- reserve:
  `debit merchant_available, credit merchant_reserved`;
- release:
  `debit merchant_reserved, credit merchant_available`;
- consume:
  `debit merchant_reserved, credit <platform-side counter account>`;
- cash receipt:
  `debit platform_cash, credit cash_receipt_clearing`;
- issue subscription credit:
  `debit platform_cash, credit subscription_credit` (example; the business
  reason for issuing credit is HELD);
- spend subscription credit against a receivable:
  `debit subscription_credit, credit platform_receivable`.

`merchant_available` and `merchant_reserved` are never increased by a cash
receipt and never increased by moving `subscription_credit`.

## 6. Append-only and correction rules

- `billing_journals` and `billing_journal_lines` are INSERT-only. No UPDATE,
  no DELETE, no truncation. A correction is a **new reversal journal** whose
  lines mirror the original with debit/credit swapped and whose
  `reversal_of_journal_id` points at the original. The original is never
  edited.
- `billing_reservation_events` is INSERT-only.
- `billing_accounts` changes only `balance_minor` and `version`, through a
  successful posting; no delete.
- `billing_reservations` changes only through a CAS transition; no delete.
- Application privilege should deny UPDATE/DELETE on the append-only tables.
  Triggers are not required by this contract and are not asserted.

## 7. Concurrency invariants (SQL obligations)

These are the invariants the future SQL adapter must enforce; the domain code
and its in-memory test store only prove the contract, not SQL:

1. **Stable lock order.** For a posting, lock every affected account row with
   `SELECT ... FOR UPDATE` in ascending `account_id` order before computing
   balances. For a reservation transition, lock the reservation row first
   (`SELECT ... FOR UPDATE`), then the affected accounts in ascending
   `account_id` order. The domain already loads the unique touched accounts in
   ascending `account_id` order and the test store asserts that read/CAS call
   order; the SQL adapter must not reorder those accesses.
2. **CAS on version.** Every balance update is
   `UPDATE billing_accounts SET balance_minor = ?, version = version + 1
   WHERE id = ? AND tenant_id = ? AND version = ?`; affected rows must be 1.
   Any other result aborts the transaction.
3. **Idempotency race.** Insert `billing_idempotency_keys` (unique PK) before
   or atomically with the journal. A duplicate key must re-read the row: same
   `payload_hash` returns the existing result; different hash is a conflict.
4. **Reservation CAS.** `UPDATE billing_reservations SET status = ?,
   version = version + 1, <journal columns> WHERE id = ? AND tenant_id = ?
   AND version = ? AND status = 'reserved'`; affected rows must be 1.
   Release and consume must use the same predicate. A second consume sees the
   reservation not-`reserved` and fails.
5. **Sufficient available.** Under the account lock, assert
   `available.balance_minor >= amount_minor` before writing. Two concurrent
   reserves serialize on that row; only the one that still sees enough
   available may post.
6. **Atomicity.** The journal rows, line rows, account updates, reservation
   row and event row commit on the same connection. No pooled autocommit
   between them. The domain's injected `LedgerStore.runAtomic` is the seam;
   the test harness executes the callback and discards its writes on throw.

## 8. Domain contract shape (for B2-C-PERSISTENCE)

- `LedgerStore.runAtomic(callback)` and a transaction-bound `LedgerTransaction`
  with: `getAccount`, `findJournalByIdempotencyKey`, `getJournal`,
  `findReversalOf`, `insertJournal` (atomic CAS), plus reservation methods in
  `billing-reservations.ts`.
- `insertJournal` is the only balance-mutating primitive. It receives the
  already-computed per-account expected version and new normal-side balance,
  and either commits the whole journal or returns a typed replay/conflict.
- The persistence adapter must not reinterpret the old
  `instructor_wallets` / `instructor_wallet_transactions` rows as
  `merchant_available` or any ledger account.

## 9. HELD — deliberately not decided here

- fees and gateway surcharges; commission (approved zero, so no account);
- dispute/cooling/chargeback workflow and accounts;
- refund eligibility, partial refunds, and the refund source account;
- payout/withdrawal lifecycle, withdrawal fees/limits, and the payout
  counter-account policy;
- provider names/codes, external transfer ids, reconciliation file formats;
- invoice/receivable issuance, tax, recurring debit, grace period accounting;
- multi-account-per-kind (sub-wallets), revenue/expense/equity accounts,
  account provisioning UI and account closure;
- compensation workflow for an already-consumed reservation (the domain
  provides reversal journals, but the business approval path is HELD);
- any HTTP route, provider call, collection, or live SQL proof.

## 10. Open schema questions to resolve with B2-C-SCHEMA

- Whether `billing_idempotency_keys` can carry the cross-table
  `CHECK ((journal_id IS NULL) <> (reservation_id IS NULL))` given creation
  order; if not, use scope-specific checks.
- Whether `billing_reservation_events` should allow more than one `reversal`
  event per reservation; the unique key proposal above can be adjusted to
  `(reservation_id, event_type, idempotency_key)` without changing the domain.
- Whether the schema worker chooses `TIMESTAMP(3)` or `DATETIME(3)`; the
  domain only requires UTC ordering and millisecond precision.
