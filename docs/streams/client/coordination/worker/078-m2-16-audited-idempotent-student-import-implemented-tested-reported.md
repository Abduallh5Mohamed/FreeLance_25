# 078 — M2-16 audited idempotent student-row import: implemented, tested, reported

Task: `client-m2-16-audited-idempotent-student-import-20261021-01`
Lane: WorkBuddy native implementation worker (manual human copy/paste, per supervisor208)
Claim: `workerId workbuddy-native-m2-16-audited-import-20261021`, team `frontend`,
`approvalVersion 2`, scopeHash
`0e9c7b1adab19f7011de16762c16b79a36db345520826bacf06c41bc1a59d83f`
MCP report: submitted, `awaiting_supervisor`. **Not an acceptance.**

## Scope

The claim returned exactly the thirteen M2-16 handoff paths and they matched
before any edit. Only those thirteen were touched.

| Path | Change |
|---|---|
| `server/migrations/20261021_04_student_import_batches.sql` | new — additive table, **file only, never applied** |
| `server/src/routes/student-import-resolution.ts` | transactional `POST /commit` beside the accepted read-only `/resolve` |
| `server/src/routes/tenant-self.ts` | additive mount wiring only (`getCommitConnection`) |
| `server/tests/helpers/m2-student-import-resolution-harness.ts` | extended transactional fixture; every accepted assertion still valid |
| `server/tests/m2-student-import-commit.test.ts` | new — 51 tests |
| `server/tests/m2-student-import-commit-failures.test.ts` | new — 18 tests |
| `src/features/students/StudentImportPreview.tsx` | additive import seam, gate and emerald import block |
| `src/features/students/import-commit.ts` | new — 714 lines |
| `src/lib/api-http.ts` | additive `commitStudentImportBatch` returning `{status, body}` |
| `src/tests/m2-student-import-commit.test.ts` | new — 102 tests |
| `docs/streams/server/M2-B09-CONTRACT.md` | new |
| `docs/streams/client/M2-16-CONTRACTS.md` | new |
| `docs/streams/client/M2-16-PROPOSAL.md` | status/decision record only |

No other route, auth, shared middleware, provider, package or configuration
file was touched.

## What changed

**Server — the only write in the student-import chain.** Owner-only
selected-active-tenant authority is re-read **on the same connection that
performs the writes**; a membership role label is never sufficient. The body is
exactly `{idempotency_key, rows}`, and every bound (key shape, 1..1000 rows, the
seven row keys in order, unique integer row numbers 2..1001, already-trimmed
in-bound values, nonblank name, within-batch value uniqueness) is enforced
**before** a connection is taken, so a malformed payload issues zero statements.

Inside one transaction the route re-checks every nonblank email/phone/barcode
against this tenant's **active** students with the accepted bounded
deduplicated chunked reads (at most 15 statements) and application-level exact
equality. **Any** match refuses the **whole** batch with row numbers and matched
field names only — never a stored value, an id or an identity — and there is no
overwrite, merge, keep exception or partial success.

Idempotency is bound to a `sha256` digest of the canonical JSON
array-of-arrays in the fixed documented key order. Same tenant + same key +
same digest replays the recorded result with no insert; same key with a
different digest is `409`. The unique `(tenant_id, idempotency_key)` plus a
`SELECT … FOR UPDATE` inside the transaction is the serialization point, so
concurrent same-key attempts serialize and exactly one becomes the first writer.

Exactly two tables are written, the batch record **first** (its result fields
are final at write time, so it can never disagree with the students) and the
students in ≤200-tuple chunks over exactly the eight documented columns — no
account, login, password, invitation, OTP, enrollment, group/course/branch,
payment or access column can be touched. `id` and `tenant_id` are
server-generated/server-selected, and an absent optional value is written as
`NULL`, never `''`, because the legacy `email`/`barcode` unique indexes are
**global** and blank strings would collide.

Failure handling is deliberately conservative: every failure rolls back and
releases exactly once; a **failed rollback destroys** the connection rather than
pooling it; a `commit()` that throws leaves the outcome **unknown**, so the
connection is destroyed and the answer is `500
STUDENT_IMPORT_COMMIT_UNCERTAIN` telling the caller to retry with the **same**
key — an uncertain commit is never turned into a retryable success. `ER_DUP_ENTRY`
rolls back, re-reads the batch record and answers replay or conflict, else a
value-free `409 STUDENT_IMPORT_VALUE_CONFLICT`, because a cross-tenant
global-unique collision must not be attributed. Every `500` body is opaque, and
`Cache-Control: no-store` is set on every outcome.

**Client.** `import-commit.ts` owns the ordered gate, the canonical payload,
strict DTO parsing and a single-flight ticket/latch controller. A local review
decision is never a write authorization. One confirmation mints one opaque key;
an **uncertain** outcome (5xx or transport rejection) keeps the attempt open so
the retry reuses the **same** key and payload, while a changed payload can never
inherit the key and a definite outcome drops the attempt. A key source that is
out of shape or throws is refused as `unavailable`, never weakened. The panel
re-evaluates the gate on **every** render from the live model and the current
confirmed reconciliation, retires the confirmation/result/pending reply on a new
file, a refused file, a close, a reset, a session change and a new
reconciliation, and preserves every accepted control.

## Verification

- server: **146/146** — new 51 + 18, accepted resolution suites 77.
- client: **301/301** — new 102, accepted 199.
- `server/` `tsc --noEmit`: **0 errors**.
- root `tsc --noEmit -p tsconfig.app.json`: **11 pre-existing outside
  diagnostics, 0 in this batch's files** (NotificationBell, StudentHeader_OLD_BACKUP ×2,
  ExamReports ×2, ExamResults, Fees ×2, StudentBarcodes, StudentDashboard,
  versionChecker).

Server coverage added: exact schema and bounds, authority and tenant isolation,
stored exact matches including collation supersets and inactive students,
within-batch duplicates, chunk and query bounds, same-key replay,
different-payload conflict, concurrent attempts, atomic inserts plus audit,
rollback, later-chunk failure discarding staged rows, failed rollback destroying
the connection, uncertain commit, acquisition/query/release failures with opaque
errors and zero writes, globally-unique cross-tenant collisions answered
value-free, tenant-scoped idempotency keys, and the migration shape asserted as a
file only.

Client coverage added: all-clear gate, explicit confirmation, canonical payload,
same-key retry, payload-change retirement, single flight, reversed completion,
file/decision/reconciliation/principal/session/reset/close/dispose fences,
malformed responses, zero storage/logging/automatic network and preservation of
the accepted controls.

Two harness-level fixes were needed and are worth recording: the shared server
harness now stores response headers under **both** the supplied name and its
lowercase form (accepted suites assert `headers['Cache-Control']` while the new
suites read `headers['cache-control']`), and one test type annotation had to use
`ImportCommitRequest["rows"]` because esbuild rejects `T["k"][]`.

## Constraints honoured

No DB, network, browser, service, install, migration application, deploy, Git
write or branch switch. No legacy auth-boundary or m1-expanded suite. All edits
and checks stopped before the MCP report. Pre-existing dirty files
(`src/pages/*`, `docs/streams/client/M2-HANDOFF.md`, the coordination README and
the unrelated dirty `tenant-self.ts`/`api-http.ts` history from earlier batches)
were preserved untouched outside the allowed edits.

## Limits

The migration FILE is not applied and no live database was used, so the real
MySQL execution of the constraints is asserted as a file shape only. Real browser
transport, DOM paint and RTL layout are not exercised. No account, login,
enrollment, access or existing-record identity is created, requested, returned
or stored.

## Open questions for the supervisor

1. `409 STUDENT_IMPORT_VALUE_CONFLICT` deliberately carries **no** row number and
   no field name, because the colliding record may belong to another tenant.
   Confirm that the client's generic `rejected` message is the intended UX for
   it, rather than a row-specific hint.
2. A committed batch re-confirmed with the same canonical payload replays under
   the same key and the controller keeps the attempt open (`canRetry() === true`)
   so the server answers with the recorded replay. Confirm that leaving the
   retry affordance available after a **definite** commit is acceptable, given
   that the button itself is only re-enabled by the gate.

No self-acceptance, no next task, no schedule change.
