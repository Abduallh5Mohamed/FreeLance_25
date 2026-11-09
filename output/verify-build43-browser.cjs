const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
async function main(){
 const pub=JSON.parse(fs.readFileSync(path.join(__dirname,'local-demo-public.json'),'utf8'));
 const owner=JSON.parse(fs.readFileSync(path.join(pub.privateDir,'accounts.json'),'utf8')).find(x=>x.role==='instructor');
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ar-EG'});let loggedIn=false;const results=[],errors=[];
 await context.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:','about:'].includes(u.protocol)?route.continue():route.abort();});
 const page=await context.newPage();page.on('pageerror',()=>errors.push('browser-script-error'));
 try{
  await page.goto('http://localhost:8081/auth',{waitUntil:'domcontentloaded'});
  await page.locator('#academy-phone').fill(owner.phone);await page.locator('#academy-password').fill(owner.password);
  await page.getByRole('button',{name:'تسجيل الدخول',exact:true}).click();await page.waitForURL(u=>!u.pathname.startsWith('/auth'),{timeout:20000});loggedIn=true;results.push({check:'real browser form login',pass:true});
  await page.goto('http://localhost:8081/manual-grading',{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'التصحيح بالسؤال — الامتحانات ذات النسخ المثبتة',exact:true}).click();
  await page.getByRole('button',{name:'قراءة الامتحانات المخولة',exact:true}).click();
  await page.getByLabel('امتحان التصحيح بالسؤال',{exact:true}).selectOption({label:'تجربة التصحيح بالسؤال — جاهز للتجربة'});
  const versions=page.getByLabel('نسخة امتحان التصحيح',{exact:true});await versions.locator('option').nth(1).waitFor({state:'attached'});await versions.selectOption({index:1});
  const questions=page.getByLabel('سؤال التصحيح',{exact:true});await questions.locator('option').nth(1).waitFor({state:'attached'});await questions.selectOption({index:1});
  await page.getByRole('button',{name:/إجابة 1 —/}).click();
  const grade=page.getByLabel('درجة السؤال',{exact:true});await grade.fill('12abc');
  let posts=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/grading/attempts/'))posts++;});
  await page.getByRole('button',{name:'حفظ مراجعة السؤال',exact:true}).click();await page.getByText('أدخل درجة كاملة صالحة بحد أقصى منزلتين، داخل الدرجة المثبتة.').waitFor();assert.equal(posts,0);
  await grade.fill('6.00');await page.getByRole('button',{name:'حفظ مراجعة السؤال',exact:true}).click();await page.getByText('الحفظ مؤكد:',{exact:false}).waitFor();assert.equal(posts,1);
  await page.screenshot({path:path.join(__dirname,'build43-grading-browser.png'),fullPage:true});results.push({check:'anonymous pinned question UI validates malformed score and saves exactly one revision',pass:true});
  // Create a separate planning period with the existing authenticated endpoint;
  // the original academic-period UI already owns period editing.
  const created=await page.evaluate(async()=>{const response=await fetch('/api/tenants/me/academic-periods',{method:'POST',headers:{Authorization:'Bearer '+localStorage.getItem('authToken'),'Content-Type':'application/json'},body:JSON.stringify({name:'موسم تجربة الواجهة 2028',starts_on:'2028-01-01',ends_on:'2028-06-30'})});const body=await response.json();return{status:response.status,id:body.period?.id};});assert.equal(created.status,201);
  await page.goto('http://localhost:8081/courses',{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'تجهيز مقرر لموسم جديد',exact:true}).click();
  await page.getByRole('button',{name:'قراءة المواسم المتاحة',exact:true}).click();await page.getByLabel('موسم إعادة الاستخدام',{exact:true}).selectOption(created.id);
  await page.getByRole('button',{name:'قراءة المقررات المخولة',exact:true}).click();await page.getByLabel('مقرر المصدر للموسم',{exact:true}).selectOption({label:'Demo Mathematics'});
  await page.getByLabel('اسم مقرر الموسم الجديد',{exact:true}).fill('رياضيات — تجربة واجهة الموسم 2028');await page.getByRole('checkbox',{name:'أؤكد حق المؤسسة في إعادة استخدام هذه الإعدادات والوصف.'}).check();
  await page.getByRole('button',{name:'معاينة ما سيُعاد استخدامه',exact:true}).click();await page.getByRole('button',{name:'تأكيد إنشاء مسودة الموسم',exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'تأكيد إنشاء مسودة الموسم',exact:true}).click();await page.getByText('إنشاء مسودة المقرر مؤكد.',{exact:false}).waitFor();
  await page.screenshot({path:path.join(__dirname,'build43-season-browser.png'),fullPage:true});results.push({check:'actual Courses panel previews owned settings and creates a separate season draft after confirmation',pass:true});
  assert.equal(errors.length,0);const report={checked_at:new Date().toISOString(),browser:'installed Chrome headless',viewport:'1440x1050',results,pageErrors:errors.length,limits:'desktop synthetic demo only; no mobile, load, provider or production acceptance'};fs.writeFileSync(path.join(__dirname,'build43-browser-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(e){if(loggedIn&&new URL(page.url()).pathname!=='/auth')await page.screenshot({path:path.join(__dirname,'build43-browser-checkpoint.png'),fullPage:true});throw e;}
 finally{await context.close();await browser.close();}
}
main().catch(e=>{console.log(JSON.stringify({error:e.name||'BROWSER_FAILED',locations:String(e.stack).split('\n').filter(s=>s.includes('verify-build43-browser.cjs')).slice(0,2)}));process.exitCode=1;});
