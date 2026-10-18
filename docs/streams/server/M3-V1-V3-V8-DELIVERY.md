# M3 V1–V3–V8 Delivery

## Scope
- V1 provider-neutral video asset lifecycle — state machine, idempotent callbacks, verified owner, bounded retries/dead-letter.
- V3 per-tenant playback entitlement — short token tied to lesson/student/tenant/session; expired/revoked/cross-tenant denied.
- V8 usage events for watch/storage — dedupe heartbeat and provider callbacks; tenant attribution and reconciliation evidence.

## Files
- server/src/services/video-asset-lifecycle.ts
- server/src/services/playback-entitlement.ts
- server/src/services/video-usage-events.ts
- server/src/routes/video-assets.ts
- server/migrations/20261018_06_video_assets_entitlements.sql
- server/tests/m3-video-lifecycle.test.ts
- server/bootstrap/m1/manifest.json (reviewed manifest inventory update)
- docs/streams/server/M3-V1-V3-V8-DELIVERY.md

## Behavior
- **V1 asset lifecycle (provider-neutral).** States `uploaded → processing → ready|failed`; a `failed` asset may be retried back to `processing`; `ready` is terminal. Illegal transitions are rejected by `evaluateAssetTransition` (closed, not silently coerced). Dead-letter is stored as metadata (`dead_lettered` + reason), never a state, so it never blocks a later retry. Transitions are compare-and-set via `updateAsset(expectedStatus)` so a concurrent/second callback cannot double-apply.
- **V1 verified callbacks.** `POST /callbacks/:provider` verifies the provider HMAC signature first; an unverified callback is ignored and audited. Attribution comes from the verified callback payload + the caller-supplied provider key, never from client-supplied tenant fields. Replay is deduplicated by `UNIQUE (provider, callback_id)`; a duplicate is swallowed (`ER_DUP_ENTRY` detected via `isDuplicateEntryError`) with no second transition or audit. Retry policy is bounded: `evaluateFailureOutcome` re-queues while `attempts < maxAttempts` (default 3, ceiling 10) and dead-letters past the ceiling.
- **V3 playback entitlement.** Tokens are `v1.<base64url claims>.<base64url HMAC-SHA256>`; TTL defaults to 60s and is capped at 300s (`normalizePlaybackTtl` fails closed on anything else). Verification checks the MAC, then `evaluatePlaybackEntitlement` enforces a fixed order — revoked → expired → tenant → lesson → student → session — and *fails closed* when any expected binding is empty. Revocation is persisted by `jti` (`revoked_at`/`revoke_reason`) so an issued token can be invalidated before expiry. A missing signing secret reports "unavailable" and never yields a token.
- **V8 usage events.** Kinds are `watch` and `storage`; events carry a tenant-attributed, deduped `dedupe_key`. Heartbeats are bucketed from the injected clock (`buildHeartbeatDedupeKey` → `hb:<session>:<bucket>`, default 30s window) and provider callbacks use `buildProviderDedupeKey` → `cb:<provider>:<eventId>`. `validateUsageEvent` bounds watch seconds (≤3600) and storage bytes (≤10 GiB) and rejects unknown kinds. Dedupe is enforced by `UNIQUE (tenant_id, dedupe_key)`; reconciliation totals are computed per tenant for `GET /usage/summary`.
- **Denial semantics.** Anonymous → 401; a principal outside the resource tenant → 404 (resource) or 403 (known, forbidden); a student hitting a staff-only surface → 403. Tenant/branch/enrollment scoping is deny-by-default from the verified principal; sensitive mutations are audited only on real state changes.

## Endpoints
All routes are exported as a factory (`createVideoAssetsRouter(deps)`) for hermetic testing; the module also default-exports a production-wired router. The router is **not mounted in `index.ts`** (per stream rules).
- `POST /assets` — create/register an asset (authenticated, owner-scoped, audited).
- `GET /assets/:assetId` — read an asset within tenant scope (404 cross-tenant).
- `POST /assets/:assetId/processing` — transition to processing (compare-and-set, audited).
- `POST /callbacks/:provider` — public provider callback, HMAC-verified, replay-deduped.
- `POST /playback/entitlements` — issue a bound, short-lived playback token (404 cross-tenant).
- `POST /playback/entitlements/revoke` — revoke by `jti` (same-tenant only; then verification denies).
- `POST /usage/heartbeat` — record watch time (deduped within the window).
- `POST /usage/provider` — public provider usage callback, HMAC-verified and attributed.
- `GET /usage/summary` — per-tenant watch/storage totals (staff only; 403 for students).

## Schema (file only, not executed)
- `video_assets` — `UNIQUE (provider, provider_asset_id)`, `status`, `attempts`, `dead_lettered`, `dead_letter_reason`.
- `video_asset_callbacks` — `UNIQUE (provider, callback_id)` for replay dedupe.
- `playback_entitlements` — PK `jti`; `revoked_at`, `revoke_reason`.
- `video_usage_events` — `UNIQUE (tenant_id, dedupe_key)`, kind, quantity, attributed tenant.
- Idempotent via `INFORMATION_SCHEMA` guards + `PREPARE`/`EXECUTE`; no runtime DDL.

## Tests
- Focused: `server/tests/m3-video-lifecycle.test.ts` — 55/55 pass (pure state machine, lifecycle service, token codec/decision/service, usage validation/dedupe/service, and router integration covering allow + deny + cross-tenant + idempotency/race + failure per handler).
- Full suite: 1456 tests, 0 failures.
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` clean.
- `server/bootstrap/m1/manifest.json` was updated with the reviewed source hash for `20261018_06_video_assets_entitlements.sql`, so the shared `m1-bootstrap-plan` inventory check stays green (the sibling V4–V6 stream updates the same manifest for its migration).

## Deferred
- **V2 (upload/transcode HLS/ABR/DRM)** and **V7 (downloads)** are deferred pending DRM/provider verification; no provider capability is faked here. The V1 lifecycle intentionally stays provider-neutral so V2 can attach a real provider later.
- Provider verification/usage callbacks remain injected HMAC verifiers; no real provider or network calls are made.
- The migration is authored only and has not been executed (no runtime DDL); it requires separate isolated execution approval.
- The route is not mounted in `index.ts` per stream rules.
