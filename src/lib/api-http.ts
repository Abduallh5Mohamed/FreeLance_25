/**
 * HTTP Client for Backend API
 * Replaces the mock localStorage database with real HTTP requests
 */

// Get API base URL from environment or use relative path
const getApiBaseUrl = (): string => {
    // If VITE_API_URL is defined, use it
    const envApiUrl = import.meta.env.VITE_API_URL;
    if (envApiUrl) {
        console.log('🔗 Using API URL from environment:', envApiUrl);
        return envApiUrl;
    }

    // Use relative path - works with nginx proxy
    console.log('🔗 Using relative /api path');
    return '/api';
};

const API_BASE_URL = getApiBaseUrl();

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

    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers: HeadersInit = {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
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
        const error = await response.json().catch(() => ({ error: 'Request failed', code: undefined }));
        if (response.status === 403 && error.code === 'BILLING_ONLY') {
            try {
                const current = JSON.parse(localStorage.getItem('currentUser') || 'null');
                if (current?.role === 'instructor') localStorage.setItem('currentUser', JSON.stringify({ ...current, billing_only: true }));
            } catch { /* malformed local session will be handled by the auth guard */ }
            if (!['/instructor-subscription', '/instructor-wallet', '/support'].includes(window.location.pathname)) {
                window.location.assign('/instructor-subscription');
            }
        }
        if (response.status === 403 && error.code === 'TENANT_SUSPENDED') {
            clearAuthToken();
            if (window.location.pathname !== '/auth') window.location.assign('/auth');
        }
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
    role: 'admin' | 'teacher' | 'student' | 'instructor' | 'staff';
    is_active: boolean;
    student_id?: string | null;
    accessible_pages?: string[];
    admin_member?: boolean;
    admin_permissions?: string[];
    admin_roles?: string[];
    billing_only?: boolean;
}

export interface AdminDashboardMetric {
    key: string; label: string; value: number | string; href?: string; tone?: string;
}
export interface AdminDashboardQueueItem {
    id: string; title: string; detail?: string; status?: string; created_at?: string; href: string;
}
export interface AdminDashboardData {
    roles: string[]; primary_role: string; title: string; description: string; permissions: string[];
    metrics: AdminDashboardMetric[];
    queues: Array<{ key: string; title: string; href: string; items: AdminDashboardQueueItem[] }>;
}
export const getAdminDashboard = () => request<AdminDashboardData>('/admin/dashboard');

export interface AdminFinanceData {
    generated_at: string; months: number;
    summary: {
        revenue_month: number; revenue_previous_month: number; revenue_growth_percent: number | null;
        revenue_total: number; cash_collected_total: number; topup_cash_collected: number; unused_service_credit: number;
        pending_amount: number; verified_month: number; verified_attempts: number;
        submitted_attempts: number; rejected_attempts: number; payment_approval_rate: number | null;
        average_verified_payment: number; avg_review_hours: number;
        total_subscriptions: number; active_subscriptions: number; pending_subscriptions: number;
        past_due_subscriptions: number; grace_subscriptions: number; expired_subscriptions: number;
        expiring_7_days: number; expiring_30_days: number;
        total_tenants: number; active_tenants: number; suspended_tenants: number; new_tenants_month: number;
        tenant_growth_percent: number | null; instructors: number; students: number; online_students: number;
        offline_students: number; average_students_per_instructor: number; unassigned_students: number;
        tenants_without_subscription: number; duplicate_references: number; invalid_review_timestamps: number;
    };
    trend: Array<{ month_key: string; revenue: number; payments: number; subscriptions_paid: number }>;
    subscription_breakdown: Array<{ label: string; count: number; amount: number }>;
    payment_methods: Array<{ label: string; attempts: number; verified: number; revenue: number }>;
    instructor_portfolio: Array<{ bucket: string; instructors: number; students: number }>;
    recent: Array<{ id: string; business_name: string; amount: string; method: string; reference_number: string; reviewed_at: string }>;
    detailed: boolean; can_export: boolean; can_calculate: boolean; can_export_pdf: boolean;
}
export const getAdminFinance = (months = 12) => request<AdminFinanceData>(`/admin/insights/finance?months=${months}`);
export const downloadAdminFinanceReport = async (months = 12): Promise<void> => {
    const response = await fetch(`${API_BASE_URL}/admin/insights/finance/export?months=${months}`, {
        headers: { Authorization: `Bearer ${getAuthToken() || ''}` },
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'فشل تنزيل التقرير' }));
        throw new Error(error.error || 'فشل تنزيل التقرير');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || 'platform-analytics.csv';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    URL.revokeObjectURL(url);
};
export interface AnalystCalculation {
    id: string; name: string; left_metric: string; operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'percent_of' | 'growth';
    right_metric?: string | null; constant_value?: string | number | null; result_format: 'number' | 'money' | 'percent'; created_at: string;
}
export const getAnalystCalculations = () => request<AnalystCalculation[]>('/admin/insights/finance/calculations');
export const createAnalystCalculation = (data: Omit<AnalystCalculation, 'id' | 'created_at'>) =>
    request<{ id: string }>('/admin/insights/finance/calculations', { method: 'POST', body: JSON.stringify(data) });
export const deleteAnalystCalculation = (id: string) =>
    request<{ success: boolean }>(`/admin/insights/finance/calculations/${id}`, { method: 'DELETE' });
export const recordAnalystPdfExport = (months: number, calculationCount: number) =>
    request<{ recorded: boolean }>('/admin/insights/finance/pdf-export-event', {
        method: 'POST', body: JSON.stringify({ months, calculation_count: calculationCount }),
    });

export interface AdminSecurityData {
    summary: { events_24h: number; admin_changes_24h: number; financial_changes_24h: number };
    events: Array<{ id: string; action: string; resource_type: string; resource_id: string; reason?: string | null; request_id?: string | null; created_at: string; actor_name?: string | null; business_name?: string | null }>;
    page: number; limit: number;
}
export const getAdminSecurity = (page = 1) => request<AdminSecurityData>(`/admin/insights/security?page=${page}`);

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

// SaaS administration APIs use the same authenticated HTTP boundary as legacy pages.
export interface AdminWorkItem {
    id: string;
    type: string;
    title: string;
    priority: string;
    status: string;
    tenant_id?: string | null;
    assigned_team_id?: string | null;
    assigned_admin_id?: string | null;
    due_at?: string | null;
    created_at: string;
}

export const getAdminWorkItems = (page = 1) =>
    request<{ data: AdminWorkItem[]; page: number; limit: number }>(`/admin/work-items?page=${page}`);

export const createAdminWorkItem = (item: {
    type: string; title: string; description?: string; priority: string; tenant_id?: string;
}) => request<{ id: string }>('/admin/work-items', { method: 'POST', body: JSON.stringify(item) });

export const getAdminWorkItem = (id: string) =>
    request<{ item: AdminWorkItem; events: Array<{ id: string; event_type: string; body?: string; created_at: string }> }>(`/admin/work-items/${id}`);

export const addAdminWorkItemComment = (id: string, body: string) =>
    request<{ id: string }>(`/admin/work-items/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });

export interface PlatformPlan {
    id: string; code: string; name: string; duration_months: number; duration_days: number; price?: string; currency: string; is_active: boolean;
}

export interface PlatformTenant {
    id: string; business_name: string; subject_type?: string; status: string; owner_user_id: string; owner_name: string; owner_phone?: string;
    subscription_id?: string | null; subscription_status?: string | null; agreed_price?: string | null;
    period_ends_at?: string | null; legacy_compat: boolean;
}

export const getPlatformPlans = () => request<PlatformPlan[]>('/admin/platform/plans');
export const createPlatformPlan = (data: { code: string; name: string; duration_months: number; duration_days: number; price: string }) =>
    request<{ id: string }>('/admin/platform/plans', { method: 'POST', body: JSON.stringify(data) });
export const getPlatformTenants = (page = 1) =>
    request<{ data: PlatformTenant[]; page: number; limit: number }>(`/admin/platform/tenants?page=${page}`);
export const createPlatformTenant = (data: {
    business_name: string; subject_type: string; owner_name: string; owner_phone: string; owner_email?: string; password: string; plan_id: string;
}) => request<{ tenant_id: string; subscription_id: string; status: string }>('/admin/platform/tenants', {
    method: 'POST', body: JSON.stringify(data),
});
export const createPlatformRenewal = (tenantId: string, planId: string) =>
    request<{ subscription_id: string; status: string }>(`/admin/platform/tenants/${tenantId}/renewals`, {
        method: 'POST', body: JSON.stringify({ plan_id: planId }),
    });
export interface PlatformPayment {
    id: string; subscription_id: string; amount?: string; method?: string; reference_number?: string;
    status: string; submitted_by?: string; created_at: string; tenant_id: string; business_name: string;
}
export const getPlatformPayments = () =>
    request<{ data: PlatformPayment[]; page: number; limit: number }>('/admin/platform/payments');
export const submitPlatformPayment = (subscriptionId: string, data: { amount: string; method: string; reference_number: string }) =>
    request<{ id: string; status: string }>(`/admin/platform/subscriptions/${subscriptionId}/payments`, {
        method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(data),
    });
export const verifyPlatformPayment = (id: string) =>
    request<{ status: string; login_enabled: boolean }>(`/admin/platform/payments/${id}/verify`, { method: 'POST' });
export interface InstructorAccountStatement {
    generated_at: string;
    permissions: {
        can_view_amounts: boolean; can_view_payment_details: boolean; can_manage_billing_profile: boolean;
        can_create_renewal: boolean; can_submit_payment: boolean; can_verify_payment: boolean;
        can_add_note: boolean; can_view_teaching_detail: boolean; can_view_audit: boolean;
    };
    instructor: {
        owner_user_id: string; owner_name: string; owner_phone?: string | null; owner_email?: string | null;
        login_active: boolean; account_created_at: string;
    };
    tenant: { id: string; business_name: string; subject_type?: string | null; status: string; legacy_compat: boolean; created_at: string } | null;
    billing_profile: {
        billing_cycle_day: number; reminder_days_before: number; collection_status: string;
        next_followup_at?: string | null; updated_at?: string | null;
    } | null;
    teaching: { students: number; online_students: number; offline_students: number; lectures: number };
    summary: {
        subscription_periods: number; paid_periods: number; paid_months: number; current_plan?: string | null;
        current_period_months: number; current_status: string; current_starts_at?: string | null;
        current_ends_at?: string | null; next_renewal_at?: string | null; remaining_days?: number | null;
        remaining_months_estimate?: number | null; last_payment_at?: string | null;
        total_contract?: number; total_verified_paid?: number; total_pending?: number;
        total_outstanding?: number; current_due?: number; normalized_monthly_price?: number;
    };
    subscriptions: Array<{
        id: string; status: string; plan_id: string; plan_code: string; plan_name: string; duration_months: number;
        currency: string; starts_at?: string | null; period_ends_at?: string | null; grace_until?: string | null;
        cancel_at_period_end: boolean; created_at: string; updated_at: string; last_verified_at?: string | null;
        verified_payments: number; pending_payments: number; agreed_price?: number; discount_amount?: number;
        amount_due?: number; verified_paid?: number; pending_paid?: number; outstanding?: number;
    }>;
    payments: Array<{
        id: string; subscription_id: string; status: string; created_at: string; reviewed_at?: string | null;
        plan_name: string; duration_months: number; amount?: number; currency?: string; method?: string;
        reference_number?: string | null; rejection_reason?: string | null; submitted_by_name?: string | null;
        reviewed_by_name?: string | null;
    }>;
    notes: Array<{
        id: string; note_type: string; body: string; followup_at?: string | null; created_at: string; created_by_name: string;
    }>;
    audit: Array<{
        id: string; action: string; resource_type: string; resource_id: string; reason?: string | null;
        created_at: string; actor_name?: string | null;
    }>;
    warnings: string[];
}

export const getInstructorAccountStatement = (ownerUserId: string) =>
    request<InstructorAccountStatement>(`/admin/platform/instructors/${ownerUserId}/account`);
export const updateInstructorBillingProfile = (ownerUserId: string, data: {
    billing_cycle_day: number; reminder_days_before: number; collection_status: string; next_followup_at?: string | null;
}) => request<{ updated: boolean }>(`/admin/platform/instructors/${ownerUserId}/billing-profile`, {
    method: 'PATCH', body: JSON.stringify(data),
});
export const addInstructorAccountNote = (ownerUserId: string, data: {
    note_type: string; body: string; followup_at?: string | null;
}) => request<{ id: string }>(`/admin/platform/instructors/${ownerUserId}/account-notes`, {
    method: 'POST', body: JSON.stringify(data),
});
export const redeemTenantInvitation = (token: string, password: string) =>
    request<{ success: boolean }>('/tenant-invitations/redeem', { method: 'POST', body: JSON.stringify({ token, password }) });

export interface MyTenantSubscription {
    tenant_id: string; business_name: string; tenant_status: string; legacy_compat: boolean;
    subscription_id: string | null; subscription_status: string | null; agreed_price: string | null;
    currency: string | null; starts_at: string | null; period_ends_at: string | null;
    grace_until: string | null; plan_name: string | null; duration_months: number | null; duration_days: number | null;
    days_remaining: number | null; grace_seconds_remaining: number | null;
}
export const getMyTenantSubscription = () => request<MyTenantSubscription>('/tenants/me/subscription');

export interface InstructorTopupRequest {
    id: string;
    tenant_id?: string;
    instructor_id?: string;
    instructor_name?: string;
    instructor_phone?: string;
    business_name?: string;
    purpose_code: 'subscription_renewal' | 'other';
    amount: string;
    currency: string;
    method: string;
    reference_number?: string | null;
    paid_at: string;
    notes?: string | null;
    status: 'submitted' | 'verified' | 'rejected';
    rejection_reason?: string | null;
    reviewed_at?: string | null;
    created_at: string;
    duplicate_suspected?: boolean;
    renewal_result?: string | null;
}

export interface InstructorBillingData {
    server_now: string;
    billing_only: boolean;
    tenant: { id: string; business_name: string; status: string; legacy_compat: boolean };
    subscription: null | {
        id: string; status: string; plan_id: string; plan_name: string;
        agreed_price: string; discount_amount: string; charge_amount: number; currency: string;
        starts_at: string | null; period_ends_at: string | null; grace_until: string | null;
        duration_months: number; duration_days: number;
        period_seconds_remaining: number; grace_seconds_remaining: number;
    };
    wallet: { balance: string; updated_at: string | null };
    renewal_intent: null | {
        id: string; status: string; trigger_type: 'topup' | 'manual'; charge_amount: string;
        paid_at: string | null; created_at: string; plan_name: string;
    };
    topups: InstructorTopupRequest[];
}

export const getMyTenantBilling = () => request<InstructorBillingData>('/tenants/me/billing');
export const submitInstructorTopup = (data: FormData, idempotencyKey = crypto.randomUUID()) =>
    request<{ id: string; status: string; duplicate?: boolean }>('/tenants/me/topups', {
        method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: data,
    });
export const getOwnTopupProofUrl = (id: string) =>
    request<{ url: string; expires_in: number }>(`/tenants/me/topups/${id}/proof-url`);
export const requestManualRenewal = () =>
    request<{ id: string; status: string; subscriptionId?: string }>('/tenants/me/renewal-intents/manual', {
        method: 'POST', body: JSON.stringify({ confirmed: true }),
    });
export const cancelRenewalIntent = (id: string) =>
    request<{ status: string }>(`/tenants/me/renewal-intents/${id}/cancel`, { method: 'POST' });

export const getAdminTopups = (filters: { page?: number; status?: string; search?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.page) params.set('page', String(filters.page));
    if (filters.status) params.set('status', filters.status);
    if (filters.search) params.set('q', filters.search);
    const suffix = params.toString() ? `?${params}` : '';
    return request<{ data: InstructorTopupRequest[]; page: number; limit: number; total?: number }>(`/admin/platform/topups${suffix}`);
};

export interface VideoSecurityViolation {
    id: string;
    activity_type: string;
    details?: string;
    violation_score: number;
    violation_weight: number;
    confidence: 'low' | 'medium' | 'high';
    created_at: string;
    masked_ip?: string;
    user_agent?: string;
    student_user_id: string;
    student_name: string;
    video_title?: string;
}

export const getInstructorVideoViolations = () =>
    request<VideoSecurityViolation[]>('/secure-video/instructor/violations');

export const suspendStudentForVideoSecurity = (studentUserId: string, minutes = 30, reason = 'مراجعة مخالفة حماية الفيديو') =>
    request<{ suspended: true; minutes: number }>(`/secure-video/instructor/students/${encodeURIComponent(studentUserId)}/suspend`, {
        method: 'POST', body: JSON.stringify({ minutes, reason }),
    });

export const unsuspendStudentForVideoSecurity = (studentUserId: string) =>
    request<{ suspended: false }>(`/secure-video/instructor/students/${encodeURIComponent(studentUserId)}/unsuspend`, { method: 'POST' });
export const getAdminTopupProofUrl = (id: string) =>
    request<{ url: string; expires_in: number }>(`/admin/platform/topups/${id}/proof-url`);
export const verifyAdminTopup = (id: string) =>
    request<{ status: string; balance: string; renewal?: { status: string } | null }>(`/admin/platform/topups/${id}/verify`, { method: 'POST' });
export const rejectAdminTopup = (id: string, reason: string) =>
    request<{ status: string }>(`/admin/platform/topups/${id}/reject`, {
        method: 'POST', body: JSON.stringify({ reason }),
    });

export interface AdminApproval {
    id: string; action_key: string; resource_id: string; requested_value: { amount: string } | string;
    reason: string; status: string; requested_by: string; created_at: string;
}
export const getAdminApprovals = () => request<AdminApproval[]>('/admin/approvals');
export const requestServiceCreditAdjustment = (data: { instructor_id: string; action_key: string; amount: string; reason: string }) =>
    request<{ id: string; status: string }>('/admin/approvals', { method: 'POST', body: JSON.stringify(data) });
export const approveAdminApproval = (id: string) =>
    request<{ status: string; new_balance: string }>(`/admin/approvals/${id}/approve`, { method: 'POST' });
export const rejectAdminApproval = (id: string, reason: string) =>
    request<{ status: string }>(`/admin/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });

export interface AdminRole { code: string; name: string; }
export interface AdminMember {
    id: string; name: string; email?: string | null; phone?: string | null; is_active: boolean; roles: string;
}
export const getAdminRoles = () => request<AdminRole[]>('/admin/members/roles');
export const getAdminMembers = () => request<AdminMember[]>('/admin/members');
export const createAdminMember = (data: { name: string; phone: string; email?: string; password: string; role_code: string }) =>
    request<{ id: string; role_code: string }>('/admin/members', { method: 'POST', body: JSON.stringify(data) });
export const updateAdminMember = (id: string, data: { role_code?: string; is_active?: boolean; password?: string; reason: string }) =>
    request<{ success: boolean }>(`/admin/members/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const sendAiChatMessage = async (message: string): Promise<string> => {
    const response = await request<{ response: string }>('/ai-chat/chat', {
        method: 'POST',
        body: JSON.stringify({ message }),
    });

    return response.response;
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
    grade_name?: string;
    group_id?: string;
    group_name?: string;
    barcode?: string;
    is_offline: boolean;
    approval_status: 'pending' | 'approved' | 'rejected';
    password?: string;
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

export const deleteUserByStudentId = async (studentId: string): Promise<boolean> => {
    try {
        await request(`/auth/users/student/${studentId}`, { method: 'DELETE' });
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
    schedule_days?: string[] | string | null;
    schedule_time?: string | null;
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
    grade_id?: string | null;
    group_id?: string | null;
    title: string;
    description?: string;
    video_url: string;
    duration_minutes?: number;
    price?: number;
    display_order?: number;
    is_free: boolean;
    is_published: boolean;
    created_at?: Date;
    updated_at?: Date;
    course_name?: string;
    course_subject?: string;
    grade_name?: string;
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
    start_date?: string;
    end_date?: string;
    student_id?: string;
    group_id?: string;
    course_id?: string;
    order?: 'asc' | 'desc';
    limit?: number;
}): Promise<Attendance[]> => {
    const params = new URLSearchParams();
    if (filters?.date) params.append('date', filters.date);
    if (filters?.start_date) params.append('start_date', filters.start_date);
    if (filters?.end_date) params.append('end_date', filters.end_date);
    if (filters?.student_id) params.append('student_id', filters.student_id);
    if (filters?.group_id) params.append('group_id', filters.group_id);
    if (filters?.course_id) params.append('course_id', filters.course_id);
    if (filters?.order) params.append('order', filters.order);
    if (filters?.limit) params.append('limit', String(filters.limit));

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

// ✅ Get exams for student based on their group
export const getStudentExams = async (userId: string): Promise<Exam[]> => {
    return request<Exam[]>(`/exams/student/${userId}`);
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


// Save exam progress (Draft)
export const saveExamProgress = async (
    examId: string,
    studentId: string,
    answers: Record<string, unknown>,
    essayAnswers?: Record<string, string>,
    answerImages?: Record<string, string>
) => {
    return await request(`/exams/${examId}/save-progress/${studentId}`, {
        method: 'POST',
        body: JSON.stringify({ answers, essayAnswers, answerImages })
    });
};

// Submit exam attempt
export const submitExamAttempt = async (
    examId: string,
    studentId: string,
    answers: Record<string, unknown>,
    score: number,
    essayAnswers?: Record<string, string>,  // ✅ إجابات مقالية
    answerImages?: Record<string, string>,  // ✅ صور الإجابات
    hasEssayQuestions?: boolean             // ✅ وجود أسئلة مقالية
) => {
    return await request(`/exams/${examId}/submit/${studentId}`, {
        method: 'POST',
        body: JSON.stringify({ answers, score, essayAnswers, answerImages, hasEssayQuestions })
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

// Get exam results (admin/teacher)
export const getExamResults = async (examId?: string, studentId?: string) => {
    const params = new URLSearchParams();
    if (examId) params.append('exam_id', examId);
    if (studentId) params.append('student_id', studentId);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    return await request(`/exam-results${queryString}`);
};

// Get exam results for a specific student
export const getStudentExamResults = async (studentId: string) => {
    return await request(`/exam-results/student/${studentId}`);
};

// ====================================
// Messages API
// ====================================

// Get recent messages for a user (conversations)
export const getRecentMessages = async () => {
    try {
        return await request(`/messages/conversations`);
    } catch (error) {
        console.error('Error fetching recent messages:', error);
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
    getStudentExams,
    getStudentExamResults,
    getExamResults,

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
    student_id?: string;
    student_name: string;
    phone?: string;
    guardian_phone?: string;
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
    payment_year?: number;
    payment_month?: number;
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
    subscription_plan_id?: string | null;
    subscription_plan_name?: string | null;
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

export const deleteSubscriptionRequest = async (id: number): Promise<{ message: string }> => {
    return request<{ message: string }>(`/subscription-requests/${id}`, {
        method: 'DELETE',
    });
};

export const cleanupApprovedRequestsByMonth = async (month: number, year: number): Promise<{ message: string; deletedCount: number }> => {
    return request<{ message: string; deletedCount: number }>(`/subscription-requests/cleanup/month?month=${month}&year=${year}`, {
        method: 'DELETE',
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
// ==================== Staff ====================
export interface Staff {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    role: string;
    accessible_pages: string[];
    is_active: boolean;
    created_at?: string;
    updated_at?: string;
}

export const getStaff = async (): Promise<Staff[]> => {
    return request<Staff[]>('/staff', {
        method: 'GET',
    });
};

export const getStaffById = async (id: string): Promise<Staff | null> => {
    try {
        return await request<Staff>(`/staff/${id}`, {
            method: 'GET',
        });
    } catch {
        return null;
    }
};

export const createStaff = async (staffData: {
    name: string;
    email?: string;
    phone: string;
    password: string;
    accessible_pages: string[];
}): Promise<Staff> => {
    return request<Staff>('/staff', {
        method: 'POST',
        body: JSON.stringify(staffData),
    });
};

export const updateStaff = async (id: string, staffData: {
    name?: string;
    email?: string;
    phone?: string;
    password?: string;
    accessible_pages?: string[];
}): Promise<Staff> => {
    return request<Staff>(`/staff/${id}`, {
        method: 'PUT',
        body: JSON.stringify(staffData),
    });
};

export const deleteStaff = async (id: string): Promise<void> => {
    await request<void>(`/staff/${id}`, {
        method: 'DELETE',
    });
};

// ==================== Premium Lectures ====================
export interface PremiumLecture {
    id: string;
    title: string;
    description?: string;
    video_url: string;
    thumbnail_url?: string;
    duration_minutes?: number;
    price: number;
    grade_id?: string;
    group_id?: string;
    is_published: boolean;
    created_by?: string;
    created_at?: string;
    updated_at?: string;
    grade_name?: string;
    group_name?: string;
    enrolled_count?: number;
    pending_payments?: number;
    // For student view
    access_id?: string;
    payment_id?: string;
    payment_status?: 'pending' | 'approved' | 'rejected';
    granted_at?: string;
}

export interface PremiumLecturePayment {
    id: string;
    student_id: string;
    premium_lecture_id: string;
    receipt_image_url: string;
    amount: number;
    status: 'pending' | 'approved' | 'rejected';
    notes?: string;
    rejection_reason?: string;
    reviewed_by?: string;
    reviewed_at?: string;
    created_at?: string;
    updated_at?: string;
    // Joined data
    lecture_title?: string;
    lecture_price?: number;
    student_name?: string;
    student_phone?: string;
    grade_name?: string;
    group_name?: string;
}

// Get all premium lectures (for teacher)
export const getPremiumLectures = async (params?: { grade_id?: string; group_id?: string }): Promise<PremiumLecture[]> => {
    const searchParams = new URLSearchParams();
    if (params?.grade_id) searchParams.append('grade_id', params.grade_id);
    if (params?.group_id) searchParams.append('group_id', params.group_id);
    const queryStr = searchParams.toString();
    return request<PremiumLecture[]>(`/premium-lectures${queryStr ? '?' + queryStr : ''}`);
};

// Get single premium lecture
export const getPremiumLecture = async (id: string): Promise<PremiumLecture> => {
    return request<PremiumLecture>(`/premium-lectures/${id}`);
};

// Create premium lecture
export const createPremiumLecture = async (lecture: Omit<PremiumLecture, 'id' | 'created_at' | 'updated_at'>): Promise<PremiumLecture> => {
    return request<PremiumLecture>('/premium-lectures', {
        method: 'POST',
        body: JSON.stringify(lecture),
    });
};

// Update premium lecture
export const updatePremiumLecture = async (id: string, lecture: Partial<PremiumLecture>): Promise<PremiumLecture> => {
    return request<PremiumLecture>(`/premium-lectures/${id}`, {
        method: 'PUT',
        body: JSON.stringify(lecture),
    });
};

// Delete premium lecture
export const deletePremiumLecture = async (id: string): Promise<void> => {
    await request<void>(`/premium-lectures/${id}`, {
        method: 'DELETE',
    });
};

// Get available premium lectures for student
export const getStudentAvailablePremiumLectures = async (studentId: string): Promise<PremiumLecture[]> => {
    return request<PremiumLecture[]>(`/premium-lectures/student/${studentId}/available`);
};

// Get student's purchased premium lectures
export const getStudentPurchasedPremiumLectures = async (studentId: string): Promise<PremiumLecture[]> => {
    return request<PremiumLecture[]>(`/premium-lectures/student/${studentId}/purchased`);
};

// Submit payment request with receipt
export const submitPremiumLecturePayment = async (formData: FormData): Promise<PremiumLecturePayment> => {
    const token = localStorage.getItem('authToken');
    const response = await fetch(`${API_BASE_URL}/premium-lectures/payments`, {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        body: formData,
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
};

// Get student's payment requests
export const getStudentPremiumPayments = async (studentId: string): Promise<PremiumLecturePayment[]> => {
    return request<PremiumLecturePayment[]>(`/premium-lectures/payments/student/${studentId}`);
};

// Get pending payments (for teacher)
export const getPendingPremiumPayments = async (): Promise<PremiumLecturePayment[]> => {
    return request<PremiumLecturePayment[]>('/premium-lectures/payments/pending');
};

// Get all payments (for teacher)
export const getAllPremiumPayments = async (params?: { status?: string; lecture_id?: string }): Promise<PremiumLecturePayment[]> => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.append('status', params.status);
    if (params?.lecture_id) searchParams.append('lecture_id', params.lecture_id);
    const queryStr = searchParams.toString();
    return request<PremiumLecturePayment[]>(`/premium-lectures/payments${queryStr ? '?' + queryStr : ''}`);
};

// Approve payment
export const approvePremiumPayment = async (paymentId: string, reviewedBy?: string): Promise<{ success: boolean; message: string }> => {
    return request<{ success: boolean; message: string }>(`/premium-lectures/payments/${paymentId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reviewed_by: reviewedBy }),
    });
};

// Reject payment
export const rejectPremiumPayment = async (paymentId: string, rejectionReason?: string, reviewedBy?: string): Promise<{ success: boolean; message: string }> => {
    return request<{ success: boolean; message: string }>(`/premium-lectures/payments/${paymentId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reviewed_by: reviewedBy, rejection_reason: rejectionReason }),
    });
};

// Check student access to premium lecture
export const checkPremiumLectureAccess = async (studentId: string, lectureId: string): Promise<{ hasAccess: boolean }> => {
    return request<{ hasAccess: boolean }>(`/premium-lectures/access/check/${studentId}/${lectureId}`);
};

// ====================================
// Instructor Management (Admin)
// ====================================

export interface Instructor {
    id: string;
    name: string;
    email?: string | null;
    phone?: string | null;
    is_active: boolean;
    created_at: string;
    wallet_balance: number;
    total_lectures?: number;
    total_students?: number;
}

export interface InstructorStats {
    wallet_balance: number;
    total_lectures: number;
    total_students: number;
    pending_sent_requests: number;
    pending_received_requests: number;
}

export interface InstructorWalletTransaction {
    id: number;
    instructor_id: number;
    type: 'credit' | 'debit';
    amount: number;
    balance_after: number;
    description: string;
    reference_id?: number;
    created_by?: number;
    created_by_name?: string;
    created_at: string;
}

export interface InstructorVideoRequest {
    id: number;
    requester_id: string;
    owner_id: string;
    requested_title: string;
    requested_grade: string;
    requested_group: string;
    status: 'open' | 'awaiting_requester' | 'completed' | 'cancelled_by_requester' | 'cancelled_by_owner' | 'expired' | 'failed_insufficient_balance';
    message?: string;
    expires_at: string;
    completed_at?: string;
    cancellation_reason?: string;
    created_at: string;
    updated_at: string;
    requester_name?: string;
    owner_name?: string;
    active_offer_id?: string;
    active_lecture_id?: string;
    active_video_id?: string;
    active_offer_title?: string;
    active_offer_price?: number;
}

export interface VideoOffer {
    id: string;
    request_id: number;
    lecture_id: string;
    video_id: string;
    title_snapshot: string;
    price_snapshot: number;
    status: 'proposed' | 'rejected' | 'accepted' | 'superseded';
    rejection_reason?: string;
    proposed_at: string;
    decided_at?: string;
    description?: string;
    duration_minutes?: number;
}

export interface ShareableLecture {
    id: string;
    title: string;
    description?: string;
    price: number;
    duration_minutes?: number;
    grade_id?: string;
    grade_name?: string;
    video_id: string;
    preview_duration_seconds: number;
}

export interface SharedLecture {
    shared_lecture_id: number;
    lecture_id: string;
    request_id: number;
    obtained_at: string;
    title: string;
    description?: string;
    video_url?: string;
    duration_minutes?: number;
    owner_name: string;
    gross_amount?: number;
    commission_amount?: number;
    is_published: boolean;
    grade_id?: string;
    grade_name?: string;
    group_ids: string[];
    group_names: string[];
}

// Get all instructors
export const getInstructors = async (): Promise<Instructor[]> => {
    return request<Instructor[]>('/instructors');
};

// Get single instructor
export const getInstructor = async (id: string): Promise<Instructor> => {
    return request<Instructor>(`/instructors/${id}`);
};

// Get instructor stats
export const getInstructorStats = async (id: string): Promise<InstructorStats> => {
    return request<InstructorStats>(`/instructors/${id}/stats`);
};

// Get instructor's lectures
export const getInstructorLectures = async (id: string): Promise<any[]> => {
    return request<any[]>(`/instructors/${id}/lectures`);
};

// Create a lecture for an instructor
export const createInstructorLecture = async (data: {
    instructor_id: string;
    title: string;
    description?: string;
    video_url: string;
    grade_id?: string;
    group_id?: string;
    duration_minutes?: number;
    price: number;
    is_free?: boolean;
}): Promise<any> => {
    return request('/lectures', {
        method: 'POST',
        body: JSON.stringify({
            ...data,
            is_published: true,
        }),
    });
};

// Get instructor's students
export const getInstructorStudents = async (id: string): Promise<any[]> => {
    return request<any[]>(`/instructors/${id}/students`);
};

// Create instructor
export const createInstructor = async (data: {
    name: string; email?: string; phone?: string; password: string;
}): Promise<Instructor> => {
    return request<Instructor>('/instructors', {
        method: 'POST',
        body: JSON.stringify(data),
    });
};

// Update instructor
export const updateInstructor = async (id: string, data: Partial<{
    name: string; email: string; phone: string; password: string; is_active: boolean;
}>): Promise<{ message: string }> => {
    return request<{ message: string }>(`/instructors/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
};

// Delete instructor
export const deleteInstructor = async (id: string): Promise<{ message: string }> => {
    return request<{ message: string }>(`/instructors/${id}`, { method: 'DELETE' });
};

// ====================================
// Instructor Wallet
// ====================================

export const getInstructorWallet = async (instructorId: string): Promise<{
    instructor_id: string;
    balance: number;
    last_updated: string;
    summary: { total_credited: number; total_debited: number; credit_count: number; debit_count: number };
}> => {
    return request(`/instructor-wallet/${instructorId}`);
};

export const getInstructorWalletTransactions = async (
    instructorId: string,
    page = 1,
    limit = 20,
    type?: 'credit' | 'debit'
): Promise<{ data: InstructorWalletTransaction[]; pagination: any }> => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (type) params.append('type', type);
    return request(`/instructor-wallet/${instructorId}/transactions?${params}`);
};

export const creditInstructorWallet = async (
    instructorId: string,
    amount: number,
    description?: string,
    created_by?: string
): Promise<{ message: string; new_balance: number }> => {
    return request(`/instructor-wallet/${instructorId}/credit`, {
        method: 'POST',
        body: JSON.stringify({ amount, description, created_by }),
    });
};

export const debitInstructorWallet = async (
    instructorId: string,
    amount: number,
    description?: string,
    created_by?: string
): Promise<{ message: string; new_balance: number }> => {
    return request(`/instructor-wallet/${instructorId}/debit`, {
        method: 'POST',
        body: JSON.stringify({ amount, description, created_by }),
    });
};

// ====================================
// Instructor Video Requests
// ====================================

export const getAllVideoRequests = async (status?: string): Promise<InstructorVideoRequest[]> => {
    const params = status ? `?status=${status}` : '';
    return request<InstructorVideoRequest[]>(`/instructor-video-requests${params}`);
};

export const getAvailableLecturesForRequest = async (instructorId: string): Promise<any[]> => {
    void instructorId;
    return [];
};

export const reprocessVideo = async (videoId: string): Promise<{ success: boolean; message: string }> => {
    return request(`/videos/${videoId}/reprocess`, { method: 'POST' });
};

export const getMySentRequests = async (instructorId: string): Promise<InstructorVideoRequest[]> => {
    void instructorId;
    return request<InstructorVideoRequest[]>('/instructor-video-requests/mine?direction=sent');
};

export const getReceivedRequests = async (instructorId: string): Promise<InstructorVideoRequest[]> => {
    void instructorId;
    return request<InstructorVideoRequest[]>('/instructor-video-requests/mine?direction=received');
};

export const getSharedWithMe = async (instructorId: string): Promise<SharedLecture[]> => {
    void instructorId;
    return request<SharedLecture[]>('/instructor-video-requests/library/shared');
};

export const sendVideoRequest = async (data: {
    owner_id: string;
    requested_title: string;
    requested_grade: string;
    requested_group: string;
    message?: string;
}): Promise<{ id: number; expires_in_hours: number }> => {
    return request<{ id: number; expires_in_hours: number }>('/instructor-video-requests', {
        method: 'POST',
        body: JSON.stringify(data),
    });
};

export const searchVideoRequestInstructors = (q: string) => request<Array<{ id: string; name: string; phone?: string }>>(`/instructor-video-requests/search-instructors?q=${encodeURIComponent(q)}`);
export const getShareableLectures = () => request<ShareableLecture[]>('/instructor-video-requests/shareable-lectures');
export const getVideoRequestOffers = (requestId: number) => request<VideoOffer[]>(`/instructor-video-requests/${requestId}/offers`);
export const proposeVideoOffer = (requestId: number, lectureId: string) => request<{ id: string; expires_in_hours: number }>(`/instructor-video-requests/${requestId}/offers`, { method: 'POST', body: JSON.stringify({ lecture_id: lectureId }) });
export const getVideoOfferPreview = (offerId: string) => request<{
    url?: string;
    player_url?: string;
    provider?: 'vdocipher';
    title: string;
    price: number;
    duration_seconds: number;
    expires_in: number;
}>(`/instructor-video-requests/offers/${offerId}/preview`);
export const rejectVideoOffer = (offerId: string, reason: string) => request<{ status: string }>(`/instructor-video-requests/offers/${offerId}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
export const acceptVideoOffer = (offerId: string) => request<{ status: string; purchase_id: string; gross: number; commission: number; seller_net: number }>(`/instructor-video-requests/offers/${offerId}/accept`, { method: 'POST' });
export const cancelVideoRequest = (requestId: number, reason?: string) => request<{ status: string }>(`/instructor-video-requests/${requestId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
export const publishSharedLecture = (sharedId: number, gradeId: string, groupIds: string[]) => request<{ published: boolean }>(`/instructor-video-requests/library/shared/${sharedId}/publications`, { method: 'PUT', body: JSON.stringify({ grade_id: gradeId, group_ids: groupIds }) });

export const getVideoCommission = () => request<{ percent: number; updated_at: string | null; can_manage: boolean }>('/admin/insights/video-commission');
export const updateVideoCommission = (percent: number) => request<{ percent: number }>('/admin/insights/video-commission', { method: 'PUT', body: JSON.stringify({ percent }) });

// ====================================
// Tenant-scoped student enrollment
// ====================================
export interface EnrollmentInviteInfo {
    business_name: string;
    subject_type?: string;
    expires_at: string;
    grades: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string; grade_id: string; course_id?: string | null }>;
    courses: Array<{ id: string; name: string; grade?: string | null }>;
}
export interface EnrollmentRequest {
    id: string; student_name: string; phone: string; guardian_name: string; guardian_phone: string;
    grade_id: string; group_id: string; requested_courses?: string | string[] | null;
    grade_name?: string; group_name?: string; status: 'pending' | 'approved' | 'rejected' | 'expired';
    rejection_reason?: string | null; created_at: string;
}
export interface StudentSpace {
    student_enrollment_id: string; tenant_id: string; business_name: string;
    grade_id?: string; group_id?: string; grade_name?: string; group_name?: string;
}
export interface StudentPasswordResetRequest {
    id: string; status: 'pending' | 'approved' | 'used' | 'rejected' | 'expired';
    name: string; phone: string; created_at: string;
}
export const getEnrollmentInviteInfo = (token: string) =>
    request<EnrollmentInviteInfo>(`/student-enrollment/join/${encodeURIComponent(token)}`);
export const submitEnrollmentRequest = (token: string, data: {
    student_name: string; phone: string; guardian_name: string; guardian_phone: string;
    password?: string; grade_id: string; group_id: string; requested_courses?: string[];
}) => request<{ message: string }>(`/student-enrollment/join/${encodeURIComponent(token)}/requests`, {
    method: 'POST', body: JSON.stringify(data),
});
export const rotateStudentInvite = () => request<{ id: string; token: string; expires_in_days: number }>(
    '/student-enrollment/invites/rotate', { method: 'POST' }
);
export const getCurrentStudentInvite = () => request<{ id: string; expires_at: string; created_at: string } | null>(
    '/student-enrollment/invites/current'
);
export const getEnrollmentRequests = () => request<EnrollmentRequest[]>('/student-enrollment/requests');
export const approveEnrollmentRequest = (id: string, data: { grade_id?: string; group_id?: string; requested_courses?: string[] } = {}) =>
    request<{ status: string; student_enrollment_id: string }>(`/student-enrollment/requests/${id}/approve`, { method: 'POST', body: JSON.stringify(data) });
export const rejectEnrollmentRequest = (id: string, reason: string) =>
    request<{ status: string }>(`/student-enrollment/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
export const getStudentSpaces = () => request<StudentSpace[]>('/student-enrollment/spaces');
export const selectStudentSpace = async (studentEnrollmentId: string) => {
    const result = await request<{ token: string; tenant_id: string; student_enrollment_id: string }>(
        `/student-enrollment/spaces/${studentEnrollmentId}/select`, { method: 'POST' }
    );
    setAuthToken(result.token);
    return result;
};
export const getCurrentStudentEnrollment = () => request<Student & { tenant_id: string; business_name: string }>('/students/me');
export const requestStudentPasswordReset = (inviteToken: string, phone: string) =>
    request<{ message: string }>(`/student-enrollment/join/${encodeURIComponent(inviteToken)}/password-reset`, {
        method: 'POST', body: JSON.stringify({ phone }),
    });
export const getStudentPasswordResetRequests = () =>
    request<StudentPasswordResetRequest[]>('/student-enrollment/password-resets');
export const approveStudentPasswordReset = (id: string) =>
    request<{ reset_token: string; expires_in_minutes: number }>(`/student-enrollment/password-resets/${id}/approve`, { method: 'POST' });
export const completeStudentPasswordReset = (token: string, password: string) =>
    request<{ success: boolean }>('/student-enrollment/password-resets/complete', {
        method: 'POST', body: JSON.stringify({ token, password }),
    });

// ====================================
// Support Tickets
// ====================================

export type SupportCategory = 'technical' | 'account' | 'billing' | 'content' | 'exam' | 'video' | 'other';
export type SupportStatus = 'open' | 'waiting_on_support' | 'waiting_on_user' | 'resolved' | 'closed';

export interface SupportTicket {
    id: string;
    ticket_number: string;
    user_id?: string;
    user_name?: string;
    user_phone?: string;
    category: SupportCategory;
    subject: string;
    description?: string;
    status: SupportStatus;
    priority: 'low' | 'normal' | 'high' | 'urgent';
    created_at: string;
    updated_at: string;
}

export interface SupportReply {
    id: string;
    sender_id: string;
    sender_name: string;
    sender_role: string;
    body: string;
    created_at: string;
}

export const createSupportTicket = (data: { category: SupportCategory; subject: string; description: string }) =>
    request<SupportTicket>('/support-tickets', { method: 'POST', body: JSON.stringify(data) });

export const getMySupportTickets = () => request<SupportTicket[]>('/support-tickets/mine');

export const getSupportQueue = (filters?: { status?: SupportStatus; category?: SupportCategory }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.category) params.set('category', filters.category);
    const query = params.toString();
    return request<SupportTicket[]>(`/support-tickets${query ? `?${query}` : ''}`);
};

export const getSupportTicket = (id: string) =>
    request<{ ticket: SupportTicket; replies: SupportReply[] }>(`/support-tickets/${id}`);

export const replyToSupportTicket = (id: string, body: string) =>
    request<SupportReply>(`/support-tickets/${id}/replies`, { method: 'POST', body: JSON.stringify({ body }) });

export const updateSupportTicketStatus = (id: string, status: SupportStatus) =>
    request<{ success: boolean; status: SupportStatus }>(`/support-tickets/${id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
    });
