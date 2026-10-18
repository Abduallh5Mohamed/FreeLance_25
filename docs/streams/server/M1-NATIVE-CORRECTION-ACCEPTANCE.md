# Native correction verification — 2026-10-17

Human transferred the remaining branch legacy/video correction to Codex.
The predecessor WorkBuddy host PID 41672 was absent and its native trace
ended in error at 20:08:25Z. The supervisor retired its claim before editing.
Existing dirty files and partial corrections were preserved.

## Verified ownership corrections

- Unclassified/NULL/unknown legacy group scope resolves to ambiguous denial.
  Explicit tenant scope remains usable under existing resource authorization;
  quarantine is an administrative workflow, not permission to read contents.
- Every present video parent must resolve. Missing lecture/material/course,
  conflicting provenance or missing context cannot fall back to tenant scope.
  Courses are not assigned a branch by choosing one of their many groups.
- Existing loader/handler correction tests pass. Additional real HTTP evidence
  now exercises both `/api/secure-video/session` and `/refresh-token`:
  positive branch access, forged selector denial, next-request revocation,
  legacy-parent denial even for the owner, dangling lecture with a valid course,
  and legitimate standalone tenant-course issuance and refresh.
- The real schema requires `videos.course_id`; an initial fixture attempting
  NULL correctly failed. The live test uses a dangling optional lecture instead,
  without disabling constraints. Missing-all-context remains covered hermetically.
- Issuing a replacement playback session may retire the previous one under
  existing device limits. The positive control refreshes the newly issued session.

## Additional defect found by live verification

The pending video queue SELECT failed with MySQL 8 prepared statements:
`Incorrect arguments to mysqld_stmt_execute`. mysql2 encodes JavaScript numbers
as DOUBLE; LIMIT requires an integer-compatible parameter. The loader now
validates a positive safe integer and binds its decimal string, retaining the
parameterized SQL and exact tenant equality checks. A real MySQL test executes
the production loader. Invalid values are rejected before any SQL call.
The final API startup no longer reports this queue-load failure.

## Independent validation

- Guarded hermetic suite: **1164/1164**, repository root and server cwd.
- Source typecheck: passed. Strict compilation of the changed live test using
  the project's existing ffprobe declaration: passed.
- Isolated live suites: **3/3 tenant tests + 7/7 branch/queue tests**.
- Tracked-source secret scanner: **944 scanned, 0 findings, 3 allowlisted**.
- `git diff --check`: passed; historical migrations unchanged by this correction.
- Snapshot restore: **97 schema objects** in source and second isolated DB;
  INSERT payload hashes identical; schema equal after normalizing schema
  qualifications, AUTO_INCREMENT counters, and redundant explicit utf8mb4
  charset display alongside the same utf8mb4 collation.

Private evidence under `WorkBuddySupervisorBridge/handoff`:
`m1-final-native-root.log`, `m1-final-native-server.log`,
`m1-final-native-live.log`, and the isolated run's
`native-final-proof-1792269508413/verification-reviewed.json`.
The proof preserves the initial stricter schema comparison and explains the
normalization; it does not suppress data differences. No existing database was
restored over. The runner stopped its own API; evidence volumes remain preserved.

## Acceptance boundary

The reviewed legacy/video corrections and pending queue-read correction pass
the above checks. This accepts these scoped corrections, not a general security
guarantee or the entire M1 milestone. SMS delivery remains explicitly deferred:
OTP has no configured provider and onboarding verification remains fail-closed
503. External credential rotation/history handling is not executed. Frontend
ownership remains with the other developer. No commit, push, merge or deployment.

## Local credential rotation — subsequent human authorization

The human confirmed there is no deployed server: the application is local only.
No normal project `.env` or native API/MinIO listener was present in the checked
local locations/ports. Production rotation was therefore not performed or claimed.
On the owned isolated test stack, JWT signing key and MinIO root password were
replaced with new cryptographically random values in the private env file;
its checksum and the recreated MinIO container ID were updated in run metadata.
Only this owned MinIO container was recreated; buckets/data and unrelated
containers were preserved.

Verified: old MinIO credentials rejected, new credentials accepted, bucket names
unchanged; an old-key synthetic JWT rejected under the new key and a new-key JWT
accepted. The full isolated live suites passed again (3 + 7 tests), required-env
tests passed (4/4), and tracked secret scan remained 944 files / 0 findings.
Stale source log lines displaying fixed example credentials were removed.

This supersedes the earlier local-rotation pending note. Revoked private values
are retained only as private rollback/evidence material, never published. Git
history was not rewritten; no claim is made about third-party clones/caches.
SMS delivery is still explicitly deferred and onboarding verification remains503.
