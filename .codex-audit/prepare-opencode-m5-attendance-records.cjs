'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const mailbox = createMailbox(root);
const previous = mailbox.call('task_status', { taskId: 'audit-20261026-sprint-attendance-hermetic-harness-01' });
if (previous.status !== 'reported') throw new Error('Previous owner has not reported');
const id = 'audit-20261026-m5-attendance-records-fixtures-01';
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'qa',
  role: 'opencode-m5-attendance-records-fixtures',
  batch: 'audit-20261026-m5-attendance-records-tests',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['server/tests/m5-attendance-records.test.ts'],
  instructions: `Edit local code/tests only. Never use Git or GitHub tools or commands, including read-only status/diff/log/branch. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md, the one allowed test file, and current server/src/routes/attendance-records.ts as read-only source of truth. Exact allowedPaths: server/tests/m5-attendance-records.test.ts ONLY. Supervisor independently ran node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m5-attendance-records.test.ts: 27 pass / 15 fail. Most expected successes or validation errors returned 403 because eligibleQuery(sql) in the test matches obsolete 'FROM students s LEFT JOIN', while the route's current lockEligibleStudentIds uses SELECT s.id FROM students s ... ORDER BY s.id ASC FOR UPDATE. The branch-membership denial test also asserts an obsolete unqualified group_id regex; current visibility uses schedule_sessions.group_id. The correction endpoint has separate stale fixture matching to investigate. Update fake data responders to recognize the actual bounded, parameterized SQL, supplying only the canonical eligible students needed by each case. Ensure fake data cannot grant eligibility or session authority for wrong tenant/group/student; assert the locking eligibility query and no write for denials. Preserve all 42 tests and substantive auth, tenant, exact-assignment, atomicity, audit, version race and denial assertions. Do not change production routes or weaken expectations to satisfy a fixture without tracing actual behavior. For each of the 15 failures, identify whether fixture shape or real behavior caused it; if real production defect, report it rather than masking it. No listener, external I/O, live DB, providers, payments, installs, migration or deploy. Run guarded target suite, guarded adjacent m1-attendance-calendar and m1-sprint-attendance-boundary suites, plus server build. Report exact commands/results, changes, limits via MCP; supervisor independently reviews before acceptance.`,
  acceptance: [
    'The m5 attendance-records suite runs all 42 cases against the actual route and fake database without external I/O or skipped assertions.',
    'Fixtures model current locking eligibility, exact group assignment and correction lookup; negative tenant/student/group tests still deny without writes.',
    'Guarded adjacent attendance suites and server build pass; only the one allowed test file changes.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Direct user authorization for OpenCode to repair local code under Codex review, without Git/GitHub. Supervisor reproduced 27 pass / 15 fail in one disjoint test file with external I/O denied.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
if (!mailbox.call('dispatch_plan', {}).ready.some(item => item.id === id)) throw new Error('Queued but not ready; preserve and inspect');
console.log(JSON.stringify({ taskId: id, ready: true }));
