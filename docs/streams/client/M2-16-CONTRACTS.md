# M2-16 — client contracts for the audited idempotent student-row import

Task: `client-m2-16-audited-idempotent-student-import-20261021-01`.
Handoff: `docs/streams/client/M2-16-HANDOFF.md`.
Builds on: accepted M2-08 (local CSV preview), accepted M2-11 (local decisions +
JSON report), accepted M2-14 (read-only server reconciliation), accepted M2-15
(existing-match review).

M2-08, M2-11, M2-14 and M2-15 behaviour is **unchanged**. This batch adds
exactly one further step — one explicit confirmation of one previously
all-clear batch — and preserves the accepted preview, decision, report,
reconciliation and review controls.

## Modules

| Path | Change |
|---|---|
| `src/features/students/import-commit.ts` | **new** — strict DTO parsing + single-flight controller |
| `src/features/students/StudentImportPreview.tsx` | **additive** import seam, refs/state, gate, retirement sites and the emerald import block |
| `src/lib/api-http.ts` | **additive** `commitStudentImportBatch` adapter returning `{ status, body }` |

No auth, shared middleware, provider, package, schema or configuration file is
touched by this batch.

## The confirmation gate

`evaluateImportCommitGate(rows, resolution)` is the ONLY authorizer. It is
evaluated on **every render** from the live decision model and the CURRENT
confirmed reconciliation, so a decision, a review or a retired answer closes
the confirmation immediately.

Checks, in the order of the user's own questions:

| Order | Refusal | Meaning |
|---|---|---|
| 1 | `invalid-rows` | an invalid row exists; the whole batch is refused |
| 2 | `pending-rows` | a row is still undecided |
| 3 | `no-rows` | nothing is included |
| 4 | `too-many-rows` | more than 1000 included rows |
| 5 | `out-of-range` | a row number outside `2..1001` |
| 6 | `missing-name` | an included row has a blank name |
| 7 | `value-too-long` | a value exceeds the schema's own VARCHAR width |
| 8 | `not-reconciled` | no confirmed reconciliation exists |
| 9 | `reconciliation-stale` | the reconciliation does not answer **exactly** the current included set, in the same order |
| 10 | `existing-matches` | the reconciliation reported at least one match, or its summary does not balance |

A local review decision is **never** a write authorization: a `kept` row is
still submitted only after a FRESH reconciliation clears it, and a single match
anywhere refuses the whole batch. Every refusal names its reason and the
affected physical row numbers, so the button is never disabled without an
explanation on screen.

## Canonical payload and idempotency

```ts
canonicalImportCommitPayload(rows)  // [[2,"Ali","a@x.com","0100","","3",""], …]
```

The canonical form is a faithful projection in the given order — it never
reorders, renumbers or trims. The ascending guarantee belongs to the gate. Two
batches are the SAME batch exactly when this string is equal.

- one confirmation mints **ONE** opaque key (`^[A-Za-z0-9_-]{16,128}$`) for ONE
  canonical batch; a short, long or non-URL-safe key is **refused**, never
  weakened, and a key source that throws is refused as `unavailable`;
- a retry of an **UNCERTAIN** outcome (a 5xx or a transport rejection) reuses
  the **SAME** key and the **SAME** payload, so the server can replay the
  recorded result instead of creating twice;
- a **changed payload** can never inherit that key: the canonical form is
  compared first, and a different batch mints a new key;
- a **definite** outcome (`committed`, `rejected`, `conflict`, `malformed`)
  drops the attempt, so the next confirmation starts a new attempt.

## Status mapping

| Transport answer | Phase | Attempt |
|---|---|---|
| 2xx matching the documented DTO | `committed` | dropped |
| 2xx not matching the DTO | `malformed` | dropped |
| `409` + `STUDENT_IMPORT_IDEMPOTENCY_CONFLICT` | `conflict` | dropped |
| `409` + `STUDENT_IMPORT_EXISTING_MATCH` | `rejected` (`existing-matches`) | dropped |
| any other 4xx | `rejected` | dropped |
| any 5xx | `failed` | **kept** — retry reuses the key |
| transport rejection | `failed` | **kept** — retry reuses the key |

`parseImportCommitResponse` accepts exactly four keys (`batch_id`, `replayed`,
`created`, `row_numbers`), a `batch_id` of 1..128 chars, a boolean replay flag,
a positive integer `created` **equal to the submitted batch size**, and row
numbers **exactly equal** to the submitted ones in ascending order. Anything
else is `malformed`, never a partial success. The DTO carries no created
student id and no private value.

## Lifecycle fences

| Fence | Rule |
|---|---|
| Single flight | at most one submission is in flight; a second click is refused with `busy`, never queued |
| Ticket | every attempt takes a monotonic ticket; a reply whose ticket is no longer active changes nothing |
| Latch ownership | only the ticket that owns the busy latch may release it, so a retired reply can never release a NEWER latch |
| Principal | a principal change before a click refuses the request (`scope-changed`); a change during the flight drops the answer |
| Session | a session event clears the result and retires the pending reply |
| `clear()` | drops the result and retires the pending reply |
| `dispose()` | unsubscribes, retires everything and refuses further attempts |
| Reversed order | a retired reply cannot publish, cannot restore a dropped result and cannot release a newer latch, so a reversed success/error order is harmless |

## Wiring in the component

- the import seam is created in the **same mount effect** as the other
  controllers and disposed with them, so a closed panel can never land a batch
  confirmed before the close;
- the seam is read through `asCommitSeam`, a **method-checked** guard: a ref
  that does not hold the real controller never receives a confirmation;
- the import block renders only when `showDecisions && commitReady`, so a panel
  with no decision model offers no confirmation;
- a new file, a refused file, a closed preview, a reset, a session change and a
  **new reconciliation** all retire the confirmation, the result and any
  pending reply;
- `confirmImport` re-validates the principal **before** submitting and passes
  the CURRENT model rows and the CURRENT confirmed reconciliation, so the gate
  is re-evaluated from live state, never from a cached value.

## What the panel states on screen

- the import block is its own emerald block, separate from the local conflict,
  reconciliation and review blocks, because a confirmation is the only action
  in this panel that writes;
- it states that this creates **tenant student records only**, inside one
  indivisible batch, and that it creates no account, no login, no password, no
  invitation, no OTP, no enrollment in a group/course/branch, and modifies no
  existing record;
- it states that confirmation requires every row to be decided **and** a fresh
  reconciliation of exactly those rows to have reported every value clear, and
  that any existing value refuses the whole batch;
- it states that pressing the button is the request: nothing is sent
  automatically.

## Privacy

- no `localStorage`, `sessionStorage`, cookie, `console` or log write happens at
  any point: the private rows and the minted key never survive a call;
- the request carries exactly `idempotency_key` and `rows`, and each row carries
  exactly the seven documented keys — no `user_id`, `tenant_id`, `role`,
  `status`, account, enrollment, payment or selector field;
- the response is never echoed back with private values.

## Bounds

- the gate runs in one pass over the current model (at most the accepted
  1000-record bound), with one bounded map lookup per row and no all-pairs
  scan;
- at most one submission is in flight, so no unbounded queue can form;
- the retry control appears only in the `failed` phase, i.e. only when the
  outcome is genuinely unknown and the same key is safe to reuse.

## Not proven here

Real browser transport, DOM paint, RTL layout, the actual server commit (the
server contract and server suites cover it), any platform uniqueness claim, and
any existing-record identity (never requested, never returned, never stored).
