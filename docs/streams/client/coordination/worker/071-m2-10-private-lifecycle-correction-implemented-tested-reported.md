# M2-10 private lifecycle correction — implemented, tested, reported

Task `client-m2-10-private-lifecycle-correction-20261021-01` (taskKind
`correction`) · worker `opencode-m2-10-render-gate-and-iso-correction` · branch
`codex/human-client`. Status **reported** (not accepted). Independent Codex
review required; a worker report is not acceptance.

Scope read before editing: `supervisor/188`, `supervisor/189`,
`M2-10-HANDOFF.md`, `M2-10-CONTRACTS.md`, the actual six-path source and the
stopped predecessor report `worker/070`.

## Changed paths — the exact six allowed, three of them touched

1. `src/features/catalog/CourseUnitManager.tsx` — render-time private-child
   gate.
2. `src/features/catalog/course-lessons.ts` — real canonical-instant
   validation.
3. `src/tests/m2-course-lesson-ui.test.ts` — 8 new regressions (68 → 76).
4. `docs/streams/client/M2-10-CONTRACTS.md` — the corrected behaviour and the
   actual check results.

`src/features/catalog/CourseLessonManager.tsx` and `src/lib/api-http.ts` were
inspected and needed **no** change: the transport is additive and types the
lesson DTO without interpreting instants, and the lesson panel renders only.
No backend, schema, router, shared helper, package, config, provider, player,
`Courses.tsx` or student-import path was touched. All pre-existing dirty work
and the accepted 183 unit UI / 185 backend were preserved.

## 188 finding 1 — the private child was mounted before the passive effect

**Before:** the child was mounted whenever a selection existed
(`lessonUnitId ? <CourseLessonManager …>`), so a parent that had just become
`denied` / `unauthorized` / `no-workspace` / `missing-course` / `malformed`, or
whose settled page no longer held the selected row, still rendered the private
lesson panel for that render; only the passive effect cleared the selection
afterwards.

**After:** a render-time derived gate mounts the child only while the parent
scope is permitted AND the settled page still holds the selected row
(`CourseUnitManager.tsx:158-181`, mount at `:376-385`). The gate mirrors the
lifetime effect EXACTLY — the same `privateScopeLost` and the same
`settledWithoutRow` rule — so the rendered child and the cleared selection can
never disagree and no stale remount follows. A transient `loading` phase is
still not a settled page, so a loading parent that still holds the selected row
keeps the child. The effect itself and the accepted unit controls are unchanged.

## 188 finding 2 — impossible timestamps were accepted as valid DTOs

**Before:** `parseCourseLesson` checked `created_at` / `updated_at` with the
shape regex only, so `2026-99-99T88:77:66.000Z` and
`2026-02-30T00:00:00.000Z` were confirmed as valid lessons.

**After:** a new `isCanonicalInstant` guard (`course-lessons.ts:472-489`) parses
the value as a real date, requires a finite instant and requires an EXACT
`toISOString()` round-trip of the same canonical string. Impossible fields and a
normalized calendar overflow are refused; there is no fallback date and no
coerced value. Both timestamps are checked, so the list, single-write and
reorder envelopes inherit the rule. Consequence, verified by test: a 2xx body
carrying such an instant is now **uncertain**, never a confirmed write, it
triggers no follow-up read, it preserves the draft and it is never retried.

## Commands and outcomes

| Command | Outcome |
| --- | --- |
| `.\node_modules\.bin\tsx.cmd --test src/tests/m2-course-lesson-ui.test.ts` | 76 tests, **76 pass**, 0 fail (68 prior + 8 new) |
| `.\node_modules\.bin\tsx.cmd --test` on `m2-course-unit-ui` + `m2-course-management` + `m2-tenant-branches-ui` + `m2-tenant-profile-ui` + `m2-tenant-profile-edit` | 254 tests, **254 pass**, 0 fail (unchanged) |
| the same six client files in one run | 330 tests, **330 pass**, 0 fail |
| `.\node_modules\.bin\tsx.cmd --test` on the unchanged public 188 probe | 6 tests, **6 pass**, 0 fail (was 2/6) |
| `.\node_modules\.bin\tsx.cmd --test` on the unchanged public 179 probe | 3 tests, **3 pass**, 0 fail |
| `.\node_modules\.bin\tsc.cmd --noEmit -p tsconfig.app.json` | exactly the **known 11** diagnostics, all outside these six paths; **zero** scoped |

The local `tsx` / `tsc` binaries were invoked directly from `node_modules\.bin`
(no `npx` fetch, no install). The public probes were read only; no probe file
was modified.

## The 8 new regressions (all in the allowed test path)

- parse: an impossible / calendar-overflow / hour-24 / minute-60 instant is
  refused in `created_at` AND in `updated_at`, while the valid canonical control
  still passes;
- parse: one impossible instant invalidates the whole list, single-write and
  reorder envelope;
- write: a 2xx create with an impossible instant is uncertain, confirms nothing,
  preserves the draft, is not retried and triggers no follow-up read;
- write: a 2xx PATCH with an impossible instant leaves the row untouched, is
  unconfirmed and is not retried;
- reorder: a 2xx batch with an impossible instant is never applied, reports no
  `lastReorder` and is not retried;
- parent: a lost scope (denied / unauthorized / no-workspace / missing-course /
  malformed / closed) renders **no** private child before the passive effect
  runs;
- parent: a settled page that no longer holds the selected row renders **no**
  child before the effect runs;
- parent: a permitted parent that still holds the selected row — and a transient
  `loading` that retains it — still renders the child.

The parent regressions drive the REAL `CourseUnitManager` through the REAL
React server renderer with the effects recorded and NOT run, so they observe
the render itself rather than the post-effect state.

## Bounds (structural, not measured)

One bounded 25-row page and ≤25 selected ids in memory · one write flight · at
most one bounded follow-up read after a confirmed write · no per-row background
request · no automatic mutation retry · no cross-page or cross-unit ordering.
These are source and fixture bounds; no latency, scalability or physical-lock
claim is made, and nothing here was measured.

## Limits (not claimed)

No DOM paint, no real RTL layout, no browser, no real HTTP, no DB, no live
service, no install, no migration application (the accepted migration file is
still FILE-only), no server-side authorization exercised end to end — the server
remains the only authority. The pre-existing 11 type diagnostics outside these
paths are unchanged and are not fixed here. No new product, access, OTP,
import, financial or provider surface. No performance measurement. The whole
M2 and the C5 rollout remain open.

Done is the M2-10 correction scope only. Codex decides acceptance.
