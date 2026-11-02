'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const mailbox = createMailbox(root);
const previous = mailbox.call('task_status', { taskId: 'audit-20261026-unit-order-correction-01' });
if (previous.status !== 'reported') throw new Error('Unit correction still owned by worker');
const id = 'audit-20261026-search-test-contract-correction-01';
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'qa',
  role: 'opencode-search-test-contract-correction',
  batch: 'audit-20261026-search-tests',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['server/tests/m8-search.test.ts'],
  instructions: `Current human authorizes supervised OpenCode corrections. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md, then server/tests/m8-search.test.ts and the current server/src/services/search.ts and server/src/routes/search.ts READ-ONLY. Exact allowedPaths: server/tests/m8-search.test.ts only. Independent baseline with node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m8-search.test.ts: 35 pass / 3 fail. Failures: (1) 'LIKE metacharacters and hostile input stay escaped bound parameters' passes RAW hostile text directly into buildStaffSearchQuery; appendTitlePrefilter now correctly requires text already folded by normalizeSearchText. Preserve strong checks by separately testing exported escapeLikeToken on raw %/_/! and binding SQL only with normalized hostile input; assert direct nonnormalized builder input refuses, never interpolate input. (2) 'production student resolver returns users.id' tests sql.includes('SELECT s.user_id') but current production query is SELECT DISTINCT s.user_id to deny ambiguous branch scopes; assert the DISTINCT projection without weakening that boundary. (3) forged branch_id student test expects 200/ignored, but current route intentionally returns 400 before any search because a client branch selector is not student authority. Assert exact 400 and no extra candidate read, while still proving server-bound branch restriction with the earlier no-selector request. Do not modify production code or tests outside allowedPaths, remove assertions, skip tests, weaken auth/tenant/branch, use Git/GitHub even read-only, run DB/providers/payments/services, install or deploy. Run the guarded m8-search suite, nearby safe tests if useful, and server build; report exact results via MCP after stopping. User's active WorkBuddy M2-23 fifteen paths remain untouched.`,
  acceptance: [
    'All three obsolete test expectations are corrected to assert current production contracts without relaxing SQL binding or student branch authority.',
    'The isolated guarded m8-search suite passes and no external I/O is attempted; server build passes.',
    'Only server/tests/m8-search.test.ts changes; production search and active WorkBuddy paths remain untouched.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Direct 2026-10-26 delegation to OpenCode for remaining independent corrections; Codex reproduced three m8-search test failures under external-I/O barrier and verified current production contracts. Disjoint test-only scope.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
const plan = mailbox.call('dispatch_plan', {});
if (!plan.ready.some(item => item.id === id)) throw new Error('Task queued but not ready; preserve task and inspect ownership');
console.log(JSON.stringify({ taskId: id, ready: true, activeCount: plan.active.length }));
