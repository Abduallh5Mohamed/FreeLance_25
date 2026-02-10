const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');

const PASSWORD = process.argv[2] || 'NewSecureP@ssw0rd2025!';
const HOST = '72.62.35.177';

const sftp = new SftpClient();

// Frontend files to upload
const DIST_DIR = path.join(__dirname, 'dist');
const REMOTE_FRONTEND = '/var/www/alqaed';

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

async function deploy() {
    try {
        // ========== FRONTEND DEPLOYMENT ==========
        console.log('\n🚀 === FRONTEND DEPLOYMENT ===\n');
        
        await sftp.connect({ host: HOST, port: 22, username: 'root', password: PASSWORD });
        console.log('✅ Connected via SFTP\n');

        // Get all frontend files
        const frontendFiles = getAllFiles(DIST_DIR);
        console.log(`📦 Found ${frontendFiles.length} frontend files to upload\n`);

        // Clean old JS/CSS files
        console.log('🧹 Cleaning old assets...');
        try {
            const oldAssets = await sftp.list(`${REMOTE_FRONTEND}/assets/`);
            for (const file of oldAssets) {
                if (file.name.endsWith('.js') || file.name.endsWith('.css')) {
                    await sftp.delete(`${REMOTE_FRONTEND}/assets/${file.name}`);
                }
            }
            console.log('✅ Old assets cleaned\n');
        } catch (e) {
            console.log('⚠️ Could not clean old assets (may not exist)\n');
        }

        // Upload frontend files
        for (const file of frontendFiles) {
            const remotePath = `${REMOTE_FRONTEND}/${file.relative}`;
            const remoteDir = path.posix.dirname(remotePath);
            
            try {
                await sftp.mkdir(remoteDir, true);
            } catch (e) { /* dir exists */ }
            
            const stats = fs.statSync(file.local);
            process.stdout.write(`  📤 ${file.relative} (${(stats.size / 1024).toFixed(1)}KB)... `);
            await sftp.put(file.local, remotePath);
            console.log('✅');
        }

        console.log('\n✅ Frontend uploaded!\n');

        // ========== BACKEND DEPLOYMENT ==========
        console.log('🚀 === BACKEND DEPLOYMENT ===\n');

        // Get all backend compiled files
        const backendFiles = getAllFiles(BACKEND_DIST_DIR);
        console.log(`📦 Found ${backendFiles.length} backend files to upload\n`);

        // Upload backend files
        for (const file of backendFiles) {
            const remotePath = `${REMOTE_BACKEND}/${file.relative}`;
            const remoteDir = path.posix.dirname(remotePath);
            
            try {
                await sftp.mkdir(remoteDir, true);
            } catch (e) { /* dir exists */ }
            
            const stats = fs.statSync(file.local);
            process.stdout.write(`  📤 ${file.relative} (${(stats.size / 1024).toFixed(1)}KB)... `);
            await sftp.put(file.local, remotePath);
            console.log('✅');
        }

        console.log('\n✅ Backend uploaded!\n');
        await sftp.end();

        // ========== RESTART SERVICES ==========
        console.log('🔄 === RESTARTING SERVICES ===\n');
        
        console.log('Restarting PM2...');
        const pm2Result = await runSSHCommand('cd /var/www/alqaed-api && pm2 restart alqaed-api 2>&1');
        console.log(pm2Result);

        console.log('Reloading nginx...');
        const nginxResult = await runSSHCommand('nginx -t 2>&1 && systemctl reload nginx 2>&1');
        console.log(nginxResult);

        // ========== VERIFY ==========
        console.log('\n✅ === VERIFICATION ===\n');
        
        const verify = await runSSHCommand(`
            echo "=== PM2 Status ===" && 
            pm2 list 2>&1 | grep alqaed && 
            echo "" && 
            echo "=== Frontend Files ===" && 
            ls -la /var/www/alqaed/assets/*.js 2>/dev/null | tail -5 && 
            echo "" && 
            echo "=== Backend Files ===" && 
            ls -la /var/www/alqaed-api/dist/routes/messages.js 2>/dev/null && 
            ls -la /var/www/alqaed-api/dist/routes/registration-requests.js 2>/dev/null && 
            echo "" && 
            echo "=== Index.html ===" && 
            head -5 /var/www/alqaed/index.html
        `);
        console.log(verify);

        console.log('\n🎉 === DEPLOYMENT COMPLETE! ===\n');

    } catch (err) {
        console.error('\n❌ Deployment error:', err.message);
        try { await sftp.end(); } catch (e) {}
        process.exit(1);
    }
}

deploy();
