# M2-09 correction: enabled action silently dropped during refresh

Independent review began under `6e47df6c-bf15-4714-a22c-357bc3f76519`;
completed under direct human180 on2026-10-21. Worker067/MCP task reported/stopped,
no active claim or CLI. Native original `ses_ea9f01701ffekPRuBpOqwOVdRo` exited0.
Prior independent248 tests passed; known11 outside frontend diagnostics, zero
scoped. Those historical counts are not fresh correction proof. Public179 probe
rerun2026-10-21:2/3 pass, one real component/controller failure. Not accepted.

File/function: `src/features/catalog/course-units.ts`, runMutation success/finally;
actual controls in `CourseUnitManager.tsx`.
Reproduction: open existing unit page; create a unit; POST resolves confirmed DTO;
automatic first-page GET stays pending. State says mutation idle, form closed and
real row archive button is enabled. Click that actual button callback. Expected
one explicit archive PATCH (or a visibly/accurately disabled control). Actual no
request: the finished create still holds writeGuard until awaited GET completes.
The enabled user action silently disappears. This can last as long as the GET.

Exact targeted fix: stop holding the MUTATION latch across a post-confirmation
READ. Settle/release the successful mutation's OWN ticket before awaiting the
bounded follow-up read; retain owner-ticket safety so old finally cannot release
a NEWER mutation. Preserve real in-flight write exclusion, principal/form/page
generations, epoch fences and one bounded follow-up GET. No automatic retry/write,
no source rewrite. If intentionally blocking writes during a read, controls must
truthfully expose that state; enabled no-op actions are unacceptable.

Regress create AND reorder follow-up read pending, actual enabled row action,
real writes still single-flight, older finally/newer mutation ticket, follow-up
success/error, principal change and confirmed-save truth. Add regressions only
inside existing allowed suite; unchanged public probe:
`C:/Users/BaraaWael/TabwebClientSupervisor/179-m2-09-independent-probes.test.ts`.
It drives real production controller and actual component callback, no copied
render decision/browser/network. Keep response-bound and authorization-loss cases.

Fresh correction `client-m2-09-followup-latch-correction-20261021-01`, OpenCode
only, same six M2-09 paths. Human152/180 necessary correction authority; stopped
predecessor verified. Preserve good code/backend176. Exact public read grant only;
no TEMP/lint/debug/source-disable/bypass. Run new regressions+184 unchanged tests
and frontend types, report known11 outside honestly. Stop ALL edits/checks before
native MCP report and concise worker reply. Codex independently accepts/rejects.
No acknowledgment needed. WorkBuddy new backend batch uses disjoint paths180.
