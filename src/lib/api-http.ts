/**
 * HTTP Client for Backend API
 * Replaces the mock localStorage database with real HTTP requests
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// Helper to get auth token from localStorage
const getAuthToken = (): string | null => {
    return localStorage.getItem('authToken');
};

// Helper to set auth token
export const setAuthToken = (token: string): void => {
    localStorage.setItem('authToken', token);
};

// Helper to clear auth token
export const clearAuthToken = (): void => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentStudent');
};

// Generic HTTP request helper
async function request<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const token = getAuthToken();

    const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers,
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
}

// ====================================
// Authentication Functions
// ====================================

export interface User {
    id: string;
    email: string;
    name: string;
    role: 'admin' | 'teacher' | 'student';
    is_active: boolean;
}

export interface AuthResponse {
    user: User | null;
    error: string | null;
    token?: string;
}

export const signIn = async (
    email: string,
    password: string
): Promise<AuthResponse> => {
    try {
        const response = await request<{ user: User; token: string }>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        });

        if (response.token) {
            setAuthToken(response.token);
            localStorage.setItem('currentUser', JSON.stringify(response.user));
        }

        return { user: response.user, error: null, token: response.token };
    } catch (error) {
        return { user: null, error: error instanceof Error ? error.message : 'Login failed' };
    }
};

export const signUp = async (
    email: string,
    password: string,
    name: string,
    role: 'student' | 'teacher' = 'student'
): Promise<AuthResponse> => {
    try {
        const response = await request<{ user: User; token: string }>('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email, password, name, role }),
        });

        if (response.token) {
            setAuthToken(response.token);
            localStorage.setItem('currentUser', JSON.stringify(response.user));
        }

        return { user: response.user, error: null, token: response.token };
    } catch (error) {
        return { user: null, error: error instanceof Error ? error.message : 'Registration failed' };
    }
};

export const getUserByEmail = async (email: string): Promise<User | null> => {
    try {
        const student = await request<User>(`/students/email/${email}`);
        return student;
    } catch (error) {
        return null;
    }
};

export const getCurrentUser = async (): Promise<User | null> => {
    try {
        const response = await request<{ user: User }>('/auth/me');
        return response.user;
    } catch (error) {
        return null;
    }
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
    return request<Student[]>('/students');
};

export const getStudentById = async (id: string): Promise<Student | null> => {
    try {
        return await request<Student>(`/students/${id}`);
    } catch {
        return null;
    }
};

export const getStudentByEmail = async (email: string): Promise<Student | null> => {
    try {
        return await request<Student>(`/students/email/${email}`);
    } catch {
        return null;
    }
};

export const createStudent = async (student: Partial<Student>): Promise<string> => {
    const created = await request<Student>('/students', {
        method: 'POST',
        body: JSON.stringify(student),
    });
    return created.id;
};

export const updateStudent = async (
    id: string,
    student: Partial<Student>
): Promise<boolean> => {
    try {
        await request(`/students/${id}`, {
            method: 'PUT',
            body: JSON.stringify(student),
        });
        return true;
    } catch {
        return false;
    }
};

export const deleteStudent = async (id: string): Promise<boolean> => {
    try {
        await request(`/students/${id}`, { method: 'DELETE' });
        return true;
    } catch {
        return false;
    }
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
    return request<Course[]>('/courses');
};

export const getCourseById = async (id: string): Promise<Course | null> => {
    try {
        return await request<Course>(`/courses/${id}`);
    } catch {
        return null;
    }
};

export const createCourse = async (course: Partial<Course>): Promise<string> => {
    const created = await request<Course>('/courses', {
        method: 'POST',
        body: JSON.stringify(course),
    });
    return created.id;
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
    return request<Group[]>('/groups');
};

export const getGroupById = async (id: string): Promise<Group | null> => {
    try {
        return await request<Group>(`/groups/${id}`);
    } catch {
        return null;
    }
};

export const createGroup = async (group: Partial<Group>): Promise<string> => {
    const created = await request<Group>('/groups', {
        method: 'POST',
        body: JSON.stringify(group),
    });
    return created.id;
};

export const updateGroup = async (
    id: string,
    group: Partial<Group>
): Promise<boolean> => {
    try {
        await request(`/groups/${id}`, {
            method: 'PUT',
            body: JSON.stringify(group),
        });
        return true;
    } catch {
        return false;
    }
};

export const deleteGroup = async (id: string): Promise<boolean> => {
    try {
        await request(`/groups/${id}`, { method: 'DELETE' });
        return true;
    } catch {
        return false;
    }
};

// ====================================
// Grades Functions
// ====================================

export interface Grade {
    id: string;
    name: string;
    display_order: number;
    is_active: boolean;
    description?: string;
    created_at?: Date;
    updated_at?: Date;
}export const getGrades = async (): Promise<Grade[]> => {
    return request<Grade[]>('/grades');
};

export const getGradeById = async (id: string): Promise<Grade | null> => {
    try {
        return await request<Grade>(`/grades/${id}`);
    } catch {
        return null;
    }
};

export const createGrade = async (grade: Partial<Grade>): Promise<Grade> => {
    return request<Grade>('/grades', {
        method: 'POST',
        body: JSON.stringify(grade),
    });
};

export const updateGrade = async (id: string, grade: Partial<Grade>): Promise<Grade> => {
    return request<Grade>(`/grades/${id}`, {
        method: 'PUT',
        body: JSON.stringify(grade),
    });
};

export const deleteGrade = async (id: string): Promise<void> => {
    await request<void>(`/grades/${id}`, {
        method: 'DELETE',
    });
};

// ====================================
// Attendance & Exams (Placeholder)
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

export interface Exam {
    id: string;
    title: string;
    course_id: string;
    duration_minutes: number;
    total_marks: number;
    is_active: boolean;
}

// Attendance functions
export const markAttendance = async (attendance: Partial<Attendance>): Promise<string> => {
    const created = await request<Attendance>('/attendance', {
        method: 'POST',
        body: JSON.stringify(attendance),
    });
    return created.id;
};

export const getAttendanceByDate = async (date: Date, groupId?: string): Promise<Attendance[]> => {
    const dateStr = date.toISOString().split('T')[0];
    const params = new URLSearchParams({ date: dateStr });
    if (groupId) params.append('group_id', groupId);

    return request<Attendance[]>(`/attendance?${params.toString()}`);
};

export const getAttendance = async (filters?: {
    date?: string;
    student_id?: string;
    group_id?: string;
    course_id?: string;
}): Promise<Attendance[]> => {
    const params = new URLSearchParams();
    if (filters?.date) params.append('date', filters.date);
    if (filters?.student_id) params.append('student_id', filters.student_id);
    if (filters?.group_id) params.append('group_id', filters.group_id);
    if (filters?.course_id) params.append('course_id', filters.course_id);

    return request<Attendance[]>(`/attendance?${params.toString()}`);
};

// Exam functions
export const getExams = async (courseId?: string): Promise<Exam[]> => {
    const params = courseId ? `?course_id=${courseId}` : '';
    return request<Exam[]>(`/exams${params}`);
};

export const getExamById = async (id: string): Promise<Exam | null> => {
    try {
        return await request<Exam>(`/exams/${id}`);
    } catch {
        return null;
    }
};

export const createExam = async (exam: Partial<Exam>): Promise<string> => {
    const created = await request<Exam>('/exams', {
        method: 'POST',
        body: JSON.stringify(exam),
    });
    return created.id;
};

export const updateExam = async (id: string, exam: Partial<Exam>): Promise<boolean> => {
    try {
        await request(`/exams/${id}`, {
            method: 'PUT',
            body: JSON.stringify(exam),
        });
        return true;
    } catch {
        return false;
    }
};

export const deleteExam = async (id: string): Promise<boolean> => {
    try {
        await request(`/exams/${id}`, { method: 'DELETE' });
        return true;
    } catch {
        return false;
    }
};

// ====================================
// Export all functions
// ====================================

export default {
    // Auth
    signIn,
    signUp,
    getUserByEmail,
    getCurrentUser,
    setAuthToken,
    clearAuthToken,

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

    // Attendance
    markAttendance,
    getAttendanceByDate,
    getAttendance,

    // Exams
    getExams,
    getExamById,
    createExam,
    updateExam,
    deleteExam,
};
