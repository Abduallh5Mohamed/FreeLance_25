'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {createMailbox,scopeHash,atomicWrite}=require('./mailbox-core.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wb-scheduler-'));
 const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
 const box=createMailbox(root);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const add=(id,extra={})=>{const task={id,instructions:'fixture only',workspace,acceptance:['proof'],approvalVersion:2,allowedPaths:[],dependencies:[],...extra};task.approval={by:'human',scopeHash:scopeHash(task)};atomicWrite(path.join(root,'tasks',id+'.json'),task);return task;};
 return {root,workspace,box,add,state:id=>JSON.parse(fs.readFileSync(path.join(root,'state',id+'.json')))};
}
test('v2 approval binds paths, dependencies, team and access mode',t=>{
 const f=fixture(t),task=f.add('a');task.allowedPaths=['sensitive.ts'];atomicWrite(path.join(f.root,'tasks/a.json'),task);
 assert.equal(f.box.call('next_approved_task').status,'empty');
});
test('directory/case overlaps block another writer; sibling file can run',t=>{
 const f=fixture(t);f.add('a',{allowedPaths:['src/']});f.add('b',{allowedPaths:['SRC/file.ts']});f.add('c',{allowedPaths:['docs/x.md']});
 assert.equal(f.box.call('next_approved_task').id,'a');assert.equal(f.box.call('next_approved_task').id,'c');
 assert.equal(f.box.call('next_approved_task').status,'empty');
 assert.equal(f.box.call('dispatch_plan').blocked.find(x=>x.id==='b').reason,'file_conflict');
});
test('read/read is allowed; writer waits until both reports stop activity',t=>{
 const f=fixture(t);f.add('a',{allowedPaths:['x'],accessMode:'read'});f.add('b',{allowedPaths:['x'],accessMode:'read'});f.add('c',{allowedPaths:['x']});
 const a=f.box.call('next_approved_task'),b=f.box.call('next_approved_task');assert.equal(b.id,'b');
 for(const x of [a,b])f.box.call('submit_task_report',{taskId:x.id,claimToken:x.claimToken,status:'reported',summary:'done',evidence:[],questions:[]});
 assert.equal(f.box.call('next_approved_task').id,'c');
});
test('dependencies require accepted, not reported',t=>{
 const f=fixture(t);f.add('a');f.add('b',{dependencies:['a']});const a=f.box.call('next_approved_task');
 f.box.call('submit_task_report',{taskId:'a',claimToken:a.claimToken,status:'reported',summary:'done',evidence:[],questions:[]});
 assert.equal(f.box.call('next_approved_task').status,'empty');
 atomicWrite(path.join(f.root,'state/a.json'),{...f.state('a'),status:'accepted'});
 assert.equal(f.box.call('next_approved_task').id,'b');
});
test('unsafe and symlink-escaping paths fail closed',t=>{
 const f=fixture(t);f.add('a',{allowedPaths:['../outside']});assert.equal(f.box.call('next_approved_task').status,'empty');
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.workspace,'link'),process.platform==='win32'?'junction':'dir');
 f.add('b',{allowedPaths:['link/new.ts']});assert.equal(f.box.call('next_approved_task').status,'empty');
});
test('legacy active claim conservatively reserves its workspace and remains untouched',t=>{
 const f=fixture(t),task=f.add('a');delete task.allowedPaths;delete task.approvalVersion;task.approval.scopeHash=scopeHash(task);atomicWrite(path.join(f.root,'tasks/a.json'),task);
 atomicWrite(path.join(f.root,'state/a.json'),{status:'claimed',scopeHash:scopeHash(task),claimToken:'fixture-secret'});
 f.add('b',{allowedPaths:['anything.ts']});assert.equal(f.box.call('next_approved_task').status,'empty');
 assert.equal(f.state('a').claimToken,'fixture-secret');assert.ok(!JSON.stringify(f.box.call('queue_status')).includes('fixture-secret'));
});
test('48 total claims and six per named team enforced',t=>{
 const f=fixture(t);for(let i=0;i<49;i++)f.add('a'+String(i).padStart(2,'0'));
 for(let i=0;i<48;i++)assert.ok(f.box.call('next_approved_task').id);
 assert.equal(f.box.call('next_approved_task').status,'empty');
 const g=fixture(t);for(let i=0;i<7;i++)g.add('b'+i,{team:'security'});
 for(let i=0;i<6;i++)assert.ok(g.box.call('next_approved_task').id);
 assert.equal(g.box.call('next_approved_task').status,'empty');
});
test('worker cannot hold two tasks; bad tokens cannot renew; overdue does not reassign',t=>{
 const f=fixture(t);f.add('a');f.add('b');const a=f.box.call('next_approved_task',{workerId:'one'});
 assert.throws(()=>f.box.call('next_approved_task',{workerId:'one'}),/already owns/);
 atomicWrite(path.join(f.root,'state/a.json'),{...f.state('a'),leaseUntil:'2000-01-01T00:00:00Z'});
 assert.equal(f.box.call('task_status',{taskId:'a'}).leaseOverdue,true);
 assert.throws(()=>f.box.call('task_heartbeat',{taskId:'a',claimToken:'wrong'}),/Invalid claim/);
 assert.equal(f.box.call('task_checkpoint',{taskId:'a',claimToken:a.claimToken,note:'fixture progress'}).status,'recorded');
 assert.equal(f.state('a').status,'claimed');
});
test('report retry repairs interrupted state; different payload and review rewrite denied',t=>{
 const f=fixture(t);f.add('a');const a=f.box.call('next_approved_task'),s=f.state('a');
 const args={taskId:'a',claimToken:a.claimToken,status:'reported',summary:'done',evidence:['proof'],questions:[]};
 f.box.call('submit_task_report',args);atomicWrite(path.join(f.root,'state/a.json'),s);
 assert.equal(f.box.call('submit_task_report',args).status,'awaiting_supervisor');
 assert.throws(()=>f.box.call('submit_task_report',{...args,summary:'changed'}),/Different report/);
 atomicWrite(path.join(f.root,'state/a.json'),{...f.state('a'),status:'accepted'});
 assert.throws(()=>f.box.call('submit_task_report',args),/already reviewed/);
});
test('retirement fences old token without silently recycling claim',t=>{
 const f=fixture(t);f.add('a');const a=f.box.call('next_approved_task');
 assert.throws(()=>f.box.retire('a',''),/evidence/);
 assert.equal(f.box.retire('a','fixture native termination verified').status,'retired');
 assert.throws(()=>f.box.call('task_heartbeat',{taskId:'a',claimToken:a.claimToken}),/Invalid claim/);
 assert.equal(f.box.call('next_approved_task').status,'empty');
});
test('orphan global scheduler lock fails closed and is never auto deleted',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'state/.scheduler-lock'));
 assert.throws(()=>f.box.call('next_approved_task'),/interrupted/);
 assert.ok(fs.existsSync(path.join(f.root,'state/.scheduler-lock')));
});
test('upgrade gate pauses new claims but preserves existing-owner reporting',t=>{
 const f=fixture(t);f.add('a');f.add('b');const a=f.box.call('next_approved_task');
 atomicWrite(path.join(f.root,'state/parallel-upgrade-pending.json'),{reason:'fixture upgrade'});
 assert.equal(f.box.call('next_approved_task').reason,'upgrade_pending');
 assert.equal(f.box.call('queue_status').upgradePending,true);
 assert.equal(f.box.call('submit_task_report',{taskId:'a',claimToken:a.claimToken,status:'blocked',summary:'fixture stop',evidence:[],questions:[]}).status,'awaiting_supervisor');
 assert.equal(f.state('a').status,'blocked');
});
test('eight separate processes racing for overlapping files produce exactly one claim',async t=>{
 const f=fixture(t);for(let i=0;i<8;i++)f.add('race'+i,{allowedPaths:['shared.ts']});
 const code=`const {createMailbox}=require(process.argv[1]);const b=createMailbox(process.argv[2]);let n=0;function run(){try{const r=b.call('next_approved_task');console.log(JSON.stringify({id:r.id||null}));}catch(e){if(/Scheduler busy/.test(e.message)&&n++<30)setTimeout(run,10);else process.exitCode=1;}}run();`;
 const results=await Promise.all(Array.from({length:8},()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['-e',code,path.join(__dirname,'mailbox-core.cjs'),f.root],{stdio:['ignore','pipe','pipe']});let out='',err='';
  child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
  child.on('exit',exit=>exit?reject(Error('fixture child failed: '+err)):resolve(JSON.parse(out)));
 })));
 assert.equal(results.filter(x=>x.id).length,1);
 assert.equal(f.box.call('queue_status').active.length,1);
});
