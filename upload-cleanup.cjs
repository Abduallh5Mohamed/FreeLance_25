const SftpClient = require('ssh2-sftp-client');
const { Client } = require('ssh2');
const fs = require('fs');

const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';
const sftp = new SftpClient();

async function uploadAndExecute() {
    try {
        console.log('🔌 Connecting to server...');
        await sftp.connect({
            host: '72.62.35.177',
            port: 22,
            username: 'root',
            password: password
        });
        console.log('✅ Connected!\n');
        
        console.log('📤 Uploading cleanup script...');
        await sftp.put('A:\\FreeLance_25-1\\cleanup-all-data.sh', '/tmp/cleanup-all-data.sh');
        console.log('✅ Script uploaded!\n');
        
        await sftp.end();
        
        // Now execute via SSH
        const conn = new Client();
        conn.on('ready', () => {
            console.log('🧹 Executing cleanup script...');
            console.log('============================================\n');
            
            conn.exec('bash /tmp/cleanup-all-data.sh', (err, stream) => {
                if (err) throw err;
                
                stream.on('data', (data) => {
                    process.stdout.write(data.toString());
                }).on('close', (code) => {
                    console.log('\n============================================');
                    if (code === 0) {
                        console.log('✅ Cleanup completed successfully!');
                    } else {
                        console.log('⚠️  Script exited with code:', code);
                    }
                    conn.end();
                }).stderr.on('data', (data) => {
                    // Hide mysql warnings
                    const str = data.toString();
                    if (!str.includes('Using a password on the command line')) {
                        process.stderr.write(str);
                    }
                });
            });
        }).connect({
            host: '72.62.35.177',
            port: 22,
            username: 'root',
            password: password
        });
        
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

uploadAndExecute();
