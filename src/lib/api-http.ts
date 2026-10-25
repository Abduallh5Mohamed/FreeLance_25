/**
 * HTTP Client for Backend API
 * Replaces the mock localStorage database with real HTTP requests
 */

import { notifySessionChange } from './session-events';

// Get API base URL from environment or use relative path
const getApiBaseUrl = (): string => {
    // If VITE_API_URL is defined, use it. The optional chain keeps this
    // module importable outside Vite (hermetic tests exercise the real
    // canonical writers); under Vite `import.meta.env` always exists.
    const envApiUrl = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL;
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

// Guards subscribe to local changes as well as cross-tab storage events.
export const AUTH_SESSION_CHANGED_EVENT = 'auth-session-changed';
let authRevision = 0;
const publishAuthSessionChanged = () => {
    authRevision += 1;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new Event(AUTH_SESSION_CHANGED_EVENT));
    }
};

// Helper to set auth token
export const setAuthToken = (token: string): void => {
    localStorage.setItem('authToken', token);
    publishAuthSessionChanged();
};

// Helper to clear auth token
export const clearAuthToken = (): void => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentStudent');
    for (const key of ['student_session', 'offlineStudentSession', 'supabaseUser', 'currentStudentSpace']) localStorage.removeItem(key);
    publishAuthSessionChanged();
    notifySessionChange('logout');
};

/** Revoke before discarding the bearer. A local logout is not proof of revocation. */
export const signOutSession = async (): Promise<{ serverRevoked: boolean; warning: string | null; sessionChanged: boolean }> => {
    const token = getAuthToken();
    authRevision += 1;
    const logoutRevision = authRevision;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let serverRevoked = false;
    let sessionChanged = false;
    try {
        if (token) {
            const response = await fetch(`${API_BASE_URL}/auth/logout`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal, cache: 'no-store',
            });
            serverRevoked = response.status === 204;
        }
    } catch {
        // Unknown server outcome; do not report successful revocation.
    } finally {
        clearTimeout(timer);
        sessionChanged = getAuthToken() !== token || authRevision !== logoutRevision;
        if (!sessionChanged) {
            clearAuthToken();
        }
    }
    return {
        serverRevoked,
        sessionChanged,
        warning: token && !serverRevoked
            ? 'تم الخروج من هذا المتصفح، لكن تعذّر تأكيد إبطال الجلسة على الخادم.' : null,
    };
};

const apiErrorMetadata = new WeakMap<Error, { status: number; code?: string }>();

const apiRequestError = (message: string, status: number, code?: string): Error => {
    const error = new Error(message);
    apiErrorMetadata.set(error, { status, code });
    return error;
};
export class ApiRequestError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
        super(message);
        apiErrorMetadata.set(this, { status, code });
    }
}

const protectedResponses = new WeakMap<Response, { token: string; revision: number }>();

/** Protected page transport: canonical server URL/token, no cross-origin bearer forwarding. */
export const authenticatedApiFetch = async (endpoint: string, options: RequestInit = {}): Promise<Response> => {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes(String.fromCharCode(92)) || endpoint.includes('://')) {
        throw new Error('Invalid API endpoint');
    }
    const token = getAuthToken();
    const revision = authRevision;
    if (!token) throw new ApiRequestError('Sign in required', 401, 'SESSION_REQUIRED');
    const headers = new Headers(options.headers);
    headers.set('Authorization', 'Bearer ' + token);
    const response = await fetch(API_BASE_URL + endpoint, { ...options, headers, cache: 'no-store' });
    if (getAuthToken() !== token || authRevision !== revision) {
        throw new ApiRequestError('Session changed during request', 409, 'CLIENT_SESSION_CHANGED');
    }
    protectedResponses.set(response, { token, revision });
    return response;
};

/** Recheck the identity after the response body, not just after its headers. */
export const readAuthenticatedApiJson = async (response: Response): Promise<Awaited<ReturnType<Response['json']>>> => {
    const binding = protectedResponses.get(response);
    if (!binding) throw new Error('Response has no protected session binding');
    const data = await response.json();
    if (getAuthToken() !== binding.token || authRevision !== binding.revision) {
        throw new ApiRequestError('Session changed during response', 409, 'CLIENT_SESSION_CHANGED');
    }
    return data;
};

/** Downloads obey the same post-body session fence as protected JSON. */
export const readAuthenticatedApiBlob = async (response: Response): Promise<Blob> => {
    const binding = protectedResponses.get(response);
    if (!binding) throw new Error('Response has no protected session binding');
    const blob = await response.blob();
    if (getAuthToken() !== binding.token || authRevision !== binding.revision) {
        throw new ApiRequestError('Session changed during download', 409, 'CLIENT_SESSION_CHANGED');
    }
    return blob;
};

interface PlatformStepUpMemory {
    bearer: string; revision: number; token: string; expiresAtMs: number;
}
let platformStepUp: PlatformStepUpMemory | null = null;
export const clearPlatformStepUp = (): void => { platformStepUp = null; };
const currentPlatformStepUp = (): string | null => {
    if (!platformStepUp) return null;
    if (platformStepUp.bearer !== getAuthToken() || platformStepUp.revision !== authRevision
        || Date.now() >= platformStepUp.expiresAtMs) { platformStepUp = null; return null; }
    return platformStepUp.token;
};
const isPlatformSensitiveMutation = (endpoint: string, method: string): boolean =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())
    && (/^\/admin\/(members|approvals)(?:\/|$)/.test(endpoint)
        || /^\/platform\/flags(?:\/|$)/.test(endpoint) || endpoint === '/platform/mfa/disable');

// Generic HTTP request helper
async function request<T>(
    endpoint: string,
    options: RequestInit & { auth?: boolean } = {}
): Promise<T> {
    const { auth = true, ...fetchOptions } = options;
    const token = getAuthToken();
    const requestRevision = authRevision;
    const isCurrentSession = () => getAuthToken() === token && authRevision === requestRevision;

    const isFormData = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData;
    const headers = new Headers(fetchOptions.headers);
    if (!isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    if (auth && token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    if (!auth) { headers.delete('Authorization'); headers.delete('x-mfa-step-up'); }
    if (auth && isPlatformSensitiveMutation(endpoint, options.method || 'GET')) {
        const stepUp = currentPlatformStepUp();
        if (stepUp) headers.set('x-mfa-step-up', stepUp);
    }
    const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...fetchOptions, headers, cache: 'no-store' });

    if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
        const error = {
            error: typeof record.error === 'string' ? record.error : 'Request failed',
            code: typeof record.code === 'string' ? record.code : undefined,
        };
        if (auth && isCurrentSession() && response.status === 403 && error.code === 'BILLING_ONLY') {
            try {
                const current = JSON.parse(localStorage.getItem('currentUser') || 'null');
                if (current?.role === 'instructor') {
                    localStorage.setItem('currentUser', JSON.stringify({ ...current, billing_only: true }));
                    // Same-document identity change (supervisor/026): notify
                    // after the stored identity is rewritten.
                    notifySessionChange('identity');
                }
            } catch { /* malformed local session will be handled by the auth guard */ }
            if (!['/instructor-subscription', '/instructor-wallet', '/support'].includes(window.location.pathname)) {
                window.location.assign('/instructor-subscription');
            }
        }
        if (auth && isCurrentSession() && response.status === 403 && error.code === 'TENANT_SUSPENDED') {
            clearAuthToken();
            if (window.location.pathname !== '/auth') window.location.assign('/auth');
        }
        if (auth && token && isCurrentSession() && response.status === 401
            && !['/auth/login', '/auth/register'].includes(endpoint)) clearAuthToken();
        if (isCurrentSession() && response.status === 403 && error.code
            && (/^MFA_/.test(error.code) || /^STEP_UP_/.test(error.code))) {
            clearPlatformStepUp();
            throw new ApiRequestError('يلزم تحقق إضافي. استخدم لوحة التحقق ثم أعد الإجراء بنفسك؛ مدخلاتك لم تُمسح.', response.status, error.code);
        }
        throw new ApiRequestError(error.error || `HTTP ${response.status}`, response.status, error.code);
    }

    const data = response.status === 204 ? undefined : await response.json();
    if (auth && token && !isCurrentSession()) {
        throw new ApiRequestError('Session changed during response', 409, 'CLIENT_SESSION_CHANGED');
    }
    return data as T;
}

export interface PlatformMfaStatus {
    enrolled: boolean; status: 'none' | 'pending' | 'active'; session_bound: boolean;
    locked?: boolean; locked_until?: string | null;
}
export const getPlatformMfaStatus = async (): Promise<PlatformMfaStatus> => {
    const result = await request<PlatformMfaStatus>('/platform/mfa/status');
    if (!result || !['none', 'pending', 'active'].includes(result.status) || typeof result.session_bound !== 'boolean') throw new Error('تعذّر تأكيد حالة التحقق');
    return result;
};
export const enrollPlatformMfa = async (reason: string) => {
    const result = await request<{ secret: string; otpauth_uri: string; status: string }>('/platform/mfa/enroll', { method: 'POST', body: JSON.stringify({ reason }) });
    if (!result || typeof result.secret !== 'string' || !/^[A-Z2-7]+$/.test(result.secret) || result.status !== 'pending') throw new Error('تعذّر قراءة إعداد التحقق؛ أعد تحميل الحالة قبل المحاولة');
    return result;
};
export const verifyPlatformMfa = async (input: { code?: string; recovery_code?: string }): Promise<string[]> => {
    clearPlatformStepUp();
    const verificationBearer = getAuthToken();
    const verificationRevision = authRevision;
    const result = await request<{ step_up_token: string; step_up_expires_at_ms: number; recovery_codes?: string[] }>('/platform/mfa/verify', { method: 'POST', body: JSON.stringify(input) });
    if (!result || typeof result.step_up_token !== 'string' || !result.step_up_token.startsWith('su2.')
        || result.step_up_token.length > 4096 || !Number.isSafeInteger(result.step_up_expires_at_ms)
        || result.step_up_expires_at_ms <= Date.now()) throw new Error('تعذّر تأكيد صلاحية التحقق');
    const bearer = getAuthToken();
    if (!bearer || bearer !== verificationBearer || authRevision !== verificationRevision) throw new ApiRequestError('Session changed; verify again', 401);
    if (result.recovery_codes !== undefined && (!Array.isArray(result.recovery_codes) || result.recovery_codes.some(code => typeof code !== 'string'))) throw new Error('تعذّر قراءة رموز الاسترداد');
    platformStepUp = { bearer, revision: authRevision, token: result.step_up_token, expiresAtMs: result.step_up_expires_at_ms };
    return result.recovery_codes || [];
};
export const disablePlatformMfa = async (reason: string): Promise<void> => {
    await request('/platform/mfa/disable', { method: 'POST', body: JSON.stringify({ reason }) });
    clearPlatformStepUp();
};

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
    const response = await authenticatedApiFetch('/admin/insights/finance/export?months=' + encodeURIComponent(String(months)));
    if (!response.ok) {
        // Parse through the protected boundary: a stale failure belongs to its old session.
        const payload = await readAuthenticatedApiJson(response).catch(cause => {
            if (cause instanceof ApiRequestError) throw cause;
            return null;
        });
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'فشل تنزيل التقرير');
    }
    const blob = await readAuthenticatedApiBlob(response);
    const disposition = response.headers.get('Content-Disposition') || '';
    const proposed = disposition.match(/filename="([^"]+)"/)?.[1] || 'platform-analytics.csv';
    const filename = proposed.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180) || 'platform-analytics.csv';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    try {
        anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click();
    } finally { anchor.remove(); URL.revokeObjectURL(url); }
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
    const startedAt = authRevision;
    const startingToken = getAuthToken();
    try {
        const response = await request<{ user: User; token: string }>('/auth/login', {
            auth: false,
            method: 'POST',
            body: JSON.stringify({ phone, password }),
        });


        if (authRevision !== startedAt || getAuthToken() !== startingToken) {
            return { user: null, error: 'تغيّرت الجلسة أثناء الطلب. أعد المحاولة.' };
        }
        if (!response.token || !response.user || !response.user.id) {
            return { user: null, error: 'تعذّر تأكيد بيانات تسجيل الدخول. أعد المحاولة.' };
        }
        if (response.token) {
            localStorage.setItem('currentUser', JSON.stringify(response.user));
            setAuthToken(response.token);
            notifySessionChange('login');
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
    const startedAt = authRevision;
    const startingToken = getAuthToken();
    try {
        const response = await request<{ user: User; token: string }>('/auth/register', {
            auth: false,
            method: 'POST',
            body: JSON.stringify({ phone, email: email || null, password, name, role }),
        });

        if (authRevision !== startedAt || getAuthToken() !== startingToken) {
            return { user: null, error: 'تغيّرت الجلسة أثناء الطلب. أعد المحاولة.' };
        }
        if (!response.token || !response.user || !response.user.id) {
            return { user: null, error: 'تعذّر تأكيد بيانات تسجيل الدخول. أعد المحاولة.' };
        }
        if (response.token) {
            localStorage.setItem('currentUser', JSON.stringify(response.user));
            setAuthToken(response.token);
            notifySessionChange('login');
        }

        return { user: response.user, error: null, token: response.token };
    } catch (error) {
        if (error instanceof Error && apiErrorMetadata.get(error)?.code === 'SESSION_UNAVAILABLE') {
            return { user: null, error: 'تم إنشاء الحساب، لكن خدمة الجلسات غير متاحة الآن. حاول تسجيل الدخول لاحقًا؛ لا تحتاج إلى إنشاء الحساب مرة أخرى.' };
        }
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

export type SessionVerification =
    | { state: 'authenticated'; user: User; token: string }
    | { state: 'anonymous' | 'unavailable' | 'changed' };

/** Network failure does not prove revocation. Responses cannot replace a newer login. */
export const verifyCurrentSession = async (signal?: AbortSignal): Promise<SessionVerification> => {
    const token = getAuthToken();
    if (!token) return { state: 'anonymous' };
    const verificationRevision = authRevision;
    const changed = () => getAuthToken() !== token || authRevision !== verificationRevision;
    try {
        const response = await fetch(API_BASE_URL + '/auth/me', {
            headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal,
        });
        if (changed()) return { state: 'changed' };
        if (response.status === 401) {
            clearAuthToken();
            return { state: 'anonymous' };
        }
        if (!response.ok) return { state: 'unavailable' };
        const body: unknown = await response.json();
        if (changed()) return { state: 'changed' };
        const user = (body as { user?: User } | null)?.user;
        if (!user || typeof user.id !== 'string' || !user.id || typeof user.name !== 'string'
            || !['admin', 'teacher', 'instructor', 'staff', 'student'].includes(user.role)
            || !user.is_active) return { state: 'unavailable' };
        if (signal?.aborted) return { state: 'unavailable' };
        localStorage.setItem('currentUser', JSON.stringify(user));
        return { state: 'authenticated', user, token };
    } catch {
        return { state: changed() ? 'changed' : 'unavailable' };
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

/**
 * M2-05 — selected institution identity (read-only), accepted M2-B01 endpoint
 * `GET /api/tenants/me/profile` (server/src/routes/tenant-self.ts:119-140).
 *
 * The exact fixed four-field DTO the server projects: no row spread, no
 * legacy_compat/owner/billing/contact fields. `subject_type` is the existing
 * nullable column returned verbatim (`null` when absent). The transport is the
 * same authenticated `request` — no parallel client, no selector, no shared
 * request/auth/error-contract change. Errors keep the documented transport
 * behavior: the server's `error` message is thrown WITHOUT the HTTP status
 * (api-http.ts:69-89), so only documented messages may classify outcomes.
 */
export interface TenantProfile {
    id: string;
    business_name: string;
    subject_type: string | null;
    status: string;
}

/** Response envelope of GET /api/tenants/me/profile: `{ tenant: TenantProfile }`. */
export interface TenantProfileEnvelope {
    tenant: TenantProfile;
}

export const getMyTenantProfile = () => request<TenantProfileEnvelope>('/tenants/me/profile');

/**
 * M2-06 — institution-name update through the accepted M2-B02 endpoint
 * `PATCH /api/tenants/me/profile` (server/src/routes/tenant-self.ts).
 *
 * Additive only: the same authenticated `request`, the same path, a strict
 * single-field body and NO client tenant selector (header/query/body). The
 * caller-facing validation (trim, 1..255) is the feature seam's job; the
 * server remains authoritative and re-validates before any connection. The
 * transport still throws the transported `error` message without the HTTP
 * status or `code`, so callers classify only documented messages.
 */
export const updateMyTenantProfile = (businessName: string) =>
    request<TenantProfileEnvelope>('/tenants/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ business_name: businessName }),
    });

/**
 * M2-07 — tenant branch metadata (owner-only) through the accepted M2-B03
 * endpoints `GET|POST /api/tenants/me/branches` and
 * `PATCH /api/tenants/me/branches/:branchId` (server/src/routes/tenant-self.ts;
 * contract docs/streams/server/M2-B03-CONTRACT.md, accepted under supervisor/151).
 *
 * Additive only: the same authenticated `request`, the same canonical paths and
 * NO client tenant selector (header/query/body) — the server selects the
 * tenant. The create body is the strict single field `{ name }`; the update
 * body carries only `name` and/or `status`. The transport still throws the
 * server's `error` message WITHOUT the HTTP status or the `code`, so callers
 * classify only documented messages and never fabricate a status.
 */
export type TenantBranchStatus = 'active' | 'archived';

/** The explicit five-field branch DTO the server projects (never a row spread). */
export interface TenantBranch {
    id: string;
    name: string;
    status: TenantBranchStatus;
    created_at: string;
    updated_at: string;
}

/** `GET /tenants/me/branches` response envelope: the bounded page and its cursor. */
export interface TenantBranchListEnvelope {
    branches: TenantBranch[];
    next_cursor: string | null;
}

/** `POST`/`PATCH` response envelope: the server-confirmed branch. */
export interface TenantBranchEnvelope {
    branch: TenantBranch;
}

/** The bounded page the client asks for (the server default page size). */
export const TENANT_BRANCH_PAGE_LIMIT = 25;

/**
 * Reads exactly ONE bounded page. `cursor` is the opaque position the server
 * returned; a malformed cursor is the server's documented 400. No tenant
 * selector is sent and no automatic all-page draining happens here.
 */
export const listMyTenantBranches = (options: { limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? TENANT_BRANCH_PAGE_LIMIT));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.toString();
    return request<TenantBranchListEnvelope>(`/tenants/me/branches${query ? `?${query}` : ''}`);
};

/** Creates one branch: the strict single-field body `{ name }` and nothing else. */
export const createMyTenantBranch = (name: string) =>
    request<TenantBranchEnvelope>('/tenants/me/branches', {
        method: 'POST',
        body: JSON.stringify({ name }),
    });

/**
 * Updates one branch: only `name` and/or `status` are sent, so a status-only
 * archive/reactivation never carries a name and a rename never carries a
 * status. The response id must match `branchId` — the caller checks it.
 */
export const updateMyTenantBranch = (
    branchId: string,
    update: { name?: string; status?: TenantBranchStatus },
) => {
    const body: { name?: string; status?: TenantBranchStatus } = {};
    if (update.name !== undefined) body.name = update.name;
    if (update.status !== undefined) body.status = update.status;
    return request<TenantBranchEnvelope>(
        `/tenants/me/branches/${encodeURIComponent(branchId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
    );
};

/**
 * M2-18 — private student branch assignment (owner-only) through
 * `PATCH /api/students/:id/branch` (server/src/routes/students.ts; contract
 * docs/streams/server/M2-B10-CONTRACT.md).
 *
 * Additive only: the same authenticated `request`, the same canonical path and
 * NO client tenant selector (header/query/body) — the server selects the tenant
 * and re-verifies the real owner row inside the same transaction that performs
 * the write. The body is the strict single field `{ branch_id }`, whose value is
 * a branch UUID (assign) or `null` (clear). Nothing else is ever sent, so this
 * call can never rename, create, delete or re-tenant anything.
 *
 * The response is the server's explicit three-field projection and nothing
 * else: the student row is never spread into the client. The transport throws
 * the server's `error` message WITHOUT the HTTP status or the `code`, so the
 * caller classifies only documented messages and never fabricates a status.
 */
export interface StudentBranchAssignment {
    student_id: string;
    branch_id: string | null;
    branch_name: string | null;
}

/** `PATCH` response envelope: the server-confirmed assignment. */
export interface StudentBranchEnvelope {
    student: StudentBranchAssignment;
}

/**
 * Assigns one student to one branch, or clears the assignment when
 * `branchId` is `null`. The id in the path is a RESOURCE id selected by the
 * user; it is never a tenant authority.
 */
export const assignStudentBranch = (studentId: string, branchId: string | null) =>
    request<StudentBranchEnvelope>(`/students/${encodeURIComponent(studentId)}/branch`, {
        method: 'PATCH',
        body: JSON.stringify({ branch_id: branchId }),
    });

/**
 * M2-20 — private instructor branch-assignment organization metadata
 * (owner-only) through
 * `GET /api/tenants/me/instructor-memberships` and
 * `PATCH /api/tenants/me/instructor-memberships/:membershipId`
 * (server/src/routes/tenant-self.ts; contract
 * docs/streams/server/M2-B12-CONTRACT.md).
 *
 * Additive only: the same authenticated `request`, the same canonical path
 * family and NO client tenant selector (header/query/body) — the server selects
 * the tenant and re-verifies the real owner, the active same-tenant instructor
 * membership and the active same-tenant branch inside the same transaction that
 * performs the write. The path id is a RESOURCE selector, never an authority.
 *
 * The write body is the strict single field `{ branch_id }`, whose value is a
 * branch UUID (record) or `null` (clear). Nothing else is ever sent, so this
 * call can never change a role, a permission, a teaching-access decision, a
 * course, a group, a student, an enrollment, a login or a price.
 *
 * The response is the server's explicit five-field projection and nothing else:
 * the membership row is never spread into the client. The transport throws the
 * server's `error` message WITHOUT the HTTP status or the `code`, so the caller
 * classifies only documented messages and never fabricates a status.
 */
export interface TenantInstructorMembership {
    membership_id: string;
    instructor_id: string;
    instructor_name: string;
    branch_id: string | null;
    branch_name: string | null;
}

/** `GET /tenants/me/instructor-memberships` envelope: the page and its cursor. */
export interface TenantInstructorMembershipListEnvelope {
    memberships: TenantInstructorMembership[];
    next_cursor: string | null;
}

/** `PATCH` response envelope: the server-confirmed membership record. */
export interface TenantInstructorMembershipEnvelope {
    membership: TenantInstructorMembership;
}

/** The bounded page the client asks for (the server default page size). */
export const TENANT_INSTRUCTOR_MEMBERSHIP_PAGE_LIMIT = 25;

/**
 * Reads exactly ONE bounded page of active instructor memberships. `cursor` is
 * the opaque position the server returned; a malformed cursor is the server's
 * documented 400. No tenant selector is sent and no automatic all-page draining
 * happens here.
 */
export const listMyTenantInstructorMemberships = (
    options: { limit?: number; cursor?: string | null } = {},
) => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? TENANT_INSTRUCTOR_MEMBERSHIP_PAGE_LIMIT));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.toString();
    return request<TenantInstructorMembershipListEnvelope>(
        `/tenants/me/instructor-memberships${query ? `?${query}` : ''}`,
    );
};

/**
 * Records one active same-tenant branch on one active instructor membership, or
 * clears the record when `branchId` is `null`. The membership id in the path is
 * a RESOURCE id selected by the user; it is never a tenant authority.
 */
export const assignInstructorBranch = (membershipId: string, branchId: string | null) =>
    request<TenantInstructorMembershipEnvelope>(
        `/tenants/me/instructor-memberships/${encodeURIComponent(membershipId)}`,
        { method: 'PATCH', body: JSON.stringify({ branch_id: branchId }) },
    );

/**
 * M2-09 — private course-unit metadata (owner-only) through the accepted
 * M2-B04 endpoints `GET|POST /api/tenants/me/catalog/courses/:courseId/units`
 * and `PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId`
 * (server/src/routes/course-units.ts; contract
 * docs/streams/server/M2-B04-CONTRACT.md, accepted under supervisor/176).
 *
 * Additive only: the same authenticated `request`, the same canonical paths and
 * NO client tenant selector (header/query/body) — the server selects the
 * tenant and re-verifies the real owner row. The course id in the path is a
 * RESOURCE id selected by the user; it is never a tenant authority.
 *
 * A course unit is private METADATA: a name, a display position and a status.
 * There is no teacher assignment, no student entitlement, no publication, no
 * payment and no upload rule in this contract, and nothing here changes the
 * access of an existing course or material.
 *
 * The create body carries `name` and optionally `display_order`; the update
 * body carries only `name`, `display_order` and/or `status`. `display_order`
 * is sent as a JSON NUMBER, because the server refuses a numeric string, a
 * float and a boolean. The transport still throws the server's `error` message
 * WITHOUT the HTTP status and WITHOUT the `code`, so callers classify only
 * documented messages and never fabricate a status.
 */
export type CourseUnitStatus = 'active' | 'archived';

/** The explicit seven-field unit DTO the server projects (never a row spread). */
export interface CourseUnit {
    id: string;
    course_id: string;
    name: string;
    display_order: number;
    status: CourseUnitStatus;
    created_at: string;
    updated_at: string;
}

/** `GET .../units` response envelope: the bounded page and its cursor. */
export interface CourseUnitListEnvelope {
    units: CourseUnit[];
    next_cursor: string | null;
}

/** `POST`/`PATCH` response envelope: the server-confirmed unit. */
export interface CourseUnitEnvelope {
    unit: CourseUnit;
}

/** The bounded page the client asks for (the server default page size). */
export const COURSE_UNIT_PAGE_LIMIT = 25;

/** The canonical unit collection path of one course. */
const courseUnitCollectionPath = (courseId: string): string =>
    `/tenants/me/catalog/courses/${encodeURIComponent(courseId)}/units`;

/**
 * Reads exactly ONE bounded page of the course's private unit metadata.
 * `cursor` is the opaque position the server returned; a malformed cursor is
 * the server's documented 400. No tenant selector is sent and no automatic
 * all-page draining happens here.
 */
export const listCourseUnits = (
    courseId: string,
    options: { limit?: number; cursor?: string | null } = {},
) => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? COURSE_UNIT_PAGE_LIMIT));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.toString();
    return request<CourseUnitListEnvelope>(
        `${courseUnitCollectionPath(courseId)}${query ? `?${query}` : ''}`,
    );
};

/**
 * Creates one private unit under the course of the path: the strict body
 * `{ name }` plus an OPTIONAL `display_order` number. Nothing else is ever
 * sent — no tenant selector, no course selector, no status, no publication or
 * paid field. The unit id is server-generated.
 */
export const createCourseUnit = (
    courseId: string,
    input: { name: string; display_order?: number },
) => {
    const body: { name: string; display_order?: number } = { name: input.name };
    if (input.display_order !== undefined) body.display_order = input.display_order;
    return request<CourseUnitEnvelope>(courseUnitCollectionPath(courseId), {
        method: 'POST',
        body: JSON.stringify(body),
    });
};

/**
 * Updates one private unit: only `name`, `display_order` and/or `status` are
 * sent, so a status-only archive never carries a name and a rename never
 * carries a status. The response id must match `unitId` — the caller checks
 * it, because a well-formed DTO for another unit is not a success here.
 */
export const updateCourseUnit = (
    courseId: string,
    unitId: string,
    update: { name?: string; display_order?: number; status?: CourseUnitStatus },
) => {
    const body: { name?: string; display_order?: number; status?: CourseUnitStatus } = {};
    if (update.name !== undefined) body.name = update.name;
    if (update.display_order !== undefined) body.display_order = update.display_order;
    if (update.status !== undefined) body.status = update.status;
    return request<CourseUnitEnvelope>(
        `${courseUnitCollectionPath(courseId)}/${encodeURIComponent(unitId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
    );
};

/**
 * M2-10 — private course-lesson metadata (owner-only) through the accepted
 * M2-B05 endpoints
 *   GET|POST /api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons
 *   PATCH    .../lessons/:lessonId
 *   POST     .../lessons/reorder
 * (server/src/routes/course-lessons.ts; contract
 * docs/streams/server/M2-B05-CONTRACT.md, accepted under supervisor/185).
 *
 * Additive only: the same authenticated `request`, the same canonical paths and
 * NO client tenant selector (header/query/body) — the server selects the tenant
 * and re-verifies the real owner row. The course id and the unit id in the path
 * are RESOURCE ids selected by the user; neither is a tenant authority.
 *
 * A course lesson is private METADATA: a title, an optional description, a
 * display position and a status. There is no lesson delivery, content, video,
 * file, material or asset reference, no teacher assignment, no student
 * entitlement, no publication, no progression and no payment in this contract.
 *
 * `display_order` is sent as a JSON NUMBER, because the server refuses a
 * numeric string, a float and a boolean. An explicit `description: null` is a
 * DELIBERATE clear and is distinct from an omitted description. The transport
 * still throws the server's `error` message WITHOUT the HTTP status and WITHOUT
 * the `code`, so callers classify only documented messages.
 */
export type CourseLessonStatus = 'active' | 'archived';

/** The explicit eight-field lesson DTO the server projects (never a row spread). */
export interface CourseLesson {
    id: string;
    unit_id: string;
    title: string;
    description: string | null;
    display_order: number;
    status: CourseLessonStatus;
    created_at: string;
    updated_at: string;
}

/** `GET .../lessons` response envelope: the bounded page and its cursor. */
export interface CourseLessonListEnvelope {
    lessons: CourseLesson[];
    next_cursor: string | null;
}

/** `POST`/`PATCH` response envelope: the server-confirmed lesson. */
export interface CourseLessonEnvelope {
    lesson: CourseLesson;
}

/** `POST .../lessons/reorder` response envelope: the selected lessons only. */
export interface CourseLessonReorderEnvelope {
    lessons: CourseLesson[];
}

/** The bounded page the client asks for (the server default page size). */
export const COURSE_LESSON_PAGE_LIMIT = 25;

/**
 * The client's own reorder bound: only the CURRENT visible page (at most 25
 * rows) can be selected, so one batch never exceeds 25 unique ids. The server's
 * own bound (100) stays a backend contract and is never used to widen this.
 */
export const COURSE_LESSON_REORDER_LIMIT = 25;

/** The canonical lesson collection path of one course unit. */
const courseLessonCollectionPath = (courseId: string, unitId: string): string =>
    `/tenants/me/catalog/courses/${encodeURIComponent(courseId)}/units/${encodeURIComponent(unitId)}/lessons`;

/**
 * Reads exactly ONE bounded page of the unit's private lesson metadata.
 * `cursor` is the opaque position the server returned; a malformed cursor is
 * the server's documented 400. No tenant selector is sent and no automatic
 * all-page draining happens here.
 */
export const listCourseLessons = (
    courseId: string,
    unitId: string,
    options: { limit?: number; cursor?: string | null } = {},
) => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? COURSE_LESSON_PAGE_LIMIT));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.toString();
    return request<CourseLessonListEnvelope>(
        `${courseLessonCollectionPath(courseId, unitId)}${query ? `?${query}` : ''}`,
    );
};

/**
 * Creates one private lesson under the unit of the path: the strict body
 * `{ title }` plus an OPTIONAL `description` (string or `null`) and an OPTIONAL
 * `display_order` number. Nothing else is ever sent — no tenant/course/unit
 * selector, no status, no content/asset/publication/paid field. The lesson id
 * is server-generated.
 */
export const createCourseLesson = (
    courseId: string,
    unitId: string,
    input: { title: string; description?: string | null; display_order?: number },
) => {
    const body: { title: string; description?: string | null; display_order?: number } = {
        title: input.title,
    };
    if (input.description !== undefined) body.description = input.description;
    if (input.display_order !== undefined) body.display_order = input.display_order;
    return request<CourseLessonEnvelope>(courseLessonCollectionPath(courseId, unitId), {
        method: 'POST',
        body: JSON.stringify(body),
    });
};

/**
 * Updates one private lesson: only `title`, `description`, `display_order`
 * and/or `status` are sent, so a status-only archive never carries a title and
 * a retitle never carries a status. `description: null` is an explicit clear
 * and is sent as `null`, never as an empty string. The response id and unit
 * must match — the caller checks them, because a well-formed DTO for another
 * lesson is not a success here.
 */
export const updateCourseLesson = (
    courseId: string,
    unitId: string,
    lessonId: string,
    update: {
        title?: string;
        description?: string | null;
        display_order?: number;
        status?: CourseLessonStatus;
    },
) => {
    const body: {
        title?: string;
        description?: string | null;
        display_order?: number;
        status?: CourseLessonStatus;
    } = {};
    if (update.title !== undefined) body.title = update.title;
    if (update.description !== undefined) body.description = update.description;
    if (update.display_order !== undefined) body.display_order = update.display_order;
    if (update.status !== undefined) body.status = update.status;
    return request<CourseLessonEnvelope>(
        `${courseLessonCollectionPath(courseId, unitId)}/${encodeURIComponent(lessonId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
    );
};

/**
 * Sets the display position of the selected lessons of ONE unit in ONE atomic
 * request: the body is ONLY `{ items: [{ id, display_order }] }`. Nothing else
 * is sent — no title, no status, no tenant/course/unit selector, no per-row
 * write. The caller owns the 25-item bound and the all-positions-validated
 * precondition; the server revalidates the whole batch and rolls it back as a
 * unit.
 */
export const reorderCourseLessons = (
    courseId: string,
    unitId: string,
    items: ReadonlyArray<{ id: string; display_order: number }>,
) => {
    const body = { items: items.map((item) => ({ id: item.id, display_order: item.display_order })) };
    return request<CourseLessonReorderEnvelope>(
        `${courseLessonCollectionPath(courseId, unitId)}/reorder`,
        { method: 'POST', body: JSON.stringify(body) },
    );
};

/**
 * M2-12 — private tenant branding metadata (owner-only) through the M2-B06
 * endpoints `GET|PATCH /api/tenants/me/branding`
 * (server/src/routes/tenant-branding.ts; contract
 * docs/streams/server/M2-B06-CONTRACT.md).
 *
 * Additive only: the same authenticated `request`, the same canonical path and
 * NO client tenant selector (header/query/body) — the server selects the tenant
 * and re-verifies the real owner row.
 *
 * Branding is PRESENTATION METADATA: two localized display labels and one
 * accent color. It renames nothing (`tenants.business_name` stays the business
 * identity), and it grants or revokes no access, pricing, billing or student
 * entitlement. `null` means "inherit the existing presentation" — it is never
 * the empty string and never a fabricated default color.
 *
 * The transport still throws the server's `error` message WITHOUT the HTTP
 * status and WITHOUT the `code`, so callers classify only documented messages.
 */
export interface TenantBranding {
    display_name_ar: string | null;
    display_name_en: string | null;
    accent_color: string | null;
    updated_at: string | null;
}

/** Response envelope of both endpoints: exactly `{ branding }`. */
export interface TenantBrandingEnvelope {
    branding: TenantBranding;
}

export const getMyTenantBranding = () => request<TenantBrandingEnvelope>('/tenants/me/branding');

/**
 * Sends ONLY the fields the caller actually set.
 *
 * `undefined` means "do not send this field", while an explicit `null` means
 * "set it back to inherit". A field left out of `update` is therefore never
 * transmitted, so a partial save can never silently clear a value the user did
 * not touch.
 */
export const updateMyTenantBranding = (update: {
    display_name_ar?: string | null;
    display_name_en?: string | null;
    accent_color?: string | null;
}) => {
    const body: { display_name_ar?: string | null; display_name_en?: string | null; accent_color?: string | null } = {};
    if (update.display_name_ar !== undefined) body.display_name_ar = update.display_name_ar;
    if (update.display_name_en !== undefined) body.display_name_en = update.display_name_en;
    if (update.accent_color !== undefined) body.accent_color = update.accent_color;
    return request<TenantBrandingEnvelope>('/tenants/me/branding', {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
};

// ---------------------------------------------------------------------------
// M2-B07 — private academic-period planning catalog (additive)
// ---------------------------------------------------------------------------

/**
 * One private academic period: a label plus two DATE-ONLY bounds plus a
 * reversible archive flag.
 *
 * `starts_on` / `ends_on` are CALENDAR DATES (`YYYY-MM-DD`), never instants:
 * they carry no time, no time zone and no offset, and the transport never
 * converts them. `created_at` / `updated_at` are canonical instants.
 */
export interface AcademicPeriod {
    id: string;
    name: string;
    starts_on: string;
    ends_on: string;
    is_archived: boolean;
    created_at: string;
    updated_at: string;
}

/** The bounded paging envelope of the catalog list. */
export interface AcademicPeriodPagination {
    limit: number;
    offset: number;
    has_more: boolean;
}

/** Response envelope of the list: exactly `{ periods, pagination }`. */
export interface AcademicPeriodListEnvelope {
    periods: AcademicPeriod[];
    pagination: AcademicPeriodPagination;
}

/** Response envelope of a create or an update: exactly `{ period }`. */
export interface AcademicPeriodEnvelope {
    period: AcademicPeriod;
}

export const ACADEMIC_PERIOD_PAGE_LIMIT = 25;
export const ACADEMIC_PERIOD_PAGE_MAX = 100;

/**
 * One bounded page of the catalog of the SERVER-selected tenant.
 *
 * The request carries no tenant selector: the workspace comes from the
 * authenticated session. `archived` is always sent explicitly, so the caller
 * never has to rely on the server's default.
 */
export const listMyAcademicPeriods = (
    options: { limit?: number; offset?: number; archived?: boolean } = {},
) => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? ACADEMIC_PERIOD_PAGE_LIMIT));
    params.set('offset', String(options.offset ?? 0));
    params.set('archived', options.archived ? 'true' : 'false');
    return request<AcademicPeriodListEnvelope>(`/tenants/me/academic-periods?${params.toString()}`);
};

/**
 * Creates one period. Only the three create fields are ever sent — no id, no
 * tenant/owner selector, no status, no enrollment/price/access field. The id is
 * server-generated.
 */
export const createMyAcademicPeriod = (input: { name: string; starts_on: string; ends_on: string }) =>
    request<AcademicPeriodEnvelope>('/tenants/me/academic-periods', {
        method: 'POST',
        body: JSON.stringify({ name: input.name, starts_on: input.starts_on, ends_on: input.ends_on }),
    });

/**
 * Sends ONLY the fields the caller actually set.
 *
 * `undefined` means "do not send this field", so a partial save can never
 * silently overwrite a value the user did not touch. `is_archived` is the
 * reversible planning visibility flag.
 */
export const updateMyAcademicPeriod = (
    id: string,
    update: { name?: string; starts_on?: string; ends_on?: string; is_archived?: boolean },
) => {
    const body: { name?: string; starts_on?: string; ends_on?: string; is_archived?: boolean } = {};
    if (update.name !== undefined) body.name = update.name;
    if (update.starts_on !== undefined) body.starts_on = update.starts_on;
    if (update.ends_on !== undefined) body.ends_on = update.ends_on;
    if (update.is_archived !== undefined) body.is_archived = update.is_archived;
    return request<AcademicPeriodEnvelope>(`/tenants/me/academic-periods/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
    });
};

// ====================================
// M2-14 / M2-B08 — private student-import reconciliation (READ-ONLY)
// ====================================

/**
 * One submitted row of the reconciliation request.
 *
 * Exactly four keys: the physical row number and the three exact match values.
 * A name, a guardian phone or a grade is NEVER part of this request.
 */
export interface StudentImportResolutionRequestRow {
    row_number: number;
    email: string;
    phone: string;
    barcode: string;
}

/** One answered row: a physical row number and the NAMES of the matched fields. */
export interface StudentImportResolutionRow {
    row_number: number;
    matched_fields: ('email' | 'phone' | 'barcode')[];
}

/** The bounded counts of one reconciliation. */
export interface StudentImportResolutionSummary {
    checked: number;
    matched: number;
    clear: number;
}

/** Response envelope: exactly `{ rows, summary }`. */
export interface StudentImportResolutionEnvelope {
    rows: StudentImportResolutionRow[];
    summary: StudentImportResolutionSummary;
}

/**
 * Submits the CURRENT locally included rows for a READ-ONLY reconciliation
 * against the records that already exist in the server-selected tenant.
 *
 * This endpoint creates, updates and imports NOTHING: it answers which exact
 * values already exist. The request carries no tenant selector, so the workspace
 * comes from the authenticated session, and the response names the matched
 * fields without disclosing any existing record's identity or data.
 */
export const resolveStudentImportRows = (rows: readonly StudentImportResolutionRequestRow[]) =>
    request<StudentImportResolutionEnvelope>('/tenants/me/student-import/resolve', {
        method: 'POST',
        body: JSON.stringify({ rows }),
    });

// ====================================
// M2-16 — private audited idempotent student-row import (WRITE)
// ====================================

/**
 * One submitted row of the import batch.
 *
 * Exactly seven keys: the physical row number and the six accepted CSV columns.
 * A selector, a status, an id or any other extra field is never part of this
 * request.
 */
export interface StudentImportCommitRequestRow {
    row_number: number;
    name: string;
    email: string;
    phone: string;
    guardian_phone: string;
    grade: string;
    barcode: string;
}

/** The exact request body: one opaque bounded idempotency key and the rows. */
export interface StudentImportCommitRequest {
    idempotency_key: string;
    rows: readonly StudentImportCommitRequestRow[];
}

/** The exact response DTO: a batch id, a replay flag, a count and row numbers. */
export interface StudentImportCommitResult {
    batch_id: string;
    replayed: boolean;
    created: number;
    row_numbers: number[];
}

/**
 * The transport answer of the import endpoint.
 *
 * Unlike the generic `request` helper, the STATUS is part of the contract: the
 * import controller must be able to tell a definite refusal (4xx, nothing was
 * created) from an UNCERTAIN one (5xx, the outcome is unknown and the same
 * idempotency key must be reused). A network failure rejects instead, which is
 * what marks the outcome unknown.
 */
export interface StudentImportCommitResponse {
    status: number;
    body: unknown;
}

/**
 * Submits ONE bounded, previously all-clear batch of student rows for the
 * server-selected tenant.
 *
 * The caller must have obtained the current decisions, confirmed no pending or
 * invalid row remains, and confirmed a fresh read-only reconciliation reports
 * every included row clear. That confirmation is advisory only: the server
 * revalidates the exact values and the tenant authority inside the transaction,
 * and refuses the WHOLE batch when any nonblank email/phone/barcode already
 * exists for this tenant.
 *
 * The tenant is never selected here: it comes from the authenticated session.
 * The request carries no existing-record identity and the response carries no
 * created student id and no stored value — only the batch identity, the replay
 * flag, the created count and the submitted physical row numbers.
 */
export const commitStudentImportBatch = async (
    commitRequest: StudentImportCommitRequest,
): Promise<StudentImportCommitResponse> => {
    const token = getAuthToken();
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const response = await fetch(`${API_BASE_URL}/tenants/me/student-import/commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify(commitRequest),
    });
    // A body that cannot be parsed is `null`, which the strict client parser
    // refuses as malformed rather than trusting.
    let body: unknown = null;
    try {
        body = await response.json();
    } catch {
        body = null;
    }
    return { status: response.status, body };
};

export interface InstructorTopupRequest {    id: string;
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
/** A 2xx alone is not proof of the requested administrative transition. */
export const requestServiceCreditAdjustment = async (data: { instructor_id: string; action_key: string; amount: string; reason: string }) => {
    const result = await request<{ id: string; status: string }>('/admin/approvals', { method: 'POST', body: JSON.stringify(data) });
    if (!result || typeof result.id !== 'string' || !result.id || result.status !== 'pending') throw new Error('تعذر تأكيد تسجيل الطلب. حدّث القائمة قبل إعادة المحاولة.');
    return result;
};
export const approveAdminApproval = async (id: string) => {
    const result = await request<{ status: string; new_balance: string }>('/admin/approvals/' + encodeURIComponent(id) + '/approve', { method: 'POST' });
    if (!result || result.status !== 'approved') throw new Error('تعذر تأكيد الاعتماد. حدّث القائمة قبل إعادة المحاولة.');
    return result;
};
export const rejectAdminApproval = async (id: string, reason: string) => {
    const result = await request<{ status: string }>('/admin/approvals/' + encodeURIComponent(id) + '/reject', { method: 'POST', body: JSON.stringify({ reason }) });
    if (!result || result.status !== 'rejected') throw new Error('تعذر تأكيد الرفض. حدّث القائمة قبل إعادة المحاولة.');
    return result;
};

export interface AdminRole { code: string; name: string; }
export interface AdminMember {
    id: string; name: string; email?: string | null; phone?: string | null; is_active: boolean; roles: string;
}
export const getAdminRoles = () => request<AdminRole[]>('/admin/members/roles');
export const getAdminMembers = () => request<AdminMember[]>('/admin/members');
export const createAdminMember = async (data: { name: string; phone: string; email?: string; password: string; role_code: string }) => {
    const result = await request<{ id: string; role_code: string }>('/admin/members', { method: 'POST', body: JSON.stringify(data) });
    if (!result || typeof result.id !== 'string' || !result.id || result.role_code !== data.role_code) throw new Error('تعذر تأكيد إنشاء الحساب. حدّث قائمة الفريق قبل إعادة المحاولة.');
    return result;
};
export const updateAdminMember = async (id: string, data: { role_code?: string; is_active?: boolean; password?: string; reason: string }) => {
    const result = await request<{ success: boolean }>('/admin/members/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(data) });
    if (!result || result.success !== true) throw new Error('تعذر تأكيد تحديث الحساب. حدّث القائمة قبل إعادة المحاولة.');
    return result;
};

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

// ---------------------------------------------------------------------------
// M2-22 — course publication (private) and published-course discovery (public)
// ---------------------------------------------------------------------------
//
// Two separate surfaces, deliberately kept apart:
//
//   * publication is a PRIVATE write on the existing `/courses/:id` surface. It
//     is a discovery flag only: publishing never enrolls anyone, grants access,
//     delivers a lesson or a file, or takes payment.
//   * discovery is a PUBLIC read on `/public/courses`. It is anonymous, read
//     only, and returns a fixed ten-field projection.
//
// Every adapter here parses a 2xx body strictly. `request` already throws the
// server's documented `error` message WITHOUT the HTTP status and WITHOUT the
// `code`, so an outcome is classified only by a documented message and no
// status is fabricated. A 2xx body that does not match the fixed projection is
// a malformed response, never a fabricated course.

export type CoursePublicationState = 'draft' | 'published';

/** The explicit THREE-field publication projection the server returns. */
export interface CoursePublication {
    course_id: string;
    publication_state: CoursePublicationState;
    published_at: string | null;
}

/** Raised when a 2xx body is not the documented publication projection. */
export const COURSE_PUBLICATION_MALFORMED_MESSAGE =
    'The server returned an unexpected course publication.';

const COURSE_PUBLICATION_DTO_KEYS = ['course_id', 'publication_state', 'published_at'].sort();

const COURSE_PUBLICATION_STATES: ReadonlySet<string> = new Set(['draft', 'published']);

const isPublicationStamp = (value: unknown): value is string | null =>
    value === null || typeof value === 'string';

/**
 * Validates one publication record: a non-null object whose key set is EXACTLY
 * the three projected fields, with a non-empty course id, a known state and a
 * string-or-null SERVER stamp.
 *
 * An extra key, a missing field, an unknown state or a non-string stamp is a
 * malformed response — never a fabricated publication.
 */
export function parseCoursePublication(body: unknown): CoursePublication | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;

    const keys = Object.keys(row).sort();
    if (keys.length !== COURSE_PUBLICATION_DTO_KEYS.length) return null;
    for (let index = 0; index < COURSE_PUBLICATION_DTO_KEYS.length; index += 1) {
        if (keys[index] !== COURSE_PUBLICATION_DTO_KEYS[index]) return null;
    }

    const { course_id, publication_state, published_at } = row;
    if (typeof course_id !== 'string' || course_id.trim() === '') return null;
    if (typeof publication_state !== 'string' || !COURSE_PUBLICATION_STATES.has(publication_state)) {
        return null;
    }
    if (!isPublicationStamp(published_at)) return null;

    return {
        course_id,
        publication_state: publication_state as CoursePublicationState,
        published_at,
    };
}

const coursePublicationPath = (courseId: string): string =>
    `/courses/${encodeURIComponent(courseId)}/publication`;

/**
 * `PUT /courses/:id/publication` with `publication_state: 'published'`.
 *
 * The response is authoritative: the returned record — not the requested
 * intent — is what the screen renders. Publishing an already-published course
 * is a truthful no-op that returns the ORIGINAL `published_at`, so a repeated
 * click can never restamp a course.
 */
export const publishCourse = async (courseId: string): Promise<CoursePublication> => {
    const body = await request<unknown>(coursePublicationPath(courseId), {
        method: 'PUT',
        body: JSON.stringify({ publication_state: 'published' }),
    });
    const parsed = parseCoursePublication(body);
    if (parsed === null) throw new Error(COURSE_PUBLICATION_MALFORMED_MESSAGE);
    return parsed;
};

/**
 * `PUT /courses/:id/publication` with `publication_state: 'draft'`.
 *
 * Unpublishing an already-draft course is likewise a truthful no-op. The record
 * is kept (with `published_at` cleared), so "never published" and "published
 * then withdrawn" both report `draft` and remain indistinguishable to the
 * public read.
 */
export const unpublishCourse = async (courseId: string): Promise<CoursePublication> => {
    const body = await request<unknown>(coursePublicationPath(courseId), {
        method: 'PUT',
        body: JSON.stringify({ publication_state: 'draft' }),
    });
    const parsed = parseCoursePublication(body);
    if (parsed === null) throw new Error(COURSE_PUBLICATION_MALFORMED_MESSAGE);
    return parsed;
};

/** The fixed TEN-field public projection. Never a row spread. */
export interface PublicCourse {
    course_id: string;
    name: string;
    subject: string | null;
    description: string | null;
    grade: string | null;
    tenant_id: string;
    business_name: string;
    display_name_ar: string | null;
    display_name_en: string | null;
    accent_color: string | null;
}

/** `GET /public/courses` envelope: the bounded page and its opaque cursor. */
export interface PublicCourseListEnvelope {
    courses: PublicCourse[];
    next_cursor: string | null;
}

/** `GET /public/courses/:courseId` envelope: exactly one course. */
export interface PublicCourseEnvelope {
    course: PublicCourse;
}

/** The page size the discovery page asks for (the server default). */
export const PUBLIC_COURSE_PAGE_LIMIT = 24;

/** The server's hard page ceiling. */
export const PUBLIC_COURSE_PAGE_MAX = 60;

/** The server's search-term ceiling, in characters. */
export const PUBLIC_COURSE_SEARCH_MAX = 100;

/** Raised when a 2xx body is not the documented public projection. */
export const PUBLIC_COURSE_MALFORMED_MESSAGE =
    'The server returned an unexpected public course.';

/**
 * The ONE documented message the public detail returns for a course that is
 * unpublished, belongs to another academy, or does not exist at all. The server
 * makes those three indistinguishable on purpose; the client must not try to
 * tell them apart either.
 */
export const PUBLIC_COURSE_UNAVAILABLE_MESSAGE = 'Course not found';

const PUBLIC_COURSE_DTO_KEYS = [
    'course_id',
    'name',
    'subject',
    'description',
    'grade',
    'tenant_id',
    'business_name',
    'display_name_ar',
    'display_name_en',
    'accent_color',
].sort();

const PUBLIC_COURSE_ACCENT_PATTERN = /^#[0-9A-F]{6}$/;

const isOptionalText = (value: unknown): value is string | null =>
    value === null || typeof value === 'string';

/** `null` ("inherit") or a canonical `#RRGGBB` uppercase accent. */
const isOptionalAccent = (value: unknown): value is string | null =>
    value === null
    || (typeof value === 'string' && PUBLIC_COURSE_ACCENT_PATTERN.test(value));

/**
 * Validates one public course against the accepted server contract: a non-null
 * object whose key set is EXACTLY the ten projected fields, with non-empty
 * identity/name strings, string-or-null optional text, and an `accent_color`
 * that is either `null` or canonical `#RRGGBB` uppercase.
 *
 * A non-canonical accent is rejected rather than rendered: the server already
 * downgrades such a value to `null`, so receiving one means the contract broke.
 */
export function parsePublicCourse(body: unknown): PublicCourse | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;

    const keys = Object.keys(row).sort();
    if (keys.length !== PUBLIC_COURSE_DTO_KEYS.length) return null;
    for (let index = 0; index < PUBLIC_COURSE_DTO_KEYS.length; index += 1) {
        if (keys[index] !== PUBLIC_COURSE_DTO_KEYS[index]) return null;
    }

    const {
        course_id, name, subject, description, grade,
        tenant_id, business_name, display_name_ar, display_name_en, accent_color,
    } = row;

    if (typeof course_id !== 'string' || course_id.trim() === '') return null;
    if (typeof name !== 'string' || name.trim() === '') return null;
    if (typeof tenant_id !== 'string' || tenant_id.trim() === '') return null;
    if (typeof business_name !== 'string' || business_name.trim() === '') return null;
    if (!isOptionalText(subject)) return null;
    if (!isOptionalText(description)) return null;
    if (!isOptionalText(grade)) return null;
    if (!isOptionalText(display_name_ar)) return null;
    if (!isOptionalText(display_name_en)) return null;
    if (!isOptionalAccent(accent_color)) return null;

    return {
        course_id,
        name,
        subject,
        description,
        grade,
        tenant_id,
        business_name,
        display_name_ar,
        display_name_en,
        accent_color,
    };
}

/** Validates the bounded list envelope: exactly `courses` and `next_cursor`. */
export function parsePublicCourseList(body: unknown): PublicCourseListEnvelope | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    if (keys.length !== 2 || keys[0] !== 'courses' || keys[1] !== 'next_cursor') return null;
    if (!Array.isArray(row.courses)) return null;
    if (!isOptionalText(row.next_cursor)) return null;

    const courses: PublicCourse[] = [];
    for (const item of row.courses) {
        const parsed = parsePublicCourse(item);
        if (parsed === null) return null;
        courses.push(parsed);
    }
    return { courses, next_cursor: row.next_cursor };
}

/** Validates the detail envelope: exactly `course`. */
export function parsePublicCourseEnvelope(body: unknown): PublicCourseEnvelope | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;
    const keys = Object.keys(row);
    if (keys.length !== 1 || keys[0] !== 'course') return null;
    const course = parsePublicCourse(row.course);
    if (course === null) return null;
    return { course };
}

/**
 * Reads exactly ONE bounded page of published courses. `cursor` is the opaque
 * position the server returned; a malformed cursor is the server's documented
 * 400. `search` is optional, and a blank term is sent as no filter at all. No
 * automatic all-page draining happens here.
 */
export const listPublicCourses = async (
    options: { limit?: number; cursor?: string | null; search?: string | null } = {},
): Promise<PublicCourseListEnvelope> => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? PUBLIC_COURSE_PAGE_LIMIT));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.search) params.set('q', options.search);
    const body = await request<unknown>(`/public/courses?${params.toString()}`);
    const parsed = parsePublicCourseList(body);
    if (parsed === null) throw new Error(PUBLIC_COURSE_MALFORMED_MESSAGE);
    return parsed;
};

/**
 * Reads exactly one published course by id. Unpublished, foreign and absent
 * courses all raise the same documented message, so the caller cannot present
 * them differently.
 */
export const getPublicCourse = async (courseId: string): Promise<PublicCourse> => {
    const body = await request<unknown>(`/public/courses/${encodeURIComponent(courseId)}`);
    const parsed = parsePublicCourseEnvelope(body);
    if (parsed === null) throw new Error(PUBLIC_COURSE_MALFORMED_MESSAGE);
    return parsed.course;
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

/**
 * M2-21 — private group announcements through
 * `GET|POST /api/groups/:groupId/announcements`,
 * `PUT /api/groups/:groupId/announcements/:announcementId` and
 * `POST /api/groups/:groupId/announcements/:announcementId/retract`
 * (server/src/routes/groups.ts; contract
 * docs/streams/server/M2-B13-CONTRACT.md).
 *
 * Additive only: the same authenticated `request`, the same `/groups` path
 * family and NO client tenant or instructor selector — the server selects the
 * tenant from the session and re-verifies the caller's active membership, the
 * owned same-tenant group and the announcement inside the same transaction
 * that performs the write. The group and announcement ids in the path are
 * RESOURCE selectors, never authority.
 *
 * A PRIVATE management surface: an announcement is a bounded title, a bounded
 * body and an explicit `draft`/`published`/`retracted` state with SERVER
 * timestamps. Nothing here sends an email, SMS or push, schedules a delivery
 * (no publish-at, expiry or timezone policy), notifies a recipient, or creates
 * an access, enrollment, role, session, attendance or billing effect.
 *
 * Unlike the legacy `createGroup`/`updateGroup`/`deleteGroup` helpers above,
 * these adapters do NOT swallow an error into `null`/`false`: the transport
 * throws the server's `error` message WITHOUT the HTTP status and WITHOUT the
 * `code`, so only documented messages classify an outcome and no status is
 * fabricated. A 2xx body that does not match the fixed projection is a
 * malformed response, never a fabricated announcement.
 */
export type GroupAnnouncementState = 'draft' | 'published' | 'retracted';

/** The explicit EIGHT-field projection the server returns (never a row spread). */
export interface GroupAnnouncement {
    id: string;
    group_id: string;
    title: string;
    body: string;
    state: GroupAnnouncementState;
    created_at: string | null;
    updated_at: string | null;
    retracted_at: string | null;
}

/** `GET .../announcements` envelope: the bounded page and its cursor. */
export interface GroupAnnouncementListEnvelope {
    announcements: GroupAnnouncement[];
    next_cursor: string | null;
}

/** The bounded page the client asks for (the server default page size). */
export const GROUP_ANNOUNCEMENT_PAGE_LIMIT = 25;

/** The server's hard page ceiling. */
export const GROUP_ANNOUNCEMENT_PAGE_MAX = 100;

/** Raised when a 2xx body is not the documented projection. */
export const GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE =
    'The server returned an unexpected announcement.';

/**
 * A create body requires `title` and `body`; an update body carries any subset
 * (an absent key KEEPS the stored value, so an empty patch is a truthful
 * no-op). `state` is only ever `draft` or `published`: `retracted` is reachable
 * solely through the explicit retract call, so a client can never forge a
 * retraction by writing a state.
 */
export interface GroupAnnouncementWrite {
    title?: string;
    body?: string;
    state?: 'draft' | 'published';
}

const GROUP_ANNOUNCEMENT_DTO_KEYS = [
    'id', 'group_id', 'title', 'body', 'state', 'created_at', 'updated_at', 'retracted_at',
].sort();

const GROUP_ANNOUNCEMENT_STATES: ReadonlySet<string> = new Set(['draft', 'published', 'retracted']);

const isAnnouncementStamp = (value: unknown): value is string | null =>
    value === null || typeof value === 'string';

/**
 * Validates one announcement against the accepted server contract: a non-null
 * object whose key set is EXACTLY the eight projected fields, with string
 * identity/content fields, a known state and string-or-null SERVER stamps.
 *
 * An extra key, a missing field, an unknown state or a non-string stamp is a
 * malformed response — never a fabricated announcement.
 */
export function parseGroupAnnouncement(body: unknown): GroupAnnouncement | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;

    const keys = Object.keys(row).sort();
    if (keys.length !== GROUP_ANNOUNCEMENT_DTO_KEYS.length) return null;
    for (let index = 0; index < GROUP_ANNOUNCEMENT_DTO_KEYS.length; index += 1) {
        if (keys[index] !== GROUP_ANNOUNCEMENT_DTO_KEYS[index]) return null;
    }

    const { id, group_id, title, body: content, state, created_at, updated_at, retracted_at } = row;
    if (typeof id !== 'string' || id.trim() === '') return null;
    if (typeof group_id !== 'string' || group_id.trim() === '') return null;
    if (typeof title !== 'string' || title.trim() === '') return null;
    if (typeof content !== 'string' || content.trim() === '') return null;
    if (typeof state !== 'string' || !GROUP_ANNOUNCEMENT_STATES.has(state)) return null;
    if (!isAnnouncementStamp(created_at)) return null;
    if (!isAnnouncementStamp(updated_at)) return null;
    if (!isAnnouncementStamp(retracted_at)) return null;

    return {
        id,
        group_id,
        title,
        body: content,
        state: state as GroupAnnouncementState,
        created_at,
        updated_at,
        retracted_at,
    };
}

/** Validates the bounded list envelope: exactly `announcements` and `next_cursor`. */
export function parseGroupAnnouncementList(body: unknown): GroupAnnouncementListEnvelope | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const row = body as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    if (keys.length !== 2 || keys[0] !== 'announcements' || keys[1] !== 'next_cursor') return null;
    if (!Array.isArray(row.announcements)) return null;
    if (!isAnnouncementStamp(row.next_cursor)) return null;

    const announcements: GroupAnnouncement[] = [];
    for (const item of row.announcements) {
        const parsed = parseGroupAnnouncement(item);
        if (parsed === null) return null;
        announcements.push(parsed);
    }
    return { announcements, next_cursor: row.next_cursor };
}

const groupAnnouncementCollectionPath = (groupId: string): string =>
    `/groups/${encodeURIComponent(groupId)}/announcements`;

const groupAnnouncementItemPath = (groupId: string, announcementId: string): string =>
    `${groupAnnouncementCollectionPath(groupId)}/${encodeURIComponent(announcementId)}`;

/**
 * Reads exactly ONE bounded page of one owned group's announcements. `cursor`
 * is the opaque position the server returned; a malformed cursor is the
 * server's documented 400. No automatic all-page draining happens here.
 */
export const listGroupAnnouncements = async (
    groupId: string,
    options: { limit?: number; cursor?: string | null } = {},
): Promise<GroupAnnouncementListEnvelope> => {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? GROUP_ANNOUNCEMENT_PAGE_LIMIT));
    if (options.cursor) params.set('cursor', options.cursor);
    const body = await request<unknown>(
        `${groupAnnouncementCollectionPath(groupId)}?${params.toString()}`,
    );
    const parsed = parseGroupAnnouncementList(body);
    if (parsed === null) throw new Error(GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE);
    return parsed;
};

/** `POST .../announcements` — strict canonical create; the server defaults `state` to `draft`. */
export const createGroupAnnouncement = async (
    groupId: string,
    write: GroupAnnouncementWrite,
): Promise<GroupAnnouncement> => {
    const body = await request<unknown>(groupAnnouncementCollectionPath(groupId), {
        method: 'POST',
        body: JSON.stringify(write),
    });
    const parsed = parseGroupAnnouncement(body);
    if (parsed === null) throw new Error(GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE);
    return parsed;
};

/** `PUT .../announcements/:announcementId` — an absent key keeps the stored value. */
export const updateGroupAnnouncement = async (
    groupId: string,
    announcementId: string,
    patch: GroupAnnouncementWrite,
): Promise<GroupAnnouncement> => {
    const body = await request<unknown>(groupAnnouncementItemPath(groupId, announcementId), {
        method: 'PUT',
        body: JSON.stringify(patch),
    });
    const parsed = parseGroupAnnouncement(body);
    if (parsed === null) throw new Error(GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE);
    return parsed;
};

/** `POST .../announcements/:announcementId/retract` — explicit, terminal and audited. */
export const retractGroupAnnouncement = async (
    groupId: string,
    announcementId: string,
): Promise<GroupAnnouncement> => {
    const body = await request<unknown>(
        `${groupAnnouncementItemPath(groupId, announcementId)}/retract`,
        { method: 'POST', body: JSON.stringify({}) },
    );
    const parsed = parseGroupAnnouncement(body);
    if (parsed === null) throw new Error(GROUP_ANNOUNCEMENT_MALFORMED_MESSAGE);
    return parsed;
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
    assignStudentBranch,
    listMyTenantInstructorMemberships,
    assignInstructorBranch,

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
    const startedAt = authRevision;
    const startingToken = getAuthToken();
    const unchanged = () => authRevision === startedAt && getAuthToken() === startingToken;
    const assertCurrent = () => { if (!unchanged()) throw new ApiRequestError('تغيّرت الجلسة أثناء اختيار المساحة. أعد المحاولة.', 409, 'CLIENT_SESSION_CHANGED'); };
    const result = await request<{ token: string; tenant_id: string; student_enrollment_id: string }>(
        '/student-enrollment/spaces/' + encodeURIComponent(studentEnrollmentId) + '/select', { method: 'POST' }
    );
    assertCurrent();
    if (!result || typeof result.token !== 'string' || !result.token || typeof result.tenant_id !== 'string'
        || !result.tenant_id || result.student_enrollment_id !== studentEnrollmentId) throw new Error('تعذّر تأكيد هوية المساحة');
    // Verify using the candidate bearer before replacing the current browser identity.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let student: Student & { tenant_id: string; business_name: string; is_active: boolean | number };
    try {
        const response = await fetch(API_BASE_URL + '/students/me', {
            headers: { Authorization: 'Bearer ' + result.token }, cache: 'no-store', signal: controller.signal,
        });
        assertCurrent();
        if (!response.ok) throw new Error('تعذّر تأكيد بيانات المساحة. الجلسة السابقة لم تتغيّر.');
        student = await response.json();
        assertCurrent();
        if (!student || student.id !== studentEnrollmentId || student.tenant_id !== result.tenant_id
            || typeof student.name !== 'string' || typeof student.business_name !== 'string'
            || (student.is_active !== true && student.is_active !== 1)) throw new Error('بيانات المساحة لا تطابق الهوية المطلوبة');
    } finally { clearTimeout(timer); }
    const selected: StudentSpace = {
        student_enrollment_id: student.id, tenant_id: student.tenant_id, business_name: student.business_name,
        grade_id: student.grade_id, group_id: student.group_id, grade_name: student.grade_name, group_name: student.group_name,
    };
    const oldStudent = localStorage.getItem('currentStudent');
    const oldSpace = localStorage.getItem('currentStudentSpace');
    try {
        localStorage.setItem('currentStudent', JSON.stringify(student));
        localStorage.setItem('currentStudentSpace', JSON.stringify(selected));
        // Last write publishes only after the full, verified identity is stored.
        setAuthToken(result.token);
    } catch (cause) {
        try {
            if (oldStudent === null) localStorage.removeItem('currentStudent'); else localStorage.setItem('currentStudent', oldStudent);
            if (oldSpace === null) localStorage.removeItem('currentStudentSpace'); else localStorage.setItem('currentStudentSpace', oldSpace);
        } catch { clearAuthToken(); }
        throw cause;
    }
    notifySessionChange('token');
    const committedRevision = authRevision;
    return { ...result, isCurrentSession: () => authRevision === committedRevision && getAuthToken() === result.token };
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
