const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');
const id=n=>`e1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ticket={id:id(1),ticket_number:'SUP-FIXTURE',user_id:'synthetic-requester',category:'technical',subject:'طلب دعم مصطنع للمراجعة',description:'وصف عام مصطنع لصاحب التذكرة',status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z'};
const privateBody='ملاحظة داخلية مصطنعة لا تُرسل لصاحب التذكرة';
(async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import Support from './src/pages/Support';
  const requester=new URLSearchParams(location.search).get('fixtureRole')==='requester';localStorage.setItem('authToken',requester?'synthetic-requester-token':'synthetic-admin-token');localStorage.setItem('currentUser',JSON.stringify({id:requester?'synthetic-requester':'synthetic-agent',role:requester?'student':'admin'}));
  createRoot(document.getElementById('root')).render(<BrowserRouter><Support/></BrowserRouter>);`,resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,alias:{'@':path.resolve('src')},logLevel:'silent',
  plugins:[{name:'fixture-navigation',setup(builder){builder.onLoad({filter:/[\\/]components[\\/](Header|StudentHeader)\.tsx$/},()=>({contents:'export default function Header(){return null}',loader:'tsx'}));}}]});
 const css=fs.readdirSync('dist/assets').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join('dist/assets',n),'utf8')).join('\n');
 const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>اختبار ملاحظات الدعم الداخلية</title><style>${css}</style><body style="font-family:Tahoma,sans-serif"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
 fs.writeFileSync('tmp/support-private-notes-browser.html',html);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:850}}),calls=[],errors=[],notes=[];let posts=0,key=null,allowed=true,failRead=false;
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!=='https://fixture.invalid')return route.abort();
   if(url.pathname==='/support')return route.fulfill({status:200,contentType:'text/html',body:html});
   const admin=req.headers().authorization==='Bearer synthetic-admin-token';calls.push({path:url.pathname,method:req.method(),admin});
   const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(url.pathname.includes('/private-notes')){
    if(!admin||!allowed)return send({error:'Private support notes not found',code:'SUPPORT_NOTES_NOT_FOUND'},404);
    if(req.method()==='POST'){
     posts++;key=req.headers()['idempotency-key'];if(!key)throw Error('private note request key absent');const input=req.postDataJSON();if(Object.keys(input).join(',')!=='body')throw Error('private body widened');
     const note={id:id(10+posts),ticket_id:ticket.id,author_id:'synthetic-agent',author_name:'مسؤول دعم تجريبي',body:input.body,created_at:'2026-11-05T10:00:00.000Z'};notes.push(note);
     if(posts===1)return send({error:'Synthetic lost acknowledgement',code:'PERSISTENCE_UNCERTAIN'},503);
     failRead=true;return send({note,unchanged:false},201);
    }
    if(url.pathname.includes('/attempts/')){if(url.pathname.split('/').at(-1)!==key)throw Error('private key changed');return send({note:notes[0],unchanged:true});}
    if(failRead){failRead=false;return send({error:'Synthetic list outage'},503);}
    return send({notes,next_cursor:null});
   }
   if(req.method()!=='GET')throw Error('private operation leaked into public mutation');
   if(url.pathname==='/api/support-tickets'||url.pathname.endsWith('/mine'))return send([ticket]);
   if(url.pathname.endsWith('/context'))return send({state:'none',context:null});
   return send({ticket,replies:[{id:id(2),sender_id:'synthetic-requester',sender_name:'طالب تجريبي',sender_role:'student',body:'رسالة علنية تجريبية',created_at:'2026-11-05T10:00:00.000Z'}],next_cursor:null,has_more_replies:false});
  });
  const select=async()=>{await page.getByRole('button',{name:/طلب دعم مصطنع للمراجعة/}).click();await page.getByText('رسالة علنية تجريبية',{exact:true}).waitFor();};
  await page.goto('https://fixture.invalid/support');await select();
  if(calls.some(row=>row.path.includes('/private-notes')))throw Error('collapsed panel fetched private data');
  await page.getByRole('button',{name:'ملاحظات فريق الدعم',exact:true}).click();const panel=page.getByRole('region',{name:'ملاحظات داخلية لفريق الدعم'});
  await panel.getByLabel('نص الملاحظة الداخلية',{exact:true}).fill(privateBody);await panel.getByRole('button',{name:'حفظ ملاحظة داخلية',exact:true}).click();await panel.getByRole('button',{name:'التحقق من نتيجة الملاحظة',exact:true}).waitFor();
  if(!await panel.getByLabel('نص الملاحظة الداخلية',{exact:true}).isDisabled())throw Error('unknown private payload editable');
  const opaque=await page.evaluate(()=>Object.entries(sessionStorage));if(opaque.length!==1||!opaque.every(([,value])=>/^[a-f\d-]{36}$/i.test(value)))throw Error('private note body persisted in browser storage');
  await page.reload();await select();await page.getByRole('button',{name:'ملاحظات فريق الدعم',exact:true}).click();await panel.getByRole('button',{name:'التحقق من نتيجة الملاحظة',exact:true}).click();
  await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.includes('.note.')));await panel.getByText('تم تأكيد حفظ الملاحظة داخل فريق الدعم.',{exact:true}).waitFor();
  await panel.getByText(privateBody,{exact:true}).waitFor();
  if(await panel.getByText(privateBody,{exact:true}).count()!==1||posts!==1)throw Error('note recovery duplicated a write or row');
  await panel.getByLabel('نص الملاحظة الداخلية',{exact:true}).fill('ملاحظة ثانية لاختبار فشل تحديث القائمة بعد الحفظ');await panel.getByRole('button',{name:'حفظ ملاحظة داخلية',exact:true}).click();
  await panel.getByText('حفظ الملاحظة مؤكد، لكن تعذّر تحديث قائمة الملاحظات. حدّث القائمة ولا تعِد إرسالها.',{exact:true}).waitFor();
  if(await panel.getByText(privateBody,{exact:true}).count()||await panel.getByRole('button',{name:'التحقق من نتيجة الملاحظة',exact:true}).count())throw Error('stale list or uncertain write after confirmed save');
  for(const width of [390,1024]){await page.setViewportSize({width,height:850});await page.screenshot({path:`tmp/support-private-notes-${width}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('private panel overflow');}
  await panel.getByRole('button',{name:'تحديث الملاحظات الداخلية',exact:true}).click();await panel.getByText(privateBody,{exact:true}).waitFor();
  allowed=false;await panel.getByRole('button',{name:'تحديث الملاحظات الداخلية',exact:true}).click();await panel.getByText('لا تتوفر صلاحية ملاحظات فريق الدعم للحساب الحالي.',{exact:true}).waitFor();if(await panel.getByText(privateBody,{exact:true}).count())throw Error('revoked private data retained');
  await page.goto('https://fixture.invalid/support?fixtureRole=requester');await select();if(await page.getByRole('button',{name:'ملاحظات فريق الدعم',exact:true}).count()||await page.getByText(privateBody,{exact:true}).count())throw Error('requester saw private note UI');
  if(calls.some(row=>!row.admin&&row.path.includes('/private-notes'))||errors.length||posts!==2)throw Error('requester private fetch, page error or duplicate note');
  console.log(JSON.stringify({privatePosts:2,publicMutations:0,collapsedPrivateRequests:0,reloadRecoveryByGet:true,opaqueKeysOnly:true,confirmedSaveRefreshFailureSeparated:true,revocationClears:true,requesterPrivateRequests:0,viewports:[390,1024],overflow:false,pageErrors:0,requests:calls.length}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
