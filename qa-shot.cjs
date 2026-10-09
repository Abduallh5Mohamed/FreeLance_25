/* QA harness: headless Chrome + CDP. Logs in as the instructor user and screenshots pages. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9222;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-qa-'));
const OUT = path.join(__dirname, '.qa');
const APP = 'http://localhost:8081';

// ---- Mint a real JWT like server/src/routes/auth.ts does ----
require(path.join(__dirname, 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, 'server', '.env') });
const jwt = require(path.join(__dirname, 'server', 'node_modules', 'jsonwebtoken'));
const mysql = require(path.join(__dirname, 'server', 'node_modules', 'mysql2', 'promise'));

async function getUser() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || process.env.DB_DATABASE,
  });
  const [rows] = await conn.query(`SELECT id, email, phone, name, role, is_active, email_verified, phone_verified, created_at, updated_at FROM users WHERE role='instructor' AND is_active=1 LIMIT 1`);
  await conn.end();
  if (!rows.length) throw new Error('No instructor user found');
  return rows[0];
}

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
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for devtools endpoint
  let version;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      version = await res.json();
      break;
    } catch { await sleep(200); }
  }
  if (!version) throw new Error('Chrome CDP did not start');

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  // Create a tab
  const { targetId } = await send(ws, 'Target.createTarget', { url: APP + '/auth' });
  const { sessionId } = await send(ws, 'Target.attachToTarget', { targetId, flatten: true });
  await send(ws, 'Page.enable', {}, sessionId);
  await send(ws, 'Runtime.enable', {}, sessionId);

  const evalJs = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result && r.result.value;
  };

  // 1) Wait for the /auth page (origin loaded so localStorage is writable)
  await sleep(2500);

  // 2) Fetch instructor + sign token
  const user = await getUser();
  const secret = process.env.JWT_SECRET || 'secret';
  const token = jwt.sign(
    { id: user.id, email: user.email || null, phone: user.phone || null, role: user.role },
    secret,
    { expiresIn: '7d' }
  );

  const stored = JSON.parse(JSON.stringify(user));
  await evalJs(`localStorage.setItem('authToken', ${JSON.stringify(token)}); localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify(stored))}); localStorage.setItem('sidebar_collapsed','false'); 'ok'`);

  // 3) Navigate & screenshot each route
  const routes = process.argv.slice(2);
  for (const route of routes) {
    await evalJs(`location.href = ${JSON.stringify(APP + route)}; 'nav'`);
    await sleep(4500);
    const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    const name = route.replace(/[^a-z0-9]+/gi, '-') || 'home';
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
    console.log('saved .qa/' + name + '.png');
  }

  chrome.kill();
  process.exit(0);
}

main().catch((e) => { console.error('QA ERROR:', e.message); process.exit(1); });
