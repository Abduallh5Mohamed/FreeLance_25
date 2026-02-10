const { Client } = require('ssh2');
const password = 'NewSecureP@ssw0rd2025!';

const conn = new Client();

conn.on('ready', () => {
    const sql = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SELECT id, name, phone, role FROM users ORDER BY created_at;" 2>/dev/null`;
    
    conn.exec(sql, (err, stream) => {
        console.log('👥 Current Users in Database:\n');
        stream.on('data', (data) => {
            console.log(data.toString());
        }).on('close', () => {
            conn.end();
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
