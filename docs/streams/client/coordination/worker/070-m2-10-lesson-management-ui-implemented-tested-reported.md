# M2-10 private lesson-management UI — implemented, tested, reported

Task `client-m2-10-lesson-management-ui-20261021-01` · worker
`workbuddy-native-m2-10-lesson-ui-20261021` · branch `codex/human-client`.
Status **reported** (not accepted). Independent Codex review required.

## Changed paths — the exact six, nothing else

1. `src/lib/api-http.ts` — additive lesson DTO + four adapters only.
2. `src/features/catalog/course-lessons.ts` — new injected controller.
3. `src/features/catalog/CourseLessonManager.tsx` — new Arabic/RTL panel.
4. `src/features/catalog/CourseUnitManager.tsx` — additive per-row selection +
   keyed child mount; accepted 183 controls/lifetimes untouched.
5. `src/tests/m2-course-lesson-ui.test.ts` — new 68-test isolated suite.
6. `docs/streams/client/M2-10-CONTRACTS.md` — actual behaviour/checks/limits.

No backend, schema, router, shared helper, package, config, provider, player or
`Courses.tsx` change. The accepted migration stays FILE-only and was not applied.
Pre-existing dirty work was preserved untouched.

## Commands and outcomes

| Command | Outcome |
| --- | --- |
| `npx tsx --test src/tests/m2-course-lesson-ui.test.ts` | 68 tests, **68 pass**, 0 fail |
| `npx tsx --test` on `m2-course-unit-ui` + `m2-course-management` + `m2-tenant-branches-ui` + `m2-tenant-profile-ui` + `m2-tenant-profile-edit` | 254 tests, **254 pass**, 0 fail (unchanged) |
| the same six files in one run | 322 tests, **322 pass**, 0 fail |
| `npx tsc --noEmit -p tsconfig.app.json` | exactly the **known 11** diagnostics, all outside these paths; **zero** in the six scoped paths |

The public179 supervisor probe is supervisor-owned and not worker-executable;
the local regression that underpins it is green.

## Source bounds

One page of ≤25 rows in memory · selection ≤25 current-page ids (the server's
100 is never used to widen it) · cursor 1..256 · description ≤10000 · order
0..2147483647 · exactly one write flight · at most one bounded follow-up read ·
no per-row background fetch · no cross-page accumulation.

## Before → after

Before: unit rows managed units but there was no lesson surface at all in the
client. After: an explicitly selected unit row opens a bounded private lesson
panel with list/paging, create, edit title/description/order with explicit
`null` clearing, separate archive/reactivate, and an atomic selection reorder —
with truthful errors, explicitly uncertain writes, and safe close/session/
selection lifetimes. No lesson child survives a hidden or denied view.

## Design points worth review

- The mutation's **own** latch ticket is released after server confirmation and
  **before** the bounded follow-up GET is awaited, so an enabled control is
  never a silent no-op (179/183). The monotonic ticket source means an older
  `finally` cannot free a newer latch — both are pinned by tests.
- The 25-row **response** bound is enforced in the parser *before* any row is
  traversed or copied.
- A reorder response must be the exact requested identity set (no duplicate,
  extra, missing or foreign id) before anything is applied.
- A failed follow-up read sets `refreshError` and never turns a confirmed save
  into a failed save.
- The parent clears the child on close, on private-scope loss, and when a
  **settled** page no longer holds the selected row; a transient `loading` phase
  is not a settled page and does not tear it down.

## Limits (not claimed)

No DOM paint, no real RTL layout, no browser, no real HTTP/DB/live service, no
install. Server authorization is not exercised end-to-end and remains the only
authority. Migration FILE-only, **not applied** → no runtime rollout. Paging is
position-based, so a concurrent reorder between two reads can duplicate or hide
a row — stated in the UI, not hidden. No lesson content/assets/uploads/
publication/student-teacher assignment/access-policy/OTP/financial surface. No
performance measurement.

Done is the private lesson-management UI only — not full C5, not M2, not a
rollout. A worker report is not acceptance.
