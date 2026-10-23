# 207: M2-13 requires canonical-name correction

WorkBuddy075 reported/stopped. Independent review ran the real safe M2-13 server
and client sets: server447/447, client607/607, server types0, frontend zero scoped
diagnostics with the same11 known outside. Those counts are evidence, not acceptance.

Actual source review found a canonical DTO defect in both projections. Server
`academicPeriodDto` validates `name.trim()` but returns the original stored string;
client `parseAcademicPeriod` validates the trimmed value but also returns the
original response string. Therefore a stored/transported name such as
`"  October  "` is exposed and confirmed although all write paths canonicalize
names. Public immutable probe:
`C:/Users/BaraaWael/TabwebClientSupervisor/207-m2-13-canonical-name-probes.test.ts`.
Baseline is1/2: malformed untrimmed DTO accepted, canonical control accepted.

OpenCode correction task
`client-m2-13-canonical-name-correction-20261021-01` has exact SIX paths:

- `server/src/routes/academic-periods.ts`
- `server/tests/m2-academic-periods.test.ts`
- `src/features/tenant/academic-periods.ts`
- `src/tests/m2-academic-periods-ui.test.ts`
- `docs/streams/server/M2-B07-CONTRACT.md`
- `docs/streams/client/M2-13-CONTRACTS.md`

Expected: server stored-row projection rejects a non-canonical name rather than
emitting it; client parser rejects a non-canonical transported name rather than
normalizing or confirming it. Preserve strict input trimming, exact seven-field
DTO, date/range/timestamp/archive validation, transaction/audit/cleanup, paging,
controller lifecycle and all accepted work. Add real server/client regressions,
run unchanged public2072/2, the new M2-13 suites and the required nearby safe
sets/types. No migration/runtime/DB/network/provider/browser/shared mount/API/card
changes. Worker stops/reports; Codex independently reviews before acceptance.
