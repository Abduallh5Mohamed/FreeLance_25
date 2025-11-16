import axios from 'axios';

async function testNotifyAbsent() {
    try {
        // First login to get token
        console.log('🔐 Logging in...');
        const loginResponse = await axios.post('http://localhost:3001/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        });

        const token = loginResponse.data.token;
        console.log('✅ Logged in successfully');

        // Get groups
        console.log('\n📋 Getting groups...');
        const groupsResponse = await axios.get('http://localhost:3001/api/groups', {
            headers: { Authorization: `Bearer ${token}` }
        });

        const groups = groupsResponse.data;
        console.log(`✅ Found ${groups.length} groups`);

        if (groups.length === 0) {
            console.log('❌ No groups found!');
            return;
        }

        const firstGroup = groups[0];
        console.log(`\n📍 Testing with group: ${firstGroup.name} (ID: ${firstGroup.id})`);

        // Test notify-absent endpoint
        console.log('\n📱 Testing notify-absent endpoint...');
        const today = new Date().toISOString().split('T')[0];

        const response = await axios.post('http://localhost:3001/api/attendance/notify-absent', {
            group_id: firstGroup.id,
            date: today
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('\n✅ Response received:');
        console.log(JSON.stringify(response.data, null, 2));

        if (response.data.whatsapp_links && response.data.whatsapp_links.length > 0) {
            console.log('\n📱 WhatsApp Links:');
            response.data.whatsapp_links.forEach((link, index) => {
                console.log(`${index + 1}. ${link.student_name} (${link.phone})`);
                console.log(`   ${link.link.substring(0, 80)}...`);
            });
        }

    } catch (error) {
        console.error('\n❌ Error:', error.response?.data || error.message);
        if (error.response?.status === 404) {
            console.log('\n⚠️  Endpoint not found! Make sure backend is rebuilt with new endpoint.');
        }
    }
}

testNotifyAbsent();
