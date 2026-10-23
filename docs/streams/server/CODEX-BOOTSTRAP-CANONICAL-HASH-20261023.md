# Bootstrap content hashes — source implementation

## Four-lane continuation

The generator now rejects malformed UTF-8 with fatal decoding, preserves a BOM if present, and records raw SHA256 from the original byte buffer. This avoids decoded replacement characters being treated as reviewed source bytes. No generator or tests were run for this source adjustment.

Codex also added server/src/security/async-route-boundary.ts for eventual Express 4 integration: synchronous throws and rejected handler promises forward to existing error middleware. It does not mount routes or replace authentication. It is untested and not yet wired.

Independent source review of sensitive-action-mfa found that the guard requires a live session ID while the existing login/auth flow has no authoritative per-login session binding. Generic MFA route wiring remains blocked on a proper session contract; no constant-true liveness resolver or fabricated session ID is acceptable. No auth change or source DDL was made to bypass this prerequisite.

FOUR-LANE-MASTER-20261023.md now supersedes the prior topology. OpenCode owns only its 12 registered notification paths, Claude finance/schema, WorkBuddy its live task paths, and Codex shared integration/security/frontend. Prompts are prepared; native external execution must still be evidenced.

## Scope

Codex owns scripts/build-m1-bootstrap.mjs and server/bootstrap/m1/manifest.json. This source change implements a reproducible hash contract across CRLF and LF checkouts; it neither executes SQL nor accepts additional migrations.

## Change

Both reviewed and generated manifests declare contentHashEncoding=utf8-crlf-to-lf-v1. SQL transport CRLF is converted to LF before comparison and staging. No trimming, BOM removal, final-newline insertion or token rewriting is performed; a bare CR is rejected. Canonical content is staged as UTF-8. Generated manifests record canonical source hashes, raw checkout hashes and hashes of the actual staged SQL, including the existing explicitly reviewed groups ALTER transformation.

The dependency prelude is now hash-pinned as well as the database-collation prelude. An absent or different pin is refused. Destination nonexistence, exact source inventory, safety checks and exact transformation matching remain required. This is a staging generator, not a migration execution runner; stored-procedure execution compatibility is not certified here.

## Review provenance

Before conversion, all 59 migration byte hashes matched their existing reviewed manifest pins. The collation prelude also matched its prior pin. The dependency prelude's canonical content matched the committed HEAD version. The new reviewed manifest keeps all 61 old/raw-to-canonical provenance entries and the prior manifest hash under hashEncodingReview. No Claude B3/live migration was added to the reviewed inventory. A file or SQL content change cannot be accepted merely by regenerating this metadata: hashes were derived only after the previous pin matched.

Manifest SHA256 after conversion: 38553965d56bbd092daadaab5caff133749087e66a4422f54fdbdd4f9380e75c.

## Evidence limits

Source and metadata review only. No tests, generator staging run, typecheck, SQL, services or database were run for this change. Existing assertions tied to raw checkout hashes or format 2 may need a separately requested verification update. Cross-platform execution and semantic-tamper rejection are intended behavior, not newly executed evidence. Changes remain uncommitted. Claude's isolated checkout was not overwritten with Codex generator/manifest changes.

## Parallel allocation

WorkBuddy task server-live-persistence-recovery-20261023-01 registers 11 exact source/report paths, including five new live implementation modules; its hash is e745570be5413c1bf360fb426d54d7192d306f26a3dba248dafe226f994cce0b. Task is registered READY, not proof of native execution.

Claude's separate prompt covers 40 exact owned paths for financial persistence, published parent views and schema contracts. live06 remains read-only while WorkBuddy builds its adapter against its pinned source; schema revisions require a sequential contract handoff. New source paths were registered in both ownership files before worker writing. Full prompts live in C:/Users/abdua/opencode-reports/PROMPT-WORKBUDDY-LIVE-CLOSURE-20261023.txt and PROMPT-CLAUDE-FINANCE-PARENT-20261023.txt.
