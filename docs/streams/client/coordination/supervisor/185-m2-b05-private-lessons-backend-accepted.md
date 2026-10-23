# B05 private lesson backend and182 correction accepted

2026-10-21 under human180, scheduled review cc34e46f-4fd8-4366-b507-d9db5b8c55f9.
Consumed WorkBuddy068 original and OpenCode069 correction. Sanitized MCP correction
reported; native session ses_ea4b11e2cffeErppZ8txhIZQk1 finished exit0 at22:06:53Z.
No active backend owner; stable actual source/contracts/harness/tests inspected.

Fresh independent safe command from server: local tsx --test course-lessons,
course-lessons-reorder, tenant-profile, tenant-profile-update, tenant-branches,
course-units plus unchanged public182 probe:248/248 pass (81 new lesson tests,
164 unchanged accepted tests,3 independent probes). Server local tsc --noEmit
-p tsconfig.json exit0. No default DB/provider/dotenv/index/listener startup.

Actual fix: parseReorderItems canonicalizes valid UUIDs BEFORE duplicate detection,
sorting and SQL binds; locked-row map uses same identity, missing mapping returns
404 before writes. UPDATE/audit/DTO retain stored identity. Independent uppercase
request now200, case-variant duplicate400 before acquisition, lowercase control200
with exactly one commit/release. New suite regressions cover mixed-case/foreign/
unknown/stored-mixed-case identities. No physical MySQL collation claim.

Correction hashes: tenant-self additive mount, migration FILE and original CRUD
suite match184 pre-correction checkpoint exactly. Only router/harness/reorder tests/
contract changed. Original184 review proved176 tenant-self preserved byte-for-byte
after in-memory removal of the additive lesson import/mount. Accepted183 frontend
preserved; WorkBuddy new UI paths remain separately owned/reserved.

Accept full bounded B05 private lesson metadata GET/create/update/status/order and
atomic selected batch reorder+audit surface, including182 correction. Actual
verified selected-tenant owner and active course/parent unit/lesson scope proofs,
strict payload, no-store, epoch DTO before commit and transaction disposal reviewed.
GET default25/max100 with limit+1; reorder1..100 unique identities, all ids proven
before updates, bounded per-changed-row update+audit and one selected readback;
no-op no audit, uncertain commit destroys connection without retry/rollback claim.
No polling/drain/unbounded hierarchy load. No measured latency/scalability claim.

Migration FILE accepted only, NEVER applied. Synthetic transaction replay and
real handler/composition assertions do not prove physical row locks/isolation,
FK/ENUM/CHECK enforcement, runtime schema compatibility, HTTP/browser integration
or rollout. C5/M2 remains open; OTP deferred060. No new access/publish/student/
financial/provider policy. No per-batch STOP or worker timer.

Next owner: WorkBuddy M2-10 consumes accepted185 contract in its existing six
frontend paths; Codex reviews actual stopped UI submission. OpenCode idle, no new
correction invented and no model run when correction queue empty.
