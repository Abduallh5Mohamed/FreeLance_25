import axios from 'axios';

async function testRegistration() {
    try {
        console.log('🧪 Testing registration with guardian phone...\n');

        const testData = {
            name: 'Test Guardian Registration',
            phone: `01${Math.floor(Math.random() * 1000000000)}`,
            password: 'test123',
            guardian_phone: '01098765432',
            grade_id: null, // Will need valid grade_id
            group_id: null,
            requested_courses: [],
            is_offline: true
        };

        console.log('📝 Test Data:');
        console.log(JSON.stringify(testData, null, 2));
        console.log('');

        // Get grades first
        const loginResponse = await axios.post('http://72.62.35.177/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        }, { timeout: 10000 });

        const token = loginResponse.data.token;

        const gradesResponse = await axios.get('http://72.62.35.177/api/grades', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        if (gradesResponse.data && gradesResponse.data.length > 0) {
            testData.grade_id = gradesResponse.data[0].id;
            console.log(`✅ Using grade: ${gradesResponse.data[0].name} (${testData.grade_id})\n`);
        }

        // Create registration request
        console.log('📤 Sending registration request...\n');
        const response = await axios.post(
            'http://72.62.35.177/api/registration-requests',
            testData,
            { timeout: 10000 }
        );

        console.log('✅ Registration request created!');
        console.log('Response:', response.data);
        console.log('');

        const requestId = response.data.id;

        // Now approve it
        console.log('👍 Approving the request...\n');
        await axios.post(
            `http://72.62.35.177/api/registration-requests/${requestId}/approve`,
            {},
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 10000
            }
        );

        console.log('✅ Request approved!');
        console.log('');

        // Check if student was created with guardian phone
        console.log('🔍 Checking created student...\n');
        const studentsResponse = await axios.get('http://72.62.35.177/api/students', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        const createdStudent = studentsResponse.data.find(s => s.phone === testData.phone);

        if (createdStudent) {
            console.log('✅ Student found!');
            console.log(`   Name: ${createdStudent.name}`);
            console.log(`   Phone: ${createdStudent.phone}`);
            console.log(`   Guardian Phone: ${createdStudent.guardian_phone || '❌ MISSING!'}`);
            console.log(`   Grade: ${createdStudent.grade || '-'}`);
            console.log('');

            if (createdStudent.guardian_phone === testData.guardian_phone) {
                console.log('✅✅✅ SUCCESS! Guardian phone was saved correctly!');
            } else {
                console.log('❌❌❌ FAILED! Guardian phone is missing or wrong!');
                console.log(`   Expected: ${testData.guardian_phone}`);
                console.log(`   Got: ${createdStudent.guardian_phone || 'null'}`);
            }
        } else {
            console.log('❌ Student not found after approval!');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

testRegistration();
