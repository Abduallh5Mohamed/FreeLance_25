const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
async function main(){
 const pub=JSON.parse(fs.readFileSync(path.join(__dirname,'local-demo-public.json'),'utf8'));
 const accounts=JSON.parse(fs.readFileSync(path.join(pub.privateDir,'accounts.json'),'utf8'));
 const f=JSON.parse(fs.readFileSync(path.join(__dirname,'build45-lesson-fixtures.json'),'utf8'));
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const results=process.env.BUILD45_STUDENT_ONLY&&fs.existsSync(path.join(__dirname,'build45-browser-owner.json'))?JSON.parse(fs.readFileSync(path.join(__dirname,'build45-browser-owner.json'),'utf8')):[];let page;
 async function session(account){const context=await browser.newContext({viewport:{width:1440,height:1100}});await context.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());const p=await context.newPage();await p.goto('http://localhost:8081/auth');await p.locator('#academy-phone').fill(account.phone);await p.locator('#academy-password').fill(account.password);const response=p.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');await p.getByRole('button',{name:'تسجيل الدخول',exact:true}).click();assert.equal((await response).status(),200);await p.waitForURL(u=>!u.pathname.includes('/auth'));return{context,p};}
 async function openCourse(p){await p.goto('http://localhost:8081/courses');const card=p.locator('[class*="shadow-soft"]').filter({has:p.getByText('رحلة الموسم 2029 — تجربة الحصة',{exact:true})});await card.getByRole('button',{name:'عرض التفاصيل',exact:true}).click();}
 try{
  if(!process.env.BUILD45_STUDENT_ONLY){const {context,p}=await session(accounts.find(x=>x.role==='instructor'));page=p;await openCourse(p);
  await p.getByRole('button',{name:'تطبيق على حصة',exact:true}).click();
  await p.getByLabel('الوحدة المصدر').first().selectOption(f.unit);
  await p.getByLabel('الحصة المصدر في الوحدة').first().selectOption(f.browserLesson);
  await p.getByRole('button',{name:'استخدام هذه الحصة كوجهة',exact:true}).click();
  await p.getByLabel('القالب').first().selectOption(f.template);await p.getByLabel('المراجعة').first().selectOption('1');
  await p.getByRole('button',{name:'مراجعة التطبيق والتوقيت',exact:true}).click();
  await p.getByRole('checkbox',{name:'أؤكد مراجعة هذه القائمة والتوقيت',exact:true}).check();
  let posts=0;await context.route('**/*lesson-template-apply',async route=>{posts++;const r=await route.fetch();assert.equal(r.status(),201);await route.abort('connectionfailed');});
  await p.getByRole('button',{name:'تأكيد التطبيق والتوقيت',exact:true}).click();
  await p.getByRole('button',{name:'التحقق من نتيجة العملية دون إعادة الحفظ',exact:true}).waitFor();
  assert.equal(await p.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tabweb.template-application.v1.')).length),1);
  p.on('dialog',d=>d.accept());await openCourse(p);
  await p.getByRole('button',{name:'التحقق من نتيجة العملية دون إعادة الحفظ',exact:true}).click();
  await p.getByText('تم حفظ العملية بأمان:',{exact:false}).waitFor();assert.equal(posts,1);
  assert.equal(await p.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('tabweb.template-application.v1.')).length),0);
  await p.getByText('تم حفظ العملية بأمان:',{exact:false}).scrollIntoViewIfNeeded();
  await p.screenshot({path:path.join(__dirname,'build45-application-recovery-browser.png'),fullPage:true});results.push({check:'Chrome committed POST lost response, reload restored marker, GET receipt only, no duplicate POST',pass:true});
  fs.writeFileSync(path.join(__dirname,'build45-browser-owner.json'),JSON.stringify(results));await context.close();}
  const student=await session(accounts.find(x=>x.key==='season-student'));page=student.p;
  page.on('response',r=>{if(r.url().includes('/api/student-enrollment/'))console.log(JSON.stringify({path:new URL(r.url()).pathname,status:r.status()}));});
  await page.getByRole('button',{name:'الدخول للمساحة',exact:true}).click();await page.waitForURL(u=>u.pathname==='/student');
  await page.goto('http://localhost:8081/student-content');await page.getByRole('button',{name:'رحلة الموسم 2029 — تجربة الحصة',exact:true}).click();
  await page.getByText('حصة تحقق التطبيق',{exact:true}).waitFor();
  await page.locator('li').filter({has:page.getByText('حصة تحقق التطبيق',{exact:true})}).getByRole('button',{name:'عرض مواد الدرس',exact:true}).click();
  await page.getByText('مرجع حصة الموسم — التسليم غير مفعّل',{exact:true}).first().waitFor();
  const lesson=page.locator('li').filter({has:page.getByText('حصة تحقق التطبيق',{exact:true})});
  await lesson.getByText('فتح هذه المادة غير متاح حاليًا.',{exact:true}).waitFor();
  assert.equal(await lesson.getByRole('button',{name:'تنزيل PDF',exact:true}).count(),0);
  await page.screenshot({path:path.join(__dirname,'build45-student-browser.png'),fullPage:true});results.push({check:'Chrome new synthetic learner selects authorized space and opens actual lesson metadata; unavailable file has no PDF download action',pass:true});
  fs.writeFileSync(path.join(__dirname,'build45-browser-results.json'),JSON.stringify({browser:await browser.version(),viewport:'1440x1100',results,limits:'Synthetic localhost; metadata only, no provider/file delivery or mobile/load acceptance.'},null,2));console.log(JSON.stringify({passed:results.length}));
 }catch(e){if(page){await page.screenshot({path:path.join(__dirname,'build45-browser-checkpoint.png'),fullPage:true}).catch(()=>{});console.error('Checkpoint:',(await page.locator('body').innerText()).slice(-9000));}throw e;}finally{await browser.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
