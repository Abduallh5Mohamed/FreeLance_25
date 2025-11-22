import axios from 'axios';

async function updateSpecificStudent() {
    try {
        // Login
        console.log('🔐 Logging in...\n');
        const loginResponse = await axios.post('http://72.62.35.177/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        }, { timeout: 10000 });

        const token = loginResponse.data.token;
        console.log('✅ Logged in!\n');

        // Update aliaa ali's guardian phone
        const studentId = 'e41fe90a-62b1-47aa-9b8a-ca20e1f1a611'; // aliaa ali
        const newGuardianPhone = '01062147611'; // Using her phone as guardian (can be changed)

        console.log(`📝 Updating guardian phone for "aliaa ali"...`);
        console.log(`   Student ID: ${studentId}`);
        console.log(`   New Guardian Phone: ${newGuardianPhone}\n`);

        await axios.put(
            `http://72.62.35.177/api/students/${studentId}`,
            { guardian_phone: newGuardianPhone },
            {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 10000
            }
        );

        console.log('✅ Updated successfully!');
        console.log('\n🔄 Now refresh the page in your browser to see the change!');

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

updateSpecificStudent();
