# W7 — Observability hardening (server)

**Task:** `server-w7-observability-hardening-20261020-01` · **Team:** `devops` · **Worker:** `wb-w7-observability-20261020-01`
**Branch:** `codex/workbuddy-server` (no switch, no commit, no push) · **Date:** 2026-10-20
**Status:** `reported` — **not accepted**. No milestone, no completion claim.
**Controlling scope:** `docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md` §W7 (read in full).

---

## 1. Scope

| Write set | Kind | Touched |
|---|---|---|
| `server/src/routes/ops.ts` | modify | yes |
| `server/src/services/logger.ts` | modify | yes |
| `server/src/services/metrics.ts` | modify | yes |
| `server/src/middleware/request-context.ts` | modify | **no** (see §9.1) |
| `server/tests/m8-observability.test.ts` | modify | yes (25 existing + 9 new) |
| `docs/streams/server/W7-OBSERVABILITY-20261020.md` | new | yes |

Out of scope and untouched: `server/src/index.ts` (I1), auth/db/manifest/schema/migrations,
search, `public/**`, any other lane's files. No timers, polling, background loops or index
wiring were added; alerts/jobs instrumentation remains I1.

---

## 2. Defects reproduced BEFORE the fix

Probe run against the **unmodified** sources with an inline `node --import tsx` script (no file
written; command in §7.1). Real output:

| # | Defect | Probe | Observed (pre-fix) | Causing line (baseline) |
|---|---|---|---|---|
| 1 | Unbounded readiness | `/readyz` with `check: () => new Promise(() => {})` | `settled=false elapsed=400ms status=200` — probe never answered | `server/src/routes/ops.ts:215-221` (`await dependency.check()` with no bound) |
| 1b | Unbounded liveness | `/healthz` with a never-settling `liveness()` | same shape — `await liveness()` unbounded | `server/src/routes/ops.ts:202-211` |
| 2 | False ready | `/readyz` with `readiness: []` | `200 {"status":"ready"}` | `server/src/routes/ops.ts:214` (`let ready = true`) |
| 3 | Unbounded `method` label | observe 3 arbitrary verbs `FROBNICATE-abc`, `zzz-1`, `zzz-2` | `3` distinct `http_requests_total` series | `server/src/services/metrics.ts:315` (`method: observation.method`) |
| 4a | `Error` bypasses depth bound | `redactValue({ err: new Error('boom') }, { maxDepth: 1 })` | `190 bytes; MaxDepth=false; hasStack=true`, keys `["name","message","stack"]` | `server/src/services/logger.ts:186-193` (`instanceof Error` handled before the `depth >= maxDepth` guard at `:196`) |
| 4b | same at root | `redactValue(new Error('boom'), { maxDepth: 0 })` | `182 bytes; MaxDepth=false` | same |
| 4c | `Error.cause` silently dropped, no cycle handling | `err.cause = err` then redact | `causePresent=false; Circular=false` | same (the `Error` branch walks no properties, so `seen` is never consulted for it) |
| 5 | No `no-store` on denial | `GET /metrics` without bearer | `401 cache-control=undefined` | `server/src/routes/ops.ts:189-197` (denial path sets status+json only) |

Defect 4 is a *bound* violation rather than an infinite loop: an `Error` at or past `maxDepth`
was still serialized in full (name + message + up to `maxStringLength` of stack) instead of
`[MaxDepth]`, and its `cause` chain was dropped entirely. Both are fixed by routing `Error`
through the same guard as any other object.

---

## 3. Root cause and fix

### 3.1 `server/src/routes/ops.ts`

- **Root cause:** both probes `await` an injected predicate with no bound, and `ready` starts as
  `true`, so "no checks wired" is indistinguishable from "all checks passed".
- **Fix:**
  - `runBounded(task, timeoutMs)` (`ops.ts:222-243`) races the check against a single timer and
    returns `{ ok: false }` on timeout **or rejection** (a synchronous throw is captured through
    `Promise.resolve().then(task)`). The handle is cleared in `finally` on every path, including
    the synchronous-throw path, so no timer outlives the probe and no unhandled rejection is
    created by a late result.
  - Per-check bound `checkTimeoutMs` (default `DEFAULT_CHECK_TIMEOUT_MS = 2000`) and a whole-sweep
    bound `readinessBudgetMs` (default `DEFAULT_READINESS_BUDGET_MS = 5000`). Each check gets
    `min(checkTimeoutMs, remaining budget)`; an exhausted budget short-circuits to not-ready
    (`ops.ts:278-296`).
  - `readinessOptIn` is the **only** way an empty list can report ready
    (`let ready = readiness.length > 0 || deps.readinessOptIn === true;`, `ops.ts:281`). Opt-in
    never overrides a failing check.
  - `/healthz` keeps its pure-liveness contract (no dependency check is ever run) and is now
    bounded by the same timeout; a timeout is `503 unavailable` (`ops.ts:271-276`).
  - Metrics denials set `Cache-Control: no-store` before the JSON body (`ops.ts:261`). Response
    shapes (`{error}`, `{status}`) are unchanged.
- No background timer, no polling, no index wiring; the timer exists only for the duration of a
  single probe.

### 3.2 `server/src/services/metrics.ts`

- **Root cause:** the `method` label is caller-controlled and was copied verbatim into a label
  value, so a forged verb creates a new series per string.
- **Fix:** `boundedHttpMethod(method: unknown)` (`metrics.ts:314-318`) upper-cases and admits only
  `GET HEAD POST PUT PATCH DELETE OPTIONS CONNECT TRACE`; everything else (including non-strings
  and empty strings) collapses into the single `HTTP_METHOD_FALLBACK = 'other'` bucket. Applied in
  `createHttpObserver.observe` (`metrics.ts:338`). Existing label values are unchanged for real
  methods (`GET`, `POST`, …).

### 3.3 `server/src/services/logger.ts`

- **Root cause:** `instanceof Error` (and `instanceof Date`) were checked **before** the
  `seen`/`maxDepth` guards, so those values skipped both bounds; the `Error` branch also walked no
  properties, dropping `cause`.
- **Fix:** `Date` and `Error` are now handled *inside* the object branch, after the cycle check and
  the depth check (`logger.ts:188-194`). `walkError` (`logger.ts:223-236`) emits
  `name/message/stack` and then walks own enumerable properties and `cause` at `depth + 1`, so:
  a self-referencing `cause` → `[Circular]`; a chain past `maxDepth` → `[MaxDepth]`;
  `AggregateError.errors` is bounded like any array; secret-looking keys on an error are still
  redacted by key.

---

## 4. Assertions changed

**None.** All 25 pre-existing tests and every assertion in them are retained verbatim; the 9 new
tests are appended. I checked whether any existing assertion encoded the old false-ready
behaviour: the only `/readyz` assertions in the repo pass a **non-empty** readiness list
(`server/tests/m8-observability.test.ts:462-481` and `server/tests/m2-m3-mounting.test.ts:922-925`),
so none of them asserted "empty ⇒ ready" and none had to be rewritten. The adjacent consumer file
`m2-m3-mounting.test.ts` still passes 20/20 (§7.3) — its `/readyz` expectation is unchanged.

---

## 5. Test matrix (9 new tests)

| # | Type | Test | Asserts |
|---|---|---|---|
| 26 | failure/bound | `ops: a dependency check that never resolves is cut off and reports not_ready` | check started once; `503 {status:'not_ready'}`; elapsed `< 1000 ms` |
| 27 | bound/cleanup | `ops: a resolved check clears its timeout handle (no leaked timer)` | `200 ready`; `process.getActiveResourcesInfo()` `Timeout` count unchanged with a 60 s bound |
| 28 | failure/bound | `ops: liveness that never resolves is bounded and reports unavailable` | `503 {status:'unavailable'}`; elapsed `< 1000 ms` |
| 29 | deny/allow | `ops: empty readiness is not_ready unless the operator opts in explicitly` | `[]` → 503; absent → 503; `[] + optIn` → 200; `optIn + failing check` → 503 |
| 30 | separation | `ops: /healthz stays live while a readiness dependency fails or hangs` | healthz 200 with 0 dependency calls, both for a throwing and a hung dependency; readyz 503 |
| 31 | bound | `metrics: unknown HTTP methods collapse into one bounded fallback bucket` | 5 observations (incl. 3 junk verbs, 1 lowercase) → exactly 2 series; `GET 2`, `other 3` |
| 32 | redaction | `logger: a cyclic Error is logged without throwing and without expanding` | one line; `cause === [Circular]`; `code` preserved; no `[object Object]` |
| 33 | redaction/bound | `logger: an Error past maxDepth is bounded and its cause chain is cut` | 20-deep `cause` chain at `maxDepth 4` → contains `[MaxDepth]`, `< 4096 B`; root Error at `maxDepth 0` → `[MaxDepth]`; log line `< 4096 B` |
| 34 | deny | `ops: metrics denials carry no-store` | 401 (missing/malformed/wrong bearer) and 503 (unconfigured) all carry `Cache-Control: no-store`; 503 body text unchanged |

No `any`, no `@ts-ignore`, no `.skip`.

---

## 6. Response contracts preserved

`/metrics` body + `Content-Type` (200) and `{error}` (401/503), `/healthz` `{status:'ok'|'unavailable'}`,
`/readyz` `{status:'ready'|'not_ready'}`, `X-Request-Id` echo, and the "no dependency names/counts"
rule are all unchanged. The only additive changes are `Cache-Control: no-store` on denials and the
new optional `checkTimeoutMs` / `readinessBudgetMs` / `readinessOptIn` dependency fields.

---

## 7. Commands and real output

### 7.1 Defect reproduction (pre-fix, inline, no file written)

```
cd "<repo>" && node --require ./scripts/m1-network-guard.cjs --import tsx --input-type=module - <<'EOF'
  … inline probe: createOpsRouter / createHttpObserver / redactValue …
EOF
```
```
D1 hung /readyz within 400ms -> settled=false elapsed=400ms status=200
D2 empty /readyz -> 200 {"status":"ready"}
D3 method series -> 3 ["…method=\"FROBNICATE-abc\"…","…method=\"zzz-1\"…","…method=\"zzz-2\"…"]
D4a {err} at maxDepth=1 -> 190 bytes; MaxDepth= false ; hasStack= true ["name","message","stack"]
D4b root Error maxDepth=0 -> 182 bytes; MaxDepth= false
D4c cyclic Error cause -> 197 bytes; Circular= false ; causePresent= false
D5 denial -> 401 cache-control=undefined
```

### 7.2 Focused test (post-fix) — from `server/`

```
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m8-observability.test.ts
```
```
exit=0
# tests 34
# pass 34
# fail 0
# skipped 0
# todo 0
# duration_ms 851.2136
ok 25 - mountObservability: attaches context, observability and the ops router
ok 26 - ops: a dependency check that never resolves is cut off and reports not_ready
ok 27 - ops: a resolved check clears its timeout handle (no leaked timer)
ok 28 - ops: liveness that never resolves is bounded and reports unavailable
ok 29 - ops: empty readiness is not_ready unless the operator opts in explicitly
ok 30 - ops: /healthz stays live while a readiness dependency fails or hangs
ok 31 - metrics: unknown HTTP methods collapse into one bounded fallback bucket
ok 32 - logger: a cyclic Error is logged without throwing and without expanding
ok 33 - logger: an Error past maxDepth is bounded and its cause chain is cut
ok 34 - ops: metrics denials carry no-store
```

### 7.3 Adjacent consumer (not the full suite)

```
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m2-m3-mounting.test.ts
→ exit=0 · # tests 20 · # pass 20 · # fail 0
```

### 7.4 Typecheck — from repo root

```
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
→ tsc exit=0   (no diagnostics)
```
`server/tsconfig.json` includes only `src/**`; the test file is compiled by the `tsx` runner, so
`tsc` does not typecheck `tests/m8-observability.test.ts`.

### 7.5 Full suite

**Not run** — forbidden for this task.

---

## 8. Hashes (sha256, final state)

| Path | Before (baseline) | After |
|---|---|---|
| `server/src/routes/ops.ts` | `86a51bf23f38cbd0d1212a7d5126088af299c40635a8d47ce1cdac1dc441e39d` | see report |
| `server/src/services/logger.ts` | `1e059538d0f92614f045423f0ef83f2774c74ffc95cf25ef0546598f8dca0dee` | see report |
| `server/src/services/metrics.ts` | `d8d2ffad035c55f14119b87b42a65c1e62bf5e51d5d554d6a8e73f00edcacb59` | see report |
| `server/src/middleware/request-context.ts` | `a964db37a7e454ad7c7b8bd552822f6cf55ce65f48be9d8b6125d3c29ad13ec2` | **unchanged** |
| `server/tests/m8-observability.test.ts` | `f30ab221ba708e29232ede29a770b9f5783baf9823cada151c5d77cf67fc9af8` | see report |
| `docs/streams/server/W7-OBSERVABILITY-20261020.md` | `ABSENT` | see report |

The authoritative after-hashes are the ones submitted through `submit_task_report`; they were
computed after this file was written and no file was edited afterwards.

---

## 9. Limitations and coordination notes

1. **`request-context.ts` is unchanged.** None of the five listed defects is in it: the
   correlation id is already set on every response (including `/metrics` denials) because
   `mountObservability` installs the context middleware before the ops router, and the no-store
   gap was in the ops denial branch. Editing it would have been scope creep, so it keeps its
   baseline hash.
2. **Timeout is cooperative, not cancellation.** A dependency that ignores the timer keeps running
   in the background until it settles; the probe stops *waiting* and reports not-ready. The
   `ReadinessCheck` contract has no abort signal, and adding one would change a shared contract —
   reported, not invented.
3. **`route` label** is bounded only by the resolver; the default resolver collapses unmatched
   requests to `unmatched`, but an injected `routeResolver` could still return arbitrary strings.
   That is unchanged and out of this task's listed defects.
4. **Test #27 is a guard on the new implementation**, not a pre-fix failure: the old code had no
   timer at all, so the count was trivially unchanged. It fails if the `clearTimeout` is removed.
5. **No live verification.** No DB, orchestrator, container, listener, provider or secret was
   used; readiness was exercised only through injected predicates.
6. **`server/src/index.ts` still passes `readiness: [createDatabaseReadinessCheck()]`**, so
   production inherits the 2 s per-check bound without an index edit (I1 owns that file). The
   index was not modified.
7. **Full suite not run** (forbidden until both lanes stop). Only the owned test file plus the
   adjacent `m2-m3-mounting.test.ts` consumer were executed.
8. `reported ≠ accepted`; acceptance is the supervisor's/owner's decision.
