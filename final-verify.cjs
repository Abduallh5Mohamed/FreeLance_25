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

    // Test HTTPS site loads HTML
    console.log('=== HTTPS Site Test ===');
    const siteTest = await runCmd(conn, 'curl -s -L https://elka2d.cloud/ 2>/dev/null | head -20');
    console.log(siteTest);

    // Test JS file accessible  
    console.log('\n=== JS File Test ===');
    const jsTest = await runCmd(conn, 'curl -s -o /dev/null -w "%{http_code} %{size_download}bytes" https://elka2d.cloud/assets/index-1770607555820.js 2>/dev/null');
    console.log('index.js:', jsTest);

    const cssTest = await runCmd(conn, 'curl -s -o /dev/null -w "%{http_code} %{size_download}bytes" https://elka2d.cloud/assets/index-DMMZV-P0.css 2>/dev/null');
    console.log('index.css:', cssTest);

    // Test API
    console.log('\n=== API Tests ===');
    const gradesTest = await runCmd(conn, 'curl -s https://elka2d.cloud/api/grades 2>/dev/null | head -100');
    console.log('Grades:', gradesTest.substring(0, 100));

    const groupsTest = await runCmd(conn, 'curl -s https://elka2d.cloud/api/groups 2>/dev/null | head -100');
    console.log('Groups:', groupsTest.substring(0, 100));

    // Check MinIO storage proxy
    console.log('\n=== MinIO Storage Proxy Test ===');
    const storageTest = await runCmd(conn, 'curl -s -o /dev/null -w "%{http_code}" https://elka2d.cloud/storage/videos-original/ 2>/dev/null');
    console.log('Storage proxy status:', storageTest);

    // Check for backend errors (new ones after restart)
    console.log('\n=== Backend Errors (last 3 since restart) ===');
    const errors = await runCmd(conn, 'pm2 logs alqaed-api --err --lines 3 --nostream 2>&1 | tail -5');
    console.log(errors);

    // Show uptime
    const uptime = await runCmd(conn, 'pm2 list 2>&1 | grep alqaed-api | grep -o "[0-9]*[smhD]"');
    console.log('\nPM2 uptime:', uptime.trim());

    conn.end();
    console.log('\n✅ All checks complete!');
}

main().catch(err => {
    console.error('Error:', err.message);
    conn.end();
});
