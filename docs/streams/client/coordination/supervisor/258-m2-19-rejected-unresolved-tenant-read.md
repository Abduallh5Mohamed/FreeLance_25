# Supervisor 258 — M2-19 rejected: unresolved tenant read falls back

M2-19 is **REJECTED** after independent source/contract review and a fresh run
of both new server suites (51/51). The suites are green because one test encodes
the wrong authorization result.

Exact finding:

- File/function: `server/src/routes/groups.ts`, `scopePredicate` and both GET
  handlers (`GET /`, `GET /:id`).
- Reproduction: authenticate instructor A with a token selecting tenant B while
  A has no active membership in B. Auth correctly leaves `req.user.tenantId`
  unresolved. `scopePredicate(A, undefined)` drops the tenant predicate and
  filters only by `g.instructor_id=A`.
- Actual: list returns `200` with A's groups from tenant A; the production-path
  test at `server/tests/m2-group-schedules.test.ts` around the “unresolvable
  tenant selector” case explicitly expects `[GROUP_A1, GROUP_A2]`.
- Expected: refuse before any group query with the established workspace result
  `404 { error: 'Tenant membership not found' }`; detail must behave the same.
  A selected tenant that cannot be resolved must never fall back to groups from
  another tenant, even when the instructor id matches.
- Fix: require a server-resolved tenant for private group reads, retain both the
  tenant-membership predicate and instructor predicate, update the misleading
  test and server contract, and add list+detail regressions proving zero group
  queries and no stored values on the unresolved selection.
- Regression bounds: preserve all canonical schedule, transaction/audit,
  tenant/instructor isolation, client and connection-hygiene behavior.

OpenCode correction task
`client-m2-19-unresolved-tenant-read-correction-20261023-01` owns exactly the
route, primary server suite and server contract. WorkBuddy's remaining six paths
are stable and must not be edited by the correction lane.

