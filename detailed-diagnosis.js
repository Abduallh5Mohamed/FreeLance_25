import axios from 'axios';

async function detailedTest() {
    try {
        // Login
        console.log('1️⃣ Logging in...\n');
        const loginResponse = await axios.post('http://72.62.35.177/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        }, { timeout: 10000 });

        const token = loginResponse.data.token;
        console.log('✅ Logged in!\n');

        // Get most recent registration request that we created
        console.log('2️⃣ Checking our test registration request...\n');
        const requestsResponse = await axios.get('http://72.62.35.177/api/registration-requests', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        const testRequest = requestsResponse.data.find(r => r.name === 'Test Guardian Registration');

        if (testRequest) {
            console.log('📝 Test Request Found:');
            console.log(`   ID: ${testRequest.id}`);
            console.log(`   Name: ${testRequest.name}`);
            console.log(`   Phone: ${testRequest.phone}`);
            console.log(`   Guardian Phone: ${testRequest.guardian_phone || '❌ NULL'}`);
            console.log(`   Status: ${testRequest.status}`);
            console.log('');

            if (!testRequest.guardian_phone) {
                console.log('❌ guardian_phone is NULL in registration request!');
                console.log('This means the column might not exist or data wasn\'t saved.\n');
            }
        } else {
            console.log('⚠ Test request not found\n');
        }

        // Check the approved student
        console.log('3️⃣ Checking if student was created...\n');
        const studentsResponse = await axios.get('http://72.62.35.177/api/students', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        const testStudent = studentsResponse.data.find(s => s.name === 'Test Guardian Registration');

        if (testStudent) {
            console.log('📝 Test Student Found:');
            console.log(`   ID: ${testStudent.id}`);
            console.log(`   Name: ${testStudent.name}`);
            console.log(`   Phone: ${testStudent.phone}`);
            console.log(`   Guardian Phone: ${testStudent.guardian_phone || '❌ NULL'}`);
            console.log(`   Offline: ${testStudent.is_offline}`);
            console.log('');

            if (!testStudent.guardian_phone) {
                console.log('❌ guardian_phone is NULL in students table!');
                console.log('This confirms the column issue.\n');
            }
        } else {
            console.log('⚠ Test student not found\n');
        }

        // Final diagnosis
        console.log('==========================================');
        console.log('🔍 DIAGNOSIS:');
        console.log('==========================================\n');

        if (testRequest && !testRequest.guardian_phone) {
            console.log('❌ PROBLEM: guardian_phone column missing in student_registration_requests table');
            console.log('   OR: Data not being saved when request is created\n');
        }

        if (testStudent && !testStudent.guardian_phone) {
            console.log('❌ PROBLEM: guardian_phone column missing in students table');
            console.log('   OR: Data not being transferred during approval\n');
        }

        console.log('💡 SOLUTION:');
        console.log('   Need to run SQL migration on the server:');
        console.log('   ');
        console.log('   ALTER TABLE students');
        console.log('   ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;');
        console.log('   ');
        console.log('   ALTER TABLE student_registration_requests');
        console.log('   ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone;');
        console.log('');

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

detailedTest();
