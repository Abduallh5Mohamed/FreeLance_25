# 202: M2-12 submission requires bounded client correction

Worker073/task196 reported/stopped. Independent fresh tests324 server +413 client
pass; server tsc0, frontend tsc exit2 with eleven known OUTSIDE diagnostics and
zero branding diagnostics. Read actual router, migration, injected harness,
composition mounts, DTO/transport/controller/card and scope contract. Backend
owner lock/no-op/audit/epoch/precommit DTO/cleanup bounds reviewed; migration FILE
only. Whole branding batch is NOT accepted until the failures below close.

Public immutable synthetic production probes:
C:/Users/BaraaWael/TabwebClientSupervisor/202-m2-12-independent-probes.test.ts
Fresh result0/4, no DB/provider/browser/network. These test actual branding.ts.

1. parseTenantBranding ISO validation accepts 2026-02-30T12:00:00.000Z because
   JavaScript normalizes it to March2. Expected reject; actual ok:true. Require
   finite date AND exact canonical round trip, including calendar invalid dates.
2. validateLabel accepts ' original ' and returns untrimmed text. Expected reject
   malformed server DTO; actual confirms it. Require value===value.trim() and
   canonical1..255 length; never normalize malformed2xx into confirmed success.
3/4. runSave retired response (success AND error) calls settleSupersededMutation
   against a NEW mutation: open/read/edit/saveA; close; reopen/read/edit/saveB;
   settleA while B is pending. Expected B remains saving with its own state;
   actual successA sets idle, errorA sets uncertain. A retired operation may not
   mutate a newer operation's mutation/error/notice/form. Track visible mutation
   ownership explicitly, preserve silent-principal clearing and own-ticket finally,
   and settle only the operation's own still-visible lifecycle. Test both outcomes
   and follow-up saves: no stale notice, false confirmation or released newer latch.

OpenCode correction exact THREE paths (narrow subset of stopped task196):
src/features/tenant/branding.ts; src/tests/m2-tenant-branding-ui.test.ts;
docs/streams/client/M2-12-CONTRACTS.md. No server/card/dashboard/api/shared changes.
Goal before/after: reject malformed canonical DTOs and preserve newer save state
against both retired outcomes; existing correct editor/uncertainty semantics stay.
Add production parser/controller regressions, run unchanged public2024/4, existing
413 client tests plus added tests and frontend tsc zero scoped/known11 outside.
No repeated human gate:180/152 necessary correction. No independent acceptance,
model switch, new policy, migration rollout or unsafe testing. Report/stop before
Codex reviews. WorkBuddy NEW batch may run ONLY on disjoint paths.
