const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || '';

conn.on('ready', () => {
    console.log('✅ Connected to server\n');
    
    // Check database for unread count
    const checkDB = `
        mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) \\
        -se "SELECT COALESCE((SELECT SUM(unread_count_user1) FROM conversations WHERE user1_id = '69fe1174-c98d-11f0-9d07-94e8d4b653c4'), 0) + COALESCE((SELECT SUM(unread_count_user2) FROM conversations WHERE user2_id = '69fe1174-c98d-11f0-9d07-94e8d4b653c4'), 0) as total_unread" freelance 2>/dev/null
    `;
    
    conn.exec(checkDB, (err, stream) => {
        if (err) {
            console.error('❌ Error:', err);
            conn.end();
            return;
        }
        
        let output = '';
        stream.on('data', (data) => {
            output += data.toString();
        }).on('close', () => {
            console.log('📊 Database Check Results:');
            console.log('==================================');
            console.log('Total Unread Count:', output.trim());
            console.log('==================================\n');
            
            if (parseInt(output.trim()) > 0) {
                console.log('✅ SUCCESS! Unread messages exist in database!');
                console.log('\n📱 NOW TEST IN BROWSER:');
                console.log('   1. Open: https://elka2d.cloud');
                console.log('   2. Press Ctrl+Shift+R (hard refresh)');
                console.log('   3. Login as Admin');
                console.log('   4. Look for RED badge on bell icon 🔔');
                console.log('   5. Open F12 Console and look for:');
                console.log('      "✅ NotificationBell: Unread count: {count: 5}"\n');
            } else {
                console.log('⚠️  No unread messages found!');
            }
            
            conn.end();
        });
    });
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
