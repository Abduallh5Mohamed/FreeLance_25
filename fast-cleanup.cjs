const { Client } = require('ssh2');
const password = 'NewSecureP@ssw0rd2025!';
const ADMIN_ID = '69fe1174-c98d-11f0-9d07-94e8d4b653c4';

const conn = new Client();

conn.on('ready', () => {
    console.log('🗑️ Deleting all users except Admin...\n');
    
    const sql = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM students; DELETE FROM teachers WHERE user_id!='${ADMIN_ID}'; DELETE FROM users WHERE id!='${ADMIN_ID}'; SET FOREIGN_KEY_CHECKS=1; SELECT CONCAT('✅ Users: ', COUNT(*)) FROM users; SELECT CONCAT('✅ Students: ', COUNT(*)) FROM students; SELECT name,phone,role FROM users;" 2>/dev/null`;
    
    conn.exec(sql, (err, stream) => {
        stream.on('data', (data) => {
            console.log(data.toString().trim());
        }).on('close', () => {
            console.log('\n✅ Done!\n');
            
            // Now clean all other tables
            console.log('🗑️ Cleaning remaining tables...\n');
            
            const cleanAll = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SET FOREIGN_KEY_CHECKS=0; TRUNCATE messages; TRUNCATE conversations; TRUNCATE exams; TRUNCATE lectures; TRUNCATE courses; TRUNCATE subscriptions; TRUNCATE payments; TRUNCATE attendance; SET FOREIGN_KEY_CHECKS=1; SELECT '✅ All tables cleaned!'" 2>/dev/null`;
            
            conn.exec(cleanAll, (err2, stream2) => {
                stream2.on('data', (data) => {
                    console.log(data.toString().trim());
                }).on('close', () => {
                    console.log('\n🎯 Database is now clean!');
                    conn.end();
                });
            });
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
