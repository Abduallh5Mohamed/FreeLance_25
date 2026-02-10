const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    console.log('Connected...');
    
    const cmds = [
        // Check if there are any JS errors in the build
        "echo '=== Check index.html ==='",
        "head -5 /var/www/alqaed/dist/index.html",
        
        // Check PM2 logs for errors after restart
        "echo '=== PM2 Recent Errors ==='",
        "pm2 logs alqaed-api --err --lines 20 --nostream 2>&1 | tail -25",
        
        // Check PM2 output logs
        "echo '=== PM2 Recent Output ==='",
        "pm2 logs alqaed-api --out --lines 20 --nostream 2>&1 | tail -25",
        
        // Test messages API
        "echo '=== Test Messages API ==='",
        "curl -s -o /dev/null -w '%{http_code}' https://elka2d.cloud/api/messages/conversations",
        "echo ''",
        
        // Test the page loads
        "echo '=== Test Page Load ==='",
        "curl -s -o /dev/null -w '%{http_code}' https://elka2d.cloud/messages",
        "echo ''",
        "curl -s -o /dev/null -w '%{http_code}' https://elka2d.cloud/student-barcodes",
        "echo ''",
        
        // Check nginx error log
        "echo '=== Nginx Errors ==='",
        "tail -10 /var/log/nginx/error.log 2>&1",
        
        // Check if JS files exist and are accessible
        "echo '=== JS File Check ==='",
        "ls -la /var/www/alqaed/dist/assets/index-*.js 2>&1",
        "curl -s -o /dev/null -w '%{http_code}' https://elka2d.cloud/assets/index-1770611194621.js",
        "echo ''",
        
        // Check socket.io working
        "echo '=== Socket.IO Check ==='",
        "curl -s -o /dev/null -w '%{http_code}' 'https://elka2d.cloud/socket.io/?EIO=4&transport=polling'",
        "echo ''",
    ].join(' && ');
    
    conn.exec(cmds, (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        let out = '';
        stream.on('data', d => out += d.toString());
        stream.stderr.on('data', d => { /* ignore */ });
        stream.on('close', () => { console.log(out); conn.end(); });
    });
});

conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password });
