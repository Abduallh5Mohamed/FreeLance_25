const { Client } = require('ssh2');

const password = 'NewSecureP@ssw0rd2025!';
const ADMIN_ID = '69fe1174-c98d-11f0-9d07-94e8d4b653c4';

const conn = new Client();

const tables = [
    // Order matters for foreign keys
    'message_status',
    'messages', 
    'conversations',
    'teacher_messages',
    'exam_attempts',
    'exam_results',
    'exam_questions',
    'exams',
    'lecture_views',
    'video_access_logs',
    'lecture_materials',
    'lectures',
    'student_course_access',
    'courses',
    'student_groups',
    'groups',
    'subscription_history',
    'subscriptions',
    'payments',
    'payment_receipts',
    'attendance',
    'meetings',
    'student_lecture_access',
    'student_materials',
    'student_notes',
    'student_progress',
    'student_registration_requests',
    'guardian_phones',
    'notifications',
    'grades',
    'student_reports',
    'materials',
    'files',
    'security_logs'
];

conn.on('ready', () => {
    console.log('🧹 Database Cleanup Started');
    console.log('============================================\n');
    
    let completed = 0;
    
    function cleanTable(index) {
        if (index >= tables.length) {
            // Clean users and other special tables
            cleanSpecialTables();
            return;
        }
        
        const table = tables[index];
        const sql = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM ${table}; SET FOREIGN_KEY_CHECKS=1;" 2>/dev/null`;
        
        conn.exec(sql, (err, stream) => {
            let output = '';
            stream.on('data', (data) => {
                output += data.toString();
            }).on('close', (code) => {
                completed++;
                if (code === 0) {
                    console.log(`✅ ${completed}/${tables.length + 3}: ${table} cleaned`);
                } else {
                    console.log(`⚠️  ${completed}/${tables.length + 3}: ${table} (may not exist)`);
                }
                cleanTable(index + 1);
            });
        });
    }
    
    function cleanSpecialTables() {
        console.log('\n🔧 Cleaning special tables...\n');
        
        // Clean teachers (keep admin if teacher)
        const sql1 = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM teachers WHERE user_id != '${ADMIN_ID}'; SET FOREIGN_KEY_CHECKS=1;" 2>/dev/null`;
        
        conn.exec(sql1, (err, stream) => {
            stream.on('close', () => {
                console.log(`✅ ${tables.length + 1}/${tables.length + 3}: Teachers cleaned`);
                
                // Clean students
                const sql2 = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM students; SET FOREIGN_KEY_CHECKS=1;" 2>/dev/null`;
                
                conn.exec(sql2, (err, stream) => {
                    stream.on('close', () => {
                        console.log(`✅ ${tables.length + 2}/${tables.length + 3}: Students deleted`);
                        
                        // Clean users (keep admin)
                        const sql3 = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SET FOREIGN_KEY_CHECKS=0; DELETE FROM users WHERE id != '${ADMIN_ID}'; SET FOREIGN_KEY_CHECKS=1;" 2>/dev/null`;
                        
                        conn.exec(sql3, (err, stream) => {
                            stream.on('close', () => {
                                console.log(`✅ ${tables.length + 3}/${tables.length + 3}: Users cleaned (Admin kept)`);
                                showFinalStatus();
                            });
                        });
                    });
                });
            });
        });
    }
    
    function showFinalStatus() {
        console.log('\n============================================');
        console.log('📊 Final Database Status:');
        console.log('============================================\n');
        
        const statusSQL = `mysql -u root -p$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2) freelance -e "SELECT COUNT(*) as 'Users' FROM users; SELECT COUNT(*) as 'Students' FROM students; SELECT COUNT(*) as 'Teachers' FROM teachers; SELECT COUNT(*) as 'Courses' FROM courses; SELECT COUNT(*) as 'Lectures' FROM lectures; SELECT COUNT(*) as 'Exams' FROM exams; SELECT COUNT(*) as 'Messages' FROM messages; SELECT name, phone, role FROM users WHERE id='${ADMIN_ID}';" 2>/dev/null`;
        
        conn.exec(statusSQL, (err, stream) => {
            stream.on('data', (data) => {
                process.stdout.write(data.toString());
            }).on('close', () => {
                console.log('\n============================================');
                console.log('✅ Database cleanup completed!');
                console.log('🎯 Database is clean and ready for client!');
                console.log('============================================\n');
                conn.end();
            });
        });
    }
    
    // Start cleaning
    cleanTable(0);
    
}).connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
