"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSeasonTemplateImport = parseSeasonTemplateImport;
exports.remapSeasonReferences = remapSeasonReferences;
exports.createSeasonTemplateImportRouter = createSeasonTemplateImportRouter;
const express_1 = require("express");
const crypto_1 = require("crypto");
const suspension_predicate_1 = require("../security/suspension-predicate");
const audit_log_1 = require("../services/audit-log");
const lesson_package_reuse_1 = require("../services/lesson-package-reuse");
const lesson_activities_1 = require("../services/lesson-activities");
const lesson_announcements_1 = require("../services/lesson-announcements");
const lesson_videos_1 = require("../services/lesson-videos");
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const exact = (x, keys) => !!x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
const hash = (x) => (0, crypto_1.createHash)('sha256').update(JSON.stringify(x)).digest('hex');
const validName = (x) => typeof x === 'string' && !!x.trim() && x.trim().length <= 120;
class Refusal extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
function refuse(status, code) { throw new Refusal(status, code); }
function parseSeasonTemplateImport(raw, apply = false) {
    if (!exact(raw, ['target_course_id', 'template_id', 'revision_number', 'name', 'rights_confirmed', 'mappings', ...(apply ? ['operation_id', 'review_token'] : [])]) || !uuid(raw.target_course_id) || !uuid(raw.template_id) || !Number.isInteger(raw.revision_number) || raw.revision_number < 1 || raw.revision_number > 2147483647 || !validName(raw.name) || raw.rights_confirmed !== true || !Array.isArray(raw.mappings) || raw.mappings.length < 1 || raw.mappings.length > 23 || apply && (!uuid(raw.operation_id) || typeof raw.review_token !== 'string' || !/^[a-f\d]{64}$/.test(raw.review_token)))
        refuse(400, 'TEMPLATE_IMPORT_INPUT');
    const mappings = raw.mappings.map(r => { if (!exact(r, ['kind', 'source_id', 'target_source_id']) || !lesson_package_reuse_1.packageKinds.includes(r.kind) || !uuid(r.source_id) || !uuid(r.target_source_id))
        refuse(400, 'TEMPLATE_IMPORT_INPUT'); return { kind: r.kind, source_id: r.source_id.toLowerCase(), target_source_id: r.target_source_id.toLowerCase() }; });
    if (new Set(mappings.map(r => r.kind + '/' + r.source_id)).size !== mappings.length || new Set(mappings.map(r => r.kind + '/' + r.target_source_id)).size !== mappings.length)
        refuse(400, 'TEMPLATE_IMPORT_INPUT');
    mappings.sort((a, b) => lesson_package_reuse_1.packageKinds.indexOf(a.kind) - lesson_package_reuse_1.packageKinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
    return { target_course_id: raw.target_course_id.toLowerCase(), template_id: raw.template_id.toLowerCase(), revision_number: raw.revision_number, name: raw.name.trim(), rights_confirmed: true, mappings, ...apply ? { operation_id: String(raw.operation_id).toLowerCase(), review_token: String(raw.review_token) } : {} };
}
function remapSeasonReferences(stored, mappings) {
    (0, lesson_package_reuse_1.validatePackageBindings)(stored, 'pinned import');
    if (stored.length !== mappings.length)
        refuse(409, 'TEMPLATE_MAPPING_INCOMPLETE');
    const desired = stored.map(r => { const m = mappings.find(x => x.kind === r.kind && x.source_id === r.source_id.toLowerCase()); if (!m)
        refuse(409, 'TEMPLATE_MAPPING_INCOMPLETE'); return { ...r, id: m.target_source_id, source_id: m.target_source_id }; });
    (0, lesson_package_reuse_1.validatePackageBindings)(desired, 'mapped import');
    return desired;
}
function receipt(raw) { const r = typeof raw === 'string' ? JSON.parse(raw) : raw; if (!exact(r, ['operation_id', 'target_course_id', 'target_template_id', 'source_template_id', 'source_revision', 'reference_count']) || ![r.operation_id, r.target_course_id, r.target_template_id, r.source_template_id].every(uuid) || !Number.isInteger(r.source_revision) || r.source_revision < 1 || !Number.isInteger(r.reference_count) || r.reference_count < 1 || r.reference_count > 23)
    throw Error('Invalid import receipt'); return r; }
function createSeasonTemplateImportRouter(deps) {
    const router = (0, express_1.Router)();
    const base = '/season-template-import';
    const handle = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user)
            return res.status(401).json({ code: 'SESSION_REQUIRED' });
        if (req.user.role === 'student' || req.user.identitySource === 'staff' || req.user.billingOnly || req.impersonation || req.headers['x-impersonation'] !== undefined)
            return res.status(403).json({ code: 'TEMPLATE_IMPORT_OWNER_REQUIRED' });
        const tenant = req.user.tenantId, actor = req.user.id;
        if (!tenant)
            return res.status(404).json({ code: 'TEMPLATE_IMPORT_NOT_FOUND' });
        const path = req.url.split('?')[0], applying = path === base + '/apply', reviewing = path === base + '/review';
        let body = null;
        try {
            if (Object.entries(req.params).some(([k, v]) => v !== undefined && (k === 'kind' ? !lesson_package_reuse_1.packageKinds.includes(v) : !uuid(v))) || Object.keys(req.query).some(k => !['after', 'revision_number'].includes(k)) || ['x-tenant-id', 'x-instructor-id', 'x-student-id'].some(k => req.headers[k] !== undefined))
                refuse(400, 'TEMPLATE_IMPORT_INPUT');
            if (req.method === 'POST') {
                if (Object.keys(req.query).length)
                    refuse(400, 'TEMPLATE_IMPORT_INPUT');
                body = parseSeasonTemplateImport(req.body, applying);
            }
            else if (req.body != null && !exact(req.body, []))
                refuse(400, 'TEMPLATE_IMPORT_INPUT');
            if (req.query.after !== undefined && (!uuid(req.query.after) || req.params.templateId || req.params.operationId))
                refuse(400, 'TEMPLATE_IMPORT_INPUT');
            if (req.query.revision_number !== undefined && (!req.params.templateId || typeof req.query.revision_number !== 'string' || !/^\d{1,10}$/.test(req.query.revision_number) || Number(req.query.revision_number) < 1 || Number(req.query.revision_number) > 2147483647) || req.params.templateId && !req.query.revision_number || req.params.operationId && Object.keys(req.query).length)
                refuse(400, 'TEMPLATE_IMPORT_INPUT');
        }
        catch {
            return res.status(400).json({ code: 'TEMPLATE_IMPORT_INPUT' });
        }
        let conn = null, open = false, commitAttempted = false, discard = false;
        try {
            conn = await deps.getConnection();
            const c = conn;
            await c.beginTransaction();
            open = true;
            async function rows(sql, p = []) { const [r] = await c.execute(sql, p); if (!Array.isArray(r))
                throw Error('Invalid rows'); return r; }
            const owner = await rows(`SELECT t.owner_user_id FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.id=? AND t.owner_user_id=? AND t.status='active' AND u.is_active=1 AND u.token_version=? AND NOT ${suspension_predicate_1.ACTIVE_SUSPENSION_PREDICATE_SQL.replace(/suspended_until/g, 'u.suspended_until')} LIMIT 1 FOR UPDATE`, [tenant, actor, req.user.tokenVersion ?? 0]);
            if (owner.length !== 1 || owner[0].owner_user_id !== actor)
                refuse(403, 'TEMPLATE_IMPORT_OWNER_REQUIRED');
            const tables = ['courses', 'course_units', 'course_lessons', 'users', 'tenants', 'season_course_reuse_operations', 'lesson_package_templates', 'lesson_package_template_revisions', 'lesson_package_template_references', 'season_template_import_operations', 'audit_events', 'audit_chain_head'];
            const engines = await rows(`SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')}) LIMIT 12`, tables);
            if (!tables.every(t => engines.some(r => r.name === t && r.engine === 'InnoDB')))
                refuse(503, 'TEMPLATE_IMPORT_UNAVAILABLE');
            const operationColumns = await rows("SELECT COLUMN_NAME AS col,DATA_TYPE AS type,IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='season_template_import_operations' LIMIT 12");
            if (!['tenant_id', 'operation_id', 'actor_user_id', 'source_template_id', 'source_revision', 'source_course_id', 'target_course_id', 'target_template_id', 'request_hash', 'result', 'created_at'].every(n => operationColumns.some(r => r.col === n && r.nullable === 'NO')) || !operationColumns.some(r => r.col === 'result' && r.type === 'json'))
                refuse(503, 'TEMPLATE_IMPORT_UNAVAILABLE');
            const indices = await rows("SELECT TABLE_NAME AS tbl,INDEX_NAME AS idx,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('season_template_import_operations','lesson_package_templates','lesson_package_template_revisions','lesson_package_template_references') AND NON_UNIQUE=0 LIMIT 40");
            for (const [tbl, idx, cols] of [['season_template_import_operations', 'PRIMARY', ['tenant_id', 'operation_id']], ['season_template_import_operations', 'uq_season_template_revision', ['tenant_id', 'target_course_id', 'source_template_id', 'source_revision']], ['lesson_package_templates', 'uq_lesson_template_name', ['tenant_id', 'course_id', 'name']], ['lesson_package_template_revisions', 'uq_template_revision_number', ['template_id', 'revision_number']], ['lesson_package_template_references', 'uq_template_reference', ['revision_id', 'kind', 'source_id']]]) {
                const r = indices.filter(x => x.tbl === tbl && x.idx === idx).sort((a, b) => a.seq - b.seq);
                if (r.length !== cols.length || cols.some((n, i) => r[i].col !== n || Number(r[i].seq) !== i + 1))
                    refuse(503, 'TEMPLATE_IMPORT_UNAVAILABLE');
            }
            const operationId = req.params.operationId?.toLowerCase() ?? body?.operation_id;
            const requestHash = applying ? hash(body) : null;
            if (operationId) {
                const saved = await rows('SELECT actor_user_id,request_hash,result FROM season_template_import_operations WHERE tenant_id=? AND operation_id=? LIMIT 1', [tenant, operationId]);
                if (saved.length) {
                    if (saved[0].actor_user_id !== actor || applying && saved[0].request_hash !== requestHash)
                        refuse(applying ? 409 : 404, 'TEMPLATE_IMPORT_OPERATION_CONFLICT');
                    const r = receipt(saved[0].result);
                    if (r.operation_id !== operationId)
                        throw Error('Wrong receipt');
                    return res.json({ operation: r });
                }
                if (!applying)
                    return res.json({ operation: null });
            }
            const targetId = body?.target_course_id ?? req.params.targetId;
            const contexts = await rows('SELECT op.source_course_id,c.id AS target_course_id,c.name AS target_name,s.name AS source_name FROM season_course_reuse_operations op JOIN courses c ON c.id=op.target_course_id AND c.tenant_id=op.tenant_id JOIN courses s ON s.id=op.source_course_id AND s.tenant_id=op.tenant_id WHERE op.tenant_id=? AND op.target_course_id=? AND c.is_active=1 AND c.publication_state=\'draft\' AND s.is_active=1 LIMIT 1 FOR UPDATE', [tenant, targetId]);
            if (contexts.length !== 1)
                refuse(404, 'TEMPLATE_IMPORT_NOT_FOUND');
            const context = contexts[0], sourceId = context.source_course_id;
            const after = String(req.query.after ?? '');
            async function kindReady(kind) { if (kind === 'material') {
                const e = await rows("SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='course_materials' LIMIT 1");
                if (e.length !== 1 || e[0].engine !== 'InnoDB')
                    refuse(503, 'TEMPLATE_IMPORT_SOURCE_UNAVAILABLE');
            } if (kind === 'video' && await (0, lesson_videos_1.lessonVideoSchema)(c) !== 'ready' || ['homework', 'quiz'].includes(kind) && !await (0, lesson_activities_1.lessonActivitySchemaReady)(c) || kind === 'announcement' && !await (0, lesson_announcements_1.lessonAnnouncementSchema)(c))
                refuse(503, 'TEMPLATE_IMPORT_SOURCE_UNAVAILABLE'); }
            if (req.params.kind) {
                const kind = req.params.kind;
                await kindReady(kind);
                let page;
                if (kind === 'quiz' || kind === 'homework') {
                    const v = await (0, lesson_activities_1.readLessonActivitySources)(c, kind, targetId, tenant, { cursor: after }, false);
                    page = { items: v.items.map(x => ({ id: x.source_id, title: x.title, state: x.source_status, audience: x.audience })), cursor: v.cursor };
                }
                else if (kind === 'announcement') {
                    const v = await (0, lesson_announcements_1.readLessonAnnouncementSources)(c, targetId, tenant, { cursor: after }, false);
                    page = { items: v.items.map(x => ({ id: x.id, title: x.title, state: x.state, audience: 'restricted' })), cursor: v.cursor };
                }
                else {
                    const found = kind === 'material' ? await rows('SELECT id FROM course_materials WHERE course_id=? AND id>? ORDER BY id LIMIT 26', [targetId, after]) : await rows("SELECT id FROM videos WHERE course_id=? AND tenant_id=? AND status='ready' AND id>? ORDER BY id LIMIT 26", [targetId, tenant, after]);
                    const items = [];
                    for (const r of found.slice(0, 25)) {
                        const v = await (0, lesson_package_reuse_1.readLessonPackageSource)(c, { id: r.id, source_id: r.id, kind, display_order: 0 }, targetId, tenant);
                        if (v)
                            items.push({ id: r.id, title: v.title, state: v.state, audience: v.audience });
                    }
                    page = { items, cursor: found.length > 25 ? found[24].id : null };
                }
                return res.json({ items: page.items, next_cursor: page.cursor });
            }
            if (!body && !req.params.templateId) {
                const list = await rows('SELECT id,name,head_revision FROM lesson_package_templates WHERE tenant_id=? AND course_id=? AND status=\'active\' AND id>? ORDER BY id LIMIT 26', [tenant, sourceId, after]);
                if (list.some(r => !uuid(r.id) || !validName(r.name) || !Number.isInteger(r.head_revision) || r.head_revision < 1))
                    throw Error('Invalid template list');
                return res.json({ items: list.slice(0, 25).map(r => ({ id: r.id, name: r.name, head_revision: r.head_revision })), next_cursor: list.length > 25 ? list[24].id : null });
            }
            const templateId = body?.template_id ?? req.params.templateId, revisionNumber = body?.revision_number ?? Number(req.query.revision_number);
            const headers = await rows('SELECT id,name,head_revision FROM lesson_package_templates WHERE id=? AND tenant_id=? AND course_id=? AND status=\'active\' LIMIT 1 FOR UPDATE', [templateId, tenant, sourceId]);
            if (headers.length !== 1)
                refuse(404, 'TEMPLATE_IMPORT_NOT_FOUND');
            const header = headers[0];
            const revs = await rows('SELECT id,source_lesson_id,reference_count,media_count,content_hash FROM lesson_package_template_revisions WHERE template_id=? AND tenant_id=? AND course_id=? AND revision_number=? LIMIT 1 FOR UPDATE', [templateId, tenant, sourceId, revisionNumber]);
            if (revs.length !== 1 || revisionNumber > header.head_revision)
                refuse(404, 'TEMPLATE_IMPORT_NOT_FOUND');
            const rev = revs[0];
            if (!uuid(rev.id) || !uuid(rev.source_lesson_id) || !validName(header.name) || !Number.isInteger(header.head_revision) || !Number.isInteger(rev.reference_count) || !Number.isInteger(rev.media_count))
                throw Error('Invalid pinned revision');
            const origin = await rows('SELECT l.id FROM course_lessons l JOIN course_units u ON u.id=l.unit_id WHERE l.id=? AND u.course_id=? AND l.status=\'active\' AND u.status=\'active\' LIMIT 1 FOR UPDATE', [rev.source_lesson_id, sourceId]);
            if (origin.length !== 1)
                refuse(409, 'TEMPLATE_IMPORT_ORIGIN_UNAVAILABLE');
            const saved = await rows('SELECT kind,source_id,display_order FROM lesson_package_template_references WHERE revision_id=? ORDER BY kind,display_order,id LIMIT 24 FOR UPDATE', [rev.id]);
            const stored = saved.map(r => ({ kind: r.kind, source_id: r.source_id, id: r.source_id, display_order: r.display_order }));
            (0, lesson_package_reuse_1.validatePackageBindings)(stored, 'import revision');
            stored.sort((a, b) => lesson_package_reuse_1.packageKinds.indexOf(a.kind) - lesson_package_reuse_1.packageKinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
            if (stored.length !== rev.reference_count || stored.filter(r => r.display_order !== null).length !== rev.media_count || hash(stored.map(r => ({ kind: r.kind, source_id: r.source_id, display_order: r.display_order }))) !== rev.content_hash)
                throw Error('Corrupt source revision');
            const facts = [], sourceItems = [];
            for (const r of stored) {
                await kindReady(r.kind);
                const value = await (0, lesson_package_reuse_1.readLessonPackageSource)(c, r, sourceId, tenant);
                if (!value)
                    refuse(409, 'TEMPLATE_IMPORT_SOURCE_UNAVAILABLE');
                facts.push(value.facts);
                sourceItems.push({ kind: r.kind, source_id: r.source_id, display_order: r.display_order, title: value.title, state: value.state, audience: value.audience });
            }
            if (!body)
                return res.json({ template_id: templateId, revision_number: revisionNumber, name: header.name, references: sourceItems });
            const desired = remapSeasonReferences(stored, body.mappings), items = [];
            for (let i = 0; i < desired.length; i++) {
                const value = await (0, lesson_package_reuse_1.readLessonPackageSource)(c, desired[i], targetId, tenant);
                if (!value)
                    refuse(409, 'TEMPLATE_IMPORT_TARGET_UNAVAILABLE');
                facts.push(value.facts);
                items.push({ ...sourceItems[i], target_source_id: desired[i].source_id, target_title: value.title, target_state: value.state, target_audience: value.audience });
            }
            const duplicates = await rows('SELECT id FROM lesson_package_templates WHERE tenant_id=? AND course_id=? AND name=? LIMIT 1 FOR UPDATE', [tenant, targetId, body.name]);
            if (duplicates.length)
                refuse(409, 'TEMPLATE_IMPORT_NAME_EXISTS');
            const reviewToken = hash([tenant, actor, context, header, rev, body.target_course_id, body.name, body.mappings, facts, items]);
            if (reviewing)
                return res.json({ target_course_id: targetId, template_id: templateId, revision_number: revisionNumber, name: body.name, items, review_token: reviewToken });
            if (body.review_token !== reviewToken)
                refuse(409, 'TEMPLATE_IMPORT_STALE');
            const previous = await rows('SELECT target_template_id FROM season_template_import_operations WHERE tenant_id=? AND target_course_id=? AND source_template_id=? AND source_revision=? LIMIT 1', [tenant, targetId, templateId, revisionNumber]);
            if (previous.length)
                refuse(409, 'TEMPLATE_IMPORT_ALREADY_IMPORTED');
            const newTemplate = (0, crypto_1.randomUUID)(), newRevision = (0, crypto_1.randomUUID)();
            await c.execute("INSERT INTO lesson_package_templates (id,tenant_id,course_id,name,status,head_revision,created_by) VALUES (?,?,?,?,'active',1,?)", [newTemplate, tenant, targetId, body.name, actor]);
            desired.sort((a, b) => lesson_package_reuse_1.packageKinds.indexOf(a.kind) - lesson_package_reuse_1.packageKinds.indexOf(b.kind) || a.source_id.localeCompare(b.source_id));
            await c.execute('INSERT INTO lesson_package_template_revisions (id,template_id,tenant_id,course_id,revision_number,source_lesson_id,created_by,reference_count,media_count,content_hash) VALUES (?,?,?,?,1,?,?,?,?,?)', [newRevision, newTemplate, tenant, targetId, rev.source_lesson_id, actor, desired.length, desired.filter(r => r.display_order !== null).length, hash(desired.map(r => ({ kind: r.kind, source_id: r.source_id, display_order: r.display_order })))]);
            for (const r of desired)
                await c.execute('INSERT INTO lesson_package_template_references (id,revision_id,kind,source_id,display_order) VALUES (?,?,?,?,?)', [(0, crypto_1.randomUUID)(), newRevision, r.kind, r.source_id, r.display_order]);
            const result = { operation_id: operationId, target_course_id: targetId, target_template_id: newTemplate, source_template_id: templateId, source_revision: revisionNumber, reference_count: desired.length };
            await (0, audit_log_1.recordSealedAuditEvent)({ query: rows, queryOne: async (sql, p) => (await rows(sql, p))[0] ?? null, execute: async (sql, p) => { const [r] = await c.execute(sql, p); return { affectedRows: Number(r.affectedRows) }; } }, { actorUserId: actor, tenantId: tenant, action: 'season.template_import', resourceType: 'lesson_package_template', resourceId: newTemplate, newValue: { source_template_id: templateId, source_revision: revisionNumber, target_course_id: targetId, reference_count: desired.length, rights_confirmed: true } });
            await c.execute('INSERT INTO season_template_import_operations (tenant_id,operation_id,actor_user_id,source_template_id,source_revision,source_course_id,target_course_id,target_template_id,request_hash,result) VALUES (?,?,?,?,?,?,?,?,?,?)', [tenant, operationId, actor, templateId, revisionNumber, sourceId, targetId, newTemplate, requestHash, JSON.stringify(result)]);
            commitAttempted = true;
            await c.commit();
            open = false;
            return res.status(201).json({ operation: result });
        }
        catch (e) {
            if (commitAttempted) {
                open = false;
                discard = true;
                return res.status(503).json({ code: 'PERSISTENCE_UNCERTAIN' });
            }
            if (e instanceof Refusal)
                return res.status(e.status).json({ code: e.code });
            return res.status(503).json({ code: applying ? 'PERSISTENCE_UNCERTAIN' : 'TEMPLATE_IMPORT_UNAVAILABLE' });
        }
        finally {
            if (conn) {
                if (open)
                    try {
                        await conn.rollback();
                    }
                    catch {
                        discard = true;
                    }
                try {
                    if (discard)
                        conn.destroy();
                    else
                        conn.release();
                }
                catch {
                    try {
                        conn.destroy();
                    }
                    catch { }
                }
            }
        }
    };
    router.get([base + '/targets/:targetId/templates', base + '/targets/:targetId/templates/:templateId', base + '/targets/:targetId/sources/:kind', base + '/operations/:operationId'], handle);
    router.post([base + '/review', base + '/apply'], handle);
    return router;
}
