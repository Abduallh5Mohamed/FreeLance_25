const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');

const PASSWORD = process.argv[2] || 'NewSecureP@ssw0rd2025!';
const HOST = '72.62.35.177';

const DIST_DIR = path.join(__dirname, 'dist');
// CORRECT: nginx root is /var/www/alqaed/dist
const REMOTE_FRONTEND = '/var/www/alqaed/dist';

function getAllFiles(dir, baseDir = dir) {
    const results = [];
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            results.push(...getAllFiles(fullPath, baseDir));
        } else {
            results.push({
                local: fullPath,
                relative: path.relative(baseDir, fullPath).replace(/\\/g, '/')
            });
        }
    }
    return results;
}

function runSSH(cmd) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec(cmd, (err, stream) => {
                if (err) { conn.end(); return reject(err); }
                let out = '';
                stream.on('close', () => { conn.end(); resolve(out); });
                stream.on('data', (d) => { out += d.toString(); });
                stream.stderr.on('data', (d) => { out += d.toString(); });
            });
        });
        conn.on('error', reject);
        conn.connect({ host: HOST, port: 22, username: 'root', password: PASSWORD });
    });
}

async function deploy() {
    const sftp = new SftpClient();
    try {
        console.log('\n🚀 Deploying frontend to /var/www/alqaed/dist/\n');
        
        await sftp.connect({
            host: HOST, port: 22, username: 'root', password: PASSWORD,
            readyTimeout: 30000,
            keepaliveInterval: 5000,
        });

        const frontendFiles = getAllFiles(DIST_DIR);
        console.log(`📦 ${frontendFiles.length} files to upload\n`);

        // Clean old JS/CSS files in dist/assets/
        console.log('🧹 Cleaning old assets in dist/assets/...');
        try {
            const oldAssets = await sftp.list(`${REMOTE_FRONTEND}/assets/`);
            for (const file of oldAssets) {
                if (file.name.endsWith('.js') || file.name.endsWith('.css')) {
                    await sftp.delete(`${REMOTE_FRONTEND}/assets/${file.name}`);
                }
            }
            console.log('✅ Cleaned\n');
        } catch (e) {
            console.log('⚠️ Could not clean (creating fresh)\n');
        }

        // Upload all files
        for (const file of frontendFiles) {
            const remotePath = `${REMOTE_FRONTEND}/${file.relative}`;
            const remoteDir = path.posix.dirname(remotePath);
            try { await sftp.mkdir(remoteDir, true); } catch (e) {}
            
            const stats = fs.statSync(file.local);
            process.stdout.write(`  📤 ${file.relative} (${(stats.size / 1024).toFixed(1)}KB)... `);
            await sftp.put(file.local, remotePath);
            console.log('✅');
        }

        console.log('\n✅ Frontend uploaded to dist/\n');
        await sftp.end();

        // Reload nginx
        console.log('🔄 Reloading nginx...');
        await runSSH('systemctl reload nginx 2>&1');
        console.log('✅ Nginx reloaded\n');

        // Verify
        console.log('🔍 Verification:');
        let result = await runSSH('ls -la /var/www/alqaed/dist/assets/*.js 2>/dev/null');
        console.log(result);

        result = await runSSH('curl -s -o /dev/null -w "HTTPS status: %{http_code}\\n" https://elka2d.cloud/assets/index-1770607555820.js 2>/dev/null');
        console.log(result);

        result = await runSSH('curl -s -o /dev/null -w "CSS status: %{http_code}\\n" https://elka2d.cloud/assets/index-DMMZV-P0.css 2>/dev/null');
        console.log(result);

        result = await runSSH('head -1 /var/www/alqaed/dist/index.html');
        console.log('Index.html:', result.substring(0, 50));

        console.log('\n🎉 Frontend deployment to correct directory complete!');

    } catch (err) {
        console.error('\n❌ Error:', err.message);
        try { await sftp.end(); } catch (e) {}
        process.exit(1);
    }
}

deploy();
