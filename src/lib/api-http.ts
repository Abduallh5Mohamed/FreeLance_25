/**
 * HTTP Client for Backend API
 * Replaces the mock localStorage database with real HTTP requests
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// DEV: quick toggle to disable authentication / backend strictness while
// developing locally. When true this will populate a demo user/student in
// localStorage and make some functions return safe defaults instead of
// throwing. Set to `false` for production or when your backend is running.
const DISABLE_AUTH_DEV = true;

if (DISABLE_AUTH_DEV && typeof localStorage !== 'undefined') {
    try {
        const devUser = {
            id: 'dev-user',
            email: 'demo@student.com',
            name: 'طالب تجريبي',
            role: 'student',
            is_active: true,
        };

        const devStudent = {
            id: 'demo-123',
            name: 'محمد أحمد',
            email: 'demo@student.com',
            phone: '01234567890',
            grade: 'صف تجريبي',
            grade_id: null,
            group_id: null,
            barcode: null,
            is_offline: true,
            approval_status: 'approved',
        };

        // Populate localStorage so supabase shim and other pages pick it up
        localStorage.setItem('authToken', 'dev-token');
        localStorage.setItem('currentUser', JSON.stringify(devUser));
        localStorage.setItem('currentStudent', JSON.stringify(devStudent));
        // supabase shim reads `supabaseUser`
        localStorage.setItem('supabaseUser', JSON.stringify(devUser));
    } catch (e) {
        // ignore storage errors in some environments
    }
}

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
    email?: string | null;
    phone?: string | null;
    name: string;
    role: 'admin' | 'teacher' | 'student';
    is_active: boolean;
    student_id?: string | null;
}

export interface AuthResponse {
    user: User | null;
    error: string | null;
    token?: string;
}

export const signIn = async (
    phone: string,
    password: string
): Promise<AuthResponse> => {
    try {
        const response = await request<{ user: User; token: string }>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ phone, password }),
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
    phone: string | null,
    password: string,
    name: string,
    role: 'student' | 'teacher' = 'student',
    email?: string | null
): Promise<AuthResponse> => {
    try {
        const response = await request<{ user: User; token: string }>('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ phone, email: email || null, password, name, role }),
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

export const getUserByPhone = async (phone: string): Promise<User | null> => {
    try {
        const response = await request<{ user: User }>(`/auth/me`);
        // /auth/me requires token; this helper focuses on students lookup below
        return response.user || null;
    } catch (error) {
        return null;
    }
};

export const getStudentByPhone = async (phone: string): Promise<Student | null> => {
    try {
        return await request<Student>(`/students/phone/${encodeURIComponent(phone)}`);
    } catch {
        return null;
    }
};

export const getCurrentUser = async (): Promise<User | null> => {
    try {
        if (DISABLE_AUTH_DEV) {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('currentUser') : null;
            return raw ? JSON.parse(raw) as User : null;
        }

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
    try {
        return await request<Student[]>('/students');
    } catch (err) {
        // When backend is unavailable return empty list (safe fallback)
        if (DISABLE_AUTH_DEV) return [];
        throw err;
    }
};

export const getStudentById = async (id: string): Promise<Student | null> => {
    try {
        return await request<Student>(`/students/${id}`);
    } catch (e) {
        if (DISABLE_AUTH_DEV) {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('currentStudent') : null;
            return raw ? JSON.parse(raw) as Student : null;
        }
        return null;
    }
};

export const getStudentByEmail = async (email: string): Promise<Student | null> => {
    try {
        return await request<Student>(`/students/email/${email}`);
    } catch (e) {
        if (DISABLE_AUTH_DEV) {
            const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('currentStudent') : null;
            const student = raw ? JSON.parse(raw) as Student : null;
            if (student && student.email === email) return student;
            return null;
        }
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

export const updateCourse = async (id: string, course: Partial<Course>): Promise<void> => {
    await request<Course>(`/courses/${id}`, {
        method: 'PUT',
        body: JSON.stringify(course),
    });
};

export const deleteCourse = async (id: string): Promise<void> => {
    await request(`/courses/${id}`, {
        method: 'DELETE',
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
    grade_id?: string;
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
// Subscriptions Functions
// ====================================

export interface Subscription {
    id: string;
    name: string;
    duration_months: number;
    price: number;
    description?: string;
    is_active: boolean;
    created_at?: Date;
    updated_at?: Date;
}

export const getSubscriptions = async (): Promise<Subscription[]> => {
    return request<Subscription[]>('/subscriptions');
};

export const getSubscriptionById = async (id: string): Promise<Subscription | null> => {
    try {
        return await request<Subscription>(`/subscriptions/${id}`);
    } catch {
        return null;
    }
};

export const createSubscription = async (subscription: Partial<Subscription>): Promise<Subscription> => {
    return request<Subscription>('/subscriptions', {
        method: 'POST',
        body: JSON.stringify(subscription),
    });
};

export const updateSubscription = async (id: string, subscription: Partial<Subscription>): Promise<Subscription> => {
    return request<Subscription>(`/subscriptions/${id}`, {
        method: 'PUT',
        body: JSON.stringify(subscription),
    });
};

export const deleteSubscription = async (id: string): Promise<void> => {
    await request<void>(`/subscriptions/${id}`, {
        method: 'DELETE',
    });
};

// ====================================
// Registration Requests Functions
// ====================================

export interface RegistrationRequest {
    id: string;
    name: string;
    phone: string;
    email?: string | null;
    password_hash?: string;
    grade_id?: string | null;
    group_id?: string | null;
    requested_courses?: string | null;
    status: 'pending' | 'approved' | 'rejected';
    rejection_reason?: string | null;
    created_at?: string;
    updated_at?: string;
    grade_name?: string;
    group_name?: string;
}

export const createRegistrationRequest = async (data: {
    name: string;
    phone: string;
    password: string;
    grade_id?: string | null;
    group_id?: string | null;
    requested_courses?: string[];
    is_offline?: boolean;
}): Promise<{ id: string; message: string }> => {
    return request('/registration-requests', {
        method: 'POST',
        body: JSON.stringify({
            ...data,
            requested_courses: data.requested_courses ? JSON.stringify(data.requested_courses) : null,
        }),
    });
};

export const getRegistrationRequests = async (status?: 'pending' | 'approved' | 'rejected'): Promise<RegistrationRequest[]> => {
    const params = status ? `?status=${status}` : '';
    return request<RegistrationRequest[]>(`/registration-requests${params}`);
};

export const approveRegistrationRequest = async (id: string): Promise<{ user: User; student: Student; message: string }> => {
    return request(`/registration-requests/${id}/approve`, {
        method: 'POST',
    });
};

export const rejectRegistrationRequest = async (id: string, reason?: string): Promise<{ message: string }> => {
    return request(`/registration-requests/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
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

// ====================================
// Lectures Functions (Teacher Lectures)
// ====================================

export interface Lecture {
    id: string;
    course_id: string;
    group_id?: string | null;
    title: string;
    description?: string;
    video_url: string;
    duration_minutes?: number;
    display_order?: number;
    is_free: boolean;
    is_published: boolean;
    created_at?: Date;
    updated_at?: Date;
    course_name?: string;
    course_subject?: string;
    group_name?: string;
}

export const getLectures = async (courseId?: string): Promise<Lecture[]> => {
    const params = courseId ? `?course_id=${courseId}` : '';
    return request<Lecture[]>(`/lectures${params}`);
};

export const getLectureById = async (id: string): Promise<Lecture | null> => {
    try {
        return await request<Lecture>(`/lectures/${id}`);
    } catch {
        return null;
    }
};

export const createLecture = async (lecture: Partial<Lecture>): Promise<Lecture> => {
    return request<Lecture>('/lectures', {
        method: 'POST',
        body: JSON.stringify(lecture),
    });
};

export const updateLecture = async (id: string, lecture: Partial<Lecture>): Promise<Lecture> => {
    return request<Lecture>(`/lectures/${id}`, {
        method: 'PUT',
        body: JSON.stringify(lecture),
    });
};

export const deleteLecture = async (id: string): Promise<void> => {
    await request<void>(`/lectures/${id}`, {
        method: 'DELETE',
    });
};

// ====================================
// Course Materials Functions
// ====================================

export interface CourseMaterial {
    id: string;
    course_id: string;
    title: string;
    description?: string;
    material_type: 'pdf' | 'video' | 'presentation' | 'link' | 'other';
    file_url?: string;
    file_size?: number;
    duration_minutes?: number;
    display_order?: number;
    is_free: boolean;
    is_published: boolean;
    created_at?: Date;
    updated_at?: Date;
    course_name?: string;
    course_subject?: string;
    grade_id?: string;
    group_ids?: string[];
}

export const getMaterials = async (courseId?: string): Promise<CourseMaterial[]> => {
    const params = courseId ? `?course_id=${courseId}` : '';
    return request<CourseMaterial[]>(`/materials${params}`);
};

export const getStudentMaterials = async (studentId: string): Promise<CourseMaterial[]> => {
    return request<CourseMaterial[]>(`/materials/student/${studentId}`);
};

export const getStudentLectures = async (studentId: string): Promise<Lecture[]> => {
    return request<Lecture[]>(`/lectures/student/${studentId}`);
};

export const getMaterialById = async (id: string): Promise<CourseMaterial | null> => {
    try {
        return await request<CourseMaterial>(`/materials/${id}`);
    } catch {
        return null;
    }
};

export const createMaterial = async (material: Partial<CourseMaterial>): Promise<CourseMaterial> => {
    return request<CourseMaterial>('/materials', {
        method: 'POST',
        body: JSON.stringify(material),
    });
};

export const updateMaterial = async (id: string, material: Partial<CourseMaterial>): Promise<CourseMaterial> => {
    return request<CourseMaterial>(`/materials/${id}`, {
        method: 'PUT',
        body: JSON.stringify(material),
    });
};

export const deleteMaterial = async (id: string): Promise<void> => {
    await request<void>(`/materials/${id}`, {
        method: 'DELETE',
    });
};

// Convert Google Drive sharing link to embeddable URL
export const convertDriveUrl = async (url: string): Promise<{
    fileId: string;
    embedUrl: string;
    originalUrl: string;
}> => {
    return request('/materials/convert-drive-url', {
        method: 'POST',
        body: JSON.stringify({ url }),
    });
};

// Attendance functions
export const markAttendance = async (attendance: Partial<Attendance>): Promise<string> => {
    const created = await request<Attendance>('/attendance', {
        method: 'POST',
        body: JSON.stringify(attendance),
    });
    return created.id;
};

export const getAttendanceByDate = async (date: Date, groupId?: string): Promise<Attendance[]> => {
    // Format date as YYYY-MM-DD in local timezone
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
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

// Get exam questions
export const getExamQuestions = async (examId: string) => {
    try {
        console.log('📚 Fetching questions for exam:', examId);
        // Add cache-busting parameter
        const result = await request(`/exams/${examId}/questions?t=${Date.now()}`);
        console.log('✅ Questions fetched successfully:', result);
        return result;
    } catch (error) {
        console.error('❌ Error fetching exam questions:', error);
        return [];
    }
};

// ====================================
// Export all functions
// ====================================

export default {
    // Auth
    signIn,
    signUp,
    getUserByPhone,
    getCurrentUser,
    setAuthToken,
    clearAuthToken,

    // Students
    getStudents,
    getStudentById,
    getStudentByPhone,
    createStudent,
    updateStudent,
    deleteStudent,

    // Registration Requests
    createRegistrationRequest,
    getRegistrationRequests,
    approveRegistrationRequest,
    rejectRegistrationRequest,

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

    // Materials
    getMaterials,
    getMaterialById,
    createMaterial,
    updateMaterial,
    deleteMaterial,
    convertDriveUrl,
};

// ====================================
// Fees Functions
// ====================================

export interface Fee {
    id: string;
    student_name: string;
    phone?: string;
    grade_id?: string;
    grade_name?: string;
    group_id?: string;
    group_name?: string;
    barcode?: string;
    amount: number;
    paid_amount: number;
    remaining_amount?: number;
    status: string;
    payment_method?: string;
    is_offline: boolean;
    notes?: string;
    due_date?: string;
    payment_date?: string;
    receipt_image_url?: string;
    created_at?: string;
    updated_at?: string;
}

export const getFees = async (isOffline?: boolean, status?: string): Promise<Fee[]> => {
    let url = '/fees';
    const params = new URLSearchParams();
    
    if (isOffline !== undefined) {
        params.append('is_offline', isOffline.toString());
    }
    if (status) {
        params.append('status', status);
    }
    
    if (params.toString()) {
        url += `?${params.toString()}`;
    }
    
    return request<Fee[]>(url);
};

export const getFeeById = async (id: string): Promise<Fee | null> => {
    try {
        return await request<Fee>(`/fees/${id}`);
    } catch {
        return null;
    }
};

export const createFee = async (fee: Partial<Fee>): Promise<Fee> => {
    return request<Fee>('/fees', {
        method: 'POST',
        body: JSON.stringify(fee),
    });
};

export const updateFee = async (id: string, fee: Partial<Fee>): Promise<Fee> => {
    return request<Fee>(`/fees/${id}`, {
        method: 'PUT',
        body: JSON.stringify(fee),
    });
};

export const deleteFee = async (id: string): Promise<void> => {
    await request<void>(`/fees/${id}`, {
        method: 'DELETE',
    });
};
