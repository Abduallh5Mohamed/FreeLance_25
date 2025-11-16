import axios from 'axios';

async function testAbsentStudents() {
    try {
        // Login
        const loginResponse = await axios.post('http://localhost:3001/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        });

        const token = loginResponse.data.token;
        const today = new Date().toISOString().split('T')[0];

        // Get group ID for "الاحد والاربعاء"
        const groupsResponse = await axios.get('http://localhost:3001/api/groups', {
            headers: { Authorization: `Bearer ${token}` }
        });

        const group = groupsResponse.data.find(g => g.name === 'الاحد والاربعاء');

        console.log(`📍 اختبار الغياب لمجموعة: ${group.name}`);
        console.log(`📅 التاريخ: ${today}\n`);

        // Call notify-absent endpoint
        const response = await axios.post('http://localhost:3001/api/attendance/notify-absent', {
            group_id: group.id,
            date: today
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('✅ النتيجة:');
        console.log(`   إجمالي الطلاب: ${response.data.total_students}`);
        console.log(`   الحاضرون: ${response.data.attended}`);
        console.log(`   الغائبون: ${response.data.absent}`);
        console.log(`   الإشعارات المرسلة: ${response.data.notifications_sent}\n`);

        if (response.data.whatsapp_links && response.data.whatsapp_links.length > 0) {
            console.log('📱 الطلاب الغائبين:');
            response.data.whatsapp_links.forEach((link, index) => {
                console.log(`   ${index + 1}. ${link.student_name} - ${link.phone}`);
                console.log(`   🔗 ${link.link}\n`);

                // Decode the message to show it
                const urlParams = new URL(link.link).searchParams;
                const message = decodeURIComponent(urlParams.get('text') || '');
                console.log('   📝 الرسالة:');
                console.log('   ' + message.split('\n').join('\n   '));
                console.log('');
            });
        }

    } catch (error) {
        console.error('❌ خطأ:', error.response?.data || error.message);
    }
}

testAbsentStudents();
