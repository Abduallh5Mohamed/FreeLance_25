'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const previous = 'audit-20261026-fees-workflow-correction-01';
const id = 'audit-20261026-fees-refresh-followup-01';
const mailbox = createMailbox(root);
const status = mailbox.call('task_status', { taskId: previous });
if (status.status !== 'reported') throw new Error('Predecessor has not reported');
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Follow-up already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'frontend',
  role: 'opencode-fees-refresh-followup',
  batch: 'audit-20261026-C-followup',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['src/pages/Fees.tsx', 'src/tests/fees-page-workflow.test.ts'],
  instructions: `Current human authorizes OpenCode under Codex supervision. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md and the correction C section of docs/agent-context/WORKBUDDY-CORRECTIONS-2026-10-26.md. Preserve the reported C payment amount and payment refresh fixes. The independent supervisor re-ran 15/15 fees tests, typecheck and build successfully, but REJECTS full C acceptance because the changed loadFeesFromDB now rethrows into unrelated mutation catch blocks. Exact reproduction in src/pages/Fees.tsx: handleApproveRequest at about line 270 awaits approveSubscriptionRequest (server mutation succeeds), then loadFeesFromDB rejects; its catch shows destructive error 'failed approving request' and does not close selection. handleDeleteFee at about line 360 similarly awaits deleteFee (server deletion succeeds), then loadFeesFromDB rejects; its catch shows 'failed deleting operation'. Expected: never report a confirmed approve/delete as a failed write; show a distinct saved/deleted-but-refresh-failed message, preserve honest stale list state, and do not auto-retry the mutation. Change only the two allowed paths. Extend the REAL page wiring test to exercise both callbacks through actual component handler binding and failed getFees, checking exactly one mutation each, correct success-with-refresh-warning, no false failure toast, no list update. Ensure normal success and mutation failure remain correct; no policy changes. No Git or GitHub use of any kind, including read-only commands. No DB, providers, payments, installs, migrations or deploy. Run fees page tests, frontend typecheck and build, report exact results, then stop and submit MCP report. Do not touch active WorkBuddy M2-23 files.`,
  acceptance: [
    'Confirmed approve plus failed fee-list refresh is not reported as failed approval and is not retried; stale list is not presented as refreshed.',
    'Confirmed delete plus failed fee-list refresh is not reported as failed deletion and is not retried; stale list is not presented as refreshed.',
    'Real page handler tests cover approve/delete success, refresh failure and mutation failure; payment C behavior stays green; frontend types and build pass.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Current direct user delegation of OpenCode corrections under Codex review. Independent 2026-10-26 review found a concrete side effect of correction C in two same-page mutation flows after predecessor reported and exited.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
const plan = mailbox.call('dispatch_plan', {});
if (!plan.ready.some(item => item.id === id)) throw new Error('Follow-up queued but not ready; inspect ownership');
console.log(JSON.stringify({ taskId: id, ready: true, activeCount: plan.active.length }));
