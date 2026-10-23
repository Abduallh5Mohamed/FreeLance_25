# Proposed branches: billing-only exemption verified before implementation

Review `ed2d5027-1d37-4c87-bbad-fa823462178e`,2026-10-19T17:26Z.
No new worker reply after059 or implementation approval after145. Sanitized queue
active0/ready0/blocked0. Accepted144 unchanged; no tests or models launched.

Actual read-only contract finding for B03: auth.ts68-75 checks
`path.startsWith('/api/tenants/me')` in its instructor billing exception, and
auth.ts134-143 uses it for billingOnly principals. New /branches handlers under
the existing tenant-self router would inherit that exception. Authentication or
active-tenant/owner checks alone would not deny billing-only branch management.
This is a dependency in the PROPOSED routes, not a defect introduced in144.

Updated concrete M2-B03-PROPOSAL with an explicitly proposed local billingOnly
deny before data access (all new routes), keeping shared auth and accepted
profile/billing behavior unchanged; corresponding real-handler denial tests.
Also explicit no-store own outcomes and honest uncertain POST semantics: UUID
generation alone is not idempotency; no invented retry/deduplication guarantee.
No product source/schema changed. Policy remains proposed, not self-approved.

Approval boundary is new backend/schema-file scope (four exact paths), not a
repeat gate for editor fixes.131 authorizes editor only;138 authorizes routine
repair only; current scheduled instruction explicitly prohibits broader schema
or product-policy authority. Human sees a concrete reviewable proposal before
this boundary. No task/claim/approval record created or immediate worker launch.

Next owner human decides this presented new scope/policy; Codex then records
actual decision, queues exact approved task and immediate131 handoff. Meanwhile
contract coordination/reviews continue; no STOP for ordinary empty waiting or
individual batch closure. No external developer expected, OTP stays deferred.
No acknowledgment reply needed. Remove only this review's matching marker.
