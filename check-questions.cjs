const mysql = require('mysql2/promise');

(async () => {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    const [rows] = await connection.execute(
        'SELECT id, question_text, question_type, correct_answer, points FROM exam_questions LIMIT 5'
    );

    console.log('Sample questions from database:');
    rows.forEach((r, i) => {
        console.log(`\nQ${i + 1}:`, {
            id: r.id,
            text: r.question_text?.substring(0, 50) + '...',
            type: r.question_type,
            correct_answer: r.correct_answer,
            correct_answer_type: typeof r.correct_answer,
            points: r.points
        });
    });

    await connection.end();
})();
