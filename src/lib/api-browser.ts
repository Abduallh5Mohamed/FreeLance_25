/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Browser-compatible API using localStorage mock database
 * This file provides all the API functions needed by the frontend
 * without requiring a backend server or MySQL connection
 */

import bcrypt from 'bcryptjs';
import { mockQuery, mockQueryOne, mockInsert, mockUpdate, mockDelete } from './mockDb';

// ====================================
// Authentication Functions
// ====================================

export interface User {
    id: string;
    email?: string | null;
    phone?: string | null;
    name: string;
    role: 'admin' | 'teacher' | 'student';
    is_active: boolean;
}

export interface AuthResponse {
    user: User | null;
    error: string | null;
}

export const signIn = async (
    phoneOrEmail: string,
    password: string
): Promise<AuthResponse> => {
    try {
        const user = mockQueryOne<User & { password_hash: string }>(
            'USERS',
            (u: any) => (u.phone === phoneOrEmail || u.email === phoneOrEmail) && u.is_active
        );

        if (!user) {
            return { user: null, error: 'Invalid credentials' };
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            return { user: null, error: 'Invalid credentials' };
        }

        const { password_hash, ...userWithoutPassword } = user;
        return { user: userWithoutPassword, error: null };
    } catch (error) {
        console.error('Sign in error:', error);
        return { user: null, error: 'Authentication failed' };
    }
};

export const signUp = async (
    phoneOrEmail: string,
    password: string,
    name: string,
    role: 'student' | 'teacher' = 'student'
): Promise<AuthResponse> => {
    try {
        const existingUser = mockQueryOne('USERS', (u: any) => u.email === phoneOrEmail || u.phone === phoneOrEmail);

        if (existingUser) {
            return { user: null, error: 'User already exists' };
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const userId = mockInsert('USERS', {
            email: phoneOrEmail.includes('@') ? phoneOrEmail : null,
            phone: !phoneOrEmail.includes('@') ? phoneOrEmail : null,
            password_hash: passwordHash,
            name,
            role,
            is_active: true,
        });

        const user: User = {
            id: userId,
            email: phoneOrEmail.includes('@') ? phoneOrEmail : null,
            phone: !phoneOrEmail.includes('@') ? phoneOrEmail : null,
            name,
            role,
            is_active: true,
        };

        return { user, error: null };
    } catch (error) {
        console.error('Sign up error:', error);
        return { user: null, error: 'Registration failed' };
    }
};

export const getUserByEmail = async (email: string): Promise<User | null> => {
    return mockQueryOne<User>('USERS', (u: any) => (u.email === email || u.phone === email) && u.is_active);
};

// ====================================
// Students Functions
// ====================================

export interface Student {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    grade?: string;
    grade_id?: string;
    group_id?: string;
    barcode?: string;
    is_offline: boolean;
    approval_status: 'pending' | 'approved' | 'rejected';
}

export const getStudents = async (): Promise<Student[]> => {
    return mockQuery<Student>('STUDENTS', (s: any) => s.is_active !== false);
};

export const getStudentById = async (id: string): Promise<Student | null> => {
    return mockQueryOne<Student>('STUDENTS', (s: any) => s.id === id && s.is_active !== false);
};

export const getStudentByEmail = async (email: string): Promise<Student | null> => {
    return mockQueryOne<Student>('STUDENTS', (s: any) => s.email === email && s.is_active !== false);
};

export const createStudent = async (student: Partial<Student>): Promise<string> => {
    return mockInsert('STUDENTS', {
        ...student,
        is_offline: student.is_offline || false,
        approval_status: student.approval_status || 'approved',
        is_active: true,
    });
};

export const updateStudent = async (id: string, student: Partial<Student>): Promise<boolean> => {
    return mockUpdate('STUDENTS', id, student);
};

export const deleteStudent = async (id: string): Promise<boolean> => {
    return mockUpdate('STUDENTS', id, { is_active: false });
};

// ====================================
// Courses Functions
// ====================================

export interface Course {
    id: string;
    name: string;
    subject?: string;
    description?: string;
    grade?: string;
    is_active: boolean;
    price?: number;
}

export const getCourses = async (): Promise<Course[]> => {
    return mockQuery<Course>('COURSES', (c: any) => c.is_active !== false);
};

export const getCourseById = async (id: string): Promise<Course | null> => {
    return mockQueryOne<Course>('COURSES', (c: any) => c.id === id && c.is_active !== false);
};

export const createCourse = async (course: Partial<Course>): Promise<string> => {
    return mockInsert('COURSES', {
        ...course,
        is_active: true,
        price: course.price || 0,
    });
};

// ====================================
// Attendance Functions
// ====================================

export interface Attendance {
    id: string;
    student_id: string;
    course_id?: string;
    group_id?: string;
    attendance_date: Date;
    status: 'present' | 'absent' | 'late' | 'excused';
    notes?: string;
}

export const markAttendance = async (attendance: Partial<Attendance>): Promise<string> => {
    return mockInsert('ATTENDANCE', {
        ...attendance,
        status: attendance.status || 'present',
    });
};

export const getAttendanceByDate = async (
    date: Date,
    groupId?: string
): Promise<Attendance[]> => {
    return mockQuery<Attendance>('ATTENDANCE', (a: any) => {
        const dateMatch = new Date(a.attendance_date).toDateString() === date.toDateString();
        return groupId ? dateMatch && a.group_id === groupId : dateMatch;
    });
};

// ====================================
// Groups Functions
// ====================================

export interface Group {
    id: string;
    name: string;
    description?: string;
    course_id?: string;
    max_students?: number;
    current_students?: number;
    is_active: boolean;
}

export const getGroups = async (): Promise<Group[]> => {
    return mockQuery<Group>('GROUPS', (g: any) => g.is_active !== false);
};

export const getGroupById = async (id: string): Promise<Group | null> => {
    return mockQueryOne<Group>('GROUPS', (g: any) => g.id === id && g.is_active !== false);
};

export const createGroup = async (group: Partial<Group>): Promise<string> => {
    return mockInsert('GROUPS', {
        ...group,
        is_active: group.is_active !== undefined ? group.is_active : true,
        max_students: group.max_students || 30,
        current_students: 0,
    });
};

export const updateGroup = async (id: string, group: Partial<Group>): Promise<boolean> => {
    return mockUpdate('GROUPS', id, group);
};

export const deleteGroup = async (id: string): Promise<boolean> => {
    return mockUpdate('GROUPS', id, { is_active: false });
};

// ====================================
// Grades Functions
// ====================================

export interface Grade {
    id: string;
    name: string;
    display_order: number;
    is_active: boolean;
}

export const getGrades = async (): Promise<Grade[]> => {
    return mockQuery<Grade>('GRADES', (g: any) => g.is_active !== false);
};

export const getGradeById = async (id: string): Promise<Grade | null> => {
    return mockQueryOne<Grade>('GRADES', (g: any) => g.id === id && g.is_active !== false);
};

export const createGrade = async (grade: Partial<Grade>): Promise<string> => {
    return mockInsert('GRADES', {
        ...grade,
        is_active: grade.is_active !== undefined ? grade.is_active : true,
        display_order: grade.display_order || 0,
    });
};

// ====================================
// Exams Functions
// ====================================

export interface Exam {
    id: string;
    title: string;
    course_id: string;
    duration_minutes: number;
    total_marks: number;
    is_active: boolean;
}

export const getExams = async (courseId?: string): Promise<Exam[]> => {
    return mockQuery<Exam>('EXAMS', (e: any) => {
        const isActive = e.is_active !== false;
        return courseId ? isActive && e.course_id === courseId : isActive;
    });
};

export const getExamById = async (id: string): Promise<Exam | null> => {
    return mockQueryOne<Exam>('EXAMS', (e: any) => e.id === id && e.is_active !== false);
};

// ====================================
// Export all functions
// ====================================

export default {
    // Auth
    signIn,
    signUp,
    getUserByEmail,

    // Students
    getStudents,
    getStudentById,
    getStudentByEmail,
    createStudent,
    updateStudent,
    deleteStudent,

    // Courses
    getCourses,
    getCourseById,
    createCourse,

    // Groups
    getGroups,
    getGroupById,
    createGroup,
    updateGroup,
    deleteGroup,

    // Grades
    getGrades,
    getGradeById,
    createGrade,

    // Attendance
    markAttendance,
    getAttendanceByDate,

    // Exams
    getExams,
    getExamById,
};
