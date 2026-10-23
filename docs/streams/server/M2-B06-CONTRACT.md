# M2-B06 Contract — private tenant branding (localized labels and accent color)

**Task:** `client-m2-12-private-branding-20261021-01` — team `integration`, the
thirteen approved paths only, `implementationWorker: workbuddy`, `taskKind:
implementation`. **Basis:** the human196 direct request recorded in
[196](../client/coordination/supervisor/196-human-next-new-batch-private-branding.md)
under the human180 dual-lane delegation, and specified in
[M2-12-HANDOFF.md](../client/M2-12-HANDOFF.md).
**Branch:** `codex/human-client`.

This document is an execution and coverage contract. **It is not acceptance**;
acceptance is Codex's independent review.

## Changed paths (exactly thirteen)

| Path | Change |
|---|---|
| `server/src/routes/tenant-branding.ts` | **new** injected router with the whole branding contract: owner read and strict subset update |
| `server/src/routes/tenant-self.ts` | **additive only**: one import + one `router.use('/branding', …)` after the accepted lesson mount; every accepted handler is untouched |
| `server/migrations/20261021_02_tenant_branding.sql` | **new** additive table FILE — **never applied** |
| `server/tests/helpers/m2-tenant-branding-harness.ts` | **new** synthetic, positively isolated fixtures/composition helpers (test-only) |
| `server/tests/m2-tenant-branding.test.ts` | **new** hermetic authority/contract/write/no-op suite (51 tests) |
| `server/tests/m2-tenant-branding-failures.test.ts` | **new** hermetic cleanup/audit/failure suite (28 tests) |
| `src/pages/InstructorDashboard.tsx` | **additive only**: one import + one `<TenantBrandingCard />` mount; profile/name/wallet/dashboard logic and routes untouched |
| `src/features/tenant/TenantBrandingCard.tsx` | **new** Arabic/RTL accessible editor with an explicit open, labelled fields, local unsaved preview and read status |
| `src/features/tenant/branding.ts` | **new** injected client parser/controller/lifetimes |
| `src/lib/api-http.ts` | **additive only**: the branding DTO and two adapters; the shared `request`, auth, error and session contracts and every accepted adapter are untouched |
| `src/tests/m2-tenant-branding-ui.test.ts` | **new** real transport/controller/callback suite (83 tests) |
| `docs/streams/server/M2-B06-CONTRACT.md` | this document |
| `docs/streams/client/M2-12-CONTRACTS.md` | the editor/preview/checks/limits companion |

No change to `server/src/index.ts`, the authentication middleware, the shared
boundaries, any other router, the accepted unit/lesson routers or their accepted
tests, `csv-preview.ts`, `InstructorStudents.tsx`, the student-import sources, a
package, a configuration file or the schema of an existing table.

## Endpoints

```
GET   /api/tenants/me/branding
PATCH /api/tenants/me/branding
```

The router is mounted by `createTenantSelfRouter` under `/branding`, **after**
`router.use(deps.authenticate)` and next to the accepted lesson mount, so both
branding routes are authenticated by the existing middleware. The branding
module itself has **no default export** and binds **no** production adapter: the
transactional connection supplier is injected, and `AuthRequest` is imported as
a **type only**, so the module pulls in no authentication, database, provider or
environment module at runtime.

## Response envelope

Both endpoints answer **exactly**:

```json
{ "branding": { "display_name_ar": null, "display_name_en": null, "accent_color": null, "updated_at": null } }
```

The row is never spread: `tenant_id`, `created_at` and every owner/contact/
billing column stay server-side. The key set is exactly those four fields.

| Field | Type | Rule |
|---|---|---|
| `display_name_ar` | `string \| null` | `null` = inherit the existing presentation; otherwise a string trimmed to 1..255 characters. Unicode permitted, no script or locale guessing |
| `display_name_en` | `string \| null` | the same rule, in its own label slot |
| `accent_color` | `string \| null` | `null` = inherit; otherwise exactly `#RRGGBB`, **canonical UPPERCASE** |
| `updated_at` | `string \| null` | canonical ISO-8601 UTC instant (`2026-10-21T08:00:00.000Z`), or `null` **only** for a successful owner read of a genuinely absent config row |

`null` is a real value meaning "inherit", never the empty string and never a
fabricated default color. The empty string is never stored, so "inherit" has
exactly one representation.

## Authority

Owner-only, resolved from server-side rows on the same connection that performs
the work: `tenants.owner_user_id` = caller, `tenants.status = 'active'`,
`users.is_active = 1`. A membership `role_key` label (`owner`/`instructor`)
never grants visibility or a write, and a global admin/student role is not a
tenant owner at all.

The tenant is **never** taken from the request: it is the server-selected scope
on the authenticated principal. There is no tenant/header/body/identity selector
and no global or public projection endpoint. The accepted
`enforceTenantAuthorityBoundary` still rejects a client-supplied selector with
400 before the handler runs.

**Order:** the local `billingOnly` refusal (403 `BILLING_ONLY`) happens
**before** any connection is acquired, and the owner verification happens
**before** the config row is looked up — so a non-owner learns nothing about
whether a branding row exists.

| Outcome | Status | Body |
|---|---|---|
| billing-only principal | 403 | `{ error: "Branding management is not available while the account is limited to billing and support", code: "BILLING_ONLY" }` |
| non-owner (membership instructor, role label, foreign owner) | 403 | `{ error: "Forbidden" }` |
| no selected workspace | 404 | `{ error: "Tenant membership not found" }` |
| strict payload rejection | 400 | `{ error: "Invalid branding payload" }` |
| read failure (missing schema, broken statement, unreadable instant/color) | 500 | `{ error: "Failed to load branding" }` |
| write failure (same causes) | 500 | `{ error: "Failed to update branding" }` |

Every handler-owned outcome sets `Cache-Control: no-store` **before** the first
await and before any denial, so the 200, the own 403/404 and every 500 carry it.

## Update semantics

`PATCH` takes a **nonempty subset** of only `display_name_ar`,
`display_name_en` and `accent_color`. The body must be a plain object; an empty
object, an unknown key (tenant/owner/logo/theme/language/status), an array, a
number, a boolean, a `null`-adjacent empty string, a whitespace-only label, a
label over 255 characters, a shorthand/named/`rgb()`/URL color or a non-string
value is rejected **before** a connection is acquired.

**No-op.** When the requested **effective** values equal the current effective
values, nothing is updated, nothing is audited and nothing is committed; the
truthful canonical DTO of the current state is returned. An absent row with an
all-null requested effective config is exactly such a no-op and the row **stays
absent** (`updated_at: null`). A whitespace or case variant of the same label or
color is a no-op, because the comparison is on the normalized effective value.

**First insert.** An absent row with a real change inserts the **complete**
effective row, storing every field the request did not mention as `NULL`.

## Atomicity, audit and disposal

One injected connection, one transaction. Inside it, in this order:

1. `SELECT … FROM tenants t JOIN users u … FOR UPDATE` — owner, tenant status and
   caller status under lock. **This owner-row lock is also what serializes two
   concurrent first inserts for the same tenant**, so at most one can reach the
   `INSERT`.
2. `SELECT … FROM tenant_branding WHERE tenant_id=? FOR UPDATE` — the existing
   config row, locked for the write (a read uses the plain snapshot select and
   takes no exclusive lock).
3. `INSERT` (first save) or `UPDATE`.
4. **Exactly one bounded audit event**: `tenant.branding_updated`, resource type
   `tenant_branding`, resource id = tenant id, with `old_value`/`new_value`
   carrying **only** the three branding fields. No credential, student, billing
   or business-identity field is ever written to the audit payload.
5. Read-back of the row inside the same transaction.
6. The **DTO is materialized from the epoch projection before the single
   commit**, so an unreadable stored instant or a non-canonical stored color
   fails the write instead of committing a row whose value could only be
   guessed. A read-back that does not match the requested effective config is an
   internal consistency failure (500), not a product conflict.

**Disposal is exactly one safe action:**

| Situation | Disposal |
|---|---|
| confirmed rollback, no-op, or committed transaction | `release()` exactly once |
| failed rollback | `destroy()` |
| failure after acquisition but before the transaction state is confirmed | `destroy()` |
| **lost commit acknowledgement** | `destroy()`; the 500 is returned, **no rollback, idempotence or retry is claimed**, and persistence stays explicitly unknown |
| acquisition failure | neither — no connection exists |

No lost-update-prevention, version or CAS promise is made. The only
serialization is the row lock taken inside this transaction; no product conflict
policy is invented, and there is deliberately no 409.

## Timestamp projection

`updated_at` is read as `UNIX_TIMESTAMP(updated_at)`, never as a driver datetime
value. The installed mysql2 pool is configured with `timezone: '+02:00'`, which
makes the driver **interpret** the wall time it receives on the client side; it
is not a `SET SESSION time_zone` statement. A TIMESTAMP stored as `12:00:00` in a
UTC session would therefore be decoded as `10:00Z`, shifting every serialized
instant by the offset of the day. Projecting the stored instant as epoch seconds
removes the driver interpretation entirely.

A missing, malformed, non-positive or unrepresentable epoch is **refused**: no
1970 instant, no "now" and no null date is ever fabricated for a row that exists.

## Schema FILE (never applied)

`server/migrations/20261021_02_tenant_branding.sql` creates **one** new table.
No database was connected, no statement was executed, no seed or backfill ran and
no runtime DDL exists in the application.

```sql
CREATE TABLE IF NOT EXISTS tenant_branding (
  tenant_id CHAR(36) NOT NULL,              -- PRIMARY KEY: one row per tenant
  display_name_ar VARCHAR(255) NULL,
  display_name_en VARCHAR(255) NULL,
  accent_color CHAR(7) NULL,                -- '#RRGGBB', canonical UPPERCASE
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tenant_branding_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  … three CHECK constraints (canonical color, label length) …
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`tenant_id` **is** the primary key, so the one-row-per-tenant invariant is
enforced by the database and no second identity column can disagree with it. The
foreign key has no `ON DELETE` clause, so deleting a tenant that still owns a
branding row is refused rather than silently orphaning or cascading it. The
primary key is the only access path: every read and write is
`WHERE tenant_id = ?`, so no secondary index is declared.

**A missing schema is a 500, never an all-null success.** A deployment where the
FILE was never applied answers `Failed to load branding` / `Failed to update
branding`; the client invents no fallback data.

## Verification actually run

| Command | Result |
|---|---|
| `cd server && npx tsx --test tests/m2-tenant-branding.test.ts` | **51 pass / 0 fail** |
| `cd server && npx tsx --test tests/m2-tenant-branding-failures.test.ts` | **28 pass / 0 fail** |
| `cd server && npx tsx --test tests/m2-tenant-profile.test.ts tests/m2-tenant-profile-update.test.ts tests/m2-tenant-branches.test.ts tests/m2-course-units.test.ts tests/m2-course-lessons.test.ts tests/m2-course-lessons-reorder.test.ts` | **245 pass / 0 fail** (unchanged) |
| `cd server && npx tsc --noEmit` | **0 diagnostics** |
| `npx tsx --test src/tests/m2-tenant-branding-ui.test.ts` | **83 pass / 0 fail** |
| `npx tsx --test src/tests/m2-course-management.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts` | **330 pass / 0 fail** (unchanged) |
| `npx tsx --test src/auth/access-control.test.ts` | **9 pass / 0 fail** (unchanged) |
| `npx tsc --noEmit -p tsconfig.app.json` | **0 scoped diagnostics**; **11** pre-existing errors remain, all outside this scope (see below) |

### Known 11 outside-scope frontend diagnostics (pre-existing, untouched)

`src/components/NotificationBell.tsx` (1), `src/components/StudentHeader_OLD_BACKUP.tsx` (2),
`src/pages/ExamReports.tsx` (2), `src/pages/ExamResults.tsx` (1),
`src/pages/Fees.tsx` (2), `src/pages/StudentBarcodes.tsx` (1),
`src/pages/StudentDashboard.tsx` (1), `src/utils/versionChecker.ts` (1).

None is in a file this batch created or modified.

## Limits — what is NOT proven

- **No live MySQL.** Real row-level locking, real concurrent transactions, real
  index usage and real `ER_NO_SUCH_TABLE` behaviour are **not** exercised. The
  fixture models the *statements* and the *transaction replay*; it does not model
  the server. In particular, a destroyed connection would abort the transaction
  server-side; the observable guarantee here is the `destroy()` itself.
- **No listener, socket, HTTP, DB, provider or app startup.** The composition is
  driven through the real middleware chain with request/response plumbing.
- **No runtime rollout.** The migration FILE is not applied, so branding is
  unavailable in a real deployment until a separately authorized gate applies it.
- **No concurrency guarantee beyond the documented row lock.** No CAS, no
  version column, no lost-update prevention is claimed.
- **No global theme/language/provider change, no logo/asset/upload, no
  host/subdomain/DNS/TLS.** Those remain separate dependency gates.
- This contract is **not** acceptance.
