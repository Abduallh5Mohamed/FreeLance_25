# M2 server contract — current implementation and unresolved boundaries

Worktree `codex/workbuddy-server`. This records reviewed current behavior;
it is not an acceptance of all C1/C4/C5/C8/C10 or permission to deploy.

## Public identity / discovery

- `GET /api/public/teachers/:id`: active teacher identity; safe id/name,
  optional active owned center id/name and bounded active-course projection.
  No private identity, payment, media-key or staff fields are selected.
  Each course must belong to an active tenant. Missing teacher:404;
  database failure:generic500 without raw exception details.
- `GET /api/public/courses`: bounded limit1–100, offset0–100000, optional
  grade/subject/search; prepared string LIMIT/OFFSET parameters. Active tenant
  and course required. Safe fields: id/name/subject/description/grade/price.
- **Unresolved C4 publication:** `courses.is_active` currently doubles as
  non-archived activity and defaults true on creation. There is no distinct
  course publication flag. These endpoints do not prove draft isolation.
  A deliberate publication contract/schema and migration validation is needed
  before claiming complete public catalog acceptance; activity is not proof
  of publishing intent. No new publication policy was guessed in this pass.

## Enrollment lifecycle

- `PUT /api/student-enrollment/:id/lifecycle`: authenticated existing teaching
  authority, selected tenant and exact instructor enrollment. Unknown row404;
  invalid term/status/date-window400; database or audit failure500.
- Fields: term (up to60 chars), enrollment_status active/revoked/expired,
  enrollment_start_date, enrollment_end_date. A finite window is half-open:
  start inclusive, end exclusive, compared to server UTC. No financial status,
  price or client assertion of payment is used as an entitlement grant.
- Existing locked row and effective updates are audited in the same
  transaction. Audit failure rolls back the lifecycle mutation.
- Workspace selection rechecks lifecycle eligibility. The common SQL
  principal repository also filters lifecycle status and UTC boundaries on
  every authenticated selected-enrollment request: a previously valid JWT
  no longer resolves after expiry/revocation and receives401 WORKSPACE_REVOKED.
  Existing NULL lifecycle values remain the documented legacy representation;
  inactive/unapproved tenant/enrollment checks still apply.
- **Deployment prerequisite:** new lifecycle columns are in the unexecuted
  `20261018_01_m2_identity_catalog_enrollment.sql` draft. No SQL was executed
  for this batch. Missing schema fails closed; do not deploy source before
  a separately approved isolated migration/bootstrap/live validation.
- OTP delivery remains deferred; signup verification503 is preserved. No
  external provider, new payments, wallet policy or unverified signup bypass.

## Catalog write controls

Lecture ordering/archive and before/after audit are being hardened together;
the delivery report records the exact reviewed routes and tests. Parent-course
and current lecture rows must be locked inside the transaction, branch-derived
authority retained, stale row sets rejected, and audit failure rolled back.
Archived lectures cannot be republished by ordinary update. No frontend,
custom domain/TLS, drip/sequential progression or import flow is accepted here.
