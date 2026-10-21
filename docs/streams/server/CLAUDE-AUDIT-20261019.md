# Claude audit-chain correctness pass — 2026-10-19

Task: claude-audit-chain-correctness-20261019-01 (worker claude-audit-upfzr0).
Scope: server/src/routes/audit-logs.ts, server/src/services/audit-log.ts, server/tests/m7-audit-logs.test.ts.

## Source hashes (sha256)
| File | Baseline | Current |
|---|---|---|
| routes/audit-logs.ts | 439a39ce708637be82b35ebce8e5db9c0ce050a0be366c8ca4b113392ba565f7 | d14bc1af8f5dad25c8fbd961ada9be28c5bb957d62465924fb42ff15486d9cca |
| services/audit-log.ts | 6e9c1b95865c7cd3e2ab43675580820fa674393dc2c631f7b14c43f52bf67474 | e46b7f9129ce189841911f9a35bf12f20d49bfaf4da326900bad90f36329a103 |
| tests/m7-audit-logs.test.ts | 2fdfdf80f795ff303a10d6e3e0c7ea1819e656374059e6488f63bf71d8c3d656 | 79439371ea039d7aec00a807c7f421d9141a6549c7baa1760286546863e70cef |

## Defects proven (failing test first) and fixed
1. Production `isPlatformReader` SQL selected `ur.user_id` with no `ur` alias: every
   request to the list/export routes would fail with an unknown-column error (500),
   including tenant owners. Fixed: `PLATFORM_READER_SQL` (exported) selects `u.id AS user_id`;
   same predicate (active super_admin or `audit.read` holder). Test checks every alias is declared.
2. Hash canonicalization vs MySQL JSON columns: the writer hashed the insertion-order
   string while verification re-reads MySQL-normalized objects (keys ordered by byte length
   then bytewise), and an explicit JSON null hashed as `null` vs `''` on re-read. Valid chains
   would report payload-hash-mismatch (e.g. the export audit row's multi-key payload).
   Fixed: both sides normalize nested key order the MySQL way and treat JSON null as SQL NULL.
   Legacy rows whose insertion order already matched MySQL order keep their hash.
3. verifyAuditChain head/leaf are separate reads; an append between them gave a false
   head-anchor-mismatch. Fixed: re-read the pair up to 2 more times; persistent mismatch
   (real truncation) is still reported.
4. Scan cap was silent. Added `truncated: boolean` (query LIMIT cap+1). `ok` semantics unchanged
   (no failure in scanned rows); consumers should treat `truncated` as not fully verified.

## Verified no defect
Concurrent append (head FOR UPDATE + CAS retry + compensating restore), monotonic chain_seq
ordering, gap detection, tail truncation via anchor (incl. all rows deleted), tenant-owner pinned
to own tenant, platform permission via server-verified lookup (not role label), pagination caps,
CSV formula neutralization, export audited before response, no UPDATE/DELETE on audit_events,
generic 4xx/500 error bodies.

## Commands
`node node_modules/tsx/dist/cli.mjs --test tests/m7-audit-logs.test.ts` (cwd server): baseline 30 pass;
after new tests before fix 6 fail; after fix 36 pass, 0 fail. `tsc --noEmit -p .` printed no errors at final run.
Existing deepEqual route assertions gained the additive `truncated: false` field (not weakened).

## Residual
- JSON string scalars that look like JSON (e.g. value "123") remain ambiguous on re-read (unchanged).
- Rows sealed before this fix with multi-key payloads not in MySQL order already failed verification; not rewritten.
- Unsealed (entry_hash NULL) rows are counted but not a failure; no external anchor/durability; privileged DB access can rewrite everything.
- Export audit runs in its own transaction, not the read's connection (no data leaks on audit failure: 500 before send).
