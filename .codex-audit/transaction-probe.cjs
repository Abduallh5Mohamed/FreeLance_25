const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const events = [];
const connection = {
  beginTransaction: async () => events.push('begin'),
  commit: async () => { events.push('commit'); throw new Error('synthetic lost COMMIT acknowledgement'); },
  rollback: async () => events.push('rollback'),
  release: () => events.push('release'),
  destroy: () => events.push('destroy'),
};
const original = Module._load;
Module._load = function(request,parent,isMain) {
  if (parent?.filename === path.resolve(__dirname,'../server/src/db.ts')) {
    if (request === 'dotenv') return { config() {} };
    if (request === 'mysql2/promise') return { createPool: () => ({ getConnection: async () => connection }) };
  }
  return original.apply(this,arguments);
};
const originalLog = console.log;
console.log = () => {};
const db = require('../server/src/db.ts');
Module._load = original;
(async () => {
  await assert.rejects(db.withTransaction(async () => events.push('work')));
  console.log = originalLog;
  assert.deepEqual(events,['begin','work','commit','rollback','release']);
  console.log('CONFIRMED: shared withTransaction releases the connection after COMMIT rejection when rollback succeeds; destroy was never called. Synthetic connection only.');
})().catch(error => { console.log = originalLog; console.error(error); process.exitCode=1; });
