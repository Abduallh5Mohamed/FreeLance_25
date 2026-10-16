'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const TEAMS = ['backend', 'security', 'media', 'storage', 'frontend', 'qa', 'devops', 'integration'];
const MAX_ACTIVE = 48;
const MAX_TEAM = 6;
const LEASE_MS = 30 * 60 * 1000;

function scopeHash(t) {
  const scope = {id:t.id, instructions:t.instructions, workspace:t.workspace, acceptance:t.acceptance};
  if (t.approvalVersion === 2) Object.assign(scope, {
    approvalVersion:2, allowedPaths:t.allowedPaths, dependencies:t.dependencies || [],
    accessMode:t.accessMode || 'write', team:t.team || null, role:t.role || null, batch:t.batch || null,
  });
  return crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}
function atomicWrite(file, value) {
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
function checkedId(id) {
  if (!ID.test(id || '')) throw Error('Invalid identifier');
  return id;
}
function canonicalWorkspace(workspace) {
  if (!workspace || !path.isAbsolute(workspace)) throw Error('Absolute workspace required for file reservations');
  const resolved = path.resolve(workspace);
  if (!fs.existsSync(resolved)) throw Error('Workspace unavailable; scope cannot be verified');
  return fs.realpathSync.native(resolved).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}
function resourceScope(t) {
  if (Array.isArray(t.allowedPaths) && t.allowedPaths.length === 0) return [];
  const workspace = canonicalWorkspace(t.workspace);
  // Old tasks without explicit paths reserve their entire workspace, conservatively.
  if (!Array.isArray(t.allowedPaths)) return [workspace];
  return t.allowedPaths.map(relative => {
    if (typeof relative !== 'string' || !relative || /^[a-z]:|^[/\\]/i.test(relative) || /[*?\x00]/.test(relative)) throw Error('Invalid relative allowedPath');
    const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.some(x => x === '..' || x === '.' || x.includes(':'))) throw Error('Unsafe allowedPath');
    const absolute = path.resolve(t.workspace, ...parts);
    // Resolve existing ancestors, including junctions, before reserving a path.
    let ancestor = absolute;
    const missing = [];
    while (!fs.existsSync(ancestor)) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    const actual = path.join(fs.realpathSync.native(ancestor), ...missing).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    if (actual !== workspace && !actual.startsWith(workspace + '/')) throw Error('allowedPath escapes workspace');
    return actual;
  });
}
function overlaps(a, b) { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
function conflict(a, b) {
  if (a.accessMode === 'read' && b.accessMode === 'read') return false;
  return a.resources.some(x => b.resources.some(y => overlaps(x, y)));
}
function createMailbox(root) {
  for (const d of ['tasks','state','results','checkpoints']) fs.mkdirSync(path.join(root,d), {recursive:true});
  const file = (dir,id) => path.join(root,dir,checkedId(id)+'.json');
  const readTask = id => { const t=JSON.parse(fs.readFileSync(file('tasks',id),'utf8')); if(t.id!==id)throw Error('Task id mismatch');return t; };
  const state = id => fs.existsSync(file('state',id)) ? JSON.parse(fs.readFileSync(file('state',id),'utf8')) : {status:'queued'};
  const approved = t => t.approval?.by==='human' && t.approval.scopeHash===scopeHash(t);
  function exclusive(fn) {
    const lock=path.join(root,'state','.scheduler-lock');
    try { fs.mkdirSync(lock); } catch(e) { if(e.code==='EEXIST')throw Error('Scheduler busy or interrupted; retry later. An orphan lock requires supervisor inspection.');throw e; }
    try { atomicWrite(path.join(lock,'owner.json'),{pid:process.pid,startedAt:new Date().toISOString()});return fn(); }
    finally { fs.rmSync(lock,{recursive:true}); }
  }
  function tasks() { return fs.readdirSync(path.join(root,'tasks')).filter(x=>/^[a-zA-Z0-9_-]{1,80}\.json$/.test(x)).sort().map(x=>readTask(x.slice(0,-5))); }
  function active(all) {
    return all.filter(t=>state(t.id).status==='claimed').map(t=>{
      const s=state(t.id);
      // Scope snapshots fence later task edits; legacy claims use current scope.
      let resources;
      try { resources=s.reservation?.resources || resourceScope(t); }
      catch { throw Error('Unverifiable active scope: '+t.id+'; supervisor must resolve it before dispatch'); }
      return {id:t.id,resources,accessMode:s.reservation?.accessMode || 'write',team:s.team || 'legacy',workerId:s.workerId,
        leaseOverdue:Boolean(s.leaseUntil && Date.parse(s.leaseUntil)<Date.now()),hasHeartbeat:Boolean(s.lastHeartbeatAt)};
    });
  }
  function candidate(t, running) {
    if(!approved(t))return {reason:'unapproved_or_scope_changed'};
    if(state(t.id).status!=='queued')return {reason:state(t.id).status};
    const unmet=(t.dependencies||[]).filter(id=>state(id).status!=='accepted');
    if(unmet.length)return {reason:'dependencies',dependencies:unmet};
    if(running.length>=MAX_ACTIVE)return {reason:'capacity'};
    if(t.team && !TEAMS.includes(t.team))return {reason:'invalid_team'};
    if(t.team && running.filter(x=>x.team===t.team).length>=MAX_TEAM)return {reason:'team_capacity'};
    let resources;try { resources=resourceScope(t); }catch(e){return {reason:'invalid_scope',message:e.message};}
    const reservation={resources,accessMode:t.accessMode==='read'?'read':'write'};
    const blockers=running.filter(x=>conflict(reservation,x)).map(x=>x.id);
    return blockers.length?{reason:'file_conflict',blockers}:{reservation};
  }
  function authenticate(t,s,args) {
    if(!approved(t)||s.scopeHash!==scopeHash(t))throw Error('Task scope changed or approval missing');
    if(!args.claimToken || s.claimToken!==args.claimToken)throw Error('Invalid claim');
  }
  function validReport(args) {
    if(!['reported','blocked'].includes(args.status)||typeof args.summary!=='string'||!args.summary.trim()||args.summary.length>20000)throw Error('Invalid report');
    for(const [key,max] of [['evidence',50],['questions',20]])if(!Array.isArray(args[key])||args[key].length>max||args[key].some(x=>typeof x!=='string'||x.length>20000))throw Error('Invalid report array');
  }
  function call(name,args={}) {
    return exclusive(()=>{
      if(name==='queue_status'||name==='dispatch_plan') {
        const all=tasks(),running=active(all),chosen=[...running],ready=[],blocked=[];
        for(const t of all) {
          if(state(t.id).status!=='queued'||!approved(t))continue;
          const c=candidate(t,chosen);
          if(c.reservation){ready.push({id:t.id,role:t.role||null,team:t.team||null,accessMode:c.reservation.accessMode});chosen.push({id:t.id,...c.reservation,team:t.team||'general'});}
          else blocked.push({id:t.id,...c});
        }
        return {version:2,maxActive:MAX_ACTIVE,maxPerTeam:MAX_TEAM,teams:TEAMS,
          upgradePending:fs.existsSync(path.join(root,'state','parallel-upgrade-pending.json')),
          active:running.map(({resources,...x})=>x),ready,blocked,
          warning:'Plan is advisory, not a reservation. Claimed is not proof of a running model. Expiry never reassigns automatically.'};
      }
      if(name==='next_approved_task') {
        if(fs.existsSync(path.join(root,'state','parallel-upgrade-pending.json')))return {status:'empty',reason:'upgrade_pending',message:'New dispatch paused for connector upgrade. Existing owners may report. Supervisor enables dispatch after old MCP clients close and v2 tools are verified.'};
        if(args.workerId!==undefined)checkedId(args.workerId);
        if(args.taskId!==undefined)checkedId(args.taskId);
        if(args.team!==undefined&&!TEAMS.includes(args.team))throw Error('Invalid team');
        if(args.sessionId!==undefined&&(typeof args.sessionId!=='string'||args.sessionId.length>200))throw Error('Invalid session id');
        const all=tasks(),running=active(all);
        if(args.workerId&&running.some(x=>x.workerId===args.workerId))throw Error('Worker already owns an active task');
        for(const t of all) {
          if(args.taskId&&t.id!==args.taskId)continue;
          if(args.team&&t.team&&args.team!==t.team)continue;
          const c=candidate(t,running);if(!c.reservation)continue;
          const team=t.team||args.team||'general';
          if(team!=='general'&&running.filter(x=>x.team===team).length>=MAX_TEAM)continue;
          const token=crypto.randomBytes(24).toString('hex'),now=new Date().toISOString();
          const claimFile=path.join(root,'state',t.id+'.claim');
          try{fs.writeFileSync(claimFile,token,{flag:'wx'});}catch(e){if(e.code==='EEXIST')continue;throw e;}
          // If this save fails the claim marker is retained: fail closed, supervisor recovery.
          atomicWrite(file('state',t.id),{status:'claimed',scopeHash:scopeHash(t),claimedAt:now,claimToken:token,
            workerId:args.workerId||'worker-'+crypto.randomBytes(8).toString('hex'),sessionId:args.sessionId||null,team,
            lastHeartbeatAt:now,leaseUntil:new Date(Date.now()+LEASE_MS).toISOString(),reservation:c.reservation});
          return {...t,claimToken:token,workerId:state(t.id).workerId,leaseUntil:state(t.id).leaseUntil,
            warning:'Reservation is coordination, not OS sandboxing. Heartbeat at checkpoints; report only after children stop. No automatic reclaim or phase approval.'};
        }
        return {status:'empty',message:'No approved runnable task. Stop; inspect dispatch_plan for dependencies/conflicts, never invent work.'};
      }
      const t=readTask(args.taskId),s=state(t.id);
      if(name==='task_status')return {taskId:t.id,status:s.status,approved:approved(t),workerId:s.workerId||null,team:s.team||null,
        leaseOverdue:Boolean(s.leaseUntil&&Date.parse(s.leaseUntil)<Date.now()),checkpoint:s.checkpoint||null};
      authenticate(t,s,args);
      if(name==='task_heartbeat'||name==='task_checkpoint') {
        if(s.status!=='claimed')throw Error('Task is not active');
        const next={...s,lastHeartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+LEASE_MS).toISOString()};
        if(name==='task_checkpoint') {
          if(typeof args.note!=='string'||!args.note.trim()||args.note.length>3000)throw Error('Invalid checkpoint');
          next.checkpoint=args.note;
        }
        atomicWrite(file('state',t.id),next);
        return {status:'recorded',leaseUntil:next.leaseUntil,warning:'No automatic reclaim; no extra scope granted.'};
      }
      if(name!=='submit_task_report')throw Error('Unknown tool');
      validReport(args);
      const body={taskId:t.id,status:args.status,summary:args.summary,evidence:args.evidence,questions:args.questions};
      const reportFile=file('results',t.id);
      let report;
      if(fs.existsSync(reportFile)) {
        report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
        if(Object.keys(body).some(k=>JSON.stringify(report[k])!==JSON.stringify(body[k])))throw Error('Different report already exists; supervisor review required');
        if(!['claimed','reported','blocked'].includes(s.status))throw Error('Task already reviewed');
      } else {
        if(s.status!=='claimed')throw Error('Task is not active');
        report={...body,receivedAt:new Date().toISOString(),scopeHash:s.scopeHash,supervisorAccepted:false};
        atomicWrite(reportFile,report);
      }
      // A retry after report-write/state-write interruption repairs state, never overwrites evidence.
      atomicWrite(file('state',t.id),{...s,status:report.status,reportedAt:report.receivedAt});
      return {status:'awaiting_supervisor',message:'Report saved. Worker must stop; no next phase automatically authorized.'};
    });
  }
  function retire(id,evidence) {
    if(typeof evidence!=='string'||evidence.trim().length<12)throw Error('Supervisor termination evidence required');
    return exclusive(()=>{
      const s=state(id);if(s.status!=='claimed')throw Error('Only active claims may be retired');
      const dir=path.join(root,'handoff','retired-claims');fs.mkdirSync(dir,{recursive:true});
      atomicWrite(path.join(dir,checkedId(id)+'-'+Date.now()+'.json'),{...s,terminationEvidence:evidence,retiredAt:new Date().toISOString()});
      atomicWrite(file('state',id),{status:'retired',scopeHash:s.scopeHash,retiredAt:new Date().toISOString(),terminationEvidence:evidence});
      return {id,status:'retired',warning:'Old token fenced. Create a new approved recovery task; do not silently recycle the claim.'};
    });
  }
  return {call,retire};
}
module.exports={createMailbox,scopeHash,resourceScope,atomicWrite,MAX_ACTIVE,MAX_TEAM,TEAMS};
