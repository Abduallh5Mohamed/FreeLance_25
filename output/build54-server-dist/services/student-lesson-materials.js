"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listStudentLessonMaterials = listStudentLessonMaterials;
const resource_branch_1 = require("../security/resource-branch");
const material_file_delivery_1 = require("./material-file-delivery");
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
/** Already-authorized lesson only. One connection, bounded rows and no URL projection. */
async function listStudentLessonMaterials(connection, scope, courseId, lessonId, principal, delivery) {
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_lesson_contents' LIMIT 16`);
    if (!['id', 'lesson_id', 'material_id', 'display_order'].every(name => columns.some(row => row.column_name === name))) {
        return { status: 503, body: { error: 'Lesson contents schema unavailable', code: 'LESSON_CONTENTS_UNAVAILABLE' }, commit: false };
    }
    const [bindings] = await connection.execute(`SELECT b.id AS content_id,b.material_id,b.display_order,m.id AS source_id,m.course_id,m.title,m.material_type,m.is_published
     FROM course_lesson_contents b LEFT JOIN course_materials m ON m.id=b.material_id AND m.course_id=?
     WHERE b.lesson_id=? ORDER BY b.display_order,b.id LIMIT 21`, [courseId, lessonId]);
    if (bindings.length > 20)
        return { status: 409, body: { error: 'Lesson contents require repair' }, commit: false };
    const rows = bindings.filter(row => row.source_id && (row.is_published === 1 || row.is_published === true || row.is_published === '1'));
    const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
    if (rows.some(row => !uuid.test(String(row.content_id)) || !uuid.test(String(row.material_id))
        || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 255
        || !['pdf', 'video', 'presentation', 'link', 'other'].includes(row.material_type)
        || !Number.isInteger(Number(row.display_order)) || Number(row.display_order) < 0 || Number(row.display_order) > 2147483647)
        || new Set(rows.map(row => String(row.content_id).toLowerCase())).size !== rows.length
        || new Set(rows.map(row => String(row.material_id).toLowerCase())).size !== rows.length
        || new Set(rows.map(row => Number(row.display_order))).size !== rows.length) {
        return { status: 409, body: { error: 'Lesson contents require repair' }, commit: false };
    }
    if (!rows.length)
        return { status: 200, body: { lesson_id: lessonId, contents: [] }, commit: false };
    const [enrollments] = await connection.execute('SELECT s.group_id FROM students s WHERE s.id=? AND s.user_id=? AND s.tenant_id=? LIMIT 1', [scope.enrollmentId, scope.userId, scope.tenantId]);
    const groupId = enrollments[0]?.group_id;
    if (!groupId)
        return { status: 200, body: { lesson_id: lessonId, contents: [] }, commit: false };
    const materialIds = rows.map(row => row.material_id);
    const [groupRows] = await connection.execute(`SELECT mg.material_id,mg.group_id,g.id AS resolved_group_id,g.branch_id,g.branch_scope,
            g.instructor_id,g.course_id AS group_course_id,c.tenant_id,
            br.id AS resolved_branch_id,br.tenant_id AS branch_tenant_id,br.status AS branch_status,br.version AS branch_version,
            bm.user_id AS member_user_id,bm.status AS member_status,bm.role AS member_role,bm.version AS member_version
     FROM material_groups mg LEFT JOIN \`groups\` g ON g.id=mg.group_id
     LEFT JOIN courses c ON c.id=g.course_id LEFT JOIN branches br ON br.id=g.branch_id
     LEFT JOIN branch_memberships bm ON bm.branch_id=br.id AND bm.user_id=?
     WHERE mg.material_id IN (${materialIds.map(() => '?').join(',')})
     ORDER BY mg.material_id,mg.group_id LIMIT 201`, [scope.userId, ...materialIds]);
    const links = groupRows;
    if (links.length > 200)
        return { status: 409, body: { error: 'Material scope exceeds verification limit' }, commit: false };
    // Feed bounded prefetched rows to the existing branch policy, rather than
    // introducing a second branch decision or one SQL lookup per material.
    const loader = (0, resource_branch_1.createSqlResourceScopeLoader)({
        queryOne: async (_sql, params) => {
            const row = rows.find(row => same(row.material_id, params?.[0]));
            return (row ? { id: row.material_id, course_id: row.course_id, tenant_id: scope.tenantId } : null);
        },
        query: async (_sql, params) => links.filter(row => same(row.material_id, params?.[0])),
    });
    const branchPrincipal = (0, resource_branch_1.principalFromAuthUser)(principal);
    const visible = [];
    for (const row of rows) {
        const groups = links.filter(link => same(link.material_id, row.material_id));
        if (!groups.some(link => same(link.group_id, groupId)) || groups.some(link => !link.resolved_group_id
            || !same(link.group_course_id, courseId) || link.tenant_id !== scope.tenantId))
            continue;
        const decision = await (0, resource_branch_1.resolveResourceBranchAccess)({
            loadResourceScope: loader,
            findBranch: async (branchId) => {
                const link = groups.find(link => same(link.resolved_branch_id, branchId));
                return link ? { id: link.resolved_branch_id, tenant_id: link.branch_tenant_id, status: link.branch_status, version: Number(link.branch_version) } : null;
            },
            findMembership: async (branchId, userId) => {
                const link = groups.find(link => same(link.branch_id, branchId) && link.member_user_id === userId);
                return link ? { branch_id: link.branch_id, user_id: link.member_user_id, role: link.member_role, status: link.member_status, version: Number(link.member_version) } : null;
            },
            // This surface is exactly student-only; it never grants an operator bypass.
            hasPlatformCapability: async () => false, isTenantOwner: async () => false,
        }, branchPrincipal, { resourceType: 'material', resourceId: row.material_id });
        if (decision.kind !== 'allowed')
            continue;
        visible.push({ content_id: String(row.content_id), title: String(row.title), material_type: String(row.material_type),
            display_order: Number(row.display_order), delivery_status: 'unavailable' });
    }
    const pdfIds = visible.filter(row => row.material_type === 'pdf').map(row => row.content_id);
    if (pdfIds.length && delivery?.reader && delivery.trustedScanner?.engine && delivery.trustedScanner.policyVersion) {
        const [sourceColumns] = await connection.execute(`SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_material_files' LIMIT 32`);
        if (material_file_delivery_1.MATERIAL_FILE_SOURCE_COLUMNS.every(name => sourceColumns.some(row => row.column_name === name))) {
            const [files] = await connection.execute(`SELECT b.id AS content_id,f.id,f.material_id,f.tenant_id,f.course_id,f.object_key,f.object_version,
        f.sha256,f.size_bytes,f.mime_type,f.status,f.scan_status,f.scanned_object_version,f.scanned_sha256,f.scan_engine,f.scan_policy_version,
        UNIX_TIMESTAMP(f.scanned_at) AS scanned_at_epoch,UNIX_TIMESTAMP() AS now_epoch
        FROM course_lesson_contents b INNER JOIN course_materials m ON m.id=b.material_id
        INNER JOIN course_material_files f ON f.material_id=m.id
        WHERE b.lesson_id=? AND b.id IN (${pdfIds.map(() => '?').join(',')}) AND m.course_id=? AND m.is_published=1 AND m.material_type='pdf'
          AND f.course_id=m.course_id AND f.tenant_id=? LIMIT 21`, [lessonId, ...pdfIds, courseId, scope.tenantId]);
            const sourceRows = files;
            if (sourceRows.length <= 20)
                for (const item of visible) {
                    const candidates = sourceRows.filter(row => same(row.content_id, item.content_id));
                    if (item.material_type === 'pdf' && candidates.length === 1 && (0, material_file_delivery_1.materialPdfEvidence)(candidates[0], { tenantId: scope.tenantId, courseId }, delivery))
                        item.delivery_status = 'pdf_available';
                }
        }
    }
    return { status: 200, body: { lesson_id: lessonId, contents: visible }, commit: false };
}
