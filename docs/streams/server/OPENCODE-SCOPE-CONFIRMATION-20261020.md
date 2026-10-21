# Codex scope confirmation — Claude/OpenCode lane — 2026-10-20

Basis: owner requested a split execution plan with Claude supervising OpenCode and Codex supervising WorkBuddy. This addendum narrows OPENCODE-EXECUTION-PLAN-20261020.md; it does not accept its findings or any milestone. Source spot-check confirms gradebook omits policy categories in its calculation call and unsubscribe consumes jti before consent writes. Other findings must still be reproduced independently before repair.

## Ownership and launch

Claude may launch T1–T5 with exactly the writable file lists in the plan, including each task's own report. No two workers own the same file. T5 owns all three of its related domains and runs their edits sequentially internally; split it only into strictly disjoint file groups. Maximum concurrency is the actual available model capacity, not the number of planned tasks. Existing dirty edits must be retained; capture full file hashes before and after.

This is a recorded ownership allocation, NOT a mailbox claim or proof an agent was launched. Claude reports worker identities and current state. WorkBuddy must not write these files or claim this lane. Codex checks this ownership manifest before assigning further WorkBuddy changes. Any conflict with an already-live external writer stops the affected task until coordinated.

## Scope corrections — mandatory

### T1 gradebook

Authorize relation/tenant/branch checks and deterministic calculation/export of already-defined valid nonempty category weights. Do not invent a canonical course enrollment relation. Verify the existing authoritative contract; if conflicting, report the affected authorization/roster subpart blocked. Do not choose empty-category normalization, extra-credit behavior, score caps or rounding policy. Preserve existing supported behavior outside the reproduced defect; isolate and report ambiguous cases. New roster endpoint only if the current approved backlog explicitly specifies it and its authority is established; no new shared mount required.

### T2 exam versions

Authorize server-verified existing course/exam authority, tenant/branch boundary checks, and preserving terminal expiry/auto-submission state through regrade. Do not select draft-vs-submitted precedence, retake policy, result release rules, archived-question policy, legacy retirement or manual-grading schema. Staff listing only where specified by the existing backlog and established authority. No background expiry-on-read writes without showing the existing lifecycle contract requires them and proving audit/transaction behavior.

### T3 schedules/attendance

Authorize validated bounded time filters, deterministic pagination and explicit truncation, plus correction metadata consistency. Preserve legitimate history access with explicit ranges; do not silently redefine every feed as future-only. No new arbitrary duration/page policy if a contract already defines it. Cancelled-session correction rules and clearing/replacing public reason must follow an existing explicit contract; otherwise hold those subparts. Do not change who may create schedules or mark attendance, legacy source of truth, overlap rules or visibility of private reasons.

### T4 moderation

Authorize tenant-bound evidence queries and atomic report/case consistency only using existing legal state transitions and schema values. Do not invent a reviewed/dismissed mapping. Restore semantics and retention/purge remain held; preserve current behavior and report the gap rather than introducing a new blanket 409 without an established contract. Evidence mutation and decision audit must share the actual transaction.

### T5 consent, parent links, audit

Authorize unsubscribe token consumption plus consent writes in one real transaction, preserving the existing signed token's defined tenant/global semantics; do not guess missing tenant from request/client input or silently narrow a global unsubscribe. Successful replay is idempotent; failed writes must not falsely consume the token. Preserve existing consent source of truth. Add parent-link audits using existing transaction-aware audit infrastructure; no secrets, OTP, phone or contact values in audit. Audit failure behavior must preserve domain atomicity. Do not change parent provisioning, who can request links, invalidation rules, notification producers/outbox or external delivery. Expose audit export truncation explicitly with compatible headers/metadata and accurate export audit; preserve chain hashing and established readers. If shared audit helpers are required, stop that subpart and report proposed scope.

## Held work

T3b and T6 remain HELD. Assignments source is not released to this lane. All listed product decisions D*/G-D* remain undecided unless an explicit existing approved contract resolves one; cite it instead of selecting a 'least-surprising' default. Absence of a decision does not block independent repairs above.

## Validation and integration

Each worker reproduces a verified defect with a failing test before its repair, runs focused hermetic tests, reviews its own diff and reports actual results/limitations. No assertion weakening, unrelated cleanup, dependency changes or fabricated live evidence. Report typecheck observations as provisional while other writers are active.

No shared index/auth/db/helper, schema/migrations/manifest, frontend, bridge controls, provider, database, Docker/native mysqld/listener, secrets or Git writes/merge/push/deploy authorization. No native model retries or replacement over a possibly-live worker after quota failure.

Claude reviews all five diffs. Full regression runs only after both lanes confirm all writers stopped; coordinate that snapshot with Codex, recording source hashes and actual counts. Reports are not phase acceptance. Follow-up scopes require explicit coordination.
