const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');

const sftp = new SftpClient();

const config = {
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: process.argv[2] || '' // Password from command line
};

const files = [
    {
        local: 'A:\\FreeLance_25-1\\dist\\assets\\index-1770306843770.js',
        remote: '/var/www/alqaed/assets/index-1770306843770.js'
    },
    {
        local: 'A:\\FreeLance_25-1\\dist\\assets\\index.es-1770306843770.js',
        remote: '/var/www/alqaed/assets/index.es-1770306843770.js'
    },
    {
        local: 'A:\\FreeLance_25-1\\dist\\assets\\purify.es-1770306843770.js',
        remote: '/var/www/alqaed/assets/purify.es-1770306843770.js'
    },
    {
        local: 'A:\\FreeLance_25-1\\dist\\assets\\html2canvas.esm-1770306843770.js',
        remote: '/var/www/alqaed/assets/html2canvas.esm-1770306843770.js'
    },
    {
        local: 'A:\\FreeLance_25-1\\dist\\index.html',
        remote: '/var/www/alqaed/index.html'
    }
];

async function uploadFile() {
    try {
        console.log('🔌 Connecting to server...');
        await sftp.connect(config);
        console.log('✓ Connected!');
        
        for (const file of files) {
            console.log(`\n📤 Uploading ${path.basename(file.local)}...`);
            const stats = fs.statSync(file.local);
            console.log(`   File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            
            await sftp.put(file.local, file.remote);
            console.log('✓ Upload complete!');
            
            // Verify
            console.log('🔍 Verifying...');
            const remoteStats = await sftp.stat(file.remote);
            console.log(`   Remote file size: ${(remoteStats.size / 1024 / 1024).toFixed(2)} MB`);
            
            if (remoteStats.size === stats.size) {
                console.log('✅ SUCCESS!');
            } else {
                console.log('⚠️  Size mismatch - something went wrong');
            }
        }
        
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    } finally {
        await sftp.end();
    }
}

uploadFile();
