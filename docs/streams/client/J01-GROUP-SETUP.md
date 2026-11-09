# J01 — group setup panel

BUILD-50: explicit active offline count; missing account means online only.
Strict parser rejects offline>active or missing_account>active-offline. Import/
account link now targets /instructor-students, where the actual CSV panel and
separate manual offline/online form live. Student roster and staff links are
labelled separately; no financial /imports link is substituted. Text explicitly
separates row import from group/course/account assignment and real OTP gates.
Actual Chrome covers owner review, native CSV reconcile/commit and return/read;
it is not independent-human handover. See [BUILD-50](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-50.md).

BUILD-40 mounts `GroupSetup` inside the existing `/groups` page, before the
group cards. It uses only IDs/names from the current group controller's rows;
no new tenant-wide list, roster load or role inference. No group auto-opens.
Owner explicitly selects a current group and requests the canonical setup URL.
Other group managers can see the explanatory panel but cannot bypass the
server's current owner-only read contract.

The panel shows next action, separate factual counts, current authorized
teacher, concrete sessions or unavailable source, and ordered issues. It offers
the existing group editor callback plus links to students/imports, courses,
separate staff/accounts and attendance. Each destination keeps its own current
permissions and write contract; the links do not create authority or promise
that existing role-management/schedule UI is a completed unified wizard.

The actor must return and explicitly refresh after fixing a source. Review is
not a live subscription; a nonempty old group-card schedule does not turn an
unknown concrete-schedule source into available evidence. No completion badge,
financial estimate, account generation or provider success is inferred.

Strict adapter requires exact DTO keys/target ID, canonical dates, caps of 500
students/20 sessions, coherent counts, unavailable-teacher null name,
unavailable-schedule empty payload, unique session IDs, and exact deterministic
issues/action. Added private fields or fake `ready` states fail parsing.

Controller fences request generation, target, principal lifetime, session/scope
notifications and disposal. Selecting another group or refreshing clears old
evidence first. Deadline is 25 seconds; late replies cannot restore success.
401/403/404 render denied, other failure renders unavailable. Session/storage
change clears the lifetime. If the selected group leaves the current group
list, selection is cleared. No setup DTO is persisted.

A small optional practice guide asks the owner to use a separate authorized
account with synthetic data, find the allowed group/session/attendance path,
and verify denial for another group. Its not-tried/needed-help/completed choice
is **memory-only self-report** and resets on group/read changes. It is not an
audit event, a persisted checklist, independent-user evidence or measured
time-saving claim. It creates no new staff identity or privileges.

Tests exercise the actual panel's hooks/callbacks and canonical HTTP transport,
plus controller privacy and source mount assertions. They are not real-browser,
accessibility, actual DB or independently operated handover acceptance.
See [server contract](../server/J01-GROUP-SETUP.md) and BUILD-40 evidence.
