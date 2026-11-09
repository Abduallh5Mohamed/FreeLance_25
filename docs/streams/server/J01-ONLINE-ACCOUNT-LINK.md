# J01 — reviewed online identity linking to an existing unassigned student record

2026-11-08 BUILD-52. Owner explicitly prioritized online linking over postponing it for offline work, then asked to implement. The original M2-16 importer remains row-only. [Evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-52.md).

## Composition and authority

`createStudentAccountLinkRequestRouter` is mounted inside student-enrollment with the canonical authenticateToken, native transaction connection and server OTP key reader. `createStudentAccountLinkOwnerRouter` is mounted under authenticated tenant-self `/catalog`. Neither is an unmounted factory. BUILD-53 applied the link/OTP schema **only to the isolated synthetic demo** after a private snapshot; this is not production schema acceptance. Existing OTP issuance uses delivery:null. Owner explicitly deferred SMS/WhatsApp and linking remains disabled by default; there is no provider activation or verification bypass.

## Deferred enablement and UTC expiry — BUILD-53

`STUDENT_ACCOUNT_LINK_ENABLED` is false when absent; only literal `true` enables the journey gate. It does not configure delivery, establish consent or bypass any original OTP proof. The server-owned flag rejects new request/review/apply and owner operational discovery with409 ACCOUNT_LINK_DEFERRED before opening a connection or consuming proof. Historical GETs and the owning student's withdrawal remain available subject to their original authority/schema. An unknown write must recover with GET; POST replay is also refused while deferred, which does not cancel an earlier operation.

GET `/api/student-enrollment/account-link-capabilities` is a public, no-store, credential-free global feature projection only. GET `/api/tenants/me/catalog/account-link/capabilities` re-proves live owner authority without requiring the new link schema. Both return exactly `{state:'deferred'}` or `{state:'verification_required'}`; the latter is not provider readiness. No client selector changes the flag. UI hides new actions while deferred/unavailable, keeps historical receipt/withdrawal access, and avoids asking an anonymous student to log in for a deferred feature.

Deadline decisions use database `expires_live` projections against UTC_TIMESTAMP. Request deadline is INSERT…SELECT LEAST(invitation expiry, UTC+24h) inside SQL; owner review binds a timezone-independent expires_epoch projection. Do not reinterpret UTC DATETIME as driver-local Date or change the shared pool timezone for this flow. BUILD-53 actual MySQL caught a one-hour live invitation being rejected before this correction.

[BUILD-53 evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-53.md): actual SQL and savepoint rollback tests, plus a bounded second-connection lock timeout, inside an outer ROLLBACK with zero fixture rows retained. Test principals/key/in-memory OTP delivery are injected; route commit releases SAVEPOINT only. These do not prove durable COMMIT recovery, real contact verification or two-commit concurrency. Default feature remains deferred at the owner's request; J04 can proceed independently.

| Method | Path | Exact input / output |
|---|---|---|
| POST | `/api/student-enrollment/join/:token/account-link` | operation_id UUID, otp_challenge_id32hex, confirmed:true; request receipt |
| GET | same path | current account's latest request for this invitation, or null |
| GET | same path `/:operationId` | current account's historical request, or null |
| POST | same path `/:operationId/withdraw` | confirmed:true; withdrawal receipt; linked requests cannot be unlinked |
| GET | `/api/tenants/me/catalog/account-link/requests` | optional UUID cursor; bounded pending request id/name page |
| GET | `/api/tenants/me/catalog/account-link/students` | optional UUID cursor; bounded eligible record id/name page |
| POST | same owner prefix `/review` | student_id/request_id; names, effect identity_only, review_token64hex |
| POST | same owner prefix `/apply` | student_id/request_id/operation_id/review_token/confirmed:true; operation receipt |
| GET | same owner prefix `/operations/:operationId` | historical owner-bound receipt or null |

Student receipt: `{request:{id,state}}`, state pending/linked/withdrawn/expired. Expired is a read projection, not a schema rewrite. Owner receipt: `{operation:{operation_id,request_id,student_id,state:'account_linked'}}`. List: `{items:[{id,name}],next_cursor}`, up to25/fetch26. No user IDs/contacts/proofs/invitation tokens/passwords in these DTOs. Handlers set no-store; canonical auth can reject before handlers.

Student is an existing, live authenticated users identity with current token_version. Identity and current phone come from the database. A consumed enrollment_join OTP challenge must match normalized phone, selected invitation tenant and the existing null identity binding; its single-use submitted_at transition, request and sealed audit are one transaction. Consent expires at the earlier of24h and invitation expiration. A revoked invitation cannot authorize new requests or owner acceptance. Pending consent may be withdrawn by its own user; historical GET never grants access. Request replay is bound to user/invite/body and does not consume OTP again. Valid old consent does not block a new request after its invitation is revoked/expired.

Owner is re-proved from live tenant/users rows on the same connection. Explicit student selection does not supply authority. Eligible record has user/group/branch NULL, active current approved enrollment, no courses, instructor NULL or current owner. Its normalized phone must match the authenticated requester and stored proof HMAC. This contact comparison alone performs no linking. Review digest binds owner/tenant/current request/current record/account data. Fresh apply changes only existing students.user_id/is_offline/instructor_id/updated_at, request state, sealed audit and receipt. It does not create user/student, overwrite contact/grade/status/history, assign group/course, collect money or complete content.

All domain writes/seals/receipts require InnoDB and one connection. Schema checks include receipt/request columns and unique keys, plus the existing students(tenant_id,user_id) unique key. One receipt per request and student, and exact same-operation replay. Unknown COMMIT destroys the connection and returns PERSISTENCE_UNCERTAIN. Absence of schema/key/proof/authority fails closed. Multi-connection SQL, legacy writer concurrency, load and real identity delivery have **not** been accepted.

## Client and boundaries

Real panels in JoinInstructor and InstructorStudents use canonical transport, strict DTOs, explicit confirmation and fresh review. SessionStorage stores only account/kind/action/operation and owner selection IDs, never OTP/contact/review/invitation/auth tokens. One pending intent per role/account/tab; changing invitation or workspace cannot authorize another receipt. Return to original context to reconcile. Unknown writes allow GET only, including after reload. Missing receipt does not mean cancelled. Failed confirmed-marker cleanup keeps the receipt and write lock. Withdrawal GET pending is not success. Read deadlines/session/principal/lifecycle fences discard stale responses. Current-request GET restores visibility after a confirmed marker was removed and a later reload occurs.

Out of scope: first account creation, records already assigned to groups/courses/branches, merging two accounts/enrollments, changing phone, course grants, providers, migrations applied elsewhere, production/mobile/load/human acceptance. Positive Chrome linking/OTP responses in BUILD-52 are explicitly mocked UI transports; only login and unavailable503 use actual runtime. Hermetic Router tests exercise the transaction and original OTP validator; no verified challenges were inserted into the demo to pretend delivery worked.
