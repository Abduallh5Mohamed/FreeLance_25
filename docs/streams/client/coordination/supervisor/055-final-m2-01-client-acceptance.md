# M2-01 approved client batch accepted; schedule stopped

UTC: 2026-10-17T20:46:10Z. Branch `codex/human-client` verified.
Approval provenance remains worker030 / supervisor047, exact seven paths only.
Read handoff, coordination README, new worker034 and actual sanitized result for
`client-m2-01-join-session-recovery-20261017-04`, worker
`wb-m2-01-join-session-recovery-04a`, reported20:41:23.426Z. Report protocol
requires stop; no active/ready/blocked tasks. Native sessionId=null; worker mapping
does not establish a native run ID. No fabricated liveness or replacement worker.

## Decision and independent evidence

**Accept the integrated M2-01 client batch within its documented limits.**
All finite findings in049,051,054 are resolved. Earlier rejected reports remain
historical; their presence alone was not acceptance. Final task state accepted
with evidence and resolution entries in the supervisor review ledger.

Re-ran with installed managed Node22.22.2 and local tsx:

- All eleven client test files: **408/408 pass**, no failures/cancellations/skips.
- Exact selected supervisor054 production probes: **2/2 pass**, including previously
  unreachable deliberate current-principal retry assertions after obsolete submit
  and reset settle. The UI no longer remains busy after silent identity replacement.
- Exact selected supervisor051 identity-preservation probes: **2/2 pass**.
- Supervisor049 invitation/activation mutation-race probes: **2/2 pass**.
- Full frontend tsc: **zero scoped errors**, same **11 outside diagnostics**;
  overall command exits nonzero. This is not a clean whole-repository type check.

Outside errors: NotificationBell.tsx:59; StudentHeader_OLD_BACKUP.tsx:496/510;
ExamReports.tsx:78/82; ExamResults.tsx:104; Fees.tsx:483/497;
StudentBarcodes.tsx:99; StudentDashboard.tsx:127; versionChecker.ts:28.

Reviewed actual production controller/page integration and scoped diffs across
the prior reviews and this submission. Join now owns busy state by operation
ticket, reads current principal at start/completion, retires obsolete busy work
without clearing newer work, and supports deliberate retry without automatic
replay. StudentSpaces preserves replacement identity while retaining own-rotation
failure cleanup/profile-only retry. Tenant activation fences fragment generations.
Forms remain in pages, retained on failure; labels are associated in source.

The production seam is used by all three pages with actual API dependencies and
injected identity readers, rather than copied test orchestration. Server outcomes
remain authoritative: join success is pending review, never inferred admission or
paid entitlement. No new transport/status authority or billing/OTP policy.

## Exact accepted files

- src/pages/JoinInstructor.tsx
- src/pages/TenantInvitation.tsx
- src/pages/StudentSpaces.tsx
- src/features/enrollment/workflows.ts
- src/tests/m2-enrollment-workflows.test.ts
- src/tests/m2-tenant-invitation.test.ts
- docs/streams/client/M2-CONTRACTS.md

M1 checkpoint039 hash comparison: **44/45 files unchanged**; the sole changed file
is StudentSpaces.tsx, explicitly included in this approved M2 batch. Its current
behavior was reviewed and client regression passed. No rollback or Git writes.
Final exact-path hashes saved outside repository in055-m2-01-accepted-checkpoint.json.
Coordination/handoff documentation is supervisory bookkeeping, not product scope.

## Limits and closure

No browser/DOM runtime, real API, DB, provider, deployment or load/scalability test.
Keyboard/label evidence is source-level; unit tests do not prove full accessibility
or end-to-end authorization. Shared transport still throws message-only errors;
classification is presentation, never permission authority. Requests are fenced
on completion, not cancelled by an invented abort contract. Platform-wide M1
isolation gates and missing OTP/payment/domain/catalog contracts remain as recorded
in M2-CONTRACTS; local acceptance does not prove production readiness.

M1 remains closed under039. **M2-01 is complete; whole M2 is not complete.**
No other batch or M3 is authorized; a later batch needs its own concrete proposal
and attributable human approval under18. No follow-up tasks created to fill a queue.

Created supervisor STOP first on completion, then disabled the existing
Tabweb-M1-Codex-Supervisor-15min task. This batch's review schedule has ended;
no claim retired or worker/account schedule rewritten. Remove only this review's
matching pending marker queuedAtUtc2026-10-17T20:45:11.8990726Z. All edits remain
uncommitted and unpublished.
