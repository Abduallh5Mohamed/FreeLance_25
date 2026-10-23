# M2-05 accepted after independent source review

Scheduled review e922992e-9b03-4902-8270-ad09ae5d6e3a,2026-10-19.
Accept the five105 paths, original implementation plus stopped recovery task
client-m2-05-profile-correction-recovery-20261019-01. Actual sanitized MCP status
is reported, owner opencode-m2-05-recovery-01, stopped worker054 evidence; native
OpenCode session ID unavailable, none invented. Queue active/ready/blocked empty.

## Source and architecture findings

F1 fixed: profile classifier uses actual server error messages retained by the
unchanged shared request transport. Real transport-to-controller regressions cover
error+discarded code,401,403 teardown and unknown errors failing closed. The page
wires the same tested controller to getMyTenantProfile and session notifications.
Additive API DTO/adapter only; git diff confirms no shared auth/error rewrite.

F2 fixed: entry/completion principal adoption invalidates request generation,
clears cached identity/error/loading and releases the retired latch. Old finally
uses its own ticket, so it cannot release a newer request. Session notification
clears identity before loading; disposal unsubscribes. Reviewed silent success,
silent failure, A-B-A and newer-busy scenarios without adding fake notifications.

The existing dashboard card renders only validated server profile data. Nullable
subject remains optional; status is metadata, not paid access. Existing session
reader/guards reused; no new framework, selector, token store or public route.
Same-principal duplicate reads are suppressed synchronously. Pending promises
are removed on settlement; no added polling loop. This is request/lifecycle
evidence, not measured latency, load capacity or scalability certification.

## Fresh independent validation

Managed local Node22.22.2, no npx/download/install or live services:
- node --import tsx --test src/tests/m2-tenant-profile-ui.test.ts plus unchanged
  C:/Users/BaraaWael/TabwebClientSupervisor/113-m2-05-review-probes.test.ts:
  42/42 pass (38 feature/transport tests +4 independent supervisor probes).
- All15 local src/tests/m1-*.test.ts and m2-*.test.ts bundles through local tsx,
  dot reporter: exit0, no failures. This also exercises legacy registerHooks tests
  under the newer existing Node runtime; worker054's Node22.14 limitation is not
  reproduced here. No claim that worker's aggregate count was independent proof.
- Local TypeScript tsc -p tsconfig.app.json --noEmit: exit1, zero scoped errors,
  same11 outside diagnostics in NotificationBell, StudentHeader_OLD_BACKUP,
  ExamReports, ExamResults, Fees, StudentBarcodes, StudentDashboard, versionChecker.
- All22 earlier accepted checkpoint file hashes unchanged across055/067/074/080/101.

No product edits by Codex. Preserve uncommitted work. DOM/browser accessibility,
live authorization/SQL, provider behavior and load performance remain untested.
No whole-project type-clean or whole-M2 closure claim.

## Next owner/action

Codex records closure/checkpoint and continues remaining-scope coordination.
OpenCode has no ready implementation task after this acceptance; do not reopen
this slice or invent a feature. Next work requires a concrete applicable remaining
contract scope; C1 branches/audit and C2-C12 gaps remain in M2-REMAINING. No external
developer is awaited. Current105 approval does not grant new schema/backend/public
catalog authority. Both15minute schedules continue, no per-batch STOP; OTP deferred.
No worker acknowledgment needed. Remove only this review's matching pending marker.
