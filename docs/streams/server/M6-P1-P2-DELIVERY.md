# M6 P1+P2 — parent-student verified linking and read-only parent views (2026-10-19)

Spec rows: `docs/17-full-feature-backlog.md` M6 — **P1 parent-student verified
linking** (`single-use challenge to verified contacts; authorization/revocation/
session tests`) and **P2 read-only parent progress/attendance/grades**
(`only linked child and published fields; parent cannot mutate student state`).
Contract context: `docs/contracts/M2-IDENTITY-CATALOG-ENROLLMENT.md` (enrollment
lifecycle, OTP deferral, tenant isolation).

## Files
- `server/src/services/parent-links.ts` — P1/P2 domain policy: canonical contact
  normalization, enrollment-activity decision, scoped HMAC view-token
  sign/verify, the parent-links service (`requestLink`/`verifyLink`/`listLinks`/
  `getLinkById`/`revokeLink`/`issueSessionToken`), the scoped token verifier, and
  the SQL store.
- `server/src/routes/parent-links.ts` — `createParentLinksRouter(deps)` +
  production default-wired instance (`POST /request`, `POST /verify`, `GET /`,
  `POST /:id/revoke`, `POST /:id/session`).
- `server/src/routes/parent-views.ts` — read-only `createParentViewsRouter(deps)`
  + production default-wired instance (`GET /child`, `GET /lesson-progress`,
  `GET /attendance`, `GET /grades`) authenticated only by the scoped token.
- `server/migrations/20261018_13_parent_links.sql` — idempotent, authoring-only
  schema (`parent_links`, `parent_view_tokens`); never executed at runtime.
- `server/tests/m6-parent-links.test.ts` — 24 hermetic tests over the real route
  factory, the real identity-otp service and a fake delivery adapter.
- `server/tests/m6-parent-views.test.ts` — 18 hermetic tests over the real view
  router and the real scoped-token verifier.
- `server/bootstrap/m1/manifest.json` — the migration is registered with its
  SHA-256 (`bcd1a2f1…cb47b`); verified via the generator (see below).
- `docs/streams/server/M6-P1-P2-DELIVERY.md` — this note.

## P1 — verified linking
- **Proof before trust.** A link row is created only after a single-use OTP
  challenge bound to `contact + purpose(contact_verification) + tenant +
  identity` is verified *and* re-asserted consumed. The OTP lifecycle is the
  shared `IdentityOtpService`, so one-time submission, expiry, attempt caps,
  resend cooldown and contact/tenant/identity binding are identical to
  enrollment. The code is only ever handed to the injected delivery adapter and
  is never returned by a route or logged.
- **Verified contacts only.** The contact must equal the student's registered
  guardian/parent phone or email; a mismatch or unknown student is `404` before
  any challenge is written.
- **Authorization is deny-by-default.** Revoke is allowed only for the link
  owner, an active tenant staff authority (`owner`/`instructor`, loaded with a
  tenant-scoped query), or the linked student; everyone else gets `404`, so link
  existence is never confirmed. An already-revoked link is `409`.
- **Sessions are owner-only and short-lived.** `POST /:id/session` mints a fresh
  scoped token only for the owning parent of an active link; TTL is clamped to
  900s.
- **Fail-closed configuration.** A missing/unconfigured OTP service yields `503`
  on `request`/`verify`; a missing or too-short `PARENT_VIEW_SECRET` yields `503`
  after a successful proof rather than a non-null assertion.

## P2 — read-only views
- **Scoped token only.** Every route is authenticated solely by an
  HMAC-SHA256 token over `PARENT_VIEW_SECRET` (≥32 bytes), bound to
  `jti + link + tenant + enrollment + parent`. The verifier re-reads the token
  record and the link on **every** request, so a revoked link or token (or an
  expired record/claim) denies the next request immediately. A foreign-tenant,
  enrollment-mismatched, forged, tampered or unknown token is `401`.
- **Only the linked child.** The child, progress, attendance and grades queries
  take `(tenant_id, enrollment_id)` exclusively from the verified token claims;
  no route accepts a student id from the client. Other children in the same
  tenant are never resolvable.
- **Published fields only.** Lesson progress counts only
  `lectures.is_published = 1 AND archived_at IS NULL`; the child projection omits
  contact, guardian, address and note columns and never uses `SELECT *`.
- **Cannot mutate.** The view router declares GET routes only (asserted directly
  against the router stack) and the views store exposes read methods only; the
  routes issue no `INSERT`/`UPDATE`/`DELETE`.

## Endpoints
Parent links (authenticated principal):
- `POST /request` — `202` challenge, `200` already-linked, `400` invalid body,
  `404` unknown student/contact mismatch, `429` throttled, `503` OTP absent.
- `POST /verify` — `201` linked, `200` already-linked (fresh token), `400`
  wrong/replayed code, `404` unknown student, `503` OTP/view secret absent.
- `GET /` — the caller's own links only.
- `POST /:id/revoke` — `200` owner/staff/student, `404` otherwise, `409`
  already revoked/changed concurrently.
- `POST /:id/session` — `200` fresh token for the owning parent, `404`
  not-owned/not-active, `503` view secret absent.

Parent views (scoped token bearer):
- `GET /child`, `GET /lesson-progress`, `GET /attendance` (`limit` 1..200,
  default 100), `GET /grades`.

## Schema (file only, not executed)
- `parent_links` — `UNIQUE (tenant_id, student_enrollment_id, parent_user_id)`
  makes a duplicate link idempotent; `status`/`version`/`revoked_at`/`revoked_by`;
  stores only `contact_hash`, never the contact.
- `parent_view_tokens` — `jti` PK plus the revocation/expiry record checked on
  every request; `link_id` cascades with its link.
- Idempotent via `INFORMATION_SCHEMA` probes + `PREPARE`/`EXECUTE`; FKs added
  under separate name-guarded steps so an interrupted run converges. No DROP,
  TRUNCATE, FK-disable or data rewrite.

## Migration registration
Re-ran the generator to a throwaway destination:

```
node scripts/build-m1-bootstrap.mjs <temp-dir>
```

It staged all 47 tracked migrations plus the collation/prelude files
(`staged 50`), confirmed `20261018_13_parent_links.sql` is present in
`sourceSha256` (`bcd1a2f1b8c12f152e31f4f1a006f06dc1016683984003194066bce32adcb47b`),
and matched the reviewed manifest. `server/tests/m1-bootstrap-plan.test.ts`
passes (2/2). No SQL was executed against a database.

## Tests
- `m6-parent-links.test.ts` 24/24 — allow + deny + cross-tenant + validation +
  failure for every handler: anonymous `401`, invalid body `400`, unknown
  student/contact mismatch `404`, single-use replay `400`, cross-tenant challenge
  `400`, OTP-missing `503`, view-secret-missing `503`, owner/staff/student revoke
  allow and foreign `404`, session owner-only, list isolation, and storage-error
  `500` with no write.
- `m6-parent-views.test.ts` 18/18 — token round-trip/tamper/foreign-secret,
  missing/malformed/forged/unknown/revoked/expired-token `401`, expired-claims
  `401`, revoked-link `401`, foreign-tenant/enrollment-mismatch `401`,
  secret-missing/short `503`, only-linked-child, other-child-never-returned,
  scoped progress/attendance/grades, attendance-limit default/clamp/validation,
  read-only GET-only router, storage-error `500`, and SQL-store scoping /
  published-only projection / no-write assertions.
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json`
  clean. (Fixed the reported `parent-links.ts(429,31) TS18048` by using the
  already-null-checked local OTP reference and by signing inside the atomic block
  with the validated secret, removing an `as string` cast.)

## Open questions / follow-ups
- **Routers are intentionally unmounted.** Both modules export a factory and a
  production default-wired instance; no `server/src/index.ts` mount was added by
  this task (`index.ts` is outside this task's allow-list; mounting is a later
  step).
- **Deployment prerequisite.** The schema file is an unexecuted draft; source
  must not be deployed before a separately approved isolated migration/bootstrap
  run, per the M2 contract. Missing schema fails closed.
- **Provider/network deferred.** OTP delivery and WhatsApp/SMS are P3–P5 and are
  provider-injected; no network or provider call is made here.
