/**
 * HTTP Client for Backend API
 * Replaces the mock localStorage database with real HTTP requests
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://deeppink-woodpecker-473963.hostingersite.com/api';

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
        console.log('🔐 signIn: Attempting login with phone:', phone);
        const response = await request<{ user: User; token: string }>('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ phone, password }),
        });

        console.log('🔐 signIn: Response received:', { user: response.user, hasToken: !!response.token });

        if (response.token) {
            setAuthToken(response.token);
            localStorage.setItem('currentUser', JSON.stringify(response.user));
            console.log('🔐 signIn: Token and user stored in localStorage');
        }

        return { user: response.user, error: null, token: response.token };
    } catch (error) {
        console.error('🔐 signIn: Login failed:', error);
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
    guardian_phone?: string;
    grade?: string;
    grade_id?: string;
    group_id?: string;
    barcode?: string;
    is_offline: boolean;
    approval_status: 'pending' | 'approved' | 'rejected';
}

export const getStudents = async (): Promise<Student[]> => {
    return await request<Student[]>('/students');
};

export const getStudentById = async (id: string): Promise<Student | null> => {
    try {
        return await request<Student>(`/students/${id}`);
    } catch (e) {
        return null;
    }
};

export const getStudentByEmail = async (email: string): Promise<Student | null> => {
    try {
        return await request<Student>(`/students/email/${email}`);
    } catch (e) {
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
    return request<Subscription[]>('/subscription-plans');
};

export const getSubscriptionById = async (id: string): Promise<Subscription | null> => {
    try {
        return await request<Subscription>(`/subscription-plans/${id}`);
    } catch {
        return null;
    }
};

export const createSubscription = async (subscription: Partial<Subscription>): Promise<Subscription> => {
    return request<Subscription>('/subscription-plans', {
        method: 'POST',
        body: JSON.stringify(subscription),
    });
};

export const updateSubscription = async (id: string, subscription: Partial<Subscription>): Promise<Subscription> => {
    return request<Subscription>(`/subscription-plans/${id}`, {
        method: 'PUT',
        body: JSON.stringify(subscription),
    });
};

export const deleteSubscription = async (id: string): Promise<void> => {
    await request<void>(`/subscription-plans/${id}`, {
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
    guardian_phone?: string; // رقم ولي الأمر
    grade_id?: string | null;
    group_id?: string | null;
    requested_courses?: string[];
    is_offline?: boolean;
}): Promise<{ id: string; message: string }> => {
    return request('/registration-requests', {
        method: 'POST',
        body: JSON.stringify({
            ...data,
            // send array directly; backend will JSON.stringify as needed
            requested_courses: data.requested_courses && data.requested_courses.length > 0 ? data.requested_courses : null,
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
    barcode?: string;
    attendance_time?: string;
    method?: string;
    student_name?: string;
    student_barcode?: string;
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
export const getExams = async (courseId?: string, studentId?: string): Promise<Exam[]> => {
    const params = new URLSearchParams();
    if (courseId) params.append('course_id', courseId);
    if (studentId) params.append('student_id', studentId);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return request<Exam[]>(`/exams${queryString}`);
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

// Check if student can attempt exam
export const canAttemptExam = async (examId: string, studentId: string) => {
    return await request(`/exams/${examId}/can-attempt/${studentId}`);
};

// Start exam attempt
export const startExamAttempt = async (examId: string, studentId: string) => {
    return await request(`/exams/${examId}/start/${studentId}`, {
        method: 'POST'
    });
};

// Submit exam attempt
export const submitExamAttempt = async (examId: string, studentId: string, answers: Record<string, unknown>, score: number) => {
    return await request(`/exams/${examId}/submit/${studentId}`, {
        method: 'POST',
        body: JSON.stringify({ answers, score })
    });
};

// Get exam attempts (admin)
export const getExamAttempts = async (examId: string) => {
    return await request(`/exams/${examId}/attempts`);
};

// Get students who haven't attempted exam (admin)
export const getNotAttemptedStudents = async (examId: string) => {
    return await request(`/exams/${examId}/not-attempted`);
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

export const searchFeesByPhone = async (phone: string): Promise<Fee[]> => {
    const params = new URLSearchParams({ phone });
    return request<Fee[]>(`/fees?${params.toString()}`);
};

export const searchFeesByName = async (name: string): Promise<Fee[]> => {
    const params = new URLSearchParams({ name });
    return request<Fee[]>(`/fees?${params.toString()}`);
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

// ============= Revenues API =============

export interface Revenue {
    id: string;
    student_name: string;
    student_phone?: string;
    student_barcode?: string;
    fee_id?: string;
    amount: number;
    payment_method: 'cash' | 'bank' | 'card' | 'online';
    payment_type: 'fee' | 'subscription' | 'course' | 'other';
    description?: string;
    notes?: string;
    payment_date: string;
    receipt_image_url?: string;
    created_at: string;
}

export const getRevenues = async (params?: {
    start_date?: string;
    end_date?: string;
    payment_type?: string;
    student_name?: string;
}): Promise<Revenue[]> => {
    const queryParams = new URLSearchParams();
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value) queryParams.append(key, value);
        });
    }
    const queryString = queryParams.toString();
    return request<Revenue[]>(`/revenues${queryString ? `?${queryString}` : ''}`);
};

export const getRevenueById = async (id: string): Promise<Revenue | null> => {
    try {
        return await request<Revenue>(`/revenues/${id}`);
    } catch {
        return null;
    }
};

export const createRevenue = async (revenue: Partial<Revenue>): Promise<Revenue> => {
    return request<Revenue>('/revenues', {
        method: 'POST',
        body: JSON.stringify(revenue),
    });
};

export const getRevenueSummary = async (params?: {
    start_date?: string;
    end_date?: string;
}): Promise<{ total: number }> => {
    const queryParams = new URLSearchParams();
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value) queryParams.append(key, value);
        });
    }
    const queryString = queryParams.toString();
    return request<{ total: number }>(`/revenues/summary/total${queryString ? `?${queryString}` : ''}`);
};

export const deleteRevenue = async (id: string): Promise<void> => {
    await request<void>(`/revenues/${id}`, {
        method: 'DELETE',
    });
};

// ====================================
// Payment Requests Functions
// ====================================

export interface PaymentRequest {
    id?: number;
    student_id: string;
    grade_id: string;
    group_id: string;
    amount: number;
    payment_method?: string;
    status?: 'pending' | 'approved' | 'rejected';
    receipt_image_url?: string;
    notes?: string;
    rejection_reason?: string;
    student_name?: string;
    student_phone?: string;
    grade_name?: string;
    group_name?: string;
    created_at?: string;
    updated_at?: string;
}

export const getPaymentRequests = async (filters?: {
    status?: string;
    student_id?: string;
}): Promise<PaymentRequest[]> => {
    const queryParams = new URLSearchParams();
    if (filters?.status) queryParams.append('status', filters.status);
    if (filters?.student_id) queryParams.append('student_id', filters.student_id);

    const queryString = queryParams.toString();
    return request<PaymentRequest[]>(`/payment-requests${queryString ? `?${queryString}` : ''}`);
};

export const createPaymentRequest = async (data: Partial<PaymentRequest>): Promise<{ message: string; id: number }> => {
    return request<{ message: string; id: number }>('/payment-requests', {
        method: 'POST',
        body: JSON.stringify(data),
    });
};

export const approvePaymentRequest = async (id: number): Promise<{ message: string }> => {
    return request<{ message: string }>(`/payment-requests/${id}/approve`, {
        method: 'POST',
    });
};

export const rejectPaymentRequest = async (id: number, rejection_reason: string): Promise<{ message: string }> => {
    return request<{ message: string }>(`/payment-requests/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejection_reason }),
    });
};

export const getPaymentRequestsStats = async (): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    total_approved_amount: number;
}> => {
    return request('/payment-requests/stats/summary');
};

// ====================================
// Notifications Functions
// ====================================

export interface Notification {
    id: number;
    user_id: number;
    user_type: 'student' | 'admin' | 'teacher';
    title: string;
    message: string;
    type: string;
    is_read: boolean;
    created_at: string;
}

export const getNotifications = async (filters?: {
    user_id?: number;
    user_type?: string;
    is_read?: boolean;
}): Promise<Notification[]> => {
    const queryParams = new URLSearchParams();
    if (filters?.user_id) queryParams.append('user_id', filters.user_id.toString());
    if (filters?.user_type) queryParams.append('user_type', filters.user_type);
    if (filters?.is_read !== undefined) queryParams.append('is_read', filters.is_read.toString());

    const queryString = queryParams.toString();
    return request<Notification[]>(`/notifications${queryString ? `?${queryString}` : ''}`);
};

export const markNotificationAsRead = async (id: number): Promise<{ message: string }> => {
    return request<{ message: string }>(`/notifications/${id}/read`, {
        method: 'PUT',
    });
};

export const markAllNotificationsAsRead = async (user_id: number, user_type: string): Promise<{ message: string }> => {
    return request<{ message: string }>('/notifications/read-all', {
        method: 'PUT',
        body: JSON.stringify({ user_id, user_type }),
    });
};

export const getUnreadNotificationsCount = async (user_id: number, user_type: string): Promise<{ count: number }> => {
    return request<{ count: number }>(`/notifications/unread-count?user_id=${user_id}&user_type=${user_type}`);
};

// ====================================
// Subscription Requests Functions
// ====================================

export interface SubscriptionRequest {
    id?: number;
    student_name: string;
    phone: string;
    guardian_phone?: string;
    grade_id?: number | null;
    grade_name?: string | null;
    group_id?: number | null;
    group_name?: string | null;
    amount?: number | null;
    notes?: string | null;
    receipt_image_url?: string | null;
    status?: 'pending' | 'approved' | 'rejected';
    rejection_reason?: string | null;
    created_at?: string;
    updated_at?: string;
}

export const getSubscriptionRequests = async (filters?: {
    status?: string;
}): Promise<SubscriptionRequest[]> => {
    const queryParams = new URLSearchParams();
    if (filters?.status) queryParams.append('status', filters.status);

    const queryString = queryParams.toString();
    return request<SubscriptionRequest[]>(`/subscription-requests${queryString ? `?${queryString}` : ''}`);
};

export const createSubscriptionRequest = async (data: Omit<SubscriptionRequest, 'id' | 'status' | 'created_at' | 'updated_at'>): Promise<{ message: string }> => {
    return request<{ message: string }>('/subscription-requests', {
        method: 'POST',
        body: JSON.stringify(data),
    });
};

export const approveSubscriptionRequest = async (id: number): Promise<{ message: string }> => {
    return request<{ message: string }>(`/subscription-requests/${id}/approve`, {
        method: 'POST',
    });
};

export const rejectSubscriptionRequest = async (id: number, rejection_reason: string): Promise<{ message: string }> => {
    return request<{ message: string }>(`/subscription-requests/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ rejection_reason }),
    });
};

// ==================== Expenses ====================
export interface Expense {
    id: string;
    description: string;
    amount: number;
    category: string;
    date: string;
    time: string;
    created_at?: string;
    updated_at?: string;
}

export const getExpenses = async (): Promise<Expense[]> => {
    return request<Expense[]>('/expenses', {
        method: 'GET',
    });
};

export const createExpense = async (expense: Omit<Expense, 'id' | 'created_at' | 'updated_at'>): Promise<Expense> => {
    return request<Expense>('/expenses', {
        method: 'POST',
        body: JSON.stringify(expense),
    });
};

export const updateExpense = async (id: string, expense: Partial<Expense>): Promise<Expense> => {
    return request<Expense>(`/expenses/${id}`, {
        method: 'PUT',
        body: JSON.stringify(expense),
    });
};

export const deleteExpense = async (id: string): Promise<void> => {
    await request<void>(`/expenses/${id}`, {
        method: 'DELETE',
    });
};

// ==================== Imports ====================
export interface Import {
    id: string;
    supplier_name: string;
    supplier_phone: string;
    import_date: string;
    payment_method: string;
    total_amount: number;
    paid_amount: number;
    remaining_amount?: number;
    notes?: string;
    items?: ImportItem[];
    created_at?: string;
    updated_at?: string;
}

export interface ImportItem {
    id?: string;
    import_id?: string;
    item_code: string;
    item_name: string;
    quantity: number;
    unit_price: number;
    total_price?: number;
}

export const getImports = async (): Promise<Import[]> => {
    return request<Import[]>('/imports', {
        method: 'GET',
    });
};

export const createImport = async (importData: Omit<Import, 'id' | 'created_at' | 'updated_at'>): Promise<Import> => {
    return request<Import>('/imports', {
        method: 'POST',
        body: JSON.stringify(importData),
    });
};

export const updateImport = async (id: string, importData: Partial<Import>): Promise<Import> => {
    return request<Import>(`/imports/${id}`, {
        method: 'PUT',
        body: JSON.stringify(importData),
    });
};

export const deleteImport = async (id: string): Promise<void> => {
    await request<void>(`/imports/${id}`, {
        method: 'DELETE',
    });
};
