# WorkBuddy047 proposal review: bounded contract accepted with required amendments

UTC2026-10-19T04:10Z / Cairo07:10. Human says «خلص» after requesting the
WorkBuddy proposal message; worker047 now exists and was read in full. This
confirms proposal delivery, not an unambiguous new backend execution grant.
No implementation task, claim or source edit created by this review.

Accept the narrow design: GET /api/tenants/me/profile, existing server-selected
authority, four explicit DTO keys, no-store, exactly three proposed paths.
Decision047§5: extend existing getOwnedTenant SELECT with subject_type, keep
explicit DTO construction; no second query. Compose actual middleware ordering
hermetically without index import/listening socket. These are proposal review
decisions, not product-code or test acceptance; no new tests were run.

WorkBuddy: amend the proposal in a new worker message before implementation:

1. Pin status matrix to real composed auth. auth.ts supportedRoles excludes
   'owner': a JWT with role owner fails validation401, not404. Test bare role
   authority using a supported role plus missing server membership instead.
   auth.ts resolves an instructor account BEFORE memberships: absent/inactive
   tenant account returns403 TENANT_SUSPENDED. Distinguish this from a live
   account whose selected authority fails at handler404; do not force all
   inactive-tenant cases to404 or change production auth to match a proposal.
   Student missing workspace returns409 at global boundary; a previously issued
   revoked student selection returns401. Keep existing statuses unchanged.
2. Import isolation must be positive evidence: assert exact dependency
   interceptions, forbidden leaf evaluation/calls and default adapter non-use;
   absence of console output alone cannot prove no env read/client creation.
   A sentinel only on injected factory data access does not prove the original
   imports were intercepted. Restore loader/console hooks in finally, including
   failed import; use process-local isolation. No logs of configuration/secrets.
3. No blanket baseline run of server/tests/*.test.ts: earlier inspected suites
   import dotenv/service clients or open HTTP listeners. Inventory/select only
   demonstrably hermetic suites before running; do not execute unsafe suites
   merely to provide a count. Use installed local runner/compiler paths, no
   npx fetching/install fallback. Report unavailable safe broader coverage
   honestly. No baseline/type/test result invented.

Keep defaults: no shared/auth/middleware/schema/package/config edits, no server
startup/DB/provider/network/browser/installs/Git. No admission/payment/OTP policy
change. Preserve accepted039/055/067/074/080 dirty work. This small read endpoint
does not finish C1 or M2. Native WorkBuddy implements only after attributable
applicable backend authorization and fresh exact-path bridge task; no self-claim
or self-approval. Existing continuous observation075 remains enabled.
