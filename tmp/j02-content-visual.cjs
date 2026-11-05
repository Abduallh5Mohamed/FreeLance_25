const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const React = require('react');
global.React = React;
const file = require.resolve('../src/features/catalog/LessonContentManager.tsx');
const original = Module._load;
const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = { phase: 'ready', busy: false, stale: false, error: null, optionsError: null, notice: null,
  contents: [{ content_id: id(10), material_id: id(1), title: 'ملف شرح أساسيات الدرس وأسئلة التدريب للطلاب', material_type: 'pdf', display_order: 0 }],
  options: [{ material_id: id(2), title: 'تدريبات إضافية للمراجعة', material_type: 'presentation', is_published: false }], nextCursor: id(25) };
function render(snapshot, removeId = null) {
  let cursor = 0;
  const values = [snapshot, id(2), '1', removeId];
  Module._load = function(name, parent, main) {
    if (name === 'react' && parent?.filename === file) return { ...React, useState: () => [values[cursor++], () => {}], useEffect() {}, useRef: () => ({current:null}), useId: () => `visual-${snapshot.phase}-${snapshot.stale}` };
    if(name.startsWith('@/')) return original.call(this, path.resolve('src',name.slice(2)), parent, main);
    return original.call(this, name, parent, main);
  };
  try {
    delete require.cache[file];
    const { LessonContentEditor } = require(file);
    return require('react-dom/server').renderToStaticMarkup(LessonContentEditor({courseId:id(5),unitId:id(6),lessonId:id(7)}));
  } finally { Module._load = original; }
}
const css = fs.readdirSync('dist/assets').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('dist/assets', name), 'utf8')).join('\n');
const body = [render(base,id(10)), render({...base, stale:true, notice:'تم تأكيد ربط المادة بالدرس.',error:'تم تأكيد الحفظ، لكن تعذّر تحديث القائمة. القائمة المعروضة قديمة؛ حدّثها قبل تعديل آخر.'}),render({...base,phase:'unavailable',contents:[],options:[],error:'إدارة محتويات الدرس غير متاحة حاليًا في هذه البيئة.'})].join('<hr style="margin:24px 0">');
fs.writeFileSync('tmp/j02-content-preview.html', `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مواد الدرس — مراجعة محلية</title><style>${css}</style><body style="font-family:Tahoma,sans-serif;background:white"><main class="mx-auto max-w-4xl space-y-4 p-4"><h1 class="text-xl font-bold">تجهيز مواد الدرس — بيانات توضيحية</h1>${body}</main></body></html>`);
(async () => {
  const { chromium } = require('D:/EmanSchools/node_modules/playwright-core');
  const { pathToFileURL } = require('node:url');
  const browser = await chromium.launch({headless:true, executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
  try {
    const page = await browser.newPage(); await page.route(/^https?:/, route => route.abort());
    for(const width of [390,1024]) {
      await page.setViewportSize({width,height:900}); await page.goto(pathToFileURL(path.resolve('tmp/j02-content-preview.html')).href);
      await page.screenshot({path:`tmp/j02-content-${width}.png`,fullPage:true});
      const result = await page.evaluate(() => ({overflow:document.documentElement.scrollWidth > innerWidth,
        unboundLabels:[...document.querySelectorAll('label')].filter(label => !document.getElementById(label.htmlFor)).length,
        sections:document.querySelectorAll('section[aria-label="مواد الدرس"]').length}));
      if(result.overflow || result.unboundLabels || result.sections !== 3) throw Error(JSON.stringify({width,...result}));
      console.log(JSON.stringify({width,...result}));
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
