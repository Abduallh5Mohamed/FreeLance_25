const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');

const PASSWORD = process.argv[2] || 'NewSecureP@ssw0rd2025!';
const HOST = '72.62.35.177';

// Backend files to upload (compiled JS)
const BACKEND_DIST_DIR = path.join(__dirname, 'server', 'dist');
const REMOTE_BACKEND = '/var/www/alqaed-api/dist';

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

function runSSHCommand(cmd) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.exec(cmd, (err, stream) => {
                if (err) { conn.end(); return reject(err); }
                let output = '';
                stream.on('close', () => { conn.end(); resolve(output); });
                stream.on('data', (data) => { output += data.toString(); });
                stream.stderr.on('data', (data) => { output += data.toString(); });
            });
        });
        conn.on('error', reject);
        conn.connect({ host: HOST, port: 22, username: 'root', password: PASSWORD });
    });
}

async function uploadWithRetry(sftp, localPath, remotePath, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await sftp.put(localPath, remotePath);
            return true;
        } catch (err) {
            if (i < maxRetries - 1) {
                console.log(` ⟳ Retry ${i + 2}...`);
                await new Promise(r => setTimeout(r, 1000));
            } else {
                throw err;
            }
        }
    }
}

async function deploy() {
    const sftp = new SftpClient();
    try {
        console.log('\n🚀 === BACKEND DEPLOYMENT ===\n');
        
        await sftp.connect({
            host: HOST, port: 22, username: 'root', password: PASSWORD,
            readyTimeout: 30000,
            keepaliveInterval: 5000,
        });
        console.log('✅ Connected via SFTP\n');

        // Get backend files
        const backendFiles = getAllFiles(BACKEND_DIST_DIR);
        console.log(`📦 Found ${backendFiles.length} backend files\n`);

        // Only upload changed route files (the ones we fixed)
        const criticalFiles = backendFiles.filter(f => 
            f.relative.includes('routes/messages.js') ||
            f.relative.includes('routes/registration-requests.js') ||
            f.relative.includes('index.js') ||
            f.relative.includes('db.js')
        );
        
        // Plus all other files
        const otherFiles = backendFiles.filter(f => !criticalFiles.some(c => c.relative === f.relative));

        // Upload critical files first
        for (const file of criticalFiles) {
            const remotePath = `${REMOTE_BACKEND}/${file.relative}`;
            const remoteDir = path.posix.dirname(remotePath);
            try { await sftp.mkdir(remoteDir, true); } catch (e) {}
            
            const stats = fs.statSync(file.local);
            process.stdout.write(`  📤 ${file.relative} (${(stats.size / 1024).toFixed(1)}KB)... `);
            await uploadWithRetry(sftp, file.local, remotePath);
            console.log('✅');
        }

        // Upload remaining files in batches of 5
        for (let i = 0; i < otherFiles.length; i++) {
            const file = otherFiles[i];
            const remotePath = `${REMOTE_BACKEND}/${file.relative}`;
            const remoteDir = path.posix.dirname(remotePath);
            try { await sftp.mkdir(remoteDir, true); } catch (e) {}
            
            const stats = fs.statSync(file.local);
            process.stdout.write(`  📤 ${file.relative} (${(stats.size / 1024).toFixed(1)}KB)... `);
            await uploadWithRetry(sftp, file.local, remotePath);
            console.log('✅');
            
            // Small delay every 5 files to prevent connection overload
            if (i % 5 === 4) await new Promise(r => setTimeout(r, 200));
        }

        console.log('\n✅ Backend uploaded!\n');
        await sftp.end();

        // Restart PM2
        console.log('🔄 Restarting PM2...');
        const pm2Result = await runSSHCommand('cd /var/www/alqaed-api && pm2 restart alqaed-api 2>&1');
        console.log(pm2Result);

        // Verify
        console.log('\n✅ Verification:');
        const verify = await runSSHCommand(`
            pm2 list 2>&1 | grep alqaed;
            echo "---";
            ls -la /var/www/alqaed-api/dist/routes/messages.js;
            ls -la /var/www/alqaed-api/dist/routes/registration-requests.js;
            echo "---";
            sleep 3;
            pm2 logs alqaed-api --lines 5 --nostream 2>&1
        `);
        console.log(verify);

        console.log('\n🎉 Backend deployment complete!');

    } catch (err) {
        console.error('\n❌ Error:', err.message);
        try { await sftp.end(); } catch (e) {}
        process.exit(1);
    }
}

deploy();
