"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMaterialsRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const https_1 = __importDefault(require("https"));
const crypto_1 = __importDefault(require("crypto"));
const auth_1 = require("../middleware/auth");
const teaching_access_1 = require("../middleware/teaching-access");
const admin_permissions_1 = require("../security/admin-permissions");
const resource_branch_1 = require("../security/resource-branch");
const audit_1 = require("../security/audit");
const video_access_policy_1 = require("../security/video-access-policy");
/**
 * Verified platform capability, resolved server-side (active super_admin or a
 * seeded permission key). Never consults a JWT role claim.
 */
const verifiedPlatformCapability = async (userId) => {
    if (await (0, admin_permissions_1.isSuperAdmin)(userId))
        return true;
    return (await (0, admin_permissions_1.getAdminPermissions)(userId)).includes('security.manage');
};
const createMaterialsRouter = (deps) => {
    const router = (0, express_1.Router)();
    const { query, queryOne, execute } = deps.db;
    // Route wiring keeps production intent names; the bound functions come
    // from deps (production passes the real middleware; hermetic tests pass
    // the same middleware over injected fixture repositories).
    const authenticateToken = deps.authenticate;
    router.use(deps.optionalAuthenticate);
    /**
     * Material is linked to a group owned by the instructor AND that group
     * belongs to a course of the instructor's selected tenant. The `groups`
     * table carries no tenant column, so the group tenant is derived through
     * its course; a group without a course, or whose course has no tenant,
     * has no provable tenant and never matches (fail closed).
     */
    const materialInScope = async (materialId, scopeId, selectedTenantId) => {
        const row = await queryOne(`SELECT mg.material_id
             FROM material_groups mg
             INNER JOIN \`groups\` g ON mg.group_id = g.id
             INNER JOIN courses gc ON g.course_id = gc.id
             WHERE mg.material_id = ? AND g.instructor_id = ? AND gc.tenant_id = ?`, [materialId, scopeId, selectedTenantId]);
        return !!row;
    };
    const areGroupsInScope = async (groupIds, scopeId, selectedTenantId) => {
        if (!Array.isArray(groupIds) || groupIds.length === 0)
            return false;
        const rows = await query(`SELECT COUNT(*) AS cnt FROM \`groups\` g
             INNER JOIN courses gc ON g.course_id = gc.id
             WHERE g.instructor_id = ? AND gc.tenant_id = ? AND g.id IN (${groupIds.map(() => '?').join(',')})`, [scopeId, selectedTenantId, ...groupIds]);
        return rows[0]?.cnt === groupIds.length;
    };
    /**
     * Server-derived write scope for a course. The course's tenant must equal
     * the caller's server-derived selected tenant, and a course with no
     * provable tenant owner never matches. Exact instructor ownership of a
     * course in another tenant does not widen this boundary.
     */
    const courseWithinSelectedTenant = (course, tenantId) => Boolean(tenantId) && course.tenant_id != null && String(course.tenant_id) === String(tenantId);
    /**
     * Resource-derived branch check for an existing material. The branch comes
     * from material_groups -> groups, never from the request. A branch-owned
     * material requires a live membership in exactly that branch; conflicting
     * parent links are ambiguous and denied.
     */
    const enforceMaterialBranch = async (req, res, materialId, requestedBranchId) => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return false;
        }
        const decision = await (0, resource_branch_1.resolveResourceBranchAccess)(deps.branchAccess ?? (0, resource_branch_1.getResourceBranchDeps)(), (0, resource_branch_1.principalFromAuthUser)(req.user), { resourceType: 'material', resourceId: materialId, requestedBranchId });
        if (decision.kind !== 'allowed') {
            const denial = (0, resource_branch_1.resourceBranchDenial)(decision);
            res.status(denial.status).json(denial.body);
            return false;
        }
        return true;
    };
    /**
     * Validate the group links of a new material: every group must exist, all
     * branch-owned links must name the same branch, and the caller must be
     * authorized for that branch. A conflict is rejected before any insert.
     */
    const validateMaterialGroupsBranch = async (user, groupIds) => {
        if (!Array.isArray(groupIds) || groupIds.length === 0)
            return { ok: true };
        const rows = await query(`SELECT id, branch_id, branch_scope FROM \`groups\`
             WHERE id IN (${groupIds.map(() => '?').join(',')})`, groupIds);
        if (rows.length !== groupIds.length) {
            return { ok: false, status: 404, error: 'Group not found' };
        }
        const branches = new Set();
        for (const row of rows) {
            if (row.branch_scope === 'branch') {
                if (!row.branch_id)
                    return { ok: false, status: 403, error: 'Branch context is ambiguous' };
                branches.add(row.branch_id);
            }
        }
        if (branches.size > 1) {
            return { ok: false, status: 400, error: 'All groups of a material must belong to one branch' };
        }
        if (branches.size === 0)
            return { ok: true };
        const branchId = [...branches][0];
        const tenantId = user.tenantId;
        if (!tenantId)
            return { ok: false, status: 403, error: 'Workspace access required' };
        const branch = await queryOne('SELECT tenant_id, status FROM branches WHERE id = ?', [branchId]);
        if (!branch || branch.tenant_id !== tenantId || branch.status !== 'active') {
            return { ok: false, status: 403, error: 'Branch is outside your teaching scope' };
        }
        const owner = await queryOne("SELECT id FROM tenants WHERE id = ? AND owner_user_id = ? AND status = 'active'", [tenantId, user.id]);
        if (!owner) {
            const membership = await queryOne("SELECT id FROM branch_memberships WHERE branch_id = ? AND user_id = ? AND status = 'active'", [branchId, user.id]);
            if (!membership)
                return { ok: false, status: 403, error: 'Branch membership required' };
        }
        return { ok: true };
    };
    /**
     * Write ownership for an existing material. The material's course tenant
     * must equal the caller's server-derived selected tenant; instructors may
     * additionally modify materials only when the material is linked to an
     * own group inside that same tenant. A missing material, and a material
     * whose course has no provable tenant owner, are indistinguishable from a
     * foreign material: both fail closed with 404. An instructor without any
     * server-derived selected tenant is denied before any lookup.
     */
    const denyMaterialWrite = async (materialId, req, res) => {
        const scopeId = (0, auth_1.instructorScopeId)(req);
        const selectedTenantId = req.user?.tenantId;
        if (scopeId && !selectedTenantId) {
            res.status(403).json({ error: 'Workspace access required' });
            return true;
        }
        const row = await queryOne(`SELECT c.tenant_id
             FROM course_materials cm
             LEFT JOIN courses c ON cm.course_id = c.id
             WHERE cm.id = ?`, [materialId]);
        if (!row) {
            res.status(404).json({ error: 'Material not found' });
            return true;
        }
        if (row.tenant_id == null || String(row.tenant_id) !== String(selectedTenantId)) {
            res.status(404).json({ error: 'Material not found' });
            return true;
        }
        if (scopeId && !(await materialInScope(materialId, scopeId, selectedTenantId))) {
            res.status(404).json({ error: 'Material not found' });
            return true;
        }
        return false;
    };
    // Get all materials (with optional course filter)
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { course_id } = req.query;
            const scopeId = (0, auth_1.instructorScopeId)(req);
            const selectedTenantId = req.user?.tenantId;
            let sql = `
                SELECT
                    cm.*,
                    c.name as course_name,
                    c.subject as course_subject
                FROM course_materials cm
                LEFT JOIN courses c ON cm.course_id = c.id
                WHERE cm.is_published = TRUE
            `;
            const params = [];
            if (course_id && typeof course_id === 'string') {
                sql += ' AND cm.course_id = ?';
                params.push(course_id);
            }
            // Instructors act only inside their server-derived selected
            // tenant: an ambiguous, absent, or revoked selection is denied
            // before any data access. Inside the selection, the material's
            // course tenant must equal it, and a group used as the visibility
            // path must belong to an own group of a course in that tenant.
            // Owning a group or course in another tenant never widens the
            // boundary, and a course with no provable tenant fails closed.
            if (scopeId) {
                if (!selectedTenantId) {
                    return res.status(403).json({ error: 'Workspace access required' });
                }
                sql += ` AND (
                    c.tenant_id = ?
                    OR EXISTS (SELECT 1 FROM material_groups mg2
                               INNER JOIN \`groups\` g2 ON mg2.group_id = g2.id
                               INNER JOIN courses gc2 ON g2.course_id = gc2.id
                               WHERE mg2.material_id = cm.id AND g2.instructor_id = ? AND gc2.tenant_id = ?))`;
                params.push(selectedTenantId, scopeId, selectedTenantId);
            }
            if (req.user?.role === 'student') {
                if (!req.user.studentEnrollmentId || !req.user.groupId)
                    return res.status(403).json({ error: 'Select an instructor workspace first' });
                sql += ` AND EXISTS (SELECT 1 FROM material_groups student_mg
                                     WHERE student_mg.material_id=cm.id AND student_mg.group_id=?)`;
                params.push(req.user.groupId);
            }
            else if (!scopeId) {
                // Non-instructor identities must present a verified tenant scope;
                // a bare role claim is not one. Platform admins (verified
                // capability) keep cross-tenant visibility.
                if (await deps.hasVerifiedPlatformCapability(req.user.id)) {
                    // verified platform admin: every tenant's materials
                }
                else if (req.user.tenantId) {
                    sql += ` AND EXISTS (SELECT 1 FROM courses c2 WHERE c2.id = cm.course_id AND c2.tenant_id = ?)`;
                    params.push(req.user.tenantId);
                }
                else {
                    return res.status(403).json({ error: 'Workspace access required' });
                }
            }
            // Branch-owned materials are visible only to a live member of the
            // derived branch (or the tenant owner). Tenant-level and legacy
            // unassigned materials keep their existing exact-resource scope.
            const platformReader = req.user?.role === 'admin'
                && await deps.hasVerifiedPlatformCapability(req.user.id);
            if (!platformReader) {
                sql += ` AND NOT EXISTS (
                    SELECT 1 FROM material_groups bmg
                    INNER JOIN \`groups\` bg ON bg.id = bmg.group_id
                    WHERE bmg.material_id = cm.id AND bg.branch_scope = 'branch'
                      AND NOT EXISTS (
                        SELECT 1 FROM branch_memberships bm
                        WHERE bm.branch_id = bg.branch_id AND bm.user_id = ? AND bm.status = 'active'
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM tenants owner_t
                        WHERE owner_t.id = ? AND owner_t.owner_user_id = ? AND owner_t.status = 'active'
                      )
                )`;
                params.push(req.user.id, req.user.tenantId ?? null, req.user.id);
                if (req.user.branchId) {
                    sql += ` AND NOT EXISTS (
                        SELECT 1 FROM material_groups bmg2
                        INNER JOIN \`groups\` bg2 ON bg2.id = bmg2.group_id
                        WHERE bmg2.material_id = cm.id AND bg2.branch_scope = 'branch' AND bg2.branch_id <> ?
                    )`;
                    params.push(req.user.branchId);
                }
            }
            sql += ' ORDER BY cm.display_order ASC, cm.created_at DESC';
            const materials = await query(sql, params);
            // Fetch group_ids for each material
            for (const material of materials) {
                const groups = await query('SELECT group_id FROM material_groups WHERE material_id = ?', [material.id]);
                material.group_ids = groups.map((g) => g.group_id);
            }
            res.json(materials);
        }
        catch (error) {
            console.error('Get materials error:', error);
            res.status(500).json({ error: 'Failed to fetch materials' });
        }
    });
    // Get materials for a specific student based on their group
    router.get('/student/:userId', authenticateToken, async (req, res) => {
        try {
            const { userId } = req.params;
            if (req.user?.role !== 'student' || String(req.user.id) !== String(userId)
                || !req.user.studentEnrollmentId || !req.user.tenantId) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }
            const student = await queryOne(`SELECT id,group_id,grade_id FROM students
                 WHERE id=? AND user_id=? AND tenant_id=? AND is_active=TRUE AND approval_status='approved'`, [req.user.studentEnrollmentId, req.user.id, req.user.tenantId]);
            if (!student) {
                return res.json([]);
            }
            if (!student.group_id) {
                return res.json([]);
            }
            // Get all materials assigned to the student's group
            let sql = `
                SELECT DISTINCT
                    cm.*,
                    c.name as course_name,
                    c.subject as course_subject
                FROM course_materials cm
                LEFT JOIN courses c ON cm.course_id = c.id
                INNER JOIN material_groups mg ON cm.id = mg.material_id
                WHERE cm.is_published = TRUE
                    AND mg.group_id = ?
                ORDER BY cm.display_order ASC, cm.created_at DESC
            `;
            const materials = await query(sql, [student.group_id]);
            // Add group_ids to each material
            for (const material of materials) {
                const groups = await query('SELECT group_id FROM material_groups WHERE material_id = ?', [material.id]);
                material.group_ids = groups.map((g) => g.group_id);
            }
            res.json(materials);
        }
        catch (error) {
            console.error('Get student materials error:', error);
            res.status(500).json({ error: 'Failed to fetch materials' });
        }
    });
    // Get material by ID
    router.get('/:id', authenticateToken, async (req, res) => {
        try {
            const scopeId = (0, auth_1.instructorScopeId)(req);
            const selectedTenantId = req.user?.tenantId;
            if (scopeId && !selectedTenantId) {
                return res.status(403).json({ error: 'Workspace access required' });
            }
            const material = await queryOne(`SELECT
                    cm.*,
                    c.name as course_name,
                    c.subject as course_subject,
                    c.tenant_id as course_tenant_id
                FROM course_materials cm
                LEFT JOIN courses c ON cm.course_id = c.id
                WHERE cm.id = ?`, [req.params.id]);
            if (!material) {
                return res.status(404).json({ error: 'Material not found' });
            }
            if (!(await enforceMaterialBranch(req, res, req.params.id, req.query?.branch_id)))
                return;
            if (scopeId) {
                // Instructor boundary: the material's course tenant must equal
                // the selected tenant (a course with no provable tenant fails
                // closed), and the group link must be an own group inside
                // that same tenant. Owning the group in another tenant is not
                // enough, and unknown ids stay indistinguishable (404).
                if (material.course_tenant_id == null
                    || String(material.course_tenant_id) !== String(selectedTenantId)
                    || !(await materialInScope(req.params.id, scopeId, selectedTenantId))) {
                    return res.status(404).json({ error: 'Material not found' });
                }
            }
            if (req.user?.role === 'student') {
                if (!req.user.groupId)
                    return res.status(403).json({ error: 'Select an instructor workspace first' });
                const assigned = await queryOne('SELECT 1 FROM material_groups WHERE material_id=? AND group_id=?', [req.params.id, req.user.groupId]);
                if (!assigned)
                    return res.status(404).json({ error: 'Material not found' });
            }
            else if (!scopeId) {
                // Non-instructor identities need a verified scope: platform-admin
                // capability (server-verified) or an active tenant membership
                // whose tenant owns the material's course. Deny-by-default.
                if (await deps.hasVerifiedPlatformCapability(req.user.id)) {
                    // verified platform admin
                }
                else if (req.user.tenantId && material.course_tenant_id
                    && String(material.course_tenant_id) === String(req.user.tenantId)) {
                    // tenant-scoped read
                }
                else {
                    return res.status(404).json({ error: 'Material not found' });
                }
            }
            res.json(material);
        }
        catch (error) {
            console.error('Get material error:', error);
            res.status(500).json({ error: 'Failed to fetch material' });
        }
    });
    // Create new material
    router.post('/', deps.requireTeachingWriteAccess, async (req, res) => {
        try {
            const scopeId = (0, auth_1.instructorScopeId)(req);
            const selectedTenantId = req.user?.tenantId;
            if (scopeId && !selectedTenantId) {
                return res.status(403).json({ error: 'Workspace access required' });
            }
            const { course_id, title, description, material_type, file_url, file_size, duration_minutes, display_order = 0, is_free = false, is_published = true, grade_id, group_ids } = req.body;
            if (!course_id || !title || !material_type) {
                return res.status(400).json({
                    error: 'Course ID, title, and material type are required'
                });
            }
            // Instructors can only publish materials to their own groups
            // inside their selected tenant.
            if (scopeId && !(await areGroupsInScope(group_ids, scopeId, selectedTenantId))) {
                return res.status(403).json({ error: 'يجب ربط المادة بمجموعة من مجموعاتك فقط' });
            }
            // Branch links must agree and must be authorized before the write.
            const branchValidation = await validateMaterialGroupsBranch(req.user, group_ids);
            if (!branchValidation.ok) {
                return res.status(branchValidation.status).json({ error: branchValidation.error });
            }
            if (req.body.branch_id !== undefined && req.body.branch_id !== null && req.body.branch_id !== '') {
                // A material's branch is derived from its groups; a bare
                // selector is not a way to assign one.
                if (!Array.isArray(group_ids) || group_ids.length === 0) {
                    return res.status(403).json({ error: 'Branch is derived from the linked groups' });
                }
            }
            // The write target course must resolve to the caller's selected
            // tenant. A course with no provable tenant owner, or one belonging
            // to another tenant, fails closed before any write; exact course
            // ownership alone never crosses the boundary.
            const course = await queryOne('SELECT tenant_id FROM courses WHERE id = ?', [course_id]);
            if (!course) {
                return res.status(404).json({ error: 'Course not found' });
            }
            if (!courseWithinSelectedTenant(course, selectedTenantId)) {
                return res.status(403).json({ error: 'Course is outside your teaching scope' });
            }
            // Video materials must reference an internally uploaded video, in
            // the ONE canonical `video://<id>` form (no whitespace, non-empty
            // id). A non-canonical value is refused before any write and is
            // never stored raw.
            if (material_type === 'video') {
                const videoReference = (0, video_access_policy_1.parseVideoReference)(String(file_url ?? ''));
                if (!videoReference.ok) {
                    return res.status(400).json({
                        error: videoReference.reason === 'not-a-reference'
                            ? 'External video links are not allowed. Upload the video to the platform.'
                            : 'Video link is not a canonical platform video reference',
                    });
                }
            }
            // Generate UUID for the new material
            const materialId = crypto_1.default.randomUUID();
            // A `video://` link is only written after the video is proven to
            // exist, belong to this workspace and be usable by the caller, and
            // to be unbound elsewhere. The check and the INSERT share one
            // transaction so the video row lock covers the write.
            const insertMaterial = async (writer) => {
                let storedFileUrl = file_url || null;
                if (material_type === 'video') {
                    const binding = await (0, video_access_policy_1.validateVideoBinding)({
                        reader: writer,
                        videoUrl: String(file_url),
                        actorUserId: req.user?.id ?? '',
                        actorTenantId: selectedTenantId,
                        actorStudentEnrollmentId: req.user?.studentEnrollmentId,
                        selfId: materialId,
                        target: 'material',
                        // The destination is this material's course, already
                        // proven to sit in the caller's selected tenant.
                        targetCourseId: course_id,
                        hasPlatformCapability: deps.hasVerifiedPlatformCapability,
                    });
                    if (!binding.ok)
                        return { kind: 'denied', binding };
                    storedFileUrl = binding.videoUrl;
                }
                await writer.execute(`INSERT INTO course_materials                (id, course_id, title, description, material_type, file_url, file_size,
                 duration_minutes, display_order, is_free, is_published)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    materialId,
                    course_id,
                    title,
                    description || null,
                    material_type,
                    storedFileUrl,
                    file_size || null,
                    duration_minutes || null,
                    display_order,
                    is_free,
                    is_published
                ]);
                return { kind: 'inserted' };
            };
            const writeOutcome = deps.transaction
                ? await deps.transaction(insertMaterial)
                : await insertMaterial(deps.db);
            if (writeOutcome.kind === 'denied') {
                return res.status(writeOutcome.binding.status).json({
                    error: writeOutcome.binding.error,
                    code: writeOutcome.binding.code,
                });
            }
            // Insert material-group relationships if group_ids provided
            if (group_ids && Array.isArray(group_ids) && group_ids.length > 0) {
                // Validate that all group_ids exist
                for (const groupId of group_ids) {
                    const groupExists = await queryOne('SELECT id FROM `groups` WHERE id = ? AND is_active = TRUE', [groupId]);
                    if (!groupExists) {
                        console.warn(`Group ${groupId} not found or inactive, skipping...`);
                        continue;
                    }
                    await execute('INSERT INTO material_groups (material_id, group_id) VALUES (?, ?)', [materialId, groupId]);
                }
            }
            const newMaterial = await queryOne('SELECT * FROM course_materials WHERE id = ?', [materialId]);
            await (0, audit_1.recordAudit)(execute, {
                actorUserId: req.user?.id ?? null,
                tenantId: selectedTenantId ?? null,
                action: 'material.create',
                resourceType: 'material',
                resourceId: materialId,
                newValue: (0, audit_1.snapshotRow)({
                    course_id, title, description, material_type, file_url, file_size,
                    duration_minutes, display_order, is_free, is_published,
                }),
            }).catch((auditError) => console.error('Material create audit failed:', auditError));
            // Add grade_id and group_ids to response
            const materialWithGroups = {
                ...newMaterial,
                grade_id: grade_id || null,
                group_ids: group_ids || []
            };
            res.status(201).json(materialWithGroups);
        }
        catch (error) {
            console.error('Create material error:', error);
            console.error('Error details:', {
                message: error.message,
                code: error.code,
                sqlMessage: error.sqlMessage,
                sql: error.sql
            });
            res.status(500).json({
                error: 'Failed to create material',
                details: error.message
            });
        }
    });
    // Update material
    router.put('/:id', deps.requireTeachingWriteAccess, async (req, res) => {
        try {
            if (!(await enforceMaterialBranch(req, res, req.params.id, req.body?.branch_id)))
                return;
            if (await denyMaterialWrite(req.params.id, req, res))
                return;
            const { title, description, material_type, file_url, file_size, duration_minutes, display_order, is_free, is_published } = req.body;
            const existingMaterial = await queryOne('SELECT material_type,file_url FROM course_materials WHERE id=?', [req.params.id]);
            const finalType = material_type ?? existingMaterial?.material_type;
            const finalUrl = file_url ?? existingMaterial?.file_url;
            if (finalType === 'video') {
                if (!finalUrl || !String(finalUrl).startsWith('video://')) {
                    return res.status(400).json({ error: 'External video links are not allowed. Upload the video to the platform.' });
                }
                // A NEW reference must be canonical; an unchanged legacy value
                // is left alone (no silent rewrite, documented legacy gap).
                if (file_url !== undefined) {
                    const videoReference = (0, video_access_policy_1.parseVideoReference)(String(file_url));
                    if (!videoReference.ok) {
                        return res.status(400).json({
                            error: videoReference.reason === 'not-a-reference'
                                ? 'External video links are not allowed. Upload the video to the platform.'
                                : 'Video link is not a canonical platform video reference',
                        });
                    }
                }
            }
            // Only a NEW association is validated: an update that keeps the
            // stored video reference is not a re-bind.
            const writesNewVideoBinding = finalType === 'video' && (file_url !== undefined
                ? String(finalUrl) !== String(existingMaterial?.file_url ?? '')
                : existingMaterial?.material_type !== 'video');
            const updateMaterial = async (writer) => {
                let storedFileUrl = file_url;
                if (writesNewVideoBinding) {
                    const binding = await (0, video_access_policy_1.validateVideoBinding)({
                        reader: writer,
                        videoUrl: String(finalUrl),
                        actorUserId: req.user?.id ?? '',
                        actorTenantId: req.user?.tenantId,
                        actorStudentEnrollmentId: req.user?.studentEnrollmentId,
                        selfId: req.params.id,
                        target: 'material',
                        // Destination is the material's own course; the
                        // validator reads it from the row in this transaction.
                        hasPlatformCapability: deps.hasVerifiedPlatformCapability,
                    });
                    if (!binding.ok)
                        return { kind: 'denied', binding };
                    storedFileUrl = binding.videoUrl;
                }
                const updated = await writer.execute(`UPDATE course_materials
                 SET title = COALESCE(?, title),
                     description = COALESCE(?, description),
                     material_type = COALESCE(?, material_type),
                     file_url = COALESCE(?, file_url),
                     file_size = COALESCE(?, file_size),
                     duration_minutes = COALESCE(?, duration_minutes),
                     display_order = COALESCE(?, display_order),
                     is_free = COALESCE(?, is_free),
                     is_published = COALESCE(?, is_published),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`, [
                    title ?? null,
                    description ?? null,
                    material_type ?? null,
                    storedFileUrl ?? null,
                    file_size ?? null,
                    duration_minutes ?? null,
                    display_order ?? null,
                    is_free ?? null,
                    is_published ?? null,
                    req.params.id
                ]);
                return { kind: 'updated', updated };
            };
            const updateOutcome = deps.transaction
                ? await deps.transaction(updateMaterial)
                : await updateMaterial(deps.db);
            if (updateOutcome.kind === 'denied') {
                return res.status(updateOutcome.binding.status).json({
                    error: updateOutcome.binding.error,
                    code: updateOutcome.binding.code,
                });
            }
            const result = updateOutcome.updated;
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Material not found' });
            }
            await (0, audit_1.recordAudit)(execute, {
                actorUserId: req.user?.id ?? null,
                tenantId: req.user?.tenantId ?? null,
                action: 'material.update',
                resourceType: 'material',
                resourceId: req.params.id,
                oldValue: (0, audit_1.snapshotRow)(existingMaterial),
                newValue: (0, audit_1.snapshotRow)({
                    title, description, material_type, file_url, file_size,
                    duration_minutes, display_order, is_free, is_published,
                }),
            }).catch((auditError) => console.error('Material update audit failed:', auditError));
            const updatedMaterial = await queryOne('SELECT * FROM course_materials WHERE id = ?', [req.params.id]);
            res.json(updatedMaterial);
        }
        catch (error) {
            console.error('Update material error:', error);
            res.status(500).json({ error: 'Failed to update material' });
        }
    });
    // Delete material (soft delete by unpublishing)
    router.delete('/:id', deps.requireTeachingWriteAccess, async (req, res) => {
        try {
            if (!(await enforceMaterialBranch(req, res, req.params.id)))
                return;
            if (await denyMaterialWrite(req.params.id, req, res))
                return;
            const result = await execute('UPDATE course_materials SET is_published = FALSE WHERE id = ?', [req.params.id]);
            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Material not found' });
            }
            await (0, audit_1.recordAudit)(execute, {
                actorUserId: req.user?.id ?? null,
                tenantId: req.user?.tenantId ?? null,
                action: 'material.archive',
                resourceType: 'material',
                resourceId: req.params.id,
                newValue: { is_published: false },
            }).catch((auditError) => console.error('Material archive audit failed:', auditError));
            res.json({ message: 'Material deleted successfully' });
        }
        catch (error) {
            console.error('Delete material error:', error);
            res.status(500).json({ error: 'Failed to delete material' });
        }
    });
    // Helper endpoint: Convert Google Drive sharing link to embeddable URL
    router.post('/convert-drive-url', async (req, res) => {
        return res.status(410).json({ error: 'External video links are disabled. Upload videos to the platform.' });
        /* legacy document-link helper intentionally unreachable for video */
        try {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ error: 'URL is required' });
            }
            // Extract file ID from Google Drive URL
            // Supports formats:
            // - https://drive.google.com/file/d/FILE_ID/view
            // - https://drive.google.com/open?id=FILE_ID
            // - https://drive.google.com/uc?id=FILE_ID
            let fileId = null;
            const patterns = [
                /\/file\/d\/([a-zA-Z0-9_-]+)/,
                /[?&]id=([a-zA-Z0-9_-]+)/,
                /\/d\/([a-zA-Z0-9_-]+)/
            ];
            for (const pattern of patterns) {
                const match = url.match(pattern);
                if (match && match[1]) {
                    fileId = match[1];
                    break;
                }
            }
            if (!fileId) {
                return res.status(400).json({
                    error: 'Could not extract file ID from Google Drive URL'
                });
            }
            // Return embeddable URL
            const embedUrl = `https://drive.google.com/file/d/${fileId}/preview`;
            res.json({
                fileId,
                embedUrl,
                originalUrl: url
            });
        }
        catch (error) {
            console.error('Convert URL error:', error);
            res.status(500).json({ error: 'Failed to convert URL' });
        }
    });
    // Stream video from Google Drive
    router.get('/stream/:fileId', async (req, res) => {
        res.status(410).json({ error: 'External video streaming is disabled. Upload videos to the platform.' });
        return;
        /* legacy implementation intentionally unreachable */
        try {
            const { fileId } = req.params;
            if (!fileId) {
                res.status(400).json({
                    error: 'File ID is required'
                });
                return;
            }
            // Google Drive export URL for video streaming
            const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
            // Forward the request to Google Drive
            https_1.default.get(driveUrl, (response) => {
                // Set appropriate headers for video streaming
                res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
                res.setHeader('Content-Length', response.headers['content-length'] || '');
                res.setHeader('Accept-Ranges', 'bytes');
                // Allow CORS
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
                response.pipe(res);
            }).on('error', (err) => {
                console.error('Stream error:', err);
                res.status(500).json({ error: 'Failed to stream video' });
            });
        }
        catch (error) {
            console.error('Stream error:', error);
            res.status(500).json({ error: 'Failed to stream video' });
        }
    });
    // Get direct download URL for Google Drive files
    router.post('/get-stream-url', async (req, res) => {
        return res.status(410).json({ error: 'External video stream URLs are disabled. Upload videos to the platform.' });
        /* legacy implementation intentionally unreachable */
        try {
            const { file_url } = req.body;
            if (!file_url) {
                return res.status(400).json({
                    error: 'File URL is required'
                });
            }
            // Extract file ID
            let fileId = null;
            const patterns = [
                /\/file\/d\/([a-zA-Z0-9_-]+)/,
                /[?&]id=([a-zA-Z0-9_-]+)/,
                /\/d\/([a-zA-Z0-9_-]+)/
            ];
            for (const pattern of patterns) {
                const match = file_url.match(pattern);
                if (match && match[1]) {
                    fileId = match[1];
                    break;
                }
            }
            if (!fileId) {
                return res.status(400).json({
                    error: 'Could not extract file ID from Google Drive URL'
                });
            }
            // Return streaming URL (our proxy endpoint)
            const streamUrl = `/api/materials/stream/${fileId}`;
            // Also return direct Google Drive export URL
            const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
            res.json({
                fileId,
                streamUrl,
                directUrl,
                originalUrl: file_url
            });
        }
        catch (error) {
            console.error('Get stream URL error:', error);
            res.status(500).json({ error: 'Failed to get stream URL' });
        }
    });
    return router;
};
exports.createMaterialsRouter = createMaterialsRouter;
exports.default = (0, exports.createMaterialsRouter)({
    db: { query: db_1.query, queryOne: db_1.queryOne, execute: db_1.execute },
    authenticate: auth_1.authenticateToken,
    optionalAuthenticate: auth_1.optionalAuth,
    requireTeachingWriteAccess: (0, teaching_access_1.requireTeachingWrite)('materials'),
    hasVerifiedPlatformCapability: verifiedPlatformCapability,
    transaction: async (fn) => {
        const pool = (0, db_1.getPool)();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const txDb = {
                query: (sql, params) => connection.query(sql, params).then((res) => res[0]),
                queryOne: async (sql, params) => {
                    const [rows] = await connection.query(sql, params);
                    return rows[0] ?? null;
                },
                execute: (sql, params) => connection.execute(sql, params).then((res) => {
                    const header = res[0];
                    const affectedRows = header.affectedRows;
                    if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
                        throw new Error('materials transaction execute did not report a usable affected-row count');
                    }
                    return {
                        insertId: typeof header.insertId === 'number' && Number.isSafeInteger(header.insertId) ? header.insertId : 0,
                        affectedRows,
                    };
                }),
            };
            const result = await fn(txDb);
            await connection.commit();
            return result;
        }
        catch (error) {
            await connection.rollback();
            throw error;
        }
        finally {
            connection.release();
        }
    },
});
