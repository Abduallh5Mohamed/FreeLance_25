import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupportWriteService, supportWriteId } from '../src/services/support-writes';
const key='a1000000-0000-4000-8000-000000000001';
const actor={id:'owner',tokenVersion:0,identitySource:'users' as const};
const input={category:'technical',subject:'Synthetic support issue',description:'Synthetic description only'};
const context={kind:'catalog_lesson' as const,course_id:'b1000000-0000-4000-8000-000000000001',lesson_id:'c1000000-0000-4000-8000-000000000001'};
const studentActor={...actor,role:'student',tenantId:'tenant-a',studentEnrollmentId:'own-enrollment'};
const assignmentAdmin={id:'admin',tokenVersion:0};
function fixture(){
  const s={tickets:[] as any[],replies:[] as any[],notes:[] as any[],audits:[] as any[],users:[{id:'owner',is_active:1,token_version:0,suspension_active:0},{id:'admin',is_active:1,token_version:0,suspension_active:0}],
    schema:true,primary:true,engine:'InnoDB',admin:false,statusAffectedRows:1,grantOverflow:false,failAudit:false,failStatus:false,failInsert:false,failCommit:false,failBegin:false,failRollback:false,
    contextReady:false,contextPartial:false,contextEngine:'InnoDB',enrolled:true,coursePublished:true,lessonActive:true,released:true,prerequisite:true,
    notesReady:false,notesEngine:'InnoDB',notesColumns:true,notesPrimary:true,notesIndex:true,badNoteEpoch:false,assignedIndex:true,
    assignmentReady:false,assignmentEngine:'InnoDB',assignmentColumns:true,assignmentPrimary:true,assignments:[] as any[],targetEligible:true,targetActive:true,targetSuspended:false,failAssignment:false,failReceipt:false,candidateRows:[] as any[],
    commits:0,rollbacks:0,destroys:0,updates:0,executed:[] as string[]};
  let chain=Promise.resolve();
  const getConnection=async()=>{
    let before:any,releaseLock:(()=>void)|null=null;
    const unlock=()=>{releaseLock?.();releaseLock=null;};
    return {
      beginTransaction:async()=>{if(s.failBegin)throw Error('begin');},
      execute:async(sql:string,p:any[]=[]):Promise<[any,any]>=>{
        const n=sql.replace(/\s+/g,' ').trim();s.executed.push(n);
        if(n.includes("INDEX_NAME='idx_support_assignee_id'"))return [s.assignedIndex?['assigned_to','id'].map((column_name,index)=>({column_name,seq_in_index:index+1})):[],[]];
        if(n.includes('FROM support_tickets t WHERE t.assigned_to=?')){
          assert.match(n,/ORDER BY t.id ASC LIMIT 26$/);assert.equal(p[0],'admin');
          return [s.tickets.filter(row=>row.assigned_to===p[0]&&(p.length===1||row.id>p[1])).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,26)
            .map(row=>({...row,created_at_epoch:Date.parse(row.created_at)/1000,updated_at_epoch:Date.parse(row.updated_at)/1000})),[]];
        }
        if(n.startsWith('SELECT users.id,users.name')){
          assert.match(n,/users.is_active=1 AND NOT \(users.suspended_until IS NOT NULL AND users.suspended_until > UTC_TIMESTAMP\(\)\)/);
          assert.match(n,/EXISTS \(SELECT 1 FROM admin_user_roles/);assert.match(n,/rp.permission_key='support.read'/);assert.match(n,/ORDER BY users.id ASC LIMIT 26$/);
          return [s.candidateRows.filter(row=>row.active&&!row.suspended&&row.granted&&(!p.length||row.id>p[0])).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,26).map(({id,name})=>({id,name})),[]];
        }
        if(n.includes("TABLE_NAME='support_assignment_attempts'")){
          if(!s.assignmentReady)return [[],[]];
          if(n.includes('information_schema.TABLES'))return [[{engine:s.assignmentEngine}],[]];
          return [s.assignmentPrimary?[{column_name:'id',seq_in_index:1}]:[],[]];
        }
        if(n.includes('information_schema.COLUMNS')&&n.includes("'support_assignment_attempts'"))return [s.assignmentReady&&s.assignmentColumns?[
          ...['assigned_to','assignment_version'].map(column_name=>({table_name:'support_tickets',column_name})),
          ...['id','ticket_id','actor_user_id','assigned_to','expected_version','result_version','changed'].map(column_name=>({table_name:'support_assignment_attempts',column_name})),
        ]:[],[]];
        if(n.startsWith('SELECT id,name,is_active'))return [p[0]==='admin'||p[0]==='ADMIN'?[{id:'admin',name:'Synthetic agent',is_active:s.targetActive?1:0,suspension_active:s.targetSuspended?1:0}]:p[0]==='agent-b'?[{id:'agent-b',name:'Synthetic second agent',is_active:1,suspension_active:0}]:[],[]];
        if(n.startsWith('SELECT id,assigned_to,assignment_version'))return [s.tickets.filter(row=>row.id===p[0]).map(row=>({id:row.id,assigned_to:row.assigned_to??null,assignment_version:row.assignment_version??0})),[]];
        if(n.startsWith('SELECT id,ticket_id,actor_user_id,assigned_to'))return [s.assignments.filter(row=>row.id===p[0]&&row.ticket_id===p[1]).map(row=>({...row})),[]];
        if(n.startsWith('UPDATE support_tickets SET assigned_to=')){
          if(s.failAssignment)throw Error('assignment');const row=s.tickets.find(row=>row.id===p[2]&&(row.assignment_version??0)===p[3]);
          if(!row)return [{affectedRows:0},[]];Object.assign(row,{assigned_to:p[0],assignment_version:p[1]});return [{affectedRows:1},[]];
        }
        if(n.startsWith('INSERT INTO support_assignment_attempts')){
          if(s.failReceipt)throw Error('receipt');if(s.assignments.some(row=>row.id===p[0]))throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});
          s.assignments.push({id:p[0],ticket_id:p[1],actor_user_id:p[2],assigned_to:p[3],expected_version:p[4],result_version:p[5],changed:p[6]});return [{affectedRows:1},[]];
        }
        if(n.includes("TABLE_NAME='support_ticket_private_notes'")){
          if(!s.notesReady)return [[],[]];
          if(n.includes('information_schema.TABLES'))return [[{engine:s.notesEngine}],[]];
          if(n.includes('information_schema.COLUMNS'))return [(s.notesColumns?['id','ticket_id','author_user_id','body','created_at']:['id']).map(column_name=>({column_name})),[]];
          if(n.includes("INDEX_NAME='PRIMARY'"))return [s.notesPrimary?[{column_name:'id',seq_in_index:1}]:[],[]];
          return [s.notesIndex?['ticket_id','created_at','id'].map((column_name,index)=>({column_name,seq_in_index:index+1})):[],[]];
        }
        if(n.includes('information_schema.TABLES')&&n.includes("IN ('students'"))return [['students','tenants','student_courses','courses','course_units','course_lessons','course_lesson_completions'].map(table_name=>({table_name,engine:s.contextEngine})),[]];
        if(n.includes('information_schema.TABLES'))return [s.schema?['users','support_tickets','support_ticket_replies','audit_events','admin_user_roles','admin_role_permissions'].map(table_name=>({table_name,engine:s.engine})):[],[]];
        if(n.includes('information_schema.STATISTICS'))return [s.primary?['users','support_tickets','support_ticket_replies','audit_events'].map(table_name=>({table_name,column_name:'id',seq_in_index:1})):[],[]];
        if(n.includes('information_schema.COLUMNS'))return [s.contextReady?['context_kind','context_tenant_id','context_enrollment_id','context_course_id','context_lesson_id'].slice(0,s.contextPartial?2:5).map(column_name=>({column_name})):[],[]];
        if(n.startsWith('SELECT id,is_active')){
          if(!n.includes('FOR UPDATE'))return [s.users.filter(row=>row.id===p[0]),[]];
          const wait=chain;chain=new Promise(resolve=>{releaseLock=resolve;});await wait;
          before=structuredClone({tickets:s.tickets,replies:s.replies,notes:s.notes,audits:s.audits,assignments:s.assignments});
          return [s.users.filter(row=>row.id.toLowerCase()===String(p[0]).toLowerCase()),[]];
        }
        if(n.startsWith('SELECT ur.user_id'))return [s.grantOverflow?Array.from({length:101},()=>({user_id:p[0],permission_key:'support.read'})):s.admin&&(p[0]==='admin'||p[0]==='agent-b'&&s.targetEligible)?[{user_id:p[0],permission_key:'support.read'}]:[],[]];
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
        if(n.startsWith('SELECT n.id,n.ticket_id')){
          const project=(row:any)=>({...row,author_id:row.author_user_id,author_name:'Synthetic agent',created_at_epoch:s.badNoteEpoch?'invalid':row.created_at_epoch});
          if(n.includes('WHERE n.id=?'))return [s.notes.filter(row=>row.id===p[0]&&row.ticket_id===p[1]).map(project),[]];
          const anchored=n.includes('support_ticket_private_notes anchor'),ticketId=p[anchored?1:0],anchor=anchored?s.notes.find(row=>row.id===p[0]&&row.ticket_id===ticketId):null;
          return [s.notes.filter(row=>row.ticket_id===ticketId&&(!anchored||anchor&&(row.created_at_epoch<anchor.created_at_epoch||row.created_at_epoch===anchor.created_at_epoch&&row.id<anchor.id)))
            .sort((a,b)=>b.created_at_epoch-a.created_at_epoch||b.id.localeCompare(a.id)).slice(0,101).map(project),[]];
        }
        if(n.startsWith('INSERT INTO support_tickets')){
          if(s.failInsert)throw Error('insert');
          s.tickets.push({id:p[0],ticket_number:p[1],user_id:p[2],category:p[3],subject:p[4],description:p[5],status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z',context_kind:null,context_tenant_id:null,context_enrollment_id:null,context_course_id:null,context_lesson_id:null});return [{affectedRows:1},[]];
        }
        if(n.startsWith('INSERT INTO support_ticket_replies')){
          s.replies.push({id:p[0],ticket_id:p[1],sender_id:p[2],body:p[3],created_at:'2026-11-05T11:00:00Z'});return [{affectedRows:1},[]];
        }
        if(n.startsWith('INSERT INTO support_ticket_private_notes')){if(s.failInsert)throw Error('insert');if(s.notes.some(row=>row.id===p[0]))throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});s.notes.push({id:p[0],ticket_id:p[1],author_user_id:p[2],body:p[3],created_at_epoch:1762336800});return [{affectedRows:1},[]];}
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

async function assignmentFixture(){const h=fixture(),ticket=(await h.create()).body.ticket;h.s.admin=true;h.s.assignmentReady=true;return {...h,ticket};}
test('assigned queue pins canonical caller and pages privately even after an anchor is transferred',async()=>{
  const h=await assignmentFixture();h.s.tickets=[];
  for(let n=0;n<61;n++)h.s.tickets.push({...h.ticket,id:`ticket-${String(n).padStart(3,'0')}`,assigned_to:'admin'});
  h.s.tickets.push({...h.ticket,id:'foreign',assigned_to:'other',description:'never-return',phone:'private'});
  assert.equal((await h.service.assigned(actor)).status,404);assert.ok(!h.s.executed.some(sql=>sql.includes('FROM support_tickets t WHERE t.assigned_to')));
  const first=await h.service.assigned({...assignmentAdmin,id:'ADMIN'});assert.equal(first.status,200);assert.equal(first.body.tickets.length,25);
  assert.deepEqual(Object.keys(first.body.tickets[0]),['id','ticket_number','category','subject','status','priority','created_at','updated_at']);
  assert.equal(first.body.tickets[0].created_at,'2026-11-05T10:00:00.000Z');
  h.s.tickets.find(row=>row.id===first.body.next_cursor).assigned_to='other';
  const second=await h.service.assigned(assignmentAdmin,first.body.next_cursor),third=await h.service.assigned(assignmentAdmin,second.body.next_cursor);
  assert.equal(second.body.tickets.length,25);assert.equal(third.body.tickets.length,11);assert.equal(third.body.next_cursor,null);
  assert.equal(new Set([...first.body.tickets,...second.body.tickets,...third.body.tickets].map(row=>row.id)).size,61);
  assert.equal((await h.service.assigned(assignmentAdmin)).body.tickets.some(row=>row.id===first.body.next_cursor),false);assert.equal(h.s.audits.length,1);
});
test('assigned queue rejects forged selectors, missing schema/index, revoked grants and corrupt dates',async()=>{
  const h=await assignmentFixture();
  const before=h.s.executed.length;assert.equal((await h.service.assigned(assignmentAdmin,['forged'])).status,400);assert.equal(h.s.executed.length,before);
  h.s.assignedIndex=false;assert.equal((await h.service.assigned(assignmentAdmin)).body.code,'SUPPORT_ASSIGNED_UNAVAILABLE');
  h.s.assignedIndex=true;h.s.assignmentReady=false;assert.equal((await h.service.assigned(assignmentAdmin)).status,503);
  h.s.assignmentReady=true;h.s.tickets[0].assigned_to='admin';h.s.tickets[0].updated_at='invalid';assert.equal((await h.service.assigned(assignmentAdmin)).status,503);
  h.s.admin=false;assert.equal((await h.service.assigned({...assignmentAdmin,role:'admin'})).status,404);assert.equal(h.s.audits.length,1);
});
test('assignment candidate discovery is private, bounded, permission filtered and keyset paged',async()=>{
  const h=await assignmentFixture();
  h.s.candidateRows=Array.from({length:61},(_,n)=>({id:`agent-${String(n).padStart(3,'0')}`,name:`Agent ${n}`,active:true,suspended:false,granted:true,phone:'never-return'}));
  h.s.candidateRows.push({id:'inactive',name:'Inactive',active:false,suspended:false,granted:true},{id:'suspended',name:'Suspended',active:true,suspended:true,granted:true},{id:'role-only',name:'Role only',active:true,suspended:false,granted:false});
  assert.equal((await h.service.assignmentCandidates(actor,h.ticket.id)).status,404);
  assert.ok(!h.s.executed.some(sql=>sql.startsWith('SELECT users.id')));
  let cursor:string|undefined;const seen:string[]=[];
  do{const result=await h.service.assignmentCandidates(assignmentAdmin,h.ticket.id,cursor);assert.equal(result.status,200);assert.ok(result.body.candidates.length<=25);
    for(const person of result.body.candidates){assert.deepEqual(Object.keys(person),['id','name']);seen.push(person.id);}cursor=result.body.next_cursor??undefined;
  }while(cursor);
  assert.equal(seen.length,61);assert.equal(new Set(seen).size,61);assert.equal(h.s.audits.length,1);
  const before=h.s.executed.length;assert.equal((await h.service.assignmentCandidates(assignmentAdmin,h.ticket.id,['forged'])).status,400);assert.equal(h.s.executed.length,before);
  h.s.assignmentReady=false;assert.equal((await h.service.assignmentCandidates(assignmentAdmin,h.ticket.id)).status,503);
  h.s.assignmentReady=true;h.s.admin=false;assert.equal((await h.service.assignmentCandidates(assignmentAdmin,h.ticket.id)).status,404);
});
test('assignment requires verified support authority, never ticket ownership or a role label',async()=>{
  const h=await assignmentFixture();
  assert.equal((await h.service.assignment(actor,h.ticket.id)).status,404);
  assert.equal((await h.service.assign(actor,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).status,404);
  h.s.admin=false;assert.equal((await h.service.assignment({...assignmentAdmin,role:'super_admin'},h.ticket.id)).status,404);
  assert.equal(h.s.assignments.length,0);assert.ok(!h.s.executed.some(sql=>sql.startsWith('SELECT id,assigned_to')));
});
for(const gate of ['assignmentReady','assignmentColumns','assignmentPrimary','assignmentEngine'] as const)test(`assignment ${gate} gate fails closed without writes`,async()=>{
  const h=await assignmentFixture();if(gate==='assignmentEngine')h.s.assignmentEngine='MyISAM';else h.s[gate]=false;
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).body.code,'SUPPORT_ASSIGNMENT_UNAVAILABLE');
  assert.equal(h.s.assignments.length,0);assert.equal(h.s.audits.length,1);
});
test('assignment serializes competing decisions and identical concurrent attempts deduplicate',async()=>{
  const h=await assignmentFixture(),payload={assigned_to:'admin',expected_version:0};
  const same=await Promise.all([h.service.assign(assignmentAdmin,h.ticket.id,key,payload),h.service.assign(assignmentAdmin,h.ticket.id,key,payload)]);
  assert.deepEqual(same.map(row=>row.status),[201,200]);assert.equal(h.s.assignments.length,1);assert.equal(h.s.audits.length,2);
  const updated=h.s.tickets[0];assert.equal(updated.status,'open');assert.equal(updated.updated_at,h.ticket.updated_at);assert.equal(h.s.replies.length,0);
  const stale=await h.service.assign(assignmentAdmin,h.ticket.id,'a1000000-0000-4000-8000-000000000002',{assigned_to:'agent-b',expected_version:0});
  assert.equal(stale.body.code,'SUPPORT_ASSIGNMENT_STALE');assert.equal(h.s.assignments.length,1);
  const competing=await Promise.all(['a1000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000004'].map((key,index)=>h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:index?'agent-b':null,expected_version:1})));
  assert.deepEqual(competing.map(row=>row.status).sort(),[201,409]);assert.equal(h.s.tickets[0].assignment_version,2);
});
test('transfer and unassignment preserve durable historical receipts after later decisions',async()=>{
  const h=await assignmentFixture();
  await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'ADMIN',expected_version:0});
  const second='a1000000-0000-4000-8000-000000000002';
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,second,{assigned_to:'agent-b',expected_version:1})).status,201);
  const commits=h.s.commits,audits=h.s.audits.length;
  const old=await h.service.reconcileAssignment(assignmentAdmin,h.ticket.id,key);assert.deepEqual(old.body.assignment,{ticket_id:h.ticket.id,assigned_to:'admin',version:1});
  assert.equal((await h.service.assignment(assignmentAdmin,h.ticket.id)).body.assignment.assigned_to,'agent-b');
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'ADMIN',expected_version:0})).status,200);
  assert.equal(h.s.commits,commits);assert.equal(h.s.audits.length,audits);
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'agent-b',expected_version:0})).status,409);
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,second,{assigned_to:'agent-b',expected_version:2})).status,409);
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,'a1000000-0000-4000-8000-000000000003',{assigned_to:null,expected_version:2})).body.assignment.version,3);
});
test('assignment no-op has a receipt and audit without changing assignment version or public state',async()=>{
  const h=await assignmentFixture();const ack=await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:null,expected_version:0});
  assert.equal(ack.status,201);assert.equal(ack.body.changed,false);assert.equal(ack.body.assignment.version,0);assert.equal(h.s.assignments.length,1);
  assert.equal((await h.service.reconcileAssignment(assignmentAdmin,h.ticket.id,key)).body.changed,false);
  assert.ok(!JSON.stringify(h.s.audits).includes('Synthetic agent'));assert.equal(h.s.tickets[0].updated_at,h.ticket.updated_at);
});
for(const failure of ['failAudit','failAssignment','failReceipt'] as const)test(`assignment ${failure} rolls back receipt, assignment and audit together`,async()=>{
  const h=await assignmentFixture();h.s[failure]=true;
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).status,503);
  assert.equal(h.s.assignments.length,0);assert.equal(h.s.tickets[0].assigned_to,undefined);assert.equal(h.s.audits.length,1);
  h.s[failure]=false;assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).status,201);
});
test('lost assignment commit reconciles by GET without another mutation and remains actor/ticket scoped',async()=>{
  const h=await assignmentFixture();h.s.failCommit=true;
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.s.destroys,1);
  h.s.failCommit=false;assert.equal((await h.service.reconcileAssignment(assignmentAdmin,h.ticket.id,key)).body.assignment.version,1);
  assert.equal(h.s.assignments.length,1);assert.equal(h.s.audits.length,2);
  const other=(await h.service.create(actor,'a1000000-0000-4000-8000-000000000002',input)).body.ticket;
  assert.equal((await h.service.reconcileAssignment(assignmentAdmin,other.id,key)).body.code,'SUPPORT_ATTEMPT_NOT_FOUND');
  assert.equal((await h.service.assign(assignmentAdmin,other.id,key,{assigned_to:'admin',expected_version:0})).status,409);
  assert.equal(h.s.tickets[1].assigned_to,undefined);
  assert.equal((await h.service.reconcile(actor,'assign',key)).status,400);
  h.s.admin=false;assert.equal((await h.service.reconcileAssignment(assignmentAdmin,h.ticket.id,key)).status,404);
});
test('assignee must be live and currently support-authorized; lost target grant hides its current name',async()=>{
  const h=await assignmentFixture();h.s.targetActive=false;
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).body.code,'SUPPORT_ASSIGNEE_UNAVAILABLE');
  h.s.targetActive=true;h.s.targetSuspended=true;
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).status,409);
  h.s.targetSuspended=false;
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'owner',expected_version:0})).status,409);
  await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'agent-b',expected_version:0});h.s.targetEligible=false;
  const read=await h.service.assignment(assignmentAdmin,h.ticket.id);assert.equal(read.body.assignee,null);assert.equal(read.body.assignment.assigned_to,'agent-b');
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,'a1000000-0000-4000-8000-000000000002',{assigned_to:'agent-b',expected_version:1})).status,409);
});
test('closed tickets reject new assignment decisions, but preserve old receipts; invalid selectors never reach SQL',async()=>{
  const h=await assignmentFixture();await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0});
  await h.service.status(actor,h.ticket.id,{status:'closed'});
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,'a1000000-0000-4000-8000-000000000002',{assigned_to:null,expected_version:1})).body.code,'SUPPORT_TICKET_CLOSED');
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0})).status,200);
  const before=h.s.executed.length;
  for(const payload of [{assigned_to:'admin',expected_version:'1'},{assigned_to:[],expected_version:1},{assigned_to:null,expected_version:NaN},{assigned_to:null,expected_version:-1},{assigned_to:null,expected_version:2147483647},{assigned_to:null,expected_version:1,tenant_id:'forged'}])
    assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,key,payload)).status,400);
  assert.equal((await h.service.assign(assignmentAdmin,h.ticket.id,'bad',{assigned_to:null,expected_version:1})).status,400);assert.equal(h.s.executed.length,before);
});
test('assignment reads fail closed on corrupt state or receipts and authorization overflow',async()=>{
  const h=await assignmentFixture();
  assert.equal((await h.service.reconcileAssignment(assignmentAdmin,h.ticket.id,key)).body.code,'SUPPORT_ATTEMPT_NOT_FOUND');
  h.s.tickets[0].assignment_version='0';assert.equal((await h.service.assignment(assignmentAdmin,h.ticket.id)).status,503);
  h.s.tickets[0].assignment_version=0;await h.service.assign(assignmentAdmin,h.ticket.id,key,{assigned_to:'admin',expected_version:0});
  h.s.assignments[0].result_version=7;assert.equal((await h.service.reconcileAssignment(assignmentAdmin,h.ticket.id,key)).status,503);
  h.s.grantOverflow=true;assert.equal((await h.service.assignment(assignmentAdmin,h.ticket.id)).status,503);
  assert.equal(h.s.assignments.length,1);assert.equal(h.s.audits.length,2);
});
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
test('private note ownership or role label alone never grants access; a verified support grant is required',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.notesReady=true;
  for(const viewer of [actor,{...actor,role:'admin'},{id:'admin',role:'admin'}]){
    assert.equal((await h.service.privateNotes(viewer,ticket.id)).status,404);
    assert.equal((await h.service.addPrivateNote(viewer,ticket.id,key,{body:'PRIVATE-NOTE-SYNTHETIC'})).status,404);
    assert.equal((await h.service.reconcilePrivateNote(viewer,ticket.id,key)).status,404);
  }
  assert.equal(h.s.notes.length,0);assert.ok(!h.s.executed.some(sql=>sql.startsWith('SELECT n.id')));
});
test('private note and sanitized audit commit once, without changing public replies or ticket status',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.notesReady=true;h.s.admin=true;const admin={id:'admin'};
  const results=await Promise.all([h.service.addPrivateNote(admin,ticket.id,key,{body:'PRIVATE-NOTE-SYNTHETIC'}),h.service.addPrivateNote(admin,ticket.id,key,{body:'PRIVATE-NOTE-SYNTHETIC'})]);
  assert.deepEqual(results.map(row=>row.status).sort(),[200,201]);assert.equal(h.s.notes.length,1);assert.equal(h.s.replies.length,0);assert.equal(h.s.tickets[0].status,'open');assert.equal(h.s.updates,0);
  assert.equal(h.s.audits.length,2);assert.ok(!JSON.stringify(h.s.audits).includes('PRIVATE-NOTE-SYNTHETIC'));
  assert.equal(results[0].body.note.created_at,new Date(1762336800*1000).toISOString());
  assert.equal((await h.service.addPrivateNote(admin,ticket.id,key,{body:'changed'})).status,409);
  assert.equal((await h.service.reconcile(admin,'reply',key)).status,404,'the public reply attempt namespace must not resolve a private note');
  const receipt=await h.service.reconcilePrivateNote(admin,ticket.id,key);assert.equal(receipt.status,200);assert.equal(receipt.body.note.id,h.s.notes[0].id);
  const other=(await h.service.create(actor,'a1000000-0000-4000-8000-000000000002',input)).body.ticket;
  assert.equal((await h.service.addPrivateNote(admin,other.id,key,{body:'PRIVATE-NOTE-SYNTHETIC'})).status,409);assert.equal(h.s.notes.length,1);
  await h.service.status(actor,ticket.id,{status:'closed'});const updates=h.s.updates;
  assert.equal((await h.service.addPrivateNote(admin,ticket.id,'a1000000-0000-4000-8000-000000000003',{body:'Closed-ticket diagnostic note'})).status,201);
  assert.equal(h.s.tickets[0].status,'closed');assert.equal(h.s.updates,updates);assert.equal(h.s.replies.length,0);
  h.s.admin=false;assert.equal((await h.service.privateNotes(admin,ticket.id)).status,404);assert.equal((await h.service.reconcilePrivateNote(admin,ticket.id,key)).status,404);
});
for(const gate of ['notesReady','notesColumns','notesPrimary','notesIndex','notesEngine'] as const)test(`private note ${gate} gate fails closed`,async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.admin=true;h.s.notesReady=true;
  if(gate==='notesEngine')h.s.notesEngine='MyISAM';else h.s[gate]=false;
  assert.equal((await h.service.addPrivateNote({id:'admin'},ticket.id,key,{body:'private'})).status,503);assert.equal(h.s.notes.length,0);assert.equal(h.s.audits.length,1);
});
for(const failure of ['failAudit','failInsert'] as const)test(`private note ${failure} rolls back without changing public state`,async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.notesReady=true;h.s.admin=true;h.s[failure]=true;
  assert.equal((await h.service.addPrivateNote({id:'admin'},ticket.id,key,{body:'private'})).status,503);assert.equal(h.s.notes.length,0);assert.equal(h.s.replies.length,0);assert.equal(h.s.audits.length,1);
});
test('lost private note commit recovers by read without another insert/audit',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.notesReady=true;h.s.admin=true;h.s.failCommit=true;
  assert.equal((await h.service.addPrivateNote({id:'admin'},ticket.id,key,{body:'private'})).body.code,'PERSISTENCE_UNCERTAIN');assert.equal(h.s.destroys,1);
  h.s.failCommit=false;assert.equal((await h.service.reconcilePrivateNote({id:'admin'},ticket.id,key)).status,200);assert.equal(h.s.notes.length,1);assert.equal(h.s.audits.length,2);
});
test('private notes keyset page preserves ties and refuses a different ticket anchor',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.notesReady=true;h.s.admin=true;
  const noteId=(n:number)=>`e1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  for(let n=1;n<=205;n++)h.s.notes.push({id:noteId(n),ticket_id:ticket.id,author_user_id:'admin',body:`private ${n}`,created_at_epoch:1762336800});
  const first=await h.service.privateNotes({id:'admin'},ticket.id);assert.equal(first.status,200);assert.equal(first.body.notes.length,100);assert.equal(first.body.next_cursor,noteId(106));
  const second=await h.service.privateNotes({id:'admin'},ticket.id,first.body.next_cursor);assert.equal(second.body.next_cursor,noteId(6));
  const third=await h.service.privateNotes({id:'admin'},ticket.id,second.body.next_cursor);assert.equal(third.body.notes.length,5);assert.equal(third.body.next_cursor,null);
  assert.equal(new Set([...first.body.notes,...second.body.notes,...third.body.notes].map(row=>row.id)).size,205);
  const other=(await h.service.create(actor,'a1000000-0000-4000-8000-000000000002',input)).body.ticket;
  assert.equal((await h.service.privateNotes({id:'admin'},other.id,noteId(106))).status,400);
  assert.equal((await h.service.privateNotes({id:'admin'},ticket.id,['repeated'])).status,400);
});
test('private note input cannot request public visibility; invalid timestamps never become fabricated dates',async()=>{
  const h=fixture(),ticket=(await h.create()).body.ticket;h.s.notesReady=true;h.s.admin=true;
  assert.equal((await h.service.addPrivateNote({id:'admin'},ticket.id,key,{body:'private',visibility:'public'})).status,400);
  assert.equal((await h.service.addPrivateNote({id:'admin'},ticket.id,key,{body:['coerced']})).status,400);
  await h.service.addPrivateNote({id:'admin'},ticket.id,key,{body:'private'});h.s.badNoteEpoch=true;
  assert.equal((await h.service.privateNotes({id:'admin'},ticket.id)).status,503);
  h.s.badNoteEpoch=false;h.s.notes[0].body='x'.repeat(10001);assert.equal((await h.service.privateNotes({id:'admin'},ticket.id)).status,503);
});
