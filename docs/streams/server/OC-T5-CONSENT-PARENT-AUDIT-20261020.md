# T5 consent, parent links, audit — OpenCode report (T5c corrective pass)

Scope: T5c correction of the T5/T5b work under the same ownership. T5c changes
only the audit export truncation header name required by Codex review item 4.
No git/DB/Docker/network mutations were run in this pass; no dependencies,
migrations, shared helpers, index/auth/db files or frontend/bridge files were
touched. The notification-consent and parent-links files are untouched in T5c.

## Files changed in T5c

- server/src/routes/audit-logs.ts (truncation header renamed to `X-Results-Truncated`)
- server/tests/m7-audit-logs.test.ts (export tests assert the exact new header and that no other truncation header is emitted)
- docs/streams/server/OC-T5-CONSENT-PARENT-AUDIT-20261020.md (this report)

Retained from T5/T5b, not modified in T5c: `server/src/services/parent-links.ts`,
`server/tests/m6-notification-consent.test.ts`,
`server/tests/m6-parent-links.test.ts`, and the T5 files that T5b verified:
`server/src/routes/notification-consent.ts`,
`server/src/services/notification-consent.ts`, `server/src/routes/parent-links.ts`,
`server/src/services/audit-log.ts`.

## Hashes (sha256, T5c before -> after)

| File | Before | After |
|---|---|---|
| server/src/routes/audit-logs.ts | 6d368a860dd8782e68cebca54d9f6a91a6de93f0398bc4ff5ae399ac6318ef04 | aa4292033387c405e81c7c0af20f0e131c3e9c67914b86188b4d1196c003a336 |
| server/tests/m7-audit-logs.test.ts | a8bcbaa770db9ae88e70749ca680cc62334b59cfa4ac0994e450d4673391d90f | 0176a3d92ca7859d6164c89a7c32bf51978cceda4984846f247a40545bf49a08 |

Report file observed before T5c edits:
`fb2953f4901e62fc96feb9b5931939d92391663698d3f776cb3edd5b72f91c8b`.
A file cannot embed its own final hash; the observed hash of the saved report
is emitted in the run summary and must be recomputed after any later edit.

Earlier T5b hashes (context only): audit route
`08683e79...` -> `6d368a86...`; audit tests `79439371...` -> `a8bcbaa7...`;
parent-links service `4f230eba...` -> `4c876732...`; consent tests
`4a1a20ca...` -> `12cf5a4a...`; parent-links tests
`cd9179d9...` -> `c25ed16e...`.

## T5c defect reproduced (test first) and fixed

### Truncation header name

T5b introduced a single truncation response header named
`X-Audit-Export-Truncated`. Codex requires the one newly introduced truncation
header to be `X-Results-Truncated: true|false`. A read-only
`git show HEAD:server/src/routes/audit-logs.ts` confirms pre-batch code emitted
no truncation header at all, so there is no established pre-batch truncation
header to preserve. The `truncated` field in the export audit row is kept.

Reproduction (failed before the rename, passes after): the two export tests
were updated first to assert `x-results-truncated` exactly and that the only
response header whose name contains `truncat` is that one. Before the route
rename the focused file was 36/38; both tests failed with
`Expected undefined to be 'true'` / `'false'` because only
`x-audit-export-truncated` was emitted. After renaming the header the file is
38/38.

- `audit export: reaching MAX_EXPORT_ROWS exposes truncation through one header and the export audit row`
- `audit export: below MAX_EXPORT_ROWS exposes truncated=false in the same header and audit row`

Minimal repair: one response header name changed in
`server/src/routes/audit-logs.ts`. No response body/shape, audit-row key, CORS
or index configuration changed. Cross-origin exposure of `X-Results-Truncated`
is pending because shared CORS/index configuration is outside this pass's
allowed files.

## Test-first deviation (honest status)

Production code for three T5 behaviors was changed BEFORE their tests existed:
unsubscribe atomicity, parent-link audits, and export truncation. The T5b tests
were written after those production edits. No isolated reproduction of the
prior code was run and the shared dirty tree was not restored. Therefore the
before-proof (red evidence) for those three behaviors is **UNAVAILABLE**; no
retroactive red run is claimed. Only the T5c header rename above has an
observed red run (36/38 -> 38/38).

The sections below record the earlier code and the regression tests that now
pin the corrected behavior.

## Behaviors covered by tests written after the prior production edits

### 1. Existing-link verify left an unaudited view token when the audit write failed

Earlier T5 code (before-proof UNAVAILABLE): `services/parent-links.ts` minted
and inserted a parent view token for an already-active link, then wrote the
audit row outside any transaction. A failed audit insert could return 500 while
the token row stayed committed.

Regression test present (written after the T5 repair):

- `audit: a failed audit write rolls back a view token minted for an existing link`
  - forced audit failure -> 500; the fake store ends with zero view tokens.

Minimal repair (T5b): the existing-link branch now runs `mintToken(existing, store)`
and `recordAudit` inside the same `runAtomic` seam; `mintToken` takes the
transaction-aware store. No action name, response shape or authorization
changed.

### 2. Audit export truncation metadata

Earlier T5 code (before-proof UNAVAILABLE) had `/export.csv` set several
truncation header names simultaneously (`X-Truncated`, `X-Export-Truncated`,
`X-Audit-Export-Truncated`, `X-Audit-Truncated`, `Truncated`). This is a
historical description; no isolated red run against that code was performed.

Regression tests present (written after the production edits):

- `audit export: reaching MAX_EXPORT_ROWS exposes truncation through one header and the export audit row`
- `audit export: below MAX_EXPORT_ROWS exposes truncated=false in the same header and audit row`

Both tests assert the single header `X-Results-Truncated` (renamed in T5c) and
assert that no other response header name contains `truncat`. They also assert
the sealed export audit row's `newValue.truncated` is `true` at
`MAX_EXPORT_ROWS` and `false` below it. `exportAuditCsv` and chain hashing were
not modified.

### 3. Unsubscribe failure/retry semantics

Before-proof UNAVAILABLE (the atomicity change predates the tests). The current
route consumes the jti and writes the consent/channel-stop rows in one
`runAtomic` seam. The hermetic test injects a transaction that rolls back the
fake ledger on error, so it asserts the failure condition directly:

- `unsubscribe: a failed consent write rolls back token consumption so the same link can be retried`
  - forced consent-ledger failure -> 500; jti set is empty; no partial revoke;
    the original grant still allows delivery; retry with the same signed token
    -> 200 and applies the channel stop; replay -> 200, no new rows, one jti.
- `unsubscribe: a global signed token revokes every channel and never infers a tenant from the request`
  - a signed token with no channel/purpose revokes all 5 channels x 5 purposes
    for the signed `(userId, userType)` only; every row keeps `tenant_id = null`
    even when the request body carries `tenant_id: 'tenant-attacker'`.

### 4. Parent-link audit rows and domain atomicity

Before-proof UNAVAILABLE (the parent-link audit change predates the tests).
Tests assert exactly one audit row per create/verify/revoke and inspect the
entire insert payload (actor, tenant, action, resource type/id, and null
old/new/reason), rejecting any occurrence of the guardian phone/email, OTP
code, view secret or contact hash:

- `audit: creating a verified link writes exactly one audit row without contact, OTP or secret values`
- `audit: verifying an existing active link writes exactly one audit row and hides contact data`
- `audit: revoking a link writes exactly one audit row and a replay writes none`
- `audit: a failed audit write rolls back a new parent link and its view token`
- `audit: a failed audit write rolls back a parent-link revocation`

The create and revoke rollback tests assert writes shared the transaction; the
existing-link rollback test pins the T5b branch repair.

## Held items (not changed)

- Parent provisioning / who may request links: `server/src/routes/parent-links.ts:121`
  (`/request` only checks authentication) and `:158` (`/verify` likewise). G8 is
  a product/policy decision; no parent role provisioning exists.
- Parent-link invalidation rules (student deactivation, guardian phone change):
  `server/src/services/parent-links.ts:163` (`isStudentEnrollmentActive`) and
  `:176` (`studentMatchesContact`). Decision D2 remains undecided.
- Consent ledger vs `notification_preferences` source of truth:
  `server/src/services/notification-consent.ts:1` module contract. Decision D1
  remains undecided; the ledger was left authoritative for send-time checks.
- Tenant owners verifying the audit chain: `server/src/routes/audit-logs.ts:142`
  (`/chain/verify` is platform-permission only). Whether tenant owners may
  verify remains undecided.
- Export truncation boundary policy: `server/src/services/audit-log.ts:717`
  treats `rows.length >= MAX_EXPORT_ROWS` as truncated and does not fetch
  `cap + 1`; the task explicitly defined "rows reach MAX_EXPORT_ROWS" as the
  signal, so this behavior is preserved rather than decided as a new policy.
- Parent-link audit action naming (new link and existing link both
  `parent_link.verified`, revoke `parent_link.revoked`):
  `server/src/services/parent-links.ts:429,484,507`. Kept for compatibility;
  no product contract found that requires separate create/verify actions.
- Unsubscribe token tenant/global semantics: the signed token has no tenant
  field (`server/src/services/notification-outbox.ts:406`) and the route never
  guesses one; `notifications-consent` rows keep `tenant_id = null`. The
  existing global-unsubscribe behavior was preserved, not narrowed.

## Focused test results

T5c (the only tests run in this pass):

- `node node_modules/tsx/dist/cli.mjs --test server/tests/m7-audit-logs.test.ts`
  - before the header rename (tests updated first): 36/38, 2 fail (both export tests, missing `x-results-truncated`)
  - after the header rename: 38/38 pass

T5b context (not re-run in T5c): notification-consent 19/19, parent-links
30/30, audit-logs 38/38 at the end of T5b.

## Typecheck (provisional while other writers are active)

- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` -> no output (no errors at this snapshot; not proof of other lanes).

## Limits

- Hermetic tests only (injected SQL interpreters and transaction seam); real
  MySQL transaction/rollback ordering, actual audit chain sealing under
  concurrency, and provider delivery are unproven.
- The simulated transaction restores only link/view-token/audit state; the OTP
  consumption that happens before `BEGIN` intentionally remains consumed.
- Truncation tests assert the response header and the export audit row only;
  they do not prove a live DB returns 5000 rows under `LIMIT 5000`.
- Cross-origin visibility of `X-Results-Truncated` is unverified; CORS/index
  configuration was out of scope.
- No full test suite, DB, Docker or network run was performed. Only one
  read-only `git show HEAD:server/src/routes/audit-logs.ts` was run to check the
  pre-batch contract; no git mutation.
- Stopped writing.
