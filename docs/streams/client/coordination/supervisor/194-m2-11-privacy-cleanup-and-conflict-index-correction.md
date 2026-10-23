# M2-11 rejected: former-principal export, link cleanup, quadratic group scans

2026-10-21 under human180/192/193. WorkBuddy071 CSV native MCP reported/stopped,
no active queue owner. Actual six-path source/model/report/UI/contracts inspected.
Fresh independent local tsx new resolution+CSV+InstructorStudents suites166/166
pass:43 NEW+123 unchanged (51 CSV+72 enrollment). Worker report incorrectly labels
the unchanged baseline166; do not propagate that count. Frontend tsc11 known
outside diagnostics, ZERO scoped. Historical counts are not fresh acceptance.

Public independent actual-production probe194:0/3 pass,3 concrete failures:
C:/Users/BaraaWael/TabwebClientSupervisor/194-m2-11-independent-probes.test.ts
Only synthetic inputs/injected local download environment, no real browser/network/
DB/student data. Real production component callback and canonical principal reader,
real report/model/CSV parser; no copied business/render logic.

1. StudentImportPreview.tsx downloadReport -> seam.getState() -> report.download:
   render genuine report control under principalA with private local file; silently
   replace canonical principal withB without session event; invoke actual callback.
   Expected NO Blob/URL and cleared private decision/report state. Actual one
   report allocation for A. getState doesn't revalidate principal and callback does
   not observe scope, unlike include/exclude. FIX fresh guarded current-principal
   snapshot BEFORE any report materialization; mismatch clears/retires private
   preview/decisions/report/selection metadata and refuses that action. Preserve
   canonical shared reader and new-file/session fences. No stale-state re-load
   after a mismatch. Do not cache a former-scope report/message.
2. import-report.ts createImportReportController.download: injected link.click()
   throws. Expected created link.remove once and URL revoke once. Actual revoke1,
   remove0. FIX cleanup in structured finally covering create/configure/click/remove/
   schedule failures, at most one revoke attempt per URL. Also make outstanding URL
   retire immediately on file replacement/reset/close/principal/session loss (source
   currently disposes report only on unmount, close/replace only clear decisions).
   Keep future valid downloads possible; don't permanently dispose on ordinary reset.
3. import-resolution.ts computeBlockingConflicts: for1000 pending rows sharing one
   phone group, actual indexed-member probe counts1,000,000 candidate-member reads
   for an EMPTY conflict map. It filters the same whole group per row, not the
   claimed one-pass indexed lookup. FIX included-row index by exact nonempty
   field/value built once per calculation, then bounded per-row key lookups; don't
   repeatedly traverse N-member duplicate groups. Preserve exact trim/case/zeros/
   blanks, overlap chains, included set semantics/actual blocking row references.
   This is measured OPERATION COUNT, not a latency/browser scalability benchmark.

Same-six-path correction client-m2-11-privacy-resource-index-correction-20261021-01,
OpenCode only; predecessor stopped. Preserve accepted170 parser,080 enrollment,
183/185/190 lesson code. No lesson/API/backend/shared-auth/package/config/product
scope expansion. Necessary model/UI/report/tests/contracts only; csv-preview should
remain unchanged unless exact necessary lifecycle integration proves otherwise.
No secret/private claims/app traces/network/browser/install/Git/deploy/OTP/import.

Regress canonical principal swap on real download callback before allocations,
session/close/replacement/error/reset lifecycle and no stale metadata revival;
all native link/URL allocation/config/click/remove/schedule/dispose failures and
exact cleanup; whole-file conflict groups/chains and deterministic operation bound.
Run existing166+new regressions, unchanged public1943/3, frontend tsc known11
outside/zero scoped. No public probe edits/TEMP/debug/source-disable/optional lint/
default server DB/provider/dotenv or model/account retry workaround. Stop ALL edits/
checks before native MCP report and concise unique worker reply. Codex acceptance
required; public194 exact trusted read only, no global permission grant.
