# Feature and readiness matrix

Checkpoint: **2026-10-25**, after the merge on `main`. Re-check target source and
tests before changing a status.

Status meanings:

- **Mounted**: reachable from the current composition root.
- **Partial**: useful code exists but an end-to-end contract is incomplete.
- **Factory only**: implementation exists but production never constructs it.
- **External/config blocked**: requires real schema, secret or provider evidence;
  do not fabricate it.

| Area | Current state | Primary entry points | Important gap |
|---|---|---|---|
| Authentication and scoped principals | Mounted | `routes/auth.ts`, `middleware/auth.ts`, `security/identity-scope.ts` | OTP is deliberately outside the current completion target |
| Tenant/workspace/branch boundaries | Mounted, actively enforced | `middleware/tenant-authority-boundary.ts`, `student-workspace-boundary.ts`, `security/branch-access.ts` | Every new route still needs resource-level tenant checks |
| Catalog units/lessons and publication | Mounted; M2-22 accepted historically | `routes/courses.ts`, `course-units.ts`, `course-lessons.ts`, `public-catalog.ts` | M2-23 is only partial; see next row |
| M2-23 student learning path | Partial | `routes/course-lessons.ts`, `migrations/20261023_04_lesson_release_progress.sql` | Missing production `student-course-access.ts`, index mount, client adapter/controller/page integration, dedicated tests and final contracts |
| Student import | Mounted in bounded phases | `routes/student-import.ts`, `src/features/imports/` | Migrations remain environment-dependent; no implicit account/enrollment creation beyond explicit contracts |
| Groups, schedules, announcements | Mounted | `routes/groups.ts`, `schedules.ts`, `announcements.ts` | Some broad post-merge harness suites are stale/failing; validate before claiming full regression green |
| Assignments | Mounted with private MinIO object store | `routes/assignments.ts`, assignment recovery services | No trusted malware scanner; durable cleanup/scan recovery and exact-version proof remain unconfigured, so clean verdict is unreachable |
| In-app notifications/preferences | Mounted | `routes/notifications.ts`, `services/notification-preferences.ts` | External dispatch is separate |
| Notification dispatch runtime | Factory only | `services/notification-runtime-factory.ts`, delivery/outbox services | Needs purpose-scoped contacts, tenant binding, secrets, applied schema report and real ready adapters; not constructed by `index.ts` |
| Legacy meetings | Mounted | `routes/meetings.ts` | Not equivalent to the hardened live runtime |
| Hardened live sessions/recordings | Factory only | `services/live-runtime-factory.ts`, `routes/live-sessions.ts`, `services/live-recording-ingest.ts` | Not mounted; requires schema/operational evidence, sealed audit, provider verification/mapping and optional real storage metering/recovery lifecycle |
| Legacy fees/payments/expenses/wallet UI | Mounted | `routes/fees.ts`, `payment-requests.ts`, `expenses.ts`, `instructor-wallet.ts` | Does not prove hardened end-to-end settlement/provider flow |
| Hardened financial source composition | Factory only | `services/financial-source-composition.ts`, billing SQL/services | Not composed in production; requires connection-bound sealed audits, verified schema and explicit payment/payout provider orchestration |
| Tenant export | Mounted fail-closed | `routes/tenant-export.ts`, startup option in `index.ts` | Ownership remains unavailable unless explicit catalog verification succeeds; migration files alone are insufficient |
| Video/media | Mounted, large legacy surface | `routes/videos.ts`, `secure-video.ts`, `video-assets.ts`, MinIO/FFmpeg services | Requires configured MinIO/FFmpeg and careful access-policy regression testing |
| Exams, results and grading | Mounted | `routes/exams.ts`, `exam-versions.ts`, `manual-grading.ts`, reporting routes | Real schema may differ from migration inventory; expiry/grading jobs require bounded lifecycle checks |
| Reporting/admin/platform controls | Mounted in multiple bounded surfaces | admin/report routes in `index.ts` | UI presence is not proof of cross-role end-to-end readiness |

## Known verification checkpoint

At the 2026-10-25 audit:

- frontend build and TypeScript checks passed;
- backend TypeScript build passed;
- conflict-marker check passed;
- selected new server suites passed (203 assertions/tests in the selected run);
- focused course-publication and branding suites passed;
- broad legacy M2 runs still showed failures concentrated in lecture, group
  announcement and group schedule harnesses after the merge.

Do not reuse these counts as fresh proof. Run relevant tests again after edits.

## Historical M2 status

`docs/streams/client/M2-REMAINING.md` ends with M2-23 as the final consolidated
non-OTP batch, but its coordination record stopped at a WorkBuddy rate limit.
The later `main` merge contains **partial** M2-23 source. Inspect the exact paths
listed in `docs/streams/client/M2-23-HANDOFF.md`; do not treat either the old
STOP record or the presence of some files as a current completion verdict.

