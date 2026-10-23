# M2-11 privacy/resource/index correction — implemented, tested, reported

Task `client-m2-11-privacy-resource-index-correction-20261021-01` · worker
`opencode-worker-072` · branch `codex/human-client`. Status **reported**
(not accepted; Codex review required). Consumes supervisor **194/195** and
supervisor **196** (which keeps the NEW M2-12 branding batch on WorkBuddy's
disjoint paths and leaves this correction with OpenCode).

Predecessor state preserved: the WorkBuddy 071 implementation and its accepted
170 CSV parser and 080 enrollment suites were left intact; no owner was
interrupted or retired.

## Changed paths — six allowed, five written, one deliberately untouched

1. `src/features/students/import-report.ts` — structured-finally cleanup, a
   `retire()` that releases the outstanding URL without disposing the seam.
2. `src/features/students/import-resolution.ts` — one included-row index per
   conflict calculation, `revalidateScope()` scope seam.
3. `src/features/students/StudentImportPreview.tsx` — guarded export before any
   materialization, immediate URL retirement on the lifecycle events.
4. `src/tests/m2-student-import-resolution.test.ts` — 43 → 50 tests (7 new
   correction regressions).
5. `docs/streams/client/M2-11-CONTRACTS.md` — corrected arithmetic, the three
   corrections, the measured operation bound.
6. `src/features/students/csv-preview.ts` — **NOT modified** (last write
   2026-10-19 23:29, before this correction). The accepted controller already
   clears its private rows on a close, a refusal and a session change, and the
   decision seam exposes the same canonical principal observation, so the
   "additive lifecycle integration" was not necessary. Verified unchanged on disk.

No `InstructorStudents.tsx`, import API, lesson path, backend, schema, auth,
shared helper, package, config, provider or player change. No storage,
clipboard or network write. No migration, no service, no install.

## The three 194 failures, before → after

**F1 — former-principal export (194 probe 2).** Before: `downloadReport` read
`seam.getState()` without re-reading the canonical principal, so a silent
logout allocated a Blob, a URL and a link for the former scope's rows.
After: a FRESH guarded principal snapshot is taken through the SAME canonical
reader (`readInstructorSessionPrincipal`, re-exported by the accepted
`csv-preview.ts`) BEFORE any materialization. A mismatch clears the preview,
the decisions, the report metadata and the pending selection, retires the
outstanding URL, refuses the action and allocates NOTHING. No stale report or
message survives a mismatch, and the panel stays usable for the current scope.

**F2 — link/URL cleanup and retirement (194 probe 1).** Before: a throwing
`link.click()` revoked the URL but never removed the created link, and the
outstanding URL was only retired on unmount. After: the cleanup runs in a
STRUCTURED `finally`, so the created link is removed EXACTLY ONCE whether the
creation, the configuration, the click or the scheduling failed; a URL is
revoked AT MOST ONCE; the scheduled revocation takes ownership only after the
click (a synchronously-run scheduled task can no longer double-revoke). The new
`retire()` releases the outstanding URL IMMEDIATELY without disposing the seam
(a later valid click still works) and is called on a replaced file, a reset, a
close, a lost principal and a lost session.

**F3 — quadratic conflict scan (194 probe 3).** Before: 1000 pending rows in
one candidate group cost 1,000,000 candidate-member reads for an EMPTY conflict
map, because each row re-filtered the whole group. After: ONE index of the
included rows, keyed by the exact nonempty field/value, is built per
calculation, and every row is a bounded key lookup. The group's member list is
never traversed. The exact trim/case/leading-zero/blank semantics, the
overlapping chains, the included-set semantics and the actual blocking row
references are unchanged.

## Commands and outcomes (all run in this session)

| Command | Outcome |
| --- | --- |
| `node_modules\.bin\tsx --test src/tests/m2-student-import-resolution.test.ts src/tests/m2-student-csv-preview.test.ts src/tests/m2-instructor-students.test.ts` | **173 tests, 173 pass, 0 fail** = 50 NEW + 123 UNCHANGED |
| `node_modules\.bin\tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/194-m2-11-independent-probes.test.ts` (public probe, unmodified) | **3 tests, 3 pass, 0 fail** — it was **0/3** before this correction |
| `node_modules\.bin\tsc --noEmit -p tsconfig.app.json` | exactly the known **11** diagnostics, all outside these paths; **ZERO** scoped |

Baseline arithmetic corrected: the predecessor's report labelled the UNCHANGED
baseline as "166". The real split is 43 original new + 123 unchanged = 166
before this correction, and 50 new + 123 unchanged = **173** after it. The
contracts file now states this explicitly.

## New regressions (7, in the existing allowed suite)

- every native failure of the materialization (`createObjectURL`, `createLink`,
  the `href`/`download`/`rel` setters, `click`, `remove`, `schedule`,
  `revokeObjectURL`) with the exact expected cleanup;
- `retire()` releases the outstanding URL at once and keeps the seam usable;
- the whole-file conflict lookup reads ZERO group members for 1000 pending
  rows in one group, and still names the exact blocking row once one is
  included (a deterministic OPERATION bound, not a latency measurement);
- an overlapping chain inside a large group resolves on the exact blocking
  rows;
- the REAL report control refuses a former-principal export before any
  allocation and clears the former scope's decisions;
- the REAL reset, close and file-replacement controls retire the outstanding
  report URL at once;
- a REAL session loss (through the real session notifier and the real mount
  effect) retires the outstanding report URL of the live panel.

## Limits and uncertainties (honest)

- NO latency, throughput or browser benchmark was measured. The conflict bound
  is a measured OPERATION COUNT (group-member reads), not a performance claim.
- The component's own mount effect is exercised through a small
  `useState`/`useRef` store against a synthetic `document`/`URL` boundary, not
  through a browser DOM: the session-notifier wiring is proven, the paint is not.
- A link whose `remove()` throws is contained (the download already happened and
  the URL is still retired on the scheduled tick); the removal is attempted
  exactly once and the failure is never propagated.
- A `schedule` failure is reported as a failed materialization (`failed`), so
  the caller is never told about a report whose promised URL lifetime could not
  be established.
- The 11 known frontend diagnostics remain outside these paths and are
  untouched.
- Whole C12/M2 remains open. No import, no server, no account, no OTP, no
  financial effect, no platform-uniqueness claim.

## Next owner action

Codex independent review of the actual source, contracts, tests and type
diagnostics. No self-acceptance is claimed. The OpenCode worker timer
`Tabweb-OpenCode-Worker-15min` is DISABLED (verified: State=Disabled) and was
not changed; the Codex supervisor review cadence remains 15 minutes
(`Tabweb-Codex-Supervisor-15min`, Ready, next 02:50:19 Cairo at report time).
