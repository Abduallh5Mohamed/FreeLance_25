import express, { Request, Response } from 'express';
import { getPool } from '../db';

const router = express.Router();
const pool = getPool();

// Run guardian_phone migration
router.post('/run-guardian-migration', async (req: Request, res: Response) => {
    try {
        console.log('🚀 Starting guardian_phone migration...');

        // Check if columns exist
        const [studentsColumns] = await pool.query<any[]>(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = 'Freelance' 
             AND TABLE_NAME = 'students' 
             AND COLUMN_NAME = 'guardian_phone'`
        );

        const [requestsColumns] = await pool.query<any[]>(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
             WHERE TABLE_SCHEMA = 'Freelance' 
             AND TABLE_NAME = 'student_registration_requests' 
             AND COLUMN_NAME = 'guardian_phone'`
        );

        const results = {
            students: { exists: studentsColumns.length > 0, added: false },
            registration_requests: { exists: requestsColumns.length > 0, added: false }
        };

        // Add to students table if doesn't exist
        if (!results.students.exists) {
            console.log('➕ Adding guardian_phone to students table...');
            await pool.query(
                `ALTER TABLE students 
                 ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone`
            );
            await pool.query(
                `CREATE INDEX idx_students_guardian_phone 
                 ON students(guardian_phone)`
            );
            results.students.added = true;
            console.log('✅ Added to students table');
        } else {
            console.log('✓ guardian_phone already exists in students table');
        }

        // Add to student_registration_requests table if doesn't exist
        if (!results.registration_requests.exists) {
            console.log('➕ Adding guardian_phone to student_registration_requests table...');
            await pool.query(
                `ALTER TABLE student_registration_requests 
                 ADD COLUMN guardian_phone VARCHAR(50) NULL AFTER phone`
            );
            await pool.query(
                `CREATE INDEX idx_registration_requests_guardian_phone 
                 ON student_registration_requests(guardian_phone)`
            );
            results.registration_requests.added = true;
            console.log('✅ Added to student_registration_requests table');
        } else {
            console.log('✓ guardian_phone already exists in student_registration_requests table');
        }

        console.log('✅ Migration completed!');

        res.json({
            success: true,
            message: 'Migration completed successfully',
            results
        });

    } catch (error) {
        console.error('❌ Migration error:', error);
        res.status(500).json({
            success: false,
            error: 'Migration failed',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

export default router;
