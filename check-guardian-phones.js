import axios from 'axios';

async function checkGuardianPhones() {
    try {
        const loginResponse = await axios.post('http://localhost:3001/api/auth/login', {
            phone: '01024083057',
            password: 'Mtd#mora55'
        });

        const token = loginResponse.data.token;

        const studentsResponse = await axios.get('http://localhost:3001/api/students', {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log('📋 أرقام الطلاب وأولياء الأمور:\n');

        studentsResponse.data.forEach(student => {
            console.log(`👤 ${student.name}`);
            console.log(`   رقم الطالب: ${student.phone || 'لا يوجد'}`);
            console.log(`   رقم ولي الأمر: ${student.guardian_phone || '❌ لا يوجد'}`);
            console.log(`   المجموعة: ${student.group_id || 'لا توجد'}`);
            console.log('');
        });

    } catch (error) {
        console.error('❌ خطأ:', error.message);
    }
}

checkGuardianPhones();
