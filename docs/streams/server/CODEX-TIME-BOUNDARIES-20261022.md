# Codex time-boundary source review — 2026-10-22

## Result

The inherited source already contains the targeted DST-gap correction. No production source or test was rewritten in this task. The remaining-inventory entry describing this particular defect as still unfixed is stale; broader timezone/provider/operational acceptance remains separate.

Reviewed source: `server/src/services/content-release.ts`, SHA256 `e23dd1319ede6673ddf8bca6f4807b13cd3a53ccc8b8b8e222d3583b81cb60d1`.

## Existing behavior verified by source inspection

- `localWallTimeToInstant` parses real calendar fields, resolves the timezone offset in two passes, then formats the resulting instant back into the requested zone.
- It compares year/month/day/hour/minute/second with the authored wall time. A nonexistent spring-forward time cannot roundtrip and therefore returns `null`, rather than silently selecting an hour before the gap.
- Existing offset selection is unchanged. The documented New York fall-back overlap `2026-11-01 01:30:00` retains its first instant (`2026-11-01T05:30:00.000Z`) expectation. This review does not establish a new universal overlap policy for all IANA transitions.
- Existing `validateReleaseConfig` calls this helper and rejects `null` before a release-policy write. Existing route-test source asserts HTTP400, no `lesson_release_policies` insert, and no success audit for the New York gap.
- Assignments, announcements and schedules also import this helper; no caller was modified here.

## Existing test coverage read, not executed

`server/tests/m2-content-release.test.ts` already includes:

- nonexistent spring-forward denial and valid times around the gap;
- New York fall-back first-instant resolution;
- config rejection for a gap;
- router rejection before any write or success audit.

No tests were added or run, and no typecheck was run, following the parent task's explicit instruction. Earlier suite results are not reasserted as evidence from this pass. No database, listener, service, network or Git operation was performed.

## Ownership / stop state

Only this new report was written. `content-release.ts` remains byte-identical to the inherited snapshot. Writing has stopped. The parent supervisor can mark the specific DST-gap source defect as already corrected without rerunning its implementation, and retain any wider timezone acceptance work separately.
