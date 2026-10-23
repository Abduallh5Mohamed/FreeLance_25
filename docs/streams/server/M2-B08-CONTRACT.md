# M2-B08 — private read-only student-import reconciliation (server contract)

Task: `client-m2-14-student-import-server-reconciliation-20261021-01`.
Handoff: `docs/streams/client/M2-14-HANDOFF.md`.
Router: `server/src/routes/student-import-resolution.ts`, mounted additively at
`/student-import` inside `createTenantSelfRouter`.

**This endpoint is a READ.** It creates no student, user, enrollment, invitation,
password, OTP, audit event or import commit, and it opens no transaction.

## Endpoint

`POST /api/tenants/me/student-import/resolve`

- Authenticated. The tenant is the one the authentication middleware selected from
  the caller's active memberships. **No tenant selector** is accepted in the
  header, the query or the body; the real tenant-authority boundary refuses one
  with `400` before this handler runs.
- `Cache-Control: no-store` on every outcome this handler produces.
- A local `billingOnly` denial runs **before** any connection is acquired.

## Authorization

The caller must be the **verified owner** of the selected **active** tenant:

```
SELECT t.owner_user_id, t.status AS tenant_status, u.is_active AS caller_active
FROM tenants t JOIN users u ON u.id=? WHERE t.id=?
```

`owner_user_id === caller`, `status === 'active'` and `caller_active === 1` are all
required. A membership row labelled `owner` or `instructor` is **not** sufficient,
and an instructor/admin/student principal never reaches the read.

| Outcome | Status | Body |
|---|---|---|
| malformed payload | `400` | `{ "error": "Invalid student import resolution payload" }` |
| billing-only | `403` | `{ "error": "…billing and support", "code": "BILLING_ONLY" }` |
| not the verified owner | `403` | `{ "error": "Forbidden" }` |
| no server-selected tenant | `404` | `{ "error": "Tenant membership not found" }` |
| acquisition/read failure | `500` | `{ "error": "Failed to resolve student import rows" }` |
| success | `200` | `{ "rows": […], "summary": {…} }` |

The `500` body never carries SQL, a table name, a stack or an internal detail, and
it **never** carries a `summary` — a broken reconciliation can never be read as
"nothing exists in the platform".

## Request

Exact body, no extra keys:

```json
{ "rows": [ { "row_number": 5, "email": "a@x.com", "phone": "0100", "barcode": "" } ] }
```

| Rule | Bound |
|---|---|
| `rows` | array of `1..1000` |
| each row | plain object with **exactly** `row_number`, `email`, `phone`, `barcode` |
| `row_number` | integer, unique, `2..1001` (the physical lines of a CSV's data records) |
| each value | `string`, **already trimmed** (`value === value.trim()`), `<= 4096` chars |
| per row | at least one of the three values is nonblank |
| whole request | total value characters `<= 2 Mi` (2,097,152) |

`''` means "this field is absent for this row" and never matches anything. A
non-trimmed value is refused rather than silently normalized: the accepted parser
trims every cell, so an untrimmed value is not one this client can produce.

Every rule above is enforced **before** a connection is taken: a malformed payload
takes zero connections and issues zero statements.

## Matching

Only **active students of the selected tenant** are read:

```
SELECT <field> AS value FROM students
WHERE tenant_id=? AND is_active=1 AND <field> IN (?,…)
```

- **Only the match column is projected.** No `id`, `user_id`, `name`, email/phone
  payload, guardian, grade or any other private column is selected, so no existing
  record's identity or data can leave the database through this endpoint.
- **The SQL is a candidate filter only.** The columns use a case-insensitive
  collation, so `IN (...)` can return a superset (a stored `A@X.com` for a
  requested `a@x.com`). The application confirms **exact string equality** against
  the requested value before reporting a match, so case, leading zeros and `+` are
  preserved and never normalized.
- `NULL` or non-string stored cells are skipped.
- No normalization, casefolding, merging, account linking or new uniqueness policy
  is introduced. Two records may match different fields of one row; that is
  reported as-is and claims no canonical identity.

## Cost bound

Values are **deduplicated per field** and read in chunks of at most **200**
distinct values per statement, one statement per (field, chunk):

- at most `3 fields × ceil(1000 / 200) = 15` statements for the largest accepted
  request, independent of how many rows share a value;
- there is no per-row query (N+1) and no per-row scan of the result set
  (quadratic);
- a field with no nonblank values issues **no** statement at all.

## Response

Exact body:

```json
{
  "rows": [ { "row_number": 5, "matched_fields": ["email", "phone"] } ],
  "summary": { "checked": 1, "matched": 1, "clear": 0 }
}
```

- exactly one entry per submitted row, **in the submitted order** (not sorted by
  row number);
- `matched_fields` is a subset of `email`, `phone`, `barcode` in that documented
  order, and is `[]` when nothing matched;
- `summary.checked === rows.length`, `summary.matched ===` the number of rows with
  a non-empty `matched_fields`, `summary.clear === checked - matched`.

## Connection hygiene

The injected seam exposes only `execute` and `release`: this module cannot start,
commit or roll back a transaction, and cannot discard a connection, because a
read-only statement leaves no uncertain transaction state to discard.

- acquisition failure: nothing to clean up, `500`;
- owner read or match read failure: `500` and the connection is released exactly
  once;
- success: released exactly once;
- a release that throws is swallowed (the connection is already gone) and never
  changes the answer or writes a second response.

## Explicitly not in this contract

No import commit, no account/user creation, no password or OTP, no enrollment, no
group/branch/course assignment, no XLSX, no migration, no notification, no billing
or financial rule, no audit write, and no claim that a match blocks or approves
anything.
