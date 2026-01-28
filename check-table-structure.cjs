const mysql = require('mysql2/promise');

(async () => {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    const [rows] = await connection.execute('SHOW CREATE TABLE exam_student_answers');
    console.log('exam_student_answers table structure:');
    console.log(rows[0]['Create Table']);

    await connection.end();
})();
