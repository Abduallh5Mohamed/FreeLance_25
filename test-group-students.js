import axios from 'axios';

async function testGroupStudents() {
    try {
        // Login
        console.log('🔐 Logging in...');
        const loginResponse = await axios.post('http://localhost:3001/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        });

        const token = loginResponse.data.token;
        console.log('✅ Logged in');

        // Get groups
        const groupsResponse = await axios.get('http://localhost:3001/api/groups', {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('\n📋 المجموعات وعدد الطلاب:\n');

        for (const group of groupsResponse.data) {
            // Get students in each group
            const studentsResponse = await axios.get('http://localhost:3001/api/students', {
                headers: { Authorization: `Bearer ${token}` }
            });

            const groupStudents = studentsResponse.data.filter(s => s.group_id === group.id && s.is_active);

            console.log(`📍 ${group.name}`);
            console.log(`   عدد الطلاب: ${groupStudents.length}`);
            console.log(`   الطلاب:`);
            groupStudents.forEach(s => {
                console.log(`   - ${s.name} (${s.barcode || 'لا يوجد باركود'})`);
            });
            console.log('');
        }

    } catch (error) {
        console.error('❌ خطأ:', error.message);
    }
}

testGroupStudents();
