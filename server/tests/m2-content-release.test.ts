import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { Router } from 'express';
import { createAuthenticateToken } from '../src/middleware/auth';
import {
    createContentAccessRouter,
    audienceMatches,
    contentAccessDenialStatus,
    evaluateContentAccess,
    normalizeContentId,
    validateReleaseConfig,
    type ContentAccessDeps,
    type LessonAccessFacts,
} from '../src/routes/content-access';
import {
    buildLessonReleasePolicy,
    evaluateLessonRelease,
    isValidTimeZone,
    localWallTimeToInstant,
    normalizeReleaseMode,
    parseLocalWallTime,
    tenantLocalNow,
    type LessonReleasePolicy,
    type ReleasePolicyRow,
} from '../src/services/content-release';
import {
    createLessonProgressService,
    isDuplicateEntryError,
    type LessonProgressDb,
} from '../src/services/lesson-progress';
import type { ResourceBranchDeps } from '../src/security/resource-branch';
import { tenantScopeBranchDeps } from './helpers/tenant-scope-branch-deps';
import {
    ExecutedStatement,
    TEST_SECRET,
    makeFakeDataAccess,
    makeRepository,
    tokenFor,
    invokeRoute,
} from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

/* =========================================================================
 * A. content-release pure policy
 * ========================================================================= */

test('release mode: normalizes known modes and rejects unknown/missing values', () => {
    assert.equal(normalizeReleaseMode('immediate'), 'immediate');
    assert.equal(normalizeReleaseMode('scheduled'), 'scheduled');
    assert.equal(normalizeReleaseMode('sequential'), 'sequential');
    assert.equal(normalizeReleaseMode('later'), null);
    assert.equal(normalizeReleaseMode(undefined), null);
});

test('timezone: validates IANA names and rejects junk', () => {
    assert.equal(isValidTimeZone('UTC'), true);
    assert.equal(isValidTimeZone('Asia/Riyadh'), true);
    assert.equal(isValidTimeZone('Not/AZone'), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone('x'.repeat(80)), false);
});

test('wall time: accepts real dates and rejects impossible calendar dates', () => {
    assert.deepEqual(parseLocalWallTime('2026-06-01 09:00:00'), {
        year: 2026, month: 6, day: 1, hour: 9, minute: 0, second: 0,
    });
    assert.deepEqual(parseLocalWallTime('2026-06-01'), {
        year: 2026, month: 6, day: 1, hour: 0, minute: 0, second: 0,
    });
    assert.equal(parseLocalWallTime('2026-02-30 09:00:00'), null);
    assert.equal(parseLocalWallTime('2026-13-01 09:00:00'), null);
    assert.equal(parseLocalWallTime('tomorrow'), null);
    assert.equal(parseLocalWallTime(42), null);
});

test('wall time -> instant: applies tenant zone offset and falls back to UTC for a bad zone', () => {
    const riyadh = localWallTimeToInstant('2026-06-01 09:00:00', 'Asia/Riyadh');
    assert.equal(riyadh?.toISOString(), '2026-06-01T06:00:00.000Z');
    const fallback = localWallTimeToInstant('2026-06-01 09:00:00', 'Not/AZone');
    assert.equal(fallback?.toISOString(), '2026-06-01T09:00:00.000Z');
    assert.equal(localWallTimeToInstant('nope', 'UTC'), null);
});

test('wall time -> instant: a nonexistent spring-forward wall time is denied (roundtrip), not shifted an hour earlier', () => {
    // 2026-03-08 02:30 America/New_York does not exist (clocks jump 02:00 -> 03:00).
    // The defective two-pass resolution silently mapped it to 06:30Z = 01:30 EST.
    const gap = localWallTimeToInstant('2026-03-08 02:30:00', 'America/New_York');
    assert.equal(gap, null);
    // The surrounding valid wall times still convert, keeping the local hour.
    const afterGap = localWallTimeToInstant('2026-03-08 03:30:00', 'America/New_York');
    assert.equal(afterGap?.toISOString(), '2026-03-08T07:30:00.000Z');
    const beforeGap = localWallTimeToInstant('2026-03-08 01:30:00', 'America/New_York');
    assert.equal(beforeGap?.toISOString(), '2026-03-08T06:30:00.000Z');
    // A valid date in a whole-hour offset zone and the UTC fallback are preserved.
    assert.equal(localWallTimeToInstant('2026-03-08 09:00:00', 'Asia/Riyadh')?.toISOString(), '2026-03-08T06:00:00.000Z');
    assert.equal(localWallTimeToInstant('2026-03-08 02:30:00', 'UTC')?.toISOString(), '2026-03-08T02:30:00.000Z');
    // The gap denial also applies to a date-only wall time at midnight.
    assert.equal(localWallTimeToInstant('2026-03-08', 'America/New_York')?.toISOString(), '2026-03-08T05:00:00.000Z');
});

test('wall time -> instant: a fall-back overlap resolves to the first (earlier-offset) instant and roundtrips', () => {
    // 2026-11-01 01:30 America/New_York happens twice; the documented policy is
    // the first (EDT, 05:30Z) instant.
    const overlap = localWallTimeToInstant('2026-11-01 01:30:00', 'America/New_York');
    assert.equal(overlap?.toISOString(), '2026-11-01T05:30:00.000Z');
});

test('tenantLocalNow: maps a UTC instant to the tenant wall clock', () => {
    const wall = tenantLocalNow(new Date('2026-06-01T06:00:00.000Z'), 'Asia/Riyadh');
    assert.deepEqual(wall, { year: 2026, month: 6, day: 1, hour: 9, minute: 0, second: 0 });
});

const policyWith = (overrides: Partial<LessonReleasePolicy>): LessonReleasePolicy => ({
    lectureId: 'lec-1',
    courseId: 'course-a',
    tenantId: 'tenant-a',
    releaseMode: 'immediate',
    releaseAtUtc: null,
    releaseTimeZone: 'UTC',
    prerequisiteLectureId: null,
    releasedAtUtc: null,
    isPublished: true,
    archived: false,
    displayOrder: 1,
    ...overrides,
});

test('release: immediate is always released', () => {
    const d = evaluateLessonRelease(policyWith({}), { now: new Date('2000-01-01T00:00:00Z'), prerequisiteCompleted: false });
    assert.deepEqual(d, { released: true, reason: 'immediate' });
});

test('release: scheduled denies before the server-time instant and releases at/after it', () => {
    const policy = policyWith({ releaseMode: 'scheduled', releaseAtUtc: '2026-06-01T12:00:00.000Z' });
    const early = evaluateLessonRelease(policy, { now: new Date('2026-06-01T11:59:59Z'), prerequisiteCompleted: false });
    assert.deepEqual(early, { released: false, reason: 'not-yet-released' });
    const at = evaluateLessonRelease(policy, { now: new Date('2026-06-01T12:00:00Z'), prerequisiteCompleted: false });
    assert.deepEqual(at, { released: true, reason: 'scheduled' });
});

test('release: a materialized released_at marker releases a scheduled lesson regardless of clock', () => {
    const policy = policyWith({ releaseMode: 'scheduled', releaseAtUtc: '2026-06-01T12:00:00.000Z', releasedAtUtc: '2026-06-01T12:00:05.000Z' });
    const d = evaluateLessonRelease(policy, { now: new Date('2026-06-01T09:00:00Z'), prerequisiteCompleted: false });
    assert.deepEqual(d, { released: true, reason: 'scheduled' });
});

test('release: an unparseable or missing scheduled instant fails closed', () => {
    assert.deepEqual(
        evaluateLessonRelease(policyWith({ releaseMode: 'scheduled', releaseAtUtc: null }), { now: new Date(), prerequisiteCompleted: false }),
        { released: false, reason: 'invalid-schedule' },
    );
    assert.deepEqual(
        evaluateLessonRelease(policyWith({ releaseMode: 'scheduled', releaseAtUtc: 'not-a-date' }), { now: new Date(), prerequisiteCompleted: false }),
        { released: false, reason: 'invalid-schedule' },
    );
});

test('release: sequential requires prerequisite completion when configured', () => {
    const policy = policyWith({ releaseMode: 'sequential', prerequisiteLectureId: 'lec-0' });
    assert.deepEqual(
        evaluateLessonRelease(policy, { now: new Date(), prerequisiteCompleted: false }),
        { released: false, reason: 'prerequisite-required' },
    );
    assert.deepEqual(
        evaluateLessonRelease(policy, { now: new Date(), prerequisiteCompleted: true }),
        { released: true, reason: 'sequential' },
    );
});

test('release: sequential without a configured prerequisite is unlocked', () => {
    const policy = policyWith({ releaseMode: 'sequential', prerequisiteLectureId: null });
    assert.deepEqual(
        evaluateLessonRelease(policy, { now: new Date(), prerequisiteCompleted: false }),
        { released: true, reason: 'sequential' },
    );
});

test('buildLessonReleasePolicy: a missing policy row degrades to immediate', () => {
    const policy = buildLessonReleasePolicy(
        { id: 'lec-1', course_id: 'c', tenant_id: 't', is_published: 1, archived_at: null, display_order: 3 },
        null,
    );
    assert.equal(policy.releaseMode, 'immediate');
    assert.equal(policy.archived, false);
    assert.equal(policy.releaseAtUtc, null);
});

test('buildLessonReleasePolicy: an invalid row mode also degrades to immediate', () => {
    const row: ReleasePolicyRow = {
        lecture_id: 'lec-1', course_id: 'c', tenant_id: 't', release_mode: 'bogus',
        release_at: null, release_timezone: 'UTC', prerequisite_lecture_id: null, released_at: null,
    };
    assert.equal(buildLessonReleasePolicy(
        { id: 'lec-1', course_id: 'c', tenant_id: 't', is_published: 1, archived_at: null, display_order: 3 }, row,
    ).releaseMode, 'immediate');
});

test('buildLessonReleasePolicy: parses scheduled instant and sequential prerequisite from the row', () => {
    const row: ReleasePolicyRow = {
        lecture_id: 'lec-2', course_id: 'c', tenant_id: 't', release_mode: 'sequential',
        release_at: null, release_timezone: 'Asia/Riyadh', prerequisite_lecture_id: 'lec-1', released_at: null,
    };
    const policy = buildLessonReleasePolicy(
        { id: 'lec-2', course_id: 'c', tenant_id: 't', is_published: 1, archived_at: null, display_order: 2 }, row,
    );
    assert.equal(policy.releaseMode, 'sequential');
    assert.equal(policy.prerequisiteLectureId, 'lec-1');
    assert.equal(policy.releaseTimeZone, 'Asia/Riyadh');
});

/* =========================================================================
 * B. lesson-progress service
 * ========================================================================= */

test('progress: recognises a duplicate-key error only for ER_DUP_ENTRY', () => {
    assert.equal(isDuplicateEntryError({ code: 'ER_DUP_ENTRY' }), true);
    assert.equal(isDuplicateEntryError({ code: 'ER_LOCK_DEADLOCK' }), false);
    assert.equal(isDuplicateEntryError(new Error('nope')), false);
    assert.equal(isDuplicateEntryError(null), false);
});

const progressDb = (opts: {
    existing?: { id: string } | null;
    completed?: { lecture_id: string }[];
    insert?: () => { affectedRows?: number; insertId?: number };
}): LessonProgressDb => ({
    query: async <T = unknown>() => (opts.completed ?? []) as T[],
    queryOne: async <T = unknown>() => (opts.existing ?? null) as T | null,
    execute: async () => (opts.insert ? opts.insert() : { affectedRows: 1, insertId: 0 }),
});

test('progress: isCompleted reflects the presence of a completion row', async () => {
    const service = createLessonProgressService(progressDb({ existing: { id: 'c1' } }));
    assert.equal(await service.isCompleted('enr-a', 'lec-1'), true);
    const empty = createLessonProgressService(progressDb({ existing: null }));
    assert.equal(await empty.isCompleted('enr-a', 'lec-1'), false);
});

test('progress: completedLectureIds maps rows to ids', async () => {
    const service = createLessonProgressService(progressDb({ completed: [{ lecture_id: 'lec-1' }, { lecture_id: 'lec-2' }] }));
    assert.deepEqual(await service.completedLectureIds('enr-a', 'course-a'), ['lec-1', 'lec-2']);
});

test('progress: recordCompletion reports created=true on insert and false on duplicate', async () => {
    let calls = 0;
    const service = createLessonProgressService(progressDb({
        insert: () => {
            calls += 1;
            if (calls > 1) { const error = new Error('dup') as Error & { code?: string }; error.code = 'ER_DUP_ENTRY'; throw error; }
            return { affectedRows: 1 };
        },
    }));
    const input = { tenantId: 't', studentEnrollmentId: 'enr-a', courseId: 'c', lectureId: 'l', source: 'student' };
    assert.deepEqual(await service.recordCompletion(input), { created: true });
    assert.deepEqual(await service.recordCompletion(input), { created: false });
});

test('progress: recordCompletion rethrows non-duplicate errors', async () => {
    const service = createLessonProgressService(progressDb({
        insert: () => { throw new Error('db down'); },
    }));
    await assert.rejects(() => service.recordCompletion({
        tenantId: 't', studentEnrollmentId: 'enr-a', courseId: 'c', lectureId: 'l', source: 'student',
    }), /db down/);
});

/* =========================================================================
 * C. composed content policy + validation
 * ========================================================================= */

const factsWith = (overrides: Partial<LessonAccessFacts> = {}): LessonAccessFacts => ({
    isStaff: false,
    lecture: {
        tenantId: 'tenant-a', instructorId: 'instr-a', groupId: null, gradeId: 'grade-a',
        branchId: null, branchAmbiguous: false, isPublished: true, archived: false, displayOrder: 1,
    },
    enrollment: {
        id: 'enr-a', tenantId: 'tenant-a', instructorId: 'instr-a', groupId: null, gradeId: 'grade-a', branchId: null,
    },
    policy: policyWith({}),
    prerequisiteCompleted: false,
    now: new Date('2026-06-01T10:00:00Z'),
    ...overrides,
});

test('access: archived lesson is denied', () => {
    const d = evaluateContentAccess(factsWith({ lecture: { ...factsWith().lecture, archived: true } }));
    assert.deepEqual(d, { allowed: false, code: 'ARCHIVED' });
});

test('access: unpublished lesson is hidden from a student but previewable by staff', () => {
    const unpublished = factsWith({ lecture: { ...factsWith().lecture, isPublished: false } });
    assert.deepEqual(evaluateContentAccess(unpublished), { allowed: false, code: 'NOT_PUBLISHED' });
    assert.deepEqual(evaluateContentAccess({ ...unpublished, isStaff: true }), { allowed: true, reason: 'staff' });
});

test('access: a student without an enrollment is denied', () => {
    assert.deepEqual(evaluateContentAccess(factsWith({ enrollment: null })), { allowed: false, code: 'ENROLLMENT_REQUIRED' });
});

test('access: cross-tenant enrollment is denied', () => {
    const d = evaluateContentAccess(factsWith({ enrollment: { ...factsWith().enrollment!, tenantId: 'tenant-b' } }));
    assert.deepEqual(d, { allowed: false, code: 'TENANT_MISMATCH' });
});

test('access: out-of-audience lesson is denied, general lessons stay open', () => {
    const mismatch = evaluateContentAccess(factsWith({ lecture: { ...factsWith().lecture, gradeId: 'grade-z' } }));
    assert.deepEqual(mismatch, { allowed: false, code: 'AUDIENCE_MISMATCH' });
    const general = evaluateContentAccess(factsWith({ lecture: { ...factsWith().lecture, gradeId: null, groupId: null } }));
    assert.equal(general.allowed, true);
});

test('access: a branch lesson requires the enrollment in that exact branch', () => {
    const same = evaluateContentAccess(factsWith({
        lecture: { ...factsWith().lecture, branchId: 'branch-x' },
        enrollment: { ...factsWith().enrollment!, branchId: 'branch-x' },
    }));
    assert.equal(same.allowed, true);
    const other = evaluateContentAccess(factsWith({
        lecture: { ...factsWith().lecture, branchId: 'branch-x' },
        enrollment: { ...factsWith().enrollment!, branchId: 'branch-y' },
    }));
    assert.deepEqual(other, { allowed: false, code: 'BRANCH_MISMATCH' });
    const ambiguous = evaluateContentAccess(factsWith({ lecture: { ...factsWith().lecture, branchAmbiguous: true } }));
    assert.deepEqual(ambiguous, { allowed: false, code: 'BRANCH_MISMATCH' });
});

test('access: release policy gates a scheduled lesson before its instant', () => {
    const d = evaluateContentAccess(factsWith({ policy: policyWith({ releaseMode: 'scheduled', releaseAtUtc: '2026-06-01T12:00:00.000Z' }) }));
    assert.deepEqual(d, { allowed: false, code: 'NOT_YET_RELEASED' });
});

test('access: sequential policy requires the prerequisite completion', () => {
    const policy = policyWith({ releaseMode: 'sequential', prerequisiteLectureId: 'lec-0' });
    assert.deepEqual(evaluateContentAccess(factsWith({ policy })), { allowed: false, code: 'PREREQUISITE_REQUIRED' });
    assert.deepEqual(evaluateContentAccess(factsWith({ policy, prerequisiteCompleted: true })), { allowed: true, reason: 'sequential' });
});

test('audienceMatches: general open, grade/group exact', () => {
    const lecture = { instructorId: null, groupId: null, gradeId: null };
    assert.equal(audienceMatches(lecture, { instructorId: null, groupId: null, gradeId: 'g1' }), true);
    assert.equal(audienceMatches({ ...lecture, gradeId: 'g1' }, { instructorId: null, groupId: null, gradeId: 'g1' }), true);
    assert.equal(audienceMatches({ ...lecture, gradeId: 'g2' }, { instructorId: null, groupId: null, gradeId: 'g1' }), false);
    assert.equal(audienceMatches({ ...lecture, groupId: 'grp1' }, { instructorId: null, groupId: 'grp1', gradeId: null }), true);
});

test('denial status: release locks are 403, enumeration-safe denials are 404', () => {
    assert.equal(contentAccessDenialStatus('NOT_YET_RELEASED'), 403);
    assert.equal(contentAccessDenialStatus('PREREQUISITE_REQUIRED'), 403);
    assert.equal(contentAccessDenialStatus('TENANT_MISMATCH'), 404);
    assert.equal(contentAccessDenialStatus('NOT_PUBLISHED'), 404);
    assert.equal(contentAccessDenialStatus('AUDIENCE_MISMATCH'), 404);
});

test('normalizeContentId: rejects empty, oversized and malformed ids', () => {
    assert.equal(normalizeContentId('lec-1'), 'lec-1');
    assert.equal(normalizeContentId(''), null);
    assert.equal(normalizeContentId('a b'), null);
    assert.equal(normalizeContentId('x'.repeat(129)), null);
    assert.equal(normalizeContentId(5), null);
});

test('validateReleaseConfig: scheduled converts a tenant-local time into a UTC instant', () => {
    const r = validateReleaseConfig({ release_mode: 'scheduled', release_at: '2026-06-01 09:00:00', release_time_zone: 'Asia/Riyadh' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.releaseAtUtc, '2026-06-01T06:00:00.000Z');
});

test('validateReleaseConfig: rejects an unknown mode, a bad timezone and a bad wall time', () => {
    assert.equal(validateReleaseConfig({ release_mode: 'later' }).ok, false);
    assert.equal(validateReleaseConfig({ release_mode: 'scheduled', release_at: '2026-06-01 09:00:00', release_time_zone: 'Not/AZone' }).ok, false);
    assert.equal(validateReleaseConfig({ release_mode: 'scheduled', release_at: 'nope', release_time_zone: 'UTC' }).ok, false);
});

test('validateReleaseConfig: sequential requires a prerequisite; immediate ignores schedule fields', () => {
    assert.equal(validateReleaseConfig({ release_mode: 'sequential' }).ok, false);
    const ok = validateReleaseConfig({ release_mode: 'sequential', prerequisite_lecture_id: 'lec-0' });
    assert.equal(ok.ok, true);
    const immediate = validateReleaseConfig({ release_mode: 'immediate', release_at: 'garbage' });
    assert.equal(immediate.ok, true);
    if (immediate.ok) assert.equal(immediate.value.releaseAtUtc, null);
});

test('validateReleaseConfig: a scheduled release inside the DST gap is denied before any write', () => {
    const gap = validateReleaseConfig({ release_mode: 'scheduled', release_at: '2026-03-08 02:30:00', release_time_zone: 'America/New_York' });
    assert.equal(gap.ok, false);
    if (!gap.ok) assert.match(gap.error, /release_at/);
});

test('validateReleaseConfig: a valid scheduled release converts to the UTC instant (regression)', () => {
    const ok = validateReleaseConfig({ release_mode: 'scheduled', release_at: '2026-03-08 03:30:00', release_time_zone: 'America/New_York' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.releaseAtUtc, '2026-03-08T07:30:00.000Z');
    // Fall-back overlap keeps the documented first-instant resolution.
    const overlap = validateReleaseConfig({ release_mode: 'scheduled', release_at: '2026-11-01 01:30:00', release_time_zone: 'America/New_York' });
    assert.equal(overlap.ok, true);
    if (overlap.ok) assert.equal(overlap.value.releaseAtUtc, '2026-11-01T05:30:00.000Z');
});

/* =========================================================================
 * D. router integration
 * ========================================================================= */

const NOW = new Date('2026-06-01T10:00:00.000Z');

const ENROLLMENT_A = {
    id: 'enr-a', tenant_id: 'tenant-a', instructor_id: 'instr-a', group_id: null, grade_id: 'grade-a',
    group_branch_id: null, group_branch_scope: null,
};

const LECTURE_PUBLISHED = {
    id: 'lec-1', course_id: 'course-a', instructor_id: 'instr-a', group_id: null, grade_id: 'grade-a',
    title: 'Lesson 1', description: 'd', video_url: 'video://x', duration_minutes: 10, is_free: 1,
    is_published: 1, display_order: 1, archived_at: null, tenant_id: 'tenant-a',
    group_branch_id: null, group_branch_scope: null,
};

const COURSE_SCOPE_A = { id: 'course-a', tenant_id: 'tenant-a', instructor_id: 'instr-a', is_owner: 1 };

interface RouterFixtures {
    enrollment?: Record<string, unknown> | null;
    lecture?: Record<string, unknown> | null;
    policy?: Record<string, unknown> | null;
    policyList?: Record<string, unknown>[];
    completion?: Record<string, unknown> | null;
    completedIds?: string[];
    courseScope?: Record<string, unknown> | null;
    releaseAuthority?: Record<string, unknown> | null;
    prerequisite?: Record<string, unknown> | null;
    courseLessons?: Record<string, unknown>[];
    now?: Date;
    branchAccess?: ResourceBranchDeps;
}

const buildContentRouter = (fixtures: RouterFixtures = {}) => {
    const responder = (sql: string, params: unknown[]): unknown[] | null => {
        void params;
        if (sql.includes('FROM students s') && sql.includes('INNER JOIN tenants t')) {
            return fixtures.enrollment === null ? [] : [fixtures.enrollment ?? ENROLLMENT_A];
        }
        if (sql.includes('FROM lesson_release_policies WHERE lecture_id = ?')) {
            return fixtures.policy ? [fixtures.policy] : [];
        }
        if (sql.includes('FROM lesson_release_policies WHERE course_id = ?')) {
            return fixtures.policyList ?? [];
        }
        if (sql.includes('FROM lesson_completions') && sql.includes('lecture_id = ?')) {
            return fixtures.completion ? [fixtures.completion] : [];
        }
        if (sql.includes('SELECT DISTINCT lecture_id FROM lesson_completions')) {
            return (fixtures.completedIds ?? []).map((lecture_id) => ({ lecture_id }));
        }
        if (sql.includes('FROM courses c WHERE c.id = ?')) {
            return fixtures.courseScope === null ? [] : [fixtures.courseScope ?? COURSE_SCOPE_A];
        }
        if (sql.includes('c.tenant_id, c.instructor_id')) {
            return fixtures.releaseAuthority === null ? [] : [fixtures.releaseAuthority ?? { id: 'lec-1', course_id: 'course-a', tenant_id: 'tenant-a', instructor_id: 'instr-a', is_owner: 1 }];
        }
        if (sql.includes('l.id, l.course_id, c.tenant_id')) {
            return fixtures.prerequisite === null ? [] : [fixtures.prerequisite ?? { id: 'lec-0', course_id: 'course-a', tenant_id: 'tenant-a' }];
        }
        if (sql.includes('WHERE l.course_id = ? AND c.tenant_id = ?')) {
            return fixtures.courseLessons ?? [];
        }
        if (sql.includes('FROM lectures l') && sql.includes('WHERE l.id = ?')) {
            return fixtures.lecture === null ? [] : [fixtures.lecture ?? LECTURE_PUBLISHED];
        }
        return [];
    };

    const db = makeFakeDataAccess(responder);
    const repository = makeRepository(
        {
            'student-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'student' },
            'instr-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        },
        {
            instructorAccounts: { 'instr-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
            memberships: { 'instr-a': [{ tenant_id: 'tenant-a' }] },
            enrollments: { 'student-a': [ENROLLMENT_A] },
        },
    );
    const deps: ContentAccessDeps = {
        db,
        authenticate: createAuthenticateToken(repository),
        branchAccess: fixtures.branchAccess ?? tenantScopeBranchDeps(() => 'tenant-a'),
        now: () => fixtures.now ?? NOW,
        transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db),
    };
    return { router: createContentAccessRouter(deps), executed: db.executed, db };
};

const STUDENT_A = tokenFor({ id: 'student-a', role: 'student', tv: 0, student_enrollment_id: 'enr-a' });
const INSTRUCTOR_A = tokenFor({ id: 'instr-a', role: 'instructor', tv: 0, tenant_id: 'tenant-a' });

const auditFor = (executed: ExecutedStatement[], action: string): ExecutedStatement | undefined =>
    executed.find((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === action);

// ---- GET /lessons/:id -----------------------------------------------------

test('direct: anonymous is 401 before any data access', async () => {
    const { router, executed } = buildContentRouter();
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1' });
    assert.equal(response.statusCode, 401);
    assert.equal(executed.length, 0);
});

test('direct: a malformed id is 404', async () => {
    const { router } = buildContentRouter();
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/bad%20id', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('direct: an enrolled student reads a published immediate lesson', async () => {
    const { router } = buildContentRouter();
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { id?: string }).id, 'lec-1');
    assert.equal((response.body as { video_url?: string }).video_url, 'video://x');
});

test('direct: a student with no enrollment is denied 404', async () => {
    const { router } = buildContentRouter({ enrollment: null });
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('direct: a cross-tenant lecture is 404', async () => {
    const { router } = buildContentRouter({ lecture: { ...LECTURE_PUBLISHED, tenant_id: 'tenant-b' } });
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('direct: an unpublished lesson is hidden from a student', async () => {
    const { router } = buildContentRouter({ lecture: { ...LECTURE_PUBLISHED, is_published: 0 } });
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('direct: a scheduled lesson is 403 before its release instant and 200 after', async () => {
    const policy = { lecture_id: 'lec-1', course_id: 'course-a', tenant_id: 'tenant-a', release_mode: 'scheduled', release_at: '2026-06-01 12:00:00', release_timezone: 'UTC', prerequisite_lecture_id: null, released_at: null };
    const early = buildContentRouter({ policy });
    const earlyRes = await invokeRoute(early.router, { method: 'GET', url: '/lessons/lec-1', token: STUDENT_A });
    assert.equal(earlyRes.statusCode, 403);
    assert.equal((earlyRes.body as { code?: string }).code, 'NOT_YET_RELEASED');

    const later = buildContentRouter({ policy, now: new Date('2026-06-01T12:00:00.000Z') });
    const laterRes = await invokeRoute(later.router, { method: 'GET', url: '/lessons/lec-1', token: STUDENT_A });
    assert.equal(laterRes.statusCode, 200);
});

test('direct: sequential lock denies the direct URL, and completion unlocks it', async () => {
    const policy = { lecture_id: 'lec-2', course_id: 'course-a', tenant_id: 'tenant-a', release_mode: 'sequential', release_at: null, release_timezone: 'UTC', prerequisite_lecture_id: 'lec-1', released_at: null };
    const lecture = { ...LECTURE_PUBLISHED, id: 'lec-2', display_order: 2 };
    const locked = buildContentRouter({ policy, lecture });
    const lockedRes = await invokeRoute(locked.router, { method: 'GET', url: '/lessons/lec-2', token: STUDENT_A });
    assert.equal(lockedRes.statusCode, 403);
    assert.equal((lockedRes.body as { code?: string }).code, 'PREREQUISITE_REQUIRED');

    const unlocked = buildContentRouter({ policy, lecture, completion: { id: 'comp-1' } });
    const unlockedRes = await invokeRoute(unlocked.router, { method: 'GET', url: '/lessons/lec-2', token: STUDENT_A });
    assert.equal(unlockedRes.statusCode, 200);
});

test('direct: a branch lesson outside the enrollment branch is 404', async () => {
    const { router } = buildContentRouter({
        lecture: { ...LECTURE_PUBLISHED, group_branch_id: 'branch-x', group_branch_scope: 'branch' },
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('direct: an instructor previews an unpublished lesson in their tenant', async () => {
    const { router } = buildContentRouter({ lecture: { ...LECTURE_PUBLISHED, is_published: 0 } });
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
});

test('direct: an instructor cannot read another tenant lesson (404)', async () => {
    const { router } = buildContentRouter({ lecture: { ...LECTURE_PUBLISHED, tenant_id: 'tenant-b' } });
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
});

test('direct: a resource-derived branch denial blocks a staff read', async () => {
    const denying: ResourceBranchDeps = {
        loadResourceScope: async () => null,
        findBranch: async () => null,
        findMembership: async () => null,
        isTenantOwner: async () => false,
        hasPlatformCapability: async () => false,
    };
    const { router } = buildContentRouter({ branchAccess: denying });
    const response = await invokeRoute(router, { method: 'GET', url: '/lessons/lec-1', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 404);
});

// ---- GET /courses/:courseId/lessons --------------------------------------

test('list: anonymous is 401', async () => {
    const { router } = buildContentRouter();
    const response = await invokeRoute(router, { method: 'GET', url: '/courses/course-a/lessons' });
    assert.equal(response.statusCode, 401);
});

test('list: a student sees accessible lessons, locked release lessons, and nothing out of audience', async () => {
    const scheduledPolicy = { lecture_id: 'lec-sched', course_id: 'course-a', release_mode: 'scheduled', release_at: '2026-06-01 12:00:00', release_timezone: 'UTC', prerequisite_lecture_id: null, released_at: null };
    const { router } = buildContentRouter({
        courseLessons: [
            LECTURE_PUBLISHED,
            { ...LECTURE_PUBLISHED, id: 'lec-sched', display_order: 2 },
            { ...LECTURE_PUBLISHED, id: 'lec-other-grade', grade_id: 'grade-z', display_order: 3 },
        ],
        policyList: [scheduledPolicy],
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses/course-a/lessons', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    const body = response.body as Array<{ id: string; locked: boolean }>;
    assert.equal(body.length, 2, 'out-of-audience lesson omitted');
    assert.equal(body.find((l) => l.id === 'lec-1')?.locked, false);
    assert.equal(body.find((l) => l.id === 'lec-sched')?.locked, true);
    assert.equal(body.some((l) => l.id === 'lec-other-grade'), false);
});

test('list: a nonexistent course is 404 for a student', async () => {
    const { router } = buildContentRouter({ courseScope: null });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses/course-a/lessons', token: STUDENT_A });
    assert.equal(response.statusCode, 404);
});

test('list: an instructor lists all (including unpublished) tenant lessons', async () => {
    const { router } = buildContentRouter({
        courseLessons: [LECTURE_PUBLISHED, { ...LECTURE_PUBLISHED, id: 'lec-draft', is_published: 0 }],
    });
    const response = await invokeRoute(router, { method: 'GET', url: '/courses/course-a/lessons', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as unknown[]).length, 2);
});

// ---- POST /lessons/:id/complete ------------------------------------------

test('complete: anonymous is 401 and an instructor is 403', async () => {
    const { router } = buildContentRouter();
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/lessons/lec-1/complete' })).statusCode, 401);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/lessons/lec-1/complete', token: INSTRUCTOR_A })).statusCode, 403);
});

test('complete: a locked lesson cannot be completed and no row is written', async () => {
    const policy = { lecture_id: 'lec-2', course_id: 'course-a', tenant_id: 'tenant-a', release_mode: 'sequential', release_at: null, release_timezone: 'UTC', prerequisite_lecture_id: 'lec-1', released_at: null };
    const { router, executed } = buildContentRouter({ policy, lecture: { ...LECTURE_PUBLISHED, id: 'lec-2' } });
    const response = await invokeRoute(router, { method: 'POST', url: '/lessons/lec-2/complete', token: STUDENT_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO lesson_completions')), false);
});

test('complete: an accessible lesson records a completion and audits once', async () => {
    const { router, executed } = buildContentRouter();
    const response = await invokeRoute(router, { method: 'POST', url: '/lessons/lec-1/complete', token: STUDENT_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { created?: boolean }).created, true);
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO lesson_completions')));
    assert.ok(auditFor(executed, 'lesson.completion'), 'lesson.completion audit recorded');
});

test('complete: a retried completion is idempotent (no duplicate row, no second audit)', async () => {
    const { router, db, executed } = buildContentRouter();
    const baseExecute = db.execute;
    let inserts = 0;
    db.execute = async (sql, params) => {
        if (sql.includes('INSERT INTO lesson_completions')) {
            inserts += 1;
            if (inserts > 1) { const error = new Error('dup') as Error & { code?: string }; error.code = 'ER_DUP_ENTRY'; throw error; }
        }
        return baseExecute(sql, params);
    };
    const first = await invokeRoute(router, { method: 'POST', url: '/lessons/lec-1/complete', token: STUDENT_A });
    const second = await invokeRoute(router, { method: 'POST', url: '/lessons/lec-1/complete', token: STUDENT_A });
    assert.equal((first.body as { created?: boolean }).created, true);
    assert.equal((second.body as { created?: boolean }).created, false);
    const audits = executed.filter((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === 'lesson.completion');
    assert.equal(audits.length, 1, 'only the real completion is audited');
});

// ---- PUT /releases/:lectureId --------------------------------------------

test('release config: anonymous is 401 and a student is 403', async () => {
    const { router } = buildContentRouter();
    assert.equal((await invokeRoute(router, { method: 'PUT', url: '/releases/lec-1', body: { release_mode: 'immediate' } })).statusCode, 401);
    assert.equal((await invokeRoute(router, { method: 'PUT', url: '/releases/lec-1', token: STUDENT_A, body: { release_mode: 'immediate' } })).statusCode, 403);
});

test('release config: a non-owner instructor is 403', async () => {
    const { router } = buildContentRouter({
        releaseAuthority: { id: 'lec-1', course_id: 'course-a', tenant_id: 'tenant-a', instructor_id: 'other-instr', is_owner: 0 },
    });
    const response = await invokeRoute(router, { method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A, body: { release_mode: 'immediate' } });
    assert.equal(response.statusCode, 403);
});

test('release config: invalid input is 400 and a self prerequisite is 400', async () => {
    const { router } = buildContentRouter();
    assert.equal((await invokeRoute(router, { method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A, body: { release_mode: 'later' } })).statusCode, 400);
    assert.equal((await invokeRoute(router, { method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A, body: { release_mode: 'sequential', prerequisite_lecture_id: 'lec-1' } })).statusCode, 400);
});

test('release config: the owner schedules a release and it is audited', async () => {
    const { router, executed } = buildContentRouter();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A,
        body: { release_mode: 'scheduled', release_at: '2026-06-01 09:00:00', release_time_zone: 'Asia/Riyadh' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { release_at_utc?: string }).release_at_utc, '2026-06-01T06:00:00.000Z');
    assert.ok(executed.some((e) => e.sql.includes('INSERT INTO lesson_release_policies')));
    assert.ok(auditFor(executed, 'content.release.configured'), 'content.release.configured audit recorded');
});

test('release config: a scheduled release inside the DST gap is 400 before any write', async () => {
    const { router, executed } = buildContentRouter();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A,
        body: { release_mode: 'scheduled', release_at: '2026-03-08 02:30:00', release_time_zone: 'America/New_York' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO lesson_release_policies')), false);
    assert.equal(auditFor(executed, 'content.release.configured'), undefined);
});

test('release config: a missing lecture is 404 with no write', async () => {
    const { router, executed } = buildContentRouter({ releaseAuthority: null });
    const response = await invokeRoute(router, { method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A, body: { release_mode: 'immediate' } });
    assert.equal(response.statusCode, 404);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO lesson_release_policies')), false);
});

test('release config: a same-course, same-tenant prerequisite is accepted and persisted', async () => {
    const { router, executed } = buildContentRouter({
        prerequisite: { id: 'lec-0', course_id: 'course-a', tenant_id: 'tenant-a' },
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A,
        body: { release_mode: 'sequential', prerequisite_lecture_id: 'lec-0' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { prerequisite_lecture_id?: string }).prerequisite_lecture_id, 'lec-0');
    const write = executed.find((e) => e.sql.includes('INSERT INTO lesson_release_policies'));
    assert.ok(write, 'the policy write was issued');
    assert.equal(write!.params[6], 'lec-0', 'the prerequisite is bound to the policy row');
    assert.ok(auditFor(executed, 'content.release.configured'));
});

test('release config: a prerequisite from another course is rejected 400 with no write', async () => {
    const { router, executed } = buildContentRouter({
        prerequisite: { id: 'lec-x', course_id: 'course-b', tenant_id: 'tenant-a' },
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A,
        body: { release_mode: 'sequential', prerequisite_lecture_id: 'lec-x' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO lesson_release_policies')), false);
    assert.equal(auditFor(executed, 'content.release.configured'), undefined);
});

test('release config: a prerequisite from another tenant is rejected 400 with no write', async () => {
    const { router, executed } = buildContentRouter({
        prerequisite: { id: 'lec-y', course_id: 'course-a', tenant_id: 'tenant-b' },
    });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A,
        body: { release_mode: 'sequential', prerequisite_lecture_id: 'lec-y' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO lesson_release_policies')), false);
});

test('release config: a nonexistent prerequisite is rejected 400 with no write', async () => {
    const { router, executed } = buildContentRouter({ prerequisite: null });
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A,
        body: { release_mode: 'sequential', prerequisite_lecture_id: 'lec-missing' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO lesson_release_policies')), false);
});

test('release config: a self prerequisite is rejected 400 before any lookup or write', async () => {
    const { router, executed } = buildContentRouter();
    const response = await invokeRoute(router, {
        method: 'PUT', url: '/releases/lec-1', token: INSTRUCTOR_A,
        body: { release_mode: 'sequential', prerequisite_lecture_id: 'lec-1' },
    });
    assert.equal(response.statusCode, 400);
    const prereqLookup = (e: { sql: string }): boolean =>
        e.sql.includes('l.id, l.course_id, c.tenant_id') && !e.sql.includes('c.instructor_id');
    assert.equal(executed.some(prereqLookup), false, 'no prerequisite lookup issued');
    assert.equal(executed.some((e) => e.sql.includes('INSERT INTO lesson_release_policies')), false);
});

// ---- POST /courses/:courseId/releases/run --------------------------------

test('release runner: anonymous is 401 and a student is 403', async () => {
    const { router } = buildContentRouter();
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/courses/course-a/releases/run' })).statusCode, 401);
    assert.equal((await invokeRoute(router, { method: 'POST', url: '/courses/course-a/releases/run', token: STUDENT_A })).statusCode, 403);
});

test('release runner: a non-owner is 403 and the update is never issued', async () => {
    const { router, executed } = buildContentRouter({
        courseScope: { id: 'course-a', tenant_id: 'tenant-a', instructor_id: 'other-instr', is_owner: 0 },
    });
    const response = await invokeRoute(router, { method: 'POST', url: '/courses/course-a/releases/run', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 403);
    assert.equal(executed.some((e) => e.sql.includes('UPDATE lesson_release_policies')), false);
});

test('release runner: materializes due releases and audits once', async () => {
    const { router, executed } = buildContentRouter();
    const response = await invokeRoute(router, { method: 'POST', url: '/courses/course-a/releases/run', token: INSTRUCTOR_A });
    assert.equal(response.statusCode, 200);
    assert.equal((response.body as { released?: number }).released, 1);
    assert.ok(executed.some((e) => e.sql.includes('UPDATE lesson_release_policies')));
    assert.ok(auditFor(executed, 'content.release.run'), 'content.release.run audit recorded');
});

test('release runner: a retry that releases nothing writes no audit', async () => {
    const { router, db, executed } = buildContentRouter();
    const baseExecute = db.execute;
    let updates = 0;
    db.execute = async (sql, params) => {
        if (sql.includes('UPDATE lesson_release_policies')) {
            updates += 1;
            return updates > 1 ? { affectedRows: 0, insertId: 0 } : baseExecute(sql, params);
        }
        return baseExecute(sql, params);
    };
    const first = await invokeRoute(router, { method: 'POST', url: '/courses/course-a/releases/run', token: INSTRUCTOR_A });
    const second = await invokeRoute(router, { method: 'POST', url: '/courses/course-a/releases/run', token: INSTRUCTOR_A });
    assert.equal((first.body as { released?: number }).released, 1);
    assert.equal((second.body as { released?: number }).released, 0);
    const audits = executed.filter((e) => e.sql.includes('INSERT INTO audit_events') && (e.params[3] as string) === 'content.release.run');
    assert.equal(audits.length, 1, 'only the real release run is audited');
});
