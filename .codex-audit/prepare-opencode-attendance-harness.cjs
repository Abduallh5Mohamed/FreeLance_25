'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const mailbox = createMailbox(root);
if (mailbox.call('task_status', { taskId: 'audit-20261026-mount-test-contract-correction-01' }).status !== 'reported') {
  throw new Error('Mount correction still owned by worker');
}
const id = 'audit-20261026-attendance-hermetic-harness-01';
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'qa',
  role: 'opencode-attendance-hermetic-harness',
  batch: 'audit-20261026-attendance-tests',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['server/tests/m1-attendance-calendar.test.ts'],
  instructions: `Current human authorizes supervised OpenCode corrections. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md, then server/tests/m1-attendance-calendar.test.ts. Read server/src/routes/attendance.ts, server/src/middleware/auth.ts and server/tests/helpers/m2-harness.ts only as needed; they are NOT writable. Exact allowedPaths: test file only. Independent baseline with node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m1-attendance-calendar.test.ts: 9 pass / 9 fail. All nine route-level failures occur before route execution because this test's harness calls Server.listen(127.0.0.1), blocked by the isolated-suite external-I/O guard. The nine pure date tests pass. Convert ONLY this suite's HTTP listener/fetch harness to an in-process invocation of the REAL createAttendanceRouter and REAL auth middleware with its existing in-memory PrincipalRepository/fakeDb and injected clock. Preserve each existing date, duplicate, error, authorization and SQL binding assertion; do not skip tests or replace the route with a fake. Ensure request body/query/headers/params behavior is accurate enough to keep these tests meaningful; a local fake response may need Express methods. Assert no listener or network call is attempted. Use server/tests/helpers/m2-harness.ts as a read-only example; do not edit shared helpers. Run guarded attendance suite plus relevant nearby isolated attendance test if safe and server build. No production source changes, DB/provider/browser/services/payments, install/migration/deploy, or Git/GitHub commands even read-only. WorkBuddy M2-23 paths remain untouched. Report exact commands/results and any remaining limitations after stopping; supervisor alone accepts.`,
  acceptance: [
    'All 18 attendance-calendar tests run against the real route and injected clock without listener/fetch or external I/O under the denial guard.',
    'The nine route-level assertions retain their behavior/SQL checks and pass; no auth/tenant/branch boundary is weakened.',
    'Only the test file changes and server build passes.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Current direct user delegation for independent OpenCode fixes; Codex reproduced nine isolated attendance suite failures caused solely by loopback listener in the test harness. One disjoint test file only.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
if (!mailbox.call('dispatch_plan', {}).ready.some(item => item.id === id)) {
  throw new Error('Task queued but not ready; preserve task and inspect ownership');
}
console.log(JSON.stringify({ taskId: id, ready: true }));
