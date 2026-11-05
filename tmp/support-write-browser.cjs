const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');
const id=n=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
(async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import Support from './src/pages/Support';
  localStorage.setItem('authToken','synthetic-browser-token');localStorage.setItem('currentUser',JSON.stringify({id:'synthetic-owner',role:'instructor'}));
  createRoot(document.getElementById('root')).render(<BrowserRouter><Support/></BrowserRouter>);`,resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,alias:{'@':path.resolve('src')},logLevel:'silent',
  plugins:[{name:'fixture-navigation',setup(builder){builder.onLoad({filter:/[\\/]components[\\/](Header|StudentHeader)\.tsx$/},()=>({contents:'export default function Header(){return null}',loader:'tsx'}));}}]});
 const css=fs.readdirSync('dist/assets').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join('dist/assets',n),'utf8')).join('\n');
 const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>اختبار استرداد محاولة الدعم</title><style>${css}</style><body style="font-family:Tahoma,sans-serif"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
 fs.writeFileSync('tmp/support-write-browser.html',html);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{
  const page=await browser.newPage({viewport:{width:390,height:850}}),calls=[],errors=[];let ticket=null,reply=null,createKey=null,replyKey=null;
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!=='https://fixture.invalid')return route.abort();
   if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:html});
   calls.push({path:url.pathname,method:req.method()});
   if(req.headers().authorization!=='Bearer synthetic-browser-token')throw Error('missing synthetic bearer');
   const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(url.pathname.endsWith('/context'))return send({state:'none',context:null});
   if(req.method()==='POST'){
    const payload=req.postDataJSON(),key=req.headers()['idempotency-key'];if(!key)throw Error('request key missing');
    if(url.pathname.endsWith('/replies')){
     if(reply)throw Error('duplicate reply POST');replyKey=key;reply={id:id(2),body:payload.body,sender_id:'synthetic-owner',sender_name:'مدرس تجريبي',sender_role:'instructor',created_at:'2026-11-05T11:00:00Z'};ticket.status='waiting_on_support';
    }else{
     if(ticket)throw Error('duplicate ticket POST');createKey=key;ticket={id:id(1),ticket_number:'SUP-202611-FIXTURE',user_id:'synthetic-owner',category:payload.category,subject:payload.subject,description:payload.description,status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z'};
    }
    return send({error:'Synthetic lost acknowledgement',code:'PERSISTENCE_UNCERTAIN'},503);
   }
   if(url.pathname.includes('/attempts/create/')){if(url.pathname.split('/').at(-1)!==createKey)throw Error('create key changed after reload');return send({ticket,unchanged:true});}
   if(url.pathname.includes('/attempts/reply/')){if(url.pathname.split('/').at(-1)!==replyKey)throw Error('reply key changed after reload');return send({reply,ticket_id:ticket.id,ticket_status:ticket.status,unchanged:true});}
   if(url.pathname.endsWith('/mine'))return send(ticket?[ticket]:[]);
   return send({ticket,replies:reply?[reply]:[],next_cursor:null,has_more_replies:false});
  });
  await page.goto('https://fixture.invalid/');if(!await page.evaluate(()=>typeof crypto.randomUUID==='function'))throw Error('fixture requires a secure browser origin');await page.getByRole('button',{name:'طلب دعم جديد',exact:true}).click();
  await page.getByLabel('عنوان مختصر',{exact:true}).fill('طلب مصطنع لاسترداد النتيجة');
  await page.getByLabel('اشرح المشكلة وما الذي كنت تحاول فعله',{exact:true}).fill('وصف مصطنع خاص للاختبار فقط ولا يحتوي على بيانات حقيقية');
  await page.getByRole('button',{name:'إرسال الطلب',exact:true}).click();await page.getByRole('button',{name:'التحقق من نتيجة الطلب',exact:true}).waitFor();
  if(!await page.getByLabel('عنوان مختصر',{exact:true}).isDisabled())throw Error('unknown payload still editable');
  const stored=await page.evaluate(()=>Object.entries(sessionStorage));if(stored.length!==1||!stored.every(([,value])=>/^[a-f\d-]{36}$/i.test(value)))throw Error('private form text persisted');
  await page.screenshot({path:'tmp/support-write-uncertain-390.png',fullPage:true});
  await page.reload();await page.getByRole('button',{name:'طلب دعم جديد',exact:true}).click();await page.getByRole('button',{name:'التحقق من نتيجة الطلب',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByLabel('اكتب ردك هنا',{exact:true}).waitFor();
  await page.getByLabel('اكتب ردك هنا',{exact:true}).fill('رد مصطنع للتحقق بعد إعادة فتح الصفحة');await page.getByRole('button',{name:'إرسال الرد',exact:true}).click();
  await page.getByRole('button',{name:'التحقق من نتيجة الرد',exact:true}).waitFor();if(!await page.getByLabel('اكتب ردك هنا',{exact:true}).isDisabled())throw Error('unknown reply payload editable');
  await page.reload();await page.getByRole('button',{name:/طلب مصطنع لاسترداد النتيجة/}).click();await page.getByRole('button',{name:'التحقق من نتيجة الرد',exact:true}).click();
  await page.waitForFunction(()=>!Object.keys(sessionStorage).some(key=>key.startsWith('tabweb.support.attempt.')));
  if(await page.getByText('رد مصطنع للتحقق بعد إعادة فتح الصفحة',{exact:true}).count()!==1)throw Error('confirmed reply duplicated in UI');
  if(calls.filter(row=>row.method==='POST').length!==2||errors.length)throw Error('unexpected mutation or page error '+errors.join(','));
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('mobile overflow');
  await page.screenshot({path:'tmp/support-write-confirmed-390.png',fullPage:true});
  console.log(JSON.stringify({createPosts:1,replyPosts:1,reloads:2,recoveredByGet:true,opaqueKeysOnly:true,duplicateReplies:0,overflow:false,pageErrors:0,requests:calls.length}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
