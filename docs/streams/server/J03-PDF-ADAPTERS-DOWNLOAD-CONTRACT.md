# J03 — private adapters and conditional student PDF download, BUILD-07

Local implementation: 2026-11-05. Continues [ingestion BUILD-06](J03-MATERIAL-PDF-INGESTION-CONTRACT.md)
and [verified binary boundary BUILD-05](J03-PRIVATE-MATERIAL-PDF-CONTRACT.md).
No migration, real store/scanner call, deployment, provider activation or default
runtime binding occurred. Adapters and browser behavior are exercised with
synthetic transports/processes/API responses; production acceptance stays open.

## Explicit storage adapter

`createMinioMaterialFileStore` uses the already-installed MinIO SDK directly,
without importing the eager legacy `minio.ts` environment/client module. Caller
supplies endpoint, credentials, region and dedicated bucket explicitly; no secret
is printed, embedded in a public URL or read at module import. Construction
performs no network operation. No bucket creation/policy/versioning mutation,
signed browser URL, object deletion or background worker is provided.

Each actual adapter operation first requires an absent/empty bucket policy and
enabled versioning. Any nonempty policy (including policies that might be
otherwise restrictive) is refused: this is a dedicated-bucket contract, not a
general policy interpreter. NoSuchBucketPolicy is accepted; unknown/error/
unversioned states fail closed. This is a request-time check, not a permanent
privacy guarantee against privileged out-of-band configuration changes.

Writes use the SDK's `If-None-Match: *` header and a fixed 64 MiB SDK part size,
above this feature's 10 MiB cap, so these writes use its single-PUT path. There
is no unsafe stat-then-unconditional-write fallback. Conditional conflict can
reconcile the existing object only with matching size/type/digest metadata and
an actual version ID. The ingestion service still independently verifies all
read-back bytes; metadata alone never creates a clean scan proof.

Opaque version tokens use `minio-version:<raw version ID>`, preserve whitespace
and reject missing/`null`/oversized IDs. Reads use `getObject(...,{versionId})`
and require the matching returned version header. Keys are restricted to the
catalog-material namespace; payloads are copied and hashed before async I/O.

AsyncLocalStorage binds the operation AbortSignal to **every actual SDK HTTP
request** through a custom transport, with socket timeout and stream teardown.
Transient HTTP responses are converted into transport errors before the SDK's
automatic backoff/logging loop; the domain's durable same-key retry protocol
owns reconciliation. Cancellation cannot prove a remote PUT did not complete,
which is why the reservation precedes it. No mutable-key deletion is attempted.

API evidence is the installed primary SDK code/types under
`server/node_modules/minio/dist/main/internal/{client,helper,type,request}`:
conditional metadata headers, single-PUT path, version options and retry loop.
Wire tests run that real SDK against in-memory HTTP request/response objects;
they do not exercise a real MinIO server or its actual policy/version semantics.

## Explicit scanner adapter

`createClamAvMaterialScanner` requires absolute executable/database/private-temp
paths, a policy ID and an explicit maximum signature-database age. It constructs
no process until `scan()`. It runs a fixed clamscan argument list, shell disabled,
window hidden, bounded stdin PDF bytes, a restricted environment and no inherited
provider credentials. Client values never choose executable/path/arguments.

The scan caps input at 10 MiB, scan expansion at 40M, files at 1000, recursion at
16 and output at 32 KiB. Limit/encryption alerts are enabled; silent skipped-limit
results must not become clean. The configured freshness flag refuses stale
signatures. Clean requires exit 0, fully written stdin, exact supported stdin/
stream OK output and no stderr/signal. Exit 1 is rejected; other/missing/noisy/
failed results are failed scan, preserving pending state in the writer.

Timeout and caller cancellation kill only the owned child, never a shell or
unrelated process. At most two scanner processes are admitted per adapter. A
killed process holds its slot until exit acknowledgment; inability to confirm
exit does not permit unlimited replacement processes. No raw output/signature
is logged or returned. Input/configuration snapshots prevent caller mutation.

Primary references checked 2026-11-05:
[ClamAV scanning documentation](https://docs.clamav.net/manual/Usage/Scanning.html)
and the package's [clamscan manual](https://manpages.debian.org/trixie/clamav/clamscan.1.en.html).
They document stdin scans, signature loading, size/scan controls and exit codes.
The exact flags/output and current binary/signatures/temp-directory privacy
still require real deployment validation; no ClamAV installation or real scan
was performed here. This adapter is not an OS sandbox or a malware-free guarantee.

`createMaterialPdfRuntime` assembles one store/scanner into compatible ingestion
and delivery configurations, deriving the read policy from the scanner. Missing
scanner leaves delivery configuration absent. It does not mount/start providers;
the real default routers still receive no such configuration.

## Metadata availability and authority

The existing student contents DTO keeps its exact five keys. `delivery_status`
is now `unavailable | pdf_available`; the latter is valid only for PDF material.
After all enrollment/course/lesson/group/branch checks, an explicitly configured
delivery reader/policy may run one source-column probe and **one bulk bounded
source query** for visible PDFs (21-row probe, at most 20 references).

The same `materialPdfEvidence` predicate used by binary delivery verifies active
source, exact tenant/course/key/version/hash/scan binding, engine/policy, MIME,
size and database scan instant. Missing schema/evidence, duplicates, overflow,
pending/revoked/mismatched source or missing adapter yields unavailable. Private
keys/hashes/version/source-material IDs never enter the student DTO.

`pdf_available` is an offer to request the protected endpoint, not an access
grant or a live provider-health certificate. Metadata performs no provider I/O.
The actual GET still verifies the full authority/source snapshot twice around
storage I/O and validates exact bytes before response. Revocation/source change
after listing is refused. Binary authorization skips the redundant offer probe,
retaining its prior bounded query shape. Default unconfigured metadata remains
unavailable; video and other kinds cannot be advertised as ready by this slice.

## Browser download

`downloadStudentMaterialPdf` uses the canonical bearer fetch; no token is put in
a URL or navigation. It requires a 200 PDF attachment with a fixed UUID filename
shape and a bounded declared length. Its streamed read independently caps size/
chunks, copies bytes, checks length/PDF prefix, honors cancellation and rechecks
the protected session after each chunk. JSON/error/HTML/partial/oversized or
post-session-change responses do not produce a usable Blob.

The existing student controller adds a single-flight explicit download operation,
with principal/event/disposal fences and a bounded browser transfer deadline.
No automatic download/retry occurs. Locked/denied state clears private rows;
withdrawn/changed source removes the stale offer until refreshed. The existing
manual completion action and separate progress ledgers are unchanged.

The component renders a download button only for `pdf_available`. A transient
object URL and UUID filename are created only after the final client checks.
URLs are revoked shortly afterward and on identity change/disposal. The UI says
that a browser download was requested, not that an OS file save or lesson
completion was proven. Already-downloaded files cannot be retroactively revoked.

## Evidence and outstanding external gates

Local tests cover real SDK wire headers/versioning/private checks/cancellation,
fake owned-process scanner execution/failures, source offers, full existing
authority regressions, bounded binary transport, post-body session change,
single-flight downloads, browser URL cleanup and actual component callbacks.

A local headless browser runs the **real React component/controller/HTTP code**
against intercepted synthetic API responses, at 390/1024 pixels. It verifies no
closed-panel request, exact PDF bytes/filename through an actual browser download,
then denial/title removal on a withdrawn response, with GET only and zero
completion writes. This is not a real authenticated server/database/provider
journey and does not establish production latency or cross-browser support.

Before real activation: verify the target catalog/constraints, dedicated private
versioned store and immutable conditional semantics, actual scanner binary/
signatures/private temp/limits/cancellation, then explicitly bind the runtime.
Schema application, credentials/configuration changes and provider calls remain
separately authorized external actions. Recovery/retention/versioned replacement,
video and remaining strategy journeys are still open.

Exact files/commands/results:
[BUILD-07 implementation record](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-07.md).
