/* Visual QA for the role-scoped analytics dashboard and its A4 PDF pages. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9231;
const APP = process.env.QA_APP || 'http://localhost:8081';
const API = process.env.QA_API || 'http://localhost:3001';
const PHONE = process.env.QA_ANALYST_PHONE;
const PASSWORD = process.env.QA_ANALYST_PASSWORD;
const OUT = path.join(__dirname, '.qa', 'admin-analytics');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-qa-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let sequence = 0;

function send(ws, method, params = {}, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const onMessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function main() {
  if (!PHONE || !PASSWORD) throw new Error('QA_ANALYST_PHONE and QA_ANALYST_PASSWORD are required');
  fs.mkdirSync(OUT, { recursive: true });
  const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: PHONE, password: PASSWORD }) });
  if (!login.ok) throw new Error(`Login failed: ${login.status}`);
  const auth = await login.json();
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, `--download-default-directory=${OUT}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let version;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); }
    }
    if (!version) throw new Error('Chrome did not start');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    await send(ws, 'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT });
    const { targetId } = await send(ws, 'Target.createTarget', { url: `${APP}/auth` });
    const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
    await send(ws, 'Page.enable', {}, sessionId);
    await send(ws, 'Runtime.enable', {}, sessionId);
    const evaluate = async expression => (await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    await sleep(1800);
    await evaluate(`localStorage.setItem('authToken',${JSON.stringify(auth.token)});localStorage.setItem('currentUser',${JSON.stringify(JSON.stringify(auth.user))});localStorage.setItem('sidebar_collapsed','false');location.href=${JSON.stringify(`${APP}/admin/analytics/overview`)};'ok'`);
    const views = [
      ['overview', 'النظرة التنفيذية'],
      ['charts', 'الاتجاهات والتوزيعات'],
      ['scenarios', 'السيناريوهات والحسابات'],
      ['reports', 'التقارير والتصدير'],
      ['governance', 'جودة البيانات وقاموس المؤشرات'],
    ];
    const screenshots = [];
    for (const [slug, heading] of views) {
      await evaluate(`location.href=${JSON.stringify(`${APP}/admin/analytics/${slug}`)}`);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        ready = await evaluate(`document.body.innerText.includes(${JSON.stringify(heading)}) && !document.body.innerText.includes('تعذر تحميل التقرير التحليلي')`);
        if (ready) break;
        await sleep(250);
      }
      if (!ready) {
        const diagnostic = await evaluate(`({href:location.href,title:document.title,body:document.body.innerText.slice(0,1200)})`);
        throw new Error(`Analytics page did not load: ${slug}\n${JSON.stringify(diagnostic)}`);
      }
      await sleep(700);
      const metrics = await send(ws, 'Page.getLayoutMetrics', {}, sessionId);
      const height = Math.min(6000, Math.ceil(metrics.cssContentSize.height));
      const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1440, height, scale: 1 } }, sessionId);
      const screenshotPath = path.join(OUT, `${slug}.png`);
      fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
      screenshots.push(screenshotPath);
    }

    await evaluate(`location.href=${JSON.stringify(`${APP}/admin/analytics/reports`)}`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(`document.body.innerText.includes('تقرير PDF احترافي')`)) break;
      await sleep(250);
    }

    const downloadStartedAt = Date.now();
    const clicked = await evaluate(`(() => { const button=[...document.querySelectorAll('button')].find(item=>item.textContent.includes('تقرير PDF احترافي')); if(!button)return false;button.click();return true;})()`);
    if (!clicked) throw new Error('PDF button not found');
    let pdfPath;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(500);
      const pdf = fs.readdirSync(OUT).find(name => name.endsWith('.pdf') && fs.statSync(path.join(OUT, name)).mtimeMs >= downloadStartedAt);
      if (pdf) { pdfPath = path.join(OUT, pdf); break; }
    }
    if (!pdfPath) throw new Error('PDF download did not finish');

    const pageCount = await evaluate(`document.querySelectorAll('[data-pdf-page]').length`);
    await evaluate(`(() => { const pages=[...document.querySelectorAll('[data-pdf-page]')]; const root=pages[0].parentElement;root.style.cssText='position:absolute;left:0;top:0;z-index:99999;background:white';pages.forEach((p,i)=>p.style.display=i===0?'block':'none');return true;})()`);
    for (let page = 0; page < pageCount; page += 1) {
      await evaluate(`document.querySelectorAll('[data-pdf-page]').forEach((p,i)=>p.style.display=i===${page}?'block':'none')`);
      await sleep(200);
      const image = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 794, height: 1123, scale: 1 } }, sessionId);
      fs.writeFileSync(path.join(OUT, `pdf-page-${page + 1}.png`), Buffer.from(image.data, 'base64'));
    }
    console.log(JSON.stringify({ screenshots, pdf: pdfPath, pdfPages: pageCount, pdfBytes: fs.statSync(pdfPath).size }));
    ws.close();
  } finally { chrome.kill(); }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
