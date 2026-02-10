const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    console.log('🔍 Verifying deployment...');
    
    const cmds = [
        // Copy new files to /var/www/alqaed/ as well (some nginx configs reference it)
        "cp -f /var/www/alqaed/dist/index.html /var/www/alqaed/index.html",
        "cp -f /var/www/alqaed/dist/favicon.ico /var/www/alqaed/favicon.ico",
        "rm -f /var/www/alqaed/assets/*.js /var/www/alqaed/assets/*.css",
        "cp -f /var/www/alqaed/dist/assets/* /var/www/alqaed/assets/",
        "systemctl reload nginx",
        
        // Verify socket.io export in backend
        "echo '=== Socket export check ==='",
        "grep -c 'getIO' /var/www/alqaed-api/dist/services/socket.js",
        "grep -c 'ioInstance' /var/www/alqaed-api/dist/services/socket.js",
        
        // Verify messages.ts has socket emit
        "echo '=== Messages socket emit check ==='",
        "grep -c 'getIO' /var/www/alqaed-api/dist/routes/messages.js",
        "grep -c 'message:new' /var/www/alqaed-api/dist/routes/messages.js",
        
        // Verify frontend has socket.io in NotificationBell 
        "echo '=== Frontend socket.io check ==='",
        "grep -c 'socket' /var/www/alqaed/dist/assets/index-*.js | head -1",
        
        // Test API
        "echo '=== API test ==='",
        "curl -s -o /dev/null -w '%{http_code}' https://elka2d.cloud/",
        "echo ''",
        "curl -s -o /dev/null -w '%{http_code}' https://elka2d.cloud/api/grades",
        "echo ''",
        
        // PM2 check
        "echo '=== PM2 ==='",
        "pm2 status | grep alqaed",
    ].join(' && ');
    
    conn.exec(cmds, (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        let out = '';
        stream.on('data', d => out += d.toString());
        stream.stderr.on('data', d => { if (!d.toString().includes('Warning')) process.stderr.write(d); });
        stream.on('close', () => { console.log(out); conn.end(); });
    });
});

conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password });
