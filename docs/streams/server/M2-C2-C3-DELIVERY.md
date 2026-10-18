# M2 C2+C3 — tenant branding, host resolution and custom domains (2026-10-18)

## Files changed
- `server/src/services/tenant-host.ts` — host-header to tenant resolution (exact verified host or single-label platform subdomain; port stripping; normalization via domain-verification validator; deny-by-default).
- `server/src/routes/tenant-branding.ts` — owner-only branding settings (logo URL, hex colors, locale ar/en, RTL flag) with audit.
- `server/src/routes/tenant-domains.ts` — custom-domain claim/verify/revoke/list using the existing verification service; cross-tenant and expired-challenge denial.
- `server/migrations/20261018_04_tenant_branding_domains.sql` — idempotent branding table, tenant subdomain column, domain challenge expiry column.
- `server/tests/m2-tenant-host-branding.test.ts` — rejection-path coverage.
- `server/bootstrap/m1/manifest.json` — manifest-only scope adjustment for the new migration hash.
- `docs/streams/server/M2-C2-C3-DELIVERY.md` — this note.

## Behavior
- Host resolution denies bad/unknown/unverified/suspended hosts and avoids wildcard confusion by requiring one label before a configured platform base domain.
- Branding mutations are owner-scoped, validated, audited, and fail closed on audit errors.
- Domain claims enforce cross-tenant denial before DNS; verification uses DNS TXT exact match; expired challenges (7-day TTL) are denied.

## Tests
- Focused: 7/7 pass.
- Full suite: 1235/1235 pass.
- Typecheck: `tsc --noEmit -p server/tsconfig.json` clean.

## Open questions
- Platform base domain defaults to `tabweb.app/tabweb.test/localhost`; production should set `PLATFORM_BASE_DOMAIN`.
- TLS issuance/renewal/revocation remains provider-dependent and is not implemented here.
- Challenge TTL fixed at 7 days; may need product-configurable expiry.
