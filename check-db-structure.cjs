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

    // Check DB password from .env
    const dbPass = await runCmd(conn, 'grep DB_PASSWORD /var/www/alqaed-api/.env 2>/dev/null');
    console.log('DB Config:', dbPass.trim());

    // Check students table structure with correct credentials
    const dbPassValue = dbPass.trim().split('=')[1] || '';
    const mysqlCmd = dbPassValue 
        ? `mysql -u root -p'${dbPassValue}' freelance -e "DESCRIBE students;" 2>&1`
        : `mysql -u root freelance -e "DESCRIBE students;" 2>&1`;
    
    console.log('\n=== Students Table Structure ===');
    const result = await runCmd(conn, mysqlCmd);
    console.log(result);

    // Check if guardian_phone or parent_phone column exists
    console.log('\n=== Phone Columns ===');
    const phoneColumns = await runCmd(conn, 
        dbPassValue 
            ? `mysql -u root -p'${dbPassValue}' freelance -e "SHOW COLUMNS FROM students WHERE Field LIKE '%phone%';" 2>&1`
            : `mysql -u root freelance -e "SHOW COLUMNS FROM students WHERE Field LIKE '%phone%';" 2>&1`
    );
    console.log(phoneColumns);

    // Check conversations table for unread count columns
    console.log('\n=== Conversations Table ===');
    const convColumns = await runCmd(conn,
        dbPassValue
            ? `mysql -u root -p'${dbPassValue}' freelance -e "DESCRIBE conversations;" 2>&1`
            : `mysql -u root freelance -e "DESCRIBE conversations;" 2>&1`
    );
    console.log(convColumns);

    conn.end();
}

main().catch(err => {
    console.error('Error:', err.message);
    conn.end();
});
