import assert from 'node:assert/strict';
import test from 'node:test';
import {teamUuid,parseTeamOwner,parseTeamTasks,parseCenterReceipt,boundedCenterRequest} from '../features/tenant/center-team-client';
const id=(n:number)=>`b5800000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('owner/team parsers preserve valid scoped facts and reject secret fields, duplicate IDs and invented privileges',()=>{
  assert.equal(teamUuid(id(1)),true);assert.equal(teamUuid('b5800000-0000-4000-000000000001'),false);
  const r={members:[{id:id(1),name:'Employee',permissions:['groups.read'],branch_ids:[id(2)],status:'active',version:0}],branches:[{id:id(2),name:'Branch'}]};assert.equal(parseTeamOwner(r).members.length,1);
  for(const change of [{password:'secret'},{members:[{...r.members[0],password_hash:'secret'}]},{members:[{...r.members[0],permissions:['fees.manage']}]},{members:[r.members[0],r.members[0]]}])assert.throws(()=>parseTeamOwner({...r,...change}));
});
test('task/recovery DTOs reject forged completion, unknown keys and invalid pagination without showing a fake saved state',()=>{
  const receipt={id:id(1),version:1,status:'resolved',kind:'task.status'};assert.equal(parseCenterReceipt(receipt).version,1);assert.throws(()=>parseCenterReceipt({...receipt,password:'private'}));assert.throws(()=>parseCenterReceipt({...receipt,kind:'fees.paid'}));
  assert.equal(parseCenterReceipt({id:id(2),version:0,status:'retired',kind:'operation.retired'}).status,'retired');
  const q={id:id(1),branch_id:id(2),assigned_member_id:id(3),title:'Request',status:'open',version:0,due_at:null,overdue:false};assert.equal(parseTeamTasks({tasks:[q],next_cursor:null}).tasks.length,1);assert.throws(()=>parseTeamTasks({tasks:[q],next_cursor:id(1)}));assert.throws(()=>parseTeamTasks({tasks:[{...q,phone:'private'}],next_cursor:null}));
});
test('whole request deadline retires transports ignoring cancellation; late ACK cannot turn rejection into confirmation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let resolve!:(x:string)=>void;const c=new AbortController(),pending=boundedCenterRequest(c,()=>new Promise<string>(r=>{resolve=r;}));const rejected=assert.rejects(pending);t.mock.timers.tick(25000);await rejected;assert.equal(c.signal.aborted,true);resolve('late');await Promise.resolve();
});
test('session cancellation settles a request without waiting for an uncooperative response',async()=>{const c=new AbortController(),pending=boundedCenterRequest(c,()=>new Promise<never>(()=>{})),rejected=assert.rejects(pending);c.abort();await rejected;});
