import { Router, Request, Response, RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';
import {
    getResourceBranchDeps,
    principalFromAuthUser,
    resolveResourceBranchAccess,
    resourceBranchDenial,
    type ResourceBranchDeps,
} from '../security/resource-branch';
import {
    parseVideoReference,
    validateVideoBinding,
    VIDEO_BINDING_CODES,
} from '../security/video-access-policy';

// Configure multer for receipt image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads/receipts');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'receipt-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb(new Error('يُسمح فقط بالصور (jpeg, jpg, png, gif, webp)'));
    }
});

// ===============================
// ACCESS POLICY
// ===============================

/**
 * Platform capability key for cross-tenant premium-lecture administration.
 * Verified against the migrations: admin_role_permissions seeds no
 * premium.* key, so the verified-active-super_admin check is the effective
 * policy today; deny-by-default for every non-owner identity.
 */
const PLATFORM_ADMIN_PERMISSION = 'premium.manage';

/** Instructor/tenant ownership of a lecture (group instructor owns the tenant). */
const LECTURE_OWNERSHIP_SQL = `
    SELECT pl.id
    FROM premium_lectures pl
    INNER JOIN \`groups\` g ON g.id = pl.group_id
    INNER JOIN tenants t ON t.owner_user_id = g.instructor_id
    WHERE pl.id = ? AND t.owner_user_id = ? AND t.status = 'active'
`;

/** Instructor/tenant ownership of a student (through the student's group). */
const STUDENT_OWNERSHIP_SQL = `
    SELECT s.id
    FROM students s
    INNER JOIN \`groups\` g ON g.id = s.group_id
    INNER JOIN tenants t ON t.owner_user_id = g.instructor_id
    WHERE s.id = ? AND t.owner_user_id = ? AND t.status = 'active'
`;

/** Scopes a premium_lectures row (aliased `pl`) to the calling instructor's tenant. */
const TEACHER_LECTURE_SCOPE_SQL = `
    EXISTS (
        SELECT 1
        FROM \`groups\` gg
        INNER JOIN tenants tt ON tt.owner_user_id = gg.instructor_id
        WHERE gg.id = pl.group_id AND tt.owner_user_id = ? AND tt.status = 'active'
    )
`;

interface PaymentRow {
    id: string;
    student_id: string;
    premium_lecture_id: string;
    status: 'pending' | 'approved' | 'rejected';
}

interface LectureRow {
    id: string;
    title: string;
    is_published: number;
}

interface StudentRow {
    id: string;
    grade_id: string | null;
    group_id: string | null;
}

export interface PremiumLectureRouterDeps {
    query: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
    queryOne: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
    execute: (sql: string, params?: any[]) => Promise<{ insertId: number; affectedRows: number }>;
    authenticate: RequestHandler;
    /**
     * Run `work` inside a single database transaction. The payment-approve
     * flow's status flip and access grant commit or roll back together; the
     * guarded flip (WHERE status='pending') means exactly one concurrent
     * approval can win.
     */
    withTransaction?: <T>(
        work: (tx: Pick<PremiumLectureRouterDeps, 'query' | 'queryOne' | 'execute'>) => Promise<T>,
    ) => Promise<T>;
    /**
     * Verified platform capability resolved server-side (active super_admin
     * or a seeded permission key). It never consults a JWT role claim, so an
     * arbitrary admin-role token cannot approve payments or read other
     * tenants' lectures.
     */
    hasPlatformCapability: (userId: string, permission: string) => Promise<boolean>;
    /** Resource-derived branch authority; defaults to the production SQL deps. */
    branchAccess?: ResourceBranchDeps;
}

/**
 * Money crosses the API as integer minor units or a decimal string with at
 * most two fraction digits; MySQL DECIMAL(10,2) does the arithmetic. Native
 * floats are accepted only when decimal-safe (finite, >= 0, <= 2dp).
 */
const DECIMAL_RE = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
export const toDecimalMoney = (value: unknown): string | null => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return DECIMAL_RE.test(trimmed) ? trimmed : null;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) return null;
        const rounded = Math.round(value * 100) / 100;
        if (Math.abs(value - rounded) > 1e-9) return null;
        return rounded.toFixed(2);
    }
    return null;
};

/**
 * Build the premium-lectures router over injected dependencies. Production
 * wiring (default export) passes the lazily loaded pool, the production auth
 * middleware, and the verified platform-capability check; hermetic tests pass
 * isolated fixtures and exercise the real handlers without a database.
 */
export const createPremiumLectureRouter = (deps: PremiumLectureRouterDeps) => {
    const router = Router();

    const withTransaction = deps.withTransaction ?? (async <T>(work: (tx: Pick<PremiumLectureRouterDeps, 'query' | 'queryOne' | 'execute'>) => Promise<T>): Promise<T> =>
        work({ query: deps.query, queryOne: deps.queryOne, execute: deps.execute }));

    const hasPlatformAdmin = async (userId: string): Promise<boolean> =>
        deps.hasPlatformCapability(userId, PLATFORM_ADMIN_PERMISSION);

    const ownsLecture = async (lectureId: string, userId: string): Promise<boolean> =>
        !!(await deps.queryOne(LECTURE_OWNERSHIP_SQL, [lectureId, userId]));

    /** Owner instructor of the lecture, or a verified platform admin. */
    const canManageLecture = async (
        user: NonNullable<AuthRequest['user']>,
        lectureId: string,
    ): Promise<boolean> => {
        if (await hasPlatformAdmin(user.id)) return true;
        return ownsLecture(lectureId, user.id);
    };

    /** The student themself, their owning instructor, or a platform admin. */
    const canViewStudent = async (
        user: NonNullable<AuthRequest['user']>,
        studentId: string,
    ): Promise<boolean> => {
        if (await hasPlatformAdmin(user.id)) return true;
        if (user.studentEnrollmentId === studentId) return true;
        return !!(await deps.queryOne(STUDENT_OWNERSHIP_SQL, [studentId, user.id]));
    };

    const isStudentOnly = (user: NonNullable<AuthRequest['user']>): boolean =>
        user.role === 'student' && !user.instructorId && !user.tenantId;

    /**
     * Resource-derived branch check for a premium lecture. Its branch comes
     * from premium_lectures.group_id -> groups; the caller selector is never
     * authority.
     */
    const enforcePremiumBranch = async (
        req: AuthRequest,
        res: Response,
        lectureId: string,
        requestedBranchId?: unknown,
    ): Promise<boolean> => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return false;
        }
        const decision = await resolveResourceBranchAccess(
            deps.branchAccess ?? getResourceBranchDeps(),
            principalFromAuthUser(req.user),
            { resourceType: 'premium_lecture', resourceId: lectureId, requestedBranchId },
        );
        if (decision.kind !== 'allowed') {
            const denial = resourceBranchDenial(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };

    /** Validate the target group's branch before create/move. */
    const validatePremiumGroupBranch = async (
        user: NonNullable<AuthRequest['user']>,
        groupId: unknown,
    ): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
        if (groupId === undefined || groupId === null || groupId === '') return { ok: true };
        if (typeof groupId !== 'string') return { ok: false, status: 400, error: 'Invalid group' };
        const group = await deps.queryOne<{ id: string; branch_id: string | null; branch_scope: string | null }>(
            'SELECT id, branch_id, branch_scope FROM `groups` WHERE id = ?', [groupId],
        );
        if (!group) return { ok: false, status: 404, error: 'Group not found' };
        if (group.branch_scope !== 'branch') return { ok: true };
        if (!group.branch_id) return { ok: false, status: 403, error: 'Branch context is ambiguous' };
        const tenantId = user.tenantId;
        if (!tenantId) return { ok: false, status: 403, error: 'Workspace access required' };
        const branch = await deps.queryOne<{ tenant_id: string; status: string }>(
            'SELECT tenant_id, status FROM branches WHERE id = ?', [group.branch_id],
        );
        if (!branch || branch.tenant_id !== tenantId || branch.status !== 'active') {
            return { ok: false, status: 403, error: 'Branch is outside your teaching scope' };
        }
        const owner = await deps.queryOne<{ id: string }>(
            "SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active'",
            [tenantId, user.id],
        );
        if (!owner) {
            const membership = await deps.queryOne<{ id: string }>(
                "SELECT id FROM branch_memberships WHERE branch_id = ? AND user_id = ? AND status = 'active'",
                [group.branch_id, user.id],
            );
            if (!membership) return { ok: false, status: 403, error: 'Branch membership required' };
        }
        return { ok: true };
    };

    // ===============================
    // CANONICAL VIDEO BINDING (same contract as lectures.ts / materials.ts)
    // ===============================

    type BindingReader = Pick<PremiumLectureRouterDeps, 'query' | 'queryOne' | 'execute'>;
    type ProofReader = Pick<PremiumLectureRouterDeps, 'query' | 'queryOne'>;

    /** Rows read by the read-time binding proof (no new columns, no new table). */
    interface VideoTenantRow { id: string; tenant_id: string | null; course_id: string | null }
    interface GroupCourseRow { id: string; course_id: string | null }
    interface CourseTenantRow { id: string; tenant_id: string | null }

    const sqlPlaceholders = (count: number): string => new Array(count).fill('?').join(',');

    const uniqueIds = (values: Array<string | null>): string[] => {
        const seen = new Set<string>();
        for (const value of values) if (value != null && value.length > 0) seen.add(value);
        return [...seen];
    };

    /**
     * Prove, from server rows only, that a STORED `video://<id>` still
     * belongs to the lecture's own destination workspace. Canonical syntax is
     * not authority: a row written before the binding contract (or written by
     * another tenant) carries a reference whose tenant/ownership was never
     * established, so it is not echoed. The proof re-applies the write
     * contract's tenant rule with read-only SQL — the asset must exist, its
     * declared tenant(s) must agree and be provable, and the destination
     * tenant derived from `premium_lectures.group_id -> groups.course_id ->
     * courses.tenant_id` must equal it exactly. Nothing is rewritten and no
     * readiness/entitlement state is invented; a row that cannot be proven is
     * simply projected with `video_url: null` while the record itself is
     * returned unchanged.
     *
     * The proof is deliberately stateless (there is no "verified" column):
     * an unproven row therefore stays withheld on every read until a write
     * re-binds it through `validateVideoBinding`. Actor authority and
     * single-parent uniqueness are NOT decided here — playback authority
     * remains the secure-video entitlement path's job.
     */
    const proveStoredVideoReferences = async (
        reader: ProofReader,
        rows: any[],
    ): Promise<Map<string, string | null>> => {
        const proven = new Map<string, string | null>();
        const candidates: Array<{ rowId: string; videoUrl: string; videoId: string; groupId: string | null }> = [];
        for (const row of rows) {
            if (!row || typeof row !== 'object' || row.id == null) continue;
            const rowId = String(row.id);
            proven.set(rowId, null); // fail closed until proven otherwise
            if (typeof row.video_url !== 'string') continue;
            const parsed = parseVideoReference(row.video_url);
            if (!parsed.ok) continue;
            candidates.push({
                rowId,
                videoUrl: parsed.videoUrl,
                videoId: parsed.videoId,
                groupId: row.group_id == null ? null : String(row.group_id),
            });
        }
        if (candidates.length === 0) return proven;

        const videoIds = uniqueIds(candidates.map((candidate) => candidate.videoId));
        const videos: VideoTenantRow[] = videoIds.length === 0 ? [] : await reader.query<VideoTenantRow>(
            `SELECT id, tenant_id, course_id FROM videos WHERE id IN (${sqlPlaceholders(videoIds.length)})`,
            videoIds,
        );
        const videoById = new Map<string, VideoTenantRow>(
            videos.map((video): [string, VideoTenantRow] => [String(video.id), video]),
        );

        const groupIds = uniqueIds(candidates.map((candidate) => candidate.groupId));
        const groups: GroupCourseRow[] = groupIds.length === 0 ? [] : await reader.query<GroupCourseRow>(
            `SELECT id, course_id FROM \`groups\` WHERE id IN (${sqlPlaceholders(groupIds.length)})`,
            groupIds,
        );
        const groupCourseById = new Map<string, string | null>(groups.map((group): [string, string | null] => [
            String(group.id),
            group.course_id == null ? null : String(group.course_id),
        ]));

        const courseIds = uniqueIds([
            ...videos.map((video) => (video.course_id == null ? null : String(video.course_id))),
            ...groups.map((group) => (group.course_id == null ? null : String(group.course_id))),
        ]);
        const courses: CourseTenantRow[] = courseIds.length === 0 ? [] : await reader.query<CourseTenantRow>(
            `SELECT id, tenant_id FROM courses WHERE id IN (${sqlPlaceholders(courseIds.length)})`,
            courseIds,
        );
        const courseTenantById = new Map<string, string | null>(courses.map((course): [string, string | null] => [
            String(course.id),
            course.tenant_id == null ? null : String(course.tenant_id),
        ]));

        for (const candidate of candidates) {
            const video = videoById.get(candidate.videoId);
            if (!video) continue;
            const directTenant = video.tenant_id == null ? null : String(video.tenant_id);
            const courseTenant = video.course_id == null
                ? null
                : courseTenantById.get(String(video.course_id)) ?? null;
            // Two declared authorities that disagree prove no tenant at all.
            if (directTenant && courseTenant && directTenant !== courseTenant) continue;
            const videoTenant = directTenant ?? courseTenant;
            if (!videoTenant) continue;
            if (!candidate.groupId) continue;
            const destinationCourseId = groupCourseById.get(candidate.groupId) ?? null;
            if (!destinationCourseId) continue;
            const destinationTenant = courseTenantById.get(destinationCourseId) ?? null;
            if (!destinationTenant || destinationTenant !== videoTenant) continue;
            proven.set(candidate.rowId, candidate.videoUrl);
        }
        return proven;
    };

    /**
     * Projection used by every response that carries a premium-lecture row.
     * The caller passes the PROVEN reference for that row (or null); nothing
     * is read from the row's own `video_url` here, so a stored value can never
     * be echoed by accident. Nothing is rewritten in the database: the row
     * keeps its legacy value and the record is returned in full.
     */
    const projectLecture = <T>(row: T, provenVideoUrl: string | null): T => {
        if (!row || typeof row !== 'object') return row;
        return { ...(row as object), video_url: provenVideoUrl } as T;
    };

    /** Prove and project a list of rows (no N+1: three batched reads). */
    const projectLectures = async (rows: any[]): Promise<any[]> => {
        const list = Array.isArray(rows) ? rows : [];
        const proven = await proveStoredVideoReferences(deps, list);
        return list.map((row) => projectLecture(
            row,
            row && typeof row === 'object' && row.id != null ? proven.get(String(row.id)) ?? null : null,
        ));
    };

    /** Prove and project a single row (detail / create / update echo). */
    const projectLectureById = async <T>(row: T): Promise<T> => {
        if (!row || typeof row !== 'object') return row;
        const id = (row as { id?: unknown }).id;
        if (id == null) return projectLecture(row, null);
        const proven = await proveStoredVideoReferences(deps, [row]);
        return projectLecture(row, proven.get(String(id)) ?? null);
    };

    /**
     * Server-derived destination of a premium lecture. `premium_lectures` has
     * no course column, so the destination course is read from its own
     * `group_id` -> `groups.course_id`, and the course's `tenant_id` is the
     * destination tenant. A lecture without a group, a group without a course,
     * or a course without a tenant has no provable destination and fails
     * closed with the policy's own TENANT_UNPROVEN mapping.
     */
    const resolvePremiumDestinationCourse = async (
        reader: Pick<PremiumLectureRouterDeps, 'queryOne'>,
        groupId: string | null,
    ): Promise<{ ok: true; courseId: string } | { ok: false; status: number; code: string; error: string }> => {
        const unproven = {
            ok: false as const,
            status: 403,
            code: VIDEO_BINDING_CODES.TENANT_UNPROVEN as string,
            error: 'Destination workspace could not be verified',
        };
        if (!groupId) return unproven;
        const group = await reader.queryOne<{ course_id: string | null }>(
            'SELECT course_id FROM `groups` WHERE id = ?', [groupId],
        );
        if (!group || group.course_id == null || String(group.course_id).length === 0) return unproven;
        const course = await reader.queryOne<{ tenant_id: string | null }>(
            'SELECT tenant_id FROM courses WHERE id = ?', [group.course_id],
        );
        if (!course || course.tenant_id == null || String(course.tenant_id).length === 0) return unproven;
        return { ok: true, courseId: String(group.course_id) };
    };

    /**
     * Bind a canonical `video://<id>` to a premium lecture under the same
     * contract as lectures/materials: the video must exist, be in the caller's
     * server-selected tenant, be authorized by the playback policy, sit in the
     * same tenant as the lecture's destination course, and not be bound
     * elsewhere. The premium table is an additional parent the shared helper
     * does not know about, so the single-parent probe is extended to it here.
     * Must run inside the write transaction (the video row is locked).
     */
    const bindPremiumVideo = async (
        reader: BindingReader,
        req: AuthRequest,
        videoUrl: string,
        selfId: string,
        groupId: string | null,
    ) => {
        const destination = await resolvePremiumDestinationCourse(reader, groupId);
        if (!destination.ok) return destination;

        const binding = await validateVideoBinding({
            reader,
            videoUrl,
            actorUserId: req.user?.id ?? '',
            actorTenantId: req.user?.tenantId,
            actorStudentEnrollmentId: req.user?.studentEnrollmentId,
            selfId,
            target: 'lecture',
            targetCourseId: destination.courseId,
            hasPlatformCapability: hasPlatformAdmin,
        });
        if (!binding.ok) return binding;

        const conflict = await reader.queryOne<{ id: string }>(
            'SELECT id FROM premium_lectures WHERE video_url = ? AND id <> ? ORDER BY id ASC LIMIT 1',
            [binding.videoUrl, selfId],
        );
        if (conflict) {
            return {
                ok: false as const,
                status: 409,
                code: VIDEO_BINDING_CODES.ALREADY_BOUND as string,
                error: 'This video is already linked to another lesson or material',
            };
        }
        return binding;
    };

    // ===============================
    // PAYMENT REQUESTS (before /:id routes)
    // ===============================

    const paymentSelect = `
        SELECT
            plp.*,
            pl.title as lecture_title,
            pl.price as lecture_price,
            s.name as student_name,
            s.phone as student_phone,
            gr.name as grade_name,
            g.name as group_name
        FROM premium_lecture_payments plp
        JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
        JOIN students s ON plp.student_id = s.id
        LEFT JOIN grades gr ON s.grade_id = gr.id
        LEFT JOIN \`groups\` g ON s.group_id = g.id
    `;

    // Get all pending payment requests (teacher: own lectures only; platform admin: all)
    router.get('/payments/pending', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user!;
            let sql = `${paymentSelect} WHERE plp.status = 'pending'`;
            const params: any[] = [];
            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لعرض طلبات الدفع' });
                }
                sql += ` AND ${TEACHER_LECTURE_SCOPE_SQL}`;
                params.push(user.id);
            }
            sql += ' ORDER BY plp.created_at ASC';

            const payments = await deps.query(sql, params);
            res.json(payments || []);
        } catch (error) {
            console.error('Get pending payments error:', error);
            res.status(500).json({ error: 'فشل في جلب طلبات الدفع المعلقة' });
        }
    });

    // Get student's payment requests (self, owning instructor, or platform admin)
    router.get('/payments/student/:studentId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;
            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية لعرض طلبات هذا الطالب' });
            }

            const payments = await deps.query(`
                SELECT
                    plp.*,
                    pl.title as lecture_title,
                    pl.price as lecture_price
                FROM premium_lecture_payments plp
                JOIN premium_lectures pl ON plp.premium_lecture_id = pl.id
                WHERE plp.student_id = ?
                ORDER BY plp.created_at DESC
            `, [studentId]);
            res.json(payments || []);
        } catch (error) {
            console.error('Get student payments error:', error);
            res.status(500).json({ error: 'فشل في جلب طلبات الدفع' });
        }
    });

    // Get all payment requests (teacher: own lectures only; platform admin: all)
    router.get('/payments', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user!;
            const { status, lecture_id } = req.query;

            let sql = `${paymentSelect} WHERE 1=1`;
            const params: any[] = [];

            if (status && typeof status === 'string') {
                sql += ' AND plp.status = ?';
                params.push(status);
            }

            if (lecture_id && typeof lecture_id === 'string') {
                sql += ' AND plp.premium_lecture_id = ?';
                params.push(lecture_id);
            }

            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لعرض طلبات الدفع' });
                }
                sql += ` AND ${TEACHER_LECTURE_SCOPE_SQL}`;
                params.push(user.id);
            }

            sql += ' ORDER BY plp.created_at DESC';

            const payments = await deps.query(sql, params);
            res.json(payments || []);
        } catch (error) {
            console.error('Get all payments error:', error);
            res.status(500).json({ error: 'فشل في جلب طلبات الدفع' });
        }
    });

    // Submit payment request with receipt image (student; lecture must be in the caller's tenant)
    router.post('/payments', deps.authenticate, upload.single('receipt'), async (req: AuthRequest, res: Response) => {
        try {
            const { premium_lecture_id, amount, notes } = req.body;
            const student_id = req.user!.studentEnrollmentId;
            const tenantId = req.user!.tenantId;

            if (!student_id || !tenantId || !premium_lecture_id || !req.file) {
                return res.status(400).json({ error: 'معرف الطالب والحصة وصورة الإيصال مطلوبين' });
            }

            const lecture = await deps.queryOne(
                `SELECT pl.id FROM premium_lectures pl
                 INNER JOIN \`groups\` g ON g.id=pl.group_id
                 INNER JOIN tenants t ON t.owner_user_id=g.instructor_id
                 WHERE pl.id=? AND t.id=? AND t.status='active'`, [premium_lecture_id, tenantId]
            );
            if (!lecture) return res.status(404).json({ error: 'الحصة غير موجودة في مساحتك' });
            if (!(await enforcePremiumBranch(req, res, premium_lecture_id))) return;

            if (amount !== undefined && amount !== null && amount !== '' && toDecimalMoney(amount) === null) {
                return res.status(400).json({ error: 'المبلغ يجب أن يكون موجبًا وبدقتين عشريتين كحد أقصى' });
            }

            // Check if student already has access or pending payment
            const existingPayment = await deps.queryOne(`
                SELECT id, status FROM premium_lecture_payments
                WHERE student_id = ? AND premium_lecture_id = ? AND status IN ('pending', 'approved')
            `, [student_id, premium_lecture_id]);

            if (existingPayment) {
                if (existingPayment.status === 'approved') {
                    return res.status(400).json({ error: 'لديك وصول مسبق لهذه الحصة' });
                }
                return res.status(400).json({ error: 'لديك طلب دفع قيد المراجعة' });
            }

            const id = uuidv4();
            const fileId = uuidv4();
            const receiptUrl = `/api/files/${fileId}/download`;
            await deps.execute(
                `INSERT INTO tenant_media_files (id,tenant_id,uploaded_by,storage_path,original_name,mime_type,byte_size)
                 VALUES (?,?,?,?,?,?,?)`,
                [fileId, tenantId, req.user!.id, path.relative(process.cwd(), req.file.path), req.file.originalname, req.file.mimetype, req.file.size]
            );

            await deps.execute(`
                INSERT INTO premium_lecture_payments (id, student_id, premium_lecture_id, receipt_image_url, amount, notes, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending')
            `, [id, student_id, premium_lecture_id, receiptUrl, toDecimalMoney(amount) ?? '0.00', notes || null]);

            const newPayment = await deps.queryOne('SELECT * FROM premium_lecture_payments WHERE id = ?', [id]);
            res.status(201).json(newPayment);
        } catch (error) {
            console.error('Submit payment error:', error);
            res.status(500).json({ error: 'فشل في إرسال طلب الدفع' });
        }
    });

    // Approve payment request (owning instructor or verified platform admin; reviewed_by is the verified identity)
    // Transactional + idempotent: the payment row is locked (FOR UPDATE),
    // the status flips conditionally (WHERE status='pending') so exactly one
    // concurrent approval wins, and the access grant commits in the same
    // transaction. A retry of an approved payment returns 400 and grants
    // nothing twice (unique_student_lecture + INSERT IGNORE).
    router.post('/payments/:id/approve', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;

            const outcome = await withTransaction(async (tx) => {
                const payment = await tx.queryOne<PaymentRow>('SELECT * FROM premium_lecture_payments WHERE id = ? FOR UPDATE', [id]);

                if (!payment) {
                    return { status: 404 as const, body: { error: 'طلب الدفع غير موجود' } };
                }

                if (payment.status !== 'pending') {
                    return { status: 400 as const, body: { error: 'تم مراجعة هذا الطلب مسبقاً' } };
                }

                if (!(await canManageLecture(req.user!, payment.premium_lecture_id))) {
                    return { status: 403 as const, body: { error: 'ليست لديك صلاحية على هذه الحصة' } };
                }
                const branchDecision = await resolveResourceBranchAccess(
                    deps.branchAccess ?? getResourceBranchDeps(),
                    principalFromAuthUser(req.user!),
                    { resourceType: 'premium_lecture', resourceId: payment.premium_lecture_id },
                );
                if (branchDecision.kind !== 'allowed') {
                    return { status: 403 as const, body: { error: 'Forbidden' } };
                }

                // Guarded flip FIRST: the loser of a concurrent approval
                // affects zero rows and grants no access.
                const transition = await tx.execute(`
                    UPDATE premium_lecture_payments
                    SET status = 'approved', reviewed_by = ?, reviewed_at = NOW()
                    WHERE id = ? AND status = 'pending'
                `, [req.user!.id, id]);
                if (transition.affectedRows === 0) {
                    return { status: 400 as const, body: { error: 'تم مراجعة هذا الطلب مسبقاً' } };
                }

                // Grant access to the lecture (idempotent: the unique
                // (student_id, premium_lecture_id) key dedupes retries).
                const accessId = uuidv4();
                await tx.execute(`
                    INSERT IGNORE INTO premium_lecture_access (id, student_id, premium_lecture_id, payment_id)
                    VALUES (?, ?, ?, ?)
                `, [accessId, payment.student_id, payment.premium_lecture_id, id]);
                return { status: 200 as const, body: { success: true, message: 'تمت الموافقة على طلب الدفع وتم منح الوصول للحصة' } };
            });
            res.status(outcome.status === 200 ? 200 : outcome.status).json(outcome.body);
        } catch (error) {
            console.error('Approve payment error:', error);
            res.status(500).json({ error: 'فشل في الموافقة على طلب الدفع' });
        }
    });

    // Reject payment request (owning instructor or verified platform admin; reviewed_by is the verified identity)
    // Guarded transition: a concurrent rejection already consumed the flip if
    // this affects zero rows, and the retry returns 400 without side effects.
    router.post('/payments/:id/reject', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const { rejection_reason } = req.body;

            const payment = await deps.queryOne<PaymentRow>('SELECT * FROM premium_lecture_payments WHERE id = ?', [id]);

            if (!payment) {
                return res.status(404).json({ error: 'طلب الدفع غير موجود' });
            }

            if (payment.status !== 'pending') {
                return res.status(400).json({ error: 'تم مراجعة هذا الطلب مسبقاً' });
            }

            if (!(await canManageLecture(req.user!, payment.premium_lecture_id))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية على هذه الحصة' });
            }
            if (!(await enforcePremiumBranch(req, res, payment.premium_lecture_id))) return;

            const transition = await deps.execute(`
                UPDATE premium_lecture_payments
                SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ?
                WHERE id = ? AND status = 'pending'
            `, [req.user!.id, rejection_reason || null, id]);
            if (transition.affectedRows === 0) {
                return res.status(400).json({ error: 'تم مراجعة هذا الطلب مسبقاً' });
            }

            res.json({ success: true, message: 'تم رفض طلب الدفع' });
        } catch (error) {
            console.error('Reject payment error:', error);
            res.status(500).json({ error: 'فشل في رفض طلب الدفع' });
        }
    });

    // ===============================
    // STUDENT PREMIUM LECTURES
    // ===============================

    // Get available premium lectures for a student (self, owning instructor, or platform admin)
    router.get('/student/:studentId/available', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;

            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية لعرض حصص هذا الطالب' });
            }

            const student = await deps.queryOne<StudentRow>('SELECT id, grade_id, group_id FROM students WHERE id = ?', [studentId]);

            if (!student) {
                return res.status(404).json({ error: 'الطالب غير موجود' });
            }

            const lectures = await deps.query(`
                SELECT
                    pl.*,
                    gr.name as grade_name,
                    g.name as group_name,
                    pla.id as access_id,
                    plp.id as payment_id,
                    plp.status as payment_status
                FROM premium_lectures pl
                LEFT JOIN grades gr ON pl.grade_id = gr.id
                LEFT JOIN \`groups\` g ON pl.group_id = g.id
                LEFT JOIN premium_lecture_access pla ON pla.premium_lecture_id = pl.id AND pla.student_id = ?
                LEFT JOIN premium_lecture_payments plp ON plp.premium_lecture_id = pl.id AND plp.student_id = ?
                    AND plp.status IN ('pending', 'approved')
                WHERE pl.is_published = TRUE
                AND (pl.grade_id IS NULL OR pl.grade_id = ?)
                AND (pl.group_id IS NULL OR pl.group_id = ?)
                ORDER BY pl.created_at DESC
            `, [studentId, studentId, student.grade_id, student.group_id]);
            // A catalogue row carries the binding only when this student was
            // actually granted access AND the stored reference is proven to
            // belong to the lecture's own destination workspace; otherwise the
            // reference is withheld (the catalogue row itself is unchanged).
            const visibleRows = (lectures || []).map((row: any) =>
                row?.access_id ? row : { ...row, video_url: null });
            res.json(await projectLectures(visibleRows));
        } catch (error) {
            console.error('Get student premium lectures error:', error);
            res.status(500).json({ error: 'فشل في جلب الحصص المدفوعة' });
        }
    });

    // Get student's purchased/accessible premium lectures (self, owning instructor, or platform admin)
    router.get('/student/:studentId/purchased', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId } = req.params;

            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية لعرض حصص هذا الطالب' });
            }

            const lectures = await deps.query(`
                SELECT
                    pl.*,
                    gr.name as grade_name,
                    g.name as group_name,
                    pla.granted_at
                FROM premium_lecture_access pla
                JOIN premium_lectures pl ON pla.premium_lecture_id = pl.id
                LEFT JOIN grades gr ON pl.grade_id = gr.id
                LEFT JOIN \`groups\` g ON pl.group_id = g.id
                WHERE pla.student_id = ?
                ORDER BY pla.granted_at DESC
            `, [studentId]);
            res.json(await projectLectures(lectures || []));
        } catch (error) {
            console.error('Get purchased lectures error:', error);
            res.status(500).json({ error: 'فشل في جلب الحصص المشتراة' });
        }
    });

    // ===============================
    // ACCESS CHECK
    // ===============================

    // Check if student has access to a premium lecture (self, owning instructor, or platform admin)
    router.get('/access/check/:studentId/:lectureId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { studentId, lectureId } = req.params;

            if (!(await canViewStudent(req.user!, studentId))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية للتحقق من وصول هذا الطالب' });
            }

            const access = await deps.queryOne(`
                SELECT * FROM premium_lecture_access
                WHERE student_id = ? AND premium_lecture_id = ?
            `, [studentId, lectureId]);

            res.json({ hasAccess: !!access, access });
        } catch (error) {
            console.error('Check access error:', error);
            res.status(500).json({ error: 'فشل في التحقق من الوصول' });
        }
    });

    // ===============================
    // LECTURE MANAGEMENT
    // ===============================

    // Get all premium lectures (owning instructor: own lectures only; platform admin: all)
    router.get('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user!;
            const { grade_id, group_id } = req.query;

            let sql = `
                SELECT
                    pl.*,
                    gr.name as grade_name,
                    g.name as group_name,
                    (SELECT COUNT(*) FROM premium_lecture_access WHERE premium_lecture_id = pl.id) as enrolled_count,
                    (SELECT COUNT(*) FROM premium_lecture_payments WHERE premium_lecture_id = pl.id AND status = 'pending') as pending_payments
                FROM premium_lectures pl
                LEFT JOIN grades gr ON pl.grade_id = gr.id
                LEFT JOIN \`groups\` g ON pl.group_id = g.id
                WHERE 1=1
            `;
            const params: any[] = [];

            if (grade_id && typeof grade_id === 'string') {
                sql += ' AND pl.grade_id = ?';
                params.push(grade_id);
            }

            if (group_id && typeof group_id === 'string') {
                sql += ' AND pl.group_id = ?';
                params.push(group_id);
            }

            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لعرض الحصص المدفوعة' });
                }
                sql += ` AND ${TEACHER_LECTURE_SCOPE_SQL}`;
                params.push(user.id);
                sql += ` AND (pl.group_id IS NULL OR NOT EXISTS (
                    SELECT 1 FROM \`groups\` bg
                    WHERE bg.id = pl.group_id AND bg.branch_scope = 'branch'
                      AND NOT EXISTS (
                        SELECT 1 FROM branch_memberships bm
                        WHERE bm.branch_id = bg.branch_id AND bm.user_id = ? AND bm.status = 'active'
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM tenants owner_t
                        WHERE owner_t.id = ? AND owner_t.owner_user_id = ? AND owner_t.status = 'active'
                      )
                ))`;
                params.push(user.id, user.tenantId ?? null, user.id);
                if (user.branchId) {
                    sql += ` AND (pl.group_id IS NULL OR NOT EXISTS (
                        SELECT 1 FROM \`groups\` bg2
                        WHERE bg2.id = pl.group_id AND bg2.branch_scope = 'branch' AND bg2.branch_id <> ?
                    ))`;
                    params.push(user.branchId);
                }
            }

            sql += ' ORDER BY pl.created_at DESC';

            const lectures = await deps.query(sql, params);
            res.json(await projectLectures(lectures || []));
        } catch (error) {
            console.error('Get premium lectures error:', error);
            res.status(500).json({ error: 'فشل في جلب الحصص المدفوعة' });
        }
    });

    // Get single premium lecture (owner/admin, or a student holding granted access)
    router.get('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const user = req.user!;

            const lecture = await deps.queryOne<LectureRow>(`
                SELECT
                    pl.*,
                    gr.name as grade_name,
                    g.name as group_name
                FROM premium_lectures pl
                LEFT JOIN grades gr ON pl.grade_id = gr.id
                LEFT JOIN \`groups\` g ON pl.group_id = g.id
                WHERE pl.id = ?
            `, [id]);

            if (!lecture) {
                return res.status(404).json({ error: 'الحصة غير موجودة' });
            }
            if (!(await enforcePremiumBranch(req, res, id, req.query?.branch_id))) return;

            if (await canManageLecture(user, id)) {
                return res.json(await projectLectureById(lecture));
            }

            // Students see a lecture only when access was actually granted;
            // published-but-not-granted lectures stay invisible (no metadata leak).
            if (user.studentEnrollmentId) {
                const access = await deps.queryOne(`
                    SELECT id FROM premium_lecture_access
                    WHERE student_id = ? AND premium_lecture_id = ?
                `, [user.studentEnrollmentId, id]);
                if (access) {
                    return res.json(await projectLectureById(lecture));
                }
            }

            return res.status(404).json({ error: 'الحصة غير موجودة' });
        } catch (error) {
            console.error('Get premium lecture error:', error);
            res.status(500).json({ error: 'فشل في جلب بيانات الحصة' });
        }
    });

    // Create premium lecture (owner of the target group, or verified platform admin)
    router.post('/', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published } = req.body;
            const user = req.user!;

            if (!title || !video_url || price === undefined) {
                return res.status(400).json({ error: 'العنوان ورابط الفيديو والسعر مطلوبين' });
            }
            const decimalPrice = toDecimalMoney(price);
            if (decimalPrice === null) {
                return res.status(400).json({ error: 'السعر يجب أن يكون موجبًا وبدقتين عشريتين كحد أقصى' });
            }

            // One canonical reference rule for this write path: `video://`
            // followed by a non-empty id with no whitespace. A raw private
            // URL (or any other form) is refused here, before any read or
            // write, and is never stored verbatim.
            const videoReference = parseVideoReference(String(video_url));
            if (!videoReference.ok) {
                return res.status(400).json({
                    error: videoReference.reason === 'not-a-reference'
                        ? 'External video links are not allowed. Upload the video to the platform.'
                        : 'Video link is not a canonical platform video reference',
                });
            }

            if (!(await hasPlatformAdmin(user.id))) {
                if (!user.instructorId || !group_id) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لإنشاء حصة مدفوعة' });
                }
                // The target group must belong to the caller's own tenant.
                const group = await deps.queryOne(`
                    SELECT g.id
                    FROM \`groups\` g
                    INNER JOIN tenants t ON t.owner_user_id = g.instructor_id
                    WHERE g.id = ? AND t.owner_user_id = ? AND t.status = 'active'
                `, [group_id, user.id]);
                if (!group) {
                    return res.status(403).json({ error: 'المجموعة ليست داخل مساحتك' });
                }
            }

            const id = uuidv4();

            // A premium lecture's branch is derived from its group; the
            // caller cannot assign an unauthorized branch.
            const groupBranch = await validatePremiumGroupBranch(user, group_id);
            if (!groupBranch.ok) {
                return res.status(groupBranch.status).json({ error: groupBranch.error });
            }

            // The binding check and the INSERT share one transaction so the
            // video row lock covers the write and no raw/unproven reference
            // can be persisted.
            const outcome = await withTransaction(async (tx) => {
                const binding = await bindPremiumVideo(tx, req, videoReference.videoUrl, id, group_id || null);
                if (!binding.ok) return { kind: 'denied' as const, binding };

                await tx.execute(`
                    INSERT INTO premium_lectures (id, title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published, created_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [id, title, description || null, binding.videoUrl, thumbnail_url || null, duration_minutes || 0, decimalPrice, grade_id || null, group_id || null, is_published ? 1 : 0, user.id]);
                return { kind: 'created' as const };
            });

            if (outcome.kind === 'denied') {
                return res.status(outcome.binding.status).json({
                    error: outcome.binding.error,
                    code: outcome.binding.code,
                });
            }

            const newLecture = await deps.queryOne('SELECT * FROM premium_lectures WHERE id = ?', [id]);
            res.status(201).json(await projectLectureById(newLecture));
        } catch (error) {
            console.error('Create premium lecture error:', error);
            res.status(500).json({ error: 'فشل في إنشاء الحصة المدفوعة' });
        }
    });

    // Update premium lecture (owner of the lecture, or verified platform admin)
    router.put('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const { title, description, video_url, thumbnail_url, duration_minutes, price, grade_id, group_id, is_published } = req.body;

            if (!(await canManageLecture(req.user!, id))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية على هذه الحصة' });
            }
            if (!(await enforcePremiumBranch(req, res, id, req.body?.branch_id))) return;
            const targetGroupBranch = await validatePremiumGroupBranch(req.user!, group_id);
            if (!targetGroupBranch.ok) {
                return res.status(targetGroupBranch.status).json({ error: targetGroupBranch.error });
            }

            // The destination GROUP is client-supplied; its tenant is not.
            // Mirrors the create path: a non-platform writer may only place a
            // lecture into a group of their own workspace, so an update cannot
            // move a lecture (and the paid video bound to it) into a foreign
            // tenant's catalogue. The branch check above only covers
            // branch-scoped groups, so this is not implied by it.
            if (group_id && !(await hasPlatformAdmin(req.user!.id))) {
                if (!req.user!.instructorId) {
                    return res.status(403).json({ error: 'ليست لديك صلاحية لتحديث الحصة المدفوعة' });
                }
                const destinationGroup = await deps.queryOne(`
                    SELECT g.id
                    FROM \`groups\` g
                    INNER JOIN tenants t ON t.owner_user_id = g.instructor_id
                    WHERE g.id = ? AND t.owner_user_id = ? AND t.status = 'active'
                `, [group_id, req.user!.id]);
                if (!destinationGroup) {
                    return res.status(403).json({ error: 'المجموعة ليست داخل مساحتك' });
                }
            }

            if (price !== undefined && toDecimalMoney(price) === null) {
                return res.status(400).json({ error: 'السعر يجب أن يكون موجبًا وبدقتين عشريتين كحد أقصى' });
            }

            // Only a NEW association needs a canonical value before any write.
            // An update that leaves the stored reference untouched does not
            // rewrite it, so a legacy row (raw URL or an unproven reference)
            // is never silently rewritten; a MOVE is re-proven inside the
            // transaction below, because the reference is only authorized for
            // the destination it was proven against.
            const current = await deps.queryOne<{ video_url: string | null }>(
                'SELECT video_url FROM premium_lectures WHERE id = ?', [id],
            );
            if (!current) {
                return res.status(404).json({ error: 'الحصة غير موجودة' });
            }
            const changesVideo = video_url !== undefined
                && String(video_url) !== String(current.video_url ?? '');
            if (changesVideo) {
                const videoReference = parseVideoReference(String(video_url));
                if (!videoReference.ok) {
                    return res.status(400).json({
                        error: videoReference.reason === 'not-a-reference'
                            ? 'External video links are not allowed. Upload the video to the platform.'
                            : 'Video link is not a canonical platform video reference',
                    });
                }
            }

            const outcome = await withTransaction(async (tx) => {
                const stored = await tx.queryOne<{ video_url: string | null; group_id: string | null }>(
                    'SELECT video_url, group_id FROM premium_lectures WHERE id = ? FOR UPDATE', [id],
                );
                if (!stored) return { kind: 'missing' as const };

                // The destination is the group this write leaves behind (this
                // endpoint is a full replace: an omitted group_id clears it,
                // exactly as the UPDATE below does). It is read as a server
                // row and mapped to its course tenant — never taken from the
                // body as authority.
                const destinationGroupId = group_id ? String(group_id) : null;
                const destinationChanged =
                    destinationGroupId !== (stored.group_id == null ? null : String(stored.group_id));

                const replacesVideo = video_url !== undefined
                    && String(video_url) !== String(stored.video_url ?? '');
                let storedVideoUrl = replacesVideo ? String(video_url) : (stored.video_url ?? null);

                // A new association is always proven. An UNCHANGED stored
                // reference is not rewritten, but a destination change
                // re-proves it: the write contract's tenant equality is a
                // property of the pair, so the same reference is not
                // authorized for a different destination tenant. A destination
                // with no provable tenant is not accepted as a proof — the row
                // is left untouched and the read projection withholds it.
                const storedReference = storedVideoUrl == null
                    ? null
                    : parseVideoReference(String(storedVideoUrl));
                const referenceToBind = replacesVideo
                    ? String(video_url)
                    : (storedReference && storedReference.ok ? storedReference.videoUrl : null);
                if (referenceToBind !== null) {
                    const destinationProvable = replacesVideo || (destinationChanged
                        && (await resolvePremiumDestinationCourse(tx, destinationGroupId)).ok);
                    if (destinationProvable) {
                        const binding = await bindPremiumVideo(
                            tx, req, referenceToBind, id, destinationGroupId,
                        );
                        if (!binding.ok) return { kind: 'denied' as const, binding };
                        storedVideoUrl = binding.videoUrl;
                    }
                }

                await tx.execute(`
                    UPDATE premium_lectures
                    SET title = ?, description = ?, video_url = ?, thumbnail_url = ?, duration_minutes = ?, price = ?, grade_id = ?, group_id = ?, is_published = ?
                    WHERE id = ?
                `, [title, description || null, storedVideoUrl, thumbnail_url || null, duration_minutes || 0, toDecimalMoney(price) ?? price, grade_id || null, group_id || null, is_published ? 1 : 0, id]);
                return { kind: 'updated' as const };
            });

            if (outcome.kind === 'missing') {
                return res.status(404).json({ error: 'الحصة غير موجودة' });
            }
            if (outcome.kind === 'denied') {
                return res.status(outcome.binding.status).json({
                    error: outcome.binding.error,
                    code: outcome.binding.code,
                });
            }

            const updatedLecture = await deps.queryOne('SELECT * FROM premium_lectures WHERE id = ?', [id]);
            res.json(await projectLectureById(updatedLecture));
        } catch (error) {
            console.error('Update premium lecture error:', error);
            res.status(500).json({ error: 'فشل في تحديث الحصة المدفوعة' });
        }
    });

    // Delete premium lecture (owner of the lecture, or verified platform admin)
    router.delete('/:id', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;

            if (!(await canManageLecture(req.user!, id))) {
                return res.status(403).json({ error: 'ليست لديك صلاحية على هذه الحصة' });
            }
            if (!(await enforcePremiumBranch(req, res, id))) return;

            await deps.execute('DELETE FROM premium_lectures WHERE id = ?', [id]);
            res.json({ success: true, message: 'تم حذف الحصة بنجاح' });
        } catch (error) {
            console.error('Delete premium lecture error:', error);
            res.status(500).json({ error: 'فشل في حذف الحصة المدفوعة' });
        }
    });

    return router;
};

// `../db` is loaded lazily (and cached) so importing this module never runs
// db.ts: no dotenv side effect and no pool creation at import time.
let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

/** Verified platform capability: active super_admin or a seeded permission key. */
const productionPlatformCapability = async (userId: string, permission: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes(permission);
};

/** Production wiring: real pool, live auth middleware, verified capability check. */
export default createPremiumLectureRouter({
    query: (sql, params) => loadDb().then((db) => db.query(sql, params)),
    queryOne: (sql, params) => loadDb().then((db) => db.queryOne(sql, params)),
    execute: (sql, params) => loadDb().then((db) => db.execute(sql, params)),
    withTransaction: async <T>(work: (tx: {
        query: <U = unknown>(sql: string, params?: unknown[]) => Promise<U[]>;
        queryOne: <U = unknown>(sql: string, params?: unknown[]) => Promise<U | null>;
        execute: (sql: string, params?: unknown[]) => Promise<{ insertId: number; affectedRows: number }>;
    }) => Promise<T>): Promise<T> => {
        const db = await loadDb();
        const connection = await db.getPool().getConnection();
        try {
            await connection.beginTransaction();
            const tx = {
                query: async <U = unknown>(sql: string, params?: unknown[]): Promise<U[]> => {
                    const [rows] = await connection.execute(sql, params);
                    return rows as U[];
                },
                queryOne: async <U = unknown>(sql: string, params?: unknown[]): Promise<U | null> => {
                    const [rows] = await connection.execute(sql, params);
                    const list = rows as U[];
                    return list.length > 0 ? list[0] : null;
                },
                execute: async (sql: string, params?: unknown[]) => {
                    const [result] = await connection.execute(sql, params);
                    return result as { insertId: number; affectedRows: number };
                },
            };
            const result = await work(tx);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    },
    authenticate: authenticateToken,
    hasPlatformCapability: productionPlatformCapability,
});
