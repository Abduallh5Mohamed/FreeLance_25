# Codex client source inventory — 2026-10-22

## Scope and evidence limits

Read-only review of `src/App.tsx`, page/request sources and `docs/streams/client/M1-HANDOFF.md`, against currently mounted server routes. The parent assigned the client lane to Codex for this new remaining-platform task; the historical docs20 split is context, not evidence that the client is complete. No client/source file was edited, no tests/typecheck/browser/service/Git/network operation was run.

Inventory found 76 `.tsx` files directly in `src/pages` and 79 `<Route ...>` declarations in App (including redirects and the development-only route). Counts are discovery aids, not feature completion percentages. Existing pages cover teacher/student/admin/instructor flows, catalog, students, exams, grades, attendance, meetings, messages, payments and support. Do not replace those flows wholesale or call the frontend entirely missing.

## Confirmed current defects / contract holes

| Priority | Current source evidence | Consequence / acceptance requirement |
|---|---|---|
| P1 | `EditExam.tsx:244` loads exam questions with bare fetch; `:751` and `:964` upload question images without Authorization. `server/src/routes/exams.ts:991` requires authenticate; image upload `:961` uses protected teaching access. | Existing editor cannot use those protected operations with canonical Bearer session; preserve question/forms on rejection. Attach canonical auth transport, do not weaken backend. |
| P1 | `TeacherExams.tsx:761` image upload similarly lacks auth; direct create/add requests already use `authToken`. | Use the same canonical credentials for upload, check HTTP success and typed response before reporting success. |
| P1 | `TeacherExams.tsx:186` compensation DELETE ignores `response.ok`; controller around `:143–149` catches and suppresses deletion failure, returns `rolled-back`; toast around `:436–442` says it rolled back. | False compensation success can leave an orphan exam. Distinguish question failure from cleanup failure; retain created exam ID and user inputs, prevent blind duplicate creation. |
| P1 | `ManualGrading.tsx:111/:121/:140/:215` raw fetch calls have no Authorization. `/manual-grading/pending` and `/submit` require auth in backend `manual-grading.ts:215/:312`. Grade/group loads also omit `response.ok` checks before assigning JSON. | Existing legacy manual-grading screen has partial single-flight/error retention logic, but protected requests must carry the canonical token. 401/403 must not become an empty pending list or success. |
| P1 | `ExamReview.tsx:147` review GET has no Authorization while backend `exams.ts:2037` requires authentication. The page already has explicit status classification and stale-response guards. | Repair request construction while preserving current 401/403/not-found/error and stale-result handling; do not rewrite the page. |
| P1 | `StudentReports.tsx:291` and `:402` use `localStorage.getItem('token')`; canonical transport `src/lib/api-http.ts:24/:29` uses `authToken`. | Notes calls can send `Bearer null` or the wrong token. Use canonical session source; keep data/draft on write rejection. |
| P2 | `StudentReports.tsx:150–160` catches each student-results error and ignores it while building a report map. | A denied/unavailable results source can look like no results. Surface incomplete/error state, avoid exporting or representing missing protected data as a complete report. Confirm product presentation rather than fabricate grades. |
| Contract integration | Exact endpoint searches in client sources found no `/exam-manual-grading`, `/progress-reports` or `/attendance-reports` references. The mounted ManualGrading page still uses legacy `/manual-grading`. | New B2 versioned grading/publication/attendance-report server APIs are not connected in this client snapshot. Define explicit adapters/types/states and correct routes; legacy grading is not evidence of versioned grading UI. |
| Contract integration | Exact source searches found no `parent-links`, `tenant-export`, `platform-mfa` or `impersonation` endpoint references, and App has no parent route. | These server feature surfaces require client contract/UI discovery and allocation. Absence of exact references proves no direct integration by those names, not absence of every related capability or dynamically composed URL. |

## Existing infrastructure that should be preserved

- `src/lib/api-http.ts` has a shared request helper attaching the canonical `authToken` and throws for non-OK responses. There is no need to invent another token key.
- The helper currently throws a plain Error, losing structured HTTP status/code for callers; a later shared-client task should preserve a typed error contract while retaining existing billing-only and suspended-tenant behavior. Do not mix that cross-cutting change into the first narrow page correction without ownership.
- Several exam pages already implement single-flight controls, form retention, sequence guards and explicit denial UI. These are partial fixes to complete, not remove.
- App mounts role-protected teacher/student/admin/instructor flows. Current auth User role union has no parent; parent provisioning and legal relationship contracts need coordination with the backend owner rather than inventing a browser-only role.

## Recommended first safe implementation slice

**Task CLIENT-EXAM-AUTH-COMPENSATION:** own only `src/pages/EditExam.tsx`, `src/pages/TeacherExams.tsx` and its scoped report initially; add a test path only when testing is explicitly requested/authorized by the parent. Read shared transport/backend contracts without editing them.

1. Attach canonical Bearer auth to questions and every image-upload request, using request-time token lookup so credentials are not captured stale.
2. Check HTTP success before accepting an uploaded URL; retain input on 401/403/503 or malformed responses.
3. Check compensation DELETE status; return an explicit cleanup-failed outcome carrying created exam ID and original failure. Show accurate recovery information and prevent accidental resubmission that recreates the orphan.
4. Preserve existing saved fields, group association, partial questions, stale-response/single-flight controls and existing API contracts. Do not add backend transactions or change grading semantics.

This slice touches no backend files owned by Claude/WorkBuddy and can be implemented independently once source ownership is confirmed.

## Remaining client work buckets requiring named tasks

1. Complete historical M1 page request fixes: exam authoring/review/manual grading, student-management form contracts, attendance status/races, meetings/support stale-state and subscription clocks. Re-verify each inherited finding before changes.
2. Wire B2 versioned grading, published progress reports and attendance exports with schema-unavailable503 and truncation UX; parent surfaces depend on legal relationship/provisioning contracts.
3. Gradebook/assignment lifecycle and private upload status UX depend on WorkBuddy contracts; do not fake scanner completion.
4. Enrollment/import multi-teacher institution flow and billing/invoice/collection/wallet/refund/payout screens depend on Claude canonical APIs; old service-credit wallet is not merchant funds.
5. Playback/live/device/revocation and usage UX depend on WorkBuddy provider/rights contracts; no permanent raw URL or mock success in production.
6. MFA/step-up/support impersonation banner, tenant export/admin operational UI need explicit scopes and API contracts.
7. RTL/English/accessibility/responsiveness, error/empty/loading distinction and real browser/device end-to-end verification remain evidence gates, not proven by page-file counts.

## Cross-cutting acceptance rules

- No demo/mock/fallback success on production paths. Server response is authoritative for mutations, payment, grading, attendance, scan and permissions.
- 401 requires session recovery; 403 remains permission denied; 503 shows temporarily unavailable and retains appropriate drafts. None means empty data or successful action.
- Scope/user changes invalidate stale sensitive responses. Failed write retains authored data and prevents duplicate submission; GET/CSV failure never silently yields a complete empty report.
- Use existing API method/path/body/success/error/time/money-unit contracts. Conflicts are raised to the owning backend lane, not patched by weakening server authorization.
- Client-side role guards are UX boundaries, not authorization proofs. Server ownership must be checked on actual protected calls.

## Stop state

Only this report was written. Client source remains untouched. Writing stopped after report delivery. Source review is not browser or integration-test evidence.

## Implementation handoff — subsequent parent authorization

The initial read-only stop state above is historical. The parent subsequently assigned a narrow source correction in `src/pages/EditExam.tsx` and `src/pages/TeacherExams.tsx` only. Those two files and this report were changed; no other client/shared/server/test file was edited.

### Own changes

- EditExam question GET and both question-image POSTs now obtain the canonical `authToken` at request time and attach a Bearer header. Upload FormData keeps the browser-generated Content-Type/boundary. Upload success also requires HTTP success, a success response and a nonempty string `imageUrl`; failure preserves the existing question draft.
- TeacherExams image upload now has the same request-time Bearer header and success checks. Missing or malformed/failed responses show failure rather than success and do not overwrite the authored image field.
- Compensation DELETE now rejects non-OK HTTP responses. The controller retains the original question failure and created exam ID in a distinct `cleanup-failed` outcome with the cleanup error, rather than falsely returning `rolled-back`.
- After cleanup failure the controller refuses another creation until an explicit successful deletion of that same exam is confirmed. The controller is instantiated per page component instead of storing this private recovery state in a module-global singleton. The page retains its course/form/questions, disables creation, shows the partial exam ID and offers review or an explicit delete retry.
- The review link uses the existing `/teacher/exams/:examId/edit` route registered in `src/App.tsx:159`; no router or endpoint contract was added. A successful existing delete clears only the matching local recovery gate.

### Source hashes after correction

| File | SHA256 |
|---|---|
| src/pages/EditExam.tsx | 6eae046357a4cc0f0e246c2e3904108134ffd64c11785d9429daaca984a57fbf |
| src/pages/TeacherExams.tsx | 04918e1f80bfb49da7562d7235b4f6b4de7451815f3c06935e98fbc1aef9b977 |

### Unverified / residual limits

No test, typecheck, browser or service was run and no test was added under the parent's explicit instruction. The new outcome union/controller lifecycle and JSX changes require later authorized validation; existing tests may need stronger truthful-compensation expectations, not weaker assertions. Source inspection is the evidence in this handoff, not a green-suite claim.

Recovery state is in memory for this component lifetime, not persisted across refresh/navigation. The backend still lacks an atomic create-with-all-questions operation; this client change makes its compensation failure truthful and prevents blind duplicate creation within the active form. An ambiguous DELETE that committed but lost its response is not declared successful; no new server idempotency semantics are invented. Server responses remain authoritative. Writing has stopped after this handoff; no acceptance or whole-feature completion is claimed.
