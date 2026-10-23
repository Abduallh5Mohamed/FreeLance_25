# M2-B09 — audited idempotent student-row import (server contract)

Task: `client-m2-16-audited-idempotent-student-import-20261021-01`.
Correction: `client-m2-16-transactional-authority-correction-20261022-01` — the
owner-authority read now runs **inside** the transaction that performs the
writes (`BEGIN` before the read), and a denied authority rolls that transaction
back before the answer.
Handoff: `docs/streams/client/M2-16-HANDOFF.md`.
Router: `server/src/routes/student-import-resolution.ts`, mounted additively at
`/student-import` inside `createTenantSelfRouter` beside the accepted M2-B08
read-only `/resolve` route.
Migration FILE: `server/migrations/20261021_04_student_import_batches.sql`
(**created, never applied by this batch**).

**This endpoint is the only WRITE in the student-import chain.** It creates
tenant student rows plus exactly one sanitized import-batch record, atomically
or not at all. It creates no account, login, password, invitation, OTP,
enrollment, group/course/branch assignment, payment or access.

## Endpoint

`POST /api/tenants/me/student-import/commit`

- Authenticated. The tenant is the one the authentication middleware selected
  from the caller's active memberships. **No tenant selector** is accepted in
  the header, the query or the body; the real tenant-authority boundary refuses
  one with `400` before this handler runs.
- `Cache-Control: no-store` on **every** outcome this handler produces,
  including `400`, `403`, `404`, `409`, `500` and `503`.
- A local `billingOnly` denial runs **before** any connection is acquired.

## Authorization

The caller must be the **verified owner** of the selected **active** tenant,
re-read **on the same connection that performs the writes** — and **inside the
transaction that performs those writes**:

```
SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
FROM tenants t JOIN users u ON u.id=? WHERE t.id=?
```

`owner_user_id === caller`, `status === 'active'` and `caller_active === 1` are
all required. A membership row labelled `owner` or `instructor` is **not**
sufficient, and an instructor/admin/student principal never reaches the write.

The transaction is opened **before** that read, so the authorization and the
writes it authorizes share **one** transaction on **one** connection. An
ownership change, a tenant suspension or a caller revocation that lands
between the authorization and the write therefore cannot slip through: the
authority read and every recheck and write after it observe the same
transaction. A denied authority rolls that transaction back **before** the
answer, writes nothing and releases the connection exactly once.

The observable order of the write path is:

```
acquire → BEGIN → authority read → idempotency lock (SELECT … FOR UPDATE)
        → existing-value re-check → batch record INSERT → student INSERTs
        → COMMIT → release
```

`BEGIN` is always the first step on the connection, so the authority read can
never happen outside a transaction: when `beginTransaction` fails, **no
statement is issued at all** and the connection is released without a
transaction.

## Outcomes

| Outcome | Status | Body |
|---|---|---|
| malformed payload | `400` | `{ "error": "Invalid student import commit payload" }` |
| billing-only | `403` | `{ "error": "…billing and support", "code": "BILLING_ONLY" }` |
| not the verified owner | `403` | `{ "error": "Forbidden" }` |
| no server-selected tenant | `404` | `{ "error": "Tenant membership not found" }` |
| no transactional seam | `503` | `{ "error": "Student import commit is unavailable", "code": "STUDENT_IMPORT_COMMIT_UNAVAILABLE" }` |
| same key, different payload | `409` | `{ "error": "…different batch", "code": "STUDENT_IMPORT_IDEMPOTENCY_CONFLICT" }` |
| an existing tenant value matched | `409` | `{ "error": "Some submitted rows already exist in this tenant", "code": "STUDENT_IMPORT_EXISTING_MATCH", "rows": [{ "row_number": 5, "matched_fields": ["email"] }] }` |
| a globally unique value collided | `409` | `{ "error": "A submitted value conflicts with an existing record", "code": "STUDENT_IMPORT_VALUE_CONFLICT" }` |
| `commit()` failed | `500` | `{ "error": "The import outcome is unknown; retry with the same idempotency key", "code": "STUDENT_IMPORT_COMMIT_UNCERTAIN" }` |
| acquisition/read/insert/rollback failure | `500` | `{ "error": "Failed to commit student import batch" }` |
| fresh commit | `200` | `{ "batch_id": "…", "replayed": false, "created": 3, "row_numbers": [2,3,4] }` |
| replay of the same key+payload | `200` | `{ "batch_id": "…", "replayed": true, "created": 3, "row_numbers": [2,3,4] }` |

Every `500` body is opaque: no SQL, no table name, no driver message, no stack
and no internal detail. The `409 STUDENT_IMPORT_VALUE_CONFLICT` body carries
**no row number and no field name**, because the conflicting record may belong
to another tenant and naming it would leak that tenant's data.

## Request

Exact body, no extra keys:

```json
{
  "idempotency_key": "a1b2c3d4e5f6a7b8c9d0e1f2",
  "rows": [
    { "row_number": 2, "name": "Ali", "email": "a@x.com", "phone": "0100",
      "guardian_phone": "", "grade": "3", "barcode": "" }
  ]
}
```

| Rule | Bound |
|---|---|
| body | plain object with **exactly** `idempotency_key` and `rows` |
| `idempotency_key` | `string`, `^[A-Za-z0-9_-]{16,128}$` |
| `rows` | array of `1..1000` |
| each row | plain object with **exactly** the 7 keys in the order `row_number, name, email, phone, guardian_phone, grade, barcode` |
| `row_number` | integer, unique, `2..1001` (the physical lines of a CSV's data records) |
| `name` | nonblank after trim, `<= 255` |
| `email` / `phone` / `guardian_phone` / `grade` / `barcode` | `string`, **already trimmed**, `<= 255 / 50 / 50 / 100 / 50` |
| whole batch | nonblank `email`, `phone` and `barcode` values are each unique within the batch |

A non-trimmed value is refused rather than silently normalized: the accepted
client parser trims every cell, so an untrimmed value is not one this client
can produce. Leading zeros, letter case and `+` are preserved and never
casefolded.

Every rule above is enforced **before** a connection is taken: a malformed
payload takes zero connections and issues zero statements.

## Existing-value re-check

Inside the transaction, before any insert, every nonblank `email`, `phone` and
`barcode` is re-checked against the tenant's **active** students using the same
bounded deduplicated chunked reads and application-level exact equality as the
M2-B08 reconciliation route:

```
SELECT <field> AS value FROM students
WHERE tenant_id=? AND is_active=1 AND <field> IN (?,…)
```

- values are **deduplicated per field** and read in chunks of at most **200**
  distinct values, so at most `3 × ceil(1000/200) = 15` statements;
- only the match column is projected — no `id`, `user_id` or private column;
- the collation may return a superset, so exact string equality is confirmed in
  the application;
- **any** match rejects the **whole** batch. No overwrite, no merge, no keep
  exception and no partial success.

The re-check runs **inside** the transaction, so a row inserted between the
client's reconciliation and this commit cannot slip through.

## Idempotency

The canonical payload is the JSON array-of-arrays of the rows in the fixed
documented key order (never object key), digested with `sha256` hex:

```
[[2,"Ali","a@x.com","0100","","3",""], …]  →  commitPayloadDigest
```

- **same tenant + same key + same digest** → the recorded result is returned
  with `replayed: true` and **no** student insert;
- **same tenant + same key + different digest** → `409
  STUDENT_IMPORT_IDEMPOTENCY_CONFLICT`;
- the unique `(tenant_id, idempotency_key)` plus the `SELECT … FOR UPDATE` gap
  lock inside the transaction is the serialization point: concurrent same-key
  attempts wait for each other, exactly one becomes the first writer and every
  other one answers from the stored record;
- keys are **tenant-scoped**: two tenants may use the same key independently.

## Writes

Exactly two tables are written, in this order, in one transaction:

1. `student_import_batches` — one sanitized batch/audit record, written
   **before** the students so the unique key is the serialization point. Its
   result fields are final at write time, so the record never has to be updated
   and can never disagree with the students.
2. `students` — the accepted rows only, in chunks of at most **200** tuples.

The student column list is exactly the eight documented columns
(`id, tenant_id, name, email, phone, guardian_phone, grade, barcode`), so no
account, login, password, invitation, OTP, enrollment, group/course/branch,
payment or access column can be touched: every other column keeps the schema's
own default.

- `id` and `tenant_id` are **server-generated / server-selected** — the request
  can name neither;
- an absent optional value is written as `NULL`, never as a blank string, so
  the globally unique `email`/`barcode` columns do not collide on "empty".

## Connection hygiene

The injected seam exposes `execute`, `beginTransaction`, `commit`, `rollback`,
`release` and `destroy`:

- a failure at any point rolls the whole batch back and releases the connection
  exactly once;
- a **denied authority** (the owner/tenant/caller read that runs inside the
  transaction) rolls the open transaction back before the answer, releases the
  connection exactly once and writes neither a batch record nor a student row;
- a **failed rollback** destroys the connection instead of returning it to the
  pool, because the session is in an unknown state;
- a `commit()` that throws leaves the outcome **unknown**: the connection is
  destroyed, the answer is `500 STUDENT_IMPORT_COMMIT_UNCERTAIN`, and the caller
  is told to retry with the **same** key. An uncertain commit is never turned
  into a retryable success and never rolled back blindly;
- a release that throws is swallowed and never changes the answer or writes a
  second response.

## Response

Exact body, exactly four keys — a batch identifier, a replay flag, a created
count and the submitted physical row numbers. No created student id, no stored
value and no existing-record identity is ever returned.

## Migration file

`server/migrations/20261021_04_student_import_batches.sql` defines one additive
table. It is **a file only**: this batch never applies it, and no test connects
to a database.

- `id CHAR(36)`, `tenant_id CHAR(36)`, `idempotency_key VARCHAR(128)`,
  `payload_digest CHAR(64)`, `created_count INT`, `row_numbers JSON`,
  `created_by CHAR(36)`, `created_at TIMESTAMP`;
- `PRIMARY KEY (id)`, `UNIQUE KEY (tenant_id, idempotency_key)`,
  `KEY (tenant_id, created_at)`, foreign keys to `tenants(id)` and `users(id)`;
- `CHECK` constraints bound the key length, the digest length, the created count
  and the `created_by` shape.

It stores **no** CSV value, **no** created student id, **no** existing-record
identity and **no** account/enrollment/payment linkage.

## Explicitly not in this contract

No account or user creation, no password, no invitation, no OTP, no enrollment,
no group/branch/course assignment, no payment, no XLSX, no migration
application, no notification, no billing or financial rule, no overwrite or
merge of an existing student, and no claim that an import approves anything.
