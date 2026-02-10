const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    // Read the nginx config
    conn.exec("cat /etc/nginx/sites-enabled/alqaed", (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        let config = '';
        stream.on('data', d => config += d.toString());
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
            const lines = config.split('\n');
            
            // Find the try_files lines and their context
            lines.forEach((line, i) => {
                if (line.includes('try_files')) {
                    console.log(`\n--- Around line ${i+1} ---`);
                    for (let j = Math.max(0, i-2); j <= Math.min(lines.length-1, i+3); j++) {
                        console.log(`${j+1}: [${JSON.stringify(lines[j])}]`);
                    }
                }
            });
            
            // Fix: Find all "try_files $uri $uri/ /index.html;" lines and add cache headers after them
            let fixedLines = [...lines];
            let insertions = 0;
            
            for (let i = fixedLines.length - 1; i >= 0; i--) {
                if (fixedLines[i].trim() === 'try_files $uri $uri/ /index.html;') {
                    // Check if next line already has cache-control
                    const nextLine = fixedLines[i + 1] || '';
                    if (!nextLine.includes('Cache-Control') && !nextLine.includes('no-cache')) {
                        // Get the indent level
                        const indent = fixedLines[i].match(/^(\s*)/)?.[1] || '        ';
                        fixedLines.splice(i + 1, 0,
                            `${indent}# Prevent browser caching of index.html (SPA fallback)`,
                            `${indent}add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;`,
                            `${indent}add_header Pragma "no-cache" always;`,
                            `${indent}add_header Expires "0" always;`
                        );
                        insertions++;
                    }
                }
            }
            
            console.log(`\nInsertions made: ${insertions}`);
            
            if (insertions === 0) {
                console.log('No insertions needed');
                conn.end();
                return;
            }
            
            const fixedConfig = fixedLines.join('\n');
            
            // Write back using heredoc
            conn.exec(`cat > /etc/nginx/sites-enabled/alqaed << 'NGINXEOF'\n${fixedConfig}\nNGINXEOF`, (err2, stream2) => {
                if (err2) { console.error(err2); conn.end(); return; }
                let out2 = '';
                stream2.on('data', d => out2 += d.toString());
                stream2.stderr.on('data', d => out2 += d.toString());
                stream2.on('close', () => {
                    console.log('Written:', out2);
                    
                    conn.exec("nginx -t 2>&1 && systemctl reload nginx && echo 'NGINX RELOADED OK' && curl -sI https://elka2d.cloud/messages 2>&1 | grep -iE 'cache|pragma|expires|http/'", (err3, stream3) => {
                        if (err3) { console.error(err3); conn.end(); return; }
                        let out3 = '';
                        stream3.on('data', d => out3 += d.toString());
                        stream3.stderr.on('data', d => out3 += d.toString());
                        stream3.on('close', () => {
                            console.log(out3);
                            conn.end();
                        });
                    });
                });
            });
        });
    });
});

conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password });
