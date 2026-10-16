'use strict';
// Local supervisor only. This is deliberately NOT exposed as an MCP worker tool.
const {createMailbox,atomicWrite}=require('./mailbox-core.cjs');
const fs=require('node:fs'),path=require('node:path');
const [action,id,...evidence]=process.argv.slice(2);
try {
 if(action==='enable-v2'){
  const proof=[id,...evidence].filter(Boolean).join(' ');
  if(proof.length<20)throw Error('Evidence that old clients stopped and v2 tools refreshed is required');
  const pending=path.join(__dirname,'state','parallel-upgrade-pending.json');
  if(!fs.existsSync(pending))throw Error('No upgrade pending');
  atomicWrite(path.join(__dirname,'handoff','v2-activation-evidence.json'),{activatedAt:new Date().toISOString(),evidence:proof});
  fs.unlinkSync(pending);
  console.log('V2 dispatch enabled. This does not start WorkBuddy agents or approve new tasks.');
 }else if(action==='retire')console.log(JSON.stringify(createMailbox(__dirname).retire(id,evidence.join(' ')),null,2));
 else throw Error('Usage: retire TASK_ID VERIFIED_TERMINATION_EVIDENCE | enable-v2 VERIFIED_CLIENT_UPGRADE_EVIDENCE');
}catch(e){console.error(e.message);process.exitCode=1;}
