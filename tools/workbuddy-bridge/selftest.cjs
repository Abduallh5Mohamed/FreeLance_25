'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-mailbox-test-'));
for(const d of ['tasks','state','results'])fs.mkdirSync(path.join(tmp,d));
fs.copyFileSync(path.join(__dirname,'server.cjs'),path.join(tmp,'server.cjs'));
for(const f of ['server-v2.cjs','mailbox-core.cjs'])fs.copyFileSync(path.join(__dirname,f),path.join(tmp,f));
const task={id:'fixture',workspace:null,instructions:'test only',acceptance:['evidence'],dependencies:[],allowedPaths:[]};
const hash=crypto.createHash('sha256').update(JSON.stringify({id:task.id,instructions:task.instructions,workspace:task.workspace,acceptance:task.acceptance})).digest('hex');
fs.writeFileSync(path.join(tmp,'tasks','fixture.json'),JSON.stringify(task));
const child=spawn(process.execPath,[path.join(tmp,'server.cjs')],{stdio:['pipe','pipe','pipe']});
const pending=new Map();let n=0,buffer='';
child.stdout.on('data',b=>{buffer+=b;let pos;while((pos=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,pos));buffer=buffer.slice(pos+1);pending.get(msg.id)?.(msg);pending.delete(msg.id);}});
function rpc(method,params){const id=++n;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),5000);pending.set(id,r=>{clearTimeout(timer);resolve(r.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
async function call(name,args={}){const r=await rpc('tools/call',{name,arguments:args});return r.isError?{error:r.content[0].text}:JSON.parse(r.content[0].text);}
(async()=>{
 assert.equal((await rpc('initialize',{protocolVersion:'2024-11-05'})).serverInfo.name,'workbuddy-supervisor-mailbox');
 assert.equal((await rpc('tools/list',{})).tools.length,7);
 assert.equal((await call('next_approved_task')).status,'empty');
 task.approval={by:'human',scopeHash:hash};fs.writeFileSync(path.join(tmp,'tasks','fixture.json'),JSON.stringify(task));
 const claim=await call('next_approved_task');assert.equal(claim.id,'fixture');
 assert.equal((await call('next_approved_task')).status,'empty');
 assert.ok((await call('submit_task_report',{taskId:'fixture',claimToken:'wrong',status:'reported',summary:'x',evidence:[],questions:[]})).error);
 assert.equal((await call('submit_task_report',{taskId:'fixture',claimToken:claim.claimToken,status:'reported',summary:'ok',evidence:['fixture'],questions:[]})).status,'awaiting_supervisor');
 assert.equal((await call('task_status',{taskId:'fixture'})).status,'reported');
 assert.equal((await call('next_approved_task')).status,'empty');
 assert.ok((await call('task_status',{taskId:'../x'})).error);
 assert.equal(JSON.parse(fs.readFileSync(path.join(tmp,'results','fixture.json'))).supervisorAccepted,false);
 console.log('PASS: initialize/tools, unapproved denied, claim dedupe, token check, report review gate, no repeat, path validation. Temporary fixture only; no WorkBuddy runtime test.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>child.stdin.end());
