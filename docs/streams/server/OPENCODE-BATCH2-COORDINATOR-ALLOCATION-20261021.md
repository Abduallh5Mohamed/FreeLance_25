# OpenCode lane — Batch 2 coordinator allocation (Claude) — 2026-10-21

Recorded allocation, not a mailbox claim, not acceptance. Governing: BATCH2-IMPLEMENTATION-SCOPE-20261021.md and the bridge ownership manifest `handoff/BATCH2-OWNERSHIP-APPROVAL-20261021.json` (status human_approved_code_execution, 51 unique writable paths, 0 conflicts). Owner authorization covers source files and source migrations only; no SQL application, no DB/Docker/network/provider/secrets/installs/Git mutations.

## Order (dependencies respected)
1. NOW, two independent workers: B2-C-SCHEMA and B2-C-LEDGER. They never write each other's files; the contract between them is coordinated by Claude (supervisor): LEDGER writes `docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md` FIRST; SCHEMA designs migration 01 first and derives migration 02 from that contract.
2. AFTER both are stopped, their contract match reviewed (tables/types/keys/units) and any collision raised to Codex: B2-C-PERSISTENCE (single worker).
3. B2-C-INTEGRATION does NOT start on `reported` alone: only after Codex scoped acceptance of SCHEMA/LEDGER/PERSISTENCE outputs. Single owner of index.ts/manifest/wiring.

## Exact ownership (from the manifest; one writer per file incl. tests and reports)
| Worker | Writable paths |
|---|---|
| B2-C-SCHEMA | server/migrations/20261021_01_exam_manual_publication.sql, server/migrations/20261021_02_internal_financial_ledger.sql, docs/contracts/B2-SCHEMA-CONTRACT-20261021.md, server/tests/b2-schema-contract.test.ts, docs/streams/server/B2-C-SCHEMA-20261021.md |
| B2-C-LEDGER | server/src/services/billing-ledger.ts, server/src/services/billing-reservations.ts, server/tests/billing-ledger.test.ts, server/tests/billing-reservations.test.ts, docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md, docs/streams/server/B2-C-LEDGER-20261021.md |
| B2-C-PERSISTENCE (later) | exam-manual-grading-sql.ts, progress-publication-sql.ts, progress-report-source-sql.ts, billing-ledger-sql.ts, their three tests, B2-C-PERSISTENCE report |
| B2-C-INTEGRATION (gated) | server/src/index.ts, server/bootstrap/m1/manifest.json, server/src/services/school-reporting-wiring.ts, server/tests/b2-production-wiring.test.ts, B2-C-INTEGRATION report |

WorkBuddy owns assignments/storage/scan worker, notification outbox/delivery/worker, video usage/lifecycle/reconciliation: not touched. Manifest is NOT owned by SCHEMA or LEDGER.

## Process rules
Hashes before/after per file (all new files at launch: none existed; checked). Mid-task contract review by the supervisor before PERSISTENCE. A quota/5xx stop is recorded (state + writes) and no replacement is launched over a possibly live process (process check first). Focused tests only while writers are active; full regression after both lanes stop, coordinated with Codex.
