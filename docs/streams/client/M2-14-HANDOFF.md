# M2-14: private server reconciliation for student CSV preview

Human direct continuation delegates this larger coherent NEW M2 task to WorkBuddy
through the manual copy/paste procedure. Accepted M2-08/11 provides bounded local
CSV preview, decisions and a JSON report, but cannot check stored tenant records.
This batch adds a **read-only reconciliation** step. It creates no student, user,
enrollment, invitation, password, OTP, audit write or import commit.

Before: local duplicate decisions say nothing about existing records. After: the
owner explicitly submits current included rows to a bounded tenant-private endpoint
and receives row-number/matched-field decisions without another student's identity
or data. The UI states that nothing was imported or granted access.

Task: `client-m2-14-student-import-server-reconciliation-20261021-01`.

## Exact eleven allowed paths

1. `server/src/routes/student-import-resolution.ts`
2. `server/src/routes/tenant-self.ts` — additive mount only
3. `server/tests/helpers/m2-student-import-resolution-harness.ts`
4. `server/tests/m2-student-import-resolution.test.ts`
5. `server/tests/m2-student-import-resolution-failures.test.ts`
6. `src/features/students/StudentImportPreview.tsx` — additive UI only
7. `src/features/students/server-resolution.ts`
8. `src/lib/api-http.ts` — additive DTO/adapter only
9. `src/tests/m2-student-import-server-resolution.test.ts`
10. `docs/streams/server/M2-B08-CONTRACT.md`
11. `docs/streams/client/M2-14-CONTRACTS.md`

OpenCode owns the six M2-13 correction paths in supervisor207. Never edit academic
period paths. Preserve all accepted CSV parsing/decision/report behavior.

## Server contract

Add owner-only selected-active-tenant endpoint
`POST /api/tenants/me/student-import/resolve`. POST carries a private bounded
candidate set but performs reads only. `Cache-Control: no-store`; same verified
active owner and local billing-only denial as accepted tenant-self children before
connection; no tenant selector.

Exact request `{ rows }`, no extra keys. `rows` has 1..1000 exact objects
`{ row_number, email, phone, barcode }`; unique integer row number 2..1001;
string values already trimmed, each <=4096 characters; blank means absent and at
least one key must be nonblank. Enforce explicit total body/serialized bounds before
expensive work. Reject malformed keys/types/bounds/duplicate row numbers with the
documented 400 response.

Query only active students of the selected tenant. Match exact nonempty text for
email/phone/barcode. Do not normalize, casefold, merge, link accounts or establish
new uniqueness policy. SQL collation may return a superset, so confirm exact string
equality in application code. Use bounded deduplicated key sets and chunked
parameterized queries: no N+1 and no quadratic scan. Select only match fields;
never return existing names, contact values, user/student IDs or other private data.

Exact response `{ rows, summary }`; one ordered result per request row:
`{ row_number, matched_fields }`, deterministic subset order email, phone, barcode.
Summary exact `{ checked, matched, clear }`. Multiple records may match different
fields without claiming a canonical identity. No mutation SQL, transaction, audit
or side effect. Inject DB; handle acquisition/query/release safely, release exactly
once and never fabricate clear results after failure.

## Client contract

`server-resolution.ts` owns exact DTO/parser/controller behavior. Only current
locally included valid rows are sent after explicit click. Never send pending,
excluded, invalid, name, guardian or grade text. Preserve physical row numbers.
No automatic call on file/decision changes.

Show per-row matched-field warnings and checked/matched/clear counts as existing-
record reconciliation only, never identity proof/import success/overwrite approval.
Any decision/file/principal/session/close/reset/dispose change clears results and
retires pending replies. Reversed success/error and silent/event principal changes
cannot restore private results or release a newer busy latch. One request in flight;
explicit retry; malformed 2xx is truthful malformed state. No persistence/logging
of private contents. API adapter additive only; no shared auth/request/error edits.

No account creation, commit, password/OTP, enrollment, group/branch/course assignment,
XLSX, migration, notifications, billing or financial rule.

## Tests and done

Use real production route factory/mount/auth with injected DB positively isolated
from default DB/provider/dotenv. Cover owner/tenant/billing/session isolation,
schema/bounds, duplicate rows, exact case/leading zeros, collation-superset filter,
overlapping matches/order/counts, chunk bounds/no N+1, acquisition/query/release
failures and zero mutation queries.

Client tests drive production DTO/parser/controller/component callbacks: included
rows only, physical numbers, response exactness/order/bounds, malformed 2xx, retry,
decision/file/principal/reset/dispose and reversed completion fences, latch ownership,
zero persistence/automatic calls. Run new suites plus accepted M2-08/M2-11 CSV,
nearby safe tenant server suites and scoped TypeScript. No live DB/network/browser/
services/default adapters/install/npx/Git/deploy/migration application/TEMP/lint.

Done is bounded read-only reconciliation only. XLSX, audited/idempotent bulk commit,
accounts/OTP/enrollment and whole C12/M2 remain open. Stop all edits/checks before
MCP report plus concise unique worker report; no self-acceptance/next task/timer.
