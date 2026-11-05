const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');
const id=n=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={kind:'catalog_lesson',course_id:id(1),lesson_id:id(3),course_name:'كورس رياضيات تجريبي',lesson_title:'درس المعادلات التجريبي'};
(async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route} from 'react-router-dom';import Support from './src/pages/Support';import StudentContent from './src/pages/StudentContent';
  localStorage.setItem('authToken','synthetic-browser-token');localStorage.setItem('currentUser',JSON.stringify({id:'synthetic-student',role:'student'}));
  createRoot(document.getElementById('root')).render(<BrowserRouter><Routes><Route path="/student-content" element={<StudentContent/>}/><Route path="/support" element={<Support/>}/></Routes></BrowserRouter>);`,resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,alias:{'@':path.resolve('src')},logLevel:'silent',
  plugins:[{name:'fixture-navigation',setup(builder){builder.onLoad({filter:/[\\/]components[\\/](Header|StudentHeader)\.tsx$/},()=>({contents:'export default function Header(){return null}',loader:'tsx'}));}}]});
 const css=fs.readdirSync('dist/assets').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join('dist/assets',n),'utf8')).join('\n');
 const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>اختبار سياق دعم الدرس</title><style>${css}</style><body style="font-family:Tahoma,sans-serif"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
 fs.writeFileSync('tmp/support-lesson-context-browser.html',html);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:850}}),calls=[],errors=[],tickets=[];let withdrawn=false,createKey=null;
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!=='https://fixture.invalid')return route.abort();
   if(['/student-content','/support'].includes(url.pathname))return route.fulfill({status:200,contentType:'text/html',body:html});
   calls.push({path:url.pathname,method:req.method(),body:req.method()==='POST'?req.postDataJSON():null});
   if(req.headers().authorization!=='Bearer synthetic-browser-token')throw Error('missing bearer');
   const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(url.pathname==='/api/student-course-access/courses')return send({courses:[{course_id:id(1),name:context.course_name,subject:null,grade:null}],truncated:false});
   if(url.pathname===`/api/student-course-access/courses/${id(1)}`)return send({course:{course_id:id(1),name:context.course_name,subject:null,grade:null},units:[{unit_id:id(2),name:'وحدة تجريبية',display_order:0,lessons:[
    {lesson_id:id(3),title:context.lesson_title,display_order:0,release_at:null,prerequisite_lesson_id:null,accessible:true,lock_reason:null,completed:false,completed_at:null,description:'وصف مصطنع'},
    {lesson_id:id(4),title:'درس مقفول تجريبي',display_order:1,release_at:'2027-01-01T10:00:00.000Z',prerequisite_lesson_id:null,accessible:false,lock_reason:'not_released',completed:false,completed_at:null,description:null},
   ]}],truncated:false});
   if(url.pathname.endsWith('/support-context'))return withdrawn||!url.pathname.includes(`/lessons/${id(3)}/`)?send({error:'Lesson not found'},404):send({context});
   if(url.pathname==='/api/support-tickets/mine')return send(tickets);
   if(req.method()==='POST'&&url.pathname==='/api/support-tickets'){
    const body=req.postDataJSON();createKey=req.headers()['idempotency-key'];if(!createKey)throw Error('missing attempt key');
    if(body.context&&JSON.stringify(body.context)!==JSON.stringify({kind:'catalog_lesson',course_id:id(1),lesson_id:id(3)}))throw Error('caller authority or title attached');
    const ticket={id:id(10+tickets.length),ticket_number:`SUP-FIXTURE-${tickets.length}`,user_id:'synthetic-student',category:body.category,subject:body.subject,description:body.description,status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z'};tickets.push(ticket);
    return body.context?send({error:'Synthetic lost acknowledgement',code:'PERSISTENCE_UNCERTAIN'},503):send({ticket,unchanged:false},201);
   }
   if(url.pathname.includes('/attempts/create/')){if(url.pathname.split('/').at(-1)!==createKey)throw Error('key changed');return send({ticket:tickets[0],unchanged:true});}
   if(url.pathname.endsWith('/context'))return send(url.pathname.includes(id(10))?(withdrawn?{state:'unavailable',context:null}:{state:'available',context}):{state:'none',context:null});
   const ticket=tickets.find(ticket=>url.pathname.endsWith(`/${ticket.id}`));if(ticket)return send({ticket,replies:[],next_cursor:null,has_more_replies:false});
   throw Error('Unexpected fixture request '+url.pathname);
  });
  await page.goto('https://fixture.invalid/student-content');await page.getByRole('button',{name:context.course_name,exact:true}).click();
  await page.getByRole('button',{name:'طلب مساعدة في الدرس',exact:true}).waitFor();if(await page.getByRole('button',{name:'طلب مساعدة في الدرس',exact:true}).count()!==1)throw Error('locked lesson offered context action');
  await page.getByRole('button',{name:'طلب مساعدة في الدرس',exact:true}).click();
  await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByText(`الدرس المرتبط: ${context.course_name} — ${context.lesson_title}`,{exact:true}).waitFor();
  await page.getByLabel('عنوان مختصر',{exact:true}).fill('مشكلة مصطنعة في درس المعادلات');await page.getByLabel('اشرح المشكلة وما الذي كنت تحاول فعله',{exact:true}).fill('شرح مصطنع للمشكلة فقط دون إرفاق أي ملف أو بيانات شخصية');
  await page.getByRole('button',{name:'إرسال الطلب',exact:true}).click();await page.getByRole('button',{name:'التحقق من نتيجة الطلب',exact:true}).waitFor();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='إعادة نفس الطلب'&&!button.disabled));
  for(const width of [390,1024]){await page.setViewportSize({width,height:850});await page.screenshot({path:`tmp/support-lesson-context-${width}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('context overflow');}
  await page.getByRole('button',{name:'التحقق من نتيجة الطلب',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByText(`سياق الدرس: ${context.course_name} — ${context.lesson_title}`,{exact:true}).waitFor();
  withdrawn=true;await page.getByRole('button',{name:/مشكلة مصطنعة في درس المعادلات/}).click();await page.getByText('سياق الدرس المرتبط لم يعد متاحًا حاليًا. يمكنك متابعة التذكرة.',{exact:true}).waitFor();
  if(await page.getByText(`سياق الدرس: ${context.course_name} — ${context.lesson_title}`,{exact:true}).count())throw Error('withdrawal left verified ticket context');
  await page.goto(`https://fixture.invalid/support?course=${id(1)}&lesson=${id(4)}`);await page.getByRole('dialog').waitFor();
  const submit=page.getByRole('button',{name:'إرسال الطلب',exact:true});await page.waitForFunction(()=>document.body.textContent.includes('لن يُرسل طلب مرتبط بدرس قبل تأكيد إتاحته.'));
  if(!await submit.isDisabled())throw Error('unverified context allowed submit');if(calls.filter(row=>row.method==='POST').length!==1)throw Error('automatic fallback write');
  await page.getByRole('dialog').getByRole('button',{name:'متابعة بطلب دعم عام',exact:true}).click();
  await page.getByLabel('عنوان مختصر',{exact:true}).fill('طلب دعم عام مصطنع');await page.getByLabel('اشرح المشكلة وما الذي كنت تحاول فعله',{exact:true}).fill('تفاصيل مصطنعة لطلب عام اختاره المستخدم صراحة');await submit.click();await page.getByRole('dialog').waitFor({state:'hidden'});
  const posts=calls.filter(row=>row.method==='POST');if(posts.length!==2||posts[1].body.context||errors.length)throw Error('fallback or page error');
  console.log(JSON.stringify({accessibleLessonAction:true,lockedLessonAction:false,contextualPosts:1,recoveredByGet:true,withdrawalHidesContext:true,explicitGenericPosts:1,implicitWrites:0,viewports:[390,1024],overflow:false,pageErrors:0,requests:calls.length}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
