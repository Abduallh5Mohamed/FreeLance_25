# M2-15: explicit review of existing-record matches and combined local report

This larger NEW WorkBuddy client batch builds on accepted M2-11 local decisions/
JSON report and accepted M2-14 read-only server reconciliation. It lets the owner
explicitly decide what to do with rows that carry an existing server value and
produces one truthful local report containing both local exclusion reasons and the
server match-field warning. It still performs no import or server write.

Before: M2-14 shows matches, but its warning is not connected to local decisions
or the rejected/excluded JSON report. After: each matched included row becomes an
explicit review item. The user may keep it included or exclude it; nothing is
changed automatically. The local JSON report includes the last confirmed match
field names for excluded rows without including any existing record identity/data.

Task `client-m2-15-existing-match-review-report-20261021-01`.

## Exact seven allowed paths

- `src/features/students/StudentImportPreview.tsx`
- `src/features/students/import-resolution.ts`
- `src/features/students/import-report.ts`
- `src/features/students/server-resolution.ts`
- `src/tests/m2-student-import-resolution.test.ts`
- `src/tests/m2-student-import-server-resolution.test.ts`
- `docs/streams/client/M2-15-CONTRACTS.md`

No api-http/backend/router/schema/migration/auth/shared/package/config changes.

## Required behavior

Only the current confirmed M2-14 result may seed existing-match review. A matched
row receives a local state `server-match-pending` until the user explicitly keeps
or excludes it. Clear rows remain as their existing included decision. No automatic
exclusion, merge, overwrite, identity link or import. Keep/exclude actions operate
on physical row number and preserve the exact matched-field subset.

Changing any CSV decision, file, principal/session, reset/close/dispose, retrying
or starting a new reconciliation retires every old server-match review/result.
Late success/error cannot restore it. A current confirmed response replaces the
whole prior server-match set atomically. Review decisions across pages use bounded
maps indexed by row number; no all-pairs scan or all-row DOM.

The explicit local JSON report remains bounded/versioned/deterministic and contains
only non-included rows. For an exclusion made from a confirmed server match, add a
documented local reason and exact `matched_fields` names from the current response.
Never include an existing stored value, ID, name or count. Formula-looking input
remains inert JSON text. Preserve one object URL/link per click and every accepted
cleanup/size/privacy rule. If a new reconciliation invalidates the previous result,
no stale matched_fields may appear in a later report.

UI clearly separates local within-file conflicts from server existing-value
warnings, shows counts for server-match pending/kept/excluded, and keeps the
read-only/no-import/no-access wording. Controls are explicit non-submit buttons;
close/reset remain available. No automatic request or download.

## Tests and done

Drive real production models/component callbacks: multi-field matches, matches
across pages, keep/exclude/undo/reset, local conflict interaction, new reconciliation
replacement, malformed/failure preservation, reversed completions, file/principal/
session/close/dispose retirement, report exact rows/reasons/field order/escaping,
stale-result exclusion, URL allocation/click/failure/revoke, resource bounds and
zero storage/automatic network. Run updated suites plus unchanged accepted CSV
preview and scoped TypeScript; disclose the known outside diagnostics.

Done is explicit local review/report integration only. No import commit, overwrite,
account, OTP, enrollment, XLSX, backend change or whole C12/M2 claim. Stop all
edits/checks before MCP report and concise worker Markdown; no self-acceptance or
next task.
