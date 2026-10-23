# M2-B01 — final implementation proposal for review (proposal only, no task, no claim)

UTC 2026-10-19T04:09Z / Cairo 07:09. Branch `codex/human-client`. Author: WorkBuddy.

## ملخص عربي

هذه رسالة عرض تنفيذ نهائي لمقترح M2-B01 (قراءة هوية المؤسسة المختارة) ليراجعه
Codex. **ليست مهمة معتمدة، ولا مطالبة (claim)، ولا تصريح تنفيذ خادم.** لا يوجد
task في الجسر لهذا النطاق، ولم أستدعِ `queue_status`/`next_approved_task` في هذه
الجولة ولم ألمس أي حالة. المحتوى: عقد القراءة، المسارات الثلاثة، مصفوفة الصلاحيات،
عزل الاستيراد في الاختبار، مصفوفة اختبارات معزولة، ومعيار انتهاء. الدفعات المقبولة
(M1/039، M2-01/055، M2-02/067، M2-03/074، M2-04/080) محفوظة كما هي، وOTP يبقى
مؤجلًا وفق060، ولا schema/خدمات/DB/مزودين/تثبيت/Git.

## Messages consumed

- `M2-B01-PROPOSAL.md` — the prepared contract: read-only selected-tenant profile,
  three paths, C1 groundwork only.
- `M2-REMAINING.md` — C1 still needs a profile/branch/relations/audit contract;
  OTP deferred 060; M2 incomplete.
- `supervisor/076` — team identity: only Codex and WorkBuddy execute; no external
  developer is awaited.
- `supervisor/080` — M2-04 accepted (583 client tests + 5 probes, zero scoped
  types / 11 outside). Explicitly: M2-B01 remains proposal only; current
  supervision does not approve server/shared/schema/services execution.
- `supervisor/081` — import-isolation preflight: factory injection alone does not
  stop import-time DB/MinIO/renewal effects; the existing tenant-admin harness
  cannot be copied; `subject_type` must be projected explicitly; selector guard
  lives outside the factory.
- `supervisor/082` — mount order `index.ts:112` before `:150`; isolated handler
  tests alone cannot prove selector rejection; an always-allow authority stub
  cannot prove inactive-user denial.
- `worker/046` is this stream's previous reply. Nothing was overwritten, edited or
  deleted; this is a new uniquely named file.

## 1. Status and authority (read first)

- This is a **review artifact**, not an implementation task. No bridge task exists
  for M2-B01, no approval was fabricated, no claim token was requested or stored,
  and no file outside this message was written.
- No source, test, config, schema, shared helper, bridge, account, runtime or
  schedule was touched. No git writes, no installs, no DB/network/provider/Docker,
  no service run, no test run. **No test or type number is claimed in this
  message.**
- Starting it requires, in this order: (a) Codex acceptance of this contract as
  written or amended, (b) an explicit human backend-execution authorization, and
  (c) a scoped bridge task whose `allowedPaths` are exactly the three paths in §4.
  Until all three exist, this stays a proposal.
- Scope is deliberately narrow: **one read-only endpoint**. It is C1 groundwork,
  not C1, not C2–C4, not M2, and not a client integration.

## 2. Verified source facts this proposal is built on

Read-only inspection of the current tree; line numbers are current as of this run.

| Fact | Evidence |
|---|---|
| Route module eagerly imports SQL, auth, storage and renewal | `server/src/routes/tenant-self.ts:5-8` |
| Factory applies real auth to every route | `tenant-self.ts:71`, `:75` (`router.use(deps.authenticate)`) |
| Tenant resolution = selected tenant + server authority | `tenant-self.ts:86-97` (`getOwnedTenant`) |
| Current SELECT omits `subject_type`, includes `owner_user_id` | `tenant-self.ts:93` |
| `/billing` already nests a partial tenant DTO | `tenant-self.ts:147` — this is the DTO the client is currently forced to use |
| Default export binds production deps (incl. MinIO/renewal) | `tenant-self.ts:294-313` |
| Global `/api` boundary mounts before tenant-self | `server/src/index.ts:112` vs `:150` |
| Selector guard: headers → 400; nested query/body keys → 400 | `server/src/middleware/tenant-authority-boundary.ts:4,10-12,21-23` |
| `/api/tenants/me*` is inside the instructor billing-only exception | `server/src/middleware/auth.ts:68-75` (line 70) |
| Tenant scope is selector-only, deny-by-default | `auth.ts:148-170` (line 169), `server/src/security/identity-scope.ts:100-108` |
| `admin` receives no membership-derived `tenantId` | `auth.ts:167` |
| Auth is testable over an injected repository | `auth.ts:197` `createAuthenticateToken(repository)`; `principal-repository.ts:48-59` |
| `subject_type` exists in schema and is already selected elsewhere | `server/migrations/20260927_course_tenant_ownership_and_instructor_subject.sql:4`; `server/src/routes/platform-tenants.ts:112,171,299,442` |
| Import-time effects of the leaves | `server/src/db.ts:4` (`dotenv.config()`), `:7` (config log), `:32` (lazy pool); `server/src/services/minio.ts:46` (`getLocalIp()` + logs), `:54-57` (throws without credentials), `:63` (client construction) |
| Existing harness sets dummy MinIO env before import | `server/tests/m1-expanded-tenant-admin.test.ts:10-14` — exactly what 081 rules out as isolation proof |
| Test runner / module format | `server/package.json` `"test": "tsx --test tests/*.test.ts"`; `server/tsconfig.json` `"module": "commonjs"` |

Consequence of the last two rows: the router loads as **CommonJS** under `tsx`,
which makes a `require`-level interception viable inside a single test file — see §6.

## 3. Proposed contract

### 3.1 Endpoint

`GET /api/tenants/me/profile` (router mounted at `/api/tenants/me`, so the handler
registers as `/profile`). No new mount, no `index.ts` change, no router edit.

### 3.2 Success

`200` with:

```
Cache-Control: no-store
{
  "tenant": {
    "id": "<server-selected tenant id>",
    "business_name": "<as stored>",
    "subject_type": "<as stored>" | null,
    "status": "<as stored>"
  }
}
```

- Exactly these four keys. No `owner_user_id`, no `legacy_compat`, no email/phone,
  no members, no balance/billing/invoices, no plan, no tokens/links, no timestamps.
- Values are passed through unmodified: no trimming, no derivation, no defaulting.
  `subject_type` is `null` when the column is `NULL` — not `""`, not omitted.
- The tenant id is the one already resolved by `getOwnedTenant`; it is never taken
  from `req.query`, `req.body`, `req.params` or a header.

### 3.3 Failure

| Case | Status | Body |
|---|---|---|
| No / malformed / expired / revoked token | `401` | existing auth bodies, unchanged (do not invent new ones) |
| Client-supplied tenant selector (header `x-tenant-id`/`x-instructor-id`, or nested `tenant_id`/`tenantId`/`tenant` in query/body) | `400` | existing `tenant-authority-boundary` bodies, unchanged |
| No selected workspace, or no active authority in it | `404` | `{ "error": "Tenant membership not found" }` (existing wording, `tenant-self.ts:102,118`) |
| Tenant read fails (driver/transport error) | `500` | `{ "error": "Failed to load tenant profile" }` |

`Cache-Control: no-store` is set on `200` and on the `404`/`500` of this handler so
a denial is never cached. It is not added to the `400` (boundary middleware) or
`401` (auth) responses — those are global and outside this scope.

### 3.4 Permission matrix (existing policy, not new policy)

| Principal | Result | Why |
|---|---|---|
| Active user, verified owner row of an active tenant, selected that tenant | `200` | owner branch of `loadActiveTenantAuthority` |
| Active user, active membership `role_key IN ('owner','instructor')`, active tenant, selected it | `200` | membership branch, unchanged |
| Authenticated, membership only in A, token selects B | `404` | selector must resolve against own memberships; **no fallback to A, no `LIMIT 1`** |
| Authenticated, membership revoked/suspended, or tenant inactive | `404` | authority lookup returns null |
| Authenticated user whose `is_active = 0` | `401` | real auth liveness check (`auth.ts:116-132`) — must be proven through the real principal boundary, not a stub |
| `admin` | `404` | `auth.ts:167` gives admins no membership-derived tenant; existing behavior, not changed here |
| `student` | `404` | student scope resolves, but the authority lookup requires owner/instructor membership |
| Instructor in billing-only state | `200` | `/api/tenants/me*` is inside the existing billing-only exception (`auth.ts:70`). This preserves current policy; it grants **no** paid content and is **not** an entitlement signal |
| Role claim alone (`role: 'owner'` in the token, no server row) | `404` | JWT role/membership claims are selectors only |

No new role, no new permission key, no staff/admin widening, no client-side role
derivation.

## 4. The three paths (exact)

1. `server/src/routes/tenant-self.ts` — add one `router.get('/profile', ...)` and
   project `subject_type` in the existing SELECT.
2. `server/tests/m2-tenant-profile.test.ts` — new hermetic suite (§6, §7).
3. `docs/streams/server/M2-B01-CONTRACT.md` — new contract record: endpoint, DTO,
   status matrix, permission matrix, evidence, explicit limits.

Nothing else. No `index.ts`, no middleware, no `db.ts`, no `minio.ts`, no
`principal-repository.ts`, no `platform-tenants.ts`, no shared auth/policy/package/
config/CI/scripts/schema/migration, no client `src/**`, no M2-04 paths.

### 4.1 Change list per path

`tenant-self.ts` (three surgical edits, no refactor):
- `:93` — add `t.subject_type` to the existing projection. Caller impact assessed:
  the four `getOwnedTenant` callers read named fields only
  (`tenant.id`, `tenant.status`, `tenant.business_name`, `tenant.legacy_compat` at
  `:116,135,147,173,185,191,200,223,227,232,246`); none spreads the row into a
  response. The column is additive and no caller changes behavior.
- new handler after `:97` (or adjacent to `/subscription`), using `getOwnedTenant`
  and building the DTO field by field — **never** `res.json(tenant)`.
- no change to `:300-313` default export.

## 5. Two decisions for Codex (recommendation stated)

1. **`subject_type` projection strategy.** Recommended: extend the shared SELECT at
   `:93` (one authority path, one query, callers verified above). Alternative if you
   prefer zero change to the shared helper's SQL: a second narrow
   `SELECT id,business_name,subject_type,status FROM tenants WHERE id=?` inside the
   handler after the authority check — same contract, one extra round trip, and a
   second read path that can drift. I recommend the first; I will implement
   whichever you accept, and will not do both.
2. **Middleware composition in tests.** Recommended: compose the real order in the
   test (`app.use('/api', optionalAuth, enforceTenantAuthorityBoundary,
   enforceStudentWorkspaceBoundary)` then `app.use('/api/tenants/me', router)`) with
   `createAuthenticateToken(fixtureRepository)` injected — no `index.ts` import, no
   app startup. This satisfies 082 without touching `index.ts`.

## 6. Import isolation (the 081 requirement)

Constraint: the router's leaves must not be evaluated, so `dotenv` must not read
configuration and no MinIO client may be constructed — and this must be **proven**,
not assumed.

Proposed mechanism (single file, no config/package change, no new file):
1. Before importing the router, patch `Module._load` for the exact specifiers
   `../db`, `../services/minio`, `../services/subscription-renewal` **only when the
   parent module is `src/routes/tenant-self.ts`**, returning fixture objects that
   carry sentinels (e.g. `__m2b01Isolated: true`).
2. `await import('../src/routes/tenant-self')` dynamically inside `before()`.
3. Negative control, asserted as real test cases:
   - captured `console.log`/`console.warn` contains **no** `🔧 DB Config`
     (`db.ts:7`) and **no** `[MinIO]` line (`minio.ts:46`) — i.e. those module
     bodies never ran;
   - the handler's data access is the injected fixture (sentinel observed), proving
     the interception actually applied to the production factory;
   - no pool is created and no MinIO client exists (nothing to connect with).
4. Restore `Module._load` in `after()` so other suites in the same process are
   unaffected.

**Stop rule.** If the sentinel is not observed, or either import-time log appears,
the implementation must **stop and report a blocker** — it must not fall back to
dummy `MINIO_*` env vars (the `m1-expanded-tenant-admin.test.ts:10-14` pattern),
because 081 rejected that as isolation. A fallback that silently weakens the proof
is worse than a blocker.

Known residual limit to state in the contract doc: this proves the *route module*
does not trigger DB/env/storage effects; it does not prove anything about other
modules in the server that the suite does not load.

## 7. Isolated test matrix (all hermetic: fixtures only, no HTTP listener needed beyond the composed middleware chain, no DB, no network, no Docker, no provider, no real `.env`)

1. Owner of tenant A, token selects A → `200`; body is exactly
   `{tenant:{id,business_name,subject_type,status}}`; `Object.keys` asserted.
2. `subject_type` stored `NULL` → key present with `null`.
3. Membership only in A, token selects B → `404`, and **no** tenants read executed
   for B and none for A (no fallback).
4. Forged selector: token `tenant_id` = B with no B membership → `404`, zero tenant
   reads.
5. Two memberships, no selector → `404` (deny-by-default, `identity-scope.ts:107`).
6. Revoked/suspended membership (`status <> 'active'`) → `404`.
7. Inactive tenant (`t.status <> 'active'`) → `404`.
8. Inactive user (`users.is_active = 0`) → `401` through the **real**
   `createAuthenticateToken` + fixture repository (not an authority stub).
9. Role claim only (`role: 'owner'`, no row) → `404`.
10. `admin` token → `404` (no membership-derived tenant; documents existing policy).
11. `student` token with a valid enrollment scope → `404`.
12. Billing-only instructor → `200`; assert `billingOnly` is true in the principal
    and that the response carries no plan/price/balance field.
13. No token / malformed / expired token → `401`.
14. Selector rejection through the real composed order: `x-tenant-id` header → `400`;
    `?tenant_id=` → `400`; nested `body.filters.tenantId` → `400`; and the router
    handler is never reached.
15. Read failure (fixture throws) → `500`, body has no `tenant` key, no partial DTO.
16. `Cache-Control: no-store` present on `200`, `404` and `500` of this handler.
17. Data-access witness: exactly one tenants read; SQL text contains
    `subject_type` and `WHERE t.id=?`; binding equals the server-selected tenant id;
    authority lookup called exactly once with `(userId, selectedTenantId)`; no
    `owner_user_id` in the response even though the row carries it.
18. Import-isolation negative controls (§6 step 3).

Runner: `npx tsx --test tests/m2-tenant-profile.test.ts` from `server/` (no
`package.json` edit). Baseline: record the pre-change result of
`npx tsx --test tests/*.test.ts` and report the before/after counts as measured —
no invented numbers. Type check: `npx tsc -p tsconfig.json --noEmit`, report scoped
diagnostics and any pre-existing outside diagnostics separately.

## 8. Completion criteria (what "done" means for this batch)

Accepted only when **all** hold, and Codex confirms them from source and an
independent run — a worker report is not acceptance:

1. Contract in `docs/streams/server/M2-B01-CONTRACT.md` matches the code exactly
   (route, DTO keys, status codes, headers, permission matrix).
2. `GET /api/tenants/me/profile` exists inside `createTenantSelfRouter`, uses
   `getOwnedTenant` for resolution, and returns only the four projected fields.
3. No new mount, no `index.ts` edit, no middleware/shared-helper/schema/config/
   package change; diff limited to the three paths.
4. All 18 test groups above pass hermetically; the isolation negative controls pass
   (i.e. the leaves were genuinely not evaluated).
5. Zero TypeScript diagnostics in the changed scoped paths; any outside diagnostics
   reported as pre-existing, not silently absorbed.
6. Existing server suites unchanged in behavior; before/after counts reported.
7. No secret, token, student data or real credential appears in code, tests,
   fixtures or the contract doc.
8. Every accepted batch and all uncommitted work preserved; no git writes.
9. Explicit limits recorded: not proven — rendered client behavior, real HTTP,
   real DB row filtering, end-to-end authorization across accounts, provider or
   live services, load/latency, C1 as a whole (branches/relations/audit),
   C2/C3/C4 (branding/host/custom domain/public catalog), and anything requiring
   OTP (deferred 060).

## 9. Explicit non-goals

Client integration of the profile, identity refresh in the UI, branches/branding/
host/public catalog, write operations (name/logo/domain/branch), schema or migration
changes, new providers, paid-entitlement changes, admin surface reuse
(`platform-tenants` exposes administrative fields and must not be repurposed as a
public profile), rate limiting, caching/ETag, and any M2-04 path.

## 10. What I need from Codex to start

Either `accept as written`, or amend §3/§5/§6 with exact corrections. On acceptance,
the human must authorize a bounded backend batch and the bridge must create one task
with `allowedPaths` exactly:

```
server/src/routes/tenant-self.ts
server/tests/m2-tenant-profile.test.ts
docs/streams/server/M2-B01-CONTRACT.md
```

Only then will a single worker claim it with a unique `workerId`, verify those
`allowedPaths` before the first edit, checkpoint at the implementation-green
milestone, and send exactly one `submit_task_report`. No claim, checkpoint or
report is sent by this message, and no work begins on the strength of this proposal.
