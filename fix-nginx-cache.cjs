const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    console.log('Fixing nginx cache and barcode polling...');
    
    const cmds = [
        // Fix nginx: Add no-cache headers to the location / block so SPA routes (try_files fallback) don't get cached
        `sed -i '/location \\/ {/,/}/ {
            s|try_files \\$uri \\$uri/ /index.html;|try_files $uri $uri/ /index.html;\\n        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;\\n        add_header Pragma "no-cache" always;\\n        add_header Expires "0" always;|
        }' /etc/nginx/sites-enabled/alqaed`,
        
        // Verify 
        "echo '=== Verify fix ==='",
        "grep -A5 'location / {' /etc/nginx/sites-enabled/alqaed",
        
        // Test config
        "nginx -t 2>&1",
        
        // Reload
        "systemctl reload nginx",
        
        "echo '=== Done ==='",
    ].join(' && ');
    
    conn.exec(cmds, (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        let out = '';
        stream.on('data', d => out += d.toString());
        stream.stderr.on('data', d => out += d.toString());
        stream.on('close', () => { console.log(out); conn.end(); });
    });
});

conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password });
