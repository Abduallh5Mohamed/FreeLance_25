# J03 — owner PDF ingestion and scan writer, BUILD-06

Follow-up BUILD-07: [explicit adapters and student PDF download](J03-PDF-ADAPTERS-DOWNLOAD-CONTRACT.md)
are now implemented locally. Prior missing-adapter/UI notes below preserve this
slice's scope; default real runtime remains unconfigured and schema unapplied.

Local implementation completed 2026-11-05, continuing authorized local strategy
work. Extends the [private PDF boundary](J03-PRIVATE-MATERIAL-PDF-CONTRACT.md).
This adds a conditional producer and owner UI, not an activated real store or
scanner, applied migration, replacement workflow or student download button.

## HTTP and authority

Existing authenticated mount `/api/tenants/me/catalog`:

| Method | Relative path | Contract |
|---|---|---|
| GET | `/courses/:courseId/units/:unitId/lessons/:lessonId/contents/:contentId/file` | Empty query/body; private file status and configured capabilities |
| POST | same | Raw `application/pdf`; UUID `Idempotency-Key`; no query, JSON metadata or caller-selected source fields |

Every transition proves the active user is the current active tenant owner,
then course → tenant, unit → course, lesson → unit, exact content → lesson and
same-course PDF material. POST transitions lock those rows and the material
source, so source mutations and audit share one connection/transaction. Billing
restriction and request selectors are denied before buffering. No caller role
label, material ID alone, client hash/key/version or clean verdict is authority.

Global JSON/urlencoded parsers currently initialize `req.body = {}` even when
they skip PDF streams. The route accepts that empty initialization, consumes the
actual stream only after admission/authority/schema/configuration checks, and
rejects nonempty/preparsed bodies. A real parser-chain regression pins this.

POST limit is 10 MiB and a PDF signature; Content-Length is validated when
present and actual bytes are bounded independently. Chunked requests remain
bounded. Original filenames are not sent/stored. Only the source of an existing
PDF material reference is uploaded; this never creates/publishes/enrolls/grants
access or updates the legacy `file_url`.

## Durable phases and idempotency

`material-file-ingestion.ts` has two active upload admissions per service
instance, acquired before body buffering. External calls use a 30-second
default cancellation deadline; scanner/store adapters must honor AbortSignal.
Database cancellation remains the existing driver policy, and request abort
does not undo a transaction already committed.

1. Preflight: live authority, actual required source columns and configured
   store functions. Refusal consumes no upload body/provider operation.
2. Read/copy bounded PDF bytes; compute SHA-256 server-side.
3. Reserve a server-generated file UUID/private key, expected digest/size,
   actor and request UUID. `upload_status=reserved`, `scan_status=pending`,
   object version empty (explicitly unknown). Reservation plus sanitized audit
   **commits before any object write**.
4. `putOnce` creates an immutable private object or reconciles exactly the same
   key/bytes. It must never overwrite a different object. Read back its exact
   raw version and verify complete byte count/digest/PDF signature. No DB
   transaction is held during body/store/scanner I/O.
5. Re-prove ownership/binding, lock source and atomically record the raw version
   with `upload_status=stored` plus audit. A stored file is still pending scan.
6. If a trusted scanner is configured, scan a copy of the actual read-back
   bytes with bound version/digest. Only matching version/digest proof from
   that server adapter can record clean/rejected, engine/policy and the DB
   scan instant, with audit in a freshly authorized transaction.

Missing, failed, timed-out or mismatched scanner proof stays stored/pending
(202); it never becomes clean. Infection records terminal rejection (422), and
a concurrent later clean result cannot promote a rejected source. No raw
scanner/provider reason is persisted or returned. Object reading and request
buffering cap 16384 chunks as well as byte size, and copy reused chunk memory.

Same request/actor/material/digest/size resumes the committed phase. Confirmed
complete clean repeats return 200 `unchanged: true`, with no provider/audit
write. Different key/actor/payload against an existing source conflicts (409).
Only an initial source is supported; there is no implicit replacement/revision.
Database uniqueness also scopes the request UUID to its tenant. No automatic
request retry or cleanup delete happens.

Audit failure rolls back its transition. Commit acknowledgement loss returns
503 `PERSISTENCE_UNCERTAIN`, destroys the connection and stops later external
work. A committed reservation is a durable recovery root even if object writing
or a subsequent SQL acknowledgement fails. Same-key reconciliation can recover
without orphaning the object or choosing a different key. Reserved/stored
uncertainty is not reported as confirmed write failure or as clean.

This is explicit request-driven recovery, not a background recovery/cleanup
worker. Rejected or abandoned private objects remain tracked; exact-version
deletion, retention policy and operator resolution are separate pending work.
No guaranteed malware-object deletion or storage reclamation is claimed.

## Private response and UI

GET response has exactly `file`, `capabilities: {upload, scan}` and
`retry_request_id`. `file` is null or exactly:

```json
{
  "file_id": "<UUID>", "material_id": "<UUID>", "size_bytes": 123,
  "upload_status": "stored", "scan_status": "pending", "source_status": "active"
}
```

The retry UUID is returned only for an active unfinished request belonging to
the currently verified owner actor; it is not an access credential. It permits
explicit same-file resume after reopening, still subject to server digest and
authority checks. No key/version/hash/provider payload/contact/filename leaks.
Capabilities report configured interfaces, not a live provider certification.

Successful POST is `{file, unchanged}`: 201 initial complete source, 200 resumed
or complete no-op, 202 confirmed stored/pending scan. Rejected proof returns
422; GET reports its actual terminal status. All handler outcomes are no-store.

`OwnerMaterialPdfManager.tsx` is mounted for PDF references inside the owner
lesson content panel. Collapsed rows start no request. The editor/controller
strictly parse responses and material identity, validate Blob size/MIME/prefix
before POST, fence principal/session/target/disposal, cancel retired requests,
and prevent duplicate submissions. Unknown/malformed POST outcomes require
explicit status refresh, retaining the same request key; a fresh empty snapshot
does not invent a new key for an outstanding attempt. Pending source recovery
can recover the request key from its authorized status response after reopen.
The original File stays in memory while pending; it is never stored in browser
storage. An absent scanner prevents redundant reupload of an already stored file.

The UI distinguishes reserved, stored/pending, rejected, revoked and recorded
scan result; it does not claim that ingestion publishes or activates student
delivery. It renders a truthful unconfigured state with no enabled upload form.
Completed sources cannot be overwritten through this interface.

## Schema and current runtime limits

Unapplied additive file `20261105_01_material_file_ingestion.sql` adds nullable
request/actor/upload-phase columns and tenant/request uniqueness to the previous
source table. Existing unclassified rows remain NULL; no fabricated upload
history, ownership, scan result or data backfill. Source/schema/catalog and
constraints require real preflight before separately authorized application.

`TenantSelfDeps.materialFileIngestion` forwards the optional trusted config to
the existing mounted lesson router. The real default composition supplies none.
No real reader/writer/scanner was constructed or called; no migration applied.
Default upload remains unavailable, and student metadata still reports opening
unavailable. Real private/immutable storage/version semantics and scanner
capabilities must be verified before any explicit binding/activation.

Next: verified private store/scanner adapters, lifecycle/cleanup proof and real
schema readiness, then conditional student download readiness/UI. Video and
replacement/versioned-source workflows retain their own gates.

Evidence and exact commands:
[BUILD-06 record](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-05.md).
