// Local demo only. Credentials stay in private storage and are never logged.
const fs=require('node:fs'),path=require('node:path');
async function main(){
 const pub=JSON.parse(fs.readFileSync(path.join(__dirname,'local-demo-public.json'),'utf8'));
 const accounts=JSON.parse(fs.readFileSync(path.join(pub.privateDir,'accounts.json'),'utf8'));
 const owner=accounts.find(a=>a.role==='teacher');if(!owner)throw Error();
 const base='http://127.0.0.1:8081/api';
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:owner.phone,password:owner.password}),signal:AbortSignal.timeout(15000)});
 const data=await login.json();if(!login.ok||!data.token)throw Error();
 const response=await fetch(base+'/tenants/me/catalog/grading/exams',{headers:{Authorization:'Bearer '+data.token},signal:AbortSignal.timeout(15000)});
 const body=await response.json();
 const result={login:login.status,grading:response.status,noStore:response.headers.get('cache-control')==='no-store',schemaUnavailable:body.code==='QUESTION_GRADING_UNAVAILABLE'};
 fs.writeFileSync(path.join(__dirname,'build42-demo-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 if(result.grading!==503||!result.schemaUnavailable||!result.noStore)process.exitCode=1;
}
main().catch(()=>{console.log('Local demo verification failed');process.exitCode=1;});
