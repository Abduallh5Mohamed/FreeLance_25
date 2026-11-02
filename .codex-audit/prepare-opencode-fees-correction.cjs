'use strict';
const fs = require('node:fs');
const path = require('node:path');
const bridgeRoot = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(bridgeRoot, 'mailbox-core.cjs'));
const id = 'audit-20261026-fees-workflow-correction-01';
const taskFile = path.join(bridgeRoot, 'tasks', `${id}.json`);
const stateFile = path.join(bridgeRoot, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists; inspect before another dispatch');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'frontend',
  role: 'opencode-fees-correction',
  batch: 'audit-20261026-C',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: [
    'src/features/fees/payment-workflow.ts',
    'src/pages/Fees.tsx',
    'src/tests/fees-payment-workflow.test.ts',
    'src/tests/fees-page-workflow.test.ts',
    'docs/agent-context/FEES-BACKEND-RISK-2026-10-26.md',
  ],
  instructions: `Current human authorizes OpenCode to complete supervised unfinished corrections. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md and only section C in docs/agent-context/WORKBUDDY-CORRECTIONS-2026-10-26.md and SUPERVISOR-REVIEW-2026-10-26.md. The current user forbids ALL Git and GitHub use, including read-only status/diff/branch/log. Inspect current files directly and preserve all existing local changes. WorkBuddy still owns M2-23; do not touch its 15 paths. Repair only fees correction C on exact allowedPaths: strict complete-string positive finite money amount with at most two decimal places before any request; actual Fees page refresh must propagate failure to runPaymentFlow so confirmed save with failed refresh shows its distinct state. Add a meaningful page-level test that covers the wiring, not only an injected seam, while preserving safe other load callers. Do not change server financial writes, balance/wallet/payment policy, send real payment, use DB/providers/network, install packages, deploy, or use Git. Inspect server/src/routes/fees.ts:516 read-only and write a separate concise risk report on absolute paid_amount, concurrency, idempotency and audit; no production payment acceptance. Run narrow tests, frontend typecheck and build. Stop activity, submit exact MCP report; supervisor alone accepts and queues next task.`,
  acceptance: [
    'Malformed, precision-invalid, nonfinite and nonpositive amounts produce zero transport writes; valid cents remain accepted.',
    'Actual Fees page wiring distinguishes a confirmed save from a failed refresh, with a regression test of the page connection and no misleading refreshed state.',
    'Only allowed paths changed; scoped tests, frontend typecheck and build recorded with exact results; separate server finance risk report written without changing server money logic.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Direct user request on 2026-10-26 to have OpenCode implement remaining corrections under Codex supervision; independent review specifically identified correction C. Exact disjoint paths exclude active WorkBuddy M2-23 scope.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
const plan = createMailbox(bridgeRoot).call('dispatch_plan', {});
const entry = plan.ready.find(item => item.id === id);
if (!entry) throw new Error('Task created but not dispatchable; inspect active scope, preserve queued task');
console.log(JSON.stringify({ taskId: id, ready: true, activeCount: plan.active.length }));
