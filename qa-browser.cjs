/* QA browser: per-page WebSocket (classic CDP). Logs in as a throwaway instructor
   user (created on demand with known credentials) and screenshots/audits pages. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-qa3-'));
const OUT = path.join(__dirname, '.qa');
const APP = 'http://localhost:8081';

require(path.join(__dirname, 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, 'server', '.env') });
const bcrypt = require(path.join(__dirname, 'server', 'node_modules', 'bcryptjs'));
const mysql = require(path.join(__dirname, 'server', 'node_modules', 'mysql2', 'promise'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsSeq = 0;

function send(ws, method, params) {
  const id = ++wsSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return ws;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); ready = true; break; }
    catch { await sleep(200); }
  }
  if (!ready) throw new Error('Chrome CDP did not start');

  // --- Ensure throwaway QA instructor exists, sign real JWT (same as auth.ts) ---
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE,
  });
  const QA_PHONE = '0100000QA1';
  const [existing] = await conn.query(`SELECT id FROM users WHERE phone = ?`, [QA_PHONE]);
  let userId;
  if (existing.length) {
    userId = existing[0].id;
    await conn.query(`UPDATE users SET is_active = 1 WHERE id = ?`, [userId]);
  } else {
    const hash = bcrypt.hashSync('Qa123456', 10);
    const [ins] = await conn.query(
      `INSERT INTO users (id, email, phone, name, role, password_hash, is_active) VALUES (UUID(), ?, ?, ?, 'instructor', ?, 1)`,
      ['qa-instructor@test.local', QA_PHONE, 'مدرس تجريبي QA', hash]
    );
    userId = ins[0];
  }
  await conn.end();
  const jwt = require(path.join(__dirname, 'server', 'node_modules', 'jsonwebtoken'));
  const token = jwt.sign(
    { id: userId, email: 'qa-instructor@test.local', phone: QA_PHONE, role: 'instructor' },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: '7d' }
  );
  const userObj = { id: userId, email: 'qa-instructor@test.local', phone: QA_PHONE, name: 'مدرس تجريبي QA', role: 'instructor', is_active: 1 };

  const route = process.argv[2] || 'teacher';
  if (route.includes('Program Files/Git')) { console.log('bad route'); process.exit(1); }
  const fullRoute = route.startsWith('/') ? route : '/' + route;
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP + '/auth')}`, { method: 'PUT' })).json();
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await sleep(2000);

  // Inject session then hard-navigate to the route
  await send(ws, 'Runtime.evaluate', {
    expression: `localStorage.setItem('authToken', ${JSON.stringify(token)}); localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify(userObj))}); localStorage.setItem('sidebar_collapsed','false'); 'ok'`,
    returnByValue: true,
  });
  await send(ws, 'Runtime.evaluate', { expression: `location.href = ${JSON.stringify(APP + fullRoute)}; 'nav'`, returnByValue: true });
  await sleep(5000);

  const urlNow = (await send(ws, 'Runtime.evaluate', { expression: 'location.pathname', returnByValue: true })).result.value;
  console.log('final url:', urlNow);

  const viewport = (await send(ws, 'Runtime.evaluate', { expression: '({w: innerWidth, h: innerHeight})', returnByValue: true })).result.value;
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, viewport.w - 320), y: 0, width: 320, height: viewport.h, scale: 1 } });
  const fname = '.qa/live-' + fullRoute.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.png';
  fs.writeFileSync(path.join(__dirname, fname), Buffer.from(shot.data, 'base64'));

  const audit = await send(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const out = { url: location.pathname };
      const aside = document.querySelector('aside');
      out.asideFound = !!aside;
      if (aside) {
        const links = [...aside.querySelectorAll('a')];
        out.links = links.map(a => {
          const r = a.getBoundingClientRect();
          return { text: (a.innerText || '').trim().slice(0, 45), href: a.getAttribute('href'), y: Math.round(r.top) };
        });
        out.groupBtns = [...aside.querySelectorAll('button')].map(b => ({ text: (b.innerText || '').trim().slice(0, 45), y: Math.round(b.getBoundingClientRect().top) }));
        out.scrollH = aside.scrollHeight; out.clientH = aside.clientHeight;
        const a = aside.getBoundingClientRect();
        out.asideRect = { w: Math.round(a.width), h: Math.round(a.height) };
      }
      return out;
    })()`,
    returnByValue: true,
  });
  if (audit.exceptionDetails) console.log('AUDIT EXC:', JSON.stringify(audit.exceptionDetails).slice(0, 300));
  console.log('saved', fname);
  console.log(JSON.stringify(audit.result.value, null, 1));
  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error('QA ERROR:', e.message); process.exit(1); });
