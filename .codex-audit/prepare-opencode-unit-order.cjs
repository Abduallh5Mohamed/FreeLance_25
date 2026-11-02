'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const mailbox = createMailbox(root);
const previous = mailbox.call('task_status', { taskId: 'audit-20261026-fees-refresh-followup-01' });
if (previous.status !== 'reported') throw new Error('Fees follow-up still owned by worker');
const id = 'audit-20261026-unit-order-correction-01';
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'backend',
  role: 'opencode-unit-prerequisite-order-correction',
  batch: 'audit-20261026-E-unit-only',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['server/src/routes/course-units.ts', 'server/tests/m2-course-units.test.ts'],
  instructions: `Current human delegates remaining independent corrections to OpenCode under Codex review. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md, and only correction E in docs/agent-context/SUPERVISOR-REVIEW-2026-10-26.md and WORKBUDDY-CORRECTIONS-2026-10-26.md. WorkBuddy still owns M2-23 fifteen paths, especially server/src/routes/course-lessons.ts, server/tests/m2-lesson-release.test.ts and B15 contract: NEVER edit them or their helpers. This task is ONLY the disjoint unit PATCH part of E, exactly two allowed paths. In server/src/routes/course-units.ts PATCH /courses/:courseId/units/:unitId, display_order changes can move a prerequisite unit after its active dependent unit, or a dependent unit before its prerequisite, breaking the cross-unit learning path invariant (unit.display_order,unit.id,lesson.display_order,lesson.id). Current code checks active-to-archived only. Add a bounded transaction-scoped proof of the FINAL unit order before UPDATE for relevant ACTIVE prerequisite/dependent edges involving the moved unit, both incoming and outgoing; preserve tie ordering by unit id. If a relevant edge would be inverted, answer 409 without UPDATE or audit. Fail closed on unprovable/database errors; preserve server tenant/course authority and existing archive behavior. Avoid loading unbounded rows; an existence query for one invalid edge is preferable. Add real route/harness tests in server/tests/m2-course-units.test.ts for valid/invalid prerequisite-unit and dependent-unit moves, tie case, no-op, zero update/audit on rejection and rollback/commit behavior. Baseline unit suite was 73/73 on 2026-10-26 before your change; this count is not your evidence. Run that suite with .codex-audit/deny-external.cjs, nearby safe catalog tests if available, and server build. No Git or GitHub use including read-only status/diff/branch/log. No DB, migrations, providers, payments, installs, deployment or live services. Report exact commands/results after work stops via MCP; supervisor alone accepts.`,
  acceptance: [
    'PATCH cannot invert an active cross-unit prerequisite edge in either direction, including equal display_order tie by unit id.',
    'Safe reorder is accepted; no-op and archive semantics remain truthful; denial produces zero UPDATE and zero audit with transaction cleanup.',
    'Only the two allowed paths change, isolated route tests and server build pass, and no active WorkBuddy M2-23 path is touched.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Direct 2026-10-26 user request for OpenCode to implement remaining independently supervised gaps; unit PATCH prerequisite inversion reproduced in source review. Two paths are disjoint from WorkBuddy active M2-23 scope.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
const plan = mailbox.call('dispatch_plan', {});
if (!plan.ready.some(item => item.id === id)) throw new Error('Task queued but not ready; preserve task and inspect ownership');
console.log(JSON.stringify({ taskId: id, ready: true, activeCount: plan.active.length }));
