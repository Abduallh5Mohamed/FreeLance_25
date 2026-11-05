const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');
const id=n=>`e1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ticket={id:id(1),ticket_number:'SUP-FIXTURE',user_id:'synthetic-requester',category:'technical',subject:'طلب دعم مصطنع للمراجعة',description:'وصف عام مصطنع لصاحب التذكرة',status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z'};
const testAssigned=process.argv.includes('--assigned-queue');
(async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import Support from './src/pages/Support';
 const requester=new URLSearchParams(location.search).get('fixtureRole')==='requester';localStorage.setItem('authToken',requester?'synthetic-requester-token':'synthetic-admin-token');localStorage.setItem('currentUser',JSON.stringify({id:requester?'synthetic-requester':'synthetic-agent',role:requester?'student':'admin'}));
 createRoot(document.getElementById('root')).render(<BrowserRouter><Support/></BrowserRouter>);`,resolveDir:process.cwd(),loader:'tsx'},
 bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,alias:{'@':path.resolve('src')},logLevel:'silent',
 plugins:[{name:'fixture-navigation',setup(builder){builder.onLoad({filter:/[\\/]components[\\/](Header|StudentHeader)\.tsx$/},()=>({contents:'export default function Header(){return null}',loader:'tsx'}));}}]});
 const css=fs.readdirSync('dist/assets').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join('dist/assets',n),'utf8')).join('\n');
 const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>اختبار تكليف تذاكر الدعم</title><style>${css}</style><body style="font-family:Tahoma,sans-serif"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
 fs.writeFileSync('tmp/support-assignment-browser.html',html);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:850}}),calls=[],errors=[],receipts=new Map();let posts=0,allowed=true,failRead=false,failAssigned=false;
  let assignment={ticket_id:ticket.id,assigned_to:null,version:0};
  const people=[{id:'synthetic-agent',name:'مسؤول الدعم الأول'},{id:'synthetic-other',name:'مسؤول الدعم الثاني'}];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!=='https://fixture.invalid')return route.abort();
   if(url.pathname==='/support')return route.fulfill({status:200,contentType:'text/html',body:html});
   const admin=req.headers().authorization==='Bearer synthetic-admin-token';calls.push({path:url.pathname,method:req.method(),admin});
   const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(url.pathname==='/api/support-tickets/assigned'){
    if(!admin||!allowed)return send({code:'SUPPORT_ASSIGNED_NOT_FOUND'},404);
    if(failAssigned){failAssigned=false;return send({error:'Synthetic assigned read outage'},503);}
    const project=row=>({id:row.id,ticket_number:row.ticket_number,category:row.category,subject:row.subject,status:row.status,priority:row.priority,created_at:'2026-11-05T10:00:00.000Z',updated_at:'2026-11-05T10:00:00.000Z'});
    const rows=Array.from({length:26},(_,n)=>project({...ticket,id:`q${String(n).padStart(3,'0')}`,subject:`متابعة تجريبية ${n}`}));
    if(assignment.assigned_to==='synthetic-agent')rows.unshift(project(ticket));
    const after=url.searchParams.get('after'),remaining=rows.filter(row=>!after||row.id>after),items=remaining.slice(0,25);
    return send({tickets:items,next_cursor:remaining.length>25?items[24].id:null});
   }
   if(url.pathname.includes('/assignment')){
    if(!admin||!allowed)return send({error:'Not found',code:'SUPPORT_ASSIGNMENT_NOT_FOUND'},404);
    if(req.method()==='POST'){
     posts++;const key=req.headers()['idempotency-key'],input=req.postDataJSON();if(!key||Object.keys(input).sort().join(',')!=='assigned_to,expected_version')throw Error('assignment payload/key invalid');
     if(receipts.has(key))throw Error('unexpected duplicate POST');
     if(posts===3){assignment={ticket_id:ticket.id,assigned_to:'synthetic-other',version:4};return send({error:'Stale',code:'SUPPORT_ASSIGNMENT_STALE'},409);}
     if(input.expected_version!==assignment.version)throw Error('UI sent obsolete version');
     assignment={ticket_id:ticket.id,assigned_to:input.assigned_to,version:assignment.version+1};
     const receipt={assignment:{...assignment},changed:true,unchanged:false};receipts.set(key,receipt);
     if(posts===1)return send({error:'Synthetic lost acknowledgement',code:'PERSISTENCE_UNCERTAIN'},503);
     if(posts===2)failRead=true;
     return send(receipt,201);
    }
    if(url.pathname.includes('/attempts/')){const receipt=receipts.get(url.pathname.split('/').at(-1));return receipt?send({...receipt,unchanged:true}):send({code:'SUPPORT_ATTEMPT_NOT_FOUND'},404);}
    if(url.pathname.endsWith('/candidates'))return send({candidates:people,next_cursor:null});
    if(failRead){failRead=false;return send({error:'Synthetic current-state outage'},503);}
    return send({assignment,assignee:people.find(row=>row.id===assignment.assigned_to)??null});
   }
   if(req.method()!=='GET')throw Error('assignment leaked into public mutation');
   if(url.pathname==='/api/support-tickets'||url.pathname.endsWith('/mine'))return send([ticket]);
   if(url.pathname.endsWith('/context'))return send({state:'none',context:null});
   return send({ticket,replies:[{id:id(2),sender_id:'synthetic-requester',sender_name:'طالب تجريبي',sender_role:'student',body:'رسالة علنية تجريبية',created_at:'2026-11-05T10:00:00.000Z'}],next_cursor:null,has_more_replies:false});
  });
  const select=async()=>{await page.getByRole('button',{name:/طلب دعم مصطنع للمراجعة/}).click();await page.getByText('رسالة علنية تجريبية',{exact:true}).waitFor();};
  const open=async()=>{await page.getByRole('button',{name:'مسؤول التذكرة والتحويل',exact:true}).click();};
  const panel=page.getByRole('region',{name:'إدارة مسؤول التذكرة'});
  const queue=page.getByRole('region',{name:'طلباتي المسندة'});
  await page.goto('https://fixture.invalid/support');await select();if(calls.some(row=>row.path.includes('/assignment')))throw Error('collapsed assignment fetched private state');
  if(calls.some(row=>row.path==='/api/support-tickets/assigned'))throw Error('collapsed assigned queue fetched rows');
  if(testAssigned){await queue.getByRole('button',{name:'الطلبات المسندة لي',exact:true}).click();await queue.locator('li').nth(24).waitFor();await queue.getByRole('button',{name:'عرض طلبات مسندة إضافية',exact:true}).click();await queue.locator('li').nth(25).waitFor();if(await queue.locator('li').count()!==26)throw Error('assigned paging lost/duplicated rows');}
  await open();await panel.getByRole('button',{name:'تولّي متابعة التذكرة',exact:true}).click();await panel.getByRole('button',{name:'التحقق من نتيجة التكليف',exact:true}).waitFor();
  if(!await panel.getByLabel('المسؤول الجديد',{exact:true}).isDisabled())throw Error('unknown decision not frozen');
  if(testAssigned)await queue.getByRole('button',{name:/طلب دعم مصطنع للمراجعة/}).waitFor();
  const stored=await page.evaluate(()=>Object.entries(sessionStorage));if(stored.length!==1||!stored.every(([,value])=>/^[a-f\d-]{36}$/i.test(value)))throw Error('assignment payload stored locally');
  if(testAssigned){await queue.getByRole('button',{name:/طلب دعم مصطنع للمراجعة/}).click();await page.getByText('رسالة علنية تجريبية',{exact:true}).waitFor();if(posts!==1)throw Error('opening assigned detail mutated ticket');}
  assignment={ticket_id:ticket.id,assigned_to:'synthetic-other',version:2};
  await page.reload();await select();
  if(testAssigned){await queue.getByRole('button',{name:'الطلبات المسندة لي',exact:true}).click();await queue.locator('li').nth(24).waitFor();if(await queue.getByRole('button',{name:/طلب دعم مصطنع للمراجعة/}).count())throw Error('transferred row reappeared');}
  await open();await panel.getByRole('button',{name:'التحقق من نتيجة التكليف',exact:true}).click();
  await panel.getByText('تم تأكيد قرار التكليف وعرض الحالة الحالية من الخادم.',{exact:true}).waitFor();
  await panel.locator('strong').filter({hasText:'مسؤول الدعم الثاني'}).waitFor();if(posts!==1)throw Error('recovery repeated POST');
  await panel.getByLabel('المسؤول الجديد',{exact:true}).selectOption('synthetic-agent');await panel.getByRole('button',{name:'حفظ المسؤول المختار',exact:true}).click();
  await panel.getByText('قرار التكليف مؤكد، لكن تعذّر تحديث الحالة الحالية. لا تُعد إرسال القرار؛ حدّث البيانات.',{exact:true}).waitFor();if(await panel.locator('strong').count())throw Error('stale assignment retained after refresh failure');
  await panel.getByRole('button',{name:'تحديث حالة التكليف',exact:true}).click();await panel.locator('strong').filter({hasText:'مسؤول الدعم الأول'}).waitFor();
  if(testAssigned)await queue.getByRole('button',{name:/طلب دعم مصطنع للمراجعة/}).waitFor();
  for(const width of [390,1024]){await page.setViewportSize({width,height:850});await page.screenshot({path:`tmp/support-${testAssigned?'assigned-queue':'assignment'}-${width}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('assignment UI overflow');}
  await panel.getByLabel('المسؤول الجديد',{exact:true}).selectOption('synthetic-other');await panel.getByRole('button',{name:'حفظ المسؤول المختار',exact:true}).click();
  await panel.getByText('لم يُنفذ القرار لأن الحالة أو صلاحية المسؤول تغيّرت. راجع الحالة الحالية قبل قرار جديد.',{exact:true}).waitFor();await panel.locator('strong').filter({hasText:'مسؤول الدعم الثاني'}).waitFor();
  if(testAssigned){await page.waitForFunction(()=>document.querySelector('[aria-label="طلباتي المسندة"]')?.textContent.includes('متابعة تجريبية'));if(await queue.getByRole('button',{name:/طلب دعم مصطنع للمراجعة/}).count())throw Error('stale assignment row retained');}
  if(await panel.getByRole('button',{name:'التحقق من نتيجة التكليف',exact:true}).count()||await page.evaluate(()=>Object.keys(sessionStorage).some(key=>key.includes('.assign.'))))throw Error('definitive rejection remained uncertain');
  await panel.getByRole('button',{name:'إلغاء التكليف',exact:true}).click();await panel.locator('strong').filter({hasText:'لم يُحدد مسؤول'}).waitFor();
  if(testAssigned){failAssigned=true;await queue.getByRole('button',{name:'تحديث الطلبات المسندة',exact:true}).click();await queue.getByText('تعذّر تحديث الطلبات المسندة؛ القائمة الحالية غير متاحة.',{exact:true}).waitFor();if(await queue.locator('li').count())throw Error('obsolete assigned rows retained on refresh failure');await queue.getByRole('button',{name:'تحديث الطلبات المسندة',exact:true}).click();await queue.locator('li').nth(24).waitFor();}
  allowed=false;await panel.getByRole('button',{name:'تحديث حالة التكليف',exact:true}).click();await panel.getByText('لم تعد صلاحية إدارة التكليف متاحة للحساب الحالي.',{exact:true}).waitFor();if(await panel.locator('strong').count())throw Error('revoked assignment view retained');
  if(testAssigned){await queue.getByRole('button',{name:'تحديث الطلبات المسندة',exact:true}).click();await queue.getByText('تغيّرت الجلسة أو صلاحية قائمة الطلبات. أعد فتح القائمة للتحقق.',{exact:true}).waitFor();if(await queue.locator('li').count())throw Error('revoked assigned rows retained');}
  await page.goto('https://fixture.invalid/support?fixtureRole=requester');await select();if(await page.getByRole('button',{name:'مسؤول التذكرة والتحويل',exact:true}).count())throw Error('requester assignment UI visible');
  if(calls.some(row=>!row.admin&&(row.path.includes('/assignment')||row.path==='/api/support-tickets/assigned'))||errors.length||posts!==4)throw Error('private leak, page error or unexpected writes');
  console.log(JSON.stringify({assignedQueue:testAssigned,assignmentPosts:posts,publicMutations:0,recoveryByGet:true,newerAssignmentPreserved:true,opaqueKeysOnly:true,confirmedSaveRefreshFailureSeparated:true,staleDecisionRecovered:true,unassignment:true,revocationClears:true,requesterAssignmentRequests:0,viewports:[390,1024],overflow:false,pageErrors:0,requests:calls.length}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
