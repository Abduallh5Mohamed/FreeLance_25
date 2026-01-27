import mysql from 'mysql2/promise';

async function addPendingReviewStatus() {
    const connection = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance',
        timezone: '+02:00'
    });

    try {
        console.log('🔄 Adding pending_review to status ENUM...');

        await connection.execute(`
      ALTER TABLE exam_attempts 
      MODIFY COLUMN status ENUM('in_progress', 'pending_review', 'completed', 'abandoned', 'passed', 'failed') 
      DEFAULT 'in_progress'
    `);

        console.log('✅ Successfully added pending_review status!');

        // Verify
        const [rows] = await connection.execute(
            "SHOW COLUMNS FROM exam_attempts WHERE Field = 'status'"
        );
        console.log('\n✅ Updated status column:');
        console.log(JSON.stringify(rows[0], null, 2));

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await connection.end();
    }
}

addPendingReviewStatus().catch(console.error);
