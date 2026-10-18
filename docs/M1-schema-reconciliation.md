# M1 schema reconciliation

## Missing core tables

`server/migrations/20261017_02_missing_core_tables.sql` adds guarded, rerunnable table creation for `lectures`, `messages`, `conversations`, `message_status`, `user_online_status`, `message_deletions`, `subscription_plans`, and `tenant_custom_domains`. Contracts were checked against the corresponding tracked route/service SQL, the numeric `insertId` contract in `messages.ts`, and the tracked legacy baseline (`20260920_00_legacy_baseline.sql`) for user identifier types and utf8mb4 collation. No migration was executed.

The messaging tables use numeric `BIGINT UNSIGNED AUTO_INCREMENT` message IDs because both HTTP and Socket create messages using the generated insert ID and reuse it as the status/conversation reference. The message schema includes `is_edited` and `edited_at`, used by both HTTP and Socket edit operations. User IDs remain `CHAR(36)`, matching `users.id` in the legacy baseline. Foreign keys are limited to message references and the tenant domain ownership reference, where the referenced key is present in tracked migrations. No user FKs were added because message recipients may be students represented outside `users`.

Before creating missing tables, the migration checks any existing `messages.id` for the numeric auto-increment contract and any existing message reference columns (`message_status.message_id`, `conversations.last_message_id`, and `message_deletions.message_id`) for `BIGINT UNSIGNED`. An incompatible existing schema deliberately stops at a missing sentinel-table query. This is a fail-closed migration error requiring manual review, not a conversion. Legacy UUID message values have no approved or safe automatic numeric mapping; preserve and reconcile that data through a separately approved migration before applying the new numeric contract.

The server's current tenant boundaries for message delivery are enforced by the authenticated recipient relation checks, not a persisted `tenant_id` column; adding that column would invent a data ownership rule not consumed by the source. Lecture ownership is resolved through the referenced course and instructor. Subscription plans are queried globally by the current router. Domain claims are explicitly tenant-owned and carry `tenant_id`.

`m1-schema-reconciliation.test.ts` scans SQL table references in the core route/service files and checks the eight reconciled core tables for tracked creation DDL. Its explicit coverage set excludes tables owned by existing foundational migrations and unrelated query helpers; it does not claim every dynamic SQL table across the whole application is reconciled.

## Bootstrap ordering blocker

Tracked files do not establish a verified fresh-install replay order. The legacy baseline creates `groups` without `instructor_id`, while `20260928_runtime_schema_replacement.sql` adds it after `20260925_01_student_tenant_enrollment.sql` uses it. Also, `20260924_instructor_video_exchange.sql` alters `lectures` before this later migration creates `lectures`; `20260920_05_instructor_system.sql` also declares foreign keys to `lectures` before a tracked creation file exists. The schema audit records these ordering findings in `docs/agent-reports/schema.md`.

There is no safe apply sequence proven from tracked artifacts alone. Fresh chronological replay is blocked, and repairing it requires a separately approved orchestration change to the migration history/bootstrap plan. This task does not reorder or edit old migrations and does not recommend an unverified workaround. The new migration has not been executed. Existing UUID-keyed `messages` schemas additionally require separately approved data reconciliation; the preflight intentionally aborts rather than rewriting existing IDs.
