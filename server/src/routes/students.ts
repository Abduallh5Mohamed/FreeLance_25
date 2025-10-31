import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne, execute } from '../db';

const router = Router();

// Get all students
router.get('/', async (req: Request, res: Response) => {
    try {
        const students = await query(
            'SELECT * FROM students WHERE is_active = TRUE ORDER BY name'
        );
        res.json(students);
    } catch (error) {
        console.error('Get students error:', error);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});

// Get student by ID
// Get student by email
router.get('/email/:email', async (req: Request, res: Response) => {
    try {
        const student = await queryOne(
            'SELECT * FROM students WHERE email = ? AND is_active = TRUE',
            [req.params.email]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json(student);
    } catch (error) {
        console.error('Get student by email error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// Get student by phone
router.get('/phone/:phone', async (req: Request, res: Response) => {
    try {
        const student = await queryOne(
            'SELECT * FROM students WHERE phone = ? AND is_active = TRUE',
            [req.params.phone]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json(student);
    } catch (error) {
        console.error('Get student by phone error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// Get student by ID
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const student = await queryOne(
            'SELECT * FROM students WHERE id = ? AND is_active = TRUE',
            [req.params.id]
        );

        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json(student);
    } catch (error) {
        console.error('Get student error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});

// (moved email & phone handlers above to avoid route conflicts)

// Create new student
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, email, phone, grade, grade_id, group_id, password, is_offline = false, approval_status = 'approved' } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Student name is required' });
        }

        // Insert into students table
        const result = await execute(
            `INSERT INTO students (name, email, phone, grade, grade_id, group_id, is_offline, approval_status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, email || null, phone || null, grade || null, grade_id || null, group_id || null, is_offline, approval_status]
        );

        const studentId = result.insertId;

        // Also insert into users table if it's an offline student
        if (is_offline && email) {
            try {
                // Hash the password before storing
                const passwordToHash = password || 'default123';
                const passwordHash = await bcrypt.hash(passwordToHash, 10);

                await execute(
                    `INSERT INTO users (email, password_hash, role, phone, name, student_id) 
                     VALUES (?, ?, 'student', ?, ?, ?)`,
                    [email, passwordHash, phone || null, name, studentId]
                );

                console.log(`User created successfully for student ${name} with email ${email}`);
            } catch (userError: any) {
                // If user already exists, update the student_id
                if (userError.code === 'ER_DUP_ENTRY') {
                    await execute(
                        `UPDATE users SET student_id = ?, phone = ?, name = ? WHERE email = ?`,
                        [studentId, phone || null, name, email]
                    );
                    console.log(`User updated for existing email ${email}`);
                } else {
                    console.error('Error creating user:', userError);
                    throw userError; // Re-throw to see the error
                }
            }
        }

        const newStudent = await queryOne(
            'SELECT * FROM students WHERE id = ?',
            [studentId]
        );

        res.status(201).json(newStudent);
    } catch (error) {
        console.error('Create student error:', error);
        res.status(500).json({ error: 'Failed to create student' });
    }
});

// Update student
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { name, email, phone, grade, grade_id, group_id, password } = req.body;

        const result = await execute(
            `UPDATE students 
             SET name = COALESCE(?, name),
                 email = COALESCE(?, email),
                 phone = COALESCE(?, phone),
                 grade = COALESCE(?, grade),
                 grade_id = COALESCE(?, grade_id),
                 group_id = COALESCE(?, group_id),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                name ?? null,
                email ?? null,
                phone ?? null,
                grade ?? null,
                grade_id ?? null,
                group_id ?? null,
                req.params.id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }

        // Also update users table if email exists
        if (email) {
            const updateFields = ['name = ?', 'phone = ?'];
            const updateValues = [name, phone || null];

            if (password) {
                // Hash the password before updating
                const passwordHash = await bcrypt.hash(password, 10);
                updateFields.push('password_hash = ?');
                updateValues.push(passwordHash);
            }

            updateValues.push(email);

            await execute(
                `UPDATE users SET ${updateFields.join(', ')} WHERE email = ? AND role = 'student'`,
                updateValues
            );
        }

        const updatedStudent = await queryOne(
            'SELECT * FROM students WHERE id = ?',
            [req.params.id]
        );

        res.json(updatedStudent);
    } catch (error) {
        console.error('Update student error:', error);
        res.status(500).json({ error: 'Failed to update student' });
    }
});

// Delete student (hard delete - removes from database)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        // First delete related records (student_courses)
        await execute(
            'DELETE FROM student_courses WHERE student_id = ?',
            [req.params.id]
        );

        // Then delete the student (only from students table, keep in users table)
        const result = await execute(
            'DELETE FROM students WHERE id = ?',
            [req.params.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }

        res.json({ message: 'Student deleted successfully' });
    } catch (error) {
        console.error('Delete student error:', error);
        res.status(500).json({ error: 'Failed to delete student' });
    }
});

export default router;
