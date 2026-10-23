# B05 not accepted: UUID identity normalization in atomic reorder

2026-10-21 review under human180. WorkBuddy068 and MCP report confirm edits/checks
stopped; no active bridge owner. Native OpenCode prior correction finished exit0.
Independent safe suites238/238 and server tsc0 pass, but independent public182
probe1/3 passes. No live DB/network/provider; actual injected production handler.

File/function: server/src/routes/course-lessons.ts parseReorderItems and reorder
currentById lookup. Declared migration uses utf8mb4_unicode_ci case-insensitive
CHAR(36) identity; UUID_PATTERN accepts uppercase. A valid uppercase lesson UUID
matches a lowercase stored row in SQL, but currentById.get(item.id) misses because
JavaScript map keys are case-sensitive. Actual500; expected200 canonical DTO.
Case variants of ONE UUID evade the duplicate Set, reach connection/locks and
return404 from count mismatch; expected400 before connection for duplicate ids.

Exact fix: use one normalized UUID identity throughout batch parse/dedup, sorting,
bindings and locked-row map lookup (lowercase valid UUIDs); preserve stored DTO
identity and all owner/course/unit scope proof, strict limits, no-op/audit/atomic
transaction, precommit epoch formatting and release/destroy semantics. Do not
rewrite the router or shared auth. Regress uppercase/mixed-case selection,
case-variant duplicate before acquisition, mixed unknown/foreign selections,
canonical DTO ordering and existing transaction failures.

Public immutable probe:
C:/Users/BaraaWael/TabwebClientSupervisor/182-m2-b05-uuid-probes.test.ts
It simulates declared SQL case-insensitive matching, not physical MySQL; lowercase
control200, uppercase500, case-variant duplicate404 reproduced independently.
Exact trusted read grant in opencode.json only, supervisor edits remain denied.

OpenCode correction task client-m2-b05-uuid-correction-20261021-01: same seven B05
paths, role explicitly grants server ownership despite older frontend-only text.
Modify only necessary router/tests/harness/contract lines, preserve tenant-self
additive-only mount and migration FILE. Rerun both new suites+unchanged164 safe
suites, unchanged public182 probe, server tsc. No legacy default DB/dotenv suites,
TEMP reconstruction, optional lint, live services or schema application.

Review found bounded GET limit+1, max100 batch, parent/owner locks before writes,
per-changed-row bounded update+audit and one readback, uncertain commit discard.
No measured latency/scalability/real locking claim. Preserved tenant-self176
baseline byte-for-byte after in-memory removal of additive lesson import/mount.
Next WorkBuddy UI work is disjoint and uses the fixed existing contract; B05
backend remains provisional until this correction is independently accepted.
