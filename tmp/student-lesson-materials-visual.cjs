const Module = require('node:module'), path = require('node:path'), fs = require('node:fs');
const React = require('react'); global.React = React;
const file = require.resolve('../src/features/catalog/StudentLessonMaterials.tsx'), original = Module._load;
const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function render(state) {
  Module._load = function(name,parent,main) {
    if(name === 'react' && parent?.filename === file) return {...React,useState:()=>[state,()=>{}],useRef:()=>({current:null}),useEffect(){}};
    if(name.startsWith('@/')) return original.call(this,path.resolve('src',name.slice(2)),parent,main);
    return original.call(this,name,parent,main);
  };
  try { delete require.cache[file]; const {StudentLessonMaterialList}=require(file);
    return require('react-dom/server').renderToStaticMarkup(StudentLessonMaterialList({courseId:id(5),lessonId:id(6)}));
  } finally { Module._load=original; }
}
const rows=[{content_id:id(1),title:'ملف تدريبات الدرس ومراجعة المهارات الأساسية',material_type:'pdf',display_order:0,delivery_status:'unavailable'},
 {content_id:id(2),title:'شرح بالفيديو للمراجعة',material_type:'video',display_order:1,delivery_status:'unavailable'}];
const states=[{phase:'ready',rows,message:null},{phase:'ready',rows:[],message:null},
 {phase:'locked',rows:[],message:'الدرس لم يعد متاحًا الآن. حدّث مسار التعلّم لمعرفة السبب.'},
 {phase:'unavailable',rows:[],message:'عرض مواد الدرس غير متاح حاليًا في هذه البيئة.'}];
const css=fs.readdirSync('dist/assets').filter(x=>x.endsWith('.css')).map(x=>fs.readFileSync(path.join('dist/assets',x),'utf8')).join('\n');
fs.writeFileSync('tmp/student-lesson-materials-preview.html',`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مراجعة مواد الطالب</title><style>${css}</style><body style="font-family:Tahoma,sans-serif;background:#fff"><main class="mx-auto max-w-4xl space-y-4 p-4"><h1 class="text-xl font-bold">مواد الدرس — بيانات توضيحية</h1><p>إتمام الدرس في المسار الجديد مستقل مؤقتًا عن سجل المحتوى القديم.</p>${states.map(render).join('<hr style="margin:20px 0">')}</main></body></html>`);
(async()=>{const {chromium}=require('D:/EmanSchools/node_modules/playwright-core'); const {pathToFileURL}=require('node:url');
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try {const page=await browser.newPage();await page.route(/^https?:/,route=>route.abort());
  for(const width of [390,1024]) {await page.setViewportSize({width,height:900});await page.goto(pathToFileURL(path.resolve('tmp/student-lesson-materials-preview.html')).href);
   await page.screenshot({path:`tmp/student-lesson-materials-${width}.png`,fullPage:true});
   const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,sections:document.querySelectorAll('section').length,locators:document.querySelectorAll('a,video,iframe').length}));
   if(result.overflow||result.sections!==4||result.locators!==0)throw Error(JSON.stringify({width,...result}));console.log(JSON.stringify({width,...result}));}
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
