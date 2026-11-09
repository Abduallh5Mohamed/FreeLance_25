"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.savedReturnSchema = savedReturnSchema;
exports.planHeader = planHeader;
exports.readPlanHead = readPlanHead;
exports.storedPlanSteps = storedPlanSteps;
exports.readPlanOperation = readPlanOperation;
exports.receiptDto = receiptDto;
exports.writeSavedPlan = writeSavedPlan;
const crypto_1 = require("crypto");
const audit_1 = require("../security/audit");
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const integer = (x) => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 2147483647;
const id = { type: 'char', length: 36 }, identity = { type: 'varchar', length: 64 }, version = { type: 'int' }, status = { type: 'enum', detail: "enum('active','withdrawn')" };
const specs = {
    course_return_plans: { id, tenant_id: identity, course_id: id, enrollment_id: identity, version, status, updated_at: { type: 'timestamp' } },
    course_return_plan_revisions: { plan_id: id, version, actor_user_id: identity, from_at: { type: 'datetime' }, to_at: { type: 'datetime' }, steps: { type: 'json' }, status, created_at: { type: 'timestamp' } },
    course_return_plan_operations: { tenant_id: identity, operation_id: id, actor_user_id: identity, course_id: id, enrollment_id: identity, request_hash: { type: 'char', length: 64 }, plan_id: id, version, status, created_at: { type: 'timestamp' } },
};
async function savedReturnSchema(c) {
    const tables = Object.keys(specs);
    const [columns] = await c.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type,COLUMN_TYPE AS column_type,CHARACTER_MAXIMUM_LENGTH AS max_length,IS_NULLABLE AS is_nullable,COLLATION_NAME AS collation_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?) LIMIT 80`, tables);
    if (!tables.every(t => Object.entries(specs[t]).every(([name, s]) => { const r = columns.find(r => r.table_name === t && r.column_name === name); return r && r.data_type === s.type && r.is_nullable === 'NO' && (s.length === undefined || Number(r.max_length) === s.length && r.collation_name === 'utf8mb4_bin') && (s.detail === undefined || String(r.column_type).toLowerCase() === s.detail); })))
        return false;
    const [engines] = await c.execute('SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?) LIMIT 3', tables);
    if (!tables.every(t => engines.some(r => r.table_name === t && r.engine === 'InnoDB')))
        return false;
    const [indexes] = await c.execute(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?) ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 20`, tables);
    for (const [t, name, cols] of [['course_return_plans', 'PRIMARY', ['id']], ['course_return_plans', 'uq_return_plan_scope', ['tenant_id', 'course_id', 'enrollment_id']], ['course_return_plan_revisions', 'PRIMARY', ['plan_id', 'version']], ['course_return_plan_operations', 'PRIMARY', ['tenant_id', 'operation_id']]]) {
        const rows = indexes.filter(r => r.table_name === t && r.index_name === name);
        if (rows.length !== cols.length || !cols.every((col, i) => rows[i].column_name === col && Number(rows[i].seq_in_index) === i + 1 && Number(rows[i].non_unique) === 0))
            return false;
    }
    const studentIndex = indexes.filter(r => r.table_name === 'course_return_plans' && r.index_name === 'ix_return_plan_student');
    if (studentIndex.length !== 4 || !['tenant_id', 'enrollment_id', 'status', 'id'].every((col, i) => studentIndex[i].column_name === col && Number(studentIndex[i].seq_in_index) === i + 1 && Number(studentIndex[i].non_unique) === 1))
        return false;
    const [keys] = await c.execute(`SELECT k.COLUMN_NAME AS column_name,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='course_return_plan_revisions' AND k.REFERENCED_TABLE_NAME IS NOT NULL LIMIT 2`);
    return keys.length === 1 && keys[0].column_name === 'plan_id' && keys[0].referenced_table === 'course_return_plans' && keys[0].referenced_column === 'id' && keys[0].delete_rule === 'RESTRICT';
}
function planHeader(row) { if (!row || !uuid(row.id) || !integer(row.version) || !['active', 'withdrawn'].includes(row.status))
    throw Error('Corrupt saved plan'); return { id: row.id, version: row.version, status: row.status }; }
async function readPlanHead(c, tenantId, courseId, enrollmentId) {
    const [rows] = await c.execute('SELECT id,version,status FROM course_return_plans WHERE tenant_id=? AND course_id=? AND enrollment_id=? LIMIT 2 FOR UPDATE', [tenantId, courseId, enrollmentId]);
    if (rows.length > 1)
        throw Error('Corrupt plan scope');
    return rows[0] ? planHeader(rows[0]) : null;
}
function storedPlanSteps(raw, status) {
    if (typeof raw === 'string' && raw.length > 1024)
        throw Error('Oversized plan');
    const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(rows) || rows.length > 3 || (status === 'active' ? rows.length < 1 : rows.length !== 0) || rows.some(s => !s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== 'lesson_id,minutes' || !uuid(s.lesson_id) || s.minutes !== null && (!integer(s.minutes) || s.minutes > 180)) || new Set(rows.map(s => s.lesson_id.toLowerCase())).size !== rows.length)
        throw Error('Corrupt saved steps');
    return rows;
}
async function readPlanOperation(c, tenantId, operationId) {
    const [rows] = await c.execute('SELECT actor_user_id,course_id,enrollment_id,request_hash,plan_id,version,status FROM course_return_plan_operations WHERE tenant_id=? AND operation_id=? LIMIT 2 FOR UPDATE', [tenantId, operationId]);
    if (rows.length > 1)
        throw Error('Corrupt receipt');
    const r = rows[0];
    if (!r)
        return null;
    planHeader({ id: r.plan_id, version: r.version, status: r.status });
    if (typeof r.request_hash !== 'string' || !/^[a-f\d]{64}$/.test(r.request_hash))
        throw Error('Corrupt receipt hash');
    return r;
}
function receiptDto(row, operationId) { return { operation_id: operationId, plan_id: row.plan_id, version: row.version, status: row.status }; }
async function writeSavedPlan(c, input) {
    const planId = input.head?.id ?? (0, crypto_1.randomUUID)(), next = (input.head?.version ?? 0) + 1;
    if (!integer(next))
        throw Error('Plan version overflow');
    storedPlanSteps(input.steps, input.status);
    const checked = async (sql, p) => { const [r] = await c.execute(sql, p); if (Number(r.affectedRows) !== 1)
        throw Error('Plan write not confirmed'); };
    if (input.head)
        await checked('UPDATE course_return_plans SET version=?,status=? WHERE id=? AND tenant_id=? AND course_id=? AND enrollment_id=? AND version=?', [next, input.status, planId, input.tenantId, input.courseId, input.enrollmentId, input.head.version]);
    else
        await checked('INSERT INTO course_return_plans (id,tenant_id,course_id,enrollment_id,version,status) VALUES (?,?,?,?,?,?)', [planId, input.tenantId, input.courseId, input.enrollmentId, next, input.status]);
    await checked('INSERT INTO course_return_plan_revisions (plan_id,version,actor_user_id,from_at,to_at,steps,status) VALUES (?,?,?,?,?,?,?)', [planId, next, input.userId, input.from.slice(0, 19).replace('T', ' '), input.to.slice(0, 19).replace('T', ' '), JSON.stringify(input.steps), input.status]);
    await (0, audit_1.recordAudit)(async (sql, p) => { await checked(sql, p); return { affectedRows: 1 }; }, { actorUserId: input.userId, tenantId: input.tenantId, action: input.status === 'active' ? 'course_return_plan.saved' : 'course_return_plan.withdrawn', resourceType: 'course_return_plan', resourceId: planId, newValue: { course_id: input.courseId, enrollment_id: input.enrollmentId, version: next, status: input.status, step_count: input.steps.length } });
    await checked('INSERT INTO course_return_plan_operations (tenant_id,operation_id,actor_user_id,course_id,enrollment_id,request_hash,plan_id,version,status) VALUES (?,?,?,?,?,?,?,?,?)', [input.tenantId, input.operationId, input.userId, input.courseId, input.enrollmentId, input.hash, planId, next, input.status]);
    return { operation_id: input.operationId, plan_id: planId, version: next, status: input.status };
}
