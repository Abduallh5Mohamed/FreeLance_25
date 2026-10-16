import { Router, RequestHandler, Response } from 'express';
import { AuthRequest, authenticateToken, requireRoles } from '../middleware/auth';
import { query, queryOne, execute } from '../db';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

/**
 * Data-access seam for the fees router. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 */
export interface FeesDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

/**
 * Injectable seams for the fees router. The default export binds the
 * production SQL adapters, the real authentication middleware, and the real
 * role gate. Tests inject fixtures through this boundary instead of
 * bypassing production authorization.
 */
export interface FeesRouterDeps {
    db: FeesDataAccess;
    authenticate: RequestHandler;
    authorize: RequestHandler;
    /**
     * Server-verified platform finance-read capability (active super_admin or
     * a seeded platform permission key), resolved against admin_user_roles.
     * A JWT role claim never satisfies this predicate. Production binds the
     * real SQL-backed check; hermetic tests inject isolated fixtures through
     * this same boundary so the production guard runs without a database.
     */
    hasVerifiedPlatformFinanceAccess?: (userId: string) => Promise<boolean>;
    /**
     * Active authority of a principal inside one tenant: the verified owner
     * row, or an active membership with role_key IN ('owner','instructor') in
     * an active tenant by an active user. Mirrors the server-owned authority
     * lookup used by video-access-policy / videos.ts / teaching-access so no
     * new authority vocabulary is invented. Production binds the SQL-backed
     * lookup; hermetic tests inject isolated fixtures through this boundary.
     */
    loadActiveTenantAuthority?: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
}

/**
 * Money columns are DECIMAL: reject non-numeric, non-finite, negative, or
 * >2dp input before the driver can coerce it into a money row. Only JSON
 * numbers in integer minor units or decimal-safe form (finite, >= 0, at most
 * two fraction digits) are accepted — numeric strings are rejected so the
 * driver never coerces text into a ledger row.
 */
const isValidMoney = (value: unknown): boolean => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    return Math.abs(value - Math.round(value * 100) / 100) < 1e-9;
};

export const createFeesRouter = (deps: FeesRouterDeps): Router => {
    const router = Router();
    const { query, queryOne, execute } = deps.db;
    router.use(deps.authenticate, deps.authorize);

    const hasVerifiedPlatformFinanceAccess = deps.hasVerifiedPlatformFinanceAccess
        ?? ((userId: string) => hasVerifiedPlatformPermission('finance.read', userId));

    /**
     * Active authority inside a tenant, resolved from server-side rows only:
     * the verified tenant owner, or an active membership with role_key
     * owner/instructor in an active tenant by an active user. A bare
     * teacher/staff/instructor JWT role claim never satisfies this.
     */
    const loadActiveTenantAuthority = deps.loadActiveTenantAuthority
        ?? (async (userId: string, tenantId: string) => queryOne<{ authority: string }>(
            `SELECT 'owner' AS authority
             FROM tenants t
             WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
             UNION ALL
             SELECT m.role_key AS authority
             FROM tenant_memberships m
             INNER JOIN tenants t ON t.id = m.tenant_id
             INNER JOIN users u ON u.id = m.user_id
             WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
               AND t.status = 'active' AND u.is_active = 1
               AND m.role_key IN ('owner','instructor')
             LIMIT 1`,
            [tenantId, userId, userId, tenantId],
        ));

    /**
     * Resolved financial-record authority of the authenticated principal.
     * `platform` is a server-verified capability (reads only), `authority`
     * is the server-verified tenant role ('owner' = tenant-wide financial
     * management, 'instructor' = precise student assignment only), and
     * `tenantId` is the server-derived active workspace.
     */
    interface FeesScope {
        platform: boolean;
        authority: 'owner' | 'instructor' | null;
        userId: string;
        tenantId: string | null;
    }

    /**
     * Verify the platform finance-read capability before any data access.
     * A lookup failure denies with 503 instead of failing open onto a role
     * claim.
     */
    const verifyPlatformFinanceAccess = async (
        req: AuthRequest,
        res: Response,
    ): Promise<boolean | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        try {
            return await hasVerifiedPlatformFinanceAccess(user.id);
        } catch (error) {
            console.error('Finance permission lookup failed:', error);
            res.status(503).json({ error: 'Finance permissions unavailable' });
            return null;
        }
    };

    /**
     * Resolve read authority. A verified platform operator reads across
     * tenants; the verified tenant owner reads the whole tenant; a verified
     * teaching member (role_key instructor) reads only fees of students
     * precisely assigned to them. Everyone else — including active
     * membership alone — is denied before any query runs.
     */
    const resolveReadScope = async (
        req: AuthRequest,
        res: Response,
    ): Promise<FeesScope | null> => {
        const platform = await verifyPlatformFinanceAccess(req, res);
        if (platform === null) return null;
        const user = req.user as NonNullable<AuthRequest['user']>;
        if (platform) return { platform: true, authority: null, userId: user.id, tenantId: null };
        const tenantId = user.tenantId;
        if (!tenantId) {
            res.status(403).json({ error: 'Workspace access required' });
            return null;
        }
        let authorityRow: { authority: string } | null;
        try {
            authorityRow = await loadActiveTenantAuthority(user.id, tenantId);
        } catch (error) {
            console.error('Tenant authority lookup failed:', error);
            res.status(503).json({ error: 'Tenant authority unavailable' });
            return null;
        }
        if (!authorityRow || (authorityRow.authority !== 'owner' && authorityRow.authority !== 'instructor')) {
            res.status(403).json({ error: 'Financial records require owner or assigned-instructor authority' });
            return null;
        }
        return { platform: false, authority: authorityRow.authority, userId: user.id, tenantId };
    };

    /**
     * Writes need an active tenant authority: the verified platform capability
     * grants reads only, so a platform principal without a tenant membership
     * is denied before any mutation (unchanged fail-closed write contract).
     */
    const resolveWriteScope = async (
        req: AuthRequest,
        res: Response,
    ): Promise<FeesScope | null> => {
        const scope = await resolveReadScope(req, res);
        if (!scope) return null;
        if (scope.platform) {
            res.status(403).json({ error: 'Active tenant membership required' });
            return null;
        }
        return scope;
    };

    /** Students precisely assigned to an instructor (own or via own group). */
    const ASSIGNED_STUDENT_PREDICATE = `
            SELECT s.id FROM students s WHERE s.instructor_id = ?
            UNION
            SELECT s.id FROM students s WHERE s.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?)`;

    const readClause = (scope: FeesScope): { sql: string; params: unknown[] } => {
        if (scope.platform) return { sql: '', params: [] };
        if (scope.authority === 'owner') {
            return { sql: ' AND tenant_id=?', params: [scope.tenantId as string] };
        }
        return {
            sql: ` AND tenant_id=? AND student_id IN (${ASSIGNED_STUDENT_PREDICATE})`,
            params: [scope.tenantId as string, scope.userId, scope.userId],
        };
    };

    /**
     * A group used to link a fee must belong to the caller's authority:
     * an owner sees the tenant (group -> course -> tenant); an instructor
     * only their own assigned group. A group whose course carries no
     * provable tenant owner never matches.
     */
    const groupInCallerAuthority = async (groupId: string, scope: FeesScope): Promise<boolean> => {
        if (scope.authority === 'instructor') {
            const row = await queryOne(
                'SELECT id FROM `groups` WHERE id=? AND instructor_id=?',
                [groupId, scope.userId],
            );
            return !!row;
        }
        const row = await queryOne(
            `SELECT g.id FROM \`groups\` g
             LEFT JOIN courses c ON g.course_id = c.id
             WHERE g.id = ? AND c.tenant_id = ?`,
            [groupId, scope.tenantId as string],
        );
        return !!row;
    };

    /** A fee row the caller's authority covers (assignment for instructors). */
    const feeInCallerAuthority = async (feeId: string, scope: FeesScope): Promise<boolean> => {
        const clause = readClause(scope);
        const row = await queryOne(
            `SELECT id FROM student_fees WHERE id = ?${clause.sql}`,
            [feeId, ...clause.params],
        );
        return !!row;
    };

    /** A student the caller's authority covers (tenant for owners, assignment for instructors). */
    const studentInCallerAuthority = async (studentId: string, scope: FeesScope): Promise<boolean> => {
        if (scope.authority === 'instructor') {
            const row = await queryOne(
                `SELECT id FROM students WHERE id=? AND (instructor_id=? OR group_id IN (SELECT id FROM \`groups\` WHERE instructor_id=?))`,
                [studentId, scope.userId, scope.userId],
            );
            return !!row;
        }
        const row = await queryOne('SELECT id FROM students WHERE id=? AND tenant_id=?', [studentId, scope.tenantId as string]);
        return !!row;
    };

    interface Fee {
        id: string;
        student_id?: string;
        student_name: string;
        phone?: string;
        guardian_phone?: string;
        grade_id?: string;
        grade_name?: string;
        group_id?: string;
        group_name?: string;
        barcode?: string;
        amount: number;
        paid_amount: number;
        status: string;
        payment_method?: string;
        is_offline: boolean;
        notes?: string;
        due_date?: string;
        payment_date?: string;
        payment_year?: number;
        payment_month?: number;
        receipt_image_url?: string;
    }

    // Get all fees
    router.get('/', async (req: AuthRequest, res: Response) => {
        try {
            const { is_offline, status, phone, name } = req.query;

            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const clause = readClause(scope);

            let sql = `SELECT * FROM student_fees WHERE 1=1${clause.sql}`;
            const params: unknown[] = [...clause.params];

            if (is_offline !== undefined) {
                sql += ' AND is_offline = ?';
                params.push(is_offline === 'true');
            }

            if (status) {
                sql += ' AND status = ?';
                params.push(status);
            }

            if (phone) {
                sql += ' AND phone = ?';
                params.push(phone);
            }

            if (name) {
                sql += ' AND student_name LIKE ?';
                params.push(`%${name}%`);
            }

            sql += ' ORDER BY created_at DESC';

            const fees = await query<Fee>(sql, params);
            res.json(fees);
        } catch (error) {
            console.error('Get fees error:', error);
            res.status(500).json({ error: 'Failed to fetch fees' });
        }
    });

    // Get fee by ID
    router.get('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveReadScope(req, res);
            if (!scope) return;
            const clause = readClause(scope);

            const fee = await queryOne<Fee>(
                `SELECT * FROM student_fees WHERE id = ?${clause.sql}`,
                [req.params.id, ...clause.params]
            );

            if (!fee) {
                return res.status(404).json({ error: 'Fee not found' });
            }

            res.json(fee);
        } catch (error) {
            console.error('Get fee error:', error);
            res.status(500).json({ error: 'Failed to fetch fee' });
        }
    });

    // Create new fee
    router.post('/', async (req: AuthRequest, res: Response) => {
        try {
            const {
                student_name,
                phone,
                guardian_phone,
                grade_id,
                grade_name,
                group_id,
                group_name,
                barcode,
                amount,
                paid_amount,
                status,
                payment_method,
                is_offline,
                notes,
                due_date,
                payment_date,
                payment_year,
                payment_month,
                receipt_image_url
            } = req.body;

            if (amount !== undefined && amount !== null && !isValidMoney(amount)) {
                return res.status(400).json({ error: 'Amount and paid amount must be non-negative numbers' });
            }
            if (paid_amount !== undefined && paid_amount !== null && !isValidMoney(paid_amount)) {
                return res.status(400).json({ error: 'Amount and paid amount must be non-negative numbers' });
            }

            // Writes need an active tenant authority (owner or assigned
            // instructor); the verified platform capability grants reads only.
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;
            const tenantId = scope.tenantId as string;
            if (!student_name && !phone && !barcode) {
                return res.status(400).json({ error: 'Student information is required' });
            }

            // A caller-supplied group used to link the fee must exist inside
            // the caller's authority (tenant for owners, own assignment for
            // instructors); the probe runs before any write and rejects
            // forged linking IDs.
            if (group_id && !(await groupInCallerAuthority(group_id, scope))) {
                return res.status(404).json({ error: 'Group not found in your tenant' });
            }

            let linkedStudent = null;

            if (barcode) {
                linkedStudent = await queryOne(
                    `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                     FROM students s
                     LEFT JOIN grades g ON s.grade_id = g.id
                     LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                     WHERE s.barcode = ? AND s.tenant_id=?`,
                    [barcode, tenantId]
                );
            }

            if (!linkedStudent && phone) {
                linkedStudent = await queryOne(
                    `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                     FROM students s
                     LEFT JOIN grades g ON s.grade_id = g.id
                     LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                     WHERE s.phone = ? AND s.tenant_id=?`,
                    [phone, tenantId]
                );
            }

            if (!linkedStudent && student_name) {
                linkedStudent = await queryOne(
                    `SELECT s.*, g.name AS grade_name, grp.name AS group_name
                     FROM students s
                     LEFT JOIN grades g ON s.grade_id = g.id
                     LEFT JOIN \`groups\` grp ON s.group_id = grp.id
                     WHERE s.name LIKE ? AND s.tenant_id=?
                     ORDER BY CHAR_LENGTH(s.name) ASC
                     LIMIT 1`,
                    [`%${student_name}%`, tenantId]
                );
            }

            // For offline students, allow direct creation without requiring student in database
            const resolvedStudentId = linkedStudent?.id || null;
            const resolvedStudentName = linkedStudent?.name || student_name;
            const resolvedPhone = linkedStudent?.phone || phone;
            const resolvedGuardianPhone = linkedStudent?.guardian_phone || guardian_phone;
            const resolvedGradeId = linkedStudent?.grade_id || grade_id;
            const resolvedGradeName = linkedStudent?.grade_name || grade_name;
            const resolvedGroupId = linkedStudent?.group_id || group_id;
            const resolvedGroupName = linkedStudent?.group_name || group_name;
            const resolvedBarcode = linkedStudent?.barcode || barcode;

            // An instructor may only create fees for students precisely
            // assigned to them; an unlinked offline record carries no
            // provable assignment and stays denied (owner path unchanged).
            if (scope.authority === 'instructor'
                && (!linkedStudent || !(await studentInCallerAuthority(linkedStudent.id, scope)))) {
                return res.status(403).json({ error: 'Student not in your assigned scope' });
            }

            // Determine payment year and month
            const paymentDateObj = payment_date ? new Date(payment_date) : new Date();
            const finalPaymentYear = payment_year || paymentDateObj.getFullYear();
            const finalPaymentMonth = payment_month || (paymentDateObj.getMonth() + 1);

            // Check if student already paid for this month (only if student_id exists)
            if (resolvedStudentId) {
                const existingPayment = await queryOne<Fee>(
                    `SELECT * FROM student_fees
                     WHERE student_id = ? AND tenant_id=? AND payment_year = ? AND payment_month = ? AND status = 'paid'`,
                    [resolvedStudentId, tenantId, finalPaymentYear, finalPaymentMonth]
                );

                if (existingPayment) {
                    return res.status(400).json({
                        error: 'تم الدفع مسبقاً',
                        message: `الطالب ${resolvedStudentName} قام بالدفع بالفعل لشهر ${finalPaymentMonth}/${finalPaymentYear}`,
                        existing_payment: existingPayment
                    });
                }
            }

            const result = await execute(
                `INSERT INTO student_fees (
                    tenant_id, student_id, student_name, phone, guardian_phone, grade_id, grade_name, group_id, group_name,
                    barcode, amount, paid_amount, status, payment_method, is_offline,
                    notes, due_date, payment_date, payment_year, payment_month, receipt_image_url
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    tenantId,
                    resolvedStudentId,
                    resolvedStudentName,
                    resolvedPhone || null,
                    resolvedGuardianPhone || null,
                    resolvedGradeId || null,
                    resolvedGradeName || null,
                    resolvedGroupId || null,
                    resolvedGroupName || null,
                    resolvedBarcode || null,
                    amount || 0,
                    paid_amount || 0,
                    status || 'paid',
                    payment_method || 'cash',
                    is_offline ?? true,
                    notes || null,
                    due_date || new Date().toISOString().split('T')[0],
                    payment_date || new Date().toISOString().split('T')[0],
                    finalPaymentYear,
                    finalPaymentMonth,
                    receipt_image_url || null
                ]
            );

            let newFee: Fee | null = null;

            if (result.insertId) {
                newFee = await queryOne<Fee>(
                    `SELECT * FROM student_fees WHERE id = ? AND tenant_id=?`,
                    [result.insertId, tenantId]
                );
            }

            if (!newFee) {
                newFee = await queryOne<Fee>(
                    `SELECT * FROM student_fees
                     WHERE barcode = ? AND tenant_id=?
                     ORDER BY created_at DESC
                     LIMIT 1`,
                    [resolvedBarcode, tenantId]
                );
            }

            res.status(201).json(newFee);
        } catch (error) {
            console.error('Create fee error:', error);
            res.status(500).json({ error: 'Failed to create fee' });
        }
    });

    // Update fee
    router.put('/:id', async (req: AuthRequest, res: Response) => {
        try {
            const { id } = req.params;
            const {
                student_id,
                student_name,
                phone,
                guardian_phone,
                grade_id,
                grade_name,
                group_id,
                group_name,
                amount,
                paid_amount,
                status,
                payment_method,
                notes,
                due_date,
                payment_date,
                payment_year,
                payment_month,
                receipt_image_url
            } = req.body;

            if (amount !== undefined && !isValidMoney(amount)) {
                return res.status(400).json({ error: 'Amount and paid amount must be non-negative numbers' });
            }
            if (paid_amount !== undefined && !isValidMoney(paid_amount)) {
                return res.status(400).json({ error: 'Amount and paid amount must be non-negative numbers' });
            }

            // Writes need an active tenant authority (owner or assigned
            // instructor); the verified platform capability grants reads only.
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;

            // An instructor may only mutate fees of students precisely
            // assigned to them; an unassigned fee is denied before any
            // UPDATE runs (owner path unchanged).
            if (scope.authority === 'instructor' && !(await feeInCallerAuthority(id, scope))) {
                return res.status(403).json({ error: 'Fee is outside your assigned scope' });
            }

            // The student a fee is linked to must exist inside the caller's
            // authority. No role bypasses this probe: a forged student_id
            // from another tenant is rejected before the UPDATE runs.
            if (student_id && !(await studentInCallerAuthority(student_id, scope))) {
                return res.status(404).json({ error: 'Student not found in your tenant' });
            }

            // A caller-supplied group used to relink the fee must exist inside
            // the caller's authority, proven before the write; a group with no
            // provable owner never matches.
            if (group_id && !(await groupInCallerAuthority(group_id, scope))) {
                return res.status(404).json({ error: 'Group not found in your tenant' });
            }

            // If payment_date is updated, recalculate year/month
            let finalPaymentYear = payment_year;
            let finalPaymentMonth = payment_month;
            if (payment_date && (!payment_year || !payment_month)) {
                const paymentDateObj = new Date(payment_date);
                finalPaymentYear = paymentDateObj.getFullYear();
                finalPaymentMonth = paymentDateObj.getMonth() + 1;
            }

            await execute(
                `UPDATE student_fees SET
                    student_id = COALESCE(?, student_id),
                    student_name = COALESCE(?, student_name),
                    phone = COALESCE(?, phone),
                    guardian_phone = COALESCE(?, guardian_phone),
                    grade_id = COALESCE(?, grade_id),
                    grade_name = COALESCE(?, grade_name),
                    group_id = COALESCE(?, group_id),
                    group_name = COALESCE(?, group_name),
                    amount = COALESCE(?, amount),
                    paid_amount = COALESCE(?, paid_amount),
                    status = COALESCE(?, status),
                    payment_method = COALESCE(?, payment_method),
                    notes = COALESCE(?, notes),
                    due_date = COALESCE(?, due_date),
                    payment_date = COALESCE(?, payment_date),
                    payment_year = COALESCE(?, payment_year),
                    payment_month = COALESCE(?, payment_month),
                    receipt_image_url = COALESCE(?, receipt_image_url),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?${readClause(scope).sql}`,
                [
                    student_id || null,
                    student_name || null,
                    phone || null,
                    guardian_phone || null,
                    grade_id || null,
                    grade_name || null,
                    group_id || null,
                    group_name || null,
                    // Money fields use explicit undefined checks so a
                    // legitimate zero update is applied instead of being
                    // dropped by a falsy check and leaving a stale amount.
                    amount !== undefined ? amount : null,
                    paid_amount !== undefined ? paid_amount : null,
                    status || null,
                    payment_method || null,
                    notes || null,
                    due_date || null,
                    payment_date || null,
                    finalPaymentYear || null,
                    finalPaymentMonth || null,
                    receipt_image_url || null,
                    id,
                    ...readClause(scope).params
                ]
            );

            const updatedFee = await queryOne<Fee>(
                `SELECT * FROM student_fees WHERE id = ?${readClause(scope).sql}`,
                [id, ...readClause(scope).params]
            );

            res.json(updatedFee);
        } catch (error) {
            console.error('Update fee error:', error);
            res.status(500).json({ error: 'Failed to update fee' });
        }
    });

    // Delete fee
    router.delete('/:id', async (req: AuthRequest, res: Response) => {
        try {
            // Writes need an active tenant authority (owner or assigned
            // instructor); the verified platform capability grants reads only.
            const scope = await resolveWriteScope(req, res);
            if (!scope) return;

            // An instructor may only delete fees of students precisely
            // assigned to them; an unassigned fee is denied before any
            // DELETE runs (owner path unchanged).
            if (scope.authority === 'instructor' && !(await feeInCallerAuthority(req.params.id, scope))) {
                return res.status(403).json({ error: 'Fee is outside your assigned scope' });
            }

            const result = await execute(
                `DELETE FROM student_fees WHERE id = ?${readClause(scope).sql}`,
                [req.params.id, ...readClause(scope).params]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Fee not found' });
            }

            res.json({ message: 'Fee deleted successfully' });
        } catch (error) {
            console.error('Delete fee error:', error);
            res.status(500).json({ error: 'Failed to delete fee' });
        }
    });

    return router;
};

const productionDb: FeesDataAccess = { query, queryOne, execute };

export default createFeesRouter({
    db: productionDb,
    authenticate: authenticateToken,
    authorize: requireRoles('admin', 'instructor', 'teacher', 'staff'),
});
