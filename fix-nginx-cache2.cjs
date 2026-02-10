const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    console.log('Connected...');
    
    // Read the nginx config, fix it, write it back
    conn.exec("cat /etc/nginx/sites-enabled/alqaed", (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        let config = '';
        stream.on('data', d => config += d.toString());
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
            console.log('Read nginx config:', config.length, 'bytes');
            
            // Fix the location / blocks - replace try_files with version that includes no-cache headers
            // There are TWO server blocks (HTTP IP + HTTPS), so fix both
            const oldLocationBlock = `    location / {
        try_files $uri $uri/ /index.html;
    }`;
            
            const newLocationBlock = `    location / {
        try_files $uri $uri/ /index.html;
        # Prevent browser caching of index.html (SPA fallback)
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
    }`;
            
            let fixedConfig = config;
            let count = 0;
            while (fixedConfig.includes(oldLocationBlock)) {
                fixedConfig = fixedConfig.replace(oldLocationBlock, newLocationBlock);
                count++;
            }
            
            console.log(`Fixed ${count} location / blocks`);
            
            if (count === 0) {
                console.log('No changes needed or pattern not matched');
                console.log('Looking for try_files...');
                const lines = config.split('\n');
                lines.forEach((line, i) => {
                    if (line.includes('try_files')) {
                        console.log(`Line ${i+1}: ${line.trim()}`);
                    }
                    if (line.includes('location /') && !line.includes('location /api') && !line.includes('location /storage') && !line.includes('location /socket') && !line.includes('location /uploads')) {
                        console.log(`Line ${i+1}: ${line.trim()}`);
                    }
                });
                conn.end();
                return;
            }
            
            // Write the fixed config back
            // Need to escape for shell command
            const escapedConfig = fixedConfig.replace(/'/g, "'\\''");
            conn.exec(`cat > /etc/nginx/sites-enabled/alqaed << 'NGINXEOF'
${fixedConfig}
NGINXEOF`, (err2, stream2) => {
                if (err2) { console.error('Write error:', err2); conn.end(); return; }
                let out2 = '';
                stream2.on('data', d => out2 += d.toString());
                stream2.stderr.on('data', d => out2 += d.toString());
                stream2.on('close', () => {
                    console.log('Config written:', out2);
                    
                    // Test and reload
                    conn.exec("nginx -t 2>&1 && systemctl reload nginx && echo 'NGINX RELOADED OK'", (err3, stream3) => {
                        if (err3) { console.error(err3); conn.end(); return; }
                        let out3 = '';
                        stream3.on('data', d => out3 += d.toString());
                        stream3.stderr.on('data', d => out3 += d.toString());
                        stream3.on('close', () => {
                            console.log(out3);
                            
                            // Verify the cache headers
                            conn.exec("curl -sI https://elka2d.cloud/messages 2>&1 | grep -i 'cache\\|pragma\\|expires'", (err4, stream4) => {
                                if (err4) { console.error(err4); conn.end(); return; }
                                let out4 = '';
                                stream4.on('data', d => out4 += d.toString());
                                stream4.stderr.on('data', () => {});
                                stream4.on('close', () => {
                                    console.log('=== Cache headers for /messages ===');
                                    console.log(out4);
                                    conn.end();
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password });
