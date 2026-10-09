# M1 schema drift report

## Safe database boundary

The M1 compose stack targets only `tabweb_m1_test` on loopback port `13316` and a newly named Docker volume. No migration or write was run against the existing `Freelance` database. A prior read-only schema probe against that configured database found `courses.tenant_id` and `videos.delivery_provider` absent; that database was not changed.

## Differences found and disposition

| Code/runtime expectation | Migration state found | Disposition |
|---|---|---|
| Runtime routes expected `subscription_requests` and its `guardian_phone` column. | The fresh baseline did not create `subscription_requests`; a numbered migration altered it before any create. | Removed the invalid alter-only migration. Added the tenant-owned table after the SaaS foundation with the columns currently read/written by the route. |
| Video processing and upload endpoints read/write `videos.tenant_id`; jobs must carry tenant context. | The video system migration created `videos` and `video_processing_queue` without `tenant_id`. | Added nullable `tenant_id` plus indexes to both, wrote tenant ID on new uploads/jobs, and constrained session lookup, status updates, and processor selection. Legacy null-tenant rows remain inaccessible to tenant sessions and need an explicit data review. |
| Upload handlers returned `/uploads/...` links, which require public static serving. | The server no longer mounts public uploads, and no tenant-file metadata table existed. | Added `tenant_media_files`, an authenticated tenant-scoped download route, and metadata registration for exam images, message images, and premium-lecture receipts. Persisted old `/uploads/...` references are not rewritten automatically. |
| `instructor_wallets` / related tables must reference UUID user IDs. | An older migration with integer instructor IDs conflicted with the later UUID-safe version. | Removed the obsolete integer-key migration from the ordered fresh-install chain; retained the UUID-safe migration as the sole instructor-system migration. |
| `student_fees` route expects tenant ID, student metadata, `payment_year`, `payment_month`, and generated remaining amount. | Static replacement table includes these fields. The fees API previously omitted `tenant_id` in inserts and used ID-only lookups/updates/deletes. | Added authenticated tenant scope to fees CRUD and server-derived tenant IDs to fee inserts. Payment approval now inserts tenant-owned fees. The behavior still requires the isolated integration run. |
| `revenues` route expects amount, source, description, date. | Static replacement table includes these fields plus required `tenant_id`; legacy payment approval inserted without tenant ID. | Payment approval now writes the request's server-owned tenant ID. `revenues.ts` itself is not mounted in `index.ts`; direct API access to it is not exposed. |
| `payment_requests` route expected a table that was absent from the fresh baseline. | No create-table migration existed; the route also read/wrote without tenant scope. | Added `20260929_payment_requests_tenant.sql`; rewrote the route to derive tenant from auth and scope list/create/approve/reject/stats. Needs fresh migration and integration verification. |
| Current video processing expects DRM/preview/provider columns. | Those are introduced by later `20260925_*` migrations, after the video base table. | Ordering is correct by filename, but the full MySQL 8 migration chain has not been executed here. |
| `students` runtime expects `instructor_id`, `user_id`, `tenant_id`, guardian fields, and auth revocation columns. | Those columns arrive across instructor, guardian, tenant-enrollment, and auth-revocation migrations. | Ordering is intended to satisfy dependencies; unverified until the fresh compose database successfully initializes. |

## Verification status

Static checks confirmed no runtime DDL remains under `server/src`. The backend TypeScript build checks call-site types only and does not validate database schema. The fresh migration stack has **not** been run because Docker Desktop's engine socket is unavailable. This is therefore a list of identified drift and fixes, not proof that the full schema has zero drift. The M1 gate stays blocked until fresh MySQL 8 initialization and all integration tests pass against it.

## M1 test database

Create an ignored `.env.m1` with `npm run m1:env`; start only the isolated services with `docker compose --env-file .env.m1 -f compose.m1.yaml up -d`; set the server process environment from `.env.m1`; run `npm run seed:m1` from `server`; start the API with `npm run dev:server`; then run `npm run test:m1:integration`. Never point these commands at the normal `.env` database.
