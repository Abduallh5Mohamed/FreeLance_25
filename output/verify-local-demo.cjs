const fs=require('node:fs'),path=require('node:path');
async function main(){
 const pub=JSON.parse(fs.readFileSync(path.join(__dirname,'local-demo-public.json'),'utf8'));
 const priorPath=path.join(__dirname,'local-demo-verification.json');
 if(fs.existsSync(priorPath)){const prior=JSON.parse(fs.readFileSync(priorPath,'utf8'));if(prior.rateLimitBlockedUntil&&Date.parse(prior.rateLimitBlockedUntil)>Date.now()){console.log(JSON.stringify({status:'RATE_LIMIT_WAIT',retryAt:prior.rateLimitBlockedUntil}));process.exitCode=2;return;}}
 const accounts=JSON.parse(fs.readFileSync(path.join(pub.privateDir,'accounts.json'),'utf8'));
 const results=[];let rateLimitBlockedUntil=null;
 for(const a of accounts){
  const r=await fetch('http://127.0.0.1:8081/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:a.phone,password:a.password}),signal:AbortSignal.timeout(15000)});
  const data=await r.json();const result={role:a.role,login:r.status,matchedRole:data.user?.role===a.role};
  if(r.ok&&data.token){
   const me=await fetch('http://127.0.0.1:8081/api/auth/me',{headers:{Authorization:'Bearer '+data.token},signal:AbortSignal.timeout(15000)});result.session=me.status;
   if(a.role==='student'){
    const spaces=await fetch('http://127.0.0.1:8081/api/student-enrollment/spaces',{headers:{Authorization:'Bearer '+data.token},signal:AbortSignal.timeout(15000)});result.spaces=spaces.status;
    const body=await spaces.json();if(spaces.ok&&body.length){const selected=await fetch('http://127.0.0.1:8081/api/student-enrollment/spaces/'+encodeURIComponent(body[0].student_enrollment_id)+'/select',{method:'POST',headers:{Authorization:'Bearer '+data.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});result.selectSpace=selected.status;}
   }
  }else result.code=typeof data.code==='string'?data.code:'LOGIN_FAILED';
  results.push(result);if(r.status===429){const wait=Math.max(1,Number(r.headers.get('retry-after'))||900);rateLimitBlockedUntil=new Date(Date.now()+wait*1000).toISOString();break;}
 }
 fs.writeFileSync(path.join(__dirname,'local-demo-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),results,rateLimitBlockedUntil},null,2));
 console.log(JSON.stringify(results,null,2));if(results.some(r=>r.login!==200||r.session!==200||r.role==='student'&&(r.spaces!==200||r.selectSpace!==200)))process.exitCode=1;
}
main().catch(e=>{console.log(JSON.stringify({error:e.code||'DEMO_VERIFICATION_FAILED'}));process.exitCode=1;});
