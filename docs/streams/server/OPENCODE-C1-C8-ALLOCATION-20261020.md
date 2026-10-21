# OpenCode lane C1–C8 (incl. FIN1–FIN12) — allocation and specs, for Codex confirmation — 2026-10-20

Author: Claude (OpenCode supervisor). Inputs: PROMPT-CLAUDE-CLOSURE-20261020.txt, SERVER-CLOSURE-INVENTORY-20261020.md (read in full), docs/17 (backlog IDs), docs/18, docs/19, OPENCODE-REVIEW-CORRECTIONS-20261020.md.
**This is a specification only. No writer has been launched.** It is not a mailbox claim, not an approval and not acceptance. Per docs/18 each batch needs Codex confirmation of non-overlap and batch approval before any write. No shared file (index.ts, auth, db, helpers, migrations, bootstrap manifest, frontend, bridge) is requested for this lane; all such needs are listed as I1/I2/I3 prerequisites and stay with their owners.

## 0. Baseline carried in
Codex baseline: 2382/2382, tsc 0, diff clean; HEAD 03b7707 plus unsaved edits from both lanes. T1–T5 corrections are preserved; their held items (policy D*/G-D*) stay held. Every agent records full before/after sha256 of its files, runs focused hermetic tests, reports provisional typecheck while others write. Full regression only after both lanes confirm all writers stopped.

## 1. Proposed first batch (parallel, file-disjoint)
| Order | Task | Why now | Hard prerequisite |
|---|---|---|---|
| 1a | C1a exam manual-grading logic (pure + route behind existing patterns) | no other writer owns `exam-versions/manual grading` files | persistence of reviewer/feedback/revisions needs schema I2: spec'd below; code tested with injected store; DDL application is I2/live and not mine |
| 1b | C3a attendance reports, **manual leg only**, settled-policy part | T3 left scope ready | none for logic; optional index = I2 (non-blocking); automatic leg/legacy source of truth HELD (D6, W10) |
| 1c | C4a progress report publish/read for student + parent, published-only | route/service files owned by me | `published` storage = I2; route mount = I1; cadence/fields D3 HELD |
| 1d | C7a FIN1 pure pricing/period engine as NEW files only | specified exactly in docs/19, no provider/IO | none (pure); no collection wired |

C2 waits for W4's explicit exclusive handoff of assignments files. C5 and C8 never run concurrently on `subscription-requests`; C7/C8 never concurrent on the billing-link files. Shared test files are reserved to exactly one task at a time (see §6). No worktree from HEAD is used (it would drop unsaved edits).

## 2. Task specs

### C1 — manual grading for the NEW exam system (A4; A1–A3 acceptance)
- **Gap (verified):** `routes/manual-grading.ts` reads/writes legacy tables only (`exam_attempts` at :240,:368,:448; `exam_results` :458) with no rubric, revision history or audit; the new flow sets `pending_review` for essays (`routes/exam-versions.ts:278`, `:1202`; `services/exam-grading.ts:23`) but nothing lists or grades those attempts. Backlog A4/A2/A3.
- **allowedPaths (single owner C1):** `server/src/routes/exam-versions.ts`, `server/src/services/exam-snapshots.ts`, `server/src/services/exam-grading.ts`, `server/src/routes/manual-grading.ts` (legacy file touched only if required for an explicit non-breaking dispatch; default: do not touch), NEW `server/src/services/exam-manual-grading.ts`, `server/src/routes/exam-manual-grading.ts`, tests `server/tests/m4-exam-snapshots.test.ts`, `server/tests/m4-exam-grading.test.ts`, NEW `server/tests/m4-exam-manual-grading.test.ts`, report `docs/streams/server/OC-C1-MANUAL-GRADING-20261020.md`.
- **Data contract (needs I2, never applied by me):** table for per-answer manual grade/revision (attempt id, answer key/question ref, points awarded 0..max integer-hundredths, reviewer user id, feedback text bounded, revision number UNIQUE per (attempt, question, revision), created_at); attempt state transition `pending_review -> graded` with reviewer id/time; optimistic version. `exam_versioned_answers` currently has no reviewer/feedback columns (migration 20261018_09:161-175).
- **Endpoints (mount = I1):** staff list of `pending_review` attempts (backlog A4 explicitly requires the manual-grading queue), grade one answer, finalize attempt. Authority = the `authorizeExamStaff` course/exam authority already in `exam-versions.ts` (server-verified), never role labels.
- **Acceptance tests:** reviewer scoped to own course sees only own pending attempts; grade within 0..points; finalize moves to `graded` and recomputes total exactly once; second grade of an answer creates revision N+1 and keeps history; every mutation audited in the same transaction; cross-tenant/unrelated teacher/student denied; concurrent finalize (version race) -> 409 and no double write; regrade interaction preserves terminal `expired` state; no result-release inference.
- **HELD (D3):** result release/visibility to student, retake policy, draft-vs-submitted precedence, archived-question policy, empty-answer scoring. Parts depending on them are isolated, not guessed.
- **Dependencies:** I2 schema before DB-backed route wiring (tests use injected store); I1 mount; the gradebook hook (exam score -> gradebook) is C2/I1, not here.

### C2 — assignments/gradebook integration (A5, A6)  [BLOCKED until W4 hands assignments files over exclusively]
- **Gap:** `routes/assignments.ts` `buildStaffVisibility`/create let any instructor see/create course-audience assignments (`routes/assignments.ts` staff visibility + create; backlog A5, B6); `services/assignments.ts:420-436` counts abandoned/infected rows against the slot (abandoned pending_upload burns the attempt) — W4 owns the upload part; `routes/gradebook.ts`: no unique/void/revision of scores, no exam/assignment feed (A6).
- **allowedPaths (after handoff):** `server/src/routes/assignments.ts`, `server/src/services/assignments.ts`, `server/src/routes/gradebook.ts`, `server/src/services/gradebook.ts`, tests `m4-assignments.test.ts`, `m4-gradebook.test.ts`, NEW `m4-gradebook-feeds.test.ts`, report `OC-C2-ASSIGNMENTS-GRADEBOOK-20261020.md`.
- **Data contracts (I2):** assignment submission grade/feedback storage; gradebook score unique key (student, course, item_type, item_id) + void/revision columns.
- **Acceptance:** teacher assigned-only authority across assignments; abandoned/infected rows do not consume a slot; grading stored and idempotent; exam/assignment scores feed the gradebook idempotently (keyed by attempt/submission id) and regrade updates, never duplicates; duplicate post idempotent/409; void/correct audited and recompute deterministic.
- **HELD:** canonical course-enrollment link (D3), empty-category/extra-credit/score-cap policy, late-at-finalize rule. **Dependencies:** W4 handoff, C1 (exam hook point), I2, I1.

### C3 — schedules/attendance reports and lifecycle (G2, G3, G7)
- **C3a (first batch) — verified gap:** no report or reconcile route anywhere (`routes/attendance-records.ts` has only list/mark/bulk/correct/me at :303,:334,:376,:432,:487; no "report/reconcile" in attendance code). Backlog G7.
- **allowedPaths (single owner C3):** `server/src/routes/attendance-records.ts`, `server/src/services/attendance-records.ts`, NEW `server/src/routes/attendance-reports.ts`, `server/src/services/attendance-reports.ts`, `server/src/routes/schedules.ts`, `server/src/services/schedules.ts` (only for C3b lifecycle below), tests `m5-attendance-records.test.ts`, `m5-schedules.test.ts`, NEW `m5-attendance-reports.test.ts`, report `OC-C3-ATTENDANCE-20261020.md`. `routes/attendance.ts` (legacy) ONLY after the source-of-truth decision.
- **Contract:** preserve every existing envelope and `X-Results-Truncated`; manual-record reports only: per student/group/session totals over a validated bounded date range, tenant/branch/assigned-group scope, corrected rows keep override reason, scoped CSV export neutralized and audited, truncation via header.
- **Acceptance:** totals equal row sums; non-owner sees only assigned groups/branches; cross-tenant 404; export capped + audited; bad range 400; legacy shapes untouched.
- **C3b (after decisions/I2):** series cancel/edit lifecycle and one-off create (series_id NULL supported by schema), idempotent create key (needs `client_request_key` column = I2), cancel remaining sessions in one transaction + one audit row; notifications = W9 contract (production notifier is NOOP) — held.
- **HELD:** legacy `attendance` vs `attendance_records` truth/`/notify-absent` (D6), visibility of `reason`, overlap rule, who may create tenant/branch series, correction of cancelled sessions, automatic leg (G4, W10).

### C4 — progress reports publish/read + parent views (A7, P1, P2, P7 data side)
- **Gap (verified):** `services/progress-reports.ts` exports pure helpers only (`buildProgressReport` :63, `projectProgressForParent` :101, `isProgressPublished` :92); no route, no publish storage; student `/progress` returns only the gradebook grade (`routes/gradebook.ts:389`); parent `gradeSummary` sums every gradebook row with no publish gate and no weights (`routes/parent-views.ts:236`), contradicting P2 "published fields only"; no `UPDATE`-able published state anywhere.
- **allowedPaths (single owner C4):** `server/src/routes/parent-links.ts`, `server/src/services/parent-links.ts`, `server/src/routes/parent-views.ts`, `server/src/services/progress-reports.ts`, NEW `server/src/routes/progress-reports.ts`, tests `m6-parent-links.test.ts`, `m6-parent-views.test.ts`, NEW `m4-progress-reports.test.ts`, report `OC-C4-PROGRESS-REPORTS-20261020.md`. Not allowed: outbox/notification files (W9), `routes/gradebook.ts` (C2; read its exported calculation only).
- **Data contract (I2):** `published`/`published_at`/`published_by` per (tenant, enrollment, course) or per report scope; parent link liveness unchanged.
- **Endpoints (mount = I1):** teacher publish/unpublish (audited, scope-checked), student own report (lesson progress, exam/assignment aggregates using existing helpers), teacher/branch filtered list + audited CSV, parent read via existing scoped token, returning only published fields and no internal ids.
- **Acceptance:** student sees own only; teacher branch filter hides other branches; parent sees nothing until published and exactly the published projection afterwards (weights consistent with the student view); revoked link denies immediately; draft score excluded; export audited and formula-neutralized; cross-tenant 404.
- **HELD (D3):** parent report fields/cadence, link invalidation on student deactivation/guardian change, parent provisioning (G8). P7 delivery = W9/D1.

### C5 — enrollment identity, import, registration, subscription requests (FIN2; C8/C10/C12, B1/B3/B4)
- **Gap:** import and some creation paths do not guarantee a unified user identity (affects the center-student-counted-once rule, docs/19); multi-teacher relations inside a center are not modelled consistently with billing; `student_courses` vs `groups.course_id` ambiguity (D3).
- **allowedPaths (single owner C5):** `routes/student-enrollment.ts`, `routes/students.ts`, `routes/student-import.ts`, `services/student-csv-import.ts`, `routes/registration-requests.ts`, `routes/subscription-requests.ts`, matching tests; report `OC-C5-ENROLLMENT-IDENTITY-20261020.md`.
- **Contract:** never merge people by name similarity; never merge across tenants; ambiguous imports quarantined with report; student-teacher relations are many-to-many inside a tenant with immutable activation events (events produced for C7, no billing here). **Schedule:** after the first batch; never concurrent with C8 on `subscription-requests`. **HELD:** canonical enrollment relation, billing-start event (D3).

### C6 — moderation/audit remainder (O4, O7, P6)
- **allowedPaths:** `routes/moderation.ts`, `services/moderation.ts`, `services/lesson-discussions.ts`, `routes/audit-logs.ts`, `services/audit-log.ts`, tests, report `OC-C6-...`. Scope: only parts with an explicit contract (report lifecycle only once a mapping contract exists; notification event contract with W9; restore/retention without purge). `security/audit.ts` sealing coverage is I3. **Starts after batch 1.**

### C7 — billing basis (FIN1, FIN4, FIN11; B2, B9, B10, B11) — NEW files only, pure first
- **Gap (verified):** no billing implementation exists: grep for `price_version`, `billing_period`, `activation_period`, `registration_count` finds nothing under `server/src`; `services/` has only the old `service-credit.ts` (not a center wallet).
- **allowedPaths (single owner C7, files do not exist yet):** NEW `server/src/services/billing-pricing.ts`, `billing-basis.ts`, `billing-periods.ts`, `billing-invoices.ts` and tests `server/tests/billing-pricing.test.ts`, `billing-basis.test.ts`, `billing-periods.test.ts`, `billing-invoices.test.ts`, report `OC-C7-BILLING-BASIS-20261020.md`. No existing file is edited.
- **FIN1 spec (docs/19 lines 13-35, 111) — acceptance numbers:** teacher T(n)=2000+50×min(max(n−50,0),50)+45×min(max(n−100,0),50)+40×min(max(n−150,0),50)+35×max(n−200,0); center C(n)=7000+45×min(max(n−200,0),50)+40×min(max(n−250,0),50)+35×min(max(n−300,0),50)+30×max(n−350,0). Required checks: T(50)=2000, T(51)=2050, T(100)=4500, T(150)=6750, T(200)=8750; C(200)=7000, C(201)=7045, C(250)=9250, C(300)=11250, C(350)=13000, **C(351)=13030 (not 13000)**, C(500)=17500; first 50 included for teachers, first 200 for centers. Proration: a 51st registration active for exactly one hour for a teacher with 50 -> 2000 + 50/720 = 2000.07 after FINAL HALF_UP only; 50 then 51 after 15 days -> 2025 (the 15-day half cycle of the 50 increment). Exact integer/rational arithmetic (BigInt/minor units, no floats), one final HALF_UP rounding, cycle 2,592,000 s, intervals [start,end) in UTC, DST-independent.
- **FIN1 basis rules:** unique student per tenant counted once regardless of teacher count (union of intervals across all student-teacher relations: 200 students with 3 teachers = 200 = 7000), event-count changes at each activation/expiry instant, immutable price-version and event ids, credit is NOT wallet, no collection wired, no vendor.
- **FIN4:** invoice/period/lines/price-version snapshots rebuildable from events (first base invoice without predicted count). Pure + injected data only; a persisted store waits for I2.
- **HELD:** D3 relation start event, fee/tax/offers vendor items (D2). **Dependencies:** FIN2 events (C5) for real data; I2 for storage.

### C8 — money flows (FIN3, FIN5–FIN10; B4, B5, B7, B8, B11, B12, F1, F2) — SEQUENTIAL, never one block
- **allowedPaths (single owner C8, only after C7/C5/I2 as stated):** `routes/fees.ts`, `routes/platform-tenants.ts`, `routes/instructor-wallet.ts`, `routes/payment-requests.ts`, `services/subscription-renewal.ts`, NEW ledger/reservation/payment-adapter files, matching tests, report `OC-C8-MONEY-<part>-20261020.md` per part. `subscription-requests.ts` only after C5 delivers it.
- **Parts:** see §3. Real collection/payout/refund execution is gated by D2; neutral interfaces and hermetic tests only.

## 3. FIN1–FIN12 breakdown (order, owner, gates)
| Part | Output | Owner/order | Gate |
|---|---|---|---|
| FIN1 | tier + interval-union + exact fractions engine, HALF_UP final only | C7, batch 1 | none (pure) |
| FIN2 | multi student/teacher relation in tenant, immutable activation event log, ambiguous-import quarantine | C5 then I2 | D3 relation/start event |
| FIN3 | balanced ledger, allocations, receivable/wallet/credit, reserve/release/compensation | C8 new files, after I2 | schema I2; old service-credit is not a center wallet |
| FIN4 | invoice/period/lines/price-version/offer snapshots, rebuildable reconciliation | C7 after FIN1–3 | none beyond data |
| FIN5 | collection priority, grace, access protection | C8 then I1 | **96 h (345,600 s) from issuing the difference request**, retry does not reset; paid future student periods preserved |
| FIN6 | legacy collection: exact identity, no false paid-without-payment, pending duplicate, attribution, revenue once | C8 on `fees` then `subscription-requests` after C5 | do not ban all unlinked cash receipts without a contract |
| FIN7 | concurrent payment idempotency, money arithmetic, remainder display | C8 on `platform-tenants`/service-credit | overpayment surplus handled per contract, not rejected |
| FIN8 | neutral checkout/callback/reconciliation interfaces; vendor implementation later | C8 new files | signed amount/currency/order/event; real execution D2 |
| FIN9 | payout request/reserve/process/confirm/fail, destination authority | C8 after ledger/priority | limits/cooling/provider D2 |
| FIN10 | refund/funding/reservation/reversal, dispute separate from normal cancel | C8 after FIN3 | external execution D2 |
| FIN11 | admin/read models from canonical invoice basis | C7/C8 after FIN4 | teacher analytics must NOT be a center invoice basis |
| FIN12 | F1/F2 hermetic financial acceptance suites, then SQL/sandbox | I4 | no real collection before it |

## 4. Prerequisites and data contracts (all for the shared-file owners, nothing applied by this lane)
- **I2 (migrations + manifest, single owner):** (a) exam manual-grading answer-grade/revision table + attempt reviewer columns (C1); (b) `published` columns for report scope (C4); (c) assignment submission grade/feedback table and gradebook score unique key + void/revision (C2); (d) attendance `(tenant_id, group_id, marked_at)` index (C3, optional), series `client_request_key` + UNIQUE (C3b); (e) FIN ledger/price-version/period/event tables (C7/C8). Idempotent files only, no existing migration edited, live application needs a separate authorization.
- **I1 (`index.ts`, auth hooks):** mounts for the new routes (exam manual grading, progress reports, attendance reports, later billing/ledger), CORS exposure of `X-Results-Truncated`, hooks between exam grading -> gradebook (C1 -> C2).
- **I3:** `content-release.ts` DST nonexistent wall time, `security/audit.ts` sealing coverage.
- **W-lane contracts consumed:** W4 assignments handoff (C2), W9 notification event contract (C3b/C6), W10 live attendance events (C3 automatic leg).

## 5. Policy-held subparts (not decided by any agent; D3 unless noted)
Result release/visibility/retakes/draft precedence/archived pinning; empty categories/extra credit/score cap; canonical enrollment relation and relation-start billing event; attendance legacy-vs-new truth, reason visibility, overlap and create authority, cancelled-session correction; consent global-vs-tenant; parent provisioning/invalidation/report fields and cadence; report-status mapping and restore/retention; D2 items (provider/vendor, DRM, live, scanner, payout, DNS/TLS, backup) and D1 (OTP/SMS/WhatsApp, fail-closed) stay deferred with neutral interfaces only.

## 6. Ownership and reservation rules
- One writer per file for the lifetime of a task; test files are reserved as listed (`m4-exam-snapshots/grading`: C1 only; `m4-gradebook`, `m4-assignments`: C2 only; `m5-*`: C3 only; `m6-parent-*`, new report tests: C4 only; `m6/m7-moderation|audit`: C6 only).
- Never concurrent: C2 with W4; C5 with C8 on `subscription-requests`; C7 with C8 on billing-link files; C1 with C2 on grading hooks.
- A quota-stopped worker is confirmed not running (process check) before any replacement; no overlapping launch.
- No worktree from HEAD: unsaved edits would be lost.
- Every deliverable: focused test numbers, full before/after sha256 per file, diff reviewed by me before submission; a mid-batch review per batch, then a final comprehensive review; no accumulation of unreviewed code.
- Quality: injected source adapters/permission checks (not cosmetic mocks); failing test first where a defect exists; where code was written first the report states it honestly; no assertion weakening, no `any`/`ts-ignore`, old response envelopes and `X-Results-Truncated` preserved.

## 7. Request to Codex
Confirm: (1) file ownership above and non-overlap with W1–W10 and I1–I4; (2) approval of batch 1 (C1a, C3a, C4a, C7a/FIN1) per docs/18; (3) I2 owner/ordering for the schema contracts in §4; (4) that C2 stays blocked until W4's explicit handoff. Until confirmed no writer is launched. No milestone/100% is claimed.
