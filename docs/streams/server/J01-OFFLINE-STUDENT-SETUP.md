# J01 — reviewed same-row offline student setup

BUILD-51, 2026-11-08. This independent owner action follows the owner's direct continuation after the concrete offline-only proposal. It does not change the row-only student-import contract, merge identities or create online accounts. [Evidence and limits](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-51.md).

Mounted in authenticated tenant-self `/catalog`, using its actual getConnection:

| Method | `/api/tenants/me/catalog` suffix | Input / result |
|---|---|---|
| GET | `/offline-setup/students` | optional UUID cursor; `{items:[{id,name}],next_cursor}` |
| GET | `/offline-setup/groups` | optional UUID cursor; `{items:[{id,name,course_id,course_name}],next_cursor}` |
| POST | `/offline-setup/review` | exact student_id/group_id/course_id; fresh names, capacity/active count, effect offline_without_login and SHA256 review_token |
| POST | `/offline-setup/apply` | same IDs plus review_token, operation_id UUID and confirmed:true; historical operation receipt |
| GET | `/offline-setup/operations/:operationId` | `{operation:null}` or exact receipt |

Receipt: `{operation:{operation_id,student_id,group_id,course_id,state:'offline_configured'}}`. No caller-provided tenant/actor/branch/role/status/account fields. Lists fetch26/return25. All responses inside the handler no-store; auth middleware can refuse earlier.

Live tenant owner/user/session proof locks the same connection. Eligible student: tenant-owned, active/current approved enrollment, user/group/branch NULL, instructor NULL or owner, no prior course or completion receipt. Groups: active tenant-wide, branch NULL and active same-tenant course. Defined grade IDs must agree. Live roster scan501, fail closed above500 or at group capacity. Review digest binds current evidence; POST re-proves it before writes. No source-import provenance is inferred.

Same-row update, existing applyOfflineCourseSelection, exact active-course postcondition, recordSealedAuditEvent and operation receipt share one InnoDB transaction. PRIMARY(tenant_id,operation_id), UNIQUE(tenant_id,student_id). Matching request replays its historical receipt; changed request409. Missing/malformed schema or failed audit/receipt fails closed. Unknown COMMIT returns500 PERSISTENCE_UNCERTAIN and destroys connection; no blind retry. Snapshot/activation scripts are demo-only. Other legacy writers' concurrency is outside this verification.

Client uses canonical authenticated transport and strict DTOs; fresh preview plus owner confirmation. An account-scoped sessionStorage marker holds only the four IDs before POST; unavailable storage blocks writes. One pending operation per account/tab across workspaces: return to original workspace for GET recovery. Missing receipt is not cancellation or retry authority. Cleanup failure preserves confirmed receipt and write lock; session/principal/deadline/lifecycle changes fence old replies. No name/review payload or auth token is stored in the marker.

Out of scope: branch setup, account linking/OTP, duplicate merge, online access policy, payments, provider delivery, progress, production/load/mobile or independent human acceptance.
