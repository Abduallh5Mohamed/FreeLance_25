'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const mailbox = createMailbox(root);
if (mailbox.call('task_status', { taskId: 'audit-20261026-m5-attendance-records-fixtures-01' }).status !== 'reported') {
  throw new Error('Prior owner has not reported');
}
const id = 'audit-20261026-parent-views-live-enrollment-test-01';
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'qa',
  role: 'opencode-parent-views-live-enrollment-test',
  batch: 'audit-20261026-parent-views-contract',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['server/tests/m6-parent-views.test.ts'],
  instructions: `Local source/test work only. Never use Git or GitHub, even read-only status/diff/log. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md, server/tests/m6-parent-views.test.ts and the current createSqlParentViewsStore implementation in server/src/routes/parent-views.ts (read only). Exact allowedPaths: server/tests/m6-parent-views.test.ts ONLY. Supervisor reproduced one guarded failure in the parent views suite: test 'sql store: every read is tenant + enrollment scoped and issues no write' expects progress.params [enrollment-1, tenant-a, enrollment-1], actual [enrollment-1, tenant-a, enrollment-1, enrollment-1, tenant-a]. Current SQL adds an EXISTS on students ls proving the enrollment is live in the exact tenant. Update the test to assert this new server-side live-enrollment authority predicate and ordered five parameter binds; retain the existing no-write, tenant, course, published/archived and projection assertions. Add a narrow negative or SQL-contract assertion for live student eligibility/tenant as appropriate, without pretending the fake DB executes SQL. Do not change production source or dilute authorization assertions to merely match an array. Run guarded m6-parent-views, m6-parent-links and m6-lesson-discussions suites plus server build. No external I/O, DB, providers, payments, installs, migrations, deploy, Git/GitHub. Report exact result through MCP and stop; supervisor accepts only after independent review.`,
  acceptance: [
    'Parent views test asserts the current live enrollment EXISTS authority and five ordered binds, not just a changed parameter count.',
    'No production source or sibling tests change; all existing authorization/no-write assertions remain.',
    'Guarded three-suite command and server build pass.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'User authorized local OpenCode corrections under Codex supervision. Supervisor reproduced one disjoint stale test assertion under external-I/O denial; no Git/GitHub before conditional final approval.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
if (!mailbox.call('dispatch_plan', {}).ready.some(item => item.id === id)) throw new Error('Queued but not ready; preserve and inspect');
console.log(JSON.stringify({ taskId: id, ready: true }));
