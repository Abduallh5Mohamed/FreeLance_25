# J01/J04 — center owner and employee screens

BUILD-58, 8 November 2026. Server contract: [independent workforce](../server/J01-CENTER-TEAM.md).

- Owner `/instructor`: CenterOperations mounts after BranchManager. It reviews
  real groups/course/resource branch facts, reuses existing GroupSetup, then
  opens CenterTeamOwner. Settings branch metadata is visibly distinguished from
  resource branch authority. No link suggesting `/staff` grants center authority.
- Team owner explicitly creates independent accounts, selects finite permissions
  and resource branches, edits/suspends/reactivates scope and privately resets
  passwords. Native positive team-account login requires no simulated JWT.
- Staff users with no legacy accessible_pages enter `/center-work`; legacy staff
  page navigation remains. A route guard is navigation only; all authority comes
  from the server. Personal Support links to the work portal.
- Employee explicitly selects their workspace, group and actual scheduled session.
  Displays eligible roster with honest missing attendance; canonical correction
  requires its original reason rule. Assigned internal tasks start/resolve with
  versions. Missing permission never falls back to generic APIs or owner identity.

## Failure behavior

Strict DTO parsing rejects secrets, unexpected fields, duplicate IDs, invalid
dates/cursors and invented permissions. Entire requests (including response body)
have25second deadlines even if the transport ignores cancellation. Session/
principal changes abort and hide private state. Child-selection epochs fence
late reads, including post-write refresh after the scope changed. Employee
display hides on focus/background and after60seconds, requiring fresh selection;
this is a display bound, not a promise of immediate offline revocation.

One opaque UUID intent per actor is verified in sessionStorage before POST.
No passwords/phones/body/tokens in recovery markers. An unknown result locks new
writes and survives reload/unmount. Recovery is explicit GET, never another POST.
An absent receipt retains the lock. Explicit server retirement creates a durable
key fence or returns the committed receipt, rather than clearing a marker based
on elapsed time. Session loss/current access denial retains uncertainty.

A confirmed ACK remains confirmed if list refresh fails; current data is cleared
and failure stated. Receipt cleanup failure retains recovery lock. Owner password
inputs are ephemeral and cleared after confirmed success or session loss; original
credentials are not displayed again by API receipts. No provider activation.

Actual Chrome/native API tests verified account creation, task assignment and
attendance correction after real commit/lost ACK/reload/GET, with one POST each,
plus worker task completion and private-view clearing. Retained screenshots show
synthetic facts only. These do not replace human timing, real mobile devices,
accessibility/load or production acceptance. Student-to-center intake is outside
this approved employee contract; personal platform support remains separate.
