const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');
const id=n=>`b1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const course=id(9),unit=id(8),lesson=id(7),base=`/api/tenants/me/catalog/courses/${course}/units/${unit}/lessons`;
(async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import CourseLessonManager from './src/features/catalog/CourseLessonManager';
 localStorage.setItem('authToken','synthetic-owner-token');localStorage.setItem('currentUser',JSON.stringify({id:'synthetic-owner',role:'instructor'}));
 createRoot(document.getElementById('root')).render(<main dir="rtl" className="mx-auto max-w-4xl space-y-4 p-4"><h1 className="text-xl font-bold">إعداد حصة تجريبية</h1><CourseLessonManager courseId="${course}" unitId="${unit}"/></main>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,alias:{'@':path.resolve('src')},logLevel:'silent'});
 const css=fs.readdirSync('dist/assets').filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join('dist/assets',name),'utf8')).join('\n');
 const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>إعداد فيديوهات الدرس</title><style>${css}</style><body style="font-family:Tahoma,sans-serif;background:#f8fafc"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
 fs.writeFileSync('tmp/owner-lesson-videos-browser.html',html);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:850}}),calls=[],errors=[],rows=[],sources=Array.from({length:30},(_,n)=>({video_id:id(n+1),title:`فيديو الشرح ${n+1}`}));
  let posts=0,deletes=0,failRead=false,allowed=true;
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!=='https://fixture.invalid')return route.abort();
   if(url.pathname==='/owner')return route.fulfill({status:200,contentType:'text/html',body:html});
   calls.push({path:url.pathname,method:req.method(),query:url.search});
   const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(value)});
   if(req.headers().authorization!=='Bearer synthetic-owner-token')throw Error('canonical bearer missing');
   if(url.pathname===base)return send({lessons:[{id:lesson,unit_id:unit,title:'درس تجريبي لإدارة الفيديو',description:null,status:'active',display_order:0,release_at:null,prerequisite_lesson_id:null,created_at:'2026-11-06T10:00:00.000Z',updated_at:'2026-11-06T10:00:00.000Z'}],next_cursor:null});
   if(!allowed)return send({error:'Synthetic owner permission removed'},403);
   if(url.pathname.endsWith('/contents'))return send({contents:[{content_id:id(201),material_id:id(301),title:'ملف شرح تجريبي',material_type:'pdf',display_order:0}]});
   if(url.pathname.endsWith('/available-videos')){const cursor=url.searchParams.get('cursor'),remaining=sources.filter(row=>!cursor||row.video_id>cursor);return send({videos:remaining.slice(0,25),next_cursor:remaining.length>25?remaining[24].video_id:null});}
   if(url.pathname===`${base}/${lesson}/videos`){
    if(req.method()==='POST'){
     posts++;const input=req.postDataJSON();if(Object.keys(input).sort().join(',')!=='display_order,video_id'||input.display_order===0)throw Error('invalid/occupied video payload sent');
     if(rows.some(row=>row.video_id===input.video_id))throw Error('duplicate POST');
     const source=sources.find(row=>row.video_id===input.video_id);if(!source)throw Error('foreign source');
     const content={content_id:id(100+posts),...source,display_order:input.display_order,video_status:'ready'};rows.push(content);rows.sort((a,b)=>a.display_order-b.display_order);
     if(posts===1){failRead=true;return send({content,unchanged:false},201);}
     return send({error:'Synthetic lost commit acknowledgement',code:'PERSISTENCE_UNCERTAIN'},500);
    }
    if(failRead){failRead=false;return send({error:'Synthetic list outage'},503);}return send({videos:rows});
   }
   if(req.method()==='DELETE'&&url.pathname.startsWith(`${base}/${lesson}/videos/`)){
    deletes++;const contentId=url.pathname.split('/').at(-1),index=rows.findIndex(row=>row.content_id===contentId);if(index<0)throw Error('wrong delete target');rows.splice(index,1);return send({detached:true,content_id:contentId});
   }
   throw Error(`Unexpected synthetic request: ${req.method()} ${url.pathname}`);
  });
  await page.goto('https://fixture.invalid/owner');if(calls.length)throw Error('closed lesson manager fetched data');await page.getByRole('button',{name:'فتح لوحة الدروس',exact:true}).click();
  await page.getByRole('button',{name:'إدارة فيديوهات الدرس',exact:true}).waitFor();if(calls.some(call=>call.path.includes('/videos')||call.path.endsWith('/contents')))throw Error('collapsed video editor fetched metadata');
  await page.getByRole('button',{name:'إدارة فيديوهات الدرس',exact:true}).click();const panel=page.getByRole('region',{name:'إعداد فيديوهات الدرس'});
  const picker=panel.getByLabel('اختر فيديو من نفس الكورس',{exact:true}),position=panel.getByLabel('موضع الفيديو داخل الدرس',{exact:true}),save=panel.getByRole('button',{name:'ربط مرجع الفيديو بالدرس',exact:true});
  await picker.selectOption(id(1));await position.fill('12abc');await save.click();await panel.getByText('اكتب موضعًا صحيحًا كاملًا من صفر إلى 2147483647.',{exact:true}).waitFor();if(posts)throw Error('invalid amount/order wrote');
  await position.fill('0');await save.click();await panel.getByText('اختر فيديو غير مرتبط وموضعًا غير مستخدم؛ الحد المشترك ٢٠ محتوى.',{exact:true}).waitFor();if(posts)throw Error('material position collision wrote');
  await position.fill('1');await save.click();await panel.getByText('الحفظ مؤكد، لكن تعذّر تحديث القائمة. حدّث البيانات ولا تُعد الحفظ.',{exact:true}).waitFor();if(posts!==1||await panel.getByRole('button',{name:'فك مرجع الفيديو',exact:true}).count())throw Error('confirmed refresh failure kept stale list');
  await panel.getByRole('button',{name:'تحديث فيديوهات الدرس والمواد',exact:true}).click();await panel.getByText('تم تأكيد ربط مرجع الفيديو بالدرس؛ هذا لا يفعّل تشغيل الطالب.',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'فيديوهات الصفحة التالية',exact:true}).click();await picker.selectOption(id(26));await position.fill('2');await save.click();await panel.getByText(/نتيجة الحفظ غير مؤكدة/).waitFor();if(posts!==2)throw Error('unknown write retried itself');
  await panel.getByRole('button',{name:'تحديث فيديوهات الدرس والمواد',exact:true}).click();await panel.getByText('فيديو الشرح 26',{exact:true}).waitFor();if(posts!==2)throw Error('read reconciliation resubmitted');
  if(await panel.locator('video,a[href]').count()||calls.some(call=>call.path.includes('/secure-video')))throw Error('preparation enabled playback');
  if(await page.evaluate(()=>Object.keys(sessionStorage).length||Object.keys(localStorage).some(key=>!['authToken','currentUser'].includes(key))))throw Error('video drafts persisted locally');
  for(const width of [390,1024]){await page.setViewportSize({width,height:850});await page.screenshot({path:`tmp/owner-lesson-videos-${width}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('video editor overflow');}
  const second=panel.getByRole('listitem').filter({hasText:'فيديو الشرح 26'});await second.getByRole('button',{name:'فك مرجع الفيديو',exact:true}).click();if(deletes)throw Error('detach lacked confirmation');await second.getByRole('button',{name:'تأكيد فك مرجع الفيديو',exact:true}).click();await panel.getByText('تم تأكيد فك مرجع الفيديو؛ الفيديو الأصلي محفوظ.',{exact:true}).waitFor();if(deletes!==1||sources.length!==30)throw Error('detach affected original media');
  rows[0].title=null;rows[0].video_status='unavailable';await panel.getByRole('button',{name:'تحديث فيديوهات الدرس والمواد',exact:true}).click();await panel.getByText('المصدر غير متاح · الموضع 1',{exact:true}).waitFor();
  allowed=false;await panel.getByRole('button',{name:'تحديث فيديوهات الدرس والمواد',exact:true}).click();await panel.getByText('تعذّر إثبات صلاحية الدرس أو المصدر. أغلق اللوحة وافتحها للتحقق.',{exact:true}).waitFor();if(await panel.locator('form,li').count())throw Error('private form/rows retained after denial');
  if(errors.length||posts!==2||deletes!==1)throw Error('page error or unexpected write count');
  console.log(JSON.stringify({parentComponent:'CourseLessonManager',posts:2,deletes:1,collapsedVideoRequests:0,strictOrderAndSharedPosition:true,confirmedRefreshFailureSeparated:true,unknownRecoveredByRead:true,selectorPaging:true,explicitDetachConfirmation:true,originalMediaPreserved:true,permissionClears:true,playbackRequests:0,draftsPersisted:false,viewports:[390,1024],overflow:false,pageErrors:0,requests:calls.length}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
