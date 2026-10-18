# M3 V4–V6 Delivery

## Scope
- V4 dynamic partial-identity watermark payload generator
- V5 device registry + concurrent session limits (per-tenant policy, atomic slot acquisition)
- V6 playback progress/resume (monotonic bounds, heartbeat rate limits, permitted device)

## Files
- server/src/services/playback-watermark.ts
- server/src/services/playback-session-registry.ts
- server/src/services/playback-progress.ts
- server/src/routes/playback-sessions.ts
- server/migrations/20261018_07_playback_sessions_progress.sql
- server/tests/m3-playback-sessions.test.ts
- server/bootstrap/m1/manifest.json (reviewed manifest inventory update)

## Behavior
- Watermark emits pseudonymous partial identity only; randomized position/opacity/overlap; explicitly states screenshots remain possible.
- Device registry enforces per-tenant max devices/concurrent sessions; slot acquisition is atomic; warning/self-revoke/support-revoke audited.
- Progress is server-authoritative and monotonic; heartbeat rate limited; cross-tenant/student forgery denied; resume only for permitted devices.

## Tests
- V4/V5/V6 unit + race + route tests pass.
- Full suite: 1401 tests, 0 failures.
- Typecheck: tsc --noEmit clean.

## Deferred
- Provider/network calls remain injected; no real DRM provider integration.
- Migration not executed (authoring only).
- Route not mounted in index.ts per task rules.
