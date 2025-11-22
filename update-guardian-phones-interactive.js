import axios from 'axios';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function updateGuardianPhones() {
    try {
        // Login first
        console.log('🔐 Logging in...\n');
        const loginResponse = await axios.post('http://72.62.35.177/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        }, { timeout: 10000 });

        const token = loginResponse.data.token;
        console.log('✅ Logged in successfully!\n');

        // Get students
        console.log('📋 Fetching offline students without guardian phone...\n');
        const studentsResponse = await axios.get('http://72.62.35.177/api/students', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        const studentsWithoutGuardian = studentsResponse.data.filter(s =>
            (s.is_offline === 1 || s.is_offline === true) &&
            (!s.guardian_phone || s.guardian_phone.trim() === '')
        );

        console.log(`Found ${studentsWithoutGuardian.length} students without guardian phone\n`);
        console.log('==========================================\n');

        for (const student of studentsWithoutGuardian) {
            console.log(`\n👤 Student: ${student.name}`);
            console.log(`   Phone: ${student.phone || 'N/A'}`);
            console.log(`   Grade: ${student.grade || 'N/A'}`);

            const guardianPhone = await question('   Enter guardian phone (or press Enter to skip): ');

            if (guardianPhone && guardianPhone.trim() !== '') {
                try {
                    await axios.put(
                        `http://72.62.35.177/api/students/${student.id}`,
                        { guardian_phone: guardianPhone.trim() },
                        {
                            headers: { Authorization: `Bearer ${token}` },
                            timeout: 10000
                        }
                    );
                    console.log('   ✅ Updated successfully!');
                } catch (error) {
                    console.log('   ❌ Failed to update:', error.message);
                }
            } else {
                console.log('   ⏭️ Skipped');
            }
        }

        console.log('\n==========================================');
        console.log('✅ Update process completed!');
        rl.close();

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
        rl.close();
    }
}

updateGuardianPhones();
