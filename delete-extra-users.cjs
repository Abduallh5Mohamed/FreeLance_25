const { Client } = require('ssh2');
const password = 'NewSecureP@ssw0rd2025!';
const ADMIN_ID = '69fe1174-c98d-11f0-9d07-94e8d4b653c4';

const usersToDelete = [
    '8609eff9-c30e-48f5-9462-6c4ea70c0e98',
    '9b955922-4bca-4568-8683-a4cfb27e3a6e',
    '0248d4c9-01b3-4d7f-bf4b-7744bdf6a005',
    '05bd3d9c-fd00-400d-9d0c-8c18c3e7bfb8'
];

const conn = new Client();

conn.on('ready', () => {
    console.log('🗑️ Deleting extra users...\n');
    
    const deleteSQL = usersToDelete.map(id => `DELETE FROM users WHERE id='${id}';`).join(' ');
    
    const sql = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SET FOREIGN_KEY_CHECKS=0; ${deleteSQL} SET FOREIGN_KEY_CHECKS=1; SELECT '✅ Users deleted'; SELECT id,name,phone,role FROM users;" 2>/dev/null`;
    
    conn.exec(sql, (err, stream) => {
        stream.on('data', (data) => {
            console.log(data.toString());
        }).on('close', () => {
            console.log('\n✅ Cleanup complete!');
            console.log('🎯 Only Admin user remains!\n');
            conn.end();
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
