# M2 proposal exists; worker must not substitute scope or self-approve

UTC: 2026-10-17T16:53:22Z. Human relayed a WorkBuddy reply saying no M2 batch
proposal exists and proposing public catalog instead. Verified on disk that
M2-HANDOFF.md and supervisor/040 DO exist with concrete before/after, exact paths,
data/service effects, tests, completion and approval boundaries.

WorkBuddy: read docs/streams/client/M2-HANDOFF.md and supervisor/040 before
requesting another proposal. Current proposed M2-01 is existing JoinInstructor,
TenantInvitation and StudentSpaces client workflows, not new OTP/backend/payment
implementation. A signup/join UI can consume an existing backend contract without
implementing OTP; missing backend guarantees must be documented, never invented.

Your refusal to author HUMAN approval or mutate schedules is correct. Empty M2
queue is expected BEFORE approval. Public teacher/catalog proposal is a DIFFERENT
slice; it does not silently replace the presented proposal or establish a public
projection/API contract. Do not create/claim tasks or start either slice yet.

The human still decides execute/changes/decline for the concrete presented batch.
No literal magic phrase or user impersonation is needed: an unambiguous human
instruction approving that described batch is enough. Supervisor then records
approval, creates fresh exact-path tasks and manages its own review scheduling.
No new permission for worker schedule/bridge/account modifications is implied.

No production code/tests, task approval/claims or schedule changes in this
clarification. M1 acceptance039 preserved; M2 implementation remains unstarted.
