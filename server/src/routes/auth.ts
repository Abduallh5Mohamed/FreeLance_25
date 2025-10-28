import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import { query, queryOne } from '../db';

const router = Router();

interface User {
    id: string;
    email?: string;
    phone?: string;
    name: string;
    role: 'admin' | 'teacher' | 'student';
    is_active: boolean;
    password_hash?: string;
}

interface JWTPayload {
    id: string;
    email: string | null;
    phone: string | null;
    role: string;
}

interface QueryResult {
    insertId: number;
    affectedRows: number;
}

// Login endpoint
router.post('/login', async (req: Request, res: Response) => {
    try {
        // Prefer phone-based login; fall back to email for backwards compatibility
        const { phone, email, password } = req.body;

        if ((!phone && !email) || !password) {
            return res.status(400).json({ error: 'Phone (or email) and password are required' });
        }

        const identifier = phone ? phone.trim() : (email || '').toLowerCase().trim();
        const where = phone ? 'phone = ?' : 'email = ?';

        const user = await queryOne<User>(
            `SELECT * FROM users WHERE ${where} AND is_active = TRUE`,
            [identifier]
        );

        if (!user || !user.password_hash) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate JWT token
        const jwtSecret: Secret = process.env.JWT_SECRET || 'secret';
        const jwtExpiry = process.env.JWT_EXPIRES_IN || '7d';
        const token = jwt.sign(
            { id: user.id, email: user.email || null, phone: user.phone || null, role: user.role },
            jwtSecret,
            { expiresIn: jwtExpiry } as jwt.SignOptions
        );

        // Remove password hash from response
        const { password_hash, ...userWithoutPassword } = user;

        res.json({
            user: userWithoutPassword,
            token,
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Register endpoint
router.post('/register', async (req: Request, res: Response) => {
    try {
        // Register with phone (preferred). For backward compatibility email may still be used.
        const { phone, email, password, name, role = 'student' } = req.body;

        if ((!phone && !email) || !password || !name) {
            return res.status(400).json({ error: 'Phone (or email), password, and name are required' });
        }

        const identifier = phone ? phone.trim() : (email || '').toLowerCase().trim();
        const where = phone ? 'phone' : 'email';

        // Check if user already exists by phone or email
        const existingUser = await queryOne(
            `SELECT id FROM users WHERE ${where} = ?`,
            [identifier]
        );

        if (existingUser) {
            return res.status(409).json({ error: 'User already exists' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Insert new user
        const result = await query(
            `INSERT INTO users (email, phone, password_hash, name, role) VALUES (?, ?, ?, ?, ?)`,
            [email ? email.toLowerCase().trim() : null, phone ? phone.trim() : null, passwordHash, name, role]
        );

        const userId = (result as unknown as QueryResult).insertId;

        // Generate JWT token
        const jwtSecret: Secret = process.env.JWT_SECRET || 'secret';
        const jwtExpiry = process.env.JWT_EXPIRES_IN || '7d';
        const token = jwt.sign(
            { id: userId, email: email || null, phone: phone || null, role },
            jwtSecret,
            { expiresIn: jwtExpiry } as jwt.SignOptions
        );

        const user = {
            id: userId.toString(),
            email: email ? email.toLowerCase().trim() : null,
            phone: phone ? phone.trim() : null,
            name,
            role,
            is_active: true,
        };

        res.status(201).json({
            user,
            token,
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Get current user (requires token)
router.get('/me', async (req: Request, res: Response) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as JWTPayload;

        const user = await queryOne<User>(
            'SELECT id, email, name, role, is_active FROM users WHERE id = ? AND is_active = TRUE',
            [decoded.id]
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
});

export default router;
