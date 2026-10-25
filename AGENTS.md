# Tabweb Academy — agent entry point

This file is the mandatory, low-token entry point for any coding agent working
in this repository.

## Read order

1. Read [`docs/agent-context/README.md`](docs/agent-context/README.md).
2. Read only the topic file(s) it routes you to for the current task.
3. Inspect the current source and diff before editing. Documentation is a map,
   never proof that runtime behavior or a database migration exists.

Do **not** begin by reading every historical Markdown file. The root contains
many old deployment notes, completion reports, one-off scripts and archived
coordination records. They are evidence of past work, not the current source of
truth.

## Source-of-truth order

1. Current user request and repository-level instructions.
2. Current source, tests, configuration and `git diff`.
3. `docs/agent-context/` (maintained orientation and known state).
4. Current contracts/handoffs explicitly named by the task.
5. Historical reports and coordination logs only when provenance is needed.

## Non-negotiable working rules

- Preserve unrelated dirty work. Never reset, clean, stash, overwrite or delete
  user changes merely to obtain a clean tree.
- Never apply migrations, modify live data, use real providers, deploy, push,
  rotate credentials or spend money unless the user explicitly requests that
  exact external action.
- A migration file is not an applied migration. A factory is not a mounted
  runtime. A passing unit test is not production verification.
- Never log, paste or commit secrets, tokens, passwords, private student data or
  provider payloads. Refer to environment variable names only.
- Tenant, workspace, branch and identity authority must be derived server-side.
  Client selectors and JWT membership fields are selectors, not authority.
- Financial writes, access grants, notification delivery and provider callbacks
  fail closed when their required authority, schema or provider is absent.
- Use parameterized SQL, explicit DTO projections and bounded queries. Avoid
  `SELECT *` on new security-sensitive or cross-tenant surfaces.
- For a change, run the narrowest relevant tests plus type/build checks in
  proportion to risk. Report exact commands and results; do not call the whole
  project clean when only scoped checks ran.

## Keep this context useful

When a change materially alters architecture, runtime wiring, commands or a
feature's readiness, update the corresponding file in `docs/agent-context/` in
the same change. Do not copy transient chat logs into these files.

