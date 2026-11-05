import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupportWriteService, supportWriteId } from '../src/services/support-writes';
const key='a1000000-0000-4000-8000-000000000001';
const actor={id:'owner',tokenVersion:0,identitySource:'users' as const};
const input={category:'technical',subject:'Synthetic support issue',description:'Synthetic description only'};
const context={kind:'catalog_lesson' as const,course_id:'b1000000-0000-4000-8000-000000000001',lesson_id:'c1000000-0000-4000-8000-000000000001'};
const studentActor={...actor,role:'student',tenantId:'tenant-a',studentEnrollmentId:'own-enrollment'};
function fixture(){
  const s={tickets:[] as any[],replies:[] as any[],audits:[] as any[],users:[{id:'owner',is_active:1,token_version:0,suspension_active:0},{id:'admin',is_active:1,token_version:0,suspension_active:0}],
    schema:true,primary:true,engine:'InnoDB',admin:false,statusAffectedRows:1,grantOverflow:false,failAudit:false,failStatus:false,failInsert:false,failCommit:false,failBegin:false,failRollback:false,
    contextReady:false,contextPartial:false,contextEngine:'InnoDB',enrolled:true,coursePublished:true,lessonActive:true,released:true,prerequisite:true,
    commits:0,rollbacks:0,destroys:0,updates:0,executed:[] as string[]};
  let chain=Promise.resolve();
  const getConnection=async()=>{
    let before:any,releaseLock:(()=>void)|null=null;
    const unlock=()=>{releaseLock?.();releaseLock=null;};
    return {
      beginTransaction:async()=>{if(s.failBegin)throw Error('begin');},
      execute:async(sql:string,p:any[]=[]):Promise<[any,any]>=>{
        const n=sql.replace(/\s+/g,' ').trim();s.executed.push(n);
        if(n.includes('information_schema.TABLES')&&n.includes("IN ('students'"))return [['students','tenants','student_courses','courses','course_units','course_lessons','course_lesson_completions'].map(table_name=>({table_name,engine:s.contextEngine})),[]];
        if(n.includes('information_schema.TABLES'))return [s.schema?['users','support_tickets','support_ticket_replies','audit_events','admin_user_roles','admin_role_permissions'].map(table_name=>({table_name,engine:s.engine})):[],[]];
        if(n.includes('information_schema.STATISTICS'))return [s.primary?['users','support_tickets','support_ticket_replies','audit_events'].map(table_name=>({table_name,column_name:'id',seq_in_index:1})):[],[]];
        if(n.includes('information_schema.COLUMNS'))return [s.contextReady?['context_kind','context_tenant_id','context_enrollment_id','context_course_id','context_lesson_id'].slice(0,s.contextPartial?2:5).map(column_name=>({column_name})):[],[]];
        if(n.startsWith('SELECT id,is_active')){
          if(!n.includes('FOR UPDATE'))return [s.users.filter(row=>row.id===p[0]),[]];
          const wait=chain;chain=new Promise(resolve=>{releaseLock=resolve;});await wait;
          before=structuredClone({tickets:s.tickets,replies:s.replies,audits:s.audits});
          return [s.users.filter(row=>row.id.toLowerCase()===String(p[0]).toLowerCase()),[]];
        }
        if(n.startsWith('SELECT ur.user_id'))return [s.grantOverflow?Array.from({length:101},()=>({user_id:p[0],permission_key:'support.read'})):s.admin&&p[0]==='admin'?[{user_id:'admin',permission_key:'support.read'}]:[],[]];
        if(n.startsWith('SELECT s.id AS enrollment_id'))return [s.enrolled&&p[0]==='own-enrollment'&&p[1]==='owner'&&p[2]==='tenant-a'?[{enrollment_id:'own-enrollment',tenant_id:'tenant-a'}]:[],[]];
        if(n.startsWith('SELECT sc.id'))return [s.enrolled&&p[0]==='own-enrollment'&&p[1]===context.course_id?[{student_course_id:'link'}]:[],[]];
        if(n.startsWith('SELECT c.id AS course_id'))return [s.coursePublished&&p[0]===context.course_id&&p[1]==='tenant-a'?[{course_id:context.course_id,name:'Synthetic course'}]:[],[]];
        if(n.startsWith('SELECT l.id,l.prerequisite_lesson_id'))return [s.lessonActive&&p[0]==='own-enrollment'&&p[1]===context.lesson_id&&p[2]===context.course_id?[{id:context.lesson_id,title:'Synthetic lesson',is_released:s.released?1:0,is_prerequisite_met:s.prerequisite?1:0}]:[],[]];
        if(n.startsWith('SELECT context_kind'))return [s.tickets.filter(row=>row.id===p[0]).map(row=>({...row})),[]];
        if(n.startsWith('SELECT id,ticket_number'))return [s.tickets.filter(row=>row.id===p[0]).map(row=>({...row})),[]];
        if(n.startsWith('SELECT id,ticket_id'))return [s.replies.filter(row=>row.id===p[0]).map(row=>({...row})),[]];
        if(n.startsWith('SELECT r.id')){
          const row=s.replies.find(row=>row.id===p[0]&&row.ticket_id===p[1]);return [row?[{...row,sender_name:'Synthetic user',sender_role:'student'}]:[],[]];
        }
        if(n.startsWith('INSERT INTO support_tickets')){
          if(s.failInsert)throw Error('insert');
          s.tickets.push({id:p[0],ticket_number:p[1],user_id:p[2],category:p[3],subject:p[4],description:p[5],status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z',context_kind:null,context_tenant_id:null,context_enrollment_id:null,context_course_id:null,context_lesson_id:null});return [{affectedRows:1},[]];
        }
        if(n.startsWith('INSERT INTO support_ticket_replies')){
          s.replies.push({id:p[0],ticket_id:p[1],sender_id:p[2],body:p[3],created_at:'2026-11-05T11:00:00Z'});return [{affectedRows:1},[]];
        }
        if(n.startsWith("UPDATE support_tickets SET context_kind")){const row=s.tickets.find(row=>row.id===p[4]&&row.user_id===p[5]);assert.ok(row);Object.assign(row,{context_kind:'catalog_lesson',context_tenant_id:p[0],context_enrollment_id:p[1],context_course_id:p[2],context_lesson_id:p[3]});return [{affectedRows:1},[]];}
        if(n.startsWith('UPDATE support_tickets')){
          if(s.failStatus)throw Error('status');const row=s.tickets.find(row=>row.id===p.at(-1));row.status=p[0];s.updates++;return [{affectedRows:s.statusAffectedRows},[]];
        }
        if(n.startsWith('INSERT INTO audit_events')){if(s.failAudit)throw Error('audit');s.audits.push(p);return [{affectedRows:1},[]];}
        throw Error('Unexpected SQL '+n);
      },
      commit:async()=>{s.commits++;if(s.failCommit)throw Error('lost acknowledgement');unlock();},
      rollback:async()=>{s.rollbacks++;if(s.failRollback)throw Error('rollback');if(before)Object.assign(s,before);unlock();},
      release:()=>unlock(),destroy:()=>{s.destroys++;unlock();},
    };
  };
  const service=createSupportWriteService({getConnection});
  const create=()=>service.create(actor,key,input);
  return {s,service,create};
}
test('stable request identity is separated by actor and operation, and normalizes key case',()=>{
  assert.equal(supportWriteId('owner','create',key),supportWriteId('owner','create',key.toUpperCase()));
  assert.notEqual(supportWriteId('owner','create',key),supportWriteId('other','create',key));
  assert.notEqual(supportWriteId('owner','create',key),supportWriteId('owner','reply',key));
});
test('concurrent duplicate creation commits one ticket and one sanitized audit',async()=>{
  const h=fixture(),results=await Promise.all([h.create(),h.create()]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,201]);assert.equal(h.s.tickets.length,1);assert.equal(h.s.audits.length,1);assert.equal(h.s.commits,1);
  assert.equal(results[0].body.ticket.id,results[1].body.ticket.id);assert.ok(!JSON.stringify(h.s.audits).includes(input.description));
  assert.equal((await h.service.create(actor,key,{...input,subject:'Changed subject'})).status,409);
});
test('a lost create commit is uncertain; same-key replay finds the committed record',async()=>{
  const h=fixture();h.s.failCommit=true;const first=await h.create();assert.equal(first.body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.s.destroys,1);
  h.s.failCommit=false;const again=await h.create();assert.equal(again.status,200);assert.equal(again.body.unchanged,true);assert.equal(h.s.tickets.length,1);assert.equal(h.s.audits.length,1);
});
for(const failure of ['failAudit','failInsert'] as const)test(`create ${failure} rolls back and same key can recover`,async()=>{
  const h=fixture();h.s[failure]=true;assert.equal((await h.create()).status,503);assert.equal(h.s.tickets.length,0);assert.equal(h.s.audits.length,0);
  h.s[failure]=false;assert.equal((await h.create()).status,201);
});
for(const gate of ['schema','primary','engine','inactive','version','suspended','staff'] as const)test(`support ${gate} gate fails closed before writes`,async()=>{
  const h=fixture();if(gate==='schema')h.s.schema=false;if(gate==='primary')h.s.primary=false;if(gate==='engine')h.s.engine='MyISAM';
  if(gate==='inactive')h.s.users[0].is_active=0;if(gate==='version')h.s.users[0].token_version=1;if(gate==='suspended')h.s.users[0].suspension_active=1;
  const result=await h.service.create(gate==='staff'?{...actor,identitySource:'staff'}:actor,key,input);
  assert.ok([401,403,503].includes(result.status));assert.equal(h.s.tickets.length,0);assert.equal(h.s.audits.length,0);
});
test('invalid key or non-string values are rejected before SQL',async()=>{
  const h=fixture();assert.equal((await h.service.create(actor,'bad',input)).status,400);assert.equal((await h.service.create(actor,key,{...input,subject:['coerced']})).status,400);assert.equal(h.s.executed.length,0);
});
test('reply/status/audit commit together and a duplicate never reopens a closed ticket',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;
  const replies=await Promise.all([h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'}),h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'})]);
  assert.deepEqual(replies.map(row=>row.status).sort(),[200,201]);assert.equal(h.s.replies.length,1);assert.equal(h.s.audits.length,2);assert.equal(h.s.tickets[0].status,'waiting_on_support');
  assert.equal((await h.service.status(actor,ticket.id,{status:'closed'})).status,200);const audits=h.s.audits.length,updates=h.s.updates;
  const again=await h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'});assert.equal(again.status,200);assert.equal(again.body.ticket_status,'closed');assert.equal(h.s.audits.length,audits);assert.equal(h.s.updates,updates);
  assert.equal((await h.service.reply(actor,ticket.id,key,{body:'Changed reply'})).status,409);
  assert.equal((await h.service.status(actor,ticket.id,{status:'closed'})).body.unchanged,true);assert.equal(h.s.audits.length,audits);
});
for(const failure of ['failAudit','failStatus'] as const)test(`reply ${failure} leaves no partial reply or status`,async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s[failure]=true;
  assert.equal((await h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'})).status,503);assert.equal(h.s.replies.length,0);assert.equal(h.s.tickets[0].status,'open');assert.equal(h.s.audits.length,1);
  h.s[failure]=false;assert.equal((await h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'})).status,201);
});
test('reply lost-commit retry returns the original reply without a second audit',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.failCommit=true;
  const first=await h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'});assert.equal(first.body.code,'PERSISTENCE_UNCERTAIN');
  h.s.failCommit=false;const again=await h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'});assert.equal(again.status,200);assert.equal(h.s.replies.length,1);assert.equal(h.s.audits.length,2);
});
test('foreign tickets, revoked support permission and reply key reuse across tickets are refused',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket,admin={id:'admin',tokenVersion:0};
  assert.equal((await h.service.reply(admin,ticket.id,key,{body:'Admin reply'})).status,404);
  h.s.admin=true;assert.equal((await h.service.reply(admin,ticket.id,key,{body:'Admin reply'})).body.ticket_status,'waiting_on_user');
  h.s.admin=false;assert.equal((await h.service.reply(admin,ticket.id,key,{body:'Admin reply'})).status,404);
  await h.service.reply(actor,ticket.id,key,{body:'Owner reply'});
  const other=(await h.service.create(actor,'a1000000-0000-4000-8000-000000000002',input)).body.ticket;
  assert.equal((await h.service.reply(actor,other.id,key,{body:'Owner reply'})).status,409);assert.equal(h.s.tickets[1].status,'open');
});
test('failed begin and rollback discard their connections',async()=>{
  for(const field of ['failBegin','failRollback'] as const){const h=fixture();h.s[field]=true;if(field==='failRollback')h.s.failAudit=true;assert.equal((await h.create()).status,503);assert.equal(h.s.destroys,1);}
});
test('read-only reconciliation is actor scoped, reports missing conservatively and never changes state',async()=>{
  const h=fixture();assert.equal((await h.service.reconcile(actor,'create',key)).body.code,'SUPPORT_ATTEMPT_NOT_FOUND');
  const ticket=(await h.create()).body.ticket;await h.service.reply(actor,ticket.id,key,{body:'Synthetic reply'});
  const commits=h.s.commits,audits=h.s.audits.length;
  assert.equal((await h.service.reconcile(actor,'create',key)).body.ticket.id,ticket.id);
  assert.equal((await h.service.reconcile(actor,'reply',key)).body.ticket_id,ticket.id);
  assert.equal((await h.service.reconcile({id:'admin'},'create',key)).status,404);
  assert.equal(h.s.commits,commits);assert.equal(h.s.audits.length,audits);
});
test('status audit failure rolls back status, and a no-op does not rewrite timestamps or audit',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.failAudit=true;
  assert.equal((await h.service.status(actor,ticket.id,{status:'closed'})).status,503);assert.equal(h.s.tickets[0].status,'open');
  h.s.failAudit=false;assert.equal((await h.service.status(actor,ticket.id,{status:'closed'})).status,200);
  const commits=h.s.commits,audits=h.s.audits.length;assert.equal((await h.service.status(actor,ticket.id,{status:'closed'})).body.unchanged,true);
  assert.equal(h.s.commits,commits);assert.equal(h.s.audits.length,audits);
});
test('server-canonical actor identity deduplicates equivalent user selectors',async()=>{
  const h=fixture(),first=await h.create(),again=await h.service.create({...actor,id:'OWNER'},key,input);
  assert.equal(again.status,200);assert.equal(again.body.ticket.id,first.body.ticket.id);assert.equal(h.s.tickets.length,1);
});
test('unchanged reply status accepts a truthful zero changed-row count and authorization overflow denies',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;await h.service.reply(actor,ticket.id,key,{body:'first reply'});
  h.s.statusAffectedRows=0;assert.equal((await h.service.reply(actor,ticket.id,'a1000000-0000-4000-8000-000000000002',{body:'second reply'})).status,201);
  h.s.grantOverflow=true;assert.equal((await h.service.reply(actor,ticket.id,'a1000000-0000-4000-8000-000000000003',{body:'blocked reply'})).status,503);assert.equal(h.s.replies.length,2);
});
test('lesson context stores server scope atomically and is read through a fresh source proof',async()=>{
  const h=fixture();h.s.contextReady=true;
  const result=await h.service.create(studentActor,key,{...input,context});assert.equal(result.status,201);
  const row=h.s.tickets[0];assert.equal(row.context_tenant_id,'tenant-a');assert.equal(row.context_enrollment_id,'own-enrollment');assert.equal(row.context_lesson_id,context.lesson_id);
  assert.ok(h.s.executed.some(sql=>sql.includes('FROM students s')&&sql.endsWith('FOR UPDATE')));
  assert.ok(!('context_tenant_id'in result.body.ticket));assert.equal(h.s.audits.length,1);
  const read=await h.service.context(studentActor,row.id);assert.equal(read.status,200);assert.equal(read.body.state,'available');
  assert.deepEqual(Object.keys(read.body.context).sort(),['kind','course_id','lesson_id','course_name','lesson_title'].sort());
  assert.ok(!JSON.stringify(read.body).includes('own-enrollment'));
  assert.deepEqual((await h.service.context({...studentActor,tenantId:'tenant-b',studentEnrollmentId:'other'},row.id)).body,{state:'unavailable',context:null});
  h.s.enrolled=false;const revoked=await h.service.context(studentActor,row.id);assert.deepEqual(revoked.body,{state:'unavailable',context:null});
  assert.equal((await h.service.create(studentActor,key,{...input,context})).body.unchanged,true,'confirmed original save is still reconcilable without revealing lesson metadata');
});
for(const gate of ['enrolled','coursePublished','lessonActive','released','prerequisite'] as const)test(`lesson support ${gate} denial creates no ticket or audit`,async()=>{
  const h=fixture();h.s.contextReady=true;h.s[gate]=false;
  const result=await h.service.create(studentActor,key,{...input,context});assert.equal(result.status,gate==='released'||gate==='prerequisite'?409:404);assert.equal(h.s.tickets.length,0);assert.equal(h.s.audits.length,0);
});
test('missing/partial context schema and nontransactional source fail closed; generic support remains available without context columns',async()=>{
  const h=fixture();assert.equal((await h.service.create(studentActor,key,{...input,context})).status,503);assert.equal(h.s.tickets.length,0);
  const generic=await h.create();assert.equal(generic.status,201);assert.equal((await h.service.context(actor,generic.body.ticket.id)).body.state,'unconfigured');
  h.s.contextReady=true;h.s.contextPartial=true;assert.equal((await h.service.create(studentActor,key,{...input,context})).status,503);
  h.s.contextPartial=false;h.s.contextEngine='MyISAM';assert.equal((await h.service.create(studentActor,'a1000000-0000-4000-8000-000000000002',{...input,context})).status,503);
});
test('lesson reference cannot carry authority selectors or be attached by a non-student',async()=>{
  const h=fixture();h.s.contextReady=true;
  assert.equal((await h.service.create(actor,key,{...input,context})).status,403);
  assert.equal((await h.service.create(studentActor,key,{...input,context:{...context,tenant_id:'foreign'}})).status,400);
  assert.equal((await h.service.create({...studentActor,tenantId:'tenant-b'},key,{...input,context})).status,404);
  assert.equal((await h.service.create({...studentActor,studentEnrollmentId:'foreign'},key,{...input,context})).status,404);
  assert.equal(h.s.tickets.length,0);
});
test('context binding rolls back with failed audit and request key cannot be reused for a different context',async()=>{
  const h=fixture();h.s.contextReady=true;h.s.failAudit=true;assert.equal((await h.service.create(studentActor,key,{...input,context})).status,503);assert.equal(h.s.tickets.length,0);
  h.s.failAudit=false;const ticket=(await h.service.create(studentActor,key,{...input,context})).body.ticket;
  assert.equal((await h.service.create(studentActor,key,input)).status,409);
  assert.equal((await h.service.create(studentActor,key,{...input,context:{...context,lesson_id:'c1000000-0000-4000-8000-000000000002'}})).status,409);
  assert.equal(h.s.tickets.length,1);assert.equal(h.s.tickets[0].id,ticket.id);assert.equal(h.s.audits.length,1);
});
test('support admin context view is ticket scoped and withholds context if the requester is inactive',async()=>{
  const h=fixture();h.s.contextReady=true;const ticket=(await h.service.create(studentActor,key,{...input,context})).body.ticket;
  const admin={id:'admin',tokenVersion:0};assert.equal((await h.service.context(admin,ticket.id)).status,404);
  h.s.admin=true;assert.equal((await h.service.context(admin,ticket.id)).body.state,'available');
  h.s.users[0].is_active=0;assert.deepEqual((await h.service.context(admin,ticket.id)).body,{state:'unavailable',context:null});
});
test('lost contextual commit reconciles the same ticket with its original binding',async()=>{
  const h=fixture();h.s.contextReady=true;h.s.failCommit=true;
  assert.equal((await h.service.create(studentActor,key,{...input,context})).body.code,'PERSISTENCE_UNCERTAIN');
  h.s.failCommit=false;const receipt=await h.service.reconcile(studentActor,'create',key);
  assert.equal(receipt.status,200);assert.equal(h.s.tickets.length,1);assert.equal(h.s.audits.length,1);
  assert.equal((await h.service.context(studentActor,receipt.body.ticket.id)).body.context.lesson_id,context.lesson_id);
});
