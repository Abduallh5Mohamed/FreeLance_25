# M4 A6 / A7 / A8 Delivery

## Scope
- A6 gradebook: points/weighted policy visible to students, Decimal-safe grade recomputation, tenant-scoped staff permissions and an audited, formula-safe CSV export.
- A7 student progress and reports: progress status/aggregate computation, tenant/branch report scoping, deny-by-default parent projection of published reports, and CSV formula-injection neutralization shared with the export surface.
- A8 certificates: eligibility policy, server-minted unique verification id, minimal public verification, revocation, immutable-once-issued rows and tenant branding capture.

## Files
- server/src/services/gradebook.ts
- server/src/services/progress-reports.ts
- server/src/services/certificates.ts
- server/src/routes/gradebook.ts
- server/src/routes/certificates.ts
- server/migrations/20261018_10_gradebook_certificates.sql
- server/bootstrap/m1/manifest.json (reviewed manifest inventory update, hash-anchored via `scripts/build-m1-bootstrap.mjs`)
- server/tests/m4-gradebook.test.ts
- server/tests/m4-certificates.test.ts

## Behavior

### A6 — gradebook
- **Weights policy visible to students.** `GET /api/gradebook/me` (and `GET /api/gradebook/progress`) now return the full policy — `mode`, `passing_score`, `rounding` and the per-category `weights` — not just the resulting score, so a student can see exactly how the grade is computed. A malformed stored `categories` JSON fails closed to `[]` instead of a 500.
- **Decimal-safe recompute.** `calculateGrade` runs entirely on fixed-point integers (scores at `GRADE_SCALE = 1e4`, the resolved percentage at `PERCENT_SCALE = 1e6`) over `BigInt`, with the single final rounding applied in the caller's rounding mode (`half_up` / `half_even` / `none`). The same stored `DECIMAL` entries therefore always recompute to the exact same grade, free of floating-point drift.
- **Scoped permissions.** Every staff read/write binds the caller's server-derived tenant (`WHERE tenant_id=?`), the tenant authority row is re-read per request, and students are rejected from staff surfaces. Tests assert the bound tenant is the caller's, never a body/claim value.
- **Audited CSV export with neutralization.** `GET /api/gradebook/export` renders through `toCsv`, which prefixes any spreadsheet-active leading character (`= + - @ TAB CR LF`) with a single quote before quoting, and writes a `gradebook.export` audit row; an audit failure aborts the response with 500.

### A7 — progress and reports
- Progress status (`not_started` / `in_progress` / `completed`), weighted overall aggregation (ignoring absent components), and the canonical report projection are pure and tested.
- `filterReportsByTenant` / `filterReportsByBranch` scope teacher views (a tenant-wide `null` branch does not narrow); `projectProgressForParent` is deny-by-default until `published === true` and exposes only aggregate fields (never the enrollment id or raw score breakdown).

### A8 — certificates
- **Eligibility policy.** `isEligibleForCertificate` / `evaluateCertificateEligibility` enforce the threshold plus lesson/assignment/exam conditions before an issue is allowed; an ineligible request is rejected 400.
- **Unique unguessable id.** The server mints the verification id from 32 CSPRNG bytes (64 hex chars, UNIQUE in MySQL); a client-supplied `verification_id` is ignored. `generateCertificateId` is 16 bytes / 32 hex.
- **Minimal public verify.** `GET /api/certificates/verify/:verificationId` is unauthenticated and returns only the verification id, status, issue time, course/tenant display names, final score and tenant branding — never internal ids, the enrollment id or issuer identity.
- **Revocation.** `POST /api/certificates/:id/revoke` is staff-scoped and tenant-scoped, transitions `issued -> revoked` once (a second attempt is 409) and audits old/new values; the public verify then reports `status: revoked`.
- **Immutable once issued.** There is no endpoint that mutates an issued certificate's score, course or enrollment; the only permitted transition is revocation. Eligibility is re-checked and a duplicate enrollment/course issue is rejected 409.
- **Tenant branding.** Branding (logo URL + primary/secondary/accent colors + locale) is captured onto the certificate row at issue time and surfaced with the minimal public verification facts.

## Tests
- New/updated: `server/tests/m4-gradebook.test.ts` (20 tests) and `server/tests/m4-certificates.test.ts` (15 tests), covering the acceptance criteria above plus anonymous/cross-tenant/student denial, duplicate-issue, revoke idempotency, decimal-safe recompute, formula-injection neutralization and audit emission.
- The `m4-certificates.test.ts` "issue requires eligibility" failure was a test-fixture defect, not a production bug: the fixture authenticated an `instructor` principal without the active instructor account the shared auth middleware requires, so the request was denied 403 before eligibility was evaluated. The fixture now supplies that account; the eligibility and anti-forgery assertions are unchanged.
- Typecheck: `tsc --noEmit` clean.
- Full suite: green, run twice.

## Deferred
- The migration is authoring-only (idempotent `INFORMATION_SCHEMA` guards + `PREPARE`/`EXECUTE`); it is not executed against MySQL.
- Both routers export a factory plus a default-wired production instance and are not mounted in `index.ts` per task rules.
- Branch scoping for reports is provided as a pure, tested service helper; record-level `branch_id` wiring belongs to the enrollment/reporting stream (P2/A7 UI) that owns that projection.
