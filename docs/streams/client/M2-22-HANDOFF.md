# M2-22 handoff: published-course projection and public discovery

Task: `client-m2-22-published-course-discovery-20261023-01`

## Goal and before/after

Before: private course/unit/lesson management exists, but `/api/courses` is a
private workspace projection and there is no explicit course publication state
or safe public discovery surface.

After: an authorized teaching principal can explicitly publish or unpublish an
active course in the selected tenant. Anonymous callers can browse a bounded,
searchable fixed projection of published active courses and open one published
course summary. A new public page consumes only that projection. Publication
does not enroll a student, grant content access, expose lessons/files, charge a
price or create an account.

## Exact allowed paths

1. `server/migrations/20261023_03_course_publication.sql`
2. `server/src/routes/courses.ts`
3. `server/src/routes/public-catalog.ts`
4. `server/src/index.ts`
5. `server/tests/m2-course-publication.test.ts`
6. `server/tests/m2-public-course-discovery.test.ts`
7. `src/lib/api-http.ts`
8. `src/features/catalog/public-course-discovery.ts`
9. `src/features/catalog/course-management.ts`
10. `src/pages/Courses.tsx`
11. `src/pages/PublicCourseDiscovery.tsx`
12. `src/App.tsx`
13. `src/tests/m2-public-course-discovery.test.ts`
14. `src/tests/m2-course-management.test.ts`
15. `docs/streams/server/M2-B14-CONTRACT.md`
16. `docs/streams/client/M2-22-CONTRACTS.md`

## Required behavior

- Add one additive migration **file only**, never apply it: explicit draft/
  published course state, nullable server publication timestamp, and bounded
  discovery index. Existing rows remain draft; no backfill to published.
- Harden publication writes inside the existing private course router. Resolve
  selected tenant and teaching authority from authenticated server state,
  revalidate active membership and same-tenant course inside one transaction,
  accept exactly `{ publication_state: 'draft'|'published' }`, audit confirmed
  transitions atomically, make identical retries truthful no-ops, and destroy
  uncertain connections.
- Add an anonymous read-only public router with a bounded keyset list and exact
  detail. Search is an optional bounded trimmed name/subject term. Return only
  course id/name/subject/bounded description/grade, tenant id/business name and
  already-accepted localized branding fields. Never spread rows or expose
  owner/instructor/contact, internal status, price/payment/subscription,
  membership counts, lessons/files or unpublished rows. Bad/foreign/unpublished
  selectors return the same 404.
- Add a public `/discover` page backed only by strict adapters/controller.
  Extend the existing private Courses page with explicit publish/unpublish.
  Server response is authoritative; preserve principal/session/list/form/target/
  dispose fences, bounded paging and duplicate blocking.
- No signup/OTP, enrollment/access entitlement, lesson/file delivery, payment,
  provider/domain/DNS, live DB/network/browser/service, dependency install,
  Git/deploy, M3 or migration application.

## Impact, tests and done

- Hermetic server tests cover strict publication transitions, tenant isolation,
  audit/cleanup, anonymous bounded list/search/detail, unpublished suppression
  and fixed projections with DB/provider/default/dotenv isolation.
- Client production tests cover canonical public adapters/controller/page state,
  malformed DTOs, paging/search races, private publish/unpublish duplication and
  stale principal/session/target replies.
- Run both new server suites plus relevant unchanged course/unit/lesson suites,
  both client suites and scoped types. Stop all activity before MCP report;
  report is not self-acceptance.
