import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditedBranchWriter } from '../src/services/audited-branch-write';
const audit = { tenantId: 'tenant', branchId: 'branch', actorUserId: 'owner', action: 'branch.updated' };
test('branch mutation and confirmed audit share one transaction; no-change never audits', async () => {
  const calls: string[] = [];
  const write = createAuditedBranchWriter({ transaction: async work => { calls.push('begin'); const r = await work({ execute: async sql => { calls.push(sql); return { affectedRows: 1 }; } }); calls.push('commit'); return r; } });
  await write('UPDATE branches SET version=version+1', [], audit);
  assert.equal(calls.length, 4); assert.match(calls[2], /INSERT INTO branch_audit_log/); assert.equal(calls[3], 'commit');
  let executions = 0; const noop = createAuditedBranchWriter({ transaction: async work => work({ execute: async () => { executions++; return { affectedRows: 0 }; } }) });
  assert.equal((await noop('UPDATE branches', [], audit)).affectedRows, 0); assert.equal(executions, 1);
});
for (const failure of ['audit-outage', 'unconfirmed-audit', 'mutation-outage', 'commit-outage']) test(`${failure} cannot retain an unaudited branch/version change`, async () => {
  let branch = 0, ledger = 0;
  const write = createAuditedBranchWriter({ transaction: async work => {
    const before = { branch, ledger };
    try { const r = await work({ execute: async sql => { if (sql.includes('branch_audit_log')) { if (failure === 'audit-outage') throw Error('audit outage'); if (failure === 'unconfirmed-audit') return { affectedRows: 0 }; ledger++; } else { if (failure === 'mutation-outage') throw Error('mutation outage'); branch++; } return { affectedRows: 1 }; } });
      if (failure === 'commit-outage') throw Error('commit uncertain'); return r;
    } catch (e) { branch = before.branch; ledger = before.ledger; throw e; }
  } });
  await assert.rejects(() => write('UPDATE branches', [], audit)); assert.equal(branch, 0); assert.equal(ledger, 0);
});
