# Supervisor 225: M2-16 transactional authority rejection

WorkBuddy078 reported/stopped M2-16. Independent verification passed the real
safe server 146/146 and client 301/301 suites, with server TypeScript at zero
errors. Those results do not override the source-level contract defect below.

In `server/src/routes/student-import-resolution.ts`, `POST /commit` acquires the
connection and executes the owner/tenant/caller authority SELECT before calling
`beginTransaction()`. Actual order is owner read, BEGIN, idempotency lock,
existing-value reads and writes. The approved M2-16 policy and M2-B09 contract
require the authority revalidation inside the same transaction as the writes.
The current gap permits owner/status/caller activity to change after the read
but before the transaction begins.

OpenCode correction task
`client-m2-16-transactional-authority-correction-20261022-01` is bounded to four
paths: the route, both commit test files and the server contract. Expected order
is BEGIN before the owner SELECT, with denied authority rolling back and
releasing once with zero writes. Preserve all request-before-connection checks,
idempotency, privacy, bounds, cleanup and uncertain-commit behavior. Run both
M2-16 server suites, unchanged M2-B08 resolution suites and server types, then
stop/report for independent review.

The direct OpenCode helper was invoked once. Native process metadata appeared
and the exact correction was then claimed by `opencode-session-native-m2-16` at
01:22 Cairo. This proves ownership/start, not completion; preserve this owner.
