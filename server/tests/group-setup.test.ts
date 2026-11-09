import assert from 'node:assert/strict';
import test from 'node:test';
import {Router} from 'express';
import type {AuthRequest} from '../src/middleware/auth';
import {createGroupSetupRouter} from '../src/routes/group-setup';
import {invokeRoute} from './helpers/m2-harness';
const id=(n:number)=>`b4000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
    const state={owner:true,ownerReads:0,revoke:false,groupReads:0,changed:false,foreign:false,metadata:true,index:true,fail:false,released:0,destroyed:0,
        actor:{id:'owner',tenantId:'tenant',role:'instructor'} as AuthRequest['user'],headers:{} as Record<string,string>,
        group:{id:id(1),name:'Group',course_id:id(2),course_name:'Math',course_active:1,is_active:1,max_students:30,instructor_id:'teacher',branch_scope:'tenant',branch_id:null,branch_valid:1},
        students:[{id:'enrollment-one',is_offline:0,enrollment_live:1,account_live:1,assigned_live:1}],teachers:[{name:'Teacher'}],
        sessions:[{id:id(3),title:'Lesson',starts_at:'2026-11-09T10:00:00.000Z'}]};
    const calls:Array<{sql:string;params:unknown[]}>=[];
    const connection={
        execute:async(sql:string,params:unknown[]=[])=>{
            calls.push({sql,params});assert.match(sql.trim(),/^SELECT /i);assert.doesNotMatch(sql,/SELECT\s+\*|FOR UPDATE|phone|email|password/i);
            if(state.fail)throw Error('private SQL outage');
            if(sql.startsWith('SELECT t.owner_user_id')){state.ownerReads++;assert.deepEqual(params,['tenant','owner']);return[state.owner&&!(state.revoke&&state.ownerReads>1)?[{owner_user_id:'owner'}]:[],[]];}
            if(sql.startsWith('SELECT g.id,g.name')){state.groupReads++;assert.deepEqual(params,['tenant',id(1)]);return[state.foreign?[]:[{...state.group,...state.changed&&state.groupReads>1?{name:'Changed'}:{}}],[]];}
            if(sql.startsWith('SELECT s.id,')){assert.deepEqual(params,[id(2),'tenant',id(1)]);return[state.students,[]];}
            if(sql.startsWith('SELECT u.name'))return[state.teachers,[]];
            if(sql.includes('information_schema.COLUMNS'))return[state.metadata?['id','tenant_id','group_id','audience','title','starts_at','ends_at','status'].map(column_name=>({column_name})):[],[]];
            if(sql.includes('information_schema.STATISTICS'))return[state.index?['tenant_id','group_id','starts_at'].map((column_name,i)=>({index_name:'group_time',column_name,seq:i+1})):[],[]];
            if(sql.startsWith('SELECT id,title,DATE_FORMAT'))return[state.sessions,[]];
            throw Error('Unexpected SQL');
        },beginTransaction:async()=>{throw Error('no transaction writes');},commit:async()=>{throw Error('no commit');},rollback:async()=>{throw Error('no rollback needed');},release:()=>{state.released++;},destroy:()=>{state.destroyed++;},
    };
    const router=Router();router.use((req,_res,next)=>{(req as AuthRequest).user=state.actor;Object.assign(req.headers,state.headers);next();});
    router.use('/api/tenants/me/catalog',createGroupSetupRouter({getConnection:async()=>connection,now:()=>new Date('2026-11-07T10:00:00.000Z')}));
    const request=(query:Record<string,string>={})=>invokeRoute(router,{method:'GET',url:'/api/tenants/me/catalog/groups/'+id(1)+'/setup',query});
    return{state,calls,request};
}
test('group setup returns factual separate stages without treating a green checklist as production readiness',async()=>{
    const h=fixture(),r=await h.request(),body=r.body as any;assert.equal(r.statusCode,200);assert.equal(body.readiness,'review_only');assert.equal(body.next_action,'practice_handover');assert.deepEqual(body.issues,[]);
    assert.deepEqual(body.students,{total:1,active:1,inactive:0,offline:0,missing_account:0,missing_course_assignment:0});assert.equal(body.instructor.name,'Teacher');assert.equal(body.schedule.sessions.length,1);
    assert.equal(r.headers?.['cache-control'],'no-store');assert.equal(h.state.released,1);assert.doesNotMatch(JSON.stringify(body),/enrollment-one|instructor_id|user_id/);
});
test('anonymous, nonowner, staff namespace, billing and impersonation cannot use the owner checklist',async()=>{
    for(const kind of ['anonymous','nonowner','staff','billing','impersonation']){const h=fixture();
        if(kind==='anonymous')h.state.actor=undefined;if(kind==='nonowner')h.state.owner=false;
        if(kind==='staff')h.state.actor={...h.state.actor!,identitySource:'staff'};if(kind==='billing')h.state.actor={...h.state.actor!,billingOnly:true};if(kind==='impersonation')h.state.headers['x-impersonation']='opaque';
        const r=await h.request();assert.equal(r.statusCode,kind==='anonymous'?401:403,kind);assert.equal(h.calls.some(c=>c.sql.startsWith('SELECT g.id')),false);
    }
});
test('foreign group and authority selectors never expose an unrelated group',async()=>{
    const h=fixture();h.state.foreign=true;assert.equal((await h.request()).statusCode,404);
    for(const query of [{tenant_id:'foreign'},{student_id:'foreign'}]){const f=fixture();assert.equal((await f.request(query)).statusCode,400);assert.equal(f.calls.length,0);}
});
test('row counts distinguish inactive enrollment, unavailable account and absent course assignment',async()=>{
    const h=fixture();h.state.students=[{id:'one',is_offline:0,enrollment_live:1,account_live:0,assigned_live:1},{id:'two',is_offline:0,enrollment_live:1,account_live:1,assigned_live:0},{id:'three',is_offline:0,enrollment_live:0,account_live:0,assigned_live:0}];
    const b=(await h.request()).body as any;assert.deepEqual(b.students,{total:3,active:2,inactive:1,offline:0,missing_account:1,missing_course_assignment:1});assert.deepEqual(b.issues,['review_accounts','review_course_assignments']);
});
test('missing concrete schedule schema or index is unknown, not an empty generated timetable',async()=>{
    for(const source of ['schema','index']){const h=fixture();if(source==='schema')h.state.metadata=false;else h.state.index=false;
        const b=(await h.request()).body as any;assert.deepEqual(b.schedule,{status:'unavailable',sessions:[]});assert.equal(b.next_action,'verify_schedule_source');assert.equal(h.calls.some(c=>c.sql.startsWith('SELECT id,title')),false);}
    const h=fixture();h.state.sessions=[];const b=(await h.request()).body as any;assert.equal(b.schedule.status,'available');assert.equal(b.next_action,'prepare_sessions');
});

test('active offline enrollment does not require an account; online account and course assignment stay separate',async()=>{
 const h=fixture();h.state.students=[{id:'offline',is_offline:1,enrollment_live:1,account_live:0,assigned_live:1},{id:'online',is_offline:0,enrollment_live:1,account_live:0,assigned_live:0}];const r=await h.request(),b=r.body as any;
 assert.equal(r.statusCode,200);assert.deepEqual(b.students,{total:2,active:2,inactive:0,offline:1,missing_account:1,missing_course_assignment:1});
 h.state.students=h.state.students.slice(0,1);const ready=(await h.request()).body as any;assert.equal(ready.students.missing_account,0);assert.equal(ready.next_action,'practice_handover');
 h.state.students[0].is_offline=2;assert.equal((await h.request()).statusCode,503);
});
test('group/branch/course state, teacher authority, empty roster and capacity produce ordered actionable issues',async()=>{
    const h=fixture();h.state.group.branch_valid=0;h.state.teachers=[];h.state.students=[];h.state.sessions=[];
    const b=(await h.request()).body as any;assert.deepEqual(b.issues,['review_group','assign_instructor','add_students','prepare_sessions']);assert.equal(b.instructor.name,null);
    const c=fixture();c.state.group.max_students=0;assert.ok(((await c.request()).body as any).issues.includes('review_capacity'));
});
test('revoked owner or changed group after collection discards evidence',async()=>{
    for(const kind of ['owner','group']){const h=fixture();if(kind==='owner')h.state.revoke=true;else h.state.changed=true;const r=await h.request();assert.equal(r.statusCode,409);assert.deepEqual(r.body,{code:'GROUP_SETUP_CHANGED'});}
});
test('overflow, duplicate rows, malformed flags, duplicate sessions and SQL failure fail closed and discard connection',async()=>{
    const cases=[(h:ReturnType<typeof fixture>)=>{h.state.students=Array.from({length:501},(_,i)=>({id:String(i),is_offline:0,enrollment_live:1,account_live:1,assigned_live:1}));},
        (h:ReturnType<typeof fixture>)=>h.state.students.push({...h.state.students[0]}),
        (h:ReturnType<typeof fixture>)=>{h.state.students[0].account_live=2;},
        (h:ReturnType<typeof fixture>)=>h.state.sessions.push({...h.state.sessions[0]}),
        (h:ReturnType<typeof fixture>)=>{h.state.sessions=Array.from({length:21},(_,i)=>({id:id(i+3),title:'Session',starts_at:'2026-11-09T10:00:00.000Z'}));},
        (h:ReturnType<typeof fixture>)=>{h.state.fail=true;}];
    for(const setup of cases){const h=fixture();setup(h);const r=await h.request();assert.equal(r.statusCode,503);assert.deepEqual(r.body,{code:'GROUP_SETUP_UNAVAILABLE'});assert.equal(h.state.destroyed,1);assert.equal(h.state.released,0);}
});
test('SQL proves live owner, group-derived course/branch and enrolled/account/assignment stages without global roster reads',async()=>{
    const h=fixture();await h.request();const owner=h.calls.find(c=>c.sql.startsWith('SELECT t.owner'))!.sql;
    for(const x of ['t.owner_user_id=?',"t.status='active'",'u.is_active=1','u.suspended_until'])assert.ok(owner.includes(x));
    const group=h.calls.find(c=>c.sql.startsWith('SELECT g.id'))!.sql;assert.ok(group.includes('c.tenant_id=?'));assert.ok(group.includes('b.tenant_id=c.tenant_id'));
    const roster=h.calls.find(c=>c.sql.startsWith('SELECT s.id'))!.sql;for(const x of ['s.tenant_id=? AND s.group_id=?','LIMIT 501','s.enrollment_end_date>UTC_TIMESTAMP()',"sc.status='active'",'u.suspended_until'])assert.ok(roster.includes(x));
    const sessions=h.calls.find(c=>c.sql.startsWith('SELECT id,title'))!.sql;assert.ok(sessions.includes('tenant_id=? AND group_id=?'));assert.ok(sessions.includes("audience='group'"));assert.ok(sessions.includes('INTERVAL 7 DAY'));assert.ok(sessions.includes('LIMIT 21'));
});
