# WorkBuddy — notifications lane closure (W9-R1 / W9-R2 / W9-R3)

Task: `server-closure-notifications-20261022-01` · team `backend` · group `notifications`
Worker: `wb-closure-notifications-20261022-01` · branch `codex/workbuddy-server` · HEAD `cab9120`
Report written: 2026-10-22. No Git mutation, no DB, no Docker, no service, no provider, no secret, no migration, no test-assertion change.

This document is a **self-report of source work**, not a phase acceptance. Nothing here claims a live send, a mounted worker, or an applied schema.

---

## 0. Baseline, scope and method

The 14 `allowedPaths` were hashed **before** any write and matched `WORKBUDDY-THREE-LANE-BASELINE-20261022.md` byte-for-byte (all 13 present files identical; the report file absent). Nothing was reset, cleaned, stashed or pulled. Three of the 14 files were edited (below); the other ten are byte-identical to the baseline and are recorded as inherited.

Pre-read (all read-only): `THREE-LANE-MASTER-20261022.md`, `THREE-LANE-FILE-OWNERSHIP-20261022.json`, `SERVER-REMAINING-INVENTORY-20261022.md` (§3 W9-R1/R2/R3, §7 D1/D3), `docs/19-commercial-registration-wallet-agreement-ar.md`, `docs/contracts/NOTIFICATION-WORKER-CONTRACT.md`, the task record, the pre-claim baseline, the six notification source files and the five notification test files, plus the read-only schema of `assignments`, `exam_versions`, `announcements`, `schedules`, `notification_outbox`, `notification_consent_events`, `notification_delivery_receipts`, and `server/src/index.ts`.

Inherited and **not** rewritten (supervisor-verified, 71 tests): `notification-worker.ts` lifecycle/fencing/unknown-quarantine, `delivery-channels.ts` adapters/readiness/redaction, `notification-outbox.ts` claim/dispatch/retry/receipts, `notification-consent.ts`, `notification-preferences.ts`, both routes, `utils/notifications.ts`. My additions are additive and delimited by section comments.

Method: implement → typecheck → run the five focused hermetic notification suites → verify each new path with a throwaway harness **outside the repo** (`%TEMP%\wb-notif-probe.ts`, deleted after use) → record. No committed test was added or modified, per the task's "source implementation only / do not add tests for existing modules" rule; the new paths are therefore labelled **untested** in the committed-suite sense and **probe-verified** separately.

---

## 1. W9-R1 — start/stop with the app, graceful shutdown, config/readiness, unknown-outcome reprocessing

Inventory text: *"تشغيل/إيقاف worker صراحة مع التطبيق وgraceful shutdown، config/readiness وإعادة معالجة unknown outcome"*.

| Part | State | Where |
|---|---|---|
| Explicit `start/stop/runOnce`, one owned timer, no import side effect, drain bound | **inherited, verified** | `notification-worker.ts` §Lifecycle (unchanged) |
| Fencing by `attempts` on every state write; stale sweep flags, never steals | **inherited, verified** | `notification-outbox.ts` `finishRow` / `recoverStaleSendingRows` (unchanged) |
| Config + readiness validation before construction | **implemented (new)** | `notification-worker.ts` `resolveNotificationWorkerStartup` |
| Reprocessing a quarantined `unknown` outcome | **implemented (new)** | `notification-outbox.ts` `reconcileQuarantinedOutboxRow` |
| Mounting in the app (`server/src/index.ts`) | **not wired — Codex-owned**, exact request in §6 | — |
| Real provider send / real timeout | **live-unproven** (no provider, by owner decision) | — |

### 1.1 `resolveNotificationWorkerStartup` (new, pure)

Validates, before `createNotificationWorker` is constructed: a non-empty server-resolved tenant, `NOTIFICATION_LINK_SECRET` ≥ 32 bytes, `NOTIFICATION_CONTACT_HMAC_KEY` ≥ 16 bytes, and at least one channel with a configured transport. It returns either `{ ready: true, config }` (tenant, link secret, HMAC key, channels, clamped `ResolvedWorkerLimits` via the inherited `resolveWorkerLimits`) or `{ ready: false, reasons }` with fixed codes `tenant-unresolved`, `link-secret-missing`, `contact-hmac-key-missing`, `no-ready-channel`.

Rationale: without this, a misconfigured process starts a worker that claims nothing (or fails per row on the link secret), and the failure is indistinguishable from "no work due". The function performs no I/O, creates no timer and sends nothing.

### 1.2 `reconcileQuarantinedOutboxRow` (new)

The contract (§5, §12.3) leaves a quarantined `unknown` row to *"an authoritative late result or an operator reconciliation"* — but no such path existed, so a quarantined row could never leave `sending`. This adds exactly one, explicit, operator-invoked resolver:

- reads `WHERE id = ? AND tenant_id = ?` (a foreign row is `not-found`, never read into a decision);
- only resolves a row that is actually quarantined (`status='sending'` **and** `last_error` ∈ {`provider-outcome-unknown`, `stale-claim-unconfirmed`});
- `provider-delivered` → `sent`, `last_error = NULL`, `delivered_at = UTC_TIMESTAMP()`, receipt `sent` with `sanitizeProof`-filtered proof;
- `provider-not-delivered` → `pending` with `last_error = reconciled-not-delivered` and `next_attempt_at = now` (one bounded retry; the attempt counter is **not** reset), receipt `failed` with that detail;
- every write carries `AND status='sending' AND attempts = ?` — the same fence as the dispatcher, so a concurrent claim invalidates it (`transition-rejected`);
- refuses to release at the attempt cap (`attempt-cap-reached`) instead of silently burning the row;
- requires `actorId`; the actor appears only in the injected log entry, never in a receipt or `last_error`.

It is deliberately **not** a route and **not** a poller: an admin/ops surface is Codex's file and authority (see §6.5).

**Verified (probe groups 7–9):** delivered → `sent` + receipt with `message_id` and the phone-shaped proof key dropped; not-delivered → `pending` + marker + `next_attempt_at = now`; wrong tenant → `not-found` and the row untouched; non-quarantined → `not-quarantined`; capped → `attempt-cap-reached` with the row still `sending`; empty actor → `actor-required`.

**Status: implemented / probe-verified / not mounted / untested in a committed suite.**

---

## 2. W9-R2 — producers (academic, schedules, results), recipient resolution, consent, receipts, failure classification, unknown outcome

Inventory text: *"producers من الجداول/النتائج/الإشراف/تقارير ولي الأمر، recipient resolver وconsent وتتبّع receipts"* with *"العقود والسياسات أولًا"*.

### 2.1 Policy ledger — what is settled, what is not

`NOTIFICATION_PRODUCER_POLICY` in `notification-outbox.ts` is the single, queryable record of each producer's status. A producer exists in code only where the owning domain's publication policy is already settled **in the repository**:

| producer | consent purpose | template | policy source (read-only) | status |
|---|---|---|---|---|
| `assignment_published` | `lesson_updates` | `assignment_published` | `assignments.status ENUM('draft','published','closed')` — `20261018_08_question_bank_assignments.sql` | **settled → implemented** |
| `exam_published` | `lesson_updates` | `exam_published` | `exam_versions.status ENUM('draft','published','archived')` + `published_at` — `20261018_09_exam_snapshots_grading.sql` | **settled → implemented** |
| `schedule_change` | `schedule_changes` | — | no settled trigger, lead time or audience rule (C3-R open) | **policy-held** — `schedule-change-policy-unsettled` |
| `results_available` | — (none exists) | — | results-release policy open (C1-R, D3: draft/submitted/retakes/release/archived) | **policy-held** — `results-release-policy-unsettled` |

The two held producers are **named in code and refuse by name**: `enqueueAcademicEventNotification` returns `{ ok: false, reason: 'event-policy-held', heldReason }` and writes nothing. They are not stubbed, not "TODO", and not guessed — a held event cannot be queued even if a caller passes a fully-populated request. `results_available` additionally has no consent purpose to route under, which is itself part of the open decision.

### 2.2 `enqueueAcademicEventNotification` (new)

Signature `(db, consent, authority, input)` mirrors the existing `enqueueParentReportDelivery(db, linkChecker, consent, input)` funnel. Authority order, all fail-closed, all before the first write:

1. **policy settled** (else `event-policy-held` + exact reason);
2. **tenant present** (`tenant-required`; never inferred from a request);
3. **resource + locale + baseUrl** validation;
4. **channels are external only** — `in_app` is rejected (`validation-failed`), an empty list is `no-external-channel`: in-app rows belong to the feed (`notifications` table), not the outbox;
5. **recipients** — deduped by `(userType,userId)`, `userType` must be a real consent namespace (`student|parent|instructor|admin`), bounded at `MAX_PRODUCER_RECIPIENTS = 500`;
6. **publication** — read through the injected `PublicationAuthority` (never asserted by the caller, never from client input). Not published / unreadable / missing `publishedAt` → `not-published`; `publishedAt` in the future → `publication-in-future` (content not visible yet);
7. **template renders** with the supplied variables (probe render) → `template-render-failed` before any consent read;
8. **consent for every (recipient, channel) pair, before any row exists** — a denied pair increments `consentDenied` and produces **no row**; an unreadable gate aborts the whole call (`consent-check-failed`) with nothing written;
9. one idempotent row per allowed pair, each with its own **signed, expiring, single-use** unsubscribe link (dedicated link secret, 24 h default, `jti` consumed by the existing route);
10. idempotency key = `acad:` + `sha256(tenant|event|resourceId|userId|userType|channel|publishedEpoch)[:40]` — deterministic per publication, ≤ 45 chars, so a re-publish (new `publishedAt`) notifies again while a retry of the same publication never duplicates.

Return value carries **counts only** (`queued`, `duplicates`, `consentDenied`) — never a recipient identity, contact or body. That is the "no recipient leakage" guarantee at the producer edge; the per-row fan-out means no recipient ever sees another recipient.

The worker still re-checks consent immediately before the adapter (inherited). The producer pre-check exists so a revoked recipient does not sit in the queue as noise; it does not replace the send-time check.

**Verified (probe groups 1–6):** both held events refuse with their exact `heldReason` and zero writes; unpublished / future / unreadable publication all refuse and write nothing; `tenant-required`, `in_app` rejection, `no-external-channel`, `no-recipients`, non-namespace `userType`, and a missing template variable all refuse with zero writes; a consent-denied recipient yields one row for the allowed recipient only, with a verifiable signed unsubscribe link, `purpose=lesson_updates`, `event_type=assignment_published`; replay returns `duplicates:1` and inserts only the newly allowed pair; the exam producer queues a row that `renderOutboxTemplate` accepts.

### 2.3 Recipient resolution — the production contact source is **held**, precisely

The worker resolves contacts through the injected `PurposeContactStore` (`findContactForPurpose({tenantId,userId,userType,channel,purpose})`). **No production implementation exists anywhere in the tree** (`grep PurposeContactStore src` → only the interface, the resolver and the worker dependency). It cannot be written inside my paths without inventing schema: a purpose-scoped contact source needs a purpose→contact mapping that does not exist (D3: *"consent ledger مقابل preferences ومعنى global/tenant/contact"*), and the legacy `users.email/phone` + `*_verified` columns are not purpose-scoped.

Therefore: **held**, with the exact seam named in §7.1. Until it exists, a wired worker with an empty/absent store fails closed (`contact-lookup-failed` → retryable, or `contact-missing` → permanent) and **never sends**.

### 2.4 Consent, receipts, failure classification, unknown outcome — inherited and unchanged

`consent` re-read per row from `notification_consent_events` (latest `seq` wins, STOP/unsubscribe deny), receipts written per attempt with sanitized proof and an HMAC contact ref, transient vs permanent vs `bounced` vs `unavailable` vs `unknown` classification, and `unknown` quarantined as `sending` + `provider-outcome-unknown` — all preserved byte-for-byte except the additive sections. The 71 inherited tests still pass unchanged (§8).

**Status: producers `assignment_published` / `exam_published` = implemented / probe-verified / not called by any route yet (call contract in §6.6); `schedule_change` / `results_available` = policy-held; production contact store = held; consent/receipts/classification = inherited-verified.**

---

## 3. W9-R3 — channel providers, templates, receipts, retry, failure classification

Inventory text: *"مزودا القنوات/templates/receipts/retry وتصنيف الفشل"*, with *"OTP/SMS/WhatsApp مؤجل بقرار المالك، يظل رفض آمن ولا نجاح وهمي"*.

| Part | State |
|---|---|
| Email adapter with injected transport; no transport ⇒ `unavailable` | inherited, verified |
| SMS adapter with injected transport; empty template ⇒ `template-not-approved` | inherited, verified |
| Retry ladder 60/300/1800/7200/86400 s, attempt cap, permanent failures | inherited, verified |
| Receipts with `sanitizeProof`, HMAC contact ref, no body/contact in `last_error` or logs | inherited, verified |
| `ar`/`en` templates for academic publication events | **implemented (new)** |
| Explicit deferral for OTP/SMS/WhatsApp (safe refusal, structural) | **implemented (new)** |
| Real provider selection, credentials, cost, sender identity | **held by owner decision (D1)** — no send attempted |

### 3.1 Templates (new, 2 events × 2 locales)

`assignment_published` (`assignment_title`, `course_name`, `due_at`) and `exam_published` (`exam_title`, `course_name`, `opens_at`, `closes_at`), both with `unsubscribe_link`, both going through the existing strict renderer: unknown event / unknown locale / extra variable / missing variable / non-scalar / > 2000 chars all reject; text is control-char-neutralized, HTML is escaped, `{close}` becomes the localized unsubscribe anchor, and a leftover `{placeholder}` fails the render. Copy is deliberately neutral — resource + server-formatted instant only. **No grade, score, rank or progress claim appears in any template**, which is what keeps the results-release question out of the message layer.

### 3.2 `createDeferredChannelAdapter` (new)

`createDeferredChannelAdapter('sms' | 'whatsapp', reason = 'channel-deferred-by-owner')` returns a `ConfiguredChannelAdapter` that reports `readiness() = { ready: false, reason }` and whose `send` answers `{ outcome: 'unavailable', reason }`. Registering it makes the owner's deferral **structural**: the worker filters unready registrations out of the claim (so no row is ever claimed), `send` cannot reach a provider, and an accidental call reports `unavailable` — never `sent`, never a fabricated message id. It also replaces the two failure modes of leaving the channel absent: silent `no-adapter` retries, or a future fake success.

`ConfiguredChannelAdapter.channel` was widened from `'email' | 'sms'` to `'email' | 'sms' | 'whatsapp'` (additive; `DeliveryAdapter.channel` already accepts `whatsapp`). No provider SDK, socket, credential or certificate is involved.

**Status: templates + deferral = implemented / probe-verified; real sends = live-unproven and unauthorized; OTP/SMS/WhatsApp provider = held by owner decision.**

---

## 4. File ledger — before → after (my own writes only)

`before` = pre-claim baseline hash/size; `after` = current bytes on disk.

| file | before sha256 | before bytes | after sha256 | after bytes | attribution |
|---|---|---|---|---|---|
| `server/src/services/notification-outbox.ts` | `4e52369b3afc83393b5e5abf4773ffd4791cc2dc9830e439df26d4b18fc3c97c` | 54593 | `215776b277ba549e79d5dd41b648de070d96b456907860fae48c978f3cb0aa02` | 75761 | inherited 1–1325 + **own** templates (2), producer section, reconciliation section |
| `server/src/services/notification-worker.ts` | `740141f24253fdb3bc2fa7ea95479e69d9cb0152d42144cbe2e90d301b7c7d0f` | 15839 | `40f44553c2cc62291827228e36dbb90383e7325ae79dba50a951f980f8717a45` | 19473 | inherited 1–419 + **own** `STARTUP_REASONS` / `resolveNotificationWorkerStartup` + one import |
| `server/src/services/delivery-channels.ts` | `7d973a674be38234e339451b38466bfaa976822d3a33c4120299a97906a55aa9` | 16511 | `01735b35745050d61e456d35808bbb48231fc75579193cdbac6053e9893210a7` | 17743 | inherited + **own** deferred-channel factory + widened channel union |
| `server/src/services/notification-consent.ts` | `6bb1cc0084c75a91448cb56d2cc2855ee5f6feac19c7e979ff57c30f6bf9fd40` | 13799 | *identical* | 13799 | inherited, untouched |
| `server/src/services/notification-preferences.ts` | `35e6a4d87de0064b67749cb7a97062373229121962c39ea8f331a258c646f2f7` | 5802 | *identical* | 5802 | inherited, untouched |
| `server/src/routes/notifications.ts` | `c4b3b53c873c6a7778597e28dff878851d3bf927882ec3ee73457e8cd1b25b64` | 7026 | *identical* | 7026 | inherited, untouched (still not a producer: no per-domain authority exists for a client-enqueued send) |
| `server/src/routes/notification-consent.ts` | `e0b85e22670700810c4d3e3c13d172057f06020ff7ba4baec4d4d3a522e3d459` | 17026 | *identical* | 17026 | inherited, untouched |
| `server/src/utils/notifications.ts` | `12083c6dee0b8585e67e41b0fa35282b01f76b05d1443486fbb4f731c9c8f912` | 4917 | *identical* | 4917 | inherited, untouched (legacy in-app helper, out of W9 scope) |
| `server/tests/m1-sprint-notification-support.test.ts` | `c8ba937c…75bab` | 32846 | *identical* | 32846 | **no test changed** |
| `server/tests/m6-delivery-channels.test.ts` | `270eee7a…50819` | 9917 | *identical* | 9917 | **no test changed** |
| `server/tests/m6-notification-consent.test.ts` | `12cf5a4a…de17e` | 32373 | *identical* | 32373 | **no test changed** |
| `server/tests/m6-notification-outbox.test.ts` | `4bc57e07…eb6d0` | 51508 | *identical* | 51508 | **no test changed** |
| `server/tests/m6-notification-worker.test.ts` | `81b1b1da…18608` | 35623 | *identical* | 35623 | **no test changed** |
| `docs/streams/server/WORKBUDDY-CLOSURE-NOTIFICATIONS-20261022.md` | ABSENT | – | this file | – | **own** |

Net: 3 source files edited (+581/−3 lines), 0 test files touched, 0 files outside `allowedPaths`, 0 new repo files.

---

## 5. Status lists

### 5.1 Implemented and verified (source-level)
- `resolveNotificationWorkerStartup` — exact reason codes, clamped limits (probe 10).
- `reconcileQuarantinedOutboxRow` — tenant-scoped, quarantine-only, cap-aware, fenced, receipted (probe 7–9).
- `NOTIFICATION_PRODUCER_POLICY` + `enqueueAcademicEventNotification` — publication-gated, consent-before-enqueue, idempotent, bounded (probe 1–6).
- `assignment_published` / `exam_published` templates, ar + en, through the strict renderer (probe 6).
- `createDeferredChannelAdapter` + `DEFERRED_CHANNEL_REASON` (probe 11).
- Inherited worker/outbox/consent/redaction guarantees: **121 focused hermetic tests pass unchanged** (§8).

### 5.2 Implemented but unproven
- **Untested in a committed suite**: all new functions. The task forbids adding tests for existing modules, so they are verified only by the throwaway probe; a committed test needs an explicit verification request.
- **Not wired**: the worker is still not mounted in `server/src/index.ts` (Codex-owned) → the app does not run it today.
- **No producer caller**: no route/service calls `enqueueAcademicEventNotification` yet (the academic lane owns those files) → no row is produced by the app today.
- **No production contact store** → a mounted worker could not resolve an email contact.
- **Live**: no provider, no real message, no real timeout, no real bounce. Every provider statement is proven against a recording transport only.

### 5.3 Held — named, not guessed
| held item | exact reason | owner / next step |
|---|---|---|
| `schedule_change` producer | `schedule-change-policy-unsettled` — no settled trigger (every edit? cancellation only?), lead time or audience rule (C3-R) | product decision → then a 20-line producer + 1 template |
| `results_available` producer | `results-release-policy-unsettled` — release policy open (C1-R/D3) **and** no consent purpose covers a result | product decision (release policy + purpose) → then producer |
| production `PurposeContactStore` | no purpose→contact source exists; needs schema (D3) | schema owner (Claude) + contract §7.1 |
| OTP / SMS / WhatsApp providers | deferred by owner (D1) | stays `unavailable` / unready; never a fake success |
| unknown-outcome reconciliation **route** | admin/ops authority + audit are Codex's files | Codex exposes the function (§6.5) |
| provider idempotency key / exactly-once | no provider contract | at-least-once + quarantine is the honest model |

---

## 6. Exact Codex integration request (startup / shutdown / readiness / producers)

`server/src/index.ts` was **not** edited. This is the contract, in the order Codex must apply it.

### 6.1 Imports (top of `index.ts`)
```ts
import {
  createConsentLedgerGate,
  createNotificationWorker,
  resolveNotificationWorkerStartup,
  toDeliveryAdapter,
  type NotificationWorker,
} from './services/notification-worker';
import {
  createDeferredChannelAdapter,
  createEmailAdapter,
  type PurposeContactStore,
} from './services/delivery-channels';
```

### 6.2 Handles (module scope, next to `videoQueueConsumer`)
```ts
let notificationWorker: NotificationWorker | null = null;
let notificationReaper: NodeJS.Timeout | null = null;
```

### 6.3 Start — inside the `httpServer.listen(...)` callback, guarded by `if (!skipDb)`, **after** the existing post-listen blocks
```ts
const startup = resolveNotificationWorkerStartup({
  env: process.env,
  tenantId: resolveNotificationWorkerTenant(),   // Codex-owned: server-resolved, NEVER a request value
  channels: emailTransport ? ['email'] : [],
  limits: { batchSize: 25, concurrency: 4, tickMs: 30_000, leaseMs: 900_000, drainTimeoutMs: 5_000 },
});
if (!startup.ready) {
  console.warn('[Notification worker] not started:', startup.reasons.join(', '));
  // report the same reasons on the readiness surface; HTTP keeps serving
} else {
  notificationWorker = createNotificationWorker({
    db: { query, queryOne, execute },                 // existing db helpers
    scope: { tenantId: startup.config.tenantId },
    adapters: [
      { adapter: toDeliveryAdapter(createEmailAdapter({ transport: emailTransport })), isReady: () => emailTransport !== null },
      { adapter: toDeliveryAdapter(createDeferredChannelAdapter('whatsapp')), isReady: () => false },
      { adapter: toDeliveryAdapter(createDeferredChannelAdapter('sms')), isReady: () => false },
    ],
    contacts: purposeContactStore,                     // BLOCKED until §7.1 exists — see the note below
    consent: createConsentLedgerGate({ query, queryOne, execute }),
    linkSecret: startup.config.linkSecret,
    hmacKey: startup.config.hmacKey,
    log: (entry) => console.info('[Notification worker]', entry),
    limits: startup.config.limits,
  });
  notificationWorker.start();
  notificationReaper = setInterval(() => { void notificationWorker?.reapStaleClaims(); }, 5 * 60 * 1000);
  notificationReaper.unref();
}
```
**Blocking note:** `contacts` has no production implementation (§7.1). Do **not** pass a permissive placeholder — a store that returns "any contact on file" violates the purpose-scoping contract. Until §7.1 lands, either skip mounting (and report `notification-worker: not-configured` as readiness) or mount with a store that returns `null` (fail-closed: no external send, rows retry then fail at the cap).

### 6.4 Shutdown — in `gracefulShutdown`, after `httpServer.close()` and the video drain, **before** `process.exit(0)` and before the lock pools close
```ts
if (notificationReaper) { clearInterval(notificationReaper); notificationReaper = null; }
if (notificationWorker) {
  const { drained, inFlight } = await notificationWorker.stop();
  if (!drained) {
    console.warn(`[Notification worker] drain timed out with ${inFlight} in flight; process not quiescent`);
  }
  notificationWorker = null;
}
```
Ordering rules: `start()` only after `listen`; `stop()` before any pool close (an in-flight dispatch still writes state and a receipt); `drained:false` is a **warning**, never a success; the worker owns exactly one timer and no reaper — the interval above is yours.

### 6.5 Reconciliation surface (operator)
Expose `reconcileQuarantinedOutboxRow(db, { outboxId, tenantId, resolution, actorId, proof?, now?, hmacKey, log? })` behind the existing admin/ops authority (route or ops script). `tenantId` must come from the authenticated admin scope, `actorId` from the principal — never from the request body. `resolution` is `'provider-delivered'` or `'provider-not-delivered'`; it requires an authoritative provider result, not an operator guess.

### 6.6 Producer call contract (for the academic lane's `assignments` / `exam-results` / exam publish handlers)
Call **after** the publish commit succeeds, never before:
```ts
await enqueueAcademicEventNotification(db, createConsentLedgerGate(db), publicationAuthority, {
  tenantId,                                   // from the authenticated admin's tenant scope
  event: 'assignment_published',              // or 'exam_published'
  resourceId: assignmentId,
  recipients,                                 // server-derived, tenant-scoped audience
  locale,                                     // 'ar' | 'en'
  channels: ['email'],                        // external only; in-app stays createNotification()
  variables: { assignment_title, course_name, due_at },        // exactly these keys
  linkSecret, baseUrl,
});
```
- `publicationAuthority.readPublication({tenantId,event,resourceId})` must read **its own** table and return `{ published, publishedAt }` (e.g. `status='published'` and `published_at`). It must not return `published:true` from a request value.
- `variables` must match the template exactly (extra or missing keys → `template-render-failed`, no row).
- Log the returned counts only; a producer refusal must **not** roll back the publish.
- `results_available` and `schedule_change` will refuse with `event-policy-held` — that is the intended answer until §5.3 is decided; do not add a local workaround.

### 6.7 Invariants Codex must preserve
- no `start()` at import time; no worker constructed outside the `listen` callback;
- one worker per tenant — a multi-tenant process needs one worker per tenant enumerated by a server-owned resolver (bounded); a widened scope is forbidden;
- never pass a client-supplied tenant, recipient, channel or purpose;
- a channel without a configured transport is registered unready (or not registered), never "ready with no transport".

---

## 7. Requests to other owners

### 7.1 Schema / contact source (Claude, schema owner) — blocks a real external send
Needed to implement `PurposeContactStore` without inventing schema: a purpose-scoped contact source for `(tenant_id, user_id, user_type, channel, purpose) → { contact, verified }`. Minimum: an append-only or versioned mapping of contact→purpose with a server-owned `verified` flag, tenant-scoped, no contact reuse across purposes. Until it exists, external delivery is structurally impossible (fail-closed by design).

### 7.2 Product decisions still open (do not guess)
1. `results_available` — release policy (draft/submitted/retakes/release/archived) **and** which consent purpose a result is delivered under (C1-R / D3).
2. `schedule_change` — which change notifies (creation / time change / cancellation), lead time, audience rule (C3-R).
3. Whether `assignment_published` / `exam_published` should also address parents (the producer supports it via `recipients`, but the audience rule is the academic lane's).

### 7.3 One implementation note for review
`assignment_published` / `exam_published` are routed under the existing consent purpose `lesson_updates` (the only purpose in `CONSENT_PURPOSES` that covers "new academic content"). This is a mapping inside the notification domain, recorded here so it is visible; if the owner wants a dedicated purpose, it is one registry line plus a schema value.

---

## 8. Commands actually run

```
# pre-write baseline (all 13 present files identical to the baseline handoff)
sha256sum + stat on the 14 allowedPaths; git rev-parse --short HEAD; git status --porcelain

# typecheck (after edits)
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
  → exit 0, no diagnostics (an earlier run showed 3 errors in server/src/services/live-session-core.ts,
    a concurrent media-lane file outside my paths; they were resolved by that lane, not by me)

# focused hermetic suites (unchanged assertions, 121 tests)
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test \
  tests/m6-notification-outbox.test.ts tests/m6-notification-worker.test.ts tests/m6-delivery-channels.test.ts
  → 71 pass, 0 fail
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test \
  tests/m6-notification-consent.test.ts tests/m1-sprint-notification-support.test.ts
  → 50 pass, 0 fail

# throwaway probe for the new paths (outside the repo, deleted afterwards)
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx %TEMP%/wb-notif-probe.ts
  → 11/11 probe groups pass

# post-write ledger
sha256sum + stat on the 14 allowedPaths
```

No DB, Docker, service, listener, migration, provider, secret, purge, deploy, Git mutation, TLS bypass or model/account switch was performed. The full suite was not run. No 429/500/transport failure occurred, so no stop condition was triggered.

---

## 9. Writing stopped

All writes are complete: three source files plus this report. No further file will be written by this worker; the claim is reported and released via `submit_task_report`.
