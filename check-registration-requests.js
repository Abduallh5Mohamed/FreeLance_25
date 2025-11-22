import axios from 'axios';

async function checkRegistrationRequest() {
    try {
        // Login
        console.log('🔐 Logging in...\n');
        const loginResponse = await axios.post('http://72.62.35.177/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        }, { timeout: 10000 });

        const token = loginResponse.data.token;
        console.log('✅ Logged in!\n');

        // Get all registration requests
        console.log('📋 Fetching registration requests...\n');
        const response = await axios.get('http://72.62.35.177/api/registration-requests', {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
        });

        console.log(`Found ${response.data.length} registration requests\n`);

        // Find requests with guardian_phone
        const withGuardian = response.data.filter(r => r.guardian_phone);
        const withoutGuardian = response.data.filter(r => !r.guardian_phone);

        console.log('==========================================');
        console.log(`📊 Statistics:`);
        console.log(`   Total requests: ${response.data.length}`);
        console.log(`   With guardian_phone: ${withGuardian.length}`);
        console.log(`   Without guardian_phone: ${withoutGuardian.length}`);
        console.log('==========================================\n');

        // Show sample requests
        if (response.data.length > 0) {
            console.log('📝 Sample requests (first 3):\n');
            response.data.slice(0, 3).forEach((req, idx) => {
                console.log(`${idx + 1}. ${req.name}`);
                console.log(`   Phone: ${req.phone}`);
                console.log(`   Guardian Phone: ${req.guardian_phone || '❌ MISSING'}`);
                console.log(`   Status: ${req.status}`);
                console.log(`   Created: ${req.created_at}`);
                console.log('');
            });
        }

        // Check if guardian_phone field exists
        if (response.data.length > 0) {
            const firstRequest = response.data[0];
            const hasGuardianField = 'guardian_phone' in firstRequest;

            console.log('==========================================');
            console.log(`🔍 Field Check:`);
            console.log(`   guardian_phone field exists in API response: ${hasGuardianField ? '✅ YES' : '❌ NO'}`);
            console.log('==========================================\n');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

checkRegistrationRequest();
