const fs=require('node:fs'),path=require('node:path');
const {build}=require('esbuild');
const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');
const reply=n=>({id:`reply-${String(n).padStart(3,'0')}`,body:`رسالة اختبار ${n}`,sender_id:'synthetic-owner',sender_name:'مدرس تجريبي',sender_role:'instructor',created_at:'2026-11-05T10:00:00Z'});
const ticket=id=>({id,ticket_number:`SUP-${id}`,category:'technical',subject:id==='ticket-a'?'مشكلة تشغيل الدرس':'محادثة ثانية',description:'بيانات مصطنعة لاختبار عرض المحادثة',status:'open',priority:'normal',created_at:'2026-11-05T10:00:00Z',updated_at:'2026-11-05T10:00:00Z'});
(async()=>{
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import Support from './src/pages/Support';import {notifySessionChange} from './src/lib/session-events';
  localStorage.setItem('authToken','synthetic-browser-token');localStorage.setItem('currentUser',JSON.stringify({id:'synthetic-owner',role:'instructor'}));window.endFixtureSession=()=>notifySessionChange('scope');
  createRoot(document.getElementById('root')).render(<BrowserRouter><Support/></BrowserRouter>);`,resolveDir:process.cwd(),loader:'tsx'},
  bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,alias:{'@':path.resolve('src')},logLevel:'silent',
  plugins:[{name:'fixture-navigation',setup(builder){builder.onLoad({filter:/[\\/]components[\\/](Header|StudentHeader)\.tsx$/},()=>({contents:'export default function Header(){return null}',loader:'tsx'}));}}]});
 const css=fs.readdirSync('dist/assets').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join('dist/assets',n),'utf8')).join('\n');
 const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>اختبار محادثة الدعم محليًا</title><style>${css}</style><body style="font-family:Tahoma,sans-serif"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
 fs.writeFileSync('tmp/support-pagination-browser.html',html);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{
  const page=await browser.newPage();let heldRoute,holdNext=false;const calls=[];
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!=='http://fixture.invalid')return route.abort();
   if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:html});
   calls.push({path:url.pathname,method:req.method(),before:url.searchParams.get('before')});
   if(req.headers().authorization!=='Bearer synthetic-browser-token')throw Error('missing synthetic bearer');
   const send=value=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
   if(url.pathname.endsWith('/context'))return send({state:'none',context:null});
   if(url.pathname.endsWith('/mine'))return send([ticket('ticket-a'),ticket('ticket-b')]);
   if(url.pathname.endsWith('/replies')){
    if(holdNext){heldRoute=route;return;}
    const before=url.searchParams.get('before');return send(before==='reply-152'?{replies:Array.from({length:100},(_,n)=>reply(n+52)),next_cursor:'reply-052'}:{replies:Array.from({length:51},(_,n)=>reply(n+1)),next_cursor:null});
   }
   if(url.pathname.endsWith('/ticket-b'))return send({ticket:ticket('ticket-b'),replies:[],next_cursor:null,has_more_replies:false});
   return send({ticket:ticket('ticket-a'),replies:Array.from({length:100},(_,n)=>reply(n+152)),next_cursor:'reply-152',has_more_replies:true});
  });
  await page.setViewportSize({width:390,height:850});await page.goto('http://fixture.invalid/');
  await page.getByRole('button',{name:/مشكلة تشغيل الدرس/}).click();await page.getByText('رسالة اختبار 251',{exact:true}).waitFor();
  await page.getByRole('button',{name:'عرض رسائل أقدم',exact:true}).scrollIntoViewIfNeeded();
  const previousY=(await page.getByText('رسالة اختبار 152',{exact:true}).boundingBox()).y;
  await page.getByRole('button',{name:'عرض رسائل أقدم',exact:true}).click();await page.getByText('رسالة اختبار 52',{exact:true}).waitFor();
  if(Math.abs((await page.getByText('رسالة اختبار 152',{exact:true}).boundingBox()).y-previousY)>2)throw Error('reading position jumped while prepending');
  await page.getByRole('button',{name:'عرض رسائل أقدم',exact:true}).click();await page.getByText('رسالة اختبار 1',{exact:true}).waitFor();
  if(await page.getByRole('button',{name:'عرض رسائل أقدم',exact:true}).count())throw Error('exhausted cursor still offered');
  const messages=await page.locator('p').allTextContents();if(messages.filter(x=>/^رسالة اختبار \d+$/.test(x)).length!==251)throw Error('lost or duplicated replies');
  for(const width of [390,1024]){await page.setViewportSize({width,height:850});await page.screenshot({path:`tmp/support-pagination-${width}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('horizontal overflow');}
  await page.getByRole('button',{name:/مشكلة تشغيل الدرس/}).click();await page.getByRole('button',{name:'عرض رسائل أقدم',exact:true}).waitFor();holdNext=true;
  await page.getByRole('button',{name:'عرض رسائل أقدم',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('جارٍ تحميل الرسائل الأقدم'));
  await page.getByRole('button',{name:/محادثة ثانية/}).click();await page.getByText('لم تُرسل ردود بعد.',{exact:true}).waitFor();
  if(heldRoute)await heldRoute.fulfill({status:200,contentType:'application/json',body:JSON.stringify({replies:[reply(51)],next_cursor:null})}).catch(()=>{});
  if(await page.getByText('رسالة اختبار 51',{exact:true}).count())throw Error('late reply crossed ticket');
  await page.evaluate(()=>window.endFixtureSession());await page.getByRole('alert').waitFor();
  if(await page.getByRole('button',{name:/محادثة ثانية/}).count())throw Error('private ticket retained after session event');
  if(calls.some(row=>row.method!=='GET'))throw Error('unexpected write');
  console.log(JSON.stringify({messages:251,pages:3,viewports:[390,1024],overflow:false,readingPositionPreserved:true,latePageFenced:true,sessionClears:true,mutations:0,requests:calls.length}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
