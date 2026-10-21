# Server stabilization batch — 2026-10-19

Human authorized parallel native agents with disjoint ownership and quality gates.
Existing server work is preserved; certificates remain excluded, SMS deferred.

| Owner | Exclusive write scope | Outcome |
|---|---|---|
| Luna search | routes/search.ts, services/search.ts, tests/m8-search.test.ts | Resolve type errors without weakening tenant/publication filters |
| Luna export | services/tenant-export.ts, tests/m8-tenant-export.test.ts | Reconcile fixture/service contract and preserve active-job/cooldown guards |
| Luna integration reviewer | Read only | Verify safe routes, auth order and missing-secret behavior |
| Root supervisor | bootstrap/m1/manifest.json, index.ts, new integration test, this report | Review migration source/hash without SQL execution, integrate mounts after worker completion, validate combined tree |

## Sequence

1. Workers inspect and fix their own files; no shared helper or index edits.
2. Root inventories migration23 hash, explicitly retaining the live-validation gap.
3. Root reviews agent diffs and integrates safe routes after their dependencies pass.
4. Full guarded hermetic suites from root and server cwd, source typecheck and diff check.
5. Report failures honestly; do not mark milestones accepted from file existence.

## Boundaries

No frontend, Git mutations, production/isolated DB execution, Docker, services,
credentials or provider messages. Migration files remain unchanged. No scope
expansion into billing implementation or launch readiness.

## Delivery and review

- Search worker replaced unsafe kind casts with validated type guards, and
  corrected the course/lesson query map type; announcement queries retain
  their separate scoped builder. Focused search tests: 24/24.
- Export fixture now models queryOne active-job/cooldown checks and persists
  fake job transitions. Both tenant owners can export their own data; the
  foreign-tenant download denial remains. Root corrected the local response
  send adapter and added a tenant-b fixture row. Focused tests: 21/21.
  The earlier report's claim of 23 tests was inaccurate: the file contains
  21 actual tests; none was removed to make the suite pass.
- Migration23 source was inspected and its SHA256 registered in the manifest.
  This is inventory only; no SQL was executed or idempotency/live correctness proven.
- Root mounted search, tenant export and platform MFA after shared API guards;
  mounted operations through its existing observability helper once, replacing
  raw path logging with structured observation. Environment loads before route
  defaults capture dedicated secrets. Two new integration-contract tests pass,
  including anonymous requests to the actual default routers returning401.
- An independent read-only agent checked the root integration and found no
  concrete regression; no production startup or real infrastructure was run.

## Deliberately incomplete

Impersonation remains unmounted: approval can activate a session before key
availability is established, and ordinary request authentication is not wired
to its scoped impersonation context. Exposing management endpoints alone would
not complete the capability. A dedicated correction/review scope is required.

MFA endpoint mounting does not prove mandatory step-up enforcement across all
sensitive APIs. Database tables, persistent export storage and dedicated
METRICS_TOKEN/TENANT_EXPORT_SECRET/MFA_SECRET_KEY provisioning still need
separately authorized operational validation. Readiness currently probes only
SELECT1, not schema readiness. No production launch or phase acceptance claimed.

## Validation

- Root full guarded hermetic suite: 2141/2141, exit0.
- Source typecheck: exit0. Diff check: exit0.
- Server-cwd full guarded hermetic suite: 2141/2141, exit0.
- An initial new ops test used a response harness without setHeader; it was
  removed as incompatible before delivery. Existing ops token/liveness/readiness
  tests were retained unchanged and passed (ops+bootstrap focused27/27).
- Private logs: WorkBuddySupervisorBridge/handoff/native-stabilization-root.log
  and native-stabilization-server.log. No credentials or claim tokens included.
