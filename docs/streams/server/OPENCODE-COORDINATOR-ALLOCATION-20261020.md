# OpenCode lane — coordinator allocation (Claude) — 2026-10-20

Recorded ownership allocation, not a mailbox claim and not proof of acceptance. Codex corrections: OPENCODE-REVIEW-CORRECTIONS-20261020.md.

## First pass (all STOPPED, no live writer)
| Task | Model | State | Report |
|---|---|---|---|
| T1 gradebook | deepseek-v4.1-flash-free | stopped | OC-T1-GRADEBOOK-20261020.md |
| T2 exam versions | glm-5.3-flash-free | stopped | OC-T2-EXAM-VERSIONS-20261020.md |
| T3 schedules/attendance | longcat-2.5-preview-free | stopped after quota error (hung process terminated by supervisor; last write 00:56 UTC) | OC-T3-SCHEDULE-ATTENDANCE-20261020.md |
| T4 moderation | deepseek-v4.1-flash-free | stopped | OC-T4-MODERATION-20261020.md |
| T5 consent/parent/audit | beam-free | stopped | OC-T5-CONSENT-PARENT-AUDIT-20261020.md |
| T5b corrective (tests) | deepseek-v4.1-flash-free | stopped | same T5 report (updated) |

## Correction pass (this allocation; each file has exactly ONE owner; old workers confirmed stopped before launch)
| Worker | Scope (Codex correction #) | Sole writable files |
|---|---|---|
| T3c | #1 preserve pre-batch response shapes, single header X-Results-Truncated, compatibility regressions for the five lists | server/src/routes/schedules.ts, server/src/services/schedules.ts, server/src/routes/attendance-records.ts, server/src/services/attendance-records.ts, server/tests/m5-schedules.test.ts, server/tests/m5-attendance-records.test.ts, docs/streams/server/OC-T3-SCHEDULE-ATTENDANCE-20261020.md |
| T2c | #2 hold the new staff attempts list and new expiry-on-read unless an existing backlog/lifecycle reference exists; #3 NARROW OWNERSHIP EXPANSION: server/tests/m4-exam-grading.test.ts is allocated exclusively to T2c for fixture/expectation integration only | server/src/routes/exam-versions.ts, server/src/services/exam-snapshots.ts, server/tests/m4-exam-snapshots.test.ts, server/tests/m4-exam-grading.test.ts, docs/streams/server/OC-T2-EXAM-VERSIONS-20261020.md |
| T4c | #5 do not accept the report-status mapping from enum values alone; verify contract, otherwise hold the mapping and dependent assertions; keep tenant-bound evidence and transaction fixes | server/src/routes/moderation.ts, server/src/services/moderation.ts, server/src/services/lesson-discussions.ts, server/tests/m7-moderation.test.ts, server/tests/m6-lesson-discussions.test.ts, docs/streams/server/OC-T4-MODERATION-20261020.md |
| T5c | #4 truncation header must be X-Results-Truncated (new metadata), honest test-first deviation record | server/src/routes/audit-logs.ts, server/src/services/audit-log.ts, server/tests/m7-audit-logs.test.ts, docs/streams/server/OC-T5-CONSENT-PARENT-AUDIT-20261020.md |

T1: no correction requested. T3b and T6 remain HELD. Overlap between old and replacement workers is excluded: every first-pass process was confirmed not running (`ps`) before the correction launch.
