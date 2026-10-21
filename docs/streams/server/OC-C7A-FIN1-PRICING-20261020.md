# OC-C7a / FIN1 — pure pricing, basis and period engine — 2026-10-20

Owner: OpenCode lane C7a. Governing scope: `docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md` line 35, then `docs/streams/server/OPENCODE-C1-C8-ALLOCATION-20261020.md` C7/FIN1. Prices, tiers, cycle and examples: `docs/19-commercial-registration-wallet-agreement-ar.md` lines 13-35, 39-54, 111.

## Result

FIN1 is delivered as three new pure modules and three hermetic acceptance test files:

- exact integer pricing in EGP minor units (piasters) over `bigint`;
- per-tenant unique-user timelines from the union of all student-teacher activation intervals, with sorted change points and no cross-tenant dedupe;
- UTC 30-day cycle windows and exact proration as one rational integral with a single final HALF_UP rounding;
- typed validation failures; no floating-point arithmetic, no `any`, no `ts-ignore`.

Nothing is mounted or persisted. No existing source file, `index.ts`, auth/middleware, `db.ts`, helper, migration, bootstrap manifest, frontend, bridge or Git state was changed. No SQL, store, HTTP route, invoice, collection, grace enforcement or vendor integration was created.

Tests were authored together with the new modules (new code, no pre-existing defect to reproduce), not test-first. During the first run one basis expectation was wrong (it expected a count-unchanged instant to be emitted as a change point); the test was corrected to the documented "instant where the count changes" rule. No production assertion or implementation branch was weakened.

## Files created and SHA-256

| File | SHA-256 |
|---|---|
| `server/src/services/billing-pricing.ts` | `de9acbd039227d85937d5c3fba38211b9753f9192c61df4da5d030f00f9bb1f5` |
| `server/src/services/billing-basis.ts` | `1bad24f209039a17bc11c972a1bf2a082bbbffa67dadd3755be7587ad25958df` |
| `server/src/services/billing-periods.ts` | `468249e62c6cd6bbca708f9b294d299634b84c1b4650fe37307ba4bf0519b769` |
| `server/tests/billing-pricing.test.ts` | `37a5e732107963760e1623279e285c2ac21668569ad37bd1c0eb79f58c01c498` |
| `server/tests/billing-basis.test.ts` | `db533e8ba1109901ae860a1711c6eeed6b310355bf2e732fc6265d88823513e2` |
| `server/tests/billing-periods.test.ts` | `4e7b6266ea6f2afc7af0844339feafeabbb87e0c5b1d2ea7b4a8d445de0628c4` |

This report file cannot contain its own stable SHA-256; its hash is printed in the final chat summary after the last write.

## Tests and results

Command exactly as required:

```text
node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/billing-pricing.test.ts server/tests/billing-basis.test.ts server/tests/billing-periods.test.ts
```

Result: **29 tests, 29 pass, 0 fail** (`duration_ms` 539.7). Each file also passes on its own (8, 10 and 11 tests respectively).

### `server/tests/billing-pricing.test.ts` (8)

1. `teacher formula: approved docs/19 values` — pass (T(0)=T(50)=2000, T(51)=2050, T(100)=4500, T(150)=6750, T(200)=8750, T(500)=19250).
2. `center formula: approved docs/19 values including C(351) = 13030` — pass (C(0)=C(200)=7000, C(201)=7045, C(250)=9250, C(300)=11250, C(350)=13000, C(351)=13030 and explicitly not 13000, C(500)=17500).
3. `teacher and center cumulative tiers match the closed form for 0..500` — pass.
4. `pricing engine reads the injected snapshot, not a global` — pass (custom snapshot changes every amount).
5. `default snapshot and its tier tables are frozen and validated` — pass.
6. `registration counts accept non-negative integers and bigint, reject everything else` — pass.
7. `invalid price snapshots are rejected with a typed error` — pass (missing id/currency, bad minor scale, missing open-ended tier, non-increasing boundaries, negative unit price).
8. `invalid organization is a typed error` — pass.

### `server/tests/billing-basis.test.ts` (10)

1. `empty event stream produces no timelines` — pass.
2. `200 students with 3 teachers each count once inside one center` — pass (change points `{0:200}`, `{2,592,000:0}`).
3. `overlapping intervals of the same user never double count` — pass.
4. `adjacent intervals [a,b) + [b,c) are continuous` — pass.
5. `one teacher relation expiring does not drop a user with another active relation` — pass.
6. `the same user in different tenants is counted once per tenant, never deduplicated across tenants` — pass.
7. `unsorted events are normalized into sorted change points` — pass.
8. `an end and a start at the same instant do not create a spurious change point` — pass.
9. `invalid event streams are rejected with typed errors` — pass (non-array, non-object, bad/missing ids, negative/fractional/NaN seconds, `end <= start`, event index reported).
10. `countUniqueUsersAt validates its instant and uses half-open boundaries` — pass.

### `server/tests/billing-periods.test.ts` (11)

1. `cycle and grace constants match docs/19` — pass (`CYCLE_SECONDS=2,592,000`, `NINETY_SIX_HOURS_SECONDS=345,600`).
2. `cycle windows are consecutive 30-day half-open UTC intervals` — pass.
3. `cycle windows reject invalid start/count` — pass.
4. `a 51st registration active for exactly one hour prorates to 2000.07 EGP` — pass (`200,007` minor; exact numerator `200,000*2,592,000 + 5,000*3,600`).
5. `50 registrations then the 51st for the second half of the cycle is 2025 EGP` — pass (`202,500` minor).
6. `a center with 200 unique students for a full cycle pays the 7000 EGP base` — pass (`700,000` minor).
7. `basis union feeds pricing: 200 students x 3 teachers -> 200 -> 7000 EGP` — pass (basis and pricing composed without a store).
8. `center C(351) is 13030 EGP and not 13000 EGP` — pass (`1,303,000` minor).
9. `the integral is rounded HALF_UP exactly once at the end` — pass (three one-third-cycle segments sum to 1 minor unit; per-segment rounding would give 0).
10. `exact half rounds up and just below half rounds down` — pass.
11. `proration rejects malformed windows, segments and snapshots with typed errors` — pass (wrong duration, gaps, overlaps, unsorted/out-of-window, negative/fractional counts, missing coverage, bad snapshot/organization).

## Implementation notes

- Money: `bigint` minor units; `DEFAULT_PRICE_VERSION` = EGP with `100n` piasters per pound. The engine validates and deeply freezes a caller-supplied snapshot on every call and never reads the default implicitly.
- Teacher and center schedule differ only by injected `includedRegistrations`, base amount and tier table; the calculation is cumulative, not a whole-count marginal rate.
- Basis groups by `tenantId`, unions each user's intervals across teachers, merges adjacent intervals (`interval.start <= last.end`), aggregates end/start deltas at the same instant, and emits only instants where the unique count actually changes.
- Periods require a complete, sorted, contiguous, non-overlapping cycle coverage; anything else is rejected rather than guessed. The exact rational is retained in `exactNumeratorMinorSeconds` / `exactDenominatorSeconds`; HALF_UP is applied once in `divideHalfUp`.
- UTC epoch seconds are accepted as safe-integer numbers (or bigint within the safe range) and converted to bigint for all interval arithmetic. No local-time/DST conversion exists.

## Schema / contract assumptions handed to I2 (not created)

1. **Price-version snapshot** — immutable row keyed by a stable `price_version` id (bounded string), currency, minor-units-per-major, and the teacher/center schedules (included count, base amount, ordered cumulative tiers with inclusive upper bounds and a final open-ended tier). Amounts should be stored as integer minor units; if JSON is used, amounts must be decimal strings, never floats. `DEFAULT_PRICE_VERSION.id = "docs19-2026-10-20"` is a local fixture, not an authoritative persisted id.
2. **Activation events** — immutable `event_id` unique per tenant, `tenant_id`, `user_id`, `teacher_id`, `starts_at`, `ends_at` as integer UTC epoch seconds (`BIGINT`, within the JS safe-integer range used here), no direct edit; corrections via compensating event + reason. Retry deduplication belongs to the producer (C5) and I2, because the pure basis interface intentionally has no event id. Identical duplicate intervals are harmless to the union, but that is not a substitute for event-id idempotency for differing payloads.
3. **Billing period / invoice line (FIN4, later)** — cycle `[start, end)` is exactly 2,592,000 UTC seconds and stores `price_version_id`; lines must preserve each segment's count, duration, and exact integral numerator/denominator (or enough data to rebuild them) so a later invoice is reproducible from the event log. The current modules do not write or read any of this.
4. **Time** — calculation uses epoch seconds only; tenant-timezone display is separate and must not change the stored interval. The 96-hour constant is stored/exported as a duration only.

No migration, DDL, table, index, store interface or bootstrap entry was authored. These are assumptions for I2's review, not evidence that SQL exists or works.

## Held / policy items (not decided here)

- **Real relation-start event and canonical enrollment relation (D3).** Held by `docs/streams/server/OPENCODE-C1-C8-ALLOCATION-20261020.md:56`, `:67`, `:77`, `:95` and `docs/19-commercial-registration-wallet-agreement-ar.md:39`. C7a accepts intervals only; C5/FIN2 produces the real event stream.
- **Invoices, renewal reconciliation, first base invoice without predicted count, previous-period adjustment, credit allocation.** Held by `docs/19-commercial-registration-wallet-agreement-ar.md:52`, `:56`, `:74`, `:97-101` and allocation `:66`, `:78-79`. Not implemented; no `billing-invoices.ts` was created.
- **Offers/discounts, taxes, fees and vendor items (D2).** Held by `docs/19-commercial-registration-wallet-agreement-ar.md:11`, `:54`, `:68`, `:90`, `:107` and allocation `:67`, `:71`, `:90(e)`. The engines do not model tax or fees; docs/19 line 54 explicitly says the example/equations do not define tax.
- **Collection, grace enforcement and the 96-hour start point.** Held by `docs/19-commercial-registration-wallet-agreement-ar.md:54`, `:76` and allocation `:80`. `server/src/services/billing-periods.ts:32` exports `NINETY_SIX_HOURS_SECONDS` only; there is no timer, status, blocking or collection logic.
- **Old `service-credit` is not a wallet and was not touched.** See `docs/19-commercial-registration-wallet-agreement-ar.md:95-101` and allocation `:62`. No new credit/ledger/wallet concept was added.
- **Zero-length activation event.** Task scope requires rejecting `end <= start`; `server/src/services/billing-basis.ts:148-150` does so. docs/19 line 111 says activation and termination at the same instant add no duration; if the product wants such an event persisted as a no-op, C5/I2 must filter it before calling the basis engine.
- **Partial-cycle/first-invoice policy.** docs/19 lines 39 and 52 leave first-invoice, renewal and partial-cycle behavior to FIN4. This module requires a complete cycle and does not decide those cases.
- **Authoritative price-version identity/versioning.** The numeric snapshot is approved, but the persisted id/version lifecycle is not. `server/src/services/billing-pricing.ts:303` is a fixture only.

## Limits (what this delivery does not prove)

- There is no store and no SQL. An injected price snapshot is not evidence that price rows exist, that I2's schema matches, or that any database arithmetic works. No test here touches MySQL.
- The basis engine does not decide eligibility: it accepts any interval supplied. Pending/rejected/expired/grace filtering, user identity unification and event production are C5/FIN2.
- No event-id deduplication, invoice persistence, idempotency key, period table, reconciliation or rebuild-from-events proof exists.
- No partial-cycle proration, tax, fee, discount, currency conversion, collection, dunning, grace or vendor behavior exists.
- No tenant existence, authentication or authorization is checked; callers must pass trusted ids.
- Timezone display is out of scope. Calculation is DST-independent because it only uses UTC epoch seconds.
- Tests are hermetic pure-function tests. Typecheck was provisional while other lanes were writing.

## Provisional typecheck

Command:

```text
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

The three new service files and their tests produce no diagnostics. At the last run the command exited 2 with errors only in another lane's new files, not edited here:

```text
server/src/routes/exam-manual-grading.ts(30,5): error TS2724: '"../services/exam-manual-grading"' has no exported member named 'ManualGradingErrorCode'. Did you mean 'ManualGradeErrorCode'?
server/src/routes/exam-manual-grading.ts(116,51): error TS2552: Cannot find name 'formatExamHundredths'. Did you mean 'formatHundredths'?
server/src/routes/exam-manual-grading.ts(122,34): error TS2304: Cannot find name 'ManualGradeErrorCode'.
server/src/routes/exam-manual-grading.ts(201,75): error TS2304: Cannot find name 'DEFAULT_PENDING_LIMIT'.
```

`git status` shows only the six new files above as untracked in this task's paths; other lanes' uncommitted edits were left untouched.

Writing has stopped.
