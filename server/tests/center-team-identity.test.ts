import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import {createAuthenticateToken,createOptionalAuth,type AuthRequest} from '../src/middleware/auth';
import type {PrincipalRepository} from '../src/security/principal-repository';
import {centerPermissions,centerUuid,proveCenterMember,proveCenterBranch,proveCenterOwner,centerAttendanceReady} from '../src/services/center-team';
process.env.JWT_SECRET='center-team-isolated-test-signing-material-only';

for (const fault of ['none','engine','index','extra-part']) test('delegated attendance schema fails closed for '+fault,async()=>{
  const db={query:async(sql:string)=>sql.includes('information_schema.TABLES')?['attendance_records','schedule_sessions','students'].map((name,i)=>({name,engine:fault==='engine'&&i===0?'MyISAM':'InnoDB'})):fault==='index'?[]:[{name:'session_student',column_name:'session_id',seq:1},{name:'session_student',column_name:'student_id',seq:2},...fault==='extra-part'?[{name:'session_student',column_name:'other',seq:3}]:[]],execute:async()=>({affectedRows:1})};
  if(fault==='none')await centerAttendanceReady(db);else await assert.rejects(()=>centerAttendanceReady(db));
});
test('canonical IDs and finite permissions reject malformed selectors and all financial/platform grants',()=>{
  assert.equal(centerUuid('b5800000-0000-4000-8000-000000000001'),true);
  assert.equal(centerUuid('b5800000-0000-4000-000000000001'),false);
  assert.deepEqual(centerPermissions('["tasks.manage","groups.read"]'),['groups.read','tasks.manage']);
  for(const p of [[],['fees.manage'],['staff.manage'],['groups.read','groups.read'],['tasks.manage','security.manage']])assert.throws(()=>centerPermissions(p));
});
async function authenticate(path:string,center:number|boolean=1,tv=0,optional=false){
  const repo:PrincipalRepository={findUsersIdentity:async()=>({is_active:1,role:'staff',token_version:tv,suspension_active:0,center_account:center}),findStaffIdentity:async()=>null,findInstructorAccount:async()=>null,findStudentEnrollments:async()=>[],findActiveTenantMemberships:async()=>[]};
  const req={headers:{authorization:'Bearer '+jwt.sign({id:'center-worker',role:'staff',tv:0,tenant_id:'forged',accessible_pages:['fees','staff','groups']},process.env.JWT_SECRET!)},originalUrl:path,url:path,method:'GET'} as unknown as AuthRequest;
  let status=0,body:any,next=false;const headers:Record<string,string>={};const res:any={set:(k:string,v:string)=>{headers[k.toLowerCase()]=v;return res;},status:(v:number)=>{status=v;return res;},json:(v:any)=>{body=v;return res;}};
  await (optional?createOptionalAuth(repo):createAuthenticateToken(repo))(req,res,()=>{next=true;});return{status,body,next,req,headers};
}
for(const path of ['/api/fees','/api/staff','/api/groups','/api/students','/api/users','/api/tenants/me/catalog/courses','/api/branches','/api/admin/roles'])test('durable center-only boundary denies '+path+' despite forged selectors/page claims',async()=>{const r=await authenticate(path);assert.equal(r.status,403);assert.equal(r.body.code,'CENTER_ACCOUNT_ONLY');assert.equal(r.next,false);assert.equal(r.headers['cache-control'],'no-store');});
test('optional authentication also marks center-only denial private before the public/academic route',async()=>{const r=await authenticate('/api/tenants/me/catalog/grading-work/assignments',1,0,true);assert.equal(r.status,403);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.next,false);});
for(const path of ['/api/auth/me','/api/support-tickets','/api/tenants/me/catalog/team/workspaces'])test('center-only account reaches narrow self-service mount '+path+' with no global tenant authority',async()=>{const r=await authenticate(path);assert.equal(r.next,true);assert.equal(r.req.user?.tenantId,undefined);assert.equal(r.req.user?.identitySource,'users');});
test('account liveness and corrupted account boundary fail closed before dedicated workflow access',async()=>{assert.equal((await authenticate('/api/tenants/me/catalog/team/workspaces',1,1)).status,401);assert.equal((await authenticate('/api/auth/me',2)).status,401);});
test('member and owner proofs use live token version, actor identity, permission and same-tenant active branch',async()=>{
  const calls:Array<{sql:string;p:unknown[]}> = [];let live=true,role=['groups.read','tasks.manage'];
  const db={query:async(sql:string,p:unknown[]=[])=>{calls.push({sql,p});if(sql.includes('FROM center_team_members'))return live?[{id:'b5800000-0000-4000-8000-000000000001',tenant_id:'tenant',user_id:'worker',permissions:role,status:'active',version:0}]:[];if(sql.includes('FROM branches'))return live?[{id:p[1]}]:[];return live?[{id:'tenant'}]:[];},execute:async()=>({affectedRows:1})};
  const actor:any={id:'worker',role:'staff',tokenVersion:4,identitySource:'users'};const id='b5800000-0000-4000-8000-000000000001';
  await proveCenterMember(db,actor,id,'tasks.manage',true);assert.deepEqual(calls[0].p,[id,'worker',4]);assert.match(calls[0].sql,/u.center_account=1/);assert.match(calls[0].sql,/FOR UPDATE/);
  await assert.rejects(()=>proveCenterMember(db,actor,id,'attendance.mark'));live=false;await assert.rejects(()=>proveCenterMember(db,actor,id));await assert.rejects(()=>proveCenterBranch(db,'tenant',id,'foreign',true));
  live=true;await proveCenterOwner(db,{id:'owner',tenantId:'tenant',tokenVersion:8}as any,true);assert.deepEqual(calls.at(-1)?.p,['tenant','owner',8]);
});
