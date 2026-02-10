const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || '';

conn.on('ready', () => {
    console.log('🔍 Final Notification System Verification');
    console.log('==========================================\n');
    
    // Step 1: Check database
    const step1 = `
        DB_PASS=$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2)
        echo "1️⃣ Database Unread Count:"
        mysql -u root -p"$DB_PASS" -se "
            SELECT COALESCE((SELECT SUM(unread_count_user1) FROM conversations WHERE user1_id = '69fe1174-c98d-11f0-9d07-94e8d4b653c4'), 0) + COALESCE((SELECT SUM(unread_count_user2) FROM conversations WHERE user2_id = '69fe1174-c98d-11f0-9d07-94e8d4b653c4'), 0) as total_unread
        " freelance 2>/dev/null
        echo ""
    `;
    
    conn.exec(step1, (err, stream) => {
        if (err) {
            console.error('❌ Error:', err);
            conn.end();
            return;
        }
        
        let output = '';
        stream.on('data', (data) => {
            output += data.toString();
        }).on('close', () => {
            console.log(output);
            
            // Step 2: Check backend is running
            const step2 = `
                echo "2️⃣ Backend Status:"
                pm2 list | grep alqaed-api
                echo ""
                echo "3️⃣ Recent API Logs (last 10 lines):"
                pm2 logs alqaed-api --lines 10 --nostream | grep -E "unread|📬" | tail -5
                echo ""
            `;
            
            conn.exec(step2, (err2, stream2) => {
                if (err2) {
                    console.error('❌ Error:', err2);
                    conn.end();
                    return;
                }
                
                let output2 = '';
                stream2.on('data', (data) => {
                    output2 += data.toString();
                }).on('close', () => {
                    console.log(output2);
                    
                    console.log('==========================================');
                    console.log('✅ Server-side verification COMPLETE!\n');
                    console.log('📱 NOW TEST IN BROWSER:');
                    console.log('==========================================');
                    console.log('1. Open: https://elka2d.cloud');
                    console.log('2. Clear browser cache: Ctrl+Shift+R');
                    console.log('3. Login as Admin');
                    console.log('4. Check notification bell 🔔');
                    console.log('');
                    console.log('✅ EXPECTED RESULT:');
                    console.log('   • RED badge with number "5"');
                    console.log('   • Badge should be visible and pulsing');
                    console.log('');
                    console.log('🔍 DEBUG in Browser Console (F12):');
                    console.log('   Look for these logs:');
                    console.log('   • "📋 Current build version: 1770306843770"');
                    console.log('   • "📡 NotificationBell: Fetching unread count"');
                    console.log('   • "✅ NotificationBell: Unread count: {count: 5}"');
                    console.log('');
                    console.log('❌ IF NOT WORKING:');
                    console.log('   1. Try Incognito/Private window');
                    console.log('   2. Clear all site data in DevTools');
                    console.log('   3. Take screenshot of Console and share');
                    console.log('==========================================\n');
                    
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
