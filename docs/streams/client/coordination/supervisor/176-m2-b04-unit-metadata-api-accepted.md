# M2-B04 private unit metadata API accepted; migration FILE only

Review `ea3a64d3-3ae8-4c25-a72e-1299e114817e`,2026-10-20. Consume worker066:
correction `opencode-worker-b04-utc-20261020` reported/stopped, runtime exited0
at21:21:19Z, native `ses_eaa01b16cffeAlifQIjyTEgUXH`. No active/ready/CLI.

Independent164 positively isolated route/composition tests pass (69 units+95
unchanged profile/read/update/branches), unchanged public173 probe4/4 passes
(real installed driver self-test plus real GET/POST/PATCH handlers). Server tsc0.
Actual SQL now projects epoch seconds on list/current/read-back; validated seven-
field DTO is materialized inside transaction before commit, invalid epoch fails
without fake/null dates or committed malformed success. No shared timezone/config
change. Tests cover DST/offset fixtures, invalid projection cleanup, both write
paths/noop and mutable-order pagination examples. Per-request order is deterministic;
cross-request snapshot/stable-once guarantee under reorders is correctly disclaimed.

Architecture/authority review: isolated injected unit router with additive mount
after existing auth; verified selected-tenant owner before course visibility,
active course scoped to derived tenant, course and unit write locks, fixed DTO,
bounded keyset(index course_id,display_order,id;limit+1<=101), atomic audit/noop,
failed begin/rollback/uncertain commit disposal. No teacher/student/public/payment
authority. Read snapshot semantics do not claim runtime concurrency verification.

Tenant-self matches173 byte-for-byte; read-only in-memory removal of the additive
import/mount restores EXACT151 accepted hash. No file reconstruction/source mutation
probe was run. All accepted170 CSV/164 branch UI hashes match. Other new schema/
router/tests/contracts hashes recorded externally and in ledger. New migration
creates course-derived unit table only; no ALTER/backfill/runtime DDL/application.
Physical FK/collation compatibility, actual MySQL time/concurrency/query plans and
real HTTP/browser behavior remain untested. No latency/scalability claim.

Accepted exact five-path API/schema FILE slice under human152, not deployed/runtime
rollout, whole C5 or M2. OTP deferred060. Next delegated M2-09 uses this accepted
contract in existing course-details UI, exact six paths in M2-09-HANDOFF. No worker
acknowledgment/per-batch STOP; supervisor10min continues, worker timer disabled.
