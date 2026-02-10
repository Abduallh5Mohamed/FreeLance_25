const { Client } = require('ssh2');
const conn = new Client();
const PASSWORD = process.argv[2] || 'NewSecureP@ssw0rd2025!';

function runCmd(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let out = '';
            stream.on('close', () => resolve(out));
            stream.on('data', (d) => { out += d.toString(); });
            stream.stderr.on('data', (d) => { out += d.toString(); });
        });
    });
}

async function main() {
    await new Promise((resolve, reject) => {
        conn.on('ready', resolve);
        conn.on('error', reject);
        conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password: PASSWORD });
    });

    // 1. Check nginx root directive
    console.log('=== Nginx Root ===');
    let result = await runCmd(conn, 'grep -n "root " /etc/nginx/sites-enabled/* 2>/dev/null | head -10');
    console.log(result);

    // 2. List files in both possible locations
    console.log('=== Files in /var/www/alqaed/ ===');
    result = await runCmd(conn, 'ls -la /var/www/alqaed/ 2>/dev/null | head -10');
    console.log(result);

    console.log('=== Files in /var/www/alqaed/assets/ ===');
    result = await runCmd(conn, 'ls -la /var/www/alqaed/assets/*.js 2>/dev/null | head -10');
    console.log(result);

    console.log('=== Files in /var/www/alqaed/dist/ ===');
    result = await runCmd(conn, 'ls -la /var/www/alqaed/dist/ 2>/dev/null | head -5');
    console.log(result);

    console.log('=== Files in /var/www/alqaed/dist/assets/ ===');
    result = await runCmd(conn, 'ls -la /var/www/alqaed/dist/assets/*.js 2>/dev/null | head -5');
    console.log(result);

    // 3. Test local curl
    console.log('=== Local Curl Test ===');
    result = await runCmd(conn, 'curl -s -o /dev/null -w "%{http_code}" http://localhost/assets/index-1770607555820.js 2>/dev/null');
    console.log('HTTP localhost:', result);
    
    result = await runCmd(conn, 'curl -s -o /dev/null -w "%{http_code}" http://72.62.35.177/assets/index-1770607555820.js 2>/dev/null');
    console.log('HTTP IP:', result);

    // 4. Check index.html content
    console.log('\n=== Index.html location ===');
    result = await runCmd(conn, 'head -3 /var/www/alqaed/index.html 2>/dev/null && echo "---at /var/www/alqaed/"');
    console.log(result);
    result = await runCmd(conn, 'head -3 /var/www/alqaed/dist/index.html 2>/dev/null && echo "---at /var/www/alqaed/dist/"');
    console.log(result);

    conn.end();
}

main().catch(err => { console.error('Error:', err.message); conn.end(); });
