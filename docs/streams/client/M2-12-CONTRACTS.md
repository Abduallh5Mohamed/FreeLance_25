# M2-12 Contracts — private branding editor, local preview and client lifetimes

**Task:** `client-m2-12-private-branding-20261021-01` — team `integration`, the
thirteen approved paths only, `implementationWorker: workbuddy`.
**Correction:** `client-m2-12-canonical-dto-retired-save-correction-20261021-01`
— team `frontend`, `implementationWorker: opencode`, `taskKind: correction`,
three approved paths only (`src/features/tenant/branding.ts`,
`src/tests/m2-tenant-branding-ui.test.ts`, this document). The correction closes
the three failures of supervisor/202 and does NOT widen the batch scope.
**Server contract:** [M2-B06-CONTRACT.md](../server/M2-B06-CONTRACT.md).
**Handoff:** [M2-12-HANDOFF.md](M2-12-HANDOFF.md).

This document is an execution and coverage contract. **It is not acceptance.**

## Client paths (three of the thirteen)

| Path | Change |
|---|---|
| `src/features/tenant/branding.ts` | **new** injected parser/controller: DTO validation, form model, dirty subset, local preview, all lifetimes |
| `src/features/tenant/TenantBrandingCard.tsx` | **new** Arabic/RTL card: explicit open, labelled fields, inherit controls, read status, confirmation, local preview |
| `src/lib/api-http.ts` | **additive only**: `TenantBranding`, `TenantBrandingEnvelope`, `getMyTenantBranding`, `updateMyTenantBranding` |
| `src/pages/InstructorDashboard.tsx` | **additive only**: one import + one `<TenantBrandingCard />` mount |
| `src/tests/m2-tenant-branding-ui.test.ts` | **new** 83 tests |

The shared `request`, the auth/session contract, the error contract and every
accepted adapter in `api-http.ts` are unchanged. The dashboard's profile,
in-name, wallet, subscription, stats and quick-action logic and its routes are
unchanged.

## Transport (additive adapters)

- `GET /tenants/me/branding` → `request<TenantBrandingEnvelope>('/tenants/me/branding')`.
  Same authenticated `request`, same bearer header, **no** client tenant selector
  in header, query or body, and no query string at all.
- `PATCH /tenants/me/branding` sends **only the fields the caller set**:
  `undefined` means "do not send", an explicit `null` means "set it back to
  inherit". A partial save can therefore never silently clear a value the user
  did not touch.
- The transport still throws the server's `error` message **without** the HTTP
  status and **without** the `code`, so only documented messages classify an
  outcome. The canonical `BILLING_ONLY` identity event + redirect and the
  `TENANT_SUSPENDED` teardown are preserved untouched.

## Runtime DTO validation

`parseTenantBranding` requires a non-null object whose key set is **exactly** the
four projected fields, then validates each value:

| Field | Accepted |
|---|---|
| `display_name_ar` / `display_name_en` | `null`, or a string that is **already trimmed** and is 1..255 characters long |
| `accent_color` | `null`, or exactly `#` + six **UPPERCASE** hex digits |
| `updated_at` | `null`, or a finite canonical ISO instant `YYYY-MM-DDTHH:MM:SS.sssZ` that re-serializes to the very same string |

**A `null` instant beside a non-null field is a contradiction and is refused.**
`updated_at: null` is legal only for the genuinely absent row, so the DTO cannot
both describe a stored row and claim it does not exist. An extra key, a
lowercase color, a shorthand/named/`rgb()`/URL color, an empty label, an
over-long label or a non-ISO instant is a **malformed response** — never a
fabricated branding. A 2xx with a malformed body is **not** a success.

### The canonical DTO rules (correction, supervisor/202)

The server is the authority and it never emits a non-canonical value: it
**trims** every label it stores and projects a real epoch into a canonical ISO
instant. The client therefore REFUSES a non-canonical value instead of
normalizing it into a confirmed success:

- **An untrimmed label is malformed.** `value === value.trim()` is required and
  the 1..255 length is measured on that canonical value. `' original '` is a
  malformed server DTO, not a label this client may clean up. The local DRAFT
  path is unchanged: a draft is still trimmed before it is sent.
- **A calendar-impossible instant is malformed.** JavaScript *normalizes*
  `2026-02-30T12:00:00.000Z` into `2026-03-02T12:00:00.000Z`, so a pattern
  match alone would accept an instant the server can never have produced. The
  instant must survive an **exact canonical round trip**
  (`new Date(value).toISOString() === value`), which refuses every impossible
  calendar date while a real instant of the same shape is still accepted.
- A malformed 2xx body stays **uncertain**: the draft is preserved, no success
  is claimed and nothing is retried automatically.

`parseTenantBrandingEnvelope` requires the envelope key set to be exactly
`{ branding }`.

## Form model

Each of the three fields is a draft `{ inherit, text }`. `inherit` is the user's
explicit choice of the `null` ("inherit the existing presentation") value; the
`text` is retained but not effective while `inherit` is on, so toggling it back
restores what the user typed instead of losing it.

- The editor is seeded from the confirmed values (all-inherit when the row is
  absent) and can only be opened from a settled `ready` or `empty` phase.
- **Local validation runs before any request**: a non-inherited label must trim
  to 1..255 characters, and a non-inherited color must be `#RRGGBB` (either case,
  canonicalized to uppercase). The draft is kept and the message is local.
- **Only the dirty subset is sent.** A field is transmitted only when its
  effective value differs from the value the editor was opened with; a
  whitespace-only or case-only difference is **not** a change.
- **A save with no effective change sends NO request at all** — no silent enabled
  no-op.
- Choosing inherit sends an explicit `null`; an untouched field is never sent.

## Lifetimes fenced in the controller

| Fence | Behaviour |
|---|---|
| read generation | every read advances it; a superseded reply never commits |
| read latch | one read at a time; a double-clicked open/refresh sends one request |
| request generation + write latch | one save at a time; a double-clicked save sends one write; acquired synchronously before the first await |
| **visible-mutation ownership** | the save that owns the visible mutation owns its status, error and notice. A **retired** reply settles the visible mutation only while it still owns it, so an older reply can never clear a newer save's `saving` status, its error, its notice or its form |
| form generation | opening, cancelling or invalidating advances it, so a late reply never rewrites or closes a newer form |
| confirmed-write epoch | a read that started before a confirmed save never overwrites it |
| phase owner | a retired read still settles the `loading` phase it owns, so the panel never hangs |
| principal at entry **and** at completion | observed on the success and the failure path; a **retired** reply observes it **before** it settles any visible state |
| own-ticket release | `release(ticket)` frees only its own latch, so an older `finally` never releases a newer flight |
| close / dispose | clears the confirmed branding, the drafts, the notice and the preview, and drops every in-flight reply |

A **definite** denial (expired/invalid session, suspension, billing-only,
owner-only `Forbidden`, missing workspace) clears the private state and retires
in-flight work. A **retryable** read failure (handler 500, network, unrecognized
message) keeps the draft, because no permission loss was proven.

## Honesty rules

- A confirmed save shows the validated **server** DTO only; the form closes only
  if the form this save belonged to is still current.
- An **uncertain** save (handler 500, network, malformed 2xx) preserves the draft,
  states the uncertainty and offers a deliberate read. **No write is retried
  automatically.**
- The reconciliation read shows the **current** server state and is never proof
  that the earlier save (or its audit event) succeeded.
- A definite denial or an invalid payload is reported as the server's own
  message, not as an uncertain outcome.
- A **retired** save (one whose request generation was superseded) never
  settles a **newer** operation's visible state. It may not set the visible
  status to `idle` or `uncertain`, may not write a stale error or notice, may
  not claim a confirmation and may not release the newer flight's latch — on
  both the success and the failure outcome. It still observes the canonical
  principal before it settles anything, and it still releases only its own
  ticket in its `finally`.

## Preview

The preview is **local and unsaved**, and exists only inside the card:

- with the editor closed it shows the confirmed values and is labelled
  `مطابقة للمحفوظ`; while editing it shows the local drafts and is labelled
  `غير محفوظة`;
- it switches the Arabic slot (`dir="rtl"`) and the English slot (`dir="ltr"`)
  **inside the preview only** — the application's own direction, language, theme
  and providers are untouched, and switching sends no request;
- an inherited slot renders no label and no color, honestly;
- the accent color is applied as CSS **only** after strict `#RRGGBB` validation,
  so it can never become raw CSS, a URL or markup. The raw draft text does appear
  in the input's own `value` (the user must see what they typed) but never in a
  `style` attribute;
- no logo, background, upload, network image fetch, `localStorage`,
  `sessionStorage`, IndexedDB or clipboard is used.

## Accessibility (Arabic / RTL)

- the panel is opened **explicitly**; no branding request is made for a viewer
  who never opens it;
- every input has a bound `<label htmlFor>`, every inherit control is a real
  checkbox with its own bound label, and every feedback region is
  `aria-live="polite"`;
- the editor renders **exactly one** `type="submit"` control and every
  non-submit control carries `type="button"`, so a cancel, a preview switch or a
  reconcile button can never submit the form;
- the **close control is never disabled**, so a pending read can always be
  dismissed;
- the owner-only nature is a **label**; the capability is never inferred from the
  local role, profile or tenant status, and a denial is shown as the server's own
  message.

## Verification actually run

### Original batch (`client-m2-12-private-branding-20261021-01`)

| Command | Result |
|---|---|
| `npx tsx --test src/tests/m2-tenant-branding-ui.test.ts` | **83 pass / 0 fail** |
| `npx tsx --test src/tests/m2-course-management.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts` | **330 pass / 0 fail** (unchanged) |
| `npx tsx --test src/auth/access-control.test.ts` | **9 pass / 0 fail** (unchanged) |
| `npx tsx --test src/tests/m2-*.test.ts` | **694 pass / 0 fail** (the whole M2 client set, including the 83 new) |
| `npx tsc --noEmit -p tsconfig.app.json` | **0 scoped diagnostics**; 11 pre-existing errors outside scope |

### Correction (`client-m2-12-canonical-dto-retired-save-correction-20261021-01`)

Every command below was run with the local `node_modules/.bin/tsx` and
`node_modules/.bin/tsc` (no install, no fetch, no network).

| Command | Result |
|---|---|
| `tsx --test C:/Users/BaraaWael/TabwebClientSupervisor/202-m2-12-independent-probes.test.ts` (unchanged public probe) | **before the fix: 0 pass / 4 fail** → **after the fix: 4 pass / 0 fail** |
| `tsx --test src/tests/m2-tenant-branding-ui.test.ts` | **89 pass / 0 fail** (83 unchanged + 6 added) |
| `tsx --test src/tests/m2-course-management.test.ts src/tests/m2-course-unit-ui.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-tenant-branches-ui.test.ts src/tests/m2-tenant-profile-ui.test.ts src/tests/m2-tenant-profile-edit.test.ts` | **330 pass / 0 fail** (unchanged) |
| `tsx --test src/auth/access-control.test.ts` | **9 pass / 0 fail** (unchanged) |
| `tsx --test src/tests/m2-*.test.ts` | **700 pass / 0 fail** (the whole M2 client set: 694 + the 6 added) |
| `tsc --noEmit -p tsconfig.app.json` | **0 scoped diagnostics**; **11** pre-existing errors outside scope, in the same 8 files as before |

The 11 outside-scope diagnostics are listed in
[M2-B06-CONTRACT.md](../server/M2-B06-CONTRACT.md#known-11-outside-scope-frontend-diagnostics-pre-existing-untouched);
none is in a file this batch created or modified. The correction added
**6** tests to the branding suite:

| Added test | Covers |
|---|---|
| `parser: a calendar-impossible instant is a malformed response` | the exact canonical round trip; 5 impossible calendar dates refused, 2 real instants accepted |
| `parser: an untrimmed server label is a malformed response, never a normalized confirmation` | 6 untrimmed labels refused, the canonical label accepted |
| `controller: a retired save success cannot settle a newer pending mutation` | the retired success keeps the newer save's `saving`/error/notice/form/latch and commits nothing |
| `controller: a retired save error cannot settle a newer pending mutation` | the retired failure does not make the newer save uncertain and leaves its draft, latch and follow-up save intact |
| `controller: a 2xx with an untrimmed server label is uncertain, not success` | the malformed 2xx stays uncertain, the draft is preserved, no automatic retry |
| `controller: a 2xx with a calendar-impossible instant is uncertain, not success` | the malformed 2xx stays uncertain, the draft is preserved, no automatic retry |

## Limits — what is NOT proven

- **No DOM paint, no real RTL layout, no real browser.** The component is
  rendered with the real React server renderer and the real shared UI primitives;
  its actual `onClick`/`onChange`/`onSubmit` callbacks are invoked from the
  production element tree. What is proven is behaviour, not pixels.
- **No real HTTP, no real DB, no live services.** The transport seam drives the
  real `request` with a stubbed `fetch`/`localStorage`/`window`.
- **No end-to-end authorization.** The server remains authoritative; the client
  never infers a capability.
- **No runtime rollout.** The migration FILE is not applied, so a real deployment
  answers a truthful 500 and the client shows that failure rather than inventing
  fallback data.
- **No performance claim** is made of any kind.
- **The canonical DTO rules are proved against the client contract, not against
  a live server.** The server's own trim/epoch behaviour was read from
  `server/src/routes/tenant-branding.ts`; no server file was modified and no
  server test was added by this correction.
- This document is **not** acceptance.
