# Human starts M2-B02 with OpenCode

2026-10-19 Africa/Cairo. After123 presented M2-B02 name-only transactional audit
proposal and owner-only policy, human directly requests OpenCode start working:
"طيب هيفضل فاضي كدا يعني ؟ انا عايز اوبن كود يبدا يشتغل".
Treat this as execution direction for the just-presented bounded proposal, not
as permission to invent further M2 features. Codex stated this interpretation in
conversation before dispatch: institution owner-only name update with atomic audit.

Task client-m2-b02-institution-name-20261019-01. Exactly three allowedPaths:
- server/src/routes/tenant-self.ts
- server/tests/m2-tenant-profile-update.test.ts
- docs/streams/server/M2-B02-CONTRACT.md

Proposed PATCH profile/name validation/owner-only write in M2-B02-PROPOSAL now
govern this slice. Verified current institution owner required; instructor/role
label alone is insufficient. No status/subject/branch/access/financial policy edit.
Existing selected profile DTO/read and accepted101/121 behavior preserved. Update
and audit commit together; rollback/release on failure, no false success. Resolve
same-name retry/no-op truthfully; no schema/shared helper/DB/service/provider edit.
Exact code paths above narrowly supersede old blanket backend prohibition only
for this task and necessary same-scope corrections after stopped submissions.

OpenCode claims/implements natively through MCP. Codex creates the approved task,
captures baseline hashes and triggers existing worker scheduler immediately; Codex
does not claim or edit worker source. Independently review real stable source,
architecture/contracts/isolated tests/types; precise corrective tasks if necessary
without repeating same-scope approval. No live/network/DB/browser/service/install/
Git/deploy, no credentials/private claim inspection. Positive import isolation.
No whole M2 completion claim; OTP deferred. Both15minute schedules continue.
