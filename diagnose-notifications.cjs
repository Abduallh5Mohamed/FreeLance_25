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

async function diagnoseNotifications() {
    try {
        console.log('🔌 Connecting...');
        await sftp.connect(config);
        
        console.log('📤 Uploading diagnostic script...');
        await sftp.put(
            'A:\\FreeLance_25-1\\diagnose-notifications.sh',
            '/tmp/diagnose-notifications.sh'
        );
        console.log('✓ Uploaded!');
        
        await sftp.end();
        
        console.log('');
        console.log('🔍 Running diagnostic...');
        console.log('==================================');
        
        const { stdout } = await execPromise(
            `ssh -o ServerAliveInterval=60 root@${config.host} "chmod +x /tmp/diagnose-notifications.sh && bash /tmp/diagnose-notifications.sh"`,
            { env: { ...process.env, SSHPASS: config.password } }
        );
        
        console.log(stdout);
        console.log('==================================');
        console.log('✅ Diagnostic complete!');
        
    } catch (err) {
        if (err.stdout) {
            console.log(err.stdout);
        }
        console.error('❌ Error:', err.message);
    }
}

diagnoseNotifications();
