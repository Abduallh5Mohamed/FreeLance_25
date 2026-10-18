# Security audit: server/src (read-only, 2026-10-16)

Scope: tenant isolation, IDOR, authz bypass, injection, path traversal, JWT/session, secrets. Static review only; no DB or network. All paths are relative to `server/src/`. Every finding below was confirmed by reading the cited code. Items I could not confirm are in the last section and are not counted.

Root cause behind most High findings: the schema has `tenant_id` only on `courses`, `students`, `videos`, `expenses`, `imports` and the newer finance tables. `groups`, `grades`, `lectures`, `exams`, `attendance`, `course_materials`, `online_meetings`, `subscription_plans` and `staff` have no tenant column. Isolation for them depends on `instructor_id` and on `instructorScopeId(req)` (middleware/auth.ts:280). That helper returns a scope only for `role === 'instructor'`. For every other role (`student`, `teacher`, `staff`, `admin`, `parent`) it returns `null`, and the routes then run the query unscoped.

## Critical / High

### S1. Unauthenticated read of any student's admin notes (CRITICAL)
- File: `routes/students.ts:368` (`router.get('/:id/notes')`), router-level `optionalAuth` at line 10.
- The handler has no `authenticateToken`. With no token, `scopeId` is `null`, the scope check is skipped, and `SELECT id, notes FROM students WHERE id = ?` runs. This also lets any logged-in student read any other student's notes, in any tenant.
- Fix: add `authenticateToken` to the route. Derive the allowed set from `req.user.tenantId`, not from `scopeId`: `... WHERE s.id=? AND s.tenant_id=?`. Deny the `student` role.

### S2. Any authenticated user can read any video row, including the HLS encryption key (HIGH)
- File: `routes/videos.ts:2379-2389` (`PUT /:videoId`).
- The `UPDATE ... AND uploaded_by=?` only guards the write. The handler then returns `SELECT * FROM videos WHERE id = ?` with no ownership or tenant check, even when the UPDATE touched 0 rows. `videos` carries `encryption_key`, `is_encrypted`, `hls_key`, `original_key` and `drm_asset_id` (read at routes/secure-video.ts:732). A student can send `PUT /api/videos/<id>` with `{title:"x"}` and receive the AES key, which defeats the session-bound `/secure-video/key` flow.
- Also: `title` undefined raises a mysql2 bind error (500).
- Fix: check `affectedRows` and return 404 when 0. Return only safe columns (no `encryption_key`, `*_key`, `drm_*`). Add `AND tenant_id=?` using `req.user.tenantId`. Validate `title`.

### S3. `/api/students` list and by-id leak all tenants' students to non-instructor roles (HIGH)
- Files: `routes/students.ts:32-36` (`canReadStudent` returns true for `admin`, `teacher`, `staff`), `:62-90` (list; the only gate is `role==='student'`, and `scopeId` is applied only for instructors), `:114`, `:148`, `:182`, `:217` (by id, email, phone, barcode).
- Result: any `staff`, `teacher`, `admin` or `parent` token gets every student of every tenant (phone, guardian phone, barcode, notes) via `SELECT s.*`.
- `s.*` also includes the legacy `students.password_hash` column (baseline schema). This is returned to instructors too.
- Fix: scope by `s.tenant_id = req.user.tenantId` for every role. Allow cross-tenant reads only through a verified platform capability (the pattern used in `routes/premium-lectures.ts`, `hasPlatformCapability`). Replace `s.*` with an explicit column list that omits `password_hash`.

### S4. Anonymous and cross-tenant listing of all published lectures (HIGH)
- File: `routes/lectures.ts:63` (list) and `:231` (by id). The router uses `optionalAuth` and these handlers never require login.
- With no token, or with a student or other non-instructor token, `scopeId` is `null` and all published lectures of all tenants are returned. By id returns `l.*` (including `instructor_id` and the `video://<id>` source) for any published lecture.
- Fix: add `authenticateToken`. Scope with `INNER JOIN courses c ON c.id=l.course_id AND c.tenant_id=?` using `req.user.tenantId`. For students, additionally use the enrolled group/grade from the principal.

### S5. Groups: unscoped reads, and cross-tenant writes by non-instructor teaching roles (HIGH)
- File: `routes/groups.ts:30-50` (list), `:52-71` (by id), `:146` (PUT), `:234` (DELETE). `canManageGroup` (line 12) returns `true` when `scopeId` is `null`.
- Reads: any student, staff, teacher or admin sees all active groups of all tenants (names, `instructor_id`, schedules).
- Writes: a `teacher`-role user who passes `requireTeachingWrite` for their own tenant (membership `owner` or `instructor`) has `scopeId = null`, so the ownership check is skipped. They can PUT or DELETE (hard delete) any group in any tenant by id.
- POST (lines 75-110): `course_id` is validated with `SELECT id FROM courses WHERE id=?` (lines 94 and 165, no tenant filter). `grade_id` is not validated. Groups created by non-instructor roles get `instructor_id = NULL`, so they are visible to everyone.
- Fix: use `req.user.tenantId` and the owning tenant (via `tenants.owner_user_id = groups.instructor_id`, or add `groups.tenant_id`). Always enforce it, independent of role. Validate `course_id` with `AND tenant_id=?`.

### S6. Global `grades` catalog is mutable by any tenant (HIGH)
- File: `routes/grades.ts:177` (PUT) and `:229` (DELETE, soft delete). They are guarded only by `requireTeachingWrite('groups')`. The router's own header comment says the table "carries no tenant column".
- Any instructor can rename or deactivate a grade used by every other tenant (students, groups, exams and lectures reference `grade_id`).
- Fix: make grades read-only for tenants (platform admin with a verified capability only), or add `tenant_id` to `grades` with per-tenant rows and scope all queries.

### S7. Grade-wide meetings leak across tenants (HIGH)
- File: `routes/meetings.ts:236` (`AND (m.group_id = ? OR (m.group_id IS NULL AND m.grade_id = ?))`); the single-meeting check is `isMeetingForStudentWorkspace` (meetings.ts:163).
- A meeting created by an instructor with `group_id = NULL` and `grade_id = X` is returned to every student whose grade is X, in any tenant. Grades are global (S6) and the query has no `created_by` or tenant filter. The response includes `meeting_link` and `meeting_password`.
- Fix: add `AND m.created_by = ?` (the enrollment's `instructorId` from the principal) to the query and to `isMeetingForStudentWorkspace`.

### S8. Deleting one tenant's enrollment destroys the global student identity (HIGH)
- File: `routes/auth.ts:425-500` (`DELETE /auth/users/student/:studentId`, roles `admin`/`teacher`). Lines 459-470 run `DELETE FROM users WHERE phone IN (...) AND role="student"` and, as fallback, by email.
- Student identity is global by design (migration 20260925_01: "Student identity is global; rows in students are tenant-scoped enrollments"). A teacher in tenant A removing their enrollment deletes the `users` row the student uses in tenants B, C and so on. The email fallback can match a different student user.
- The `req.user.role !== 'admin'` bypass also gives any `admin`-claim token cross-tenant reach (see S10).
- Dead code: the duplicated "by email" block at lines 466-475.
- Fix: delete only the `students` enrollment row (and its `student_courses`). Delete the `users` row only if no other `students.user_id` references it, and prefer deactivation over delete. Remove the email fallback.

### S9. Global student-subscription plan catalog writable by any teacher or admin token (HIGH)
- File: `routes/subscription-plans.ts:94,139,201` with `authorize: requireRoles('admin','teacher')` (line 226). The table has no tenant column and no migration.
- Any tenant's teacher, or any `admin`-claim token, can create, reprice or deactivate the shared plans.
- Fix: restrict writes to `requireAdminPermission('subscription.create')` (platform capability), or add `tenant_id` and scope.

### S10. JWT `role` claim is trusted without re-checking the DB, and it gates cross-tenant bypasses (HIGH)
- Files: `middleware/auth.ts:123-139` and `security/principal-repository.ts:62-70`. The liveness query selects only `is_active, token_version, suspension` and never `users.role`. `resolvePrincipal` uses `claims.role` as-is.
- Impact: a demoted admin or teacher keeps the old role for up to 7 days (`MAX_JWT_LIFETIME_SECONDS`, routes/auth.ts:35) unless `token_version` is bumped. The "role === 'admin'" bypass exists in `routes/exams.ts:165`, `routes/exam-results.ts:50`, `routes/manual-grading.ts:33`, `routes/auth.ts:448`, `routes/courses.ts:120`, `routes/registration-requests.ts:16`, `routes/student-enrollment.ts:374,385`. These treat any `admin` as cross-tenant. `routes/staff.ts` says tenant admins hold no platform assignment, so the claim alone is not platform authority.
- Fix: select `role` in `findUsersIdentity` and reject on mismatch. Replace the `role === 'admin'` checks with `requireAdminPermission(...)` or `hasPlatformCapability`, as `routes/meetings.ts` and `routes/premium-lectures.ts` already do. Bump `token_version` on role, password or membership change.

## Medium

### S11. Student lecture feed resolves the student by phone, not the selected enrollment
- File: `routes/lectures.ts:151-165`. It looks up `users.phone` and then `students WHERE phone=? AND is_active` (no `tenant_id`, no `LIMIT`, unordered). A student enrolled in two tenants (or two rows with the same phone) gets an arbitrary enrollment's `instructor_id`, group and grade.
- Fix: use `req.user.studentEnrollmentId`, `groupId`, `gradeId` and `instructorId` from the principal. Never match on phone.

### S12. Lecture create can set an arbitrary `instructor_id` for non-instructor teaching roles
- File: `routes/lectures.ts:297` (`const ownerId = scopeId || instructor_id || null`). A `teacher`-role user takes `instructor_id` from the body. `grade_id`, `group_id` and `video_url` ownership are not validated for anyone: `video://<id>` is not checked against the caller's tenant or `uploaded_by`.
- PUT and DELETE (`:410`, `:486`) skip the ownership check when `scopeId` is null, so a teacher can edit or unpublish any tenant's lecture.
- Fix: `ownerId = req.user.id` always. Verify `videos.id` belongs to `req.user.tenantId`. Verify `grade_id` and `group_id`. Apply the tenant/owner check regardless of role.

### S13. Cross-tenant user enumeration by phone
- File: `routes/auth.ts:507`. `requireRoles('admin','teacher','staff')` returns `id, phone, name, role, is_active` for any active user in the platform (including instructors and admins). It is rate-limited at 60/min per IP only.
- Fix: restrict to platform admins, or return only students with an enrollment in `req.user.tenantId`.

### S14. CORS and socket origin check is a substring match
- Files: `index.ts:86` and `services/socket.ts:152`. `origin.includes('localhost')` accepts `https://localhost.evil.com` and `https://evil-localhost.net`, with `credentials: true`.
- Fix: parse with `new URL(origin)` and compare `hostname` to `localhost` or `127.0.0.1` exactly, and enable that only when `NODE_ENV !== 'production'`.

### S15. Error handler returns raw exception messages
- File: `index.ts:167` (`message: err.message`). This can leak SQL errors, file paths and library details.
- Fix: return `Internal server error` only, plus a request id; log the message server-side.

### S16. `X-Forwarded-For` trusted unconditionally for video session binding
- File: `middleware/auth.ts:402-405` (`getClientIp`). The video session token IP hash and the violation logs use it. A client can set a header so the IP binding follows it.
- Separately, `middleware/rate-limit.ts:28-37` correctly ignores XFF unless `TRUSTED_PROXIES` is set. Without it, behind nginx every client shares one bucket (login limit 12 per 15 min applies to all users at once, a DoS), and no `trust proxy` is configured in `index.ts`.
- Fix: use `resolveClientAddress` from rate-limit.ts everywhere, and set `app.set('trust proxy', <n>)`.

### S17. Staff session cannot be revoked
- Files: `routes/staff.ts:389-398` and `routes/auth.ts:259` (staff JWT has no `tv`). `findStaffIdentity` checks only `is_active` (principal-repository.ts:70). A staff password change does not invalidate existing tokens (valid up to 7 days). `staff.ts:388` uses `JWT_EXPIRES_IN || '7d'` without the 7-day cap that `auth.ts` applies.
- Fix: add `token_version` to `staff`, include it in the token and check it. Reuse `resolveJwtLifetimeSeconds` in staff.ts.

### S18. Upload filters trust client MIME type
- Files: `routes/exams.ts:52-72` computes `extname` but accepts any `image/*` MIME; the stored filename keeps the original extension (`question-…<ext>`), so `x.html` with `Content-Type: image/png` is accepted. `routes/premium-lectures.ts:29` and `routes/messages.ts:86` require both extension and MIME, but the MIME is client-controlled and no magic-byte check is done.
- Mitigation present: files are served only through `routes/files.ts` (realpath containment, forced attachment for active types, `nosniff`), and `files.ts` has no traversal gap.
- Fix: require both extension and MIME, and sniff magic bytes (as `routes/tenant-self.ts:186` does with `detected.contentType`). Force the stored extension from the detected type.

### S19. Staff is global, never tenant-scoped; staff creation returns a wrong id
- File: `routes/staff.ts:183-186`. `staff.id` is `CHAR(36) DEFAULT (UUID())`, so `result.insertId` is `0` and the API returns `id: "0"`. The table has no `tenant_id`, no membership (memberships FK to `users`), so staff always fail `requireTeachingWrite`, but `canReadStudent` and other `role==='staff'` checks (S3) still give them cross-tenant read.
- Fix: generate the UUID in code and insert it. Decide the tenant model for staff (add `tenant_id` and enforce it in every `staff` check).

### S20. Meeting update binds `undefined`
- File: `routes/meetings.ts:452-467`. `title, description, meeting_link, ... is_active` can be `undefined` when omitted. mysql2 `execute` throws on `undefined` binds, so a partial PUT returns 500. Also `meeting_password = ?` and `group_id = ?` are set unconditionally, so omitted values wipe the stored ones (when null is passed).
- Fix: map `undefined` to `null` and use `COALESCE` for password and group_id, or build the SET list from provided fields.

## Low

- L1. `routes/videos.ts:2339` (DELETE) and `:2379` (PUT) authorize by `uploaded_by` only; a user removed from the tenant can still delete or edit their old videos. Add `tenant_id` and a live membership check.
- L2. `routes/videos.ts:2497` `GET /placeholder-thumbnail` is declared after `GET /:videoId` (line 2299, requires auth) so it is unreachable; move it above.
- L3. `services/socket.ts:33` `verifySocketPrincipal` is exported, unused, and calls `jwt.verify` without `algorithms`. Delete it or pass `{ algorithms: ['HS256'] }`.
- L4. `routes/secure-video.ts:748` hard-codes the fallback origin `https://elka2d.cloud`, as does `services/socket.ts:145-146`; remove the production domain from source and read it from env only.
- L5. `routes/secure-video.ts:606,666,700` media session token and sid travel in the query string (URLs end up in nginx logs and Referer). Prefer a header or a short-lived cookie.
- L6. `db.ts:19` falls back to user `root` and `MYSQL_ROOT_PASSWORD`/empty password. Fail startup in production if `DB_USER`/`DB_PASSWORD` are unset.
- L7. `videos.encryption_key` is stored in plain hex in the DB. Encrypt at rest with an app-level KEK.
- L8. `routes/courses.ts` public discovery returns `tenant_id IS NULL` rows. Migration 20260927 sets `courses.tenant_id` FK `ON DELETE SET NULL`, so deleting a tenant would turn its courses public. Use `RESTRICT`.
- L9. `index.ts:307` shells out to `fuser -k` on EADDRINUSE. Remove; a hung dev port should not kill processes from app code.
- L10. `index.ts:92-93` JSON/urlencoded body limit is 50mb for every route. Lower the default and raise it only on upload routes.

## Verified OK (no finding)
- JWT verification pins HS256 (`middleware/auth.ts:57`); secret from env, no hard-coded secrets found in `server/src` (regex scan for key/secret/password literals and `AKIA`/`sk_live` returned nothing).
- No SQL string interpolation of request input found (only numeric `LIMIT` from validated ints in `routes/notifications.ts`); all other queries are parameterized.
- Path traversal: `routes/files.ts` (`resolveWithinStorageRoot`) uses realpath containment; `secure-video.ts` media/manifest paths are regex-whitelisted.
- Video delivery re-checks authorization on every manifest, segment, key and heartbeat call.
- Courses, expenses, revenues, imports, fees, payment-requests and subscription-requests are tenant-scoped with `tenant_id = req.user.tenantId`.

## Not verified (not counted above)
- Whether `parent` users exist (`users.role` enum has no `parent`; `supportedRoles` and `socket.ts` list it). If the enum is widened later, S3 applies to parents immediately.
- `attendance.ts`, `exam-results.ts`, `manual-grading.ts`, `messages.ts`, `payment-requests.ts` were only spot-checked for scoping; a deeper pass is advised after S1-S10 are fixed.
