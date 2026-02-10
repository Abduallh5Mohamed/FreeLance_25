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

async function checkDatabase() {
    try {
        console.log('🔌 Connecting...');
        await sftp.connect(config);
        
        console.log('📤 Uploading script...');
        await sftp.put(
            'A:\\FreeLance_25-1\\check-database.sh',
            '/tmp/check-database.sh'
        );
        console.log('✓ Uploaded!');
        
        await sftp.end();
        
        console.log('');
        console.log('🗄️ Checking Database...');
        console.log('==================================');
        
        const { stdout } = await execPromise(
            `ssh -o ServerAliveInterval=60 root@${config.host} "chmod +x /tmp/check-database.sh && bash /tmp/check-database.sh"`,
            { env: { ...process.env, SSHPASS: config.password } }
        );
        
        console.log(stdout);
        
    } catch (err) {
        if (err.stdout) {
            console.log(err.stdout);
        }
        console.error('❌ Error:', err.message);
    }
}

checkDatabase();
