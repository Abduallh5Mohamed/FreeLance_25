# J02/J03 — student catalog homework UI (BUILD-28)

Local conditional implementation. Real schema, storage/scanner, browser/device
and load acceptance remain open. Backend contract:
[catalog homework submissions](../server/J03-CATALOG-HOMEWORK-SUBMISSIONS.md).

## Actual mounted flow

Authorized homework detail in `StudentLessonActivities` now mounts the keyed
`StudentCatalogHomework` panel. Homework metadata uses `submission_required`;
quiz keeps `attempt_required`. These are fresh-proof candidates, not readiness
or submission grants. Old `unconfigured` responses stay readable without a
launch panel; assigning one kind the other's candidate fails DTO parsing.

Mount reads current policy, own history, and the stored request's receipt when
present. It never creates, signs, transfers, verifies or cancels automatically.
The panel shows file types/size limit, the server deadline in device timezone,
current versions and distinct pending-upload, pending-scan, clean, quarantined
and revoked labels. It never marks lesson completion or assigns a grade.

The student explicitly chooses a file, prepares a keyed submission, transfers
that file, then asks the API to verify/scan. Authorization refresh and pending
version cancellation are separate actions. Cancellation requires a checked
confirmation. New-version preparation re-reads original server policy before
clearing the old request pointer; it cannot reset assignment/enrollment limits.
History selection never moves legacy/unbound submissions into catalog.

The initial create response's file identity is derived only from its frozen
metadata payload; recovered identity comes from the private server receipt.
No filename/size/type assertion is a clean verdict. Client extension, name,
minimum 1024 bytes and assignment maximum are checked before creation/transfer;
the original server engine still verifies actual type/signature/size/ETag.
Matching a reselected file proves metadata compatibility, not identical bytes.

## Private state and safe transfer

Only an opaque UUID request key is persisted in sessionStorage. Its slot is
scoped by user, selected tenant/enrollment and catalog target. Local selectors
locate recovery state, never grant server authority. An unavailable/malformed
key store prevents creating a request; identity is saved before POST.
No file bytes/name/type, private URL, signed fields, credentials or response
payload are persisted by this flow. File and upload authorization stay in memory.
File memory is released after confirmed verification/recovery of a verified
version, cancellation, selection change, session retirement or disposal.

API transport uses authenticated no-store catalog paths and sends exactly the
file metadata plus UUID header on create; other actions carry empty bodies. It
never redirects to generic assignment paths or sends client source IDs.

Storage transfer uses a separate fetch: no API bearer or cookies, no redirects,
no referrer, and no response-body logging. Strict signed authorization supports
PUT or signed multipart POST, with only declared Content-Type headers for PUT,
bounded signed fields and file appended last for POST. Credentials in URL,
fragments, unsafe schemes, forged extra headers, expired targets and oversized
files fail before transfer. Cross-origin storage requires HTTPS; HTTP is allowed
only for the current application origin. A local cross-origin HTTP MinIO setup
therefore needs approved TLS/proxy configuration before browser acceptance.

A storage 2xx acknowledges transfer only. It does not finalize the submission
or prove clean scanning. Verification 202 stays pending_scan; quarantined 422
is a confirmed quarantine state, not a successful clean upload or an unknown
write. The existing default backend lacks declared ETag/durable cleanup ports,
so this new upload journey remains unavailable despite the mounted UI.

## Uncertainty and lifecycle

Writes/transfers are single flight, with fixed payload/file selection while in
flight. Unknown acknowledgement, malformed response, transport failure or timeout
stops further writes and clears authorization. Explicit recovery performs reads
only and never replays a PUT, POST, finalize or cancel. If the stored request is
not visible, the UI says that absence is not rollback; an explicit same-key
create retry is available only after that inspection, with same frozen metadata
when still in memory. After reload the student reselects the file; backend key
uniqueness/context/file conflict remains authoritative.

A pending row after unknown transfer offers explicit verification of the object
already at storage before deliberate re-upload. Re-upload overwrites a pending
version and is labelled accordingly. There is no durable offline file queue,
resume-bytes promise or automatic transfer resumption. Already issued URLs retain
their original TTL; API withdrawal does not recall storage capabilities.

Controller generations fence principal, auth incarnation, silent workspace/ABA
changes, scope events, cross-tab storage and disposal. Retiring clears private
state and aborts requests; abort is not rollback evidence. API/read/authorization
operations are bounded to 20 seconds, transfer to 120 seconds and finalize to
150 seconds (allowing the engine's bounded scanner). Late ignored-abort replies
cannot restore state or advance the next operation. No background polling is
introduced. Beforeunload warns for an in-memory file or busy/uncertain operation;
it is not a complete SPA navigation blocker. Closing detail drops memory and
reopening reads server state plus the opaque request pointer.

## Evidence and next work

24 new parser/controller/transport/actual-TSX tests plus 13 activity tests pass.
Tests execute actual picker/create callbacks and effects with synthetic fetch,
hook fixtures and SSR. Storage transfer tests inspect real fetch options and
FormData without a provider. These do not prove browser CORS/device behavior,
real storage/scanner/SQL locking, or upload performance under load.

No migration application, provider activation, deployment, packages or live data.
Next local lesson-package work: lesson announcement/context and audience preview
before publish; read existing announcement/notification contracts first. Real
delivery remains separately authorized. Other J00–J10 journeys stay open.
