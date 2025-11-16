"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../db");
const router = (0, express_1.Router)();
const BARCODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BARCODE_LENGTH = 25;
const generateBarcode = () => {
    let code = '';
    for (let i = 0; i < BARCODE_LENGTH; i += 1) {
        const index = Math.floor(Math.random() * BARCODE_CHARSET.length);
        code += BARCODE_CHARSET[index];
    }
    return code;
};
const sanitizeBarcode = (value) => {
    const normalized = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (normalized.length !== BARCODE_LENGTH) {
        const error = new Error('INVALID_BARCODE_LENGTH');
        error.name = 'INVALID_BARCODE_LENGTH';
        throw error;
    }
    return normalized;
};
// Get all students
router.get('/', async (req, res) => {
    try {
        const students = await (0, db_1.query)(`SELECT s.*, g.name AS grade_name, grp.name AS group_name
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.is_active = TRUE
             ORDER BY s.name`);
        res.json(students);
    }
    catch (error) {
        console.error('Get students error:', error);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});
// Get student by ID
router.get('/:id', async (req, res) => {
    try {
        const student = await (0, db_1.queryOne)(`SELECT s.*, g.name AS grade_name, grp.name AS group_name
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.id = ? AND s.is_active = TRUE`, [req.params.id]);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    }
    catch (error) {
        console.error('Get student by ID error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});
// Get student by email
router.get('/email/:email', async (req, res) => {
    try {
        const student = await (0, db_1.queryOne)(`SELECT s.*, g.name AS grade_name, grp.name AS group_name
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.email = ? AND s.is_active = TRUE`, [req.params.email]);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    }
    catch (error) {
        console.error('Get student by email error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});
// Get student by phone
router.get('/phone/:phone', async (req, res) => {
    try {
        const student = await (0, db_1.queryOne)(`SELECT s.*, g.name AS grade_name, grp.name AS group_name
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.phone = ? AND s.is_active = TRUE`, [req.params.phone]);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    }
    catch (error) {
        console.error('Get student by phone error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});
// Get student by ID
router.get('/barcode/:barcode', async (req, res) => {
    try {
        const student = await (0, db_1.queryOne)(`SELECT s.*, g.name AS grade_name, grp.name AS group_name
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.barcode = ? AND s.is_active = TRUE`, [req.params.barcode]);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json(student);
    }
    catch (error) {
        console.error('Get student error:', error);
        res.status(500).json({ error: 'Failed to fetch student' });
    }
});
// (moved email & phone handlers above to avoid route conflicts)
// Create new student
router.post('/', async (req, res) => {
    try {
        console.log('📝 Creating student with body:', JSON.stringify(req.body, null, 2));
        const { name, email, phone, grade, grade_id, group_id, password, barcode: incomingBarcode, is_offline = false, approval_status = 'approved' } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Student name is required' });
        }
        // Generate UUID for new student
        const studentId = crypto_1.default.randomUUID();
        console.log('📝 Generated student ID:', studentId);
        // Insert into students table
        let barcodeToStore;
        try {
            barcodeToStore = incomingBarcode ? sanitizeBarcode(incomingBarcode) : generateBarcode();
            console.log('📝 Barcode to store:', barcodeToStore);
        }
        catch (validationError) {
            if (validationError.name === 'INVALID_BARCODE_LENGTH') {
                return res.status(400).json({ error: 'Barcode must be exactly 25 alphanumeric characters.' });
            }
            throw validationError;
        }
        console.log('📝 Inserting into students table...');
        await (0, db_1.execute)(`INSERT INTO students (id, name, email, phone, grade, grade_id, group_id, barcode, is_offline, approval_status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            studentId,
            name,
            email || null,
            phone || null,
            grade || null,
            grade_id || null,
            group_id || null,
            barcodeToStore,
            is_offline,
            approval_status,
        ]);
        console.log('✅ Student inserted successfully');
        // Also insert into users table if it's an offline student
        if (is_offline && email) {
            try {
                // Hash the password before storing
                const passwordToHash = password || 'default123';
                const passwordHash = await bcryptjs_1.default.hash(passwordToHash, 10);
                await (0, db_1.execute)(`INSERT INTO users (email, password_hash, role, phone, name, student_id) 
                     VALUES (?, ?, 'student', ?, ?, ?)`, [email, passwordHash, phone || null, name, studentId]);
                console.log(`User created successfully for student ${name} with email ${email}`);
            }
            catch (userError) {
                if (typeof userError === 'object' && userError !== null && 'code' in userError && userError.code === 'ER_DUP_ENTRY') {
                    await (0, db_1.execute)(`UPDATE users SET student_id = ?, phone = ?, name = ? WHERE email = ?`, [studentId, phone || null, name, email]);
                    console.log(`User updated for existing email ${email}`);
                }
                else {
                    console.error('Error creating user:', userError);
                    throw userError;
                }
            }
        }
        const newStudent = await (0, db_1.queryOne)(`SELECT s.*, g.name AS grade_name, grp.name AS group_name
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.id = ?`, [studentId]);
        res.status(201).json(newStudent);
    }
    catch (error) {
        console.error('Create student error:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage
        });
        res.status(500).json({
            error: 'Failed to create student',
            details: error.message
        });
    }
});
// Update student
router.put('/:id', async (req, res) => {
    try {
        const { name, email, phone, grade, grade_id, group_id, barcode, password } = req.body;
        const fields = [];
        const params = [];
        if (name !== undefined) {
            fields.push('name = ?');
            params.push(name ?? null);
        }
        if (email !== undefined) {
            fields.push('email = ?');
            params.push(email ?? null);
        }
        if (phone !== undefined) {
            fields.push('phone = ?');
            params.push(phone ?? null);
        }
        if (grade !== undefined) {
            fields.push('grade = ?');
            params.push(grade ?? null);
        }
        if (grade_id !== undefined) {
            fields.push('grade_id = ?');
            params.push(grade_id ?? null);
        }
        if (group_id !== undefined) {
            fields.push('group_id = ?');
            params.push(group_id ?? null);
        }
        if (barcode !== undefined) {
            if (barcode === null) {
                fields.push('barcode = NULL');
            }
            else {
                try {
                    const sanitized = sanitizeBarcode(barcode);
                    fields.push('barcode = ?');
                    params.push(sanitized);
                }
                catch (validationError) {
                    if (validationError.name === 'INVALID_BARCODE_LENGTH') {
                        return res.status(400).json({ error: 'Barcode must be exactly 25 alphanumeric characters.' });
                    }
                    throw validationError;
                }
            }
        }
        if (fields.length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }
        fields.push('updated_at = CURRENT_TIMESTAMP');
        const result = await (0, db_1.execute)(`UPDATE students SET ${fields.join(', ')} WHERE id = ?`, [...params, req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }
        // Also update users table if email exists
        if (email) {
            const updateFields = ['name = ?', 'phone = ?'];
            const updateValues = [name, phone || null];
            if (password) {
                // Hash the password before updating
                const passwordHash = await bcryptjs_1.default.hash(password, 10);
                updateFields.push('password_hash = ?');
                updateValues.push(passwordHash);
            }
            updateValues.push(email);
            await (0, db_1.execute)(`UPDATE users SET ${updateFields.join(', ')} WHERE email = ? AND role = 'student'`, updateValues);
        }
        const updatedStudent = await (0, db_1.queryOne)(`SELECT s.*, g.name AS grade_name, grp.name AS group_name
             FROM students s
             LEFT JOIN grades g ON s.grade_id = g.id
             LEFT JOIN \`groups\` grp ON s.group_id = grp.id
             WHERE s.id = ?`, [req.params.id]);
        res.json(updatedStudent);
    }
    catch (error) {
        console.error('Update student error:', error);
        res.status(500).json({ error: 'Failed to update student' });
    }
});
// Delete student (hard delete - removes from database)
router.delete('/:id', async (req, res) => {
    try {
        // First delete related records (student_courses)
        await (0, db_1.execute)('DELETE FROM student_courses WHERE student_id = ?', [req.params.id]);
        // Then delete the student (only from students table, keep in users table)
        const result = await (0, db_1.execute)('DELETE FROM students WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Student not found' });
        }
        res.json({ message: 'Student deleted successfully' });
    }
    catch (error) {
        console.error('Delete student error:', error);
        res.status(500).json({ error: 'Failed to delete student' });
    }
});
exports.default = router;
