# Post-M2-04 contract preparation: import isolation and authority boundaries

UTC2026-10-18T21:30Z / Cairo2026-10-19. Branch codex/human-client verified.
Read current handoff/remaining/README and governing075/068; newest worker reply
is still046, already reviewed in080. No new worker reply or operator scope
approval. Sanitized dispatch active=[],ready=[],blocked=[]. No liveness or
native run inferred. All19 accepted055/067/074/080 file hashes unchanged.

No tests repeated without changed source; latest independent evidence remains
080:583 client tests+5 supervisor probes, zero scoped types/11 outside. Current
review adds source-only contract preparation, not new runtime/test proof.

Inspected tenant-self production imports and existing server test harnesses for
prepared M2-B01. Factory injection alone does not stop import-time DB/MinIO/
renewal imports. Existing tenant-admin tests import those modules, so copying
that harness unchanged would not satisfy no env/service-client side effects.
Proposed future test must isolate dependency leaves before importing real route
factory and drive real authentication/authority with fixtures. No test was run.

Verified selector middleware actual location is middleware/tenant-authority-boundary.ts;
it rejects spoofed headers and nested query/body selectors with400, outside the
factory itself. Auth billing-only exception currently covers /api/tenants/me;
the proposed limited profile read must preserve current policy, not grant paid
access or invent a new restriction. getOwnedTenant SELECT lacks subject_type,
although existing platform-tenants SELECT confirms the field. Future implementation
must explicitly project it and assess helper callers, never return a whole row.
These points were added to M2-B01-PROPOSAL.md as reviewable preparation.

No backend task approved/queued; no source/tests/config/shared/schema/service edits.
No external developer delivery awaited under076. M2 is incomplete, OTP remains
deferred060. Missing future contracts are narrow scope issues; continued contract
coordination is authorized, so no all-progress STOP is asserted. Continuous075
timer stays enabled; no arbitrary client task or acknowledgment request to fill
the empty queue. Clear only own21:30:11.7420540Z review marker after timer check.
