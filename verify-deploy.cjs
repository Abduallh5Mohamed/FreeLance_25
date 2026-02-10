const { Client } = require('ssh2');

const PASSWORD = process.argv[2] || 'NewSecureP@ssw0rd2025!';
const HOST = '72.62.35.177';

function runSSHCommand(cmd) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec(cmd, (err, stream) => {
                if (err) { conn.end(); return reject(err); }
                let output = '';
                stream.on('close', () => { conn.end(); resolve(output); });
                stream.on('data', (data) => { output += data.toString(); });
                stream.stderr.on('data', (data) => { output += data.toString(); });
            });
        });
        conn.on('error', reject);
        conn.connect({ host: HOST, port: 22, username: 'root', password: PASSWORD });
    });
}

async function verify() {
    console.log('🔍 === VERIFICATION ===\n');

    // 1. Check frontend files
    console.log('=== Frontend Files ===');
    let result = await runSSHCommand('ls -la /var/www/alqaed/assets/*.js /var/www/alqaed/assets/*.css 2>/dev/null');
    console.log(result);

    // 2. Check index.html has correct files
    console.log('\n=== Index.html References ===');
    result = await runSSHCommand('grep -o "index-[0-9]*.js\\|index-[0-9]*.css\\|index\\.es-[0-9]*.js" /var/www/alqaed/index.html');
    console.log(result);

    // 3. Check backend messages.ts fix (verify unread_count_user1 logic exists)
    console.log('\n=== Backend Fix Verification ===');
    result = await runSSHCommand('grep -c "unread_count_user1" /var/www/alqaed-api/dist/routes/messages.js');
    console.log('messages.js contains unread_count_user1:', result.trim(), 'occurrences');

    result = await runSSHCommand('grep -c "guardian_phone" /var/www/alqaed-api/dist/routes/registration-requests.js');
    console.log('registration-requests.js contains guardian_phone:', result.trim(), 'occurrences');

    result = await runSSHCommand('grep -c "parent_phone" /var/www/alqaed-api/dist/routes/registration-requests.js');
    console.log('registration-requests.js contains parent_phone:', result.trim(), 'occurrences (should be 0)');

    // 4. Check student_courses FK fix
    result = await runSSHCommand('grep "userId, courseId" /var/www/alqaed-api/dist/routes/registration-requests.js');
    console.log('\nstudent_courses FK fix:', result.length > 0 ? '✅ Uses userId' : '⚠️ Check manually');

    // 5. Check PM2 is healthy
    console.log('\n=== PM2 Health ===');
    result = await runSSHCommand('pm2 list 2>&1 | grep alqaed');
    console.log(result);

    // 6. Check PM2 recent logs for errors after restart
    console.log('\n=== Recent Errors (after restart) ===');
    result = await runSSHCommand('pm2 logs alqaed-api --err --lines 5 --nostream 2>&1');
    console.log(result);

    // 7. Test API endpoint
    console.log('\n=== API Test ===');
    result = await runSSHCommand('curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/grades 2>/dev/null');
    console.log('API /api/grades status:', result);

    result = await runSSHCommand('curl -s -o /dev/null -w "%{http_code}" https://elka2d.cloud/ 2>/dev/null');
    console.log('HTTPS frontend status:', result);

    // 8. Check database guardian_phone column
    console.log('\n=== Database Check ===');
    result = await runSSHCommand('mysql -u root freelance -e "SHOW COLUMNS FROM students LIKE \'%phone%\';" 2>/dev/null');
    console.log('Students phone columns:', result);

    console.log('\n🎉 Verification complete!');
}

verify().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
