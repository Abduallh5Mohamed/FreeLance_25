'use strict';
// Portable local setup only: no model, platform server, database or Git process is started.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scopeHash, atomicWrite } = require('./mailbox-core.cjs');

const argv = process.argv.slice(2);
function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
try {
  const workspaceArg = option('--workspace');
  if (!workspaceArg || !path.isAbsolute(workspaceArg)) throw Error('--workspace must be the absolute local repository path');
  const workspace = fs.realpathSync(workspaceArg);
  const destination = path.resolve(option('--bridge-dir') || path.join(os.homedir(), 'TabwebClientBridge'));
  const nodeBinary = option('--node') || process.execPath;
  if (!path.isAbsolute(nodeBinary) || !fs.existsSync(nodeBinary)) throw Error('--node must name an existing absolute Node executable');
  if (fs.existsSync(destination)) throw Error('Destination already exists. Refusing to overwrite any bridge or active claims. Choose a new empty location.');
  const repoRelative = path.relative(workspace, destination);
  if (repoRelative === '' || (!repoRelative.startsWith('..') && !path.isAbsolute(repoRelative))) {
    throw Error('Keep the live bridge outside the repository to avoid publishing private state');
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['tasks', 'state', 'results', 'checkpoints', 'handoff']) {
    fs.mkdirSync(path.join(destination, name));
  }
  for (const name of ['server.cjs', 'server-v2.cjs', 'mailbox-core.cjs', 'supervisor-control.cjs', 'scope-hash.cjs', 'team-topology.json', 'selftest.cjs', 'scheduler.test.cjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(destination, name), fs.constants.COPYFILE_EXCL);
  }
  atomicWrite(path.join(destination, 'workbuddy-mcp.json'), {
    mcpServers: { 'tabweb-client-supervisor': { command: nodeBinary, args: [path.join(destination, 'server.cjs')] } },
  });
  atomicWrite(path.join(destination, 'supervisor-review-ledger.json'), { reviews: [] });
  if (argv.includes('--approve-connectivity')) {
    const task = {
      id: 'connection-001', workspace, role: 'Client connector verification only',
      team: 'integration', batch: 'local-connectivity-only', approvalVersion: 2,
      accessMode: 'read', dependencies: [], allowedPaths: [],
      instructions: 'Connectivity only. Call next_approved_task once and submit summary exactly CONNECTED WORKBUDDY-731 through submit_task_report. No repository reads/writes, shell commands, platform implementation or child workers. Keep claim token only in designated tool fields. Stop after reporting.',
      acceptance: ['Exact connectivity report received by the local supervisor', 'No platform activity'],
    };
    task.approval = { by: 'human', scopeHash: scopeHash(task), basis: 'The local human explicitly passed --approve-connectivity; connection test only, no implementation approval' };
    atomicWrite(path.join(destination, 'tasks', 'connection-001.json'), task);
    atomicWrite(path.join(destination, 'state', 'connection-001.json'), { status: 'queued', scopeHash: task.approval.scopeHash });
  }
  fs.copyFileSync(path.join(__dirname, 'WORKER-PROMPT-CLIENT.md'), path.join(destination, 'WORKER-PROMPT-CLIENT.md'));
  console.log(JSON.stringify({ bridgeDirectory: destination, mcpConfig: path.join(destination, 'workbuddy-mcp.json'), workspace, connectivityTaskCreated: argv.includes('--approve-connectivity'), workerStarted: false, implementationApproved: false }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
