import { ApiRequestError, authenticatedApiFetch, readAuthenticatedApiJson } from '../../lib/api-http';
export const homeworkUuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(x);
const record = (x: any): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x: any, keys: string[]) => record(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
const integer = (x: any, min: number, max: number) => Number.isSafeInteger(x) && x >= min && x <= max;
const iso = (x: any) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const bad = () => Error('Invalid catalog homework response');
export type UploadStatus = 'pending_upload' | 'pending_scan' | 'finalized' | 'quarantined';
export interface HomeworkReceipt {
    id: string;
    version: number;
    status: 'submitted' | 'late' | 'revoked';
    file_name: string;
    file_type: string;
    file_size_bytes: number;
    upload_status: UploadStatus;
    scan_status: 'pending' | 'clean' | 'infected' | 'failed';
}
export interface HomeworkPolicy {
    content_id: string;
    deadline_at: string | null;
    late_policy: 'block' | 'mark_late' | 'accept';
    resubmission_policy: 'allow' | 'block';
    max_submissions: number;
    max_file_bytes: number;
    allowed_file_types: string[];
    accepting: boolean;
    reason: string | null;
    upload_configured: boolean;
}
export interface UploadAuthorization {
    method: 'PUT' | 'POST';
    url: string;
    fields?: Record<string, string>;
    expires_at: string;
    expires_in_seconds: number;
    required_headers: Record<string, string>;
    max_bytes: number;
    max_bytes_enforced: boolean;
    max_bytes_enforcement: 'signed_content_length_range' | 'finalize_stat_only';
}
const receiptKeys = ['id', 'version', 'status', 'file_name', 'file_type', 'file_size_bytes', 'upload_status', 'scan_status'];
function receipt(x: any): HomeworkReceipt {
    if (!record(x) || !homeworkUuid(x.id) || !integer(x.version, 1, Number.MAX_SAFE_INTEGER) || !['submitted', 'late', 'revoked'].includes(x.status) || typeof x.file_name !== 'string' || !x.file_name || x.file_name.length > 255 || /[\\/\x00-\x1f]/.test(x.file_name) || typeof x.file_type !== 'string' || !x.file_type || x.file_type.length > 120 || !integer(x.file_size_bytes, 0, 2147483648) || !['pending', 'clean', 'infected', 'failed'].includes(x.scan_status))
        throw bad();
    const expected = x.file_size_bytes === 0 ? 'pending_upload' : x.scan_status === 'clean' ? 'finalized' : x.scan_status === 'pending' ? 'pending_scan' : 'quarantined';
    if (x.upload_status !== expected)
        throw bad();
    return { id: x.id, version: x.version, status: x.status, file_name: x.file_name, file_type: x.file_type, file_size_bytes: x.file_size_bytes, upload_status: x.upload_status, scan_status: x.scan_status };
}
export function parseHomeworkRecovery(raw: any): HomeworkReceipt | null {
    if (exact(raw, ['submission']) && raw.submission === null)
        return null;
    if (!exact(raw, ['submission', 'unchanged']) || raw.unchanged !== true || !exact(raw.submission, receiptKeys))
        throw bad();
    return receipt(raw.submission);
}
export function parseHomeworkHistory(raw: any): HomeworkReceipt[] {
    if (!Array.isArray(raw) || raw.length > 1000)
        throw bad();
    const rows = raw.map(x => { if (!exact(x, [...receiptKeys, 'is_late', 'submitted_at', 'revoked_at']) || typeof x.is_late !== 'boolean' || [x.submitted_at, x.revoked_at].some(v => v !== null && !iso(v)))
        throw bad(); return receipt(x); });
    if (new Set(rows.map(x => x.id)).size !== rows.length || new Set(rows.map(x => x.version)).size !== rows.length)
        throw bad();
    return rows;
}
export function parseHomeworkPolicy(raw: any, contentId: string): HomeworkPolicy {
    const keys = ['content_id', 'deadline_at', 'late_policy', 'resubmission_policy', 'max_submissions', 'max_file_bytes', 'allowed_file_types', 'accepting', 'reason', 'upload_configured'];
    if (!exact(raw, keys) || raw.content_id !== contentId || raw.deadline_at !== null && !iso(raw.deadline_at) || !['block', 'mark_late', 'accept'].includes(raw.late_policy) || !['allow', 'block'].includes(raw.resubmission_policy) || !integer(raw.max_submissions, 1, 50) || !integer(raw.max_file_bytes, 1024, 2147483648) || !Array.isArray(raw.allowed_file_types) || !raw.allowed_file_types.length || raw.allowed_file_types.length > 16 || raw.allowed_file_types.some((x: any) => typeof x !== 'string' || !['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'zip', 'txt'].includes(x)) || new Set(raw.allowed_file_types).size !== raw.allowed_file_types.length || typeof raw.accepting !== 'boolean' || typeof raw.upload_configured !== 'boolean' || (raw.accepting ? raw.reason !== null : !['NOT_OPEN', 'DEADLINE_PASSED', 'RESUBMISSION_BLOCKED', 'SUBMISSION_LIMIT_REACHED'].includes(raw.reason)))
        throw bad();
    return { content_id: raw.content_id, deadline_at: raw.deadline_at, late_policy: raw.late_policy, resubmission_policy: raw.resubmission_policy, max_submissions: raw.max_submissions, max_file_bytes: raw.max_file_bytes, allowed_file_types: [...raw.allowed_file_types], accepting: raw.accepting, reason: raw.reason, upload_configured: raw.upload_configured };
}
export function parseUploadAuthorization(raw: any): UploadAuthorization {
    const keys = ['method', 'url', 'expires_at', 'expires_in_seconds', 'required_headers', 'max_bytes', 'max_bytes_enforced', 'max_bytes_enforcement'];
    if (!record(raw) || !exact(raw, [...keys, ...(raw.method === 'POST' ? ['fields'] : [])]) || !['PUT', 'POST'].includes(raw.method) || typeof raw.url !== 'string' || raw.url.length > 8192 || /[\x00-\x20\x7f]/.test(raw.url) || !iso(raw.expires_at) || !integer(raw.expires_in_seconds, 60, 600) || !integer(raw.max_bytes, 1024, 2147483648) || typeof raw.max_bytes_enforced !== 'boolean' || raw.max_bytes_enforcement !== (raw.max_bytes_enforced ? 'signed_content_length_range' : 'finalize_stat_only'))
        throw bad();
    const url = new URL(raw.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        throw bad();
    if (raw.method === 'PUT' && (!exact(raw.required_headers, ['Content-Type']) || typeof raw.required_headers['Content-Type'] !== 'string' || !raw.required_headers['Content-Type'] || raw.required_headers['Content-Type'].length > 120 || /[\r\n]/.test(raw.required_headers['Content-Type'])))
        throw bad();
    if (raw.method === 'POST' && (!exact(raw.required_headers, []) || !record(raw.fields) || Object.keys(raw.fields).length > 32 || Object.entries(raw.fields).some(([key, value]) => !key || key.length > 128 || key.toLowerCase() === 'file' || typeof value !== 'string' || value.length > 8192)))
        throw bad();
    return { method: raw.method, url: raw.url, ...(raw.method === 'POST' ? { fields: { ...raw.fields } } : {}), expires_at: raw.expires_at, expires_in_seconds: raw.expires_in_seconds, required_headers: { ...raw.required_headers }, max_bytes: raw.max_bytes, max_bytes_enforced: raw.max_bytes_enforced, max_bytes_enforcement: raw.max_bytes_enforcement };
}
export function parseHomeworkCreated(raw: any, file: {file_name:string;file_type:string}): {
    submission: HomeworkReceipt;
    upload: UploadAuthorization | null;
} {
    if (record(raw) && 'submission' in raw) {
        const submission = parseHomeworkRecovery(raw);
        if (!submission)
            throw bad();
        return { submission, upload: null };
    }
    if (!exact(raw, [...receiptKeys.filter(k => !['file_name', 'file_type'].includes(k)), 'is_late', 'upload']) || typeof raw.is_late !== 'boolean' || raw.file_size_bytes !== 0 || raw.scan_status !== 'pending' || !['submitted', 'late'].includes(raw.status))
        throw bad();
    // File identity is supplied by the frozen create payload, not this response.
    return { submission: receipt({ ...raw, ...file }), upload: parseUploadAuthorization(raw.upload) };
}
export function parseHomeworkAuthorization(raw: any, id: string, version: number): UploadAuthorization {
    if (!exact(raw, ['id', 'version', 'upload_status', 'scan_status', 'upload']) || raw.id !== id || raw.version !== version || raw.upload_status !== 'pending_upload' || raw.scan_status !== 'pending')
        throw bad();
    return parseUploadAuthorization(raw.upload);
}
export function parseHomeworkFinalized(raw: any, old: HomeworkReceipt): HomeworkReceipt {
    const infected = record(raw) && raw.code === 'scan_infected';
    if (!exact(raw, ['id', 'version', 'upload_status', 'scan_status', 'file_size_bytes', 'status', ...(infected ? ['error', 'code'] : [])]) || raw.id !== old.id || raw.version !== old.version || infected && typeof raw.error !== 'string')
        throw bad();
    const next = receipt({ ...old, ...raw });
    if (!next.file_size_bytes || infected && next.upload_status !== 'quarantined')
        throw bad();
    return next;
}
export function catalogHomeworkTransport(courseId: string, lessonId: string, contentId: string) {
    if (![courseId, lessonId, contentId].every(homeworkUuid))
        throw bad();
    const base = `/assignments/catalog/courses/${courseId}/lessons/${lessonId}/activities/${contentId}`;
    const request = async (path: string, signal: AbortSignal, body?: unknown, key?: string) => {
        const response = await authenticatedApiFetch(base + path, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) }) });
        const data = await readAuthenticatedApiJson(response);
        if (!response.ok && !(response.status === 422 && record(data) && data.code === 'scan_infected'))
            throw new ApiRequestError('Homework request failed', response.status, record(data) && typeof data.code === 'string' ? data.code : undefined);
        return data;
    };
    const sid = (id: string) => { if (!homeworkUuid(id))
        throw bad(); return '/submissions/' + id; };
    return {
        policy: (signal: AbortSignal) => request('/submission-policy', signal), mine: (signal: AbortSignal) => request('/submissions/mine', signal),
        recover: (key: string, signal: AbortSignal) => { if (!homeworkUuid(key))
            throw bad(); return request('/requests/' + key, signal); },
        create: (file: {
            file_name: string;
            file_type: string;
        }, key: string, signal: AbortSignal) => { if (!homeworkUuid(key))
            throw bad(); return request('/submissions', signal, file, key); },
        authorize: (id: string, signal: AbortSignal) => request(sid(id) + '/upload-authorization', signal, {}),
        finalize: (id: string, signal: AbortSignal) => request(sid(id) + '/finalize', signal, {}), cancel: (id: string, signal: AbortSignal) => request(sid(id) + '/cancel', signal, {}),
    };
}
/** Direct storage transfer: no API bearer/cookies, redirects or referrer. */
export async function transferHomeworkFile(auth: UploadAuthorization, file: File, signal: AbortSignal, origin: string, fetcher: typeof fetch = fetch): Promise<void> {
    const parsed = parseUploadAuthorization(auth), url = new URL(parsed.url);
    if (url.protocol !== 'https:' && url.origin !== new URL(origin).origin || Date.parse(parsed.expires_at) <= Date.now() || file.size < 1024 || file.size > parsed.max_bytes)
        throw Error('Upload authorization unavailable');
    let body: BodyInit = file;
    if (parsed.method === 'POST') {
        const form = new FormData();
        for (const [key, value] of Object.entries(parsed.fields!))
            form.append(key, value);
        form.append('file', file);
        body = form;
    }
    const result = await fetcher(parsed.url, { method: parsed.method, headers: parsed.required_headers, body, signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!result.ok)
        throw Error('Storage transfer not confirmed');
    // A 2xx response proves only transfer, never API verification or clean scan.
}
