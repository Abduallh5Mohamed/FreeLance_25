/**
 * M8 Q6 — per-tenant data export.
 *
 * Scope + permission model (deny by default):
 *  - An export is started only by the verified tenant OWNER of the
 *    server-derived tenant, or by a verified platform actor holding the
 *    `tenant_export.request` permission (server-owned rows only; a JWT role
 *    claim is never evidence).
 *  - The whole surface fails closed with 503 unless TENANT_EXPORT_SECRET is
 *    configured with at least EXPORT_SECRET_MIN_BYTES (32) bytes: no job is
 *    created, no token is issued, no byte is read, and the denial is audited.
 *  - One active (pending) export per tenant is enforced twice: an explicit
 *    pre-check AND the database-level UNIQUE key on the generated
 *    active_tenant_lock column (see migration 20261018_23), so two concurrent
 *    requests cannot both start an export; the loser of that INSERT race is
 *    mapped to 409 instead of surfacing a 500. A completed export starts a
 *    cooldown window during which new requests are 409.
 *  - The job insert and its audit row commit together when the injected
 *    connection exposes `transaction`. Without that seam a failed audit is
 *    recovered with a guarded pending -> failed transition, so a request never
 *    leaves an unaudited active job and never reports success. The same
 *    guarded recovery applies to the completion transition.
 *
 * Ownership (W2 repair):
 *  - `tenant_id` is a nullable column on several planned tables. It was
 *    populated once by the 20261017_04 backfill, and some write paths never
 *    set it, so `WHERE tenant_id = ?` silently dropped every row created
 *    after that backfill (SQL `=` never matches NULL).
 *  - Each planned table therefore declares ownership *authorities*:
 *      * `owns`     — a predicate proving the row belongs to the bound tenant
 *                     (direct `tenant_id`, or a parent whose own tenant is
 *                     proven: lectures/groups/exams -> courses, children ->
 *                     their planned parent);
 *      * `conflicts` — a predicate proving the same row is claimed by a
 *                     different tenant.
 *    A row is exported only when at least one authority proves the tenant AND
 *    no authority resolves to another tenant. A direct `tenant_id` that
 *    contradicts the proven parent is rejected and counted, never preferred.
 *    Two resolved authorities that disagree are ambiguity, and ambiguity is a
 *    denial: there is no "first row"/"first parent" selection anywhere.
 *  - Authorities are denial-only where they are not a proof source (e.g. a
 *    lecture's group, an exam's group attachments). They can remove a row but
 *    never add one, so the export never widens beyond the plan's parent chain.
 *  - Rows whose ownership cannot be proven (NULL direct value and no
 *    resolvable parent) are never selected and are never counted: an
 *    unattributable row is not evidence of this tenant's data, and a count
 *    could describe another institution's activity.
 *
 * Completeness manifest (v2):
 *  - Per-table row count, byte size and SHA-256 checksum of the exact JSONL
 *    payload written through the injected storage interface.
 *  - `coverage.included[]` names every table that was written with its
 *    ownership basis, parent chain, rejected-contradiction count and whether a
 *    resource cap truncated it. `coverage.omitted[]` names every tenant-scoped
 *    table in `server/migrations` that the plan does not export, with a reason
 *    and, where a proof exists, a proven lower bound of this tenant's rows.
 *  - `coverage.complete` and `coverage.incomplete` answer different questions
 *    and neither of them means "broken":
 *      * `complete` is always false — this file is a declared subset of
 *        tenant-scoped tables, read table by table without a consistent
 *        point-in-time snapshot, and rows whose ownership cannot be proven are
 *        withheld. No other field can make it a full copy of the tenant.
 *      * `incomplete` is true only when a gap was detected *inside the
 *        declared plan*: a resource cap truncated a table, a table was skipped
 *        because the byte budget was spent, or a row was rejected as an
 *        ownership contradiction. `incomplete: false` means no such gap was
 *        detected in the planned tables; it never upgrades the extract to
 *        complete.
 *  - Reads are paged by keyset (`id > ?`) with a bounded page size, and both a
 *    per-table row cap and a total byte cap are enforced while reading — the
 *    whole table is never materialised before the JSONL is built.
 *  - Stale `pending` jobs are never reclaimed on age alone: `tenant_data_exports`
 *    has no owner/fencing column, so reclaiming would race a live worker. That
 *    part needs a schema change (I2) and is reported, not invented here.
 *
 *  - Downloads require a signed, expiring HMAC token
 *    (base64url(payload).base64url(HMAC-SHA256(secret, payload))) binding
 *    export id + tenant id + expiry; verification is constant-time and fails
 *    closed. The signed export id must equal the requested export id, and the
 *    persisted token hash makes re-issuance rotate (invalidate) the previous
 *    token. Every request, completion, failure, token issuance and download
 *    is audited; configuration and download denials are audited too.
 *
 * This module never reads process.env or performs I/O itself: the secret,
 * the clock, the id generator, the storage and the audit writer are all
 * injected, so the whole flow is hermetically testable.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';

export const EXPORT_SECRET_MIN_BYTES = 32;
export const EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS = 600;
export const EXPORT_DOWNLOAD_WINDOW_SECONDS = 24 * 60 * 60;
export const EXPORT_COOLDOWN_SECONDS = 300;
export const EXPORT_STORAGE_PREFIX = 'tenant-exports';
export const EXPORT_PLATFORM_PERMISSION = 'tenant_export.request';
/** v2 adds the `coverage` section and the `incomplete` flag. */
export const EXPORT_MANIFEST_VERSION = 2;

/** Rows per keyset page. Overridable per call for tests; validated on use. */
export const EXPORT_PAGE_SIZE = 500;
/** Hard cap on rows read from one table before it is declared truncated. */
export const EXPORT_MAX_ROWS_PER_TABLE = 50_000;
/** Hard cap on the bytes this export may write across all tables (64 MiB). */
export const EXPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const EXPORT_MAX_PAGE_SIZE = 10_000;

export interface ExportLimits {
    pageSize: number;
    maxRowsPerTable: number;
    maxTotalBytes: number;
}

export const EXPORT_DEFAULT_LIMITS: ExportLimits = {
    pageSize: EXPORT_PAGE_SIZE,
    maxRowsPerTable: EXPORT_MAX_ROWS_PER_TABLE,
    maxTotalBytes: EXPORT_MAX_TOTAL_BYTES,
};

export interface TenantExportDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    /**
     * Optional serialized-transaction seam. When present, job state
     * transitions run inside it; without it each statement runs on the
     * caller's connection.
     */
    transaction?: <T>(fn: (tx: TenantExportDataAccess) => Promise<T>) => Promise<T>;
}

/** Injected object storage seam (production: S3/local adapter; tests: memory). */
export interface TenantExportStorage {
    write(key: string, body: string): Promise<void>;
    read(key: string): Promise<string>;
}

export interface TenantExportAuditInput {
    actorUserId: string | null;
    tenantId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
}

export interface TenantExportDeps {
    db: TenantExportDataAccess;
    storage: TenantExportStorage;
    /** TENANT_EXPORT_SECRET; the surface fails closed (503) below 32 bytes. */
    secret: string | undefined;
    /**
     * Audit writer. The optional executor is the transaction-scoped access
     * object when a transaction seam is available, so the business write and
     * its audit row commit or roll back together.
     */
    audit: (input: TenantExportAuditInput, db?: TenantExportDataAccess) => Promise<void>;
    now?: () => number;
    newId?: () => string;
    /** Resource caps; defaults to EXPORT_DEFAULT_LIMITS. */
    limits?: Partial<ExportLimits>;
}

// ---------------------------------------------------------------------------
// Ownership model: every statement proves ownership before a row is loaded.
// ---------------------------------------------------------------------------

/** The ownership classification the statement returns for each row. */
export const EXPORT_OWNERSHIP_OWNED = 'owned';
export const EXPORT_OWNERSHIP_CONTRADICTION = 'contradiction';
const OWNERSHIP_COLUMN = '__ownership';

export type ExportOwnershipBasis = 'direct' | 'parent';

export interface ExportOwnershipAuthority {
    /** Human-readable proof source, e.g. `courses.id = lectures.course_id`. */
    source: string;
    /**
     * SQL predicate that is true when this authority proves the row belongs to
     * the bound tenant. `null` makes the authority denial-only: it can reject a
     * row but never justify including one.
     */
    owns: string | null;
    /** SQL predicate that is true when this authority resolves elsewhere. */
    conflicts: string;
}

interface ExportPlanSpec {
    table: string;
    /** Explicit, alias-qualified column list (never SELECT *). */
    select: string;
    /** FROM clause aliasing the exported table as `t`. */
    from: string;
    authorities: readonly ExportOwnershipAuthority[];
    basis: ExportOwnershipBasis;
    parent: string | null;
}

export interface ExportTablePlan extends ExportPlanSpec {
    /**
     * The first-page statement. Later pages append the keyset predicate
     * (`AND t.id > ?`), so this exact string is what a single-page table runs.
     */
    sql: string;
}

const countPlaceholders = (fragment: string): number => fragment.split('?').length - 1;

const buildExportPageSql = (spec: ExportPlanSpec, withCursor: boolean): string => {
    const conflicts = spec.authorities.map((authority) => `(${authority.conflicts})`).join(' OR ');
    const owns = spec.authorities
        .filter((authority): authority is ExportOwnershipAuthority & { owns: string } => authority.owns !== null)
        .map((authority) => `(${authority.owns})`)
        .join(' OR ');
    return [
        `SELECT ${spec.select},`,
        `CASE WHEN ${conflicts} THEN '${EXPORT_OWNERSHIP_CONTRADICTION}' ELSE '${EXPORT_OWNERSHIP_OWNED}' END AS ${OWNERSHIP_COLUMN}`,
        `FROM ${spec.from}`,
        `WHERE (${owns})`,
        withCursor ? 'AND t.id > ?' : '',
        'ORDER BY t.id',
        'LIMIT ?',
    ].filter((part) => part !== '').join(' ');
};

/**
 * Parameters in the exact textual order of the placeholders: the CASE
 * classification first, then the WHERE ownership proof, then the keyset
 * cursor, then the page size. Every parameter except the cursor is the
 * export tenant, so a mis-ordered pin can never widen the scope.
 */
const exportPageParams = (
    spec: ExportPlanSpec,
    tenantId: string,
    cursor: string | null,
    pageSize: number,
): unknown[] => {
    const params: unknown[] = [];
    const pushTenantPins = (fragment: string): void => {
        for (let index = 0; index < countPlaceholders(fragment); index += 1) params.push(tenantId);
    };
    for (const authority of spec.authorities) pushTenantPins(authority.conflicts);
    for (const authority of spec.authorities) {
        if (authority.owns !== null) pushTenantPins(authority.owns);
    }
    if (cursor !== null) params.push(cursor);
    params.push(pageSize);
    return params;
};

const defineExportPlan = (spec: ExportPlanSpec): ExportTablePlan => ({
    ...spec,
    sql: buildExportPageSql(spec, false),
});

const directTenantAuthority = (alias = 't'): ExportOwnershipAuthority => ({
    source: `${alias}.tenant_id`,
    owns: `${alias}.tenant_id = ?`,
    conflicts: `${alias}.tenant_id <> ?`,
});

const parentTenantAuthority = (parentAlias: string, source: string): ExportOwnershipAuthority => ({
    source,
    owns: `${parentAlias}.tenant_id = ?`,
    conflicts: `${parentAlias}.tenant_id <> ?`,
});

/**
 * The completeness plan. Column lists are explicit (never SELECT *) so
 * credential material cannot creep in: students.password_hash is the only
 * secret column in scope and it is deliberately absent from its list.
 *
 * `t` is always the exported table. Parent joins are 1:1 on a primary key, so
 * they cannot duplicate rows; set-shaped authorities are expressed as EXISTS
 * subqueries for the same reason.
 */
export const EXPORT_TABLE_PLAN: readonly ExportTablePlan[] = [
    defineExportPlan({
        table: 'courses',
        select: 't.id, t.name, t.subject, t.description, t.grade, t.is_active, t.price, t.duration_months, t.thumbnail_url, t.tenant_id, t.instructor_id, t.created_at, t.updated_at',
        from: 'courses t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'lectures',
        select: 't.id, t.course_id, t.grade_id, t.group_id, t.instructor_id, t.title, t.description, t.video_url, t.duration_minutes, t.price, t.display_order, t.is_free, t.is_published, t.archived_at, t.tenant_id, t.created_at, t.updated_at',
        from: 'lectures t LEFT JOIN courses pc ON pc.id = t.course_id LEFT JOIN `groups` pg ON pg.id = t.group_id',
        authorities: [
            directTenantAuthority(),
            parentTenantAuthority('pc', 'courses.id = lectures.course_id'),
            {
                // Denial-only: a lecture attached to another tenant's group is
                // ambiguous ownership, so it is rejected rather than assigned
                // to whichever authority happens to resolve first.
                source: 'groups.tenant_id = lectures.group_id',
                owns: null,
                conflicts: 'pg.tenant_id <> ?',
            },
        ],
        basis: 'parent',
        parent: 'courses.id = lectures.course_id',
    }),
    defineExportPlan({
        table: 'announcements',
        select: 't.id, t.tenant_id, t.branch_id, t.title, t.body, t.audience, t.status, t.created_by, t.published_at, t.retracted_at, t.version, t.created_at, t.updated_at',
        from: 'announcements t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'schedules',
        select: 't.id, t.tenant_id, t.branch_id, t.group_id, t.title, t.audience, t.timezone, t.starts_at, t.ends_at, t.status, t.created_by, t.cancelled_at, t.version, t.created_at, t.updated_at',
        from: 'schedules t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'groups',
        select: 't.id, t.name, t.description, t.course_id, t.grade_id, t.instructor_id, t.branch_id, t.branch_scope, t.max_students, t.current_students, t.schedule_days, t.schedule_time, t.is_active, t.tenant_id, t.created_at, t.updated_at',
        from: '`groups` t LEFT JOIN courses pc ON pc.id = t.course_id',
        authorities: [directTenantAuthority(), parentTenantAuthority('pc', 'courses.id = groups.course_id')],
        basis: 'parent',
        parent: 'courses.id = groups.course_id',
    }),
    defineExportPlan({
        table: 'branches',
        select: 't.id, t.tenant_id, t.name, t.status, t.version, t.created_at, t.updated_at',
        from: 'branches t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'branch_memberships',
        select: 't.id, t.branch_id, t.user_id, t.role, t.status, t.version, t.created_at, t.updated_at',
        from: 'branch_memberships t INNER JOIN branches b ON b.id = t.branch_id',
        authorities: [parentTenantAuthority('b', 'branches.id = branch_memberships.branch_id')],
        basis: 'parent',
        parent: 'branches.id = branch_memberships.branch_id',
    }),
    defineExportPlan({
        table: 'grades',
        select: 't.id, t.name, t.display_order, t.is_active, t.tenant_id, t.created_at, t.updated_at',
        from: 'grades t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'students',
        select: 't.id, t.name, t.email, t.phone, t.grade, t.grade_id, t.group_id, t.barcode, t.is_offline, t.approval_status, t.parent_phone, t.address, t.notes, t.is_active, t.term, t.user_id, t.tenant_id, t.instructor_id, t.enrollment_start_date, t.enrollment_end_date, t.enrollment_status, t.created_at, t.updated_at',
        from: 'students t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'student_courses',
        select: 't.id, t.student_id, t.course_id, t.enrollment_date, t.status, t.progress',
        from: 'student_courses t INNER JOIN students s ON s.id = t.student_id',
        authorities: [parentTenantAuthority('s', 'students.id = student_courses.student_id')],
        basis: 'parent',
        parent: 'students.id = student_courses.student_id',
    }),
    defineExportPlan({
        table: 'course_materials',
        select: 't.id, t.course_id, t.title, t.description, t.material_type, t.file_url, t.file_size, t.duration_minutes, t.display_order, t.is_free, t.is_published, t.created_at, t.updated_at',
        from: 'course_materials t INNER JOIN courses c ON c.id = t.course_id',
        authorities: [parentTenantAuthority('c', 'courses.id = course_materials.course_id')],
        basis: 'parent',
        parent: 'courses.id = course_materials.course_id',
    }),
    defineExportPlan({
        table: 'exams',
        select: 't.id, t.title, t.description, t.course_id, t.duration_minutes, t.total_marks, t.passing_marks, t.exam_date, t.start_time, t.end_time, t.is_active, t.is_published, t.allow_review, t.shuffle_questions, t.tenant_id, t.created_at, t.updated_at',
        from: 'exams t LEFT JOIN courses pc ON pc.id = t.course_id',
        authorities: [
            directTenantAuthority(),
            parentTenantAuthority('pc', 'courses.id = exams.course_id'),
            {
                // Denial-only: an exam attached to a group that resolves to
                // another tenant is a contradiction between authorities.
                source: 'exam_groups -> groups -> courses',
                owns: null,
                conflicts: 'EXISTS (SELECT 1 FROM exam_groups eg INNER JOIN `groups` g ON g.id = eg.group_id LEFT JOIN courses gc ON gc.id = g.course_id WHERE eg.exam_id = t.id AND (gc.tenant_id <> ? OR g.tenant_id <> ?))',
            },
        ],
        basis: 'parent',
        parent: 'courses.id = exams.course_id',
    }),
    defineExportPlan({
        table: 'exam_questions',
        select: 't.id, t.exam_id, t.question_text, t.question_type, t.options, t.correct_answer, t.points, t.explanation, t.display_order, t.created_at, t.updated_at',
        from: 'exam_questions t INNER JOIN exams e ON e.id = t.exam_id LEFT JOIN courses pc ON pc.id = e.course_id',
        authorities: [
            { ...directTenantAuthority('e'), source: 'exams.tenant_id = exam_questions.exam_id' },
            parentTenantAuthority('pc', 'courses.id = exams.course_id'),
            {
                // The parent exam is rejected as a contradiction, so its
                // questions must be rejected with it instead of surviving on a
                // narrower authority.
                source: 'exam_groups -> groups -> courses (parent exam)',
                owns: null,
                conflicts: 'EXISTS (SELECT 1 FROM exam_groups eg INNER JOIN `groups` g ON g.id = eg.group_id LEFT JOIN courses gc ON gc.id = g.course_id WHERE eg.exam_id = e.id AND (gc.tenant_id <> ? OR g.tenant_id <> ?))',
            },
        ],
        basis: 'parent',
        parent: 'exams.id = exam_questions.exam_id -> courses.id = exams.course_id',
    }),
    defineExportPlan({
        table: 'question_bank_questions',
        select: 't.id, t.tenant_id, t.branch_id, t.branch_scope, t.question_type, t.question_text, t.options, t.correct_answers, t.points, t.explanation, t.tags, t.current_version, t.archived_at, t.created_by, t.created_at, t.updated_at, t.version',
        from: 'question_bank_questions t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'question_bank_versions',
        select: 't.id, t.question_id, t.tenant_id, t.version, t.question_type, t.question_text, t.options, t.correct_answers, t.points, t.explanation, t.tags, t.created_by, t.created_at',
        from: 'question_bank_versions t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'assignments',
        select: 't.id, t.tenant_id, t.branch_id, t.branch_scope, t.course_id, t.group_id, t.title, t.instructions, t.deadline_at, t.deadline_timezone, t.late_policy, t.resubmission_policy, t.max_submissions, t.max_file_bytes, t.allowed_file_types, t.status, t.archived_at, t.created_by, t.created_at, t.updated_at, t.version',
        from: 'assignments t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'assignment_submissions',
        select: 't.id, t.tenant_id, t.assignment_id, t.student_enrollment_id, t.student_user_id, t.version, t.status, t.file_name, t.file_type, t.file_size_bytes, t.storage_key, t.scan_status, t.is_late, t.submitted_at, t.revoked_at, t.revoked_by, t.revoke_reason, t.created_at',
        from: 'assignment_submissions t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
];

/** Human-readable record of what the export never contains. */
export const EXPORT_EXCLUSIONS: readonly string[] = [
    'students.password_hash (credential material is never selected)',
    'users (platform identity rows carry no tenant scope and are never selected)',
    'platform secrets and configuration (API keys, HMAC secrets, env values)',
    'rows of other tenants (every statement pins the tenant in its ownership proof and contradiction check)',
    'a consistent point-in-time snapshot (each table is read in its own paged statement)',
];

/**
 * Why a tenant-scoped table is not exported. The category is the stable,
 * machine-checkable statement; the prose `reason` is human wording that may be
 * re-edited. `product_excluded` is the only category that records a product
 * decision rather than a pending one.
 */
export type ExportOmissionCategory =
    | 'credential_secret'
    | 'platform_finance'
    | 'operational_state'
    | 'product_excluded'
    | 'outside_plan'
    | 'budget_exhausted';

/**
 * Tenant-scoped tables in `server/migrations` that EXPORT_TABLE_PLAN does not
 * export, grouped by category. Each table is named exactly once across all
 * groups so `coverage.omitted` is a set, not a list; a table named twice would
 * double-count coverage.
 *
 * `outside_plan` means "not decided yet": adding such a table changes the
 * declared export scope and needs an explicit owner decision. `product_excluded`
 * is different — it records a decision that was already taken.
 */
const EXPORT_OMITTED_GROUPS: readonly {
    category: ExportOmissionCategory;
    reason: string;
    tables: readonly string[];
}[] = [
    {
        category: 'credential_secret',
        reason: 'credential and session secret material is never exported',
        tables: [
            'identity_otp_challenges',
            'impersonation_sessions',
            'parent_view_tokens',
            'student_enrollment_invites',
            'student_password_reset_requests',
            'tenant_invitations',
        ],
    },
    {
        category: 'platform_finance',
        reason: 'platform billing and finance: exporting these needs an explicit privacy decision, and this batch makes no financial-data change',
        tables: [
            'expenses',
            'instructor_topup_requests',
            'payment_requests',
            'platform_revenue_events',
            'revenues',
            'student_fees',
            'subscription_requests',
            'tenant_account_notes',
            'tenant_billing_profiles',
            'tenant_renewal_intents',
            'tenant_subscriptions',
        ],
    },
    {
        category: 'operational_state',
        reason: 'operational, telemetry and internal job state is not tenant content',
        tables: [
            'admin_work_items',
            'audit_events',
            'branch_audit_log',
            'imports',
            'playback_devices',
            'playback_entitlements',
            'playback_session_slots',
            'playback_tenant_policies',
            'student_import_batches',
            'tenant_data_exports',
            'video_asset_callbacks',
            'video_processing_queue',
            'video_usage_events',
        ],
    },
    {
        // A decision already taken, not a pending one: the owner excluded the
        // certificate feature (A8) from the product on 2026-10-19, so these
        // rows are not tenant content the export owes anyone. Source,
        // migrations and historical rows are retained, not deleted.
        category: 'product_excluded',
        reason: 'product-excluded by owner decision (2026-10-19): the certificate feature (A8) is outside the product, so certificate rows are not tenant content this export covers; the source, migrations and historical rows are retained, not deleted',
        tables: ['certificates'],
    },
    {
        category: 'outside_plan',
        reason: 'tenant content outside the approved plan: adding it changes the declared export scope and needs an explicit owner decision, so this batch neither adds it nor endorses its exclusion',
        tables: [
            'attendance_records',
            'exam_grading_runs',
            'exam_version_questions',
            'exam_versioned_answers',
            'exam_versioned_attempts',
            'exam_versions',
            'gradebook_policies',
            'gradebook_scores',
            'lesson_completions',
            'lesson_discussion_blocks',
            'lesson_discussion_replies',
            'lesson_discussion_reports',
            'lesson_discussion_threads',
            'lesson_release_policies',
            'moderation_appeals',
            'moderation_cases',
            'moderation_decision_history',
            'notification_consent_events',
            'notification_delivery_receipts',
            'notification_outbox',
            'parent_links',
            'playback_progress',
            'question_bank_version_usages',
            'schedule_series',
            'schedule_sessions',
            'student_enrollment_requests',
            'tenant_branding',
            'tenant_custom_domains',
            'tenant_media_files',
            'tenant_memberships',
            'video_assets',
            'videos',
        ],
    },
];

/**
 * Proven lower bounds for omitted tables. Each statement is pinned to the
 * export tenant through a column that cannot be NULL (a direct `tenant_id`, or
 * a parent chain whose terminal column is NOT NULL), so the count is evidence
 * of this tenant's own rows and never a global orphan count.
 */
interface ExportCountProbe {
    table: string;
    sql: string;
    evidence: string;
}

const EXPORT_OMITTED_PROBES: readonly ExportCountProbe[] = [
    {
        table: 'attendance_records',
        sql: 'SELECT COUNT(*) AS n FROM attendance_records WHERE tenant_id = ?',
        evidence: 'attendance_records.tenant_id IS NOT NULL',
    },
    {
        table: 'lesson_completions',
        sql: 'SELECT COUNT(*) AS n FROM lesson_completions WHERE tenant_id = ?',
        evidence: 'lesson_completions.tenant_id IS NOT NULL',
    },
];

/**
 * Children of exported rows that the plan does not export at all. Their
 * ownership is proven through the planned parent, which is the only way to
 * show the omission is real without reading another tenant's rows.
 */
const EXPORT_OMITTED_CHILD_PROBES: readonly ExportCountProbe[] = [
    {
        table: 'exam_results',
        sql: 'SELECT COUNT(*) AS n FROM exam_results r INNER JOIN exams e ON e.id = r.exam_id INNER JOIN courses c ON c.id = e.course_id WHERE c.tenant_id = ?',
        evidence: 'exam_results.exam_id -> exams.course_id -> courses.tenant_id',
    },
    {
        table: 'group_courses',
        sql: 'SELECT COUNT(*) AS n FROM group_courses gc INNER JOIN `groups` g ON g.id = gc.group_id INNER JOIN courses c ON c.id = g.course_id WHERE c.tenant_id = ?',
        evidence: 'group_courses.group_id -> groups.course_id -> courses.tenant_id',
    },
    {
        table: 'student_materials',
        sql: 'SELECT COUNT(*) AS n FROM student_materials sm INNER JOIN course_materials m ON m.id = sm.material_id INNER JOIN courses c ON c.id = m.course_id WHERE c.tenant_id = ?',
        evidence: 'student_materials.material_id -> course_materials.course_id -> courses.tenant_id',
    },
];

// ---------------------------------------------------------------------------
// Checksums, JSONL, tokens.
// ---------------------------------------------------------------------------

export const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

export const jsonlOf = (rows: readonly Record<string, unknown>[]): string =>
    rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

const b64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url');

const timingSafeStringEqual = (a: string, b: string): boolean => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
};

export interface ExportDownloadTokenPayload {
    v: 1;
    e: string;
    t: string;
    x: number;
}

export const signExportToken = (secret: string, payload: ExportDownloadTokenPayload): string => {
    const body = b64url(JSON.stringify(payload));
    const signature = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
};

const verifyExportTokenSignature = (secret: string, token: string): ExportDownloadTokenPayload | null => {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (signature.includes('.')) return null;
    let payload: Partial<ExportDownloadTokenPayload>;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<ExportDownloadTokenPayload>;
    } catch {
        return null;
    }
    if (
        payload.v !== 1
        || typeof payload.e !== 'string' || payload.e.length === 0
        || typeof payload.t !== 'string' || payload.t.length === 0
        || typeof payload.x !== 'number' || !Number.isFinite(payload.x)
    ) {
        return null;
    }
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (!timingSafeStringEqual(expected, signature)) return null;
    return payload as ExportDownloadTokenPayload;
};

// ---------------------------------------------------------------------------
// Job rows + manifest.
// ---------------------------------------------------------------------------

export interface TenantExportJobRow {
    id: string;
    tenant_id: string;
    status: string;
    requested_by: string | null;
    storage_key: string | null;
    file_size: number | string | null;
    manifest: unknown;
    token_hash: string | null;
    expires_at: string | Date | null;
    error: string | null;
    created_at: string | Date;
    completed_at: string | Date | null;
}

export interface ExportTableManifest {
    table: string;
    rows: number;
    bytes: number;
    checksum: string;
}

/** Per-table coverage: how the rows were proven and whether they are whole. */
export interface ExportTableCoverage {
    table: string;
    rows: number;
    basis: ExportOwnershipBasis;
    parent: string | null;
    authorities: string[];
    /** Rows that claimed this tenant while another authority disagreed. */
    rejected_contradictions: number;
    /** True when a resource cap stopped the read before the table was exhausted. */
    truncated: boolean;
    pages: number;
}

export interface ExportOmittedTable {
    table: string;
    /** Stable classification of the omission; `reason` is the human wording. */
    category: ExportOmissionCategory;
    reason: string;
    /** Proven lower bound of this tenant's rows; null when no proof exists. */
    provable_rows: number | null;
    evidence: string | null;
}

export interface ExportOmittedChild {
    table: string;
    evidence: string;
    provable_rows: number | null;
}

export interface ExportCoverage {
    scope: string;
    included: ExportTableCoverage[];
    omitted: ExportOmittedTable[];
    omitted_children: ExportOmittedChild[];
    rejected: Array<{ table: string; rows: number; reason: string }>;
    limitations: string[];
    /**
     * Always false. It does not mean the export is broken: the plan is a
     * declared subset of tenant-scoped tables, no consistent point-in-time
     * snapshot is taken, and rows whose ownership cannot be proven are
     * withheld. Nothing in this manifest can make it a full copy of the tenant.
     */
    complete: boolean;
    /**
     * True only when a gap was detected inside the declared plan (a cap
     * truncated a table, a table was skipped for budget, or a row was rejected
     * as a contradiction). False means no such gap was detected in the planned
     * tables; it does not mean the extract is a complete copy — `complete`
     * stays false either way.
     */
    incomplete: boolean;
}

export interface ExportManifest {
    version: number;
    tenant_id: string;
    started_at: string;
    completed_at: string;
    tables: ExportTableManifest[];
    total_rows: number;
    total_bytes: number;
    excluded: string[];
    coverage: ExportCoverage;
    /** Mirrors `coverage.incomplete`; see there for what it does not mean. */
    incomplete: boolean;
}

const EXPORT_COVERAGE_SCOPE =
    'EXPORT_TABLE_PLAN: a declared subset of tenant-scoped tables, read table by table without a consistent snapshot';

const EXPORT_COVERAGE_LIMITATIONS: readonly string[] = [
    'rows whose ownership cannot be proven from the plan parent chain are excluded and are not counted: an unattributable row is not evidence of this tenant, and a count could describe another institution',
    'root rows with a NULL tenant_id (courses, grades, students) cannot be attributed and are excluded without a count',
    'grades.tenant_id NULL means a shared legacy catalog row, which is not tenant-owned and is excluded',
    'each table is read in its own paged statement, so the extract is not a consistent point-in-time snapshot',
    'stale pending jobs are never reclaimed on age alone: tenant_data_exports has no owner/fencing column, so reclaiming would race a live worker and needs a schema change (I2)',
];

const asTime = (value: string | Date | null | undefined): number => {
    if (!value) return 0;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
};

const secretConfigured = (secret: string | undefined): secret is string =>
    typeof secret === 'string' && secret.length >= EXPORT_SECRET_MIN_BYTES;

/**
 * Runs `fn` inside the injected transaction when the connection provides one.
 * Production wires `transaction` to the pool's `withTransaction`; hermetic
 * callers without that seam keep the previous statement-per-call behaviour and
 * rely on the compensating guarded transitions below.
 */
const inTransaction = async <T>(
    db: TenantExportDataAccess,
    fn: (tx: TenantExportDataAccess) => Promise<T>,
): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));

/** A guarded transition found the row in an unexpected state (not an outage). */
class ExportStateConflictError extends Error {}

/** MySQL duplicate-key (1062) surfaces as ER_DUP_ENTRY on the driver error. */
const isDuplicateKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    if ((error as { code?: unknown }).code === 'ER_DUP_ENTRY') return true;
    return (error as { errno?: unknown }).errno === 1062;
};

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'unknown export failure';

/**
 * Guarded pending -> failed transition. It only ever matches the exact tenant
 * and job and only while the row is still in the expected state, so a
 * concurrent completion cannot be demoted by a recovery path.
 */
const failPendingJob = async (
    db: TenantExportDataAccess,
    exportId: string,
    tenantId: string,
    reason: string,
): Promise<void> => {
    await db.execute(
        `UPDATE tenant_data_exports SET status = 'failed', error = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
        [reason.slice(0, 1000), exportId, tenantId],
    );
};

/**
 * Recovery after the completion write succeeded in this call but its audit
 * row did not commit. Without a transaction seam the status is already
 * 'completed'; with one the rollback left it 'pending'. Both are demoted to
 * 'failed' so the surface never reports an unaudited success.
 */
const failJobAfterAuditFailure = async (
    db: TenantExportDataAccess,
    exportId: string,
    tenantId: string,
    reason: string,
): Promise<void> => {
    await db.execute(
        `UPDATE tenant_data_exports SET status = 'failed', error = ?
         WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'completed')`,
        [reason.slice(0, 1000), exportId, tenantId],
    );
};

// ---------------------------------------------------------------------------
// Request (fail closed on secret, one active per tenant, cooldown).
// ---------------------------------------------------------------------------

export type ExportRequestResult =
    | { ok: true; job: { id: string; tenantId: string; status: string; createdAt: string } }
    | { ok: false; status: number; error: string };

export const requestTenantExport = async (
    deps: TenantExportDeps,
    input: { tenantId: string; actorUserId: string; reason?: string },
): Promise<ExportRequestResult> => {
    if (!secretConfigured(deps.secret)) {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            action: 'tenant_export.request_denied',
            resourceType: 'tenant_data_exports',
            resourceId: '*',
            newValue: { tenant_id: input.tenantId },
            reason: 'The tenant export service is not configured',
        });
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    const now = deps.now ?? Date.now;
    const active = await deps.db.queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM tenant_data_exports
         WHERE tenant_id = ? AND status = 'pending' LIMIT 1`,
        [input.tenantId],
    );
    if (active) {
        // A pending row is honoured, never stolen on age: there is no fencing
        // column, so reclaiming it could race a worker that is still alive.
        return { ok: false, status: 409, error: 'An export for this tenant is already in progress' };
    }
    const lastCompleted = await deps.db.queryOne<{ created_at: string | Date }>(
        `SELECT created_at FROM tenant_data_exports
         WHERE tenant_id = ? AND status = 'completed'
         ORDER BY created_at DESC LIMIT 1`,
        [input.tenantId],
    );
    if (lastCompleted) {
        const createdAt = asTime(lastCompleted.created_at);
        if (createdAt > 0 && now() - createdAt < EXPORT_COOLDOWN_SECONDS * 1000) {
            return { ok: false, status: 409, error: 'An export for this tenant was completed recently; the cooldown window applies' };
        }
    }
    const id = deps.newId?.() ?? randomUUID();
    let inserted = false;
    try {
        await inTransaction(deps.db, async (db) => {
            await db.execute(
                `INSERT INTO tenant_data_exports (id, tenant_id, status, requested_by)
                 VALUES (?, ?, 'pending', ?)`,
                [id, input.tenantId, input.actorUserId],
            );
            inserted = true;
            await deps.audit({
                actorUserId: input.actorUserId,
                tenantId: input.tenantId,
                action: 'tenant_export.requested',
                resourceType: 'tenant_data_exports',
                resourceId: id,
                newValue: { tenant_id: input.tenantId },
                reason: input.reason ?? 'Tenant data export requested',
            }, db);
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            // A concurrent request won the UNIQUE(active_tenant_lock) race.
            return { ok: false, status: 409, error: 'An export for this tenant is already in progress' };
        }
        if (inserted && !deps.db.transaction) {
            // No transaction seam: the pending row is already committed, so
            // recover it explicitly instead of leaving a stuck active job.
            try {
                await failPendingJob(
                    deps.db,
                    id,
                    input.tenantId,
                    `The export request was not audited: ${errorMessage(error)}`,
                );
            } catch (compensationError) {
                throw new Error(
                    `The export request was not audited (${errorMessage(error)}) and the pending job could not be marked failed (${errorMessage(compensationError)})`,
                );
            }
        }
        throw error;
    }
    return { ok: true, job: { id, tenantId: input.tenantId, status: 'pending', createdAt: new Date(now()).toISOString() } };
};

// ---------------------------------------------------------------------------
// Processing: paged tenant-proven reads, checksums, storage writes, coverage.
// ---------------------------------------------------------------------------

const resolveLimits = (overrides: Partial<ExportLimits> | undefined): ExportLimits => {
    const limits: ExportLimits = { ...EXPORT_DEFAULT_LIMITS, ...overrides };
    if (!Number.isInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > EXPORT_MAX_PAGE_SIZE) {
        throw new Error(`The export page size must be an integer between 1 and ${EXPORT_MAX_PAGE_SIZE}`);
    }
    if (!Number.isInteger(limits.maxRowsPerTable) || limits.maxRowsPerTable < 1) {
        throw new Error('The export row cap must be a positive integer');
    }
    if (!Number.isInteger(limits.maxTotalBytes) || limits.maxTotalBytes < 1) {
        throw new Error('The export byte cap must be a positive integer');
    }
    return limits;
};

interface ExportTableRead {
    body: string;
    rows: number;
    rejected: number;
    truncated: boolean;
    pages: number;
}

/**
 * Reads one table page by page. The JSONL body is assembled per page and the
 * byte budget is checked before each page is appended, so neither the table
 * nor the export is ever materialised unbounded.
 */
const readExportTable = async (
    db: TenantExportDataAccess,
    plan: ExportTablePlan,
    tenantId: string,
    limits: ExportLimits,
    budget: { remainingBytes: number },
): Promise<ExportTableRead> => {
    let cursor: string | null = null;
    let body = '';
    let rows = 0;
    let rejected = 0;
    let truncated = false;
    let pages = 0;
    let scanned = 0;
    for (;;) {
        const sql: string = cursor === null ? plan.sql : buildExportPageSql(plan, true);
        const fetched: Array<Record<string, unknown>> = await db.query<Record<string, unknown>>(
            sql,
            exportPageParams(plan, tenantId, cursor, limits.pageSize),
        );
        pages += 1;
        const allowance = limits.maxRowsPerTable - scanned;
        const capped = fetched.length > allowance;
        const page = capped ? fetched.slice(0, Math.max(allowance, 0)) : fetched;
        scanned += page.length;
        const lines: string[] = [];
        for (const row of page) {
            const ownership = row[OWNERSHIP_COLUMN];
            if (ownership === EXPORT_OWNERSHIP_CONTRADICTION) {
                rejected += 1;
                continue;
            }
            if (ownership !== EXPORT_OWNERSHIP_OWNED) {
                // Fail closed: a row the statement did not classify cannot be
                // silently exported, and cannot be silently dropped either.
                throw new Error(`The export read returned an unclassified row for ${plan.table}`);
            }
            const { [OWNERSHIP_COLUMN]: _classification, ...record } = row;
            lines.push(JSON.stringify(record));
            rows += 1;
        }
        if (lines.length > 0) {
            const chunk = `${lines.join('\n')}\n`;
            const chunkBytes = Buffer.byteLength(chunk, 'utf8');
            if (chunkBytes > budget.remainingBytes) {
                truncated = true;
                break;
            }
            budget.remainingBytes -= chunkBytes;
            body += chunk;
        }
        if (capped) {
            truncated = true;
            break;
        }
        if (fetched.length < limits.pageSize) break;
        const last: Record<string, unknown> | undefined = fetched[fetched.length - 1];
        const lastId: unknown = last?.id;
        if (typeof lastId !== 'string' || lastId.length === 0) {
            throw new Error(`The export read cannot page ${plan.table}: the row has no string id`);
        }
        cursor = lastId;
    }
    return { body, rows, rejected, truncated, pages };
};

const countProbe = async (
    db: TenantExportDataAccess,
    probe: ExportCountProbe,
    tenantId: string,
): Promise<{ provableRows: number | null; failure: string | null }> => {
    try {
        const rows = await db.query<{ n: number | string }>(probe.sql, [tenantId]);
        const value = rows[0]?.n;
        if (value === undefined || value === null) return { provableRows: null, failure: null };
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0
            ? { provableRows: parsed, failure: null }
            : { provableRows: null, failure: `unexpected count for ${probe.table}` };
    } catch (error) {
        // The omission is declared either way; a failed probe only removes the
        // lower bound, and that is recorded rather than swallowed.
        return { provableRows: null, failure: `${probe.table}: ${errorMessage(error).slice(0, 200)}` };
    }
};

const buildOmittedCoverage = async (
    db: TenantExportDataAccess,
    tenantId: string,
): Promise<{ omitted: ExportOmittedTable[]; omittedChildren: ExportOmittedChild[]; probeFailures: string[] }> => {
    const probeFailures: string[] = [];
    const probed = new Map<string, { provableRows: number | null; evidence: string }>();
    for (const probe of EXPORT_OMITTED_PROBES) {
        const result = await countProbe(db, probe, tenantId);
        if (result.failure !== null) probeFailures.push(result.failure);
        probed.set(probe.table, { provableRows: result.provableRows, evidence: probe.evidence });
    }
    const omitted: ExportOmittedTable[] = [];
    for (const group of EXPORT_OMITTED_GROUPS) {
        for (const table of group.tables) {
            const proof = probed.get(table);
            omitted.push({
                table,
                category: group.category,
                reason: group.reason,
                provable_rows: proof?.provableRows ?? null,
                evidence: proof?.evidence ?? null,
            });
        }
    }
    const omittedChildren: ExportOmittedChild[] = [];
    for (const probe of EXPORT_OMITTED_CHILD_PROBES) {
        const result = await countProbe(db, probe, tenantId);
        if (result.failure !== null) probeFailures.push(result.failure);
        omittedChildren.push({
            table: probe.table,
            evidence: probe.evidence,
            provable_rows: result.provableRows,
        });
    }
    return { omitted, omittedChildren, probeFailures };
};

export const processTenantExport = async (
    deps: TenantExportDeps,
    exportId: string,
): Promise<ExportManifest> => {
    const now = deps.now ?? Date.now;
    const limits = resolveLimits(deps.limits);
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status FROM tenant_data_exports WHERE id = ? LIMIT 1`,
        [exportId],
    );
    if (!job) throw new Error('The export job does not exist');
    if (job.status !== 'pending') throw new Error('The export job is not pending');
    const tenantId = job.tenant_id;
    const startedAt = new Date(now()).toISOString();
    const tables: ExportTableManifest[] = [];
    const included: ExportTableCoverage[] = [];
    const rejected: ExportCoverage['rejected'] = [];
    const budget = { remainingBytes: limits.maxTotalBytes };
    let totalRows = 0;
    let totalBytes = 0;
    let budgetExhausted = false;
    const skipped: string[] = [];
    try {
        for (const plan of EXPORT_TABLE_PLAN) {
            if (budgetExhausted) {
                // The byte budget is a hard bound: a table that was not read is
                // reported as omitted, never as an included empty table.
                skipped.push(plan.table);
                continue;
            }
            const read = await readExportTable(deps.db, plan, tenantId, limits, budget);
            const bytes = Buffer.byteLength(read.body, 'utf8');
            const key = `${EXPORT_STORAGE_PREFIX}/${tenantId}/${exportId}/${plan.table}.jsonl`;
            await deps.storage.write(key, read.body);
            tables.push({ table: plan.table, rows: read.rows, bytes, checksum: sha256Hex(read.body) });
            included.push({
                table: plan.table,
                rows: read.rows,
                basis: plan.basis,
                parent: plan.parent,
                authorities: plan.authorities.map((authority) => authority.source),
                rejected_contradictions: read.rejected,
                truncated: read.truncated,
                pages: read.pages,
            });
            if (read.rejected > 0) {
                rejected.push({
                    table: plan.table,
                    rows: read.rejected,
                    reason: 'the row claimed this tenant while another ownership authority resolved to a different tenant; it is rejected rather than assigned to one side',
                });
            }
            totalRows += read.rows;
            totalBytes += bytes;
            if (read.truncated && budget.remainingBytes <= 0) budgetExhausted = true;
        }
        const omittedCoverage = await buildOmittedCoverage(deps.db, tenantId);
        for (const table of skipped) {
            omittedCoverage.omitted.push({
                table,
                category: 'budget_exhausted',
                reason: 'not read: the export byte budget was exhausted by earlier tables',
                provable_rows: null,
                evidence: null,
            });
        }
        const truncatedTables = included.filter((entry) => entry.truncated).map((entry) => entry.table);
        const incomplete = truncatedTables.length > 0 || skipped.length > 0 || rejected.length > 0;
        const coverage: ExportCoverage = {
            scope: EXPORT_COVERAGE_SCOPE,
            included,
            omitted: omittedCoverage.omitted,
            omitted_children: omittedCoverage.omittedChildren,
            rejected,
            limitations: [...EXPORT_COVERAGE_LIMITATIONS, ...omittedCoverage.probeFailures.map((failure) => `omitted-row probe failed: ${failure}`)],
            complete: false,
            incomplete,
        };
        const manifest: ExportManifest = {
            version: EXPORT_MANIFEST_VERSION,
            tenant_id: tenantId,
            started_at: startedAt,
            completed_at: new Date(now()).toISOString(),
            tables,
            total_rows: totalRows,
            total_bytes: totalBytes,
            excluded: [...EXPORT_EXCLUSIONS],
            coverage,
            incomplete,
        };
        const manifestKey = `${EXPORT_STORAGE_PREFIX}/${tenantId}/${exportId}/manifest.json`;
        await deps.storage.write(manifestKey, JSON.stringify(manifest));
        const expiresAt = new Date(now() + EXPORT_DOWNLOAD_WINDOW_SECONDS * 1000);
        let transitioned = false;
        try {
            await inTransaction(deps.db, async (db) => {
                const updated = await db.execute(
                    `UPDATE tenant_data_exports
                     SET status = 'completed', storage_key = ?, file_size = ?, manifest = ?,
                         expires_at = ?, completed_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND status = 'pending' AND tenant_id = ?`,
                    [manifestKey, totalBytes, JSON.stringify(manifest), expiresAt, exportId, tenantId],
                );
                if ((updated.affectedRows ?? 0) === 0) {
                    throw new Error('The export job is no longer pending');
                }
                transitioned = true;
                await deps.audit({
                    actorUserId: null,
                    tenantId,
                    action: 'tenant_export.completed',
                    resourceType: 'tenant_data_exports',
                    resourceId: exportId,
                    newValue: { tables: tables.length, rows: totalRows, bytes: totalBytes, incomplete },
                    reason: 'Tenant data export completed',
                }, db);
            });
        } catch (error) {
            if (transitioned) {
                // The status write succeeded in this call but the audit did not
                // commit; demote the job so no unaudited export is downloadable.
                try {
                    await failJobAfterAuditFailure(
                        deps.db,
                        exportId,
                        tenantId,
                        `The export completion was not audited: ${errorMessage(error)}`,
                    );
                } catch (compensationError) {
                    throw new Error(
                        `The export completion was not audited (${errorMessage(error)}) and the job could not be marked failed (${errorMessage(compensationError)})`,
                    );
                }
            }
            throw error;
        }
        return manifest;
    } catch (error) {
        const message = errorMessage(error);
        await deps.db.execute(
            `UPDATE tenant_data_exports SET status = 'failed', error = ?
             WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
            [message.slice(0, 1000), exportId, tenantId],
        );
        await deps.audit({
            actorUserId: null,
            tenantId,
            action: 'tenant_export.failed',
            resourceType: 'tenant_data_exports',
            resourceId: exportId,
            newValue: { reason: message.slice(0, 1000) },
            reason: 'Tenant data export failed',
        });
        throw error;
    }
};

// ---------------------------------------------------------------------------
// Download tokens + downloads.
// ---------------------------------------------------------------------------

export type ExportTokenResult =
    | { ok: true; token: string; expiresAt: string }
    | { ok: false; status: number; error: string };

const loadCompletedJob = async (
    deps: TenantExportDeps,
    tenantId: string,
    exportId: string,
): Promise<TenantExportJobRow | null> => {
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status, storage_key, expires_at, token_hash
         FROM tenant_data_exports
         WHERE id = ? AND tenant_id = ? AND status = 'completed' LIMIT 1`,
        [exportId, tenantId],
    );
    return job ?? null;
};

export const issueExportDownloadToken = async (
    deps: TenantExportDeps,
    input: { tenantId: string; exportId: string; actorUserId: string },
): Promise<ExportTokenResult> => {
    if (!secretConfigured(deps.secret)) {
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    const now = deps.now ?? Date.now;
    const job = await loadCompletedJob(deps, input.tenantId, input.exportId);
    if (!job) {
        return { ok: false, status: 404, error: 'Export not found' };
    }
    const windowEnd = asTime(job.expires_at);
    if (windowEnd > 0 && windowEnd <= now()) {
        return { ok: false, status: 410, error: 'The export download window has expired' };
    }
    const tokenExpiresAt = Math.floor(now() / 1000) + EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS;
    const token = signExportToken(deps.secret, {
        v: 1,
        e: input.exportId,
        t: input.tenantId,
        x: tokenExpiresAt,
    });
    let rotated = false;
    try {
        await inTransaction(deps.db, async (db) => {
            const updated = await db.execute(
                `UPDATE tenant_data_exports SET token_hash = ?
                 WHERE id = ? AND tenant_id = ? AND status = 'completed'`,
                [sha256Hex(token), input.exportId, input.tenantId],
            );
            if ((updated.affectedRows ?? 0) === 0) {
                throw new ExportStateConflictError('The export is no longer available');
            }
            rotated = true;
            await deps.audit({
                actorUserId: input.actorUserId,
                tenantId: input.tenantId,
                action: 'tenant_export.download_issued',
                resourceType: 'tenant_data_exports',
                resourceId: input.exportId,
                newValue: { expires_at: new Date(tokenExpiresAt * 1000).toISOString() },
                reason: 'Tenant export download token issued',
            }, db);
        });
    } catch (error) {
        if (!rotated && error instanceof ExportStateConflictError) {
            return { ok: false, status: 409, error: 'The export is no longer available' };
        }
        throw error;
    }
    return { ok: true, token, expiresAt: new Date(tokenExpiresAt * 1000).toISOString() };
};

export type ExportDownloadVerification =
    | { ok: true; exportId: string; tenantId: string }
    | { ok: false; status: number; error: string };

export const verifyExportDownloadToken = async (
    deps: TenantExportDeps,
    input: { token: string; tenantId: string },
): Promise<ExportDownloadVerification> => {
    if (!secretConfigured(deps.secret)) {
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    const now = deps.now ?? Date.now;
    const payload = verifyExportTokenSignature(deps.secret as string, input.token);
    if (!payload) {
        return { ok: false, status: 403, error: 'The download token is invalid' };
    }
    if (payload.x * 1000 <= now()) {
        return { ok: false, status: 410, error: 'The download token has expired' };
    }
    if (payload.t !== input.tenantId) {
        return { ok: false, status: 403, error: 'The download token does not belong to this tenant' };
    }
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status, expires_at, token_hash
         FROM tenant_data_exports
         WHERE id = ? AND tenant_id = ? LIMIT 1`,
        [payload.e, payload.t],
    );
    if (!job || job.status !== 'completed') {
        return { ok: false, status: 403, error: 'The download token is invalid' };
    }
    const expiresAt = asTime(job.expires_at);
    if (expiresAt > 0 && expiresAt <= now()) {
        return { ok: false, status: 410, error: 'The export download window has expired' };
    }
    // Rotation: only the most recently issued token for this job verifies.
    // Older tokens are invalidated by the hash overwrite on re-issue.
    if (!job.token_hash || !timingSafeStringEqual(job.token_hash, sha256Hex(input.token))) {
        return { ok: false, status: 403, error: 'The download token is invalid' };
    }
    return { ok: true, exportId: payload.e, tenantId: payload.t };
};

export type ExportDownloadResult =
    | { ok: true; body: string; byteSize: number; manifest: ExportManifest | null }
    | { ok: false; status: number; error: string };

export const downloadTenantExport = async (
    deps: TenantExportDeps,
    input: { token: string; tenantId: string; exportId: string; actorUserId: string },
): Promise<ExportDownloadResult> => {
    const verification = await verifyExportDownloadToken(deps, {
        token: input.token,
        tenantId: input.tenantId,
    });
    if (!verification.ok) {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: input.exportId,
            reason: verification.error,
        });
        return { ok: false, status: verification.status, error: verification.error };
    }
    if (verification.exportId !== input.exportId) {
        // The signed identity must equal the id in the requested URL; a valid
        // token for another export of the same tenant cannot be replayed here.
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: verification.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: input.exportId,
            reason: 'The download token does not match the requested export',
        });
        return { ok: false, status: 403, error: 'The download token does not match the requested export' };
    }
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status, storage_key, file_size, manifest
         FROM tenant_data_exports
         WHERE id = ? AND tenant_id = ? AND status = 'completed' LIMIT 1`,
        [verification.exportId, verification.tenantId],
    );
    if (!job || !job.storage_key) {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: verification.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: verification.exportId,
            reason: 'The export file is no longer available',
        });
        return { ok: false, status: 410, error: 'The export file is no longer available' };
    }
    let body: string;
    try {
        body = await deps.storage.read(job.storage_key);
    } catch {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: verification.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: verification.exportId,
            reason: 'The export file could not be read',
        });
        return { ok: false, status: 410, error: 'The export file is no longer available' };
    }
    const manifest: ExportManifest | null = parseManifest(job.manifest);
    await deps.audit({
        actorUserId: input.actorUserId,
        tenantId: verification.tenantId,
        action: 'tenant_export.downloaded',
        resourceType: 'tenant_data_exports',
        resourceId: verification.exportId,
        newValue: { bytes: Buffer.byteLength(body, 'utf8') },
        reason: 'Tenant data export downloaded',
    });
    return { ok: true, body, byteSize: Buffer.byteLength(body, 'utf8'), manifest };
};

const parseManifest = (value: unknown): ExportManifest | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as ExportManifest;
        } catch {
            return null;
        }
    }
    if (typeof value === 'object') return value as ExportManifest;
    return null;
};
