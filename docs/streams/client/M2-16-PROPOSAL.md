# M2-16 proposal: audited idempotent student-row import

Status: **approved, claimed and implemented; reported for independent review — not
self-accepted**.

Implementation was completed by WorkBuddy under
`client-m2-16-audited-idempotent-student-import-20261021-01` across the exact 13
allowed paths of `M2-16-HANDOFF.md`, and a native MCP worker report was filed
for Codex review. A worker report is not acceptance: the batch is accepted only
by the supervisor's independent review.

Accepted M2-08/11/14/15 now provides bounded parsing, explicit local decisions,
read-only tenant reconciliation, existing-match review and a local report. The
next real C12 step would mutate tenant student data, so its product decisions must
be explicit before an exact WorkBuddy task is published.

## Recommended bounded policy

- Import creates **student rows only** for the selected active tenant. It creates
  no user/account, password, invitation, OTP, enrollment, course/group assignment,
  payment or access.
- Only rows currently included and confirmed **clear** by a fresh reconciliation
  may be submitted. A row with any existing email/phone/barcode match is refused;
  a local kept review does not authorize overwrite, merge or duplicate creation.
- One explicit confirmation submits one bounded batch. The server revalidates the
  exact values and tenant authority inside the transaction; client reconciliation
  is advisory and never a write authorization.
- A caller-generated opaque idempotency key identifies the exact canonical batch.
  Same key plus same canonical payload returns the recorded result; same key with
  different payload is a conflict. No silent retry creates extra students.
- The transaction writes student rows and one sanitized audit/import record
  atomically. A partial batch never commits. Response reports submitted physical
  row numbers and outcome counts, without passwords, secrets or unrelated student
  data.

## Approved human product decisions

1. Confirm student-row-only creation with **no account/access/enrollment**.
2. Confirm every existing-value match is a hard refusal; no keep/overwrite/merge.
3. Confirm atomic all-or-nothing batch behavior rather than partial success.
4. Confirm an idempotency/audit migration **file** may be added but not applied.

These four decisions were approved by the user's direct request for the next
WorkBuddy task. The exact backend+client scope, tests and completion criteria are
published in `M2-16-HANDOFF.md`. Publication is not execution: an actual WorkBuddy
MCP claim/checkpoint is still required.

## Decision record

| When | Decision |
|---|---|
| 2026-10-21 | the four bounded product decisions above were approved by direct human request, and the task was published for a manual WorkBuddy claim |
| 2026-10-21 | WorkBuddy claimed `client-m2-16-audited-idempotent-student-import-20261021-01` under `M2-16-HANDOFF.md`; the claim was preserved with no redispatch |
| 2026-10-22 | the 13 allowed paths were implemented: the transactional `/commit` route beside the accepted read-only `/resolve`, the additive `student_import_batches` migration FILE (never applied), the hermetic server harness plus two server suites, the client commit controller and its panel wiring, the additive `commitStudentImportBatch` adapter, the client suite, and the `M2-B09` / `M2-16` contracts |
| 2026-10-22 | the specified suites and scoped types were run, all edits and checks stopped, and a native MCP worker report was filed with the claim token, changed files, verified behaviour, test/type results and the remaining limits |

No decision in this record expands the approved scope, applies the migration,
uses a live database/network/browser, or accepts the batch. Acceptance remains
with the independent supervisor review.

