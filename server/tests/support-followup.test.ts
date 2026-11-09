import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createSupportWriteService} from '../src/services/support-writes';
import {parseFollowupInput} from '../src/services/support-followup';
const now=Date.parse('2026-11-07T12:00:00.000Z')/1000;
const actor={id:'ADMIN',tokenVersion:0,identitySource:'users' as const};
const ticket=(n:number,updated=now-48*3600)=>({id:'ticket-'+String(n).padStart(3,'0'),ticket_number:'T-'+n,subject:'Synthetic issue '+n,category:'technical',status:'open',priority:'normal',created_at_epoch:now-30*86400,updated_at_epoch:updated,assigned_to:'admin' as string|null});
function fixture(){
    const s={granted:true,active:1,version:0,suspended:0,assignment:true,index:true,precision:0 as number|null,clock:now,fail:false,rollbackFail:false,commits:0,rollbacks:0,released:0,destroyed:0,rows:[ticket(1)],raw:null as unknown[]|null,calls:[] as Array<{sql:string;p:unknown[]}>};
    const service=createSupportWriteService({getConnection:async()=>({
        beginTransaction:async()=>{},commit:async()=>{s.commits++;},rollback:async()=>{s.rollbacks++;if(s.rollbackFail)throw Error('cleanup failure');},release:()=>{s.released++;},destroy:()=>{s.destroyed++;},
        execute:async(sql:string,p:unknown[]=[])=>{
            const n=sql.replace(/\s+/g,' ').trim();s.calls.push({sql:n,p});assert.match(n,/^SELECT /);assert.doesNotMatch(n,/SELECT\s+\*/i);
            if(n.includes('information_schema.TABLES')&&n.includes("IN ('users'"))return[['users','support_tickets','support_ticket_replies','audit_events','admin_user_roles','admin_role_permissions'].map(table_name=>({table_name,engine:'InnoDB'})),[]];
            if(n.includes('information_schema.STATISTICS')&&n.includes("TABLE_NAME IN ('users'"))return[['users','support_tickets','support_ticket_replies','audit_events'].map(table_name=>({table_name,column_name:'id',seq_in_index:1})),[]];
            if(n.startsWith('SELECT id,is_active,token_version'))return[[{id:'admin',is_active:s.active,token_version:s.version,suspension_active:s.suspended}],[]];
            if(n.startsWith('SELECT ur.user_id'))return[s.granted?[{user_id:'admin',permission_key:'support.read'}]:[],[]];
            if(n.includes('information_schema.TABLES')&&n.includes("TABLE_NAME='support_assignment_attempts'"))return[s.assignment?[{engine:'InnoDB'}]:[],[]];
            if(n.includes('information_schema.COLUMNS')&&n.includes("'support_assignment_attempts'"))return[s.assignment?[
                ...['assigned_to','assignment_version'].map(column_name=>({table_name:'support_tickets',column_name})),
                ...['id','ticket_id','actor_user_id','assigned_to','expected_version','result_version','changed'].map(column_name=>({table_name:'support_assignment_attempts',column_name})),
            ]:[],[]];
            if(n.includes("TABLE_NAME='support_assignment_attempts'")&&n.includes("INDEX_NAME='PRIMARY'"))return[[{column_name:'id',seq_in_index:1}],[]];
            if(n.includes('information_schema.COLUMNS'))return[['created_at','updated_at'].map(column_name=>({column_name,data_type:'timestamp',datetime_precision:s.precision})),[]];
            if(n.includes("INDEX_NAME='idx_support_followup'"))return[s.index?['assigned_to','status','updated_at','id'].map((column_name,i)=>({column_name,seq_in_index:i+1})):[],[]];
            if(n==='SELECT UNIX_TIMESTAMP() AS now_epoch')return[[{now_epoch:s.clock}],[]];
            if(n.startsWith('SELECT id,ticket_number,category')){
                if(s.fail)throw Error('private queue SQL outage');
                if(s.raw!==null)return[s.raw,[]];
                const mine=n.includes('t.assigned_to=?'),offset=mine?1:0,cutoff=Number(p[offset+1]),cursor=n.includes('t.updated_at>FROM_UNIXTIME(?)');
                const statuses=p.filter(x=>['open','waiting_on_support','waiting_on_user'].includes(String(x)));
                if(mine)assert.equal(p[0],'admin');
                const rows=s.rows.filter(r=>(mine?r.assigned_to==='admin':r.assigned_to===null)&&statuses.includes(r.status)&&r.updated_at_epoch<=cutoff&&(!cursor||r.updated_at_epoch>Number(p[offset+2])||r.updated_at_epoch===Number(p[offset+2])&&r.id>String(p[offset+4])))
                    .sort((a,b)=>a.updated_at_epoch-b.updated_at_epoch||a.id.localeCompare(b.id)).slice(0,26);
                return[rows.map(({assigned_to,...r})=>r),[]];
            }
            throw Error('Unexpected SQL '+n);
        },
    })});
    return{s,service,read:(query:unknown={})=>service.followup(actor,query)};
}
test('oldest-first support follow-up pins canonical actor and never returns requester/assignee/private content',async()=>{
    const h=fixture();h.s.rows=[ticket(1,now-25*3600),ticket(2,now-50*3600),{...ticket(3),assigned_to:'other'}, {...ticket(4),status:'closed'},ticket(5,now-3600)];
    const result=await h.read();assert.equal(result.status,200);assert.deepEqual(result.body.tickets.map((t:any)=>t.id),['ticket-002','ticket-001']);
    assert.deepEqual(Object.keys(result.body.tickets[0]),['id','ticket_number','category','subject','status','priority','created_at','updated_at']);
    assert.deepEqual(result.body.filters,{scope:'mine',status:'needs_support',min_hours:24});assert.equal(result.body.as_of,'2026-11-07T12:00:00.000Z');
    assert.equal(h.s.commits,0);assert.equal(h.s.rollbacks,1);assert.equal(h.s.released,1);
});
test('unassigned/user-waiting filters use a separate exact-status range without arbitrary actor selectors',async()=>{
    const h=fixture();h.s.rows=[{...ticket(1),assigned_to:null,status:'waiting_on_user'},{...ticket(2),assigned_to:null},ticket(3)];
    const result=await h.read({scope:'unassigned',status:'waiting_on_user',min_hours:'0'});assert.deepEqual(result.body.tickets.map((r:any)=>r.id),['ticket-001']);
    const sql=h.s.calls.find(c=>c.sql.startsWith('SELECT id,ticket_number,category'))!;assert.ok(sql.sql.includes('t.assigned_to IS NULL'));assert.equal(sql.p.includes('admin'),false);
});
test('status union ranges each have bounded lookahead and time/id keyset does not need a surviving anchor',async()=>{
    const h=fixture();h.s.rows=Array.from({length:60},(_,i)=>({...ticket(i),status:i%2?'open':'waiting_on_support'}));
    const first=await h.read();assert.equal(first.body.tickets.length,25);assert.ok(first.body.next_cursor);
    h.s.rows=h.s.rows.filter(r=>r.id!==first.body.tickets[24].id); // anchor removed/transferred
    const second=await h.read({after:first.body.next_cursor});assert.equal(second.status,200);assert.equal(second.body.tickets.length,25);assert.equal(second.body.tickets[0].id,'ticket-025');
    assert.equal(second.body.as_of,first.body.as_of);
    const query=h.s.calls.find(c=>c.sql.includes(' UNION ALL '))!.sql;assert.equal((query.match(/LIMIT 26/g)??[]).length,3);assert.ok(query.includes('ORDER BY updated_at_epoch ASC,id ASC'));
});
test('strict filters and filter-bound cursors reject forged shape, changed filters and expired windows',async()=>{
    for(const query of [{scope:'all'},{actor:'other'},{min_hours:'24abc'},{min_hours:24},{status:['open']},{after:'not+base64'}]){const h=fixture();assert.equal((await h.read(query)).status,400);assert.equal(h.s.calls.length,0);}
    const h=fixture();h.s.rows=Array.from({length:26},(_,i)=>ticket(i));const first=await h.read();
    assert.equal((await h.read({scope:'unassigned',after:first.body.next_cursor})).status,400);
    h.s.clock+=1801;assert.equal((await h.read({after:first.body.next_cursor})).status,400);
    assert.equal(parseFollowupInput({after:Buffer.from('{}').toString('base64url')}),null);
});
test('grant loss, inactive/revoked/suspended identity and old staff namespace fail before follow-up data',async()=>{
    for(const kind of ['grant','inactive','version','suspension','staff']){const h=fixture();if(kind==='grant')h.s.granted=false;if(kind==='inactive')h.s.active=0;if(kind==='version')h.s.version=1;if(kind==='suspension')h.s.suspended=1;
        const result=kind==='staff'?await h.service.followup({...actor,identitySource:'staff'},{}):await h.read();assert.ok([401,403,404].includes(result.status));
        assert.equal(h.s.calls.some(c=>c.sql.startsWith('SELECT id,ticket_number,category')),false);}
});
test('missing schema/index and timestamp precision mismatch fail closed without scanning queue rows',async()=>{
    for(const kind of ['assignment','index','precision','nullprecision']){const h=fixture();if(kind==='assignment')h.s.assignment=false;if(kind==='index')h.s.index=false;if(kind==='precision')h.s.precision=6;if(kind==='nullprecision')h.s.precision=null;
        const result=await h.read();assert.equal(result.status,503);assert.equal(result.body.code,'SUPPORT_FOLLOWUP_UNAVAILABLE');assert.equal(h.s.calls.some(c=>c.sql.startsWith('SELECT id,ticket_number,category')),false);}
});
test('query failure rolls back safely; failed cleanup discards connection and neither path commits',async()=>{
    for(const kind of ['query','rollback']){const h=fixture();if(kind==='query')h.s.fail=true;else h.s.rollbackFail=true;const result=await h.read();assert.equal(result.status,503);assert.equal(h.s.commits,0);assert.equal(h.s.destroyed,kind==='rollback'?1:0);assert.equal(h.s.released,kind==='query'?1:0);assert.equal(h.s.rollbacks,1);assert.doesNotMatch(JSON.stringify(result.body),/private queue|Synthetic issue/);}
});
test('corrupt projected states, invalid epochs, duplicate IDs or a truncated lookahead cannot become a private page',async()=>{
    const base=ticket(1);
    for(const raw of [[{...base,status:'closed'}],[{...base,updated_at_epoch:true}],[{...base,created_at_epoch:now}],
        [{...base,updated_at_epoch:now}], [base,base],Array.from({length:27},(_,n)=>ticket(n))]){
        const h=fixture();h.s.raw=raw;const r=await h.read();assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.body),/Synthetic issue/);assert.equal(h.s.commits,0);
    }
});
test('HTTP route is mounted before ticket ID matching and no-store comes before authentication',()=>{
    const source=readFileSync(new URL('../src/routes/support-tickets.ts',import.meta.url),'utf8');assert.ok(source.indexOf("router.get('/follow-up'")<source.indexOf("router.get('/:id"));
    assert.ok(source.indexOf("res.set('Cache-Control', 'no-store')")<source.indexOf('router.use(authenticateToken)'));
    assert.match(source,/writes\.followup\(req.user,req.query\)/);
});
