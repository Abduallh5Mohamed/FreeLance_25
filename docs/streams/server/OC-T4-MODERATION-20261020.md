# OC T4 — moderation hardening (correction pass T4c) — 2026-10-20

Status: **reported**, not accepted. Supervisor/Codex acceptance is separate.
Scope basis: `docs/streams/server/OPENCODE-EXECUTION-PLAN-20261020.md`,
`docs/streams/server/OPENCODE-SCOPE-CONFIRMATION-20261020.md` (T4 section, mandatory)
and `docs/streams/server/OPENCODE-REVIEW-CORRECTIONS-20261020.md` item 5.

## Correction (T4c)

The first pass closed `lesson_discussion_reports` in the decision transaction with
the mapping `dismiss -> dismissed`, every other decision -> `reviewed`. That mapping
is NOT established by any contract and is now held. The report-closing UPDATE and
the assertions that depended on it have been removed; reports are left `open` after
a decision. The table/enum is untouched.

Contract verification performed (explicit statement of a decision -> report status):

- `docs/17-full-feature-backlog.md` rows O4 (`content moderation/reports | P6/C4 | queue, evidence, decision/reason, appeals, tenant notification, reviewer permissions`) and P6 (`lesson comments and Q&A | ... | moderation/report/block; deletion/retention and notification rules`): no decision -> report-status mapping.
- `docs/streams/server/M7-O4-DELIVERY.md` and `docs/streams/server/M6-P6-DELIVERY.md`: describe the report table (`status open|reviewed|dismissed`) and the moderation queue; no decision -> status transition is specified.
- Migration `server/migrations/20261018_16_lesson_discussions.sql` (lines 104-129) and `server/migrations/20261018_18_moderation.sql`: define the enum and the `moderation_cases.report_id` FK; no transition rule.
- `server/src/services/lesson-discussions.ts` comments (lines 34-36, first pass): only stated that a case "closes it once, to `reviewed` or `dismissed`" — no per-decision mapping.
- Moderation decision/appeal/restore semantics (`MODERATION_DECISIONS`, `contentActionForDecision`, appeals, `restore_content`) specify content-side actions only; none state which report status follows.

Conclusion: no contract establishes `dismiss -> dismissed` and other decisions ->
`reviewed`. The mapping is held. No alternative semantics were introduced.

## Files changed (only the allowed list)

| File | Change |
| --- | --- |
| `server/src/routes/moderation.ts` | removed report-close call from `applyDecision`; evidence snapshot (G16) and transaction sharing preserved |
| `server/src/services/moderation.ts` | removed `reportResolutionForDecision`, `ModerationStore.closeReport` and its SQL delegation; removed now-unused lesson-discussions import |
| `server/src/services/lesson-discussions.ts` | removed `setReportStatus` from store contract/SQL impl and the `ClosedReportStatus`/`CLOSED_REPORT_STATUSES` exports |
| `server/tests/m7-moderation.test.ts` | removed report-close dependent assertions; G16 + transaction-sharing tests retained |
| `server/tests/m6-lesson-discussions.test.ts` | removed `setReportStatus` seam test |
| `docs/streams/server/OC-T4-MODERATION-20261020.md` | this report |

No other file was written. `index.ts`, auth/middleware, `db.ts`, helpers,
migrations, manifest, frontend, bridge, search/export/video/billing/outbox/
assignments files and provider/DB/network resources were not touched.

## Hashes (sha256, full)

BEFORE (captured at the start of this correction pass = AFTER of the first pass):

```
f0832f73577361eef6773af0f9a871dec9b5cc654f603b9cefaa0365d75b90ea  server/src/routes/moderation.ts
e6369f6039c398a74d5955051b0e1772fc5f7038af371ce73029ce849bd689f6  server/src/services/moderation.ts
8a727cbe5e20cafa1fbe1249cc8863b48ea1955ab2a2049ee0531feabeacc5c2  server/src/services/lesson-discussions.ts
7a9945b0892558a7d7d85a5a1e3b1ea6feac29ca4a131db8ab94aadf61d5388b  server/tests/m7-moderation.test.ts
7b9ab29cb63e868a1ad1f96ab6d9b2ae0088aca3991dd890bf8a42c2ce3703b5  server/tests/m6-lesson-discussions.test.ts
f287bbd51a7f9a4e53d0cd2ae2a6d317acb7708331ba3c25ee39d45c87a90d3e  docs/streams/server/OC-T4-MODERATION-20261020.md
```

AFTER (this correction pass):

```
817b68d86c5dc3cae63bb0b2f904a174fdfe317110955623a70519b4f5936a1b  server/src/routes/moderation.ts
119f9559da0d122647bdd8ede34e7c8fbc695d03cdb5302746eca50e23e08ccc  server/src/services/moderation.ts
33024ac8816d12451585b082ff68fb22f9f9f9befd5f30f344571d28d6d46329  server/src/services/lesson-discussions.ts
8687a3619a829541ddf955e9dc916f4d5b4f12bc2ea2cd3e0163d089db00c92e  server/tests/m7-moderation.test.ts
4130f9a6ea651f524f90ddd0b03f119d11154fbf6e5839b89f2103b1a178de08  server/tests/m6-lesson-discussions.test.ts
(this report has no meaningful before hash; it is updated)
```

## Defect 1 — evidence snapshot was not tenant-bound (kept, unchanged)

Unchanged from the first pass: `ModerationContentGateway.snapshotEvidence` takes
`tenantId` first; every production evidence read carries `AND tenant_id = ?`;
`createModerationContentGateway(db)` is exported for hermetic testing.
Test retained: `POST /cases: the production evidence gateway binds the report
tenant (a target from another tenant never resolves)`.

## Defect 2 — source report left `open` after a decision (HELD)

The report-closing UPDATE and the `dismiss -> dismissed / others -> reviewed`
mapping have been removed. A decision no longer mutates `lesson_discussion_reports.status`;
the report stays `open`. The table/enum (`open | reviewed | dismissed`) is untouched.

Removed (assertions that depended on the held mapping):
- m7: `POST /cases/:id/decision: dismiss closes the source report as dismissed in the same store`
- m7: `POST /cases/:id/decision: a content decision closes the source report as reviewed`
- m7: `POST /cases/:id/decision: if the report cannot be closed the decision is a 409 and the report stays open`
- m7: `reportResolutionForDecision uses only the schema's existing report closing values`
- m7: `SQL store: closeReport only closes an open report within the same tenant`
- m7: `decision: the report close uses the transaction connection and rolls back with a failed audit`
- m6: `report: setReportStatus closes an open report once, with a tenant-bound open-state guard`

Preserved independently valid fix — evidence mutation and decision audit share the
actual transaction (G16-related transaction seam):
- m7: `decision: the content action runs inside the same transaction as the case update and audit` (unchanged, still passing).

## Unresolved policy (held)

- Which decisions (if any) should close a source report, and as which status
  (`reviewed` vs `dismissed` vs a new value)?
- What happens on appeal: does an appeal reopen or change the report status?
- What happens on `restore_content`: does it reopen a previously closed report?
- Does a decision that touches no content (`dismiss`) differ from a content-changing
  decision for report status?
- Whether closing should be atomic with the decision (as the first pass assumed) or
  a separate triage step, and what a failed close should do to the decision.

These require an explicit contract decision before any mapping is reintroduced.

## Held (not changed, reported)

| Item | Why held | Anchor |
| --- | --- | --- |
| Restore of a soft-deleted target | `restore` uses `setThreadStatus(...,'open')` / `setReplyStatus(...,'visible')`, whose SQL requires `deleted_at IS NULL`; a soft-deleted row yields 0 rows -> existing `409`. No undelete contract (decision D5). No blanket 409 was added. | `server/src/routes/moderation.ts:785,789`; `server/src/services/lesson-discussions.ts:499,508` |
| Retention / purge | 180-day retention is hard-coded twice and no purge job exists; retention policy/purge authority is undecided (D5/G15). | `server/src/routes/moderation.ts:786,790` |
| Appeal deadlines | No deadline field in `moderation_appeals` and no deadline check in the appeal route. | `server/src/routes/moderation.ts:490-560`; `server/migrations/20261018_18_moderation.sql:110-126` |
| Branch-scoped moderator authority | Authority is tenant-wide only (`TENANT_AUTHORITY_SQL` has no branch predicate); branch scoping is a product decision. | `server/src/routes/moderation.ts:797-805` |
| Report-status closing | No contract establishes a decision -> report status mapping (see above). | `server/src/services/lesson-discussions.ts:34-37` (enum only) |

## Focused test results (actual, after correction)

```
node node_modules/tsx/dist/cli.mjs --test server/tests/m7-moderation.test.ts
# tests 33  # pass 33  # fail 0

node node_modules/tsx/dist/cli.mjs --test server/tests/m6-lesson-discussions.test.ts
# tests 35  # pass 35  # fail 0
```

Typecheck observation (provisional while other writers are active):

```
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
(no output — exit 0 at this snapshot)
```

## Limits

- Hermetic/injected-dependency tests only; no MySQL, Docker, network, provider or
  `.env` use. SQL behavior is asserted through statement text and a recording
  data access, not a live server.
- Real transaction isolation, concurrent decisions and MySQL ENUM behavior are
  unproven here.
- The working tree contains other writers' uncommitted edits; no Git operation,
  full-suite run, merge or commit was performed.
- No `any`, `ts-ignore`, assertion weakening, dependency change or migration edit
  was introduced.

## Stop

Writing has stopped. No further edits were made after this report.
