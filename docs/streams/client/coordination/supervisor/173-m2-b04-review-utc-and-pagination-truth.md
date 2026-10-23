# M2-B04 requires UTC serialization and pagination-claim correction

Review `ff939422-4dd7-4231-a7db-892c6d229764`,2026-10-20 Cairo.
Consume worker065: task reported/stopped by `opencode-worker-b04-20261019`,
native session `ses_eaa141864ffeNwX5Q8gU9esQnE`, exited0; no active/ready/CLI.
Independent156 isolated tests pass (61 new+95 unchanged), server tsc exits0.
Positive import sentinels precede app imports; default DB/provider/dotenv bodies
are not used. Good dedicated injected router, tenant-derived course relation,
owner-first scope checks, course/unit-qualified writes, transaction/audit cleanup
and bounded keyset queries are preserved. No acceptance solely from these tests.

## F1: exact-UTC guarantee relies on an unconfigured SQL session timezone

Files/functions: `server/src/routes/course-units.ts`, `toUtcTimestamp`, DTO and
all unit SELECT/read-back projections; M2-B04-CONTRACT UTC section.
`server/src/db.ts` sets mysql2 `timezone:'+02:00'`; inspected installed mysql2
packet/parser code uses this to INTERPRET received wall time. This is not a
`SET SESSION time_zone` statement. No SQL session offset is configured by this
new module; docs incorrectly call the driver option an explicit session offset.
Existing tests seed already-correct Date.UTC objects, hiding that difference.

Reproduction (hermetic, not a claim about the actual live DB timezone): a permitted
UTC SQL session returns stored TIMESTAMP wall time `2026-10-20 12:00:00`; the
real installed mysql2 decoder with configured+02 interprets it as10:00Z. Real
GET/POST/PATCH handlers then expose10:00Z, expected stored instant12:00Z. Public
173 probe executes the actual driver decoder and real factory handlers with
injected connection. Driver-fixture self-test passes; three actual-handler
timestamp assertions fail. No DB/network/config/secret read or service startup.

Exact bounded fix: SELECT `UNIX_TIMESTAMP(u.created_at) AS created_at_epoch` and
`UNIX_TIMESTAMP(u.updated_at) AS updated_at_epoch` in list/current/read-back
projections, derive canonical ISO DTO timestamps from valid finite epoch seconds.
TIMESTAMP instant projection avoids driver datetime offset and named-timezone
tables. Do NOT change shared db/timezone/config, issue pooled session SETs or
add/subtract a guessed2/3hours. Preserve exactly seven public DTO fields, no epoch
leakage. Validate/materialize DTO inside transaction before successful write commit;
null/malformed epoch must not fabricate1970/current time or successful null dates.
Correct docs/comments to actual guarantees and remaining physical MySQL limits.
Regress all three handlers, DST/offset-independent epoch and malformed epoch cleanup.

## F2: pagination promise exceeds mutable-order behavior

File/function: GET comment and M2-B04-CONTRACT List ordering section claim that
keyset paging cannot skip/duplicate under concurrent writes. display_order is
mutable: after first page contains A(order0), moving A to2 can make it appear
again after the old cursor; moving an unseen row before cursor can omit it.
Expected truthful contract: deterministic tie-breaking on each current request,
bounded pages, NO cross-request snapshot/stable-once guarantee under reorder.
Fix documentation/claims and add a real-handler mutable-order example regression.
Do NOT invent snapshot tokens/version policy or change cursor/API to promise more.

## Next bounded correction

Fresh `client-m2-b04-utc-correction-20261020-01`, same exact five paths in
M2-B04-HANDOFF, human152 necessary-correction authority; predecessor stopped verified.
Preserve existing tenant-self accepted code/additive mount, owner gates/locks,
audit/noop/uncertain-commit disposal, index/page limits. Migration remains FILE
ONLY; physical FK/collation/server-timezone/query-plan compatibility needs later
authorized runtime preflight, not guessed success or DDL now.

Read-only public probe:
`C:/Users/BaraaWael/TabwebClientSupervisor/173-m2-b04-utc-probes.test.ts`.
Currently1/4 (driver self-test pass, three production routes fail). Exact read
grant only, no TEMP/general supervisor permission. Keep156 tests passing, add
real regression assertions in allowed suite; server tsc must remain0. No optional
lint/TEMP/debug/source-disable probe, no default adapters/live DB/network/npx fetch.
Stop ALL edits/checks before native report + concise worker reply; Codex reviews
stable source/tests/architecture before acceptance. No acknowledgment/per-batch STOP.
