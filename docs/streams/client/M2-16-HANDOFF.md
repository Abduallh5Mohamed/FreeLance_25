# M2-16: audited idempotent student-row import

Human direct continuation approves the bounded policy proposed in M2-16-PROPOSAL:
student-row-only creation, hard refusal of existing-value matches, atomic batch
behavior, and an idempotency/audit migration FILE that must not be applied.

Task: `client-m2-16-audited-idempotent-student-import-20261021-01`.

## Before / after

Before: accepted M2-08/11/14/15 parses and reviews a CSV and reconciles existing
values, but cannot persist anything. After: the verified tenant owner explicitly
confirms one bounded, freshly reconciled all-clear batch; the server revalidates
it and atomically creates tenant student rows plus a sanitized import audit record.
Repeating the same idempotency key and canonical payload returns the recorded
result without another insert. Nothing creates accounts, access or enrollment.

## Exact 13 allowed paths

1. `server/migrations/20261021_04_student_import_batches.sql`
2. `server/src/routes/student-import-resolution.ts`
3. `server/src/routes/tenant-self.ts` — additive dependency/mount wiring only
4. `server/tests/helpers/m2-student-import-resolution-harness.ts`
5. `server/tests/m2-student-import-commit.test.ts`
6. `server/tests/m2-student-import-commit-failures.test.ts`
7. `src/features/students/StudentImportPreview.tsx`
8. `src/features/students/import-commit.ts`
9. `src/lib/api-http.ts` — additive DTO/adapter only
10. `src/tests/m2-student-import-commit.test.ts`
11. `docs/streams/server/M2-B09-CONTRACT.md`
12. `docs/streams/client/M2-16-CONTRACTS.md`
13. `docs/streams/client/M2-16-PROPOSAL.md` — update status/decision record only

No other route, auth, shared middleware, provider, package or configuration file.
Do not apply the migration or use a live DB/network/browser/service.

## Required server behavior

Add an owner-only selected-active-tenant commit endpoint beside the accepted
read-only resolution route. Accept 1..1000 exact canonical row objects with physical
row number, name, email, phone, guardian phone, grade and barcode plus an opaque
bounded idempotency key. Reject unknown keys, untrimmed/over-bound values, repeated
row numbers, repeated nonblank email/phone/barcode within the batch and empty
required name. Preserve leading zeros and case; do not normalize or casefold.

Before mutation, verify active owner/tenant authority and billing-only denial using
the accepted tenant-self boundary. Inside one transaction re-check every nonblank
email/phone/barcode against active students of this tenant using bounded deduplicated
chunked reads and application-level exact equality. Any match rejects the WHOLE
batch with row numbers and matched field names only; never return stored values,
IDs or identities. No overwrite, merge, keep exception or partial success.

The migration FILE defines a tenant-scoped import-batch/idempotency record with a
canonical payload digest, final sanitized result and audit metadata. Same tenant,
same key and same digest returns the prior result without student inserts; same key
with a different digest is `409`. Concurrent same-key attempts serialize safely.
Insert only student rows: generate IDs server-side; tenant_id selected by server;
no user_id/account/password, invitation, OTP, enrollment, group/course/branch,
payment or access. Store permitted CSV fields and safe existing defaults only.
Students plus the one sanitized batch/audit record commit atomically. Roll back and
discard/release safely on every failure; never expose SQL/internal details or turn
an uncertain commit into retryable success.

Response is exact, deterministic and bounded: batch identifier/idempotency replay
flag, created count and submitted physical row numbers only. No created student
IDs or private values. Set no-store. The injected router seam must enable hermetic
tests and stay positively isolated from default DB/provider/dotenv.

## Required client behavior

`import-commit.ts` owns strict DTO parsing and a single-flight controller. The real
component enables confirmation only after the current decisions have no pending or
invalid rows and a fresh reconciliation for the exact current included set reports
every row clear. Any file/decision/reconciliation/principal/session/reset/close or
dispose change retires confirmation, result and pending replies. Reversed outcomes
cannot restore them or release a newer latch.

One explicit confirmation creates one idempotency key for that canonical batch;
retry of an uncertain transport outcome reuses the same key and exact payload.
Changing payload creates a new attempt/key. Never persist private CSV contents or
log them. UI states clearly that this creates tenant student records only and does
not create login, enrollment or access. No automatic request/download and no fake
success. Preserve accepted preview, decision, report, reconciliation and review UI.

## Tests and completion

Server tests must drive the production route/mount with injected DB and cover exact
schema/bounds, authority/tenant isolation, within-batch duplicates, stored exact
matches including collation supersets, chunk/query bounds, same-key replay,
different-payload conflict, concurrent attempts, atomic inserts+audit, rollback,
commit uncertainty, acquisition/query/release failures and zero account/enrollment/
payment writes. Assert migration shape as a file only; never apply it.

Client tests drive production controller/component callbacks: all-clear gate,
explicit confirmation, canonical payload, same-key retry, payload-change retirement,
single flight, reversed completion, file/decision/reconciliation/principal/session/
reset/close/dispose fences, malformed responses, zero storage/logging/automatic
network and preservation of accepted controls. Run only new suites plus directly
affected accepted student-import suites and scoped types; disclose known outside
diagnostics. No legacy auth-boundary/m1-expanded suite, live DB/network/browser,
install, Git or deploy.

Done means this exact atomic student-row import only. No accounts, login, OTP,
enrollment, assignments, XLSX, migration application or whole C12/M2 claim. Stop
all edits/checks before MCP report and a concise unique worker Markdown. WorkBuddy
does not self-accept or start another task.
