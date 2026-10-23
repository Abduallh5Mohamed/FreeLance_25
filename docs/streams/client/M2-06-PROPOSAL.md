# M2-06 proposal: institution-name editor on existing dashboard

Approved for bounded implementation under direct human continuation131,
2026-10-19. Exact five paths and server-owned policy below govern. Earlier
proposal-only wording is historical for this slice, not later features.

Prepared2026-10-19; proposal only, NOT approved/queued. Depends on accepted121
profile card and accepted129 owner-only PATCH. No new route/screen/backend/schema.

## Goal and before/after

The instructor dashboard displays the selected institution's server-confirmed
name but cannot submit the accepted rename operation. Add a small name form to
that existing card, with label, cancel/save, busy/error states and keyboard access.
Save sends only business_name through the canonical request transport to
PATCH /tenants/me/profile. The returned validated minimal DTO updates the card
only after confirmed success; no optimistic success or paid-access inference.
Trim and validate1..255 exactly as the accepted backend; preserve input on failure.

Profile DTO intentionally has no owner/capability field. Do not infer write authority
from local role or institution status or add a fake owner flag. Recommended UI:
label the action as institution-owner-only; an attempted request remains subject to
the server's actual owner check. A reader may receive the existing404 denial;
present that truthfully as rename not authorized/unavailable, without claiming
the existing read-authorized institution vanished or exposing ownership details.
This UI presentation is proposed here, not an existing approved behavior.

## Proposed exact five paths

- src/pages/InstructorDashboard.tsx: small form on current card, labels/statuses.
- src/features/tenant/profile.ts: extend existing injected controller with the
  bounded edit lifecycle; preserve accepted read/session behavior.
- src/lib/api-http.ts: additive updateMyTenantProfile adapter/request only;
  existing request/auth/error handling and read DTO unchanged.
- src/tests/m2-tenant-profile-edit.test.ts: isolated actual production behavior.
- docs/streams/client/M2-06-CONTRACTS.md: behavior, transport limits and evidence.

Read necessary nonsecret existing source/tests/contracts. Do not edit accepted121
tests to fit new behavior; run them unchanged. No shared request/auth/session
events/router/backend/player/schema/migration/package/config/provider/DB/network/
browser/live services/install/Git/deploy or branding/branches/OTP/checkout scope.
M2-05-CONTRACTS remains historical accepted read-only scope, not rewritten history.

## Required lifecycle and authority behavior

Synchronous single-flight before awaiting/re-render; no duplicate PATCH on double
save. Draft/form/request lifetimes prevent late success/error/finally from mutating
a canceled/reopened form, newer edit, switched principal or disposed controller.
Session/logout clears private draft/profile. Fence competing GET and PATCH so an
old read cannot overwrite a newly confirmed name or revive an old institution.
Only the current canonical principal/selected-profile identity may commit.

Use actual documented transported error messages; never fabricate HTTP status
or rely on discarded code fields. Failed/malformed/uncertain replies never show
success. Commit acknowledgement/network failure may have persisted server-side:
do not automatically repeat PATCH. Offer a deliberate read of current profile to
reconcile, preserving the draft and warning that the previous change was not
confirmed. A matching subsequent GET is current state, not proof of that write's
history/audit. New save remains an explicit user action; identical backend retry
is a no-op under129. No mandatory extra GET on a validated successful PATCH.

## Tests, impact and completion

Hermetic real adapter+controller tests: exact PATCH path/canonical bearer/name-only
body/no tenant selectors; valid DTO; owner-like success and actual server denial;
401/403 teardown; malformed/500/network reply; failed draft retention and deliberate
read reconciliation without duplicate writes; invalid name; duplicate/cancel/reopen;
reverse GET/PATCH completion, principal A-B-A/silent change/dispose/old-finally.
Use fake local transport only, no copied implementation or actual credentials.
Run unchanged38 read tests and relevant local client regressions; frontend tsc
before/after, zero scoped errors with known11 outside distinguished.
Review actual request counts/cleanup; no DOM/live/load/latency claims without proof.

Impact: only accepted name-write+audit through existing server contract, no new
data collection/table/service/payment. Done after Codex source/architecture/API/
test/type review, truthful contract and stopped MCP report. Same-scope verified
correction loop only after applicable human execution authority; no self-approval.
This does not close branches/C1/M2; OTP remains deferred.
