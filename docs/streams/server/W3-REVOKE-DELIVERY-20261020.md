# W3 — revoking a playback session stops the next delivery request

**Task:** `server-w3-playback-revoke-delivery-stop-20261020-01` (team `media`)
**Controlling scope:** `docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md` §W3
**Date:** 2026-10-20 · **Status:** implemented, focused tests + typecheck green, **not accepted**
**Environment:** no database, no Docker, no listener, no network, no provider, no secret, no install, no Git mutation.

---

## 1. Defect reproduced before the repair

### 1.1 Source reading

| Seam | Pre-fix behaviour |
|---|---|
| `server/src/services/playback-session-registry.ts:744-773` (SQL) and `:313-338` (in-memory) | `revokeSession` flipped `playback_session_slots.status = 'revoked'`, removed the user slot and wrote one audit event. Nothing else. |
| `server/src/routes/playback-sessions.ts:314-329` | `support-revoke` called `revokeSession` then `releaseSlot` (a no-op once the row is `revoked`) and appended a second audit event. No entitlement revocation, no delivery-session close. |
| `server/src/routes/secure-video.ts:921-928` (`validateMediaSession`) | Delivery was bound to `getActiveSession`, i.e. the **per-process** `activeSessions` map (`server/src/services/video-security.ts:63,179`). `video_sessions.is_active = 0`, written by `killSession`, was never read at delivery. |
| `server/src/routes/secure-video.ts:1381 / 1429 / 1485` and the refresh path | The durable entitlement record *was* consulted, but a playback-session revoke never touched it, so every record stayed usable for its full TTL (≤ 300 s). |

Consequence: after `POST /api/playback-sessions/sessions/:id/support-revoke` returned `200`, the next
`manifest` / `media` / `key` / `refresh-token` request was still served, and an instance with its own
cache kept serving a session another instance had killed.

### 1.2 Behavioural reproduction

New test `server/tests/m3-playback-revocation-delivery.test.ts` was written first and run against the
**unmodified** source:

```
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
  --test tests/m3-playback-revocation-delivery.test.ts
# tests 9 / # pass 2 / # fail 7
```

| # | Test | Pre-fix failure |
|---|---|---|
| 4 | after a revoke the NEXT manifest/media/key/refresh is denied | `200 !== 403` at `/manifest/video-1/playlist.m3u8` — revoke answered `200`, the next request still served bytes |
| 5 | second instance with a stale cache | same 200-after-revoke, on the second router |
| 7 | durably inactive session, no entitlement required | `200 !== 401` — `is_active = 0` was invisible to delivery |
| 8 | storage failure during revoke | `200 !== 500` — nothing failed because nothing durable was written besides the slot |
| 9 | local kill failure after commit | `entitlements.get('jti-1').revoked_at !== null` was `false` — the record was never revoked |
| 2 | audit inside the durable transaction | `inTransaction` `false !== true` — the audit row was written on a separate connection |
| 6 | empty-cache instance | harness field-name bug (see §6), not defect evidence |

Positive control (test 1, `/session` issuance → manifest → media → key) passed pre-fix, so the harness
really does serve bytes when the session is live.

---

## 2. Root cause

1. **Revocation was not authoritative for delivery.** The revoke wrote one durable row
   (`playback_session_slots`) that the delivery path never reads, and left the durable row that
   delivery *does* read (`playback_entitlements`) untouched
   (`playback-session-registry.ts:744-773`, `playback-entitlement.ts` had no session-wide revoke).
2. **Delivery trusted a process cache for liveness.** `validateMediaSession`
   (`secure-video.ts:921-928`) bound the request to `activeSessions`, so a kill performed by another
   instance — or by `killSession` from a path that never revokes an entitlement (violation,
   suspension, instructor action) — was invisible to the instance serving the bytes.
3. **The revocation was not atomic.** The slot update, the (absent) entitlement change and the audit
   insert were three independent statements on a pooled connection; an audit failure left a revoked
   slot with no audit row, and there was no transaction to roll back.

---

## 3. Durable-authority design

One decision point — `deliverySessionIsLive` + `deliveryEntitlement` — is passed by every manifest,
media, key and refresh request. It reads only durable server rows, never the process cache.

### 3.1 Delivery gate (`server/src/routes/secure-video.ts`)

```
deliveryEntitlement(session, videoId)          // durable per-session entitlement records
  → deny 403 PLAYBACK_ENTITLEMENT_DENIED      // revoked / expired / binding mismatch / missing / store-unavailable
deliverySessionIsLive(sessionId)              // durable video_sessions row (secure-video.ts:1000)
  → deny 401 { error: 'session_inactive' }
```

* `readDurableSessionStatus` (`server/src/services/video-security.ts:208`) maps the row to
  `active` | `revoked` | `unknown` | `unavailable`.
  * `revoked` → deny. `unavailable` (the read threw) → deny (fail closed).
  * `unknown` (no row) can only occur when the insert at creation failed; it is **not** a
    fail-open across instances: the request has already been bound to a live session *this* process
    created, and another instance has no cache entry at all, so it denies at `401` before reaching
    this point. A missing row can therefore only ever narrow access.
* Call sites: `secure-video.ts:1409` (manifest), `:1458` (media), `:1515` (key), `:1309`
  (refresh-token — a revoked session never mints a token).
* The entitlement check runs first so the denial reason stays precise (`revoked`) when both durable
  rows disagree; the session row is the second gate for sessions the entitlement model does not bind
  (preview, no unique lecture, no enrollment).

### 3.2 Revocation (`server/src/services/playback-session-registry.ts:761`)

`createSqlPlaybackSessionStore(...).revokeSession` now runs inside `withTransaction`:

1. `SELECT … FROM playback_session_slots WHERE session_id = ? … FOR UPDATE` — lock the slot.
2. Authority: `isOwner = actorId === row.user_id`; `isSupport = support === true && actorType === 'support'`.
   Support intent and support actor type must **both** be present, so an owner cannot escalate to the
   support path to bypass `self_revoke_allowed`, and a caller-supplied single flag is not authority.
   Tenant policy (`support_revoke_allowed` / `self_revoke_allowed`) is re-read inside the transaction.
3. `UPDATE … SET status = 'revoked' … WHERE session_id = ? AND status = 'active'`; `affectedRows === 0`
   means a concurrent revoke/release won the race → `already_ended`, and no second event is emitted.
4. `deps.revokeEntitlements(tx, { sessionId, reason, revokedAtMs })` — the durable co-commit.
   Production wires it to `createSqlPlaybackEntitlementStore(tx).revokeBySessionId`
   (`playback-sessions.ts:529-539`), which is one statement:
   `UPDATE playback_entitlements SET revoked_at = ?, revoke_reason = ? WHERE session_id = ? AND revoked_at IS NULL`
   (`playback-entitlement.ts:475`).
5. `audit(event, tx)` — the audit insert uses the transaction handle, so it commits with the change.

The in-memory registry got the same `isSupport` tightening (`playback-session-registry.ts:320`) but
no transaction (there is no durable store there; it is the test/fallback adapter).

### 3.3 Route (`server/src/routes/playback-sessions.ts:79`)

`commitRevocation` is the single path for self and support revoke:

* durable failure → `500 { error: 'revoke_failed' }`, nothing reported as revoked;
* not revoked → the existing `404` / `403` codes with the store's reason;
* committed → `killDeliverySession(sessionId, reason)` **after** the commit, in its own `try/catch`;
  a failure is logged and the response stays `200` (the durable store already denies the next request).
* The duplicate support audit event that the route appended is removed — the store emits exactly one
  meaningful event, inside the transaction.

---

## 4. Atomicity argument

* Slot status, session-wide entitlement revocation and the audit row are **one** MySQL transaction on
  **one** connection (`withTransaction` → `productionDb.transaction`, `playback-sessions.ts:482-512`).
  A failure in the entitlement statement or in the audit insert throws out of the callback; the
  connection is rolled back, so neither the slot nor the entitlement changed and no audit row exists.
* The local session close (`killSession`) is **outside** the transaction and after the commit. It is a
  secondary effect on a cache/row that only the revoke can remove; if it fails, the durable rows
  already deny the next request, so the session is not resurrected. It is not part of any SQL rollback.
* Idempotency: `revokeBySessionId` filters `revoked_at IS NULL`, the slot update filters
  `status = 'active'`, and a second revoke returns `already_ended` without a second audit event.

---

## 5. Test matrix

`server/tests/m3-playback-revocation-delivery.test.ts` (9 tests, all green). It drives the real
`createSqlPlaybackSessionStore`, the real `createSqlPlaybackEntitlementStore`, the real
`createPlaybackEntitlementService` (real HMAC issuance), the real `createPlaybackSessionsRouter` and
the real `createSecureVideoDeliveryRouter`. The SQL adapter runs against a stateful in-memory database
that honours `transaction` with snapshot/rollback; no predicate is re-implemented in the test.

| # | Test | Assertion |
|---|---|---|
| 1 | session creation + authorized self playback | `/session` persists exactly one durable record; manifest `200` with `#EXTM3U`, media `200` with `segment-bytes`, key `200` |
| 2 | self and support authority | support (`role=admin`, same tenant, both flags) → `200`, exactly one `playback.session.support_revoke` event with `actorId=admin-1` and `inTransaction=true`; self → `200`, `playback.session.self_revoke` |
| 3 | foreign user / foreign tenant | `403 not_authorized`, `403 tenant_mismatch`, slot still `active`, zero audit rows, playback still `200` |
| 4 | **the next request after a revoke** | manifest, media, key → `403`, `reason=revoked`, `chunks.length === 0`; refresh → `403 revoked`; the durable record's `revoked_at` is set |
| 5 | **second instance, separate cache** | process B holds a *live* session object in its own cache (strongest stale cache); after A's revoke, B's manifest and media → `403 revoked`, no bytes |
| 6 | second instance, empty cache | `401`, no bytes |
| 7 | durable `is_active = 0`, entitlement not required | manifest/media/key → `401 session_inactive`, no bytes |
| 8 | storage failure during revoke | entitlement-update failure and audit-insert failure each → `500 revoke_failed`; slot still `active`, `revoked_at` still `null`, zero audit rows, local kill not called; after recovery playback is `200` |
| 9 | local kill failure after commit | `200 revoked`, slot `revoked`, `revoked_at` set, `video_sessions.is_active` still `1` (the kill never ran), delivery → `403 revoked`, no bytes |

`server/tests/m3-playback-sessions.test.ts` (64 tests) and `server/tests/m1-security-videos.test.ts`
(4 tests) are **byte-identical to the baseline** — no assertion was deleted, loosened or rewritten.

---

## 6. Commands and real output

```
$ cd server
$ M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
    --test tests/m3-playback-revocation-delivery.test.ts tests/m3-playback-sessions.test.ts \
           tests/m1-security-videos.test.ts
1..73
# tests 73
# suites 0
# pass 73
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1803.8021
```

Adjacent suites that also cover these modules (outside the W3 write set — run as a regression check,
not modified):

```
$ M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
    --test tests/m1-media-socket-regressions.test.ts tests/m3-playback-sql-store.test.ts
# tests 119
# pass 119
# fail 0
```

Typecheck (from the repository root; `server/tsconfig.json` includes only `src/**`):

```
$ node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
TSC_EXIT=0
```

Tests are compiled by the tsx runner, not by `tsc`; `tsc` proves `src/**` only.

The full suite was **not** run (forbidden for this task).

---

## 7. Files

| Path | sha256 before (baseline) | sha256 after |
|---|---|---|
| `server/src/routes/playback-sessions.ts` | `99253d021659cd1d9dacfafc6dd30e8c4aecfdf1680dc5900a6c8cc43e02558f` | `342b09794955155f31ff9854f3f839bb6dee5589d853156460d8b885118b3bf9` |
| `server/src/services/playback-session-registry.ts` | `7a20560fd59bcb7a4d59f27c4713b6b2714d834f937d2200ecfb3511e9952183` | `5c9e3667526f4797cd2e709577ad341cc8e0630eb44c8079525adff980784460` |
| `server/src/routes/secure-video.ts` | `33095f533612e1bb7f47b1dbd1c81c27477a7464d9d56c6e15bdeb0116f08035` | `9ed8ad6d56516c4b4a6bad5231290f64fd672b9eceddeffcbab7b93d3d05fd59` |
| `server/src/services/video-security.ts` | `172303e29033f753c4ed68491135d7a190b7c19df117c67d6a00ae719776dfda` | `4a56f29bbc2a6763f135462a437cefe951546fbec0e7e369c18da2139880e357` |
| `server/src/services/playback-entitlement.ts` | `6de765b970b023c5ca0da64af4a960d8602255b757ef027f9a15a2dcbfac55e5` | `1af9a2db85e8eafed6901be7039ec38520aa4df44f3336e95a28abafd969b6cf` |
| `server/tests/m3-playback-sessions.test.ts` | `54179476df3838f0a4edcd1066f368a32894c7eebbe1b1a271c31ac8c417bbad` | unchanged |
| `server/tests/m1-security-videos.test.ts` | `d51fbbe014b2d04bb3b2781407e97f477d757406368bbb2f5ee0e0f847f44bbf` | unchanged |
| `server/tests/m3-playback-revocation-delivery.test.ts` | ABSENT | `1d3c6047b99f98b90e0dc8d4e4ef422439d627bdc3bd10f53321cd87212b0178` |
| `docs/streams/server/W3-REVOKE-DELIVERY-20261020.md` | ABSENT | this file |

`secure-video.ts` and `playback-entitlement.ts` arrived dirty; every pre-existing hunk is retained —
the W3 delta in `secure-video.ts` is +1 import line, one helper block and four call sites (1564 → 1593
lines), and `playback-entitlement.ts` only gains the optional `revokeBySessionId` member and its SQL
implementation. `server/src/security/video-access-policy.ts` was **not** touched (W5 owns it).

---

## 8. Limitations / not proven

1. **No live MySQL.** The transaction, `FOR UPDATE` lock, `affectedRows` semantics and rollback were
   exercised against a stateful fake that implements snapshot/rollback. Real InnoDB behaviour
   (deadlock retry, lock wait, `ROW_COUNT` on an `UPDATE` with no change) is **not** proven here.
2. **Multi-process is simulated, not observed.** "Second instance with a separate cache" is two
   `createSecureVideoDeliveryRouter` instances over one durable store, each with its own session map.
   Two OS processes and a shared pool were not started (forbidden). What is proven is that the
   decision comes from the durable rows: instance B denies while its cache still holds a live session.
3. **Bytes already sent are not retracted.** Only the *next* request is denied. No CDN revocation, no
   in-flight response abort, and no DRM re-key is claimed or implemented.
4. **`unknown` session row falls back to the in-process binding.** A session whose `video_sessions`
   insert failed (the insert error is logged, not fatal) is still served by the process that created
   it. Cross-instance it denies (empty cache → `401`). Closing this fully needs a non-swallowing
   create path — outside this task's write set (`video-security.ts` is in scope, but changing
   `createVideoSession` to fail closed would change the session-creation contract, so it is reported
   rather than changed).
5. **`revokeBySessionId` has no `session_id` index.** The bounded `findBySessionId` read already
   documented this; the revoke `UPDATE` filters on the same column. Index/migration is I2, not W3.
6. **Route-level support authority is the verified role claim + tenant match** (the existing contract).
   A platform-capability check (`security.manage`) would be stronger but would change the documented
   `support-revoke` contract and break the existing admin-token assertion in
   `m3-playback-sessions.test.ts:659-668`, which this task must preserve. Reported as a product
   question, not silently changed.
7. **In-memory registry path revokes no entitlement** (there is no durable store in that adapter). The
   durable co-commit is a property of `createSqlPlaybackSessionStore`, which is the production wiring.
8. One harness field name (`status` vs `statusCode` on the fake response) and one media path prefix
   were corrected while writing the new test; they are not defect evidence and are not counted in §1.2.

---

# 9. CORRECTION 2026-10-20 — durable session authority is now fail-closed

**Task:** `server-w3-durable-session-failclosed-correction-20261020-01` (team `media`, worker
`wb-w3-durable-failclosed-20261020-01`).
**Status:** implemented, focused tests + typecheck green, **not accepted**. This section is additive:
§1–§8 above are the previous worker's findings and are unchanged.

## 9.1 The three fail-open facts, confirmed in source

| # | Fact (pre-correction) | Location |
|---|---|---|
| 1 | The delivery gate accepted a missing row as live | `server/src/routes/secure-video.ts:1002` — `return status === 'active' \|\| status === 'unknown';` |
| 2 | A missing durable row was mapped to `unknown` | `server/src/services/video-security.ts:223` — `if (!row) return 'unknown';` (now `:259`) |
| 3 | `createVideoSession` swallowed the durable insert failure **after** publishing the session to the local map | `server/src/services/video-security.ts:127-128` (map writes) then `:145-147` (`catch` logs only) |

Together they meant a session whose `video_sessions` insert failed was still served by the process
that created it — the limitation reported in §8.4, now closed.

## 9.2 What changed

1. **`createVideoSession` is durable-first** (`video-security.ts:101-188`). The `UPDATE` (invalidate
   this user's older rows) and the `INSERT` now run **before** `activeSessions.set` /
   `userSessionMap.set`. A thrown statement, or an `affectedRows < 1` on the insert, raises
   `VideoSessionPersistenceError` and publishes nothing: no cache entry, no user→session mapping, no
   id returned. An insert that "succeeds" but writes no row is therefore also rejected.
2. **`VideoSessionPersistence` seam** (`video-security.ts:74-80`). Optional second parameter,
   defaulting to the pool-backed `execute`; it lets a hermetic test drive the real creation path with
   a failing store instead of mocking the function under test.
3. **The gate is fail-closed** (`secure-video.ts:1001-1004`): `deliverySessionIsLive` returns
   `status === 'active'` only. `unknown` and `unavailable` both deny.
4. **`/session` refuses to mint on persistence failure** (`secure-video.ts:1119-1143`): a creation
   throw returns `503 { code: 'PLAYBACK_UNAVAILABLE' }` with no `sessionId`, no `sessionToken`, no
   `streamUrl`, and no entitlement is issued.
5. **Preserved unchanged:** the SQL revoke + entitlement + audit transaction, the `FOR UPDATE` lock,
   the `affectedRows` race handling, and the post-commit best-effort local close (§3, §4). No change to
   `playback-sessions.ts`, `playback-session-registry.ts` or `playback-entitlement.ts`
   (byte-identical, §9.6 hashes). `video-access-policy.ts` was not touched (W5 owns it).

## 9.3 Deny matrix (manifest, media, key, refresh-token — all four paths)

| Durable session row | Local cache | Result |
|---|---|---|
| `is_active = 1` | live | **allow** (positive control) |
| `is_active = 0` | live | **deny** `401 session_inactive` |
| missing (`unknown`) | live (creating process) | **deny** `401 session_inactive` — *the closed gap* |
| read throws (`unavailable`) | live | **deny** `401 session_inactive` |
| any | absent | **deny** `401` before the gate (`validateMediaSession` / `getActiveSession`) |
| revoked entitlement (any row state) | live | **deny** `403 revoked`, entitlement gate runs first |
| foreign user / foreign tenant | — | **deny** `403` (`not_authorized` / `tenant_mismatch`) at revoke; playback unaffected |
| creation insert fails | — | **no session**: `503 PLAYBACK_UNAVAILABLE`, zero cache entries, zero entitlements |

## 9.4 Tests added (`server/tests/m3-playback-revocation-delivery.test.ts`, 9 → 13)

| Test | Asserts |
|---|---|
| `a missing durable session row denies even with a live local cache entry` | positive control `200`; after `videoSessions.delete`, manifest/media/key/refresh → `401 session_inactive`, `chunks.length === 0`, no `sessionToken` |
| `an unreadable durable session store denies instead of serving` | read throws for `video_sessions` only → manifest/media/key/refresh `401`, no bytes; recovery → `200` |
| `a durable insert failure mints no session and leaves no local grant` | real `createVideoSession` + failing persistence rejects with `VideoSessionPersistenceError`; `getActiveSession(attemptedId) === null`, `getUserActiveSessionId(userId) === null`; positive control with a working store publishes a row the durable reader reports `active` |
| `the session route issues no token when creation cannot persist` | `POST /session` → `503 PLAYBACK_UNAVAILABLE`, no `sessionId`/`sessionToken`/`streamUrl`, empty body, cache size `0`, entitlements `0` |

Existing test 5 (independent instance, separate cache) was **extended**, not weakened: after the
revoke, instance B now also denies `key` (`403`) and `refresh-token` (`403 revoked`, no token). No
existing assertion was removed or loosened.

## 9.5 Commands and real output

```
$ cd server
$ M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
    --test tests/m3-playback-revocation-delivery.test.ts tests/m3-playback-sessions.test.ts \
           tests/m1-security-videos.test.ts
1..77
# tests 77
# suites 0
# pass 77
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1712.8707
```

```
$ node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
TSC_EXIT=0
```

`server/tsconfig.json` includes only `src/**`; the tests are compiled by the tsx runner, not by `tsc`.
The full suite was **not** run.

## 9.6 Files (correction delta only)

| Path | sha256 before | sha256 after |
|---|---|---|
| `server/src/routes/secure-video.ts` | `9ed8ad6d56516c4b4a6bad5231290f64fd672b9eceddeffcbab7b93d3d05fd59` | `5ae5354b66d3426c6f20a17e975358c799e70ce85393647dcd58aabc8b610413` |
| `server/src/services/video-security.ts` | `4a56f29bbc2a6763f135462a437cefe951546fbec0e7e369c18da2139880e357` | `d2e49aa42698da1352eebaed704e88991faea5b2937ec18018376d515906a31f` |
| `server/tests/m3-playback-revocation-delivery.test.ts` | `1d3c6047b99f98b90e0dc8d4e4ef422439d627bdc3bd10f53321cd87212b0178` | `619e2346a05948890ac041cd28f54080de24aca91b548b9c0f219622eb7e170f` |
| `server/src/routes/playback-sessions.ts` | `342b0979…b3bf9` | unchanged |
| `server/src/services/playback-session-registry.ts` | `5c9e3667…4460` | unchanged |
| `server/src/services/playback-entitlement.ts` | `1af9a2db…6cf` | unchanged |
| `server/tests/m3-playback-sessions.test.ts` | `54179476…bbad` | unchanged |
| `server/tests/m1-security-videos.test.ts` | `d51fbbe0…4bbf` | unchanged |

## 9.7 Remaining role-only authority gap (audited, not changed)

1. **`support-revoke` authority is role-only.** `playback-sessions.ts:342` admits
   `admin | super_admin | staff` from the live principal role (DB-verified by `resolvePrincipal`,
   `middleware/auth.ts:143-162`), then `:347` compares tenants, then the store re-reads the tenant
   policy. There is no resource-scoped capability and no per-session grant: **any** admin/staff of a
   tenant may revoke **any** user's playback session in it. The stronger capability used elsewhere in
   the video surface (`security.manage`, `secure-video.ts:62-71`) was deliberately **not** applied —
   it would change the documented contract and break `m3-playback-sessions.test.ts:659-668`.
2. **The tenant comparison is skipped when the actor has no tenant.** `:347` guards with
   `slot && userTenantId && …`, and the store (`playback-session-registry.ts:761-806`) never receives
   the actor's tenant, so it cannot re-check it. A staff principal without a tenant id could therefore
   revoke a session in another tenant (`super_admin` does so by design). Fixing this needs a store
   contract change (actor tenant in `RevokeInput`) and is outside this correction.
3. `POST /devices/:deviceId/revoke` (`:390`) uses the same role-only support test.

## 9.8 Adjacent suite impact — needs coordination

`server/tests/m1-media-socket-regressions.test.ts` (outside this task's write set) drives the same
delivery router with a `queryOne` that returns `null` for `video_sessions`, so its fixture cannot
express a persisted row:

```
$ M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
    --test tests/m1-media-socket-regressions.test.ts
# tests 108
# pass 105
# fail 3
```

Failing, all because they assert the old cache-only contract (no durable session row exists in the
harness): `entitlement delivery: a valid record serves the manifest, the segment and the key`;
`entitlement refresh: a valid record near expiry is renewed`; `entitlement refresh: a valid record
outside the renewal window is not re-issued`. The correct fix is to seed `video_sessions` in that
harness (`{ is_active: 1 }`), which requires an owner with that file in scope; this task must not
edit it, and the guards were not loosened to keep it green.

## 9.9 Limitations

* No live MySQL; the insert-failure path is proven through the injected persistence seam, not a
  failing InnoDB.
* "Unreadable store" is a throwing reader, not a real connection loss/timeout.
* Bytes already sent are still not retracted (§8.3 unchanged).
* A failed creation now returns `503` instead of a silently unusable `200`; clients that treated the
  old swallowed failure as success will see an error, which is the intended fail-closed behaviour.

---

# 10. CORRECTION 2026-10-20 — durable harness fixture + resource-scoped revoke authority

**Task:** `server-w3-fixture-authority-correction-20261020-01` (team `media`, worker
`wb-w3-fixture-authority-20261020-01`, approval version 2).
**Status:** implemented, focused tests + typecheck green, **not accepted**. Additive: §1–§9 are the
two previous workers' findings and are unchanged. The production delivery guard was **not** touched.

## 10.1 GAP 1 — the three failures, reproduced before any edit

```
$ cd server
$ M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
    --test tests/m1-media-socket-regressions.test.ts
not ok 94  - entitlement delivery: a valid record serves the manifest, the segment and the key   (401 == 200)
not ok 101 - entitlement refresh: a valid record near expiry is renewed                          (401 == 200)
not ok 102 - entitlement refresh: a valid record outside the renewal window is not re-issued     (401 == 200)
# tests 108 / # pass 105 / # fail 3
```

Root cause was the **fixture**, not the guard: `makeDeliveryHarness` answered `null` for every
`queryOne`, including `SELECT is_active FROM video_sessions WHERE id = ?`, so
`readDurableSessionStatus` returned `unknown` and `deliverySessionIsLive` denied at `401`. The guard
(`secure-video.ts:1001`, fail-closed since §9) is correct and was left byte-identical.

### 10.1.1 Fixture model (`server/tests/m1-media-socket-regressions.test.ts`)

`createDurableSessionTable()` is an in-memory `video_sessions` table with three properties:

1. **Written by the real statements.** `INSERT INTO video_sessions …` (creation) and both
   `UPDATE video_sessions SET is_active=0 …` forms (kill by `id`, invalidation by `user_id`) mutate
   it. `makeDeliveryHarness.createVideoSession` now performs that INSERT before returning the id, so
   `POST /session → manifest 200` is proven end-to-end instead of asserted on a cache object.
2. **Read by id, no default row.** `SELECT is_active FROM video_sessions WHERE id = ?` returns
   `{ is_active: 1 }`, `{ is_active: 0 }` or `null`; an unknown id is `null`. Nothing is fabricated
   per query.
3. **Explicit states.** `durableSession: 'active' | 'missing' | 'unavailable'` (default `active`
   when the fixture has a session, `missing` otherwise) plus `failReads()` / `deactivate()` for
   transitions.

Negative coverage kept and extended: the pre-existing "valid session with no server-owned record"
test still denies at the entitlement gate, and three tests were added — a **missing** durable row
denies manifest/media/key/refresh at `401 session_inactive` with zero bytes; a row **killed after
issuance** denies the next request; an **unreadable** store denies and recovers when the read works
again. No existing assertion was removed or loosened.

## 10.2 GAP 2 — resource-scoped support authority

### 10.2.1 Defect (source, pre-correction)

`playback-sessions.ts:342,347` admitted `admin | super_admin | staff` and then compared tenants only
when `userTenantId` was present (`slot && userTenantId && …`), so the comparison was **skipped** for
any actor without a tenant — and `resolvePrincipal` (`middleware/auth.ts:197`) deliberately derives
**no** tenant for role `admin`. `POST /devices/:deviceId/revoke` (`:390`) had the same shape. A role
string alone therefore authorized support without proven resource authority.

### 10.2.2 Contract implemented

`PlaybackSessionsDeps.hasPlatformCapability` is a **verified predicate** (production default:
`hasVerifiedPlatformPermission('security.manage', userId)` from `admin-permissions.ts` — an active
`super_admin` row or the `security.manage` key from `admin_role_permissions`; no new key, file
read-only). `resolveSupportAuthority(actor, targetTenantId)`:

| Actor state | Target tenant | Result |
|---|---|---|
| tenant derived by `resolvePrincipal` equals the target | same | **allow** (tenant-scoped resource authority, no lookup) |
| role label `admin`/`super_admin`/`staff`, **no tenant** | any | capability lookup; false or throw → **deny** |
| tenant present but **foreign** | other | capability lookup; false or throw → **deny** |
| no tenant, capability **verified** | any | **allow** (platform operator) |
| tenant present, capability **verified** | other | **allow** (cross-tenant operator) |
| capability lookup **throws** | any | **deny** `503 authority_unavailable` |
| owner (`actorId === row.user_id`), support intent absent | own | **allow** under `self_revoke_allowed` (unchanged) |

Codes: missing tenant `403 tenant_required`, foreign tenant `403 tenant_mismatch`, lookup failure
`503 authority_unavailable`, missing session `404 session_not_found`. Every denial returns before
`commitRevocation`: no slot mutation, no entitlement revoke, no audit row, no local close.

The scope is passed **through the durable-store seam** (`RevokeAuthority { actorTenantId,
platformAuthorized }` on `revokeSession` / `revokeDevice`) and re-checked against the row that is
being changed: `SELECT … FOR UPDATE` → tenant re-check → status flip → entitlement co-commit →
audit, all in one transaction. `revokeDevice` was moved into `withTransaction` with `FOR UPDATE` and
a transactional audit for the same reason. No schema change.

## 10.3 Test evidence

Added (7): role label + no tenant denied; foreign tenant denied (route); verified capability
positive (no tenant **and** cross-tenant); capability withdrawal denies the **next** request; lookup
failure denied with no mutation/audit; device support-revoke matrix (role-only / foreign / unreadable
/ verified / self); three repaired harness regressions plus three durable-state negatives.

```
$ M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
    --test tests/m1-media-socket-regressions.test.ts tests/m3-playback-revocation-delivery.test.ts \
           tests/m3-playback-sessions.test.ts tests/m1-security-videos.test.ts
1..197
# tests 197
# suites 0
# pass 197
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1545.727
```

Per suite: `m1-media-socket-regressions` 111/111 (was 105/108), `m3-playback-revocation-delivery`
18/18 (was 13/13), `m3-playback-sessions` 64/64 (was 60/60), `m1-security-videos` 4/4.
Adjacent, unmodified: `m3-playback-sql-store` + `m2-m3-mounting` 31/31.

```
$ node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
TSC_EXIT=0
```

The full suite was **not** run.

## 10.4 Files (correction delta)

| Path | sha256 before | sha256 after |
|---|---|---|
| `server/src/routes/playback-sessions.ts` | `342b0979…b3bf9` | `5d25786d367131bdeeaa6ae2250513417a40221489897955cb9a74525515c5bb` |
| `server/src/services/playback-session-registry.ts` | `5c9e3667…4460` | `7cdfeece574ed49016f3df6c680485940e6e0eb2e3ed33f583599b38c130f688` |
| `server/tests/m3-playback-sessions.test.ts` | `54179476…bbad` | `154a0f782856babd3ca4dff0ba6a966d49f09b6e78fa94289e9acb32c48b9d4b` |
| `server/tests/m3-playback-revocation-delivery.test.ts` | `619e2346…170f` | `bbe7b6d99bb5a729a9c589b42672706687179f4508be2e3c11e91d122c9d6433` |
| `server/tests/m1-media-socket-regressions.test.ts` | not previously recorded | `6994f900e5ee3748705d33d87348d2b0097b1a8010c6b21aa9ba6e15a3fcabae` |
| `server/src/routes/secure-video.ts` | `5ae5354b…0413` | unchanged |
| `server/src/services/video-security.ts` | `d2e49aa4…a31f` | unchanged |
| `server/src/services/playback-entitlement.ts` | `1af9a2db…6cf` | unchanged |
| `server/tests/m1-security-videos.test.ts` | `d51fbbe0…4bbf` | unchanged |
| `server/src/security/admin-permissions.ts` | — | **read-only, not edited** |

`video-access-policy.ts`, migrations, `src/index.ts`, frontend and Claude-lane paths were not touched.

## 10.5 Behaviour change to note

A production `admin` principal carries no tenant (`resolvePrincipal`), so a tenant admin without
`security.manage` can no longer support-revoke. That is the required contract ("a role label alone
cannot authorize support"); `staff` keeps same-tenant support through its membership-derived tenant,
and a verified `security.manage`/`super_admin` operator keeps the cross-tenant path.

## 10.6 Residual gaps

1. No live MySQL: the transaction, `FOR UPDATE` and rollback are exercised against the stateful fake.
2. Device revoke now runs in a transaction, but the `UPDATE … WHERE status='active'` `affectedRows`
   race is still not surfaced, so a concurrent double device revoke could emit two audit rows
   (pre-existing; session revoke already handles it).
3. The 404/403 split for support uses a pre-transaction `getSession`; the authority itself is
   re-checked inside the transaction, so only the status code, not the decision, depends on the
   pre-read.
4. Bytes already sent are still not retracted (§8.3 unchanged).
5. The pre-edit hash of `m1-media-socket-regressions.test.ts` was recorded by neither earlier worker;
   its after-hash above is the verifiable one.
