import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import { query, queryOne } from '../db';

const router = Router();

interface Staff {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    password_hash?: string;
    role: string;
    accessible_pages: string[];
    is_active: boolean;
    created_at?: string;
    updated_at?: string;
}

interface QueryResult {
    insertId: number;
    affectedRows: number;
}

// Get all staff members
router.get('/', async (req: Request, res: Response) => {
    try {
        const staffList = await query<Staff>(
            `SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at 
             FROM staff WHERE is_active = 1 ORDER BY created_at DESC`
        );

        // Parse accessible_pages from JSON string to array
        const parsedStaff = staffList.map(s => ({
            ...s,
            accessible_pages: typeof s.accessible_pages === 'string'
                ? JSON.parse(s.accessible_pages)
                : (s.accessible_pages || [])
        }));

        res.json(parsedStaff);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ error: 'Failed to fetch staff' });
    }
});

// Get single staff member
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const staff = await queryOne<Staff>(
            `SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at 
             FROM staff WHERE id = ?`,
            [id]
        );

        if (!staff) {
            return res.status(404).json({ error: 'Staff not found' });
        }

        // Parse accessible_pages
        const parsedStaff = {
            ...staff,
            accessible_pages: typeof staff.accessible_pages === 'string'
                ? JSON.parse(staff.accessible_pages)
                : (staff.accessible_pages || [])
        };

        res.json(parsedStaff);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ error: 'Failed to fetch staff' });
    }
});

// Create new staff member
router.post('/', async (req: Request, res: Response) => {
    try {
        const { name, phone, password, accessible_pages = [] } = req.body;

        if (!name || !phone || !password) {
            return res.status(400).json({ error: 'الاسم ورقم الهاتف وكلمة المرور مطلوبة' });
        }

        // Check if phone exists in staff table
        const existingStaff = await queryOne(
            'SELECT id FROM staff WHERE phone = ?',
            [phone.trim()]
        );

        if (existingStaff) {
            return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل كموظف' });
        }

        // Check if phone exists in users table (admin/teacher/student)
        const existingUser = await queryOne(
            'SELECT id, role FROM users WHERE phone = ?',
            [phone.trim()]
        );

        if (existingUser) {
            return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل في النظام' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Insert new staff
        const result = await query(
            `INSERT INTO staff (name, phone, password_hash, role, accessible_pages, is_active) 
             VALUES (?, ?, ?, 'staff', ?, 1)`,
            [
                name.trim(),
                phone.trim(),
                passwordHash,
                JSON.stringify(accessible_pages)
            ]
        );

        const staffId = (result as unknown as QueryResult).insertId;

        res.status(201).json({
            id: staffId.toString(),
            name: name.trim(),
            phone: phone.trim(),
            role: 'staff',
            accessible_pages,
            is_active: true,
            message: 'تم إنشاء الموظف بنجاح'
        });
    } catch (error) {
        console.error('Error creating staff:', error);
        res.status(500).json({ error: 'Failed to create staff' });
    }
});

// Update staff member
router.put('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { name, phone, password, accessible_pages } = req.body;

        // Check if staff exists
        const existingStaff = await queryOne<Staff>(
            'SELECT id, phone FROM staff WHERE id = ?',
            [id]
        );

        if (!existingStaff) {
            return res.status(404).json({ error: 'الموظف غير موجود' });
        }

        // Check for duplicate phone (if phone is being changed)
        if (phone && phone.trim() !== existingStaff.phone) {
            // Check in staff table
            const duplicateStaffPhone = await queryOne(
                'SELECT id FROM staff WHERE phone = ? AND id != ?',
                [phone.trim(), id]
            );
            if (duplicateStaffPhone) {
                return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل كموظف آخر' });
            }

            // Check in users table
            const duplicateUserPhone = await queryOne(
                'SELECT id FROM users WHERE phone = ?',
                [phone.trim()]
            );
            if (duplicateUserPhone) {
                return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل في النظام' });
            }
        }

        // Build update query
        const updateFields: string[] = [];
        const updateValues: any[] = [];

        if (name) {
            updateFields.push('name = ?');
            updateValues.push(name.trim());
        }
        if (phone) {
            updateFields.push('phone = ?');
            updateValues.push(phone.trim());
        }
        if (password) {
            const passwordHash = await bcrypt.hash(password, 10);
            updateFields.push('password_hash = ?');
            updateValues.push(passwordHash);
        }
        if (accessible_pages !== undefined) {
            updateFields.push('accessible_pages = ?');
            updateValues.push(JSON.stringify(accessible_pages));
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updateFields.push('updated_at = NOW()');
        updateValues.push(id);

        await query(
            `UPDATE staff SET ${updateFields.join(', ')} WHERE id = ?`,
            updateValues
        );

        // Fetch updated staff
        const updatedStaff = await queryOne<Staff>(
            `SELECT id, name, email, phone, role, accessible_pages, is_active, created_at, updated_at 
             FROM staff WHERE id = ?`,
            [id]
        );

        const parsedStaff = {
            ...updatedStaff,
            accessible_pages: typeof updatedStaff?.accessible_pages === 'string'
                ? JSON.parse(updatedStaff.accessible_pages)
                : (updatedStaff?.accessible_pages || [])
        };

        res.json({
            ...parsedStaff,
            message: 'تم تحديث بيانات الموظف بنجاح'
        });
    } catch (error) {
        console.error('Error updating staff:', error);
        res.status(500).json({ error: 'Failed to update staff' });
    }
});

// Delete staff member (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;

        const existingStaff = await queryOne(
            'SELECT id FROM staff WHERE id = ?',
            [id]
        );

        if (!existingStaff) {
            return res.status(404).json({ error: 'Staff not found' });
        }

        await query(
            'UPDATE staff SET is_active = 0, updated_at = NOW() WHERE id = ?',
            [id]
        );

        res.json({ message: 'تم حذف الموظف بنجاح' });
    } catch (error) {
        console.error('Error deleting staff:', error);
        res.status(500).json({ error: 'Failed to delete staff' });
    }
});

// Staff login endpoint
router.post('/login', async (req: Request, res: Response) => {
    try {
        console.log('🔐 Staff Login attempt:', req.body);
        const { phone, password } = req.body;

        if (!phone || !password) {
            return res.status(400).json({ error: 'Phone and password are required' });
        }

        const staff = await queryOne<Staff>(
            `SELECT id, name, email, phone, password_hash, role, accessible_pages, is_active 
             FROM staff WHERE phone = ? AND is_active = 1`,
            [phone.trim()]
        );

        console.log('👤 Staff found:', staff ? 'Yes' : 'No');

        if (!staff || !staff.password_hash) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, staff.password_hash);
        console.log('🔑 Password valid:', isValidPassword);

        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Parse accessible_pages
        const accessiblePages = typeof staff.accessible_pages === 'string'
            ? JSON.parse(staff.accessible_pages)
            : (staff.accessible_pages || []);

        // Generate JWT token
        const jwtSecret: Secret = process.env.JWT_SECRET || 'secret';
        const jwtExpiry = process.env.JWT_EXPIRES_IN || '7d';
        const token = jwt.sign(
            {
                id: staff.id,
                phone: staff.phone,
                role: 'staff',
                accessible_pages: accessiblePages
            },
            jwtSecret,
            { expiresIn: jwtExpiry } as jwt.SignOptions
        );

        console.log('✅ Staff login successful for:', staff.phone);

        res.json({
            user: {
                id: staff.id,
                name: staff.name,
                email: staff.email,
                phone: staff.phone,
                role: 'staff',
                accessible_pages: accessiblePages,
                is_active: staff.is_active
            },
            token
        });
    } catch (error) {
        console.error('❌ Staff login error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

export default router;
