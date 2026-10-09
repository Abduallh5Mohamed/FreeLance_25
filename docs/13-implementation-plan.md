# خطة تنفيذ المستودع

## هيكل target داخل الموجود

```text
src/
  app/ routes/ providers/
  auth/ tenant/ platform-admin/
  teacher/{catalog,students,groups,assessment,assignments,gradebook,attendance,staff,media}/
  student/{discovery,learning,assessment,assignments,progress}/
  parent/{links,reports}/
  shared/{api,i18n,ui,validation}/
server/src/
  middleware/{auth,permissions,tenant}/
  domains/{identity,tenants,catalog,enrollment,media,assessment,assignment,attendance,live,parent,usage,moderation,support,notification,audit,export}/
  routes/ repositories/ providers/ jobs/ observability/
server/migrations/ tests/{unit,integration,security}/
```

هيكل مقترح لتقسيم المسؤولية؛ لا تنقل الملفات دفعة واحدة. existing routes/pages يظلون legacy حتى يملك بديل اختبارًا، وبعدها deprecate بمسار واضح.

## M1 tasks وترتيبها

1. Snapshot/restoration, production route/schema inventory. Acceptance: restore record and drift ledger.
2. Secret inventory/rotation, signup role allowlist, remove unsafe defaults. Acceptance: fail closed tests.
3. Unified principal, tenant membership, session issue/refresh/revoke. Acceptance: identity/session tests.
4. Capability policy + route middleware + admin separation. Acceptance: role capability matrix.
5. Tenant repositories/composite constraints and legacy quarantine. Acceptance: no cross-tenant fixture writes.
6. File/video/object/job/socket tenant verification. Acceptance: A→B denies across all channels.
7. Remove runtime DDL/migration endpoints and hard-delete orphan route. Acceptance: no schema mutation by request and deletion is reversible/audited.
8. Cross-tenant integration and recovery suite. Acceptance: passing before M2 begins.

## M2–M8 implementation order

Use every item in `17-full-feature-backlog.md` as acceptance source. For each feature: migration/API contract → service/policy → UI/state/error/accessibility → observability → unit/integration/security test → run evidence → commit. Build domain modules per roadmap; ensure each route/API has a negative permission/tenant test, not only happy-path UI.

## Database migration discipline

Idempotent versioned SQL; zero runtime DDL; staging snapshot; backup+restore; counts/checksums; mapping report; quarantine ambiguous rows; forward compatibility; rollback or recovery plan; deploy migrator controlled; post-migration invariants. No destructive cleanup based on old dev scripts.

## CI and local workflow

Current scripts: root `npm run build`, `npm run lint`, `npm run test:access`; backend `cd server; npm run build`, `npm test`. Confirm lockfiles/dependencies installed and MySQL/MinIO settings from safe `.env.example`, never commit `.env`/credentials. Add stable service-free domain tests before live integration tests. Local integration requires disposable MySQL/MinIO and fixture reset commands; document each exact command in the milestone closeout.

## Commit policy

One commit per completed milestone with clear message (`feat(m1): ...`). Do not bundle failing tests; do not start the dependent milestone while gates fail. Earlier commits remain individually revertible. Do not claim production deployment unless it was actually demonstrated.
