# m2-m3 mounting test-contract correction implemented, tested and reported

Task: `audit-20261026-mount-test-contract-correction-01`
(worker `opencode-audit-mount-test-contract-correction-20261026`, correction
lane). Supervisor alone decides acceptance. No Git/GitHub command was used; no
live DB, migration, provider, payment, network, package install or deployment
was used. Native session ID and model ID were not available to this CLI session.

## Changed paths (exact, within allowedPaths)

- `server/tests/m2-m3-mounting.test.ts`
- Coordination report only: this file.

No production route, `server/src/index.ts`, helper or active WorkBuddy M2-23
path was edited. `server/src/index.ts`,
`server/src/routes/public-catalog.ts`, `routes/public-identity.ts`,
`routes/tenant-branding.ts`, `routes/tenant-self.ts` and
`server/tests/m2-public-catalog-composition.test.ts` were read only.

## Behavior before → after

Guarded baseline actually reproduced **18 pass / 2 fail** (20 subtests), not
20/2:

1. `mounting: no new path collides with an existing mount (segment-aware)`
   - Before: rejected `mount path collision between /api/public and
     /api/public`, although the real `index.ts` deliberately mounts
     `publicCatalogRoutes` then `publicIdentityRoutes` on the same prefix with
     disjoint concrete child paths (`GET /courses` only in the catalog router;
     the identity router registers no course-list route).
   - After: a narrow `VERIFIED_SHARED_MOUNTS` allow-list permits exactly
     `publicCatalogRoutes` + `publicIdentityRoutes` on `/api/public`. Every
     other duplicate path or segment-prefix collision still fails. The test also
     pins that no third variable may share `/api/public` and that
     `publicCatalogRoutes` mounts before `publicIdentityRoutes` so it owns
     `GET /courses`.
2. `mounting: every mounted path denies an anonymous caller without touching
   storage`
   - Before: `GET /api/tenant/branding` returned 404 because the guarded surface
     mounted the named localized `createTenantBrandingRouter` (which production
     mounts inside tenant-self at `/api/tenants/me/branding`) at the OLD
     `/api/tenant/branding` prefix.
   - After: both synthetic surfaces mount the matching injectable
     `createLegacyTenantBrandingRouter({ db, authenticate,
     loadActiveTenantAuthority: authorityTripwire })` at
     `/api/tenant/branding`, mirroring the production default mount. The probe
     still proves 401/403 and zero storage/authority calls. The localized
     factory's true `/api/tenants/me/branding` mount was not fabricated here;
     `m2-public-catalog-composition.test.ts` / existing tenant-self contracts
     remain the authority for that surface.

## Verification (exact commands / results)

| Command | Result |
|---|---|
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m2-m3-mounting.test.ts` | 20 pass / 0 fail (guarded baseline 18 pass / 2 fail) |
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m2-public-catalog-composition.test.ts server/tests/m2-c1-c4-public-identity.test.ts` | 20 pass / 0 fail |
| `npm run build` in `server/` | exit 0, no diagnostics |

## Limits

- Hermetic guarded tests and a TypeScript build only; no live MySQL, migration
  application or production acceptance is claimed.
- `npm run build` regenerated build output under `server/dist`; no tracked
  source outside `server/tests/m2-m3-mounting.test.ts` was edited.
- Supervisor decides acceptance.
