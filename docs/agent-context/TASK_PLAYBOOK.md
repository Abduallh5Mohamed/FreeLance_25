# Bounded task playbook

Use this structure for implementation plans, agent handoffs and review notes.
It keeps work reproducible without copying the entire repository history.

## Before editing

Record:

```text
Goal:
Current behavior / reproduction:
Expected behavior:
Exact allowed paths:
Out of scope:
Security/data impact:
Tests to run:
Definition of done:
```

Then:

1. Check `git status --short` and preserve existing owners/dirty changes.
2. Find the production mount and the nearest tests.
3. Trace request -> auth/authority -> route -> service/store -> schema/provider.
4. Identify whether the task depends on unapplied schema or external state.
5. Prefer one coherent vertical batch over disconnected speculative helpers.

## Implementation

- Edit only the declared paths unless a concrete dependency forces a scope
  change; report that change before broadening materially.
- Reuse existing adapters, transaction helpers, DTO conventions and error
  vocabulary.
- Add failure-path coverage with the happy path.
- Keep external effects off during construction/import and tests.

## Review checklist

```text
[ ] Exact diff reviewed; no unrelated user work overwritten
[ ] Route is actually mounted (if runtime behavior is claimed)
[ ] Identity/tenant/workspace authority is server-derived
[ ] Queries are bounded, parameterized and explicitly projected
[ ] Mutation + audit are atomic; uncertain commit is not reported as success
[ ] No-op/retry behavior matches the contract
[ ] Cleanup and provider failure behavior are explicit and fail closed
[ ] Migration remains a file unless application was separately authorized
[ ] Focused tests, nearby regressions and types/build were run
[ ] Documentation status distinguishes source, configuration and runtime proof
```

## Handoff/result format

```text
Decision: accepted | correction required | blocked by external prerequisite
Changed files:
Verified behavior:
Commands and exact results:
Known limitations:
Next safe action:
```

For a rejection/correction, include exact file/function, reproduction,
expected/actual result and required regression test. Avoid vague statements
such as “needs cleanup” or “looks incomplete”.

