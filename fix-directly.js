import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function fixDirectly() {
    try {
        console.log('🔧 Fixing guardian_phone columns directly on server...\n');

        // SQL commands
        const sqlCommands = [
            "ALTER TABLE students ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;",
            "CREATE INDEX IF NOT EXISTS idx_students_guardian_phone ON students(guardian_phone);",
            "ALTER TABLE student_registration_requests ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(50) NULL AFTER phone;",
            "CREATE INDEX IF NOT EXISTS idx_registration_requests_guardian_phone ON student_registration_requests(guardian_phone);"
        ];

        console.log('📋 SQL Commands to execute:');
        sqlCommands.forEach((cmd, idx) => {
            console.log(`   ${idx + 1}. ${cmd}`);
        });
        console.log('');

        // Try via SSH with mysql command
        console.log('🔗 Attempting to connect via SSH...\n');

        const fullCommand = sqlCommands.join(' ');
        const sshCommand = `ssh root@72.62.35.177 "echo \\"${fullCommand}\\" | mysql -u Freelance -p'MyPass12345@' Freelance"`;

        try {
            const { stdout, stderr } = await execAsync(sshCommand, { timeout: 30000 });
            console.log('✅ Executed successfully!');
            if (stdout) console.log('Output:', stdout);
            if (stderr) console.log('Errors:', stderr);
        } catch (sshError) {
            console.log('⚠ SSH direct execution failed, trying alternative...\n');

            // Alternative: Create a remote SQL file and execute it
            const commands = [
                `ssh root@72.62.35.177 "echo '${sqlCommands.join('; ')}' > /tmp/fix_guardian.sql"`,
                `ssh root@72.62.35.177 "mysql -u Freelance -p'MyPass12345@' Freelance < /tmp/fix_guardian.sql"`,
                `ssh root@72.62.35.177 "rm /tmp/fix_guardian.sql"`
            ];

            for (const cmd of commands) {
                try {
                    const { stdout } = await execAsync(cmd, { timeout: 30000 });
                    if (stdout) console.log(stdout);
                } catch (e) {
                    console.error(`Error executing: ${cmd}`);
                    console.error(e.message);
                }
            }
        }

        console.log('\n==========================================\n');
        console.log('🧪 Testing if fix worked...\n');

        // Test by creating a new registration
        const loginResponse = await axios.post('http://72.62.35.177/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        }, { timeout: 10000 });

        const token = loginResponse.data.token;

        // Check if columns exist by trying to fetch data
        const requestsResponse = await axios.get('http://72.62.35.177/api/registration-requests', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        if (requestsResponse.data.length > 0) {
            const sample = requestsResponse.data[0];
            const hasGuardianField = 'guardian_phone' in sample;

            console.log(`✅ API returns guardian_phone field: ${hasGuardianField ? 'YES' : 'NO'}`);

            if (hasGuardianField) {
                console.log('\n✅✅✅ SUCCESS! The columns exist and API can access them!');
                console.log('\n📝 Next steps:');
                console.log('   1. Try creating a new account with guardian phone');
                console.log('   2. It should save correctly now');
                console.log('   3. Check in offline-students or students pages');
            }
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.log('\n🔧 Manual fix required:');
        console.log('   Run these commands on server:');
        console.log('   ssh root@72.62.35.177');
        console.log('   mysql -u Freelance -p Freelance');
        console.log('   Password: MyPass12345@');
        console.log('');
        console.log('   Then execute:');
        console.log('   ALTER TABLE students ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;');
        console.log('   ALTER TABLE student_registration_requests ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;');
    }
}

fixDirectly();
