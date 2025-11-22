import axios from 'axios';

async function autoFillGuardianPhones() {
    try {
        // Login
        console.log('🔐 Logging in...\n');
        const loginResponse = await axios.post('http://72.62.35.177/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        }, { timeout: 10000 });

        const token = loginResponse.data.token;
        console.log('✅ Logged in!\n');

        // Get all offline students
        const studentsResponse = await axios.get('http://72.62.35.177/api/students', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        const studentsWithoutGuardian = studentsResponse.data.filter(s =>
            (s.is_offline === 1 || s.is_offline === true) &&
            (!s.guardian_phone || s.guardian_phone.trim() === '') &&
            s.phone && s.phone.trim() !== ''
        );

        console.log(`Found ${studentsWithoutGuardian.length} students to update\n`);
        console.log('==========================================\n');

        let successCount = 0;
        let failCount = 0;

        for (const student of studentsWithoutGuardian) {
            try {
                console.log(`📝 Updating: ${student.name}`);
                console.log(`   Using phone: ${student.phone} as guardian phone`);

                await axios.put(
                    `http://72.62.35.177/api/students/${student.id}`,
                    { guardian_phone: student.phone },
                    {
                        headers: { Authorization: `Bearer ${token}` },
                        timeout: 10000
                    }
                );

                console.log(`   ✅ Success\n`);
                successCount++;

            } catch (error) {
                console.log(`   ❌ Failed: ${error.message}\n`);
                failCount++;
            }
        }

        console.log('==========================================');
        console.log(`\n📊 Summary:`);
        console.log(`   ✅ Successfully updated: ${successCount}`);
        console.log(`   ❌ Failed: ${failCount}`);
        console.log(`\n🔄 Refresh your browser to see all changes!`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

autoFillGuardianPhones();
