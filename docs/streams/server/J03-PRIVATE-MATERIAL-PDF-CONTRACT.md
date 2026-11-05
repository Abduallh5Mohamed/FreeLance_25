# J03 — verified private material PDF boundary, BUILD-05

Current continuation: [BUILD-07](J03-PDF-ADAPTERS-DOWNLOAD-CONTRACT.md) reuses the
exact source predicate for conditional metadata offers and adds explicit adapter
factories/student download UI. No default real provider wiring or schema
application is implied; earlier absence statements describe historical scope.

2026-11-05 follow-up: the conditional owner ingestion/source/scan writer and UI
are implemented under [BUILD-06](J03-MATERIAL-PDF-INGESTION-CONTRACT.md). Real
adapters remain unconfigured and schema unapplied; earlier no-writer statements
below describe BUILD-05's historical scope, not absence of the new local code.

Local implementation: 2026-11-04, continuing the owner's local step-by-step
authorization. The previous [student visibility contract](J03-STUDENT-LESSON-MATERIALS-CONTRACT.md)
continues to govern metadata. This slice adds a conditional binary read; no
upload/registration/scan writer, provider activation or production readiness.

## Mounted endpoint and default

`GET /api/student-course-access/courses/:courseId/lessons/:lessonId/contents/:contentId/file`
is mounted by the existing `createStudentCourseAccessRouter`. Request body and
query must be empty, UUID paths valid, role exactly student and selected scope
server-derived. Client authority/storage/scan selectors are refused. Range and
If-Range are unsupported (416), preventing partial downloads from skipping full
byte verification. No client storage URL, version or digest is accepted.

The real default export does **not** construct a reader or trust a scan engine.
An authorized visible reference therefore returns 503 `MATERIAL_FILE_UNAVAILABLE`;
foreign/hidden references retain 404 and inaccessible lessons their 409 lock.
The student metadata DTO/UI remains `delivery_status: unavailable`; no clickable
download is advertised before the producer/runtime/readiness contract exists.

## Source evidence and schema

Additive file `20261104_01_course_material_files.sql` is **not applied**. One
current source row per material; material/course/tenant FKs and size check are
declared but require real target catalog/engine/collation verification before
separately authorized application. Presence of this file is not schema proof.

`course_material_files` holds server-owned material/course/tenant identities,
private object key and raw version, digest/size/MIME, active/revoked state, and
scan status plus the exact scanned version/digest/engine/policy/time. Scan
defaults to pending; no default clean verdict or backfill. Version fields are
VARBINARY to avoid PAD SPACE comparisons collapsing opaque versions.

No HTTP registration endpoint was added. A future trusted ingestion/scan writer
must prove ownership/storage bytes and atomically audit its transitions; operators
must not manually label a legacy URL clean to activate this path. Client file
metadata, a filename extension or a generic private bucket are not scan evidence.

At request time all 16 required source columns must exist in the actual catalog.
This is a minimal availability gate, not full FK/index/schema certification.
The explicit source query is scoped through the exact lesson binding and
published PDF material, with material/course/tenant equality and a two-row
probe. Missing/ambiguous source, wrong kind or malformed proof fails closed.

Accepted proof requires:

- active source, clean scan, `application/pdf`, 5..10485760 bytes;
- exact object key `catalog-materials/<tenant>/<course>/<material>/<file>.pdf`,
  with canonical safe identity segments and server-generated UUID file/material;
- raw, untrimmed UTF-8 object version identical to the scanned version. Invalid
  UTF-8 binary versions are unsupported, never normalized to a different version;
- valid SHA-256 identical to the scanned digest, and an actual stored scan
  instant greater than zero and no later than the database epoch;
- exact configured trusted scan engine and policy version.

This reads a trusted server record; it does not implement a malware scanner or
verify that a real scan writer exists in a deployed environment.

## Download lifecycle

`createMaterialFileDeliveryService` receives a connection supplier and optional
trusted reader/scanner-policy configuration. No environment/provider import,
network call or credential read occurs at module load. A real future reader
must read the exact private version and honor AbortSignal, including pending
opens and stream cleanup. No fallback to a mutable URL or another version.

1. Acquire one of two in-process service leases; busy → 503 `MATERIAL_FILE_BUSY`.
2. In a read transaction reuse the exact enrollment/course/release/prerequisite/
   material/group/branch visibility proof from BUILD-04; find this content only.
   Read/validate its schema and source evidence. Roll back and release.
3. Read private bytes through the configured adapter, with a 5-second default
   cancellation deadline and request-abort propagation. Deadline includes waiting
   but cannot cancel a driver SQL call; DB timeout policy remains the existing
   driver's responsibility. Adapter failures are sanitized.
4. Buffer at most 10 MiB before any HTTP file bytes are sent. Bound iterator
   chunks to 16384, reject overrun/short read/error/unsupported chunks, and copy
   chunks so a reused adapter buffer cannot alter previously accepted bytes.
   Verify actual `%PDF-` prefix and complete SHA-256 against the scan proof.
5. In a **fresh** transaction, rerun all access checks and reread the source.
   Refuse revoked/withdrawn/locked/changed references. Changed valid evidence →
   409 `MATERIAL_FILE_CHANGED`. No transaction is held during object reading.
6. Only after the second proof return the bytes as a PDF attachment. Retain the
   lease until HTTP finish/close; release is idempotent. Failed preparations
   release their lease immediately. No automatic retry.

Each positive path uses two full read proofs (20 bounded SQL statements in the
current composition), one object read and no database mutation. Two leases bound
verification/response buffering per service instance; this is not a tenant quota,
distributed concurrency control or live memory/latency benchmark. Buffering
deliberately withholds all bytes until validation and excludes large files/video.

Responses use `Cache-Control: no-store`, `Content-Type: application/pdf`,
`X-Content-Type-Options: nosniff`, CSP sandbox, exact Content-Length and an ASCII
attachment name derived only from the UUID file ID. No original filename,
storage locator, raw version or digest is returned. A read is not a completion
or download-count/legacy-progress write. Authorization is checked before bytes
are handed to HTTP, not continuously after the response has started.

## Evidence and remaining work

Service tests cover positive digest/version proof, missing/untrusted scan,
malformed/foreign keys and scope, size/signature/hash mismatch, provider errors,
empty chunk flood, cancellation/timeouts, exact raw version, reused chunks,
source changes, cleanup failures and response-lease limits. Actual route tests
run the real auth/tenant/student chain and handler over synthetic SQL/storage,
assert attachment bytes/headers and fresh revocation checks, and keep the
unconfigured default refusal pinned. No real scanner/store, applied schema,
socket, production concurrency or browser download was exercised.

Next: trusted owner ingestion and audited scan writer; verify actual private
storage capabilities; explicitly wire proven adapters; then advertise verified
PDF availability and add the authenticated student download UI. Independent
video binding/delivery retains its separate course-authority/provider gate.
All external schema/provider operations remain separately authorized actions.

Exact changed files, commands and results:
[implementation record](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-04.md#build-05--private-pdf-delivery-boundary).
