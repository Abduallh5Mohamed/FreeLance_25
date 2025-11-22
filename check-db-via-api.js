import axios from 'axios';

async function checkDatabase() {
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
        console.log('📋 Fetching offline students...\n');
        const studentsResponse = await axios.get('http://72.62.35.177/api/students', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        const offlineStudents = studentsResponse.data.filter(s => s.is_offline === 1 || s.is_offline === true);

        console.log(`Found ${offlineStudents.length} offline students\n`);
        console.log('==========================================\n');

        let missingCount = 0;
        offlineStudents.forEach((student, idx) => {
            console.log(`${idx + 1}. ${student.name}`);
            console.log(`   ID: ${student.id}`);
            console.log(`   Phone: ${student.phone || '❌'}`);
            console.log(`   Guardian Phone: ${student.guardian_phone || '❌ MISSING'}`);
            console.log(`   Grade: ${student.grade || '-'}`);
            console.log(`   Group: ${student.group_name || '-'}`);

            if (!student.guardian_phone) {
                missingCount++;
            }
            console.log('');
        });

        console.log('==========================================');
        console.log(`📊 Statistics:`);
        console.log(`   Total offline students: ${offlineStudents.length}`);
        console.log(`   Missing guardian phone: ${missingCount}`);
        console.log(`   With guardian phone: ${offlineStudents.length - missingCount}`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

checkDatabase();
