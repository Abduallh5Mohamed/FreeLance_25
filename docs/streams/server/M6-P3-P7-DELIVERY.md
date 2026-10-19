# M6 P3+P4+P5+P7 — consent ledger, outbox delivery, channel gates, parent reports (2026-10-18)

## Files changed
- `server/src/services/notification-consent.ts` — P3 append-only consent domain
  (M6 P3 spec).
- `server/src/services/delivery-channels.ts` — P5 channel gate policy, PII
  redaction helpers and the injected adapter interfaces (no provider code).
- `server/src/services/notification-outbox.ts` — P4 event outbox (idempotency,
  bounded-backoff retries, bounce/failed states), locale templates with escaped
  variables, signed expiring links on a dedicated secret, and the P7
  parent-report funnel. Extends — never breaks — the existing
  `notification-preferences` contract (its exports/tests are untouched and
  re-used: `NOTIFICATION_CHANNELS`, `isNotificationChannel`).
- `server/src/routes/notification-consent.ts` — P3 consent router
  `createNotificationConsentRouter(deps)` plus production-wired default
  instance (real pool + real auth injected lazily; no runtime DDL).
- `server/migrations/20261018_14_notification_outbox_consent.sql` — idempotent,
  guarded schema file, authoring-only, NOT executed (registered in the M1
  bootstrap manifest as outlined below).
- `server/bootstrap/m1/manifest.json` — added the new migration's SHA-256
  source hash and an explicit "not executed" unresolved note, matching the
  generator workflow (`scripts/build-m1-bootstrap.mjs` refuses unknown
  inventory).
- `server/tests/m6-notification-consent.test.ts` — 16 hermetic tests.
- `server/tests/m6-notification-outbox.test.ts` — 24 hermetic tests.
- `docs/streams/server/M6-P3-P7-DELIVERY.md` — this note.

## P3 — consent validated (`notification-consent.ts`)
- **Append-only ledger** `notification_consent_events`: `recordConsent` only
  ever INSERTs; the fake-DB test guards literally reject `UPDATE`/`DELETE`
  surfaces. Latest event per (user_id, user_type, purpose, channel) wins;
  `seq` (AUTO_INCREMENT UNIQUE) is the deterministic tie-breaker at second
  granularity.
- **Deny-by-default:** no events = quiet defaults (in-app on, email/whatsapp/
  sms off), mirroring `notification-preferences`.
- **Purpose × channel x source:** purposes =
  `announcements|lesson_updates|schedule_changes|billing_reminders|
  progress_report`; sources = `account_settings|stop_message|unsubscribe_link|support`.
  `parseConsentInput` rejects unknown fields, non-enum values, and any client
  attempt to self-assert a system source — the owner route forces
  `account_settings`, the owner id is `recorded_by`, and consent time is the
  injected server clock (`recorded_at`).
- **STOP honored immediately:** `recordChannelStop` appends a revoke for every
  purpose on the channel in one call; because the delivery gate
  (`canDeliverTo`) re-reads the ledger and the outbox re-checks consent at
  dispatch time, a STOP cancels even already-queued rows with zero latency.
- **Re-consent:** a later grant after a STOP re-opens delivery (history keeps
  all three events; tests assert the append-only sequence
  grant→stop_message→grant).
- Route surface: `POST /` (opt-in/out), `GET /` (bounded history), `GET
  /state` (effective purpose:channel map), `POST /stop` (whole-channel stop),
  `POST /unsubscribe-link` (signed token mint), `POST /unsubscribe`
  (signed-link path, intentionally unauthenticated before the auth gate).
  Tenant/ownership isolation: user_type is the server-derived role
  (`student|parent|admin|instructor`; others 403), every statement is bound to
  the token identity (cross-tenant/cross-user tests assert only the caller's
  rows are ever touched).

## P4 — event outbox (`notification-outbox.ts`)
- **Idempotency:** `enqueueOutboxRow` validates strictly (no junk rows:
  channel/locale/purpose/length bounds, payload object, maxAttempts 1–10),
  then inserts keyed by a caller idempotency key; a duplicate key re-queues
  nothing and returns `{duplicate: true}` (also backed by
  `uq_outbox_idempotency`).
- **Bounded backoff:** `outboxBackoffSeconds` ladder 60s/300s/1800s/7200s,
  capped at 86400s; `max_attempts` default 5, ceiling 10.
- **Dispatch is claim-guarded and fail-closed:** a conditional
  `status='pending' AND next_attempt_at <= now` UPDATE transitions to
  `sending` (one winner; concurrent dispatchers skip), consent is re-checked
  after claiming (STOP → `cancelled` without any adapter contact), terminal
  states are `sent`/`failed`/`bounced`/`cancelled`, retries return to
  `pending` with a scheduled `next_attempt_at`. No adapter configured for a
  channel retries then fails closed — it never silently drops.
- **Receipts:** every attempt outcome writes a `notification_delivery_receipts`
  row (sent proof / failed / bounced / cancelled reasons, digit-masked) and a
  sanitized dispatch log (`sanitizeDeliveryLog`) that contains only
  outboxId/channel/eventType/outcome/digit-masked reason/HMAC `contact_ref` —
  no phone numbers or message bodies reach logs or receipts.
- **Locale templates:** `renderOutboxTemplate(eventType, 'ar'|'en', vars)`
  with strict handling — unknown event/locale rejected, unknown or missing
  variables rejected, scalars of 1–2000 chars only, HTML output escaping
  (`<script>` payloads verified neutralized), text output control-char
  neutralized, and a post-render assertion that no `{var}` leaks.
- **Expiring links:** `signSecureLink`/`verifySecureLink` bind a JSON payload
  (kind/ref/user/purpose/channel) plus `exp` and a random `jti` with
  HMAC-SHA256, compared via `timingSafeEqual`.
  `resolveLinkSecret` requires `NOTIFICATION_LINK_SECRET` ≥ 32 bytes and
  **fails closed** (`LinkSecretMissingError` → route 503): a missing/short
  secret can never mint or verify a link.

## P5 — WhatsApp/SMS channels (`delivery-channels.ts`)
- **Adapters are injected interfaces only** (`SmsChannelAdapter`,
  `WhatsAppChannelAdapter` with an async `send` returning
  `sent|failed|bounced` + an arbitrary provider `proof`). No provider, SDK or
  network call exists in this tree; real providers are **deferred** and the
  deployer injects the adapter at wiring time (documented here, no index.ts
  change was made).
- **Refuse-to-send gate** `gateChannelSend`: denies unless (a) a non-empty
  phone, (b) opt-in (the caller evaluates the server-side consent gate first —
  a STOP of any source denies), (c) verified number (injected
  `VerifiedNumberChecker` reading server rows, never client input) and (d)
  approved template id (injected `ApprovedTemplateChecker`). Each failure has
  a distinct typed reason and the deny never reaches the adapter.
- **No PII in delivery logs:** `contactRef` = HMAC-SHA256(24 hex chars);
  `maskPhone` = last-4 only; `sanitizeProof` drops every PII-shaped key and
  digit-masks remaining strings (with an explicit allow-list for
  `message_id`/`msgid`/`provider_status`); `redactPiiText` masks digit runs
  ≥ 6 and collapses whitespace so provider echoes cannot leak numbers.
  `last_error` and receipt `detail` are masked by the same helpers.

## P7 — parent report delivery (in `notification-outbox.ts`)
- **Verified link only:** `enqueueParentReportDelivery` takes an injected
  `ParentLinkChecker.isVerifiedLinkedParent({tenantId, parentUserId,
  studentEnrollmentId})`. `parent-links.ts` is deliberately not imported; an
  unlinked child, a foreign tenant or an opted-out parent results in
  `{ok:false, reason}` **with zero writes** (`state.executed.length === 0`
  asserted for the link check).
- **Only configured summary fields:** `buildParentReportVars` accepts an
  allow-list (`student_name`, `attendance_summary`, `grade_summary`,
  `progress_summary`); configured-but-missing values, non-scalar values, a
  missing period/name or a deny on unconfigured fields fail closed before any
  queue write. Unconfigured fields never appear in the message body.
- **Queue + links:** the row's payload variables include signed,
  expiring report and unsubscribe tokens minted from the dedicated
  link secret; the rendered `ar`/`en` subject/body carry only the allowed
  fields and the receipt from dispatch (sent/failed) is the channel proof and
  success/failure receipt for the report.

## Schema (file only, never executed)
`server/migrations/20261018_14_notification_outbox_consent.sql`:
- `notification_consent_events` — append-only ledger; PK id, UNIQUE seq,
  tenant/user/purpose/channel indexes. No FK by design: consent history
  survives identity cleanup and can never be cascaded away.
- `notification_outbox` — idempotency key UNIQUE, status
  `pending|sending|sent|failed|bounced|cancelled`, attempts/max_attempts,
  next_attempt_at, delivered_at; `fk_outbox_tenant` → tenants(cascade).
- `notification_delivery_receipts` — per-attempt outcome + sanitized proof +
  digit-masked detail; `fk_receipt_outbox` → outbox(cascade).
- Every statement is guarded by an INFORMATION_SCHEMA probe
  (+PREPARE/EXECUTE) so re-running is a no-op; no DROP/TRUNCATE/data rewrite.
- Registered in `server/bootstrap/m1/manifest.json` (sourceSha256 + explicit
  "not executed / needs isolated approval" unresolved note), consistent with
  the `scripts/build-m1-bootstrap.mjs` inventory check.

## Deferred (documented, not silently promised)
- Real WhatsApp/SMS/email providers: adapters are injected interfaces; a
  production adapter (provider SDK, credential binding, sandbox verification)
  is required and must be reviewed before any live send. Until wired, dispatch
  fails closed (no adapter → retry → terminal failed).
- Consent webhook ingestion (provider STOP callbacks) and the parent report
  scheduler are producers that should call `recordChannelStop` /
  `enqueueParentReportDelivery` from their own wiring; they are out of scope
  here so only tested seams are exposed.

## Test evidence
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m6-notification-consent.test.ts` — 16/16 pass.
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m6-notification-outbox.test.ts` — 24/24 pass.
- Full suite with tsx --test server/tests/*.test.ts run twice (see task summary).
- All tests are hermetic: fake SQL interpreter + injected clock/adapters; no
  MySQL, no provider, no network, no .env reads.
