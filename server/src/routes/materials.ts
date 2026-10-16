import { Router, Request, RequestHandler, Response } from 'express';
import { query, queryOne, execute } from '../db';
import https from 'https';
import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import { authenticateToken, optionalAuth, instructorScopeId, AuthRequest } from '../middleware/auth';
import { requireTeachingWrite } from '../middleware/teaching-access';
import { isSuperAdmin, getAdminPermissions } from '../security/admin-permissions';

/**
 * Data-access seam for the materials router. Production binds ../db; hermetic
 * tests inject isolated fixtures through the same boundary so the real
 * authorization logic runs without a database.
 */
export interface MaterialsDataAccess {
    query: typeof query;
    queryOne: typeof queryOne;
    execute: typeof execute;
}

/**
 * Injectable seams for the materials router. The default export binds the
 * production SQL adapters, the real authentication middleware, the real
 * teaching-entitlement guard, and the server-verified platform capability
 * check. Tests inject fixtures through this boundary instead of bypassing
 * production authorization.
 */
export interface MaterialsRouterDeps {
    db: MaterialsDataAccess;
    authenticate: RequestHandler;
    optionalAuthenticate: RequestHandler;
    requireTeachingWriteAccess: RequestHandler;
    hasVerifiedPlatformCapability: (userId: string) => Promise<boolean>;
}

/**
 * Verified platform capability, resolved server-side (active super_admin or a
 * seeded permission key). Never consults a JWT role claim.
 */
const verifiedPlatformCapability = async (userId: string): Promise<boolean> => {
    if (await isSuperAdmin(userId)) return true;
    return (await getAdminPermissions(userId)).includes('security.manage');
};

export const createMaterialsRouter = (deps: MaterialsRouterDeps): Router => {
    const router = Router();
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
    const materialInScope = async (
        materialId: string,
        scopeId: string,
        selectedTenantId: string,
    ): Promise<boolean> => {
        const row = await queryOne(
            `SELECT mg.material_id
             FROM material_groups mg
             INNER JOIN \`groups\` g ON mg.group_id = g.id
             INNER JOIN courses gc ON g.course_id = gc.id
             WHERE mg.material_id = ? AND g.instructor_id = ? AND gc.tenant_id = ?`,
            [materialId, scopeId, selectedTenantId]
        );
        return !!row;
    };

    const areGroupsInScope = async (
        groupIds: any[],
        scopeId: string,
        selectedTenantId: string,
    ): Promise<boolean> => {
        if (!Array.isArray(groupIds) || groupIds.length === 0) return false;
        const rows = await query<any>(
            `SELECT COUNT(*) AS cnt FROM \`groups\` g
             INNER JOIN courses gc ON g.course_id = gc.id
             WHERE g.instructor_id = ? AND gc.tenant_id = ? AND g.id IN (${groupIds.map(() => '?').join(',')})`,
            [scopeId, selectedTenantId, ...groupIds]
        );
        return rows[0]?.cnt === groupIds.length;
    };

    interface CourseTenantRow {
        tenant_id: string | null;
    }

    /**
     * Server-derived write scope for a course. The course's tenant must equal
     * the caller's server-derived selected tenant, and a course with no
     * provable tenant owner never matches. Exact instructor ownership of a
     * course in another tenant does not widen this boundary.
     */
    const courseWithinSelectedTenant = (
        course: CourseTenantRow,
        tenantId: string | undefined,
    ): boolean =>
        Boolean(tenantId) && course.tenant_id != null && String(course.tenant_id) === String(tenantId);

    /**
     * Write ownership for an existing material. The material's course tenant
     * must equal the caller's server-derived selected tenant; instructors may
     * additionally modify materials only when the material is linked to an
     * own group inside that same tenant. A missing material, and a material
     * whose course has no provable tenant owner, are indistinguishable from a
     * foreign material: both fail closed with 404. An instructor without any
     * server-derived selected tenant is denied before any lookup.
     */
    const denyMaterialWrite = async (
        materialId: string,
        req: AuthRequest,
        res: Response,
    ): Promise<boolean> => {
        const scopeId = instructorScopeId(req);
        const selectedTenantId = req.user?.tenantId;
        if (scopeId && !selectedTenantId) {
            res.status(403).json({ error: 'Workspace access required' });
            return true;
        }
        const row = await queryOne<{ tenant_id: string | null }>(
            `SELECT c.tenant_id
             FROM course_materials cm
             LEFT JOIN courses c ON cm.course_id = c.id
             WHERE cm.id = ?`,
            [materialId]
        );
        if (!row) {
            res.status(404).json({ error: 'Material not found' });
            return true;
        }
        if (row.tenant_id == null || String(row.tenant_id) !== String(selectedTenantId)) {
            res.status(404).json({ error: 'Material not found' });
            return true;
        }
        if (scopeId && !(await materialInScope(materialId, scopeId, selectedTenantId!))) {
            res.status(404).json({ error: 'Material not found' });
            return true;
        }
        return false;
    };

    interface CourseMaterial {
        id: string;
        course_id: string;
        title: string;
        description?: string;
        material_type: 'pdf' | 'video' | 'presentation' | 'link' | 'other';
        file_url?: string;
        file_size?: number;
        duration_minutes?: number;
        display_order?: number;
        is_free: boolean;
        is_published: boolean;
        created_at?: Date;
        updated_at?: Date;
    }

    // Get all materials (with optional course filter)
    router.get('/', authenticateToken, async (req: AuthRequest, res: Response) => {
        try {
            const { course_id } = req.query;
            const scopeId = instructorScopeId(req);
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
            const params: any[] = [];

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
                if (!req.user.studentEnrollmentId || !req.user.groupId) return res.status(403).json({ error: 'Select an instructor workspace first' });
                sql += ` AND EXISTS (SELECT 1 FROM material_groups student_mg
                                     WHERE student_mg.material_id=cm.id AND student_mg.group_id=?)`;
                params.push(req.user.groupId);
            } else if (!scopeId) {
                // Non-instructor identities must present a verified tenant scope;
                // a bare role claim is not one. Platform admins (verified
                // capability) keep cross-tenant visibility.
                if (await deps.hasVerifiedPlatformCapability(req.user!.id)) {
                    // verified platform admin: every tenant's materials
                } else if (req.user!.tenantId) {
                    sql += ` AND EXISTS (SELECT 1 FROM courses c2 WHERE c2.id = cm.course_id AND c2.tenant_id = ?)`;
                    params.push(req.user!.tenantId);
                } else {
                    return res.status(403).json({ error: 'Workspace access required' });
                }
            }

            sql += ' ORDER BY cm.display_order ASC, cm.created_at DESC';

            const materials = await query(sql, params);

            // Fetch group_ids for each material
            for (const material of materials) {
                const groups = await query(
                    'SELECT group_id FROM material_groups WHERE material_id = ?',
                    [material.id]
                );
                material.group_ids = groups.map((g: any) => g.group_id);
            }

            res.json(materials);
        } catch (error) {
            console.error('Get materials error:', error);
            res.status(500).json({ error: 'Failed to fetch materials' });
        }
    });

    // Get materials for a specific student based on their group
    router.get('/student/:userId', authenticateToken, async (req: AuthRequest, res: Response) => {
        try {
            const { userId } = req.params;
            if (req.user?.role !== 'student' || String(req.user.id) !== String(userId)
                || !req.user.studentEnrollmentId || !req.user.tenantId) {
                return res.status(403).json({ error: 'Student workspace access required' });
            }
            const student = await queryOne(
                `SELECT id,group_id,grade_id FROM students
                 WHERE id=? AND user_id=? AND tenant_id=? AND is_active=TRUE AND approval_status='approved'`,
                [req.user.studentEnrollmentId, req.user.id, req.user.tenantId]
            );

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
                const groups = await query(
                    'SELECT group_id FROM material_groups WHERE material_id = ?',
                    [material.id]
                );
                material.group_ids = groups.map((g: any) => g.group_id);
            }

            res.json(materials);
        } catch (error) {
            console.error('Get student materials error:', error);
            res.status(500).json({ error: 'Failed to fetch materials' });
        }
    });

    // Get material by ID
    router.get('/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            const selectedTenantId = req.user?.tenantId;
            if (scopeId && !selectedTenantId) {
                return res.status(403).json({ error: 'Workspace access required' });
            }
            const material = await queryOne(
                `SELECT
                    cm.*,
                    c.name as course_name,
                    c.subject as course_subject,
                    c.tenant_id as course_tenant_id
                FROM course_materials cm
                LEFT JOIN courses c ON cm.course_id = c.id
                WHERE cm.id = ?`,
                [req.params.id]
            );

            if (!material) {
                return res.status(404).json({ error: 'Material not found' });
            }
            if (scopeId) {
                // Instructor boundary: the material's course tenant must equal
                // the selected tenant (a course with no provable tenant fails
                // closed), and the group link must be an own group inside
                // that same tenant. Owning the group in another tenant is not
                // enough, and unknown ids stay indistinguishable (404).
                if (material.course_tenant_id == null
                    || String(material.course_tenant_id) !== String(selectedTenantId)
                    || !(await materialInScope(req.params.id, scopeId, selectedTenantId!))) {
                    return res.status(404).json({ error: 'Material not found' });
                }
            }
            if (req.user?.role === 'student') {
                if (!req.user.groupId) return res.status(403).json({ error: 'Select an instructor workspace first' });
                const assigned = await queryOne('SELECT 1 FROM material_groups WHERE material_id=? AND group_id=?', [req.params.id, req.user.groupId]);
                if (!assigned) return res.status(404).json({ error: 'Material not found' });
            } else if (!scopeId) {
                // Non-instructor identities need a verified scope: platform-admin
                // capability (server-verified) or an active tenant membership
                // whose tenant owns the material's course. Deny-by-default.
                if (await deps.hasVerifiedPlatformCapability(req.user!.id)) {
                    // verified platform admin
                } else if (req.user!.tenantId && material.course_tenant_id
                    && String(material.course_tenant_id) === String(req.user!.tenantId)) {
                    // tenant-scoped read
                } else {
                    return res.status(404).json({ error: 'Material not found' });
                }
            }

            res.json(material);
        } catch (error) {
            console.error('Get material error:', error);
            res.status(500).json({ error: 'Failed to fetch material' });
        }
    });

    // Create new material
    router.post('/', deps.requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            const scopeId = instructorScopeId(req);
            const selectedTenantId = req.user?.tenantId;
            if (scopeId && !selectedTenantId) {
                return res.status(403).json({ error: 'Workspace access required' });
            }
            const {
                course_id,
                title,
                description,
                material_type,
                file_url,
                file_size,
                duration_minutes,
                display_order = 0,
                is_free = false,
                is_published = true,
                grade_id,
                group_ids
            } = req.body;

            if (!course_id || !title || !material_type) {
                return res.status(400).json({
                    error: 'Course ID, title, and material type are required'
                });
            }

            // Instructors can only publish materials to their own groups
            // inside their selected tenant.
            if (scopeId && !(await areGroupsInScope(group_ids, scopeId, selectedTenantId!))) {
                return res.status(403).json({ error: 'يجب ربط المادة بمجموعة من مجموعاتك فقط' });
            }

            // The write target course must resolve to the caller's selected
            // tenant. A course with no provable tenant owner, or one belonging
            // to another tenant, fails closed before any write; exact course
            // ownership alone never crosses the boundary.
            const course = await queryOne<CourseTenantRow>(
                'SELECT tenant_id FROM courses WHERE id = ?',
                [course_id]
            );
            if (!course) {
                return res.status(404).json({ error: 'Course not found' });
            }
            if (!courseWithinSelectedTenant(course, selectedTenantId)) {
                return res.status(403).json({ error: 'Course is outside your teaching scope' });
            }

            // Video materials must reference an internally uploaded video.
            if (material_type === 'video' && (!file_url || !String(file_url).startsWith('video://'))) {
                return res.status(400).json({
                    error: 'External video links are not allowed. Upload the video to the platform.'
                });
            }

            // Generate UUID for the new material
            const materialId = crypto.randomUUID();

            const result = await execute(
                `INSERT INTO course_materials
                (id, course_id, title, description, material_type, file_url, file_size,
                 duration_minutes, display_order, is_free, is_published)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    materialId,
                    course_id,
                    title,
                    description || null,
                    material_type,
                    file_url || null,
                    file_size || null,
                    duration_minutes || null,
                    display_order,
                    is_free,
                    is_published
                ]
            );

            // Insert material-group relationships if group_ids provided
            if (group_ids && Array.isArray(group_ids) && group_ids.length > 0) {
                // Validate that all group_ids exist
                for (const groupId of group_ids) {
                    const groupExists = await queryOne(
                        'SELECT id FROM `groups` WHERE id = ? AND is_active = TRUE',
                        [groupId]
                    );

                    if (!groupExists) {
                        console.warn(`Group ${groupId} not found or inactive, skipping...`);
                        continue;
                    }

                    await execute(
                        'INSERT INTO material_groups (material_id, group_id) VALUES (?, ?)',
                        [materialId, groupId]
                    );
                }
            }

            const newMaterial = await queryOne(
                'SELECT * FROM course_materials WHERE id = ?',
                [materialId]
            );

            // Add grade_id and group_ids to response
            const materialWithGroups = {
                ...newMaterial,
                grade_id: grade_id || null,
                group_ids: group_ids || []
            };

            res.status(201).json(materialWithGroups);
        } catch (error: any) {
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
    router.put('/:id', deps.requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            if (await denyMaterialWrite(req.params.id, req, res)) return;
            const {
                title,
                description,
                material_type,
                file_url,
                file_size,
                duration_minutes,
                display_order,
                is_free,
                is_published
            } = req.body;

            const existingMaterial = await queryOne<any>('SELECT material_type,file_url FROM course_materials WHERE id=?', [req.params.id]);
            const finalType = material_type ?? existingMaterial?.material_type;
            const finalUrl = file_url ?? existingMaterial?.file_url;
            if (finalType === 'video' && (!finalUrl || !String(finalUrl).startsWith('video://'))) {
                return res.status(400).json({ error: 'External video links are not allowed. Upload the video to the platform.' });
            }

            const result = await execute(
                `UPDATE course_materials
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
                 WHERE id = ?`,
                [
                    title ?? null,
                    description ?? null,
                    material_type ?? null,
                    file_url ?? null,
                    file_size ?? null,
                    duration_minutes ?? null,
                    display_order ?? null,
                    is_free ?? null,
                    is_published ?? null,
                    req.params.id
                ]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Material not found' });
            }

            const updatedMaterial = await queryOne(
                'SELECT * FROM course_materials WHERE id = ?',
                [req.params.id]
            );

            res.json(updatedMaterial);
        } catch (error) {
            console.error('Update material error:', error);
            res.status(500).json({ error: 'Failed to update material' });
        }
    });

    // Delete material (soft delete by unpublishing)
    router.delete('/:id', deps.requireTeachingWriteAccess, async (req: AuthRequest, res: Response) => {
        try {
            if (await denyMaterialWrite(req.params.id, req, res)) return;
            const result = await execute(
                'UPDATE course_materials SET is_published = FALSE WHERE id = ?',
                [req.params.id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({ error: 'Material not found' });
            }

            res.json({ message: 'Material deleted successfully' });
        } catch (error) {
            console.error('Delete material error:', error);
            res.status(500).json({ error: 'Failed to delete material' });
        }
    });

    // Helper endpoint: Convert Google Drive sharing link to embeddable URL
    router.post('/convert-drive-url', async (req: Request, res: Response) => {
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
        } catch (error) {
            console.error('Convert URL error:', error);
            res.status(500).json({ error: 'Failed to convert URL' });
        }
    });

    // Stream video from Google Drive
    router.get('/stream/:fileId', async (req: Request, res: Response): Promise<void> => {
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
            https.get(driveUrl, (response: IncomingMessage) => {
                // Set appropriate headers for video streaming
                res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
                res.setHeader('Content-Length', response.headers['content-length'] || '');
                res.setHeader('Accept-Ranges', 'bytes');

                // Allow CORS
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

                response.pipe(res);
            }).on('error', (err: Error) => {
                console.error('Stream error:', err);
                res.status(500).json({ error: 'Failed to stream video' });
            });
        } catch (error) {
            console.error('Stream error:', error);
            res.status(500).json({ error: 'Failed to stream video' });
        }
    });

    // Get direct download URL for Google Drive files
    router.post('/get-stream-url', async (req: Request, res: Response) => {
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
        } catch (error) {
            console.error('Get stream URL error:', error);
            res.status(500).json({ error: 'Failed to get stream URL' });
        }
    });

    return router;
};

export default createMaterialsRouter({
    db: { query, queryOne, execute },
    authenticate: authenticateToken,
    optionalAuthenticate: optionalAuth,
    requireTeachingWriteAccess: requireTeachingWrite('materials'),
    hasVerifiedPlatformCapability: verifiedPlatformCapability,
});
