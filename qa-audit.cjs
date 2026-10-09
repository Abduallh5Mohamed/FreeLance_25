/* Audit DOM of instructor session: URL, sidebar structure, layout metrics. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9223;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-qa2-'));
const APP = 'http://localhost:8081';

require(path.join(__dirname, 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, 'server', '.env') });
const jwt = require(path.join(__dirname, 'server', 'node_modules', 'jsonwebtoken'));
const mysql = require(path.join(__dirname, 'server', 'node_modules', 'mysql2', 'promise'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let wsSeq = 0;
function send(ws, method, params, sessionId) {
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
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let version;
  for (let i = 0; i < 50; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(200); }
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const { targetId } = await send(ws, 'Target.createTarget', { url: APP + '/auth' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);
  await send(ws, 'Log.enable', {}, sessionId);
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.sessionId === sessionId && msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value !== undefined ? String(a.value) : a.description || '').join(' ');
      if (text) logs.push(text.slice(0, 200));
    }
    if (msg.sessionId === sessionId && msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXC: ' + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
    }
  });
  const evalJs = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result && r.result.value;
  };
  await sleep(3000);

  const user = await (async () => {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || process.env.DB_DATABASE,
    });
    const [rows] = await conn.query(`SELECT id, email, phone, name, role, is_active FROM users WHERE role='instructor' AND is_active=1 LIMIT 1`);
    await conn.end();
    return rows[0];
  })();
  const token = jwt.sign({ id: user.id, email: user.email || null, phone: user.phone || null, role: user.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
  await evalJs(`localStorage.setItem('authToken', ${JSON.stringify(token)}); localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify(user))}); localStorage.setItem('sidebar_collapsed','false'); 'ok'`);

  const route = process.argv[2] || '/teacher';
  await evalJs(`localStorage.setItem('authToken', ${JSON.stringify(token)}); localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify(user))}); 'ok'`);
  await send(ws, 'Page.navigate', { url: APP + route }, sessionId);
  await sleep(6000);

  const audit = await evalJs(`(() => {
    const raw = localStorage.getItem('currentUser');
    let parsed = null, parseErr = null;
    try { parsed = JSON.parse(raw); } catch (e) { parseErr = String(e); }
    const out = { url: location.pathname, title: document.title, rawLen: raw ? raw.length : 0, role: parsed ? parsed.role : null, name: parsed ? parsed.name : null, parseErr, bodyText: document.body.innerText.slice(0, 200) };
    const aside = document.querySelector('aside');
    out.asideFound = !!aside;
    if (aside) {
      out.asideWidth = aside.getBoundingClientRect().width;
      out.asideScrollH = aside.scrollHeight;
      out.asideClientH = aside.clientHeight;
      const links = [...aside.querySelectorAll('a')];
      out.links = links.map(a => {
        const r = a.getBoundingClientRect();
        return { text: a.innerText.trim().slice(0, 40), href: a.getAttribute('href'), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top) };
      });
      const headers = [...aside.querySelectorAll('button')].map(b => ({ text: b.innerText.trim().slice(0, 40), y: Math.round(b.getBoundingClientRect().top) }));
      out.headers = headers;
    }
    return out;
  })()`);
  console.log(JSON.stringify({ audit, logs: logs.slice(0, 60) }, null, 1));
  chrome.kill();
  process.exit(0);
}
main().catch((e) => { console.error('AUDIT ERROR:', e.message); process.exit(1); });
