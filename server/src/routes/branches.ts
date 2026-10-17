/**
 * Minimal branch / branch-membership lifecycle administration and the audited
 * quarantine workflow for ambiguous legacy branch ownership.
 *
 * There is deliberately no UI and no data migration here: an authorized tenant
 * owner (or a verified platform operator) creates branches, grants/revokes
 * memberships, and classifies a legacy group explicitly. Every mutation writes
 * an audit row with the verified actor id. Nothing is auto-assigned.
 */
import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { query, queryOne, execute } from '../db';
import { AuthRequest, authenticateToken } from '../middleware/auth';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';

const router = Router();
router.use(authenticateToken);

const BRANCH_STATUSES = new Set(['active', 'suspended', 'archived']);
const MEMBERSHIP_ROLES = new Set(['owner', 'instructor', 'teacher', 'staff', 'student']);

interface BranchRow {
    id: string;
    tenant_id: string;
    name: string;
    status: string;
    version: number;
    created_at?: Date;
    updated_at?: Date;
}

const isPlatformOperator = async (userId: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes('security.manage');
};

const isTenantOwner = async (userId: string, tenantId: string): Promise<boolean> =>
    Boolean(await queryOne(
        "SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active' LIMIT 1",
        [tenantId, userId],
    ));

/**
 * Resolve the tenant this administration call may act on. A platform operator
 * may name a tenant explicitly; every other caller is confined to the
 * server-derived selected tenant and must be its owner.
 */
const authorizeTenantAdmin = async (
    req: AuthRequest,
    res: Response,
    requestedTenantId?: unknown,
): Promise<{ tenantId: string; platform: boolean } | null> => {
    const user = req.user;
    if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return null;
    }
    const platform = await isPlatformOperator(user.id);
    const tenantId = typeof requestedTenantId === 'string' && requestedTenantId.length > 0
        ? requestedTenantId
        : user.tenantId;
    if (!tenantId) {
        res.status(403).json({ error: 'An active tenant is required' });
        return null;
    }
    if (!platform && !(await isTenantOwner(user.id, tenantId))) {
        res.status(403).json({ error: 'Tenant owner access required' });
        return null;
    }
    return { tenantId, platform };
};

const audit = async (input: {
    tenantId: string | null;
    branchId: string | null;
    actorUserId: string;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    detail?: unknown;
}): Promise<void> => {
    await execute(
        `INSERT INTO branch_audit_log
           (id, tenant_id, branch_id, actor_user_id, action, resource_type, resource_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            randomUUID(),
            input.tenantId,
            input.branchId,
            input.actorUserId,
            input.action,
            input.resourceType ?? null,
            input.resourceId ?? null,
            input.detail === undefined ? null : JSON.stringify(input.detail),
        ],
    );
};

const readBranch = async (branchId: string): Promise<BranchRow | null> =>
    queryOne<BranchRow>(
        'SELECT id, tenant_id, name, status, version, created_at, updated_at FROM branches WHERE id = ? LIMIT 1',
        [branchId],
    );

// ---------------------------------------------------------------------------
// Quarantine report (declared before /:id so the literal wins).
// ---------------------------------------------------------------------------
router.get('/quarantine', async (req: AuthRequest, res: Response) => {
    try {
        const scope = await authorizeTenantAdmin(req, res, req.query.tenant_id);
        if (!scope) return;

        const rows = await query<{
            reason: string;
            group_id: string;
            name: string;
            branch_id: string | null;
            branch_scope: string | null;
            tenant_id: string | null;
        }>(
            `SELECT reason, group_id, name, branch_id, branch_scope, tenant_id FROM (
                SELECT 'branch_scope_without_branch' AS reason, g.id AS group_id, g.name,
                       g.branch_id, g.branch_scope,
                       COALESCE(c.tenant_id, (SELECT t.id FROM tenants t
                         WHERE t.owner_user_id = g.instructor_id AND t.status='active'
                         ORDER BY t.created_at LIMIT 1)) AS tenant_id
                FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
                WHERE g.branch_scope = 'branch' AND g.branch_id IS NULL
                UNION ALL
                SELECT 'tenant_scope_with_branch', g.id, g.name, g.branch_id, g.branch_scope,
                       COALESCE(c.tenant_id, (SELECT t.id FROM tenants t
                         WHERE t.owner_user_id = g.instructor_id AND t.status='active'
                         ORDER BY t.created_at LIMIT 1))
                FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
                WHERE g.branch_scope = 'tenant' AND g.branch_id IS NOT NULL
                UNION ALL
                SELECT 'legacy_or_unknown_unclassified', g.id, g.name, g.branch_id, g.branch_scope,
                       COALESCE(c.tenant_id, (SELECT t.id FROM tenants t
                         WHERE t.owner_user_id = g.instructor_id AND t.status='active'
                         ORDER BY t.created_at LIMIT 1))
                FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
                WHERE g.branch_scope IS NULL OR g.branch_scope NOT IN ('branch','tenant')
                UNION ALL
                SELECT 'branch_missing_or_cross_tenant', g.id, g.name, g.branch_id, g.branch_scope,
                       COALESCE(c.tenant_id, (SELECT t.id FROM tenants t
                         WHERE t.owner_user_id = g.instructor_id AND t.status='active'
                         ORDER BY t.created_at LIMIT 1))
                FROM \`groups\` g
                LEFT JOIN courses c ON c.id = g.course_id
                LEFT JOIN branches b ON b.id = g.branch_id
                WHERE g.branch_id IS NOT NULL AND (b.id IS NULL OR b.tenant_id <> COALESCE(c.tenant_id, ''))
            ) q
            WHERE q.tenant_id = ?
            ORDER BY q.reason, q.group_id
            LIMIT 500`,
            [scope.tenantId],
        );

        const byReason = new Map<string, number>();
        for (const row of rows) byReason.set(row.reason, (byReason.get(row.reason) || 0) + 1);

        res.json({
            tenant_id: scope.tenantId,
            counts: [...byReason.entries()].map(([reason, count]) => ({ reason, count })),
            rows,
            note: 'Unclassified legacy/unknown rows are ambiguous and denied for normal access; they are listed here for the authorized owner/platform operator to classify explicitly. No branch is inferred and listing grants no resource access.',
        });
    } catch (error) {
        console.error('Branch quarantine report error:', error);
        res.status(500).json({ error: 'Failed to build quarantine report' });
    }
});

/**
 * Classify one legacy/ambiguous group explicitly. The update is guarded by
 * the current classification so a concurrent change cannot be overwritten
 * silently; the previous and new values are audited.
 */
router.post('/quarantine/groups/:groupId/classify', async (req: AuthRequest, res: Response) => {
    try {
        const scope = await authorizeTenantAdmin(req, res, req.body?.tenant_id);
        if (!scope) return;
        const groupId = req.params.groupId;
        const targetScope = req.body?.scope;
        if (targetScope !== 'tenant' && targetScope !== 'branch') {
            return res.status(400).json({ error: 'scope must be tenant or branch' });
        }
        const targetBranchId = targetScope === 'branch' ? req.body?.branch_id : null;
        if (targetScope === 'branch') {
            if (typeof targetBranchId !== 'string' || targetBranchId.length === 0) {
                return res.status(400).json({ error: 'branch_id is required for branch scope' });
            }
            const branch = await readBranch(targetBranchId);
            if (!branch || branch.tenant_id !== scope.tenantId || branch.status !== 'active') {
                return res.status(403).json({ error: 'Branch is outside this tenant' });
            }
        }

        const current = await queryOne<{
            id: string; branch_id: string | null; branch_scope: string;
            tenant_id: string | null;
        }>(
            `SELECT g.id, g.branch_id, g.branch_scope,
                    COALESCE(c.tenant_id, (SELECT t.id FROM tenants t
                      WHERE t.owner_user_id = g.instructor_id AND t.status='active'
                      ORDER BY t.created_at LIMIT 1)) AS tenant_id
             FROM \`groups\` g LEFT JOIN courses c ON c.id = g.course_id
             WHERE g.id = ?`,
            [groupId],
        );
        if (!current) return res.status(404).json({ error: 'Group not found' });
        if (current.tenant_id !== scope.tenantId) {
            return res.status(404).json({ error: 'Group not found' });
        }

        const result = await execute(
            `UPDATE \`groups\` SET branch_scope = ?, branch_id = ?
             WHERE id = ? AND branch_scope = ? AND branch_id <=> ?`,
            [targetScope, targetBranchId, groupId, current.branch_scope, current.branch_id],
        );
        if (result.affectedRows === 0) {
            return res.status(409).json({ error: 'Group classification changed concurrently' });
        }

        await audit({
            tenantId: scope.tenantId,
            branchId: targetBranchId,
            actorUserId: req.user!.id,
            action: 'group.branch.classified',
            resourceType: 'group',
            resourceId: groupId,
            detail: {
                from: { scope: current.branch_scope, branch_id: current.branch_id },
                to: { scope: targetScope, branch_id: targetBranchId },
            },
        });
        res.json({ group_id: groupId, branch_scope: targetScope, branch_id: targetBranchId });
    } catch (error) {
        console.error('Branch classify error:', error);
        res.status(500).json({ error: 'Failed to classify group' });
    }
});

// ---------------------------------------------------------------------------
// Branch lifecycle.
// ---------------------------------------------------------------------------
router.get('/', async (req: AuthRequest, res: Response) => {
    try {
        const scope = await authorizeTenantAdmin(req, res, req.query.tenant_id);
        if (!scope) return;
        const branches = await query<BranchRow>(
            'SELECT id, tenant_id, name, status, version, created_at, updated_at FROM branches WHERE tenant_id = ? ORDER BY name',
            [scope.tenantId],
        );
        res.json(branches);
    } catch (error) {
        console.error('List branches error:', error);
        res.status(500).json({ error: 'Failed to list branches' });
    }
});

router.post('/', async (req: AuthRequest, res: Response) => {
    try {
        const scope = await authorizeTenantAdmin(req, res, req.body?.tenant_id);
        if (!scope) return;
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name || name.length > 190) {
            return res.status(400).json({ error: 'A branch name is required' });
        }
        const id = randomUUID();
        await execute(
            "INSERT INTO branches (id, tenant_id, name, status, version) VALUES (?, ?, ?, 'active', 0)",
            [id, scope.tenantId, name],
        );
        await audit({
            tenantId: scope.tenantId,
            branchId: id,
            actorUserId: req.user!.id,
            action: 'branch.created',
            resourceType: 'branch',
            resourceId: id,
            detail: { name },
        });
        res.status(201).json(await readBranch(id));
    } catch (error) {
        console.error('Create branch error:', error);
        res.status(500).json({ error: 'Failed to create branch' });
    }
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
    try {
        const branch = await readBranch(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        const scope = await authorizeTenantAdmin(req, res, branch.tenant_id);
        if (!scope) return;
        const name = req.body?.name === undefined ? null : String(req.body.name).trim();
        const status = req.body?.status === undefined ? null : String(req.body.status);
        if (name !== null && (!name || name.length > 190)) {
            return res.status(400).json({ error: 'Invalid branch name' });
        }
        if (status !== null && !BRANCH_STATUSES.has(status)) {
            return res.status(400).json({ error: 'Invalid branch status' });
        }
        if (name === null && status === null) {
            return res.status(400).json({ error: 'Nothing to update' });
        }
        // Version bump is the revocation signal: branch-scoped sessions are
        // re-read on every request and a suspension/version change denies the
        // next request.
        const result = await execute(
            `UPDATE branches
             SET name = COALESCE(?, name), status = COALESCE(?, status),
                 version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND tenant_id = ? AND version = ?`,
            [name, status, branch.id, branch.tenant_id, branch.version],
        );
        if (result.affectedRows === 0) {
            return res.status(409).json({ error: 'Branch changed concurrently' });
        }
        await audit({
            tenantId: branch.tenant_id,
            branchId: branch.id,
            actorUserId: req.user!.id,
            action: 'branch.updated',
            resourceType: 'branch',
            resourceId: branch.id,
            detail: { name, status, from_version: branch.version },
        });
        res.json(await readBranch(branch.id));
    } catch (error) {
        console.error('Update branch error:', error);
        res.status(500).json({ error: 'Failed to update branch' });
    }
});

// ---------------------------------------------------------------------------
// Membership lifecycle.
// ---------------------------------------------------------------------------
router.get('/:id/memberships', async (req: AuthRequest, res: Response) => {
    try {
        const branch = await readBranch(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        const scope = await authorizeTenantAdmin(req, res, branch.tenant_id);
        if (!scope) return;
        const rows = await query(
            `SELECT branch_id, user_id, role, status, version, created_at, updated_at
             FROM branch_memberships WHERE branch_id = ? ORDER BY created_at`,
            [branch.id],
        );
        res.json(rows);
    } catch (error) {
        console.error('List branch memberships error:', error);
        res.status(500).json({ error: 'Failed to list branch memberships' });
    }
});

router.post('/:id/memberships', async (req: AuthRequest, res: Response) => {
    try {
        const branch = await readBranch(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        const scope = await authorizeTenantAdmin(req, res, branch.tenant_id);
        if (!scope) return;
        const userId = typeof req.body?.user_id === 'string' ? req.body.user_id : '';
        const role = typeof req.body?.role === 'string' ? req.body.role : '';
        if (!userId || !MEMBERSHIP_ROLES.has(role)) {
            return res.status(400).json({ error: 'user_id and a valid role are required' });
        }
        const user = await queryOne<{ id: string }>('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await execute(
            `INSERT INTO branch_memberships (id, branch_id, user_id, role, status, version)
             VALUES (?, ?, ?, ?, 'active', 0)
             ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active', version = version + 1`,
            [randomUUID(), branch.id, userId, role],
        );
        await audit({
            tenantId: branch.tenant_id,
            branchId: branch.id,
            actorUserId: req.user!.id,
            action: 'branch.membership.upserted',
            resourceType: 'branch_membership',
            resourceId: userId,
            detail: { role },
        });
        res.status(201).json(await queryOne(
            'SELECT branch_id, user_id, role, status, version FROM branch_memberships WHERE branch_id = ? AND user_id = ?',
            [branch.id, userId],
        ));
    } catch (error) {
        console.error('Upsert branch membership error:', error);
        res.status(500).json({ error: 'Failed to update branch membership' });
    }
});

router.delete('/:id/memberships/:userId', async (req: AuthRequest, res: Response) => {
    try {
        const branch = await readBranch(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        const scope = await authorizeTenantAdmin(req, res, branch.tenant_id);
        if (!scope) return;
        // Revocation is a status/version change, never a row delete: the next
        // request re-reads the row and fails closed.
        const result = await execute(
            `UPDATE branch_memberships
             SET status = 'revoked', version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE branch_id = ? AND user_id = ?`,
            [branch.id, req.params.userId],
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Membership not found' });
        }
        await audit({
            tenantId: branch.tenant_id,
            branchId: branch.id,
            actorUserId: req.user!.id,
            action: 'branch.membership.revoked',
            resourceType: 'branch_membership',
            resourceId: req.params.userId,
        });
        res.json({ status: 'revoked' });
    } catch (error) {
        console.error('Revoke branch membership error:', error);
        res.status(500).json({ error: 'Failed to revoke branch membership' });
    }
});

export default router;
