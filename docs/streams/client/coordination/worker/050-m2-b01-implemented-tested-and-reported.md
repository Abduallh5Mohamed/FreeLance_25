# M2-B01 implemented and reported — three authorized paths only

UTC2026-10-19T04:36Z / Cairo07:36, branch `codex/human-client`. Reply to
`supervisor/096` with amendments 094/095, consumed after the direct human
authorization in this session (`worker/049` recorded the earlier scope blocker;
that blocker is now resolved by the human, not by this worker).

Task: `client-m2-b01-tenant-profile-20261019-01`, team `backend`, claimed once via
`next_approved_task` with a unique workerId. The claim returned exactly the three
`allowedPaths` and no others; nothing was edited outside them.

## Changed paths

- `server/src/routes/tenant-self.ts` (modified, narrow)
  - `getOwnedTenant` keeps `authenticate` + `loadActiveTenantAuthority` unchanged and
    gains an optional projection flag. The default (billing/renewal) projection text is
    byte-identical to before; the profile projection is the minimal four fields
    `id,business_name,subject_type,status` on the same single statement.
  - New `GET /profile`: fixed four-field DTO `{tenant:{id,business_name,subject_type,status}}`,
    `Cache-Control: no-store`, existing `Tenant membership not found` 404, generic 500.
- `server/tests/m2-tenant-profile.test.ts` (new) — 19 tests.
- `docs/streams/server/M2-B01-CONTRACT.md` (new) — contract, status matrix, evidence, limits.

## One deviation to review explicitly

096/094 say "add `subject_type` to the existing `getOwnedTenant` projection". Doing that
globally breaks two accepted tests: `server/tests/m1-expanded-tenant-admin.test.ts:231`
matches that statement by exact substring (`includes`), and that file is **outside**
this task's `allowedPaths`. Rather than break accepted coverage or edit an out-of-scope
file, the profile path selects its own minimal projection through the flag and the
legacy text is proven unchanged by an explicit regression test. If the canonical
single projection is required, the task scope needs `server/tests/m1-expanded-tenant-admin.test.ts`
added so the fixture matcher can be widened — a one-line change this worker is not
authorized to make.

## Evidence (actually executed)

- `tsx --test tests/m2-tenant-profile.test.ts` → 19/19 pass.
- Selected hermetic set → 120/120 pass: `m2-tenant-profile`, `m1-expanded-tenant-admin`,
  `m1-auth-regressions`, `auth-boundary`, `m1-sprint-notification-support`.
- `tsc --noEmit -p server/tsconfig.json` → exit 0, 0 errors, identical before and after.
- Composition driven is the real one: `createOptionalAuth` → `enforceTenantAuthorityBoundary`
  → `enforceStudentWorkspaceBoundary` → `createTenantSelfRouter`, with injected
  repositories only; no listener, no `fetch`, no index startup.
- Import isolation is positive, not log-based: `src/db`, `src/services/minio`,
  `src/services/subscription-renewal` intercepted in the CJS loader before any app
  import; `MINIO_*` stay undefined; the real modules never enter `require.cache`;
  sentinel calls = 0; hook restored in `finally`. Counter-check without interception:
  the real load prints DB config, probes NICs and throws
  `MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required`, so the assertion is not vacuous.
- Observed status matrix (from real middleware order, not a document): 200 allow;
  401 unsupported `owner` role / invalid / missing / expired / revoked / inactive user;
  403 `TENANT_SUSPENDED`; 404 admin, no authority, forged or stale selection, ambiguous
  membership, student-with-workspace; 409 student without workspace at the boundary;
  400 spoofed header/query/nested-body selectors with the handler never reached;
  500 generic on data and authority failures.

## Limits (not claimed)

No live MySQL, HTTP transport, provider or Docker; row-level filtering stays with the
integration suite, which was **not run**. `loadActiveTenantAuthority` is fixture-injected
against the production SQL contract, with SQL text/binding and `(userId, tenantId)`
witnesses — it is not a copy of production logic and not an always-allow stub.

## State

Only the three paths above changed in the source tree (plus coordination/memory notes);
no revert of any prior dirty work, no git writes, no installs, no DB/network/Docker, no
task/state/approval/bridge/account/runtime/schedule change. Exactly one checkpoint pair
and one `submit_task_report`; a worker report is not acceptance.
