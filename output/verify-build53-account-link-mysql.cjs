// Real MySQL route execution, entirely inside an outer ROLLBACK.
// Route commit() releases a SAVEPOINT ONLY. No fixture identity/proof/link is
// committed. In-memory OTP delivery is a TEST adapter, never a runtime provider.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const {connect}=require('./demo-db.cjs');
async function main(){
 const {c,root,database,version}=await connect();let secondary=null;const checks=[],errors=[];
 const ids={user:crypto.randomUUID(),student:crypto.randomUUID(),invite:crypto.randomUUID(),request:crypto.randomUUID(),operation:crypto.randomUUID()};
 let begun=false,step='imports',serial=0,fault=null,commits=0,destroys=0;const completed=[];
 try{
  const {Router}=require(path.join(root,'server/node_modules/express'));
  const {createStudentAccountLinkOwnerRouter,createStudentAccountLinkRequestRouter}=await import(pathToFileURL(path.join(root,'server/src/routes/student-account-link.ts')).href);
  const {IdentityOtpService}=await import(pathToFileURL(path.join(root,'server/src/security/identity-otp.ts')).href);
  const {invokeRoute}=await import(pathToFileURL(path.join(root,'server/tests/helpers/m2-harness.ts')).href);
  const {verifyAuditChain}=await import(pathToFileURL(path.join(root,'server/src/services/audit-log.ts')).href);
  const parent=JSON.parse(fs.readFileSync(path.join(__dirname,'build50-group-fixtures.json'),'utf8'));assert.equal(parent.database,database);
  const [[tenant]]=await c.execute('SELECT t.id,t.owner_user_id,u.token_version FROM tenants t JOIN courses course ON course.tenant_id=t.id JOIN users u ON u.id=t.owner_user_id WHERE course.id=? AND t.status=\'active\'',[parent.course]);assert.ok(tenant);
  const [[mode]]=await c.execute('SELECT @@SESSION.sql_mode AS mode');assert.match(mode.mode,/STRICT/);
  const totals=async(conn)=>{const [[x]]=await conn.execute('SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM students) AS students,(SELECT COUNT(*) FROM student_account_link_requests) AS requests,(SELECT COUNT(*) FROM student_account_link_operations) AS operations,(SELECT COUNT(*) FROM identity_otp_challenges) AS proofs,(SELECT COUNT(*) FROM audit_events) AS audits');return x;};
  const before=await totals(c);await c.beginTransaction();begun=true;
  const key=crypto.randomBytes(32).toString('hex'),invite=crypto.randomBytes(32).toString('hex'),phone='+2010'+String(crypto.randomInt(10000000,99999999));
  const bcrypt=require(path.join(root,'server/node_modules/bcryptjs'));const passwordHash=await bcrypt.hash(crypto.randomBytes(32).toString('hex'),10);
  await c.execute("INSERT INTO users (id,phone,password_hash,name,role,is_active,phone_verified) VALUES (?,?,?,'ROLLBACK SQL account','student',1,0)",[ids.user,phone,passwordHash]);
  await c.execute("INSERT INTO students (id,tenant_id,instructor_id,name,phone,barcode,notes,is_offline,is_active,approval_status) VALUES (?,?,?,'ROLLBACK original student',?,?,'preserve this history',0,1,'approved')",[ids.student,tenant.id,tenant.owner_user_id,phone,'B53'+crypto.randomBytes(10).toString('hex')]);
  await c.execute('INSERT INTO student_enrollment_invites (id,tenant_id,instructor_id,token_hash,expires_at) VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[ids.invite,tenant.id,tenant.owner_user_id,crypto.createHash('sha256').update(invite).digest('hex')]);
  const query=async(sql,p=[])=>{const [rows]=await c.execute(sql,p);return rows;};
  let delivered=null,deliveries=0;
  const otp=new IdentityOtpService({
   insertChallenge:async r=>{await c.execute('INSERT INTO identity_otp_challenges (id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[r.id,r.contact_hash,r.purpose,r.tenant_id,r.identity_id,r.code_hash,r.attempts,r.max_attempts,r.resend_available_at,r.expires_at,r.consumed_at,r.submitted_at??null]);},
   findChallengeById:async id=>(await query('SELECT id,contact_hash,purpose,tenant_id,identity_id,code_hash,attempts,max_attempts,resend_available_at,expires_at,consumed_at,submitted_at FROM identity_otp_challenges WHERE id=?',[id]))[0]??null,
   findLatestActiveChallenge:async()=>null,countRecentChallenges:async()=>0,
   incrementAttempts:async id=>{await c.execute('UPDATE identity_otp_challenges SET attempts=attempts+1 WHERE id=?',[id]);},
   consumeChallenge:async(id,now)=>{const [r]=await c.execute('UPDATE identity_otp_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL',[now,id]);return r.affectedRows;},
  },key,{send:async(_contact,code)=>{delivered=code;deliveries++;}});
  step='test-only OTP in outer transaction';const issued=await otp.issue({contact:phone,purpose:'enrollment_join',tenantId:tenant.id});assert.ok(delivered);assert.equal((await otp.verify({challengeId:issued.challengeId,code:delivered,contact:phone,purpose:'enrollment_join',tenantId:tenant.id})).kind,'consumed');delivered=null;
  const actor={id:ids.user,role:'student',identitySource:'users',tokenVersion:0};
  const getConnection=async()=>{const savepoint='b53_'+(++serial);let finish;completed.push(new Promise(resolve=>{finish=resolve;}));return{
   beginTransaction:()=>c.query('SAVEPOINT '+savepoint),
   execute:async(sql,p=[])=>{try{
    if(fault==='audit'&&sql.startsWith('INSERT INTO audit_events'))throw Object.assign(Error('Injected audit outage'),{code:'TEST_AUDIT_OUTAGE'});
    const parameters=fault==='receipt'&&sql.startsWith('INSERT INTO student_account_link_operations')?[...p.slice(0,-1),'f'.repeat(65)]:p;
    const result=await c.execute(sql,parameters);
    if(sql.startsWith('SELECT i.id,i.tenant_id')&&result[0].length===0){const [[visible]]=await c.execute('SELECT COUNT(*) AS n FROM student_enrollment_invites WHERE id=?',[ids.invite]);errors.push({step,code:'INVITE_LOOKUP_DIAGNOSTIC',hash_matches:p[0]===crypto.createHash('sha256').update(invite).digest('hex'),fixture_rows:visible.n});}
    return result;
   }catch(e){errors.push({step,code:e.code??'SQL_FAILURE',statement:sql.slice(0,45)});throw e;}},
   commit:async()=>{try{await c.query('RELEASE SAVEPOINT '+savepoint);commits++;}catch(e){errors.push({step,code:e.code??'SAVEPOINT_FAILURE',statement:'RELEASE SAVEPOINT'});throw e;}},
   rollback:async()=>{await c.query('ROLLBACK TO SAVEPOINT '+savepoint);await c.query('RELEASE SAVEPOINT '+savepoint);},
   release:()=>finish(),destroy:()=>{destroys++;finish();},
  };};
  const router=Router();router.use((req,res,next)=>{req.user={...actor};req.ip='build53-rollback-only';res.setHeader=(k,v)=>res.set(k,v);next();});
  router.use(createStudentAccountLinkRequestRouter({getConnection,enabled:()=>true,otpKey:()=>key,authenticate:(_r,_s,next)=>next()}));
  router.use(createStudentAccountLinkOwnerRouter({getConnection,enabled:()=>true,otpKey:()=>key}));
  async function api(url,body){const parsed=new URL(url,'http://hermetic'),first=completed.length;const r=await invokeRoute(router,{method:body?'POST':'GET',url,body,query:Object.fromEntries(parsed.searchParams)});await Promise.all(completed.slice(first));return r;}
  const join='/join/'+invite+'/account-link',base='/account-link';const submission={operation_id:ids.request,otp_challenge_id:issued.challengeId,confirmed:true};
  step='native proof submission';let r=await api(join,submission);assert.equal(r.statusCode,201,JSON.stringify({response:r.body,errors}));
  const [[proof]]=await c.execute('SELECT consumed_at,submitted_at FROM identity_otp_challenges WHERE id=?',[issued.challengeId]);assert.ok(proof.consumed_at&&proof.submitted_at);assert.equal(deliveries,1);
  const [[expiry]]=await c.execute('SELECT TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),r.expires_at) AS seconds_left,(r.expires_at=i.expires_at) AS matches_invite FROM student_account_link_requests r JOIN student_enrollment_invites i ON i.id=r.invite_id WHERE r.id=?',[ids.request]);assert.ok(expiry.seconds_left>0&&expiry.seconds_left<=3600);assert.equal(expiry.matches_invite,1);
  assert.equal((await api(join,submission)).statusCode,200);assert.equal((await api(join+'/'+ids.request)).body.request.state,'pending');checks.push({check:'real SQL request/proof/sealed-audit path with in-memory test OTP delivery, same request replay and private receipt inside outer transaction',pass:true});
  step='native UTC expiry';await c.execute('UPDATE student_account_link_requests SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE id=?',[ids.request]);assert.equal((await api(join)).body.request.state,'expired');await c.execute('UPDATE student_account_link_requests r JOIN student_enrollment_invites i ON i.id=r.invite_id SET r.expires_at=LEAST(i.expires_at,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 DAY)) WHERE r.id=?',[ids.request]);assert.equal((await api(join)).body.request.state,'pending');checks.push({check:'database UTC controls one-hour invitation/deadline and expired/current projection without driver Date conversion; exact fixture expiry restored',pass:true});
  actor.id=tenant.owner_user_id;actor.role='instructor';actor.tenantId=tenant.id;actor.tokenVersion=tenant.token_version;
  step='native owner keyset reads';r=await api(base+'/requests');assert.equal(r.statusCode,200,JSON.stringify({response:r.body,errors}));assert.ok(r.body.items.some(x=>x.id===ids.request));assert.ok(r.body.items.every(x=>Object.keys(x).sort().join(',')==='id,name'));let found=false,cursor=null;for(let page=0;page<10;page++){r=await api(base+'/students'+(cursor?'?cursor='+cursor:''));assert.equal(r.statusCode,200);found ||= r.body.items.some(x=>x.id===ids.student);cursor=r.body.next_cursor;if(found||!cursor)break;}assert.equal(found,true);checks.push({check:'actual bounded owner request and eligible-student pages execute with canonical fixed projections and cursor support',pass:true});
  const selected={student_id:ids.student,request_id:ids.request};
  async function review(){const r=await api(base+'/review',selected);assert.equal(r.statusCode,200,JSON.stringify({response:r.body,errors}));return{...selected,operation_id:ids.operation,review_token:r.body.review_token,confirmed:true};}
  const [[original]]=await c.execute('SELECT id,name,phone,barcode,notes,grade_id,group_id,branch_id,user_id,is_offline FROM students WHERE id=?',[ids.student]);
  step='stale review';let approved=await review();await c.execute('UPDATE students SET notes=? WHERE id=?',['different history',ids.student]);
  // notes is preserved data, not part of the published identity review. A name
  // change is review evidence and must invalidate the reviewed selection.
  await c.execute('UPDATE students SET name=? WHERE id=?',['changed identity display',ids.student]);assert.equal((await api(base+'/apply',approved)).statusCode,409);await c.execute('UPDATE students SET name=?,notes=? WHERE id=?',[original.name,original.notes,ids.student]);checks.push({check:'real current-row revalidation rejects changed reviewed identity before writes and restores the isolated fixture',pass:true});
  approved=await review();const [[headBefore]]=await c.execute('SELECT head_seq,head_entry_hash,head_row_id FROM audit_chain_head LIMIT 1');
  for(const mode of ['audit','receipt']){step='real rollback '+mode;fault=mode;r=await api(base+'/apply',approved);fault=null;assert.equal(r.statusCode,503,JSON.stringify({response:r.body,errors}));const [[s]]=await c.execute('SELECT user_id FROM students WHERE id=?',[ids.student]);assert.equal(s.user_id,null);const [[request]]=await c.execute('SELECT status FROM student_account_link_requests WHERE id=?',[ids.request]);assert.equal(request.status,'pending');const [[count]]=await c.execute('SELECT COUNT(*) AS n FROM student_account_link_operations WHERE operation_id=?',[ids.operation]);assert.equal(count.n,0);const [[head]]=await c.execute('SELECT head_seq,head_entry_hash,head_row_id FROM audit_chain_head LIMIT 1');assert.deepEqual(head,headBefore);}
  assert.ok(errors.some(x=>x.code==='ER_DATA_TOO_LONG'));checks.push({check:'audit outage injection and actual MySQL strict-length receipt error roll back student/request/audit/chain reservation to the route savepoint',pass:true});
  step='staged same-row approval';approved=await review();r=await api(base+'/apply',approved);assert.equal(r.statusCode,201,JSON.stringify({response:r.body,errors}));const [[updated]]=await c.execute('SELECT id,name,phone,barcode,notes,grade_id,group_id,branch_id,user_id,is_offline FROM students WHERE id=?',[ids.student]);assert.deepEqual({...updated,user_id:null,is_offline:original.is_offline},original);assert.equal(updated.user_id,ids.user);assert.equal(updated.is_offline,0);
  const [[grants]]=await c.execute('SELECT COUNT(*) AS n FROM student_courses WHERE student_id=?',[ids.student]);assert.equal(grants.n,0);assert.equal((await api(base+'/apply',Object.fromEntries(Object.entries(approved).reverse()))).statusCode,200);assert.equal((await api(base+'/operations/'+ids.operation)).body.operation.student_id,ids.student);
  const chain=await verifyAuditChain({query},{limit:1000});assert.equal(chain.ok,true);assert.equal(chain.truncated,false);assert.equal(chain.headAnchor.ok,true);checks.push({check:'real SQL same-ID identity-only link, unchanged history, zero course grants, canonical replay, historical receipt and verified staged sealed chain; SAVEPOINT release is not a durable COMMIT',pass:true});
  step='two-connection lock probe';secondary=(await connect()).c;await secondary.query('SET SESSION innodb_lock_wait_timeout=1');const competing=Router();competing.use((req,_res,next)=>{req.user={...actor};next();});competing.use(createStudentAccountLinkOwnerRouter({getConnection:async()=>({beginTransaction:()=>secondary.beginTransaction(),execute:(q,p)=>secondary.execute(q,p),commit:()=>secondary.commit(),rollback:()=>secondary.rollback(),release:()=>{},destroy:()=>secondary.destroy()}),enabled:()=>true,otpKey:()=>key}));
  r=await invokeRoute(competing,{method:'GET',url:base+'/requests'});assert.equal(r.statusCode,503);checks.push({check:'second real connection times out on the live owner lock and fails closed while the outer transaction is open; not a two-COMMIT race or throughput measurement',pass:true});
  step='outer rollback';await c.rollback();begun=false;const after=await totals(c);assert.deepEqual(after,before);const chainAfter=await verifyAuditChain({query},{limit:1000});assert.equal(chainAfter.ok,true);
  for(const [table,column,value] of [['users','id',ids.user],['students','id',ids.student],['student_enrollment_invites','id',ids.invite],['student_account_link_requests','id',ids.request],['student_account_link_operations','operation_id',ids.operation],['identity_otp_challenges','id',issued.challengeId]]){const [[row]]=await c.execute('SELECT COUNT(*) AS n FROM `'+table+'` WHERE `'+column+'`=?',[value]);assert.equal(row.n,0);}
  checks.push({check:'outer ROLLBACK removes all fixture identities, invite, test proof, consent, link, receipt and audit; exact global counts and original sealed chain restored',pass:true});
  const result={database,version,checks,route_savepoint_releases:commits,route_discard_signals:destroys,test_otp_deliveries:deliveries,persisted_fixture_rows:0,expected_errors:errors.filter(x=>['TEST_AUDIT_OUTAGE','ER_DATA_TOO_LONG'].includes(x.code)).map(({code})=>code),limits:'Original Router factories over actual MySQL, with injected test principals, ephemeral test HMAC and in-memory delivery, all inside a rollback-only transaction. commit() RELEASES SAVEPOINT, never commits. No mounted runtime OTP/key/provider/identity activation, durable recovery acceptance or two-commit concurrency claim.'};fs.writeFileSync(path.join(__dirname,'build53-mysql-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:checks.length,persisted_fixture_rows:0}));
 }catch(e){console.error(JSON.stringify({step,error:e.code??'INTEGRATION_FAILED',message:e.code==='ERR_ASSERTION'?e.message:undefined,sql_errors:errors,at:String(e.stack).split('\n').filter(x=>x.includes('build53-account-link')).slice(0,2)}));process.exitCode=1;}
 finally{if(begun)await c.rollback().catch(()=>{});if(secondary)await secondary.end().catch(()=>{});await c.end();}
}
main().catch(e=>{console.error(JSON.stringify({error:e.code??'BUILD53_FAILED'}));process.exitCode=1;});
