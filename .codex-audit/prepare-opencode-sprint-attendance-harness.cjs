'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const mailbox = createMailbox(root);
if (mailbox.call('task_status', { taskId: 'audit-20261026-attendance-hermetic-harness-01' }).status !== 'reported') {
  throw new Error('Prior attendance owner has not reported');
}
const id = 'audit-20261026-sprint-attendance-hermetic-harness-01';
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'qa',
  role: 'opencode-sprint-attendance-hermetic-harness',
  batch: 'audit-20261026-sprint-attendance-tests',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['server/tests/m1-sprint-attendance-boundary.test.ts'],
  instructions: `Current user is explicit: OpenCode edits local code/tests ONLY. Never use Git or GitHub tools or commands, including status/diff/log/branch and all remote operations. Codex supervises. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md and target test file. Read previous corrected server/tests/m1-attendance-calendar.test.ts as an example, plus current attendance/grades routes and auth/teaching-access seams only when needed. Exact allowedPaths: server/tests/m1-sprint-attendance-boundary.test.ts ONLY. Independent baseline under node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m1-sprint-attendance-boundary.test.ts is 0 pass / 29 fail, every failure at this suite's Server.listen(127.0.0.1) before route execution; no production behavior conclusion follows. Convert the loopback createServer/fetch harness to an in-process dispatcher of the REAL createAttendanceRouter and createGradesRouter with existing real injected auth, branch and teaching permissions, fakeDb and notification seam. Preserve all 29 meaningful assertions, exact request bodies/query/headers/status, JWT/tenant/branch checks, duplicate/write/SQL checks. Do not fake the routes, bypass middleware, skip tests or relax fail-closed behavior. Add a per-request no-listener/no-fetch assertion or equivalent guard so external I/O cannot silently return. Be careful with root paths carrying ?query: route path before '?' must normalize to '/'. Update the test header so it truthfully describes in-process execution. Do not modify production source/shared helpers/WorkBuddy M2-23 paths. No live DB/provider/payment/service, install/migration/deploy. Run the guarded target suite, guarded adjacent m1-attendance-calendar suite and server build. Report exact commands/results and any remaining limitation via MCP after stopping. Supervisor alone accepts.`,
  acceptance: [
    'All 29 original sprint attendance/grade tests exercise the real routers in-process without listener/fetch under the external-I/O denial guard.',
    'Auth/tenant/branch/teaching permission and SQL assertions remain substantive; no tests skipped and no production source changed.',
    'Guarded adjacent attendance-calendar suite and server build pass; only the one allowed test file changes.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Direct 2026-10-26 user authorization for OpenCode to fix remaining local code under Codex review, with no Git/GitHub. Codex independently reproduced 29 test harness listener failures under external-I/O guard; disjoint one-file test correction.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
if (!mailbox.call('dispatch_plan', {}).ready.some(item => item.id === id)) {
  throw new Error('Task queued but not ready; preserve task and inspect ownership');
}
console.log(JSON.stringify({ taskId: id, ready: true }));
