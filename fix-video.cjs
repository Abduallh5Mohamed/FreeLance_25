const SftpClient = require('ssh2-sftp-client');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const sftp = new SftpClient();
const config = {
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: process.argv[2] || ''
};

async function fixVideo() {
    try {
        console.log('🔌 Connecting...');
        await sftp.connect(config);
        
        console.log('📤 Uploading fix script...');
        await sftp.put('A:\\FreeLance_25-1\\fix-video-complete.sh', '/tmp/fix-video.sh');
        console.log('✓ Uploaded!');
        
        await sftp.end();
        
        console.log('🔧 Running fix script...');
        const result = await execPromise(`ssh root@${config.host} "chmod +x /tmp/fix-video.sh && bash /tmp/fix-video.sh"`);
        console.log(result.stdout);
        
        console.log('✅ Done!');
    } catch (err) {
        console.error('❌ Error:', err.message);
    }
}

fixVideo();
