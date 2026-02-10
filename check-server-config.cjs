const { Client } = require('ssh2');

const conn = new Client();
const host = '72.62.35.177';
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

function runCommand(conn, cmd) {
    return new Promise((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
            if (err) return reject(err);
            let output = '';
            let errorOutput = '';
            stream.on('close', () => resolve(output + errorOutput));
            stream.on('data', (data) => { output += data.toString(); });
            stream.stderr.on('data', (data) => { errorOutput += data.toString(); });
        });
    });
}

async function main() {
    await new Promise((resolve, reject) => {
        conn.on('ready', resolve);
        conn.on('error', reject);
        conn.connect({ host, port: 22, username: 'root', password });
    });

    console.log('✅ Connected to server\n');

    // 1. Check nginx config
    console.log('=== NGINX CONFIG ===');
    const nginxConfig = await runCommand(conn, 'cat /etc/nginx/sites-enabled/* 2>/dev/null || cat /etc/nginx/conf.d/*.conf 2>/dev/null');
    console.log(nginxConfig);

    // 2. Check if MinIO is running
    console.log('\n=== MINIO STATUS ===');
    const minioStatus = await runCommand(conn, 'systemctl status minio 2>/dev/null | head -20; echo "---"; ps aux | grep minio | grep -v grep; echo "---"; curl -s -o /dev/null -w "%{http_code}" http://localhost:9000/minio/health/live 2>/dev/null || echo "MinIO not responding"');
    console.log(minioStatus);

    // 3. Check backend .env
    console.log('\n=== BACKEND ENV (MinIO related) ===');
    const envFile = await runCommand(conn, 'grep -E "MINIO|STORAGE|BUCKET" /var/www/alqaed-api/.env 2>/dev/null || echo "No .env found"');
    console.log(envFile);

    // 4. Check PM2 status
    console.log('\n=== PM2 STATUS ===');
    const pm2Status = await runCommand(conn, 'pm2 list 2>/dev/null || echo "PM2 not running"');
    console.log(pm2Status);

    // 5. Check PM2 logs for errors
    console.log('\n=== RECENT BACKEND ERRORS ===');
    const pm2Errors = await runCommand(conn, 'pm2 logs alqaed-api --err --lines 20 --nostream 2>/dev/null || echo "No logs"');
    console.log(pm2Errors);

    // 6. Check database tables
    console.log('\n=== DATABASE TABLES ===');
    const tables = await runCommand(conn, 'mysql -u root -e "USE freelance; SHOW TABLES;" 2>/dev/null | head -50');
    console.log(tables);

    // 7. Check if guardian_phone column exists in students table
    console.log('\n=== STUDENTS TABLE STRUCTURE ===');
    const studentsTable = await runCommand(conn, 'mysql -u root -e "USE freelance; DESCRIBE students;" 2>/dev/null');
    console.log(studentsTable);

    // 8. Check groups table
    console.log('\n=== GROUPS TABLE ===');
    const groupsTable = await runCommand(conn, 'mysql -u root -e "USE freelance; SELECT * FROM \\`groups\\`;" 2>/dev/null');
    console.log(groupsTable);

    conn.end();
    console.log('\n✅ Check complete');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    conn.end();
    process.exit(1);
});
