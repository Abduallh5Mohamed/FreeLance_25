'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = 'C:/Users/BaraaWael/TabwebClientBridge';
const { createMailbox, scopeHash, atomicWrite } = require(path.join(root, 'mailbox-core.cjs'));
const mailbox = createMailbox(root);
if (mailbox.call('task_status', { taskId: 'audit-20261026-search-test-contract-correction-01' }).status !== 'reported') {
  throw new Error('Search worker still owns its task');
}
const id = 'audit-20261026-mount-test-contract-correction-01';
const taskFile = path.join(root, 'tasks', `${id}.json`);
const stateFile = path.join(root, 'state', `${id}.json`);
if (fs.existsSync(taskFile) || fs.existsSync(stateFile)) throw new Error('Task already exists');
const task = {
  id,
  workspace: 'D:/FreeLance_25-1/FreeLance_25-1',
  approvalVersion: 2,
  team: 'qa',
  role: 'opencode-mount-test-contract-correction',
  batch: 'audit-20261026-mount-tests',
  accessMode: 'write',
  dependencies: [],
  implementationWorker: 'opencode',
  taskKind: 'correction',
  allowedPaths: ['server/tests/m2-m3-mounting.test.ts'],
  instructions: `Current human authorizes bounded OpenCode corrections under Codex supervision. Read AGENTS.md, docs/agent-context/README.md, ENGINEERING_RULES.md, then inspect server/tests/m2-m3-mounting.test.ts. Read server/src/index.ts, routes/public-catalog.ts, routes/public-identity.ts, routes/tenant-branding.ts, routes/tenant-self.ts and server/tests/m2-public-catalog-composition.test.ts READ-ONLY. Exact allowedPaths is only server/tests/m2-m3-mounting.test.ts. Independent guarded baseline: node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m2-m3-mounting.test.ts => 20 pass / 2 fail. Failure 1: static collision test rejects duplicate /api/public mount for publicCatalogRoutes and publicIdentityRoutes, although these have disjoint concrete child paths and composition tests prove one canonical GET /courses. Correct the test to permit only this specific verified shared mount pair, while continuing to reject arbitrary duplicate/prefix collisions and preserve concrete route ownership checks; do not blanket-ignore duplicates. Failure 2: buildGuardedSurface mounts the NEW named createTenantBrandingRouter at OLD /api/tenant/branding. Production index mounts the DEFAULT legacy tenantBrandingRoutes there; named localized factory is mounted inside tenant-self at /api/tenants/me/branding. Use the matching injectable legacy factory at the old mount and keep anonymous 401/403 plus zero storage calls; if testing the new path separately, mirror its true mount/guard and ownership. Do not change production routes/index, weaken auth/tenant checks, delete assertions, skip tests or use Git/GitHub even read-only. No DB, provider, payment, install, migration or deploy. Run guarded mounting test plus public composition/identity tests and server build. Report exact results after stopping via MCP; supervisor alone accepts. WorkBuddy M2-23 fifteen paths remain untouched.`,
  acceptance: [
    'The test rejects arbitrary mount collisions while allowing only verified disjoint publicCatalog/publicIdentity composition.',
    'Anonymous branding probe mounts the same router as production at the same prefix and proves 401/403 with zero storage calls.',
    'Only the test file changes; guarded mounting/public suites and server build pass.',
  ],
};
task.approval = {
  by: 'human',
  scopeHash: scopeHash(task),
  basis: 'Current user delegates remaining independent fixes to OpenCode; Codex reproduced two test-only mount failures and traced the production mount/factory mismatch. Exact one-file scope disjoint from WorkBuddy.',
};
atomicWrite(taskFile, task);
atomicWrite(stateFile, { status: 'queued' });
if (!mailbox.call('dispatch_plan', {}).ready.some(item => item.id === id)) {
  throw new Error('Task queued but not ready; preserve task and inspect ownership');
}
console.log(JSON.stringify({ taskId: id, ready: true }));
