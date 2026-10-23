# Remaining C1 contract boundary after M2-05

Review c6f8c042-a46c-4dc5-b3b2-8633e939aa1f,2026-10-19. No submission newer
than worker054; dispatch active/ready/blocked empty. Five accepted121 hashes
unchanged: no tests rerun or reopening, no worker acknowledgment requested.

Source: docs/17-full-feature-backlog.md:27 requires tenant-owned, audited
institution metadata/branch relation/status. tenant-self.ts:119 accepted101
provides a read-only selected profile; accepted121 adds its dashboard card.
Neither supplies branch management or institution edits/audit. api-http admin
instructor billing/audit fields are not a selected-institution branch contract.
Search server/src *.ts/*.sql for tenant_branches, CREATE TABLE.*branches and
branch_id returned no match; this does not prove absence in all migrations or
external systems. M2-REMAINING C1 row now distinguishes accepted profile from gaps.

Next owner Codex: prepare a C1 contract proposal grounded in S1/S3/persistence
evidence: branch tenant ownership, read/write roles, relation/status semantics,
audit atomicity and exact files/schema impact. These are requirements to resolve,
not invented schema/DTO/policy or authority to implement. Current096/105 permits
neither broader backend/schema changes nor treating admin billing authority as
branch access. OpenCode waits for a concrete approved ready task; no external
developer awaited, no work manufactured to fill an empty queue.

Both timers Ready: next worker16:18:58, supervisor16:26:08 Cairo at inspection.
No per-batch STOP. Whole M2 remains incomplete, OTP deferred. Remove only this
review's matching pending marker. This review changed coordination only.
