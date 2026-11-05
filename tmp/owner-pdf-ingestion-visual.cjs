const Module=require('node:module'),path=require('node:path'),fs=require('node:fs'),React=require('react');global.React=React;
const target=require.resolve('../src/features/catalog/OwnerMaterialPdfManager.tsx'),original=Module._load;
const id=n=>`a1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base={phase:'ready',file:null,uploadConfigured:true,scanConfigured:false,busy:false,uncertain:false,retryable:false,error:null,notice:null};
const file={file_id:id(1),material_id:id(2),size_bytes:42,upload_status:'stored',scan_status:'pending',source_status:'active'};
let serial=0;
function render(state){let slot=0;const uid='owner-pdf-'+(++serial);Module._load=function(name,parent,main){
 if(name==='react'&&parent?.filename===target)return{...React,useState:()=>[slot++===0?state:null,()=>{}],useEffect(){},useRef:()=>({current:null}),useId:()=>uid};
 if(name.startsWith('@/'))return original.call(this,path.resolve('src',name.slice(2)),parent,main);return original.call(this,name,parent,main);
 };try{delete require.cache[target];const {OwnerMaterialPdfEditor}=require(target);return require('react-dom/server').renderToStaticMarkup(OwnerMaterialPdfEditor({courseId:id(3),unitId:id(4),lessonId:id(5),contentId:id(6),materialId:id(2)}));}finally{Module._load=original;}}
const states=[base,{...base,uploadConfigured:false},{...base,file,retryable:true,notice:'تم حفظ الملف، وهو بانتظار الفحص ولن يُسلَّم للطلاب قبل اكتماله.'},
 {...base,scanConfigured:true,uncertain:true,retryable:true,error:'تعذّر تأكيد نتيجة المحاولة. حدّث الحالة قبل الاستكمال، واستخدم الملف الأصلي نفسه.'}];
const css=fs.readdirSync('dist/assets').filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join('dist/assets',n),'utf8')).join('\n');
fs.writeFileSync('tmp/owner-pdf-ingestion-preview.html',`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>ملف الدرس الخاص — مراجعة محلية</title><style>${css}</style><body style="font-family:Tahoma,sans-serif;background:white"><main class="mx-auto max-w-4xl space-y-5 p-4"><h1 class="text-xl font-bold">رفع PDF للدرس — بيانات توضيحية</h1>${states.map(render).join('<hr style="margin:20px 0">')}</main></body></html>`);
(async()=>{const {chromium}=require('D:/EmanSchools/node_modules/playwright-core');const {pathToFileURL}=require('node:url');
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try{const page=await browser.newPage();await page.route(/^https?:/,route=>route.abort());for(const width of [390,1024]){
  await page.setViewportSize({width,height:900});await page.goto(pathToFileURL(path.resolve('tmp/owner-pdf-ingestion-preview.html')).href);await page.screenshot({path:`tmp/owner-pdf-ingestion-${width}.png`,fullPage:true});
  const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,sections:document.querySelectorAll('section').length,
    unbound:[...document.querySelectorAll('label')].filter(x=>!document.getElementById(x.htmlFor)).length}));
  if(result.overflow||result.sections!==4||result.unbound)throw Error(JSON.stringify({width,...result}));console.log(JSON.stringify({width,...result}));}
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
