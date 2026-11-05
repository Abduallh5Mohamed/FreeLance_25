const { chromium } = require('D:/EmanSchools/node_modules/playwright-core');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/BaraaWael/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe'});
 try {
  const page=await browser.newPage();
  await page.route(/^https?:/,route=>route.abort());
  const checks=[];
  for(const width of [390,1024]){
   await page.setViewportSize({width,height:850});
   await page.goto(pathToFileURL(path.resolve('tmp/business-import-preview.html')).href);
   await page.screenshot({path:`tmp/business-import-${width}.png`,fullPage:true});
   const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,currentSteps:document.querySelectorAll('[aria-current="step"]').length,templateDownload:document.querySelector('a[download]')?.getAttribute('download')}));
   if(result.overflow||result.currentSteps!==1) throw new Error(JSON.stringify({width,...result}));
   await page.getByRole('link',{name:'انتقل للمطابقة'}).click();
   if(!page.url().endsWith('#student-import-matching')) throw new Error('navigation target missing');
   checks.push({width,...result,navigation:true});
  }
  const downloaded=page.waitForEvent('download');
  await page.getByRole('link',{name:'تنزيل قالب CSV فارغ'}).click();
  const file=await downloaded;
  const contents=fs.readFileSync(await file.path(),'utf8').replace(/^\uFEFF/,'');
  if(contents!=='name,email,phone,guardian_phone,grade,barcode\r\n') throw new Error('template download is not header-only');
  checks.push({actualDownload:true,filename:file.suggestedFilename(),headerOnly:true});
  console.log(JSON.stringify(checks));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
