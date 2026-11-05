# J03 — owner PDF source revocation, BUILD-08

Local contract, 2026-11-05. Extends the [owner PDF ingestion contract](J03-MATERIAL-PDF-INGESTION-CONTRACT.md) and [student delivery contract](J03-PRIVATE-MATERIAL-PDF-CONTRACT.md). It does not activate a provider or apply a migration.

`DELETE /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId/contents/:contentId/file` has no body or query. The authenticated active tenant owner must still own the course, unit, lesson and exact PDF material binding. Billing-only authority and client-supplied identity selectors are refused. The actual source schema must be present. A source must exist; otherwise the response is 404.

The service locks the source row after re-proving ownership and sets `status='revoked'` in the same transaction as a sanitized `course_material_file.revoke` audit. Its `WHERE` clause binds file, tenant, course and material and requires `active`. Audit or update failure rolls back. An uncertain commit returns 503 `PERSISTENCE_UNCERTAIN`, destroys the connection and requires an explicit status read before another action. Repeat DELETE of an already revoked source returns 200 `{file,unchanged:true}` with no audit or update.

The owner response contains only the existing six-key file DTO and `unchanged`; private object key, object version, hash and bytes stay hidden. The source record remains for later operator resolution, and any object already written is retained. No delete, replacement, reactivation or automatic cleanup occurs. Revocation works even when store/scanner adapters are unconfigured because it is a database action.

Student metadata does not offer `pdf_available` for a revoked source. The binary GET rechecks exact source proof and refuses a revoked row before provider read, and repeats its authority proof after any provider read. An already completed browser download cannot be recalled; the UI says the source will be unavailable on subsequent reads. In-flight work can finish only if its final recheck precedes revocation commit; no claim of instantaneous cancellation of bytes already delivered.

The owner panel asks for explicit confirmation before DELETE. An unknown outcome leaves the panel uncertain until a fresh status read; a stale or wrong-file acknowledgement never confirms a withdrawal. Session change fences late replies. The upload flow also checks `active` at each phase, so a scan result arriving after revocation cannot promote the source to clean.
