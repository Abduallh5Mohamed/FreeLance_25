const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');
const id=n=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pdf=Buffer.from('%PDF-1.7\nsynthetic browser fixture only\n%%EOF');
(async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {StudentLessonMaterials} from './src/features/catalog/StudentLessonMaterials';
  localStorage.setItem('authToken','synthetic-browser-token');localStorage.setItem('currentUser',JSON.stringify({id:'synthetic-student',role:'student'}));
  createRoot(document.getElementById('root')).render(<StudentLessonMaterials courseId="${id(2)}" lessonId="${id(3)}"/>);`,resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,alias:{'@':path.resolve('src')},logLevel:'silent'});
 const css=fs.readdirSync('dist/assets').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join('dist/assets',n),'utf8')).join('\n');
 const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>اختبار PDF الطالب محليًا</title><style>${css}</style><body style="font-family:Tahoma,sans-serif;background:white"><main class="mx-auto max-w-3xl space-y-4 p-4"><h1 class="text-xl font-bold">مواد الدرس — بيانات اختبار مصطنعة</h1><div id="root"></div></main><script>${bundle.outputFiles[0].text}</script></body></html>`;
 fs.writeFileSync('tmp/student-pdf-download-browser.html',html);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{
  const page=await browser.newPage({acceptDownloads:true});const calls=[];let revoked=false;
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.origin!=='http://fixture.invalid')return route.abort();
   if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:html});
   calls.push({path:url.pathname,method:request.method()});
   if(request.headers().authorization!=='Bearer synthetic-browser-token')throw Error('synthetic bearer missing');
   if(url.pathname.endsWith('/file'))return revoked?route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'Lesson content not found'})}):route.fulfill({status:200,headers:{'Content-Type':'application/pdf','Content-Length':String(pdf.length),'Content-Disposition':`attachment; filename="lesson-material-${id(4)}.pdf"`,'Cache-Control':'no-store'},body:pdf});
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({lesson_id:id(3),contents:[{content_id:id(1),title:'ملف تدريبات PDF للدرس',material_type:'pdf',display_order:0,delivery_status:'pdf_available'}]})});
  });
  await page.setViewportSize({width:390,height:850});await page.goto('http://fixture.invalid/');await page.getByRole('button',{name:'عرض مواد الدرس'}).waitFor();
  if(calls.length)throw Error('closed panel fetched private data');
  await page.getByRole('button',{name:'عرض مواد الدرس'}).click();await page.getByRole('button',{name:'تنزيل PDF',exact:true}).waitFor();
  for(const width of [390,1024]){await page.setViewportSize({width,height:850});await page.screenshot({path:`tmp/student-pdf-download-${width}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('horizontal overflow');}
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'تنزيل PDF',exact:true}).click();const file=await downloaded;
  if(!fs.readFileSync(await file.path()).equals(pdf)||file.suggestedFilename()!==`lesson-material-${id(1)}.pdf`)throw Error('browser bytes/name mismatch');
  await page.getByText('تم تجهيز الملف وإرسال طلب التنزيل للمتصفح.',{exact:false}).waitFor();
  revoked=true;await page.getByRole('button',{name:'تنزيل PDF',exact:true}).click();await page.getByText('لم يعد تنزيل هذه المادة مسموحًا.',{exact:false}).waitFor();
  if(await page.getByText('ملف تدريبات PDF للدرس',{exact:true}).count())throw Error('revocation left private title');
  if(calls.length!==3||calls.some(c=>c.method!=='GET'))throw Error('unexpected request or completion write');
  await page.screenshot({path:'tmp/student-pdf-download-revoked.png',fullPage:true});
  console.log(JSON.stringify({closedRequests:0,viewports:[390,1024],overflow:false,actualBrowserDownload:true,exactBytes:true,revocationClears:true,requests:calls.length,completionWrites:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
