# CURRENT SERVER PROGRESS — 2026-10-19 (server-only, evidence-based)

**Worker:** `wb-server-billing-review-20261019-01` (task `current-server-progress-billing-policy-review-20261019-01`, team qa, accessMode write — three allowed documents only; code inspected READ-ONLY).
**Repo:** `C:\Users\abdua\OneDrive\سطح المكتب\FreeLance_25-1` · branch `codex/workbuddy-server` · HEAD verified this run: `de7375e72d3938cca283f8c64021bb4c2eec3021` (2026-10-19T10:05:07+03:00).

## 0) Fresh verification evidence (this review)

| Check | Command | Result |
|---|---|---|
| Full hermetic suite — repo root cwd | `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/*.test.ts` | **exit ≠ 0 — 2139 tests, 2130 pass, 9 fail** (27.4 s) |
| Full hermetic suite — server cwd | `M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/*.test.ts` | **identical: 2130 pass / 2139, 9 fail** (17.6 s) |
| Source typecheck — server | `node node_modules/typescript/bin/tsc --noEmit` | **exit 2 — 3 errors**, all inside the untracked M8 search files (details §5) |
| Stale claim resolved | earlier report's `services/parent-links.ts(429,31) 'deps.otp' possibly undefined` | **no longer reproduces** — that code is committed (da782dd) and typechecks clean now |

Working tree: 18 modified tracked files (M4/M5/M6 review-fix set) plus an **untracked M8 set**: `server/src/middleware/request-context.ts`, `server/src/services/logger.ts`, `server/src/services/metrics.ts`, `server/src/routes/ops.ts`, `server/src/routes/search.ts`, `server/src/services/search.ts`, `server/src/routes/tenant-export.ts`, `server/src/services/tenant-export.ts`, `server/migrations/20261018_23_search_export.sql`, `server/tests/m8-observability.test.ts`, `server/tests/m8-search.test.ts`, `server/tests/m8-tenant-export.test.ts`. No live DB, network, Docker or provider contact — hermetic fakes only.

## 1) Status legend

| Mark | Meaning |
|---|---|
| **A** | implemented **and** hermetic-tested (dedicated passing tests in the current suite) |
| **B** | implemented, **not verified** (not mounted in `index.ts`, typecheck red, or no provider/device evidence) |
| **C** | missing |
| **D** | external provider / vendor / human-client dependency (not deliverable by server code alone) |
| **E** | superseded by human decision (out of current scope, history preserved) |

## 2) M1 — Security + tenant core

| ID | الوظيفة | Status | Evidence (files / tests) |
|---|---|---|---|
| S1 | identity: user/tenant/branch membership | **A** | `middleware/tenant-authority-boundary.ts`, `middleware/student-workspace-boundary.ts`, `security/identity-scope.ts`, migrations `20261017_06_branch_membership`, `20261017_07_identity_otp`; `m1-close-branch-membership`, `m1-close-identity-otp`, `m1-branch-resource-contract` pass |
| S2 | auth/OTP/sessions/revoke/recovery | **A** | `routes/auth.ts`, `security/identity-otp.ts`, `security/phone.ts`; `auth-security`, `m1-security-auth-session`, `m1-close-auth-token-version`, `identity-hardening` pass |
| S3 | RBAC capability policies (deny-by-default) | **A** | `security/admin-permissions.ts`, `security/branch-access.ts`, `middleware/teaching-access.ts`; `m1-close-platform-admin`, `m1-expanded-admin-authority`, `m1-expanded-lecture-authority` pass |
| S4 | signup/invitation policy | **A** | `routes/tenant-invitations.ts`, `security/registration-policy.ts`; `m1-expanded-tenant-admin` pass |
| S5 | safe migration & data ownership (reviewed manifest ledger) | **B** | `scripts/build-m1-bootstrap.mjs`, `server/bootstrap/m1/manifest.json`; `m1-bootstrap-plan` **currently fails** (untracked migration not registered — §10.1); `m1-schema-reconciliation` passes |
| S6 | private file & export tenant scope | **A** | `routes/files.ts`, `services/minio.ts`; `m1-expanded-file-authority`, `m1-upload-contract` pass |
| S7 | video/object/session tenant scope | **A** | `routes/secure-video.ts`, `security/video-access-policy.ts`, `services/playback-entitlement.ts`; `m1-expanded-lecture-authority`, `m1-branch-video-scope`, `m1-video-route-boundary`, `m1-security-videos` pass |
| S8 | queue/cache/socket tenant context | **A** | `services/socket.ts`; `m1-media-socket-regressions`, `m1-security-socket-origin` pass |
| S9 | M1 release gates | **B** | `m1-ci-boundary`, `m1-secret-scan`, `m1-secret-env-required`, `m1-network-guard` + `.github/workflows/ci.yml`, `.github/workflows/m1-security-config.yml` exist and pass, but the bootstrap-plan leg of S9 is red until §10.1 is resolved |

## 3) M2 — Teacher/Student core

| ID | الوظيفة | Status | Evidence |
|---|---|---|---|
| C1 | tenant/branch/teacher identity | **A** | `routes/branches.ts`, `routes/tenant-self.ts`; `m1-close-branch-membership`, `m1-expanded-tenant-admin` |
| C2 | branding + subdomain/host resolution | **A** (server side) | `routes/tenant-branding.ts`, `services/tenant-host.ts`; `m2-tenant-host-branding` |
| C3 | custom domains | **B/D** | `routes/tenant-domains.ts`, `services/domain-verification.ts`; `domain-verification` tests pass with injected verifier — real DNS/TLS issuance + takeover behavior is **provider-verified only in hermetic fakes** |
| C4 | public teacher page + discovery | **A** | `routes/public-identity.ts`; `m2-c1-c4-public-identity` |
| C5 | course/unit/lesson/file catalog | **A** | `routes/courses.ts`, `routes/lectures.ts`, `routes/materials.ts`; `m2-c5-lectures-reorder-audit` |
| C6 | scheduled drip release | **A** | `routes/content-access.ts`, `services/content-release.ts`; `m2-content-release` |
| C7 | sequential lesson unlocking | **A** | same surface; `m2-content-release` |
| C8 | terms + enrollment lifecycle | **A** | `routes/student-enrollment.ts`, migration `20261018_01`; `m2-c8-c10-enrollment-lifecycle`, `m1-close-enrollment-courses` |
| C9 | student signup/join + OTP | **A** | `routes/auth.ts`, `routes/registration-requests.ts`; `student-enrollment-security`, `m2-enrollment-session-recheck` |
| C10 | enrollment/access status gating | **A** | `routes/student-enrollment.ts` + `content-access` policy; `m2-c8-c10-enrollment-lifecycle` |
| C11 | announcements | **A** | `routes/announcements.ts`; `m2-announcements` |
| C12 | CSV/XLSX student import | **A** | `routes/student-import.ts`, `services/student-csv-import.ts`; `m2-student-import` |

## 4) M3 — Video protection

| ID | الوظيفة | Status | Evidence |
|---|---|---|---|
| V1 | provider-neutral asset lifecycle | **A** | `routes/video-assets.ts`, `services/video-asset-lifecycle.ts`; `m3-video-lifecycle` |
| V2 | upload/transcode HLS/ABR/DRM | **B/D** | `services/video-processor.ts`, `services/vdocipher.ts` exist; status-after-provider-verification pattern tested, but **no live transcoder/DRM run and no device matrix** — provider evidence outstanding |
| V3 | per-tenant playback entitlement | **A** | `routes/playback-sessions.ts`, `services/playback-entitlement.ts`; `m3-playback-entitlement-indexes`, `m3-playback-sessions`, `m3-playback-sql-store` |
| V4 | partial identity watermark | **A** | `services/playback-watermark.ts`; `m3-video-review-fixes` |
| V5 | device/concurrent-session limits | **A** | `services/playback-session-registry.ts`; `m3-playback-sessions` (race coverage) |
| V6 | low-bandwidth resume | **A** | `services/playback-progress.ts`; `m3-playback-sessions` |
| V7 | downloads where allowed | **C/D** | no download route exists (default deny holds); rights/DRM provider capability unverified — a rights decision + provider proof precede any implementation |
| V8 | usage events (watch/storage) | **B** | `services/video-usage-events.ts` + tests pass for watch events; **storage metering end-to-end not proven** — `storageStat` upload/finalize pipeline is still a stub (carried from the 2026-10-19 02:20 verified report, not re-tested here) |

## 5) M4 — Assessment, assignments, gradebook

| ID | الوظيفة | Status | Evidence |
|---|---|---|---|
| A1 | reusable question bank | **A** | `routes/question-bank.ts`, `services/question-bank.ts`; `m4-question-bank` |
| A2 | timed exams + immutable snapshots | **A** | `routes/exam-versions.ts`, `services/exam-snapshots.ts`; `m4-exam-snapshots` |
| A3 | MCQ auto-grading | **A** | `services/exam-grading.ts`; `m4-exam-grading` |
| A4 | manual grading | **A** | `routes/manual-grading.ts`; `m4-*` grading coverage |
| A5 | assignments + file submissions | **A** | `routes/assignments.ts`, `services/assignments.ts`; `m4-assignments` |
| A6 | gradebook | **A** | `routes/gradebook.ts`, `services/gradebook.ts`; `m4-gradebook` |
| A7 | student progress reports | **A** | `services/progress-reports.ts`; `m4-gradebook` report coverage |
| A8 | certificates | **E** | superseded by human decision 2026-10-19 (product = school teachers/students platform). Source + migrations preserved; `/api/certificates` intentionally unmounted in `index.ts`; **not a completion blocker** |

## 6) M5 — Groups, attendance, integrated live

| ID | الوظيفة | Status | Evidence |
|---|---|---|---|
| G1 | groups / multi-teacher center membership | **A** | `routes/groups.ts` (tenant-scoped CRUD behind `requireTeachingWrite`); `m1-security-groups-meetings` |
| G2 | schedules/calendar (recurrence, DST) | **A** | `routes/schedules.ts`, `services/schedules.ts`; `m5-schedules` |
| G3 | manual attendance | **A** | `routes/attendance-records.ts`, `services/attendance-records.ts`; `m5-attendance-records` |
| G4 | automatic attendance from live provider | **C/D** | no verified join/leave callback surface; Live provider contract outstanding |
| G5 | in-platform live session | **C/D** | no live routes or migrations (`live_session`/`room_token` absent); provider POC + S8 token design required |
| G6 | recording saved into course library | **C/D** | depends on G5 + V1; nothing implemented |
| G7 | attendance reports + manual/auto reconcile | **B** | manual attendance data is queryable; no dedicated report/reconcile surface and the automatic leg is missing with G4 |

## 7) M6 — Parent and notifications

| ID | الوظيفة | Status | Evidence |
|---|---|---|---|
| P1 | parent–student verified linking | **A** | `routes/parent-links.ts`, `services/parent-links.ts`; `m6-parent-links` |
| P2 | read-only parent views | **A** | `routes/parent-views.ts`; `m6-parent-views` |
| P3 | notification preferences/consent | **A** | `routes/notification-consent.ts`, `services/notification-consent.ts`; `m6-notification-consent` |
| P4 | in-app/email delivery + outbox | **A** | `services/notification-outbox.ts`, `services/delivery-channels.ts`; `m6-notification-outbox` |
| P5 | WhatsApp/SMS reports | **B/D** | `services/whatsapp.ts` (+ deep-link `whatsapp-free.ts`) exist with no provider contract; approved-template/account verification, verified numbers, opt-in/STOP and no-PII-logging proofs outstanding. **SMS deferred per owner instruction** |
| P6 | lesson comments & Q&A | **A** | `routes/lesson-discussions.ts`, `services/lesson-discussions.ts`; `m6-lesson-discussions` |
| P7 | parent report delivery | **B/D** | channel layer exists; blocked behind P5 provider proof |

## 8) M7 — Super-Admin operations

| ID | الوظيفة | Status | Evidence |
|---|---|---|---|
| O1 | tenant create/suspend/restore | **A** | `routes/platform-tenants.ts`, `security/suspension-predicate.ts`; `m1-expanded-tenant-admin`, `m1-close-platform-admin` |
| O2 | plans + feature-flag editor | **A** | `routes/platform-flags.ts`, `services/feature-flags.ts`; `m7-feature-flags` |
| O3 | usage measurement + billing ledger | **C** | **no billing ledger exists**: grep for `price_version` / `billing_period` / `activation_period` / `registration_count` / tier logic finds no billing implementation. `subscription-lifecycle.ts` / `subscription-renewal.ts` operate fixed-price `tenant_subscriptions` + plan amounts only; `video-usage-events` meters watch events. Contrary teacher-based counting found only in analytics — §11 |
| O4 | moderation queue + appeals | **A** | `routes/moderation.ts`, `services/moderation.ts`; `m7-moderation` |
| O5 | support tickets | **A** | `routes/support-tickets.ts`; `m1-close-platform-admin`, `m1-sprint-notification-support` |
| O6 | impersonation | **B** | `routes/impersonation.ts` + 21 passing hermetic tests (`m7-impersonation`) — **not imported/mounted in `index.ts`** (adopter wiring documented in the file header) |
| O7 | tamper-evident audit logs | **A** | `routes/audit-logs.ts`, `services/audit-log.ts`; `m7-audit-logs` |
| O8 | platform analytics | **A** (server side) | `routes/admin-insights.ts`; `qa-m1-gate-gaps` boundary coverage; PII-aggregate limits noted |
| O9 | platform MFA | **B** | `routes/platform-mfa.ts` + 24 passing hermetic tests (`m7-platform-mfa`) — **not mounted**; `createMfaVerifier` wiring is adopter-owned by design |

## 9) M8 — Quality and operations (server scope)

| ID | الوظيفة | Status | Evidence |
|---|---|---|---|
| Q1 | Arabic RTL / English | **D** | frontend surface (human client owns `src/**`) — out of server scope |
| Q2 | accessibility | **D** | frontend surface — out of server scope |
| Q3 | search | **B** | `routes/search.ts` + `services/search.ts` (SQL-side tenant/visibility gates); `m8-search` 25/25 pass — but **untracked, unmounted, and typecheck fails on it** (§10.3) |
| Q4 | observability | **B** | `middleware/request-context.ts`, `services/logger.ts`, `services/metrics.ts`, `routes/ops.ts`; `m8-observability` 25/25 pass — **untracked and never wired**: `mountObservability` is exported but `index.ts` never calls it, so `/metrics`, `/healthz`, `/readyz` are not live |
| Q5 | backup + tested restore | **C/D** | ops/human drill; no code, no restore evidence |
| Q6 | per-tenant data export | **B** | `routes/tenant-export.ts` + `services/tenant-export.ts`; migration `20261018_23` exists — but **8 of 23 tests fail** (§10.2), unmounted, migration unregistered in the reviewed manifest |
| Q7 | scale/performance | **C** | no load-test harness or measured p95 profile |
| Q8 | release safety | **B** | `.github/workflows/ci.yml` + `m1-security-config.yml` exist; staged-deploy/rollback evidence not in repo |

## 10) Open blockers (red items that must be resolved before any "green" claim)

**10.1 — `m1-bootstrap-plan` fails (1 test).** `stages every migration in order with exact source hashes…`: `Source hash differs from reviewed manifest for 20261018_23_search_export.sql`. The migration exists on disk (untracked M8 set) but is not registered in `server/bootstrap/m1/manifest.json`. Registering it is an M1 gate-owner action outside this task's scope. No file was edited to mask it.

**10.2 — `m8-tenant-export` fails 8 of 23 tests** (409-while-active, cooldown, pending-job+audit, platform-actor export, non-owner deny/fail-closed, DB-failure 500, status/download-token/signed download, owner job listing). Root cause identified read-only: the test fixture implements the active-job / last-completed SELECT matching **only in `db.query`**, while `services/tenant-export.ts:304-323` reads those guards via **`db.queryOne`**, which the fixture hardcodes to `null` — so the service never observes the seeded active job. The service itself contains the intended 409/cooldown logic. Either the fixture or the service contract must be corrected by the owner; nothing was edited or masked here.

**10.3 — Typecheck red on the untracked M8 search set (3 errors):** `src/routes/search.ts(117,43)` and `(127,39)` pass `string` where the `"question_bank" | "courses" | "announcements" | "lessons"` union is required; `src/services/search.ts(211,7)` is missing `announcements` in `Record<"courses" | "announcements" | "lessons", string>`.

**10.4 — Mounting gaps.** `ops.ts` (Q4), `search.ts` (Q3), `tenant-export.ts` (Q6), `impersonation.ts` (O6) and `platform-mfa.ts` (O9) are implemented with passing dedicated tests but are **not imported by `server/src/index.ts`** — none of these surfaces is live. Mounting requires an approved scope touching the shared `index.ts` (coordinate with Codex per the two-developer operating plan).

**10.5 — Untracked M8 set.** None of the M8 files is committed; ownership/serialization with the human client stream needs supervisor coordination.

## 11) Billing counting audit (READ-ONLY) — contrary teacher-based patterns found

1. `server/src/routes/admin-insights.ts:141-146` — the "portfolio" analytics query aggregates `COUNT(s.id) AS student_count` **per instructor** via `students.instructor_id` (legacy teacher-centric model). It is analytics, not billing, but it is the only teacher-based student-counting pattern in the codebase; **it must not be reused as the basis for center billing** when B10/O3 is implemented.
2. No billing ledger exists: `price_version`, `billing_period`, `activation_period`, `registration_count` and tier arithmetic appear nowhere in `server/src`. `subscription-lifecycle.ts` / `subscription-renewal.ts` run fixed-price `tenant_subscriptions` with plan amounts and 4-day grace only. Student money exists only as legacy surfaces (`payment-requests`, `instructor-wallet` top-ups, `premium-lecture` payments, `fees`/`expenses`/`revenues`) that do not implement the docs/19 tiered count-proration-settlement model.
3. **Needed correction scope when billing counting is implemented (design only, not done here):** the counting unit must be the **unique student user id within the tenant**, keyed on the **union of eligible active student–teacher relations** inside that tenant — never a per-teacher sum, never a cross-tenant dedupe. Full rule with acceptance examples is documented in `docs/19` (dated owner correction, 2026-10-19) and mirrored in `docs/17` B2/B10/O3 wording.
4. This review does **not** claim the financial system is correct — it is largely unimplemented; only the policy text is corrected.

## 12) Progress ranges (explicitly non-authoritative)

Method: a milestone's breadth weight = its backlog rows; acceptance = rows that are **A** today. Ranges are honest intervals, not measurements — no exact percentage is claimed, and implementation breadth is separated from tested acceptance/readiness.

| Milestone | Breadth (implemented rows) | Tested acceptance (A rows) | Range |
|---|---|---|---|
| M1 | 9/9 rows | 8/9 (S5 gate red) | breadth ~95%; accepted ~85-90% |
| M2 | 12/12 | 11/12 (C3 provider evidence outstanding) | breadth ~100%; accepted ~90-95% |
| M3 | 7/8 (V7 absent) | 5/8 (V2/V8 unproven end-to-end) | breadth ~85%; accepted ~65-75% |
| M4 | 7/7 (A8 superseded) | 7/7 | breadth ~100%; accepted ~95-100% |
| M5 | 3/7 (G4/G5/G6 absent) | 3/7 | breadth ~45%; accepted ~40-50% |
| M6 | 7/7 | 5/7 (P5/P7 provider unverified) | breadth ~100%; accepted ~70-80% |
| M7 | 8/9 (O3 absent) | 6/9 (O6/O9 unmounted) | breadth ~90%; accepted ~65-75% |
| M8 | 3/8 (Q3/Q4/Q6 code-only) | 0/8 mounted-and-verified | breadth ~35%; accepted ~10-20% |
| Billing additions (B/S/N/F in docs/17) | scaffolding only (legacy subscriptions, top-ups, approvals) | none of the docs/19 count/proration/settlement rules | breadth ~15-25%; accepted ~0-5% |

Overall server breadth across all rows above ≈ **70-75%**; tested-accepted ≈ **55-65%** (ranges weight A rows vs all rows).

## 13) Remaining effort — person-day ranges (assumptions stated)

Assumptions: one engineer working hermetic-first; no vendor contract in hand; client (human dev) available for coordination but does not write server code. Provider/human latency is listed separately and never added into engineering days.

| Work item | Effort (person-days) | External/human latency |
|---|---|---|
| Close S5: review + register `20261018_23` in `server/bootstrap/m1/manifest.json`, re-run gates | 0.5-1 | M1 gate-owner review |
| Reconcile `m8-tenant-export` fixture vs service contract (pick `queryOne` or `query`; re-run 23 tests) | 0.5-1 | — |
| Fix 3 M8 search typecheck errors | 0.5-1 | — |
| Mount Q3/Q4/Q6 + O6/O9 routers in `index.ts` (fail-closed secrets `METRICS_TOKEN`, `TENANT_EXPORT_SECRET`, `MFA_SECRET_KEY`) + regression tests | 2-4 | index.ts is shared — Codex coordination |
| V2 live transcoder/DRM verification (device matrix, status-after-provider) | 3-6 | provider sandbox + device lab (2-6 weeks) |
| V7 downloads (rights decision first, then entitlement/lease tests) | 2-4 | rights/DRM provider capability proof |
| V8 storage metering end-to-end (upload-finalize pipeline replacing the `storageStat` stub) | 3-6 | object-storage events provider |
| M5 G4/G5/G6 live sessions (tokens, host roles, recording pipeline) | 8-15 | live provider POC + contract (2-6 weeks) |
| M6 P5/P7 WhatsApp provider verification (templates, opt-in/STOP, no-PII logs); **SMS deferred** | 1-2 | provider onboarding (1-4 weeks) |
| O3/B10 counting + proration + settlement ledger (after F1 gate design) | 10-20 | legal/vendor contract, tax review (2-8 weeks) |
| Q5 backup + restore drill with recorded duration/data-loss evidence | 2-4 | ops access |
| Q7 load test with documented p95/error/queue-lag targets | 3-5 | traffic profile from owner |

## 14) Recommended next bounded tasks (precise paths/dependencies)

1. **Unblock the M1 gate (S5):** review and register `server/migrations/20261018_23_search_export.sql` into `server/bootstrap/m1/manifest.json` via the M1 gate process, then re-run `m1-bootstrap-plan`. *Depends on:* M1 gate owner; no other work should land on the manifest meanwhile.
2. **Make Q6 honest:** correct the `m8-tenant-export` fixture/service contract (choose `db.queryOne` consistently) and re-run `server/tests/m8-tenant-export.test.ts` to 23/23. *Files:* `server/tests/m8-tenant-export.test.ts`, `server/src/services/tenant-export.ts`. *No dependency.*
3. **Make Q3 green:** fix the 3 typecheck errors in `server/src/routes/search.ts` (lines 117, 127) and `server/src/services/search.ts` (line 211). *No dependency.*
4. **Expose what is built:** mount `ops`/`search`/`tenant-export` (Q4/Q3/Q6) and `impersonation`/`platform-mfa` (O6/O9) in `server/src/index.ts` behind the existing `/api` guards, with fail-closed secret checks, plus mounting regression tests. *Depends on:* tasks 1-3 accepted; `index.ts` is shared with the human client — needs Codex coordination.
5. **Design-only billing counting task (B10/O3):** unique-student-within-tenant counter + price-version snapshot + proration/settlement design per the docs/19 correction — no financial SQL in the design task. *Depends on:* F1 gate decision and vendor/legal path.

## 15) Billing policy correction applied by this review (owner, 2026-10-19)

- Center billing counts the **unique student user within the tenant once** while **any** eligible active student–teacher relation exists in that center; several teachers in the same center **never multiply** the count; overlapping active intervals are **unioned, not summed**. Distinct independent-teacher institutions remain **separate tenants** — cross-tenant dedupe is forbidden. The existing rule that one student–teacher relation counts once across multiple courses is preserved.
- Prices, tiering, the 30-day cycle, proration and the no-commission rule are **unchanged**; **no billing code or SQL was implemented or executed** by this review.
- Documented in `docs/19-commercial-registration-wallet-agreement-ar.md` (dated owner correction + acceptance examples) and `docs/17-full-feature-backlog.md` (B2/B10/O3 wording). SMS remains deferred and certificates remain excluded per owner instruction.

## 16) Limits

- Hermetic fakes only; no live MySQL/provider/device evidence this run. Carried (not re-tested): `storageStat` stub, `VIDEO_PLAYBACK_SECRET` deploy requirement, `playback_entitlements.session_id` index gap — from the 2026-10-19 02:20 verified report.
- Q1/Q2 are frontend surfaces owned by the human client; outside server scope.
- No milestone is accepted by this document. Final acceptance is Codex's.
