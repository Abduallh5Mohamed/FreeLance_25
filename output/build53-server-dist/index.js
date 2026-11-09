"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const video_security_1 = require("./services/video-security");
// Load environment before route defaults capture dedicated service secrets.
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const db_1 = require("./db");
const http_1 = require("http");
const socket_1 = require("./services/socket");
const student_enrollment_1 = __importStar(require("./routes/student-enrollment"));
const branches_1 = __importDefault(require("./routes/branches"));
const content_access_1 = __importDefault(require("./routes/content-access"));
const student_course_access_1 = __importDefault(require("./routes/student-course-access"));
const question_bank_1 = __importDefault(require("./routes/question-bank"));
const assignments_1 = __importDefault(require("./routes/assignments"));
const tenant_branding_1 = __importDefault(require("./routes/tenant-branding"));
const tenant_domains_1 = __importDefault(require("./routes/tenant-domains"));
const announcements_1 = __importDefault(require("./routes/announcements"));
const student_import_1 = __importDefault(require("./routes/student-import"));
const video_assets_1 = __importDefault(require("./routes/video-assets"));
const playback_sessions_1 = __importDefault(require("./routes/playback-sessions"));
const parent_links_1 = __importDefault(require("./routes/parent-links"));
const parent_views_1 = __importDefault(require("./routes/parent-views"));
const notification_consent_1 = __importDefault(require("./routes/notification-consent"));
const lesson_discussions_1 = __importDefault(require("./routes/lesson-discussions"));
// Import routes
const auth_1 = __importDefault(require("./routes/auth"));
const groups_1 = __importDefault(require("./routes/groups"));
const grades_1 = __importDefault(require("./routes/grades"));
const students_1 = __importDefault(require("./routes/students"));
const courses_1 = __importDefault(require("./routes/courses"));
const public_catalog_1 = __importDefault(require("./routes/public-catalog"));
const attendance_1 = __importDefault(require("./routes/attendance"));
const exams_1 = __importDefault(require("./routes/exams"));
const exam_results_1 = __importDefault(require("./routes/exam-results"));
const subscriptions_1 = __importDefault(require("./routes/subscriptions"));
const subscription_plans_1 = __importDefault(require("./routes/subscription-plans"));
const materials_1 = __importDefault(require("./routes/materials"));
const lectures_1 = __importDefault(require("./routes/lectures"));
const registration_requests_1 = __importDefault(require("./routes/registration-requests"));
const fees_1 = __importDefault(require("./routes/fees"));
const payment_requests_1 = __importDefault(require("./routes/payment-requests"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const subscription_requests_1 = __importDefault(require("./routes/subscription-requests"));
const files_1 = __importDefault(require("./routes/files"));
const expenses_1 = __importDefault(require("./routes/expenses"));
const imports_1 = __importDefault(require("./routes/imports"));
const messages_1 = __importDefault(require("./routes/messages"));
const videos_1 = __importStar(require("./routes/videos"));
const secure_video_1 = __importDefault(require("./routes/secure-video"));
const manual_grading_1 = __importDefault(require("./routes/manual-grading"));
const staff_1 = __importDefault(require("./routes/staff"));
const premium_lectures_1 = __importDefault(require("./routes/premium-lectures"));
const ai_chat_1 = __importDefault(require("./routes/ai-chat"));
const meetings_1 = __importDefault(require("./routes/meetings"));
const instructors_1 = __importDefault(require("./routes/instructors"));
const public_identity_1 = __importDefault(require("./routes/public-identity"));
const instructor_wallet_1 = __importDefault(require("./routes/instructor-wallet"));
const instructor_video_requests_1 = __importDefault(require("./routes/instructor-video-requests"));
const support_tickets_1 = __importDefault(require("./routes/support-tickets"));
const admin_work_items_1 = __importDefault(require("./routes/admin-work-items"));
const platform_tenants_1 = __importDefault(require("./routes/platform-tenants"));
const tenant_invitations_1 = __importDefault(require("./routes/tenant-invitations"));
const admin_members_1 = __importDefault(require("./routes/admin-members"));
const tenant_self_1 = __importDefault(require("./routes/tenant-self"));
const admin_approvals_1 = __importDefault(require("./routes/admin-approvals"));
const admin_dashboard_1 = __importDefault(require("./routes/admin-dashboard"));
const admin_insights_1 = __importDefault(require("./routes/admin-insights"));
const exam_versions_1 = __importStar(require("./routes/exam-versions"));
const gradebook_1 = __importDefault(require("./routes/gradebook"));
const schedules_1 = __importDefault(require("./routes/schedules"));
const attendance_records_1 = __importDefault(require("./routes/attendance-records"));
const platform_flags_1 = __importDefault(require("./routes/platform-flags"));
const audit_logs_1 = __importDefault(require("./routes/audit-logs"));
const moderation_1 = __importDefault(require("./routes/moderation"));
const search_1 = __importDefault(require("./routes/search"));
const tenant_export_1 = __importStar(require("./routes/tenant-export"));
const platform_mfa_1 = __importDefault(require("./routes/platform-mfa"));
const impersonation_1 = __importDefault(require("./routes/impersonation"));
const ops_1 = require("./routes/ops");
const logger_1 = require("./services/logger");
const metrics_1 = require("./services/metrics");
const minio_1 = require("./services/minio");
const subscription_lifecycle_1 = require("./services/subscription-lifecycle");
const auth_2 = require("./middleware/auth");
const impersonation_context_1 = require("./middleware/impersonation-context");
const student_workspace_boundary_1 = require("./middleware/student-workspace-boundary");
const tenant_authority_boundary_1 = require("./middleware/tenant-authority-boundary");
const school_reporting_wiring_1 = require("./services/school-reporting-wiring");
dotenv_1.default.config();
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const PORT = process.env.PORT || 3001;
/** The single processing-queue consumer; started when the DB is available. */
let videoQueueConsumer = null;
/** Single-flight shutdown: every signal/error observes the same promise. */
let shutdownPromise = null;
/** Intervals this bootstrap starts and therefore must stop. */
const ownedIntervals = new Set();
const startOwnedInterval = (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    ownedIntervals.add(timer);
};
const stopOwnedIntervals = () => {
    for (const timer of ownedIntervals)
        clearInterval(timer);
    ownedIntervals.clear();
};
function isAllowedCorsOrigin(origin, corsOrigin, vercelUrl) {
    const allowedOrigins = [
        'http://localhost:8080',
        'http://localhost:8081',
        'http://localhost:3000',
        'http://127.0.0.1:8080',
        'http://127.0.0.1:8081',
        'http://127.0.0.1:3000',
        corsOrigin,
        vercelUrl ? `https://${vercelUrl}` : undefined,
    ].filter((value) => Boolean(value));
    if (!origin || allowedOrigins.includes(origin))
        return true;
    try {
        const parsedOrigin = new URL(origin);
        return parsedOrigin.origin === origin
            && (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:')
            && (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1');
    }
    catch {
        return false;
    }
}
function trustedProxyAddresses(value) {
    return value ? value.split(',').map((address) => address.trim()).filter(Boolean) : [];
}
function getErrorResponse(error) {
    const record = typeof error === 'object' && error !== null ? error : {};
    if (record.type === 'entity.parse.failed')
        return { status: 400, body: { error: 'Invalid JSON body' } };
    if (record.type === 'entity.too.large')
        return { status: 413, body: { error: 'Request body too large' } };
    if (record.type === 'request.aborted')
        return { status: 400, body: { error: 'Request interrupted' } };
    if (record.name === 'MulterError') {
        return { status: 400, body: { error: 'ملف الإثبات غير صالح أو يتجاوز الحد الأقصى 8MB' } };
    }
    return { status: 500, body: { error: 'Internal server error', message: 'Internal server error' } };
}
// Only explicitly configured proxy addresses may supply client IPs through X-Forwarded-For.
app.set('trust proxy', trustedProxyAddresses(process.env.TRUSTED_PROXY_IPS));
// Middleware
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (isAllowedCorsOrigin(origin, process.env.CORS_ORIGIN, process.env.VERCEL_URL)) {
            callback(null, true);
        }
        else
            callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
    exposedHeaders: ['X-Results-Truncated'],
}));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Initialize Socket.IO
const socketServer = (0, socket_1.setupSocketIO)(httpServer);
// One structured request observer; no raw URL/query logging of signed tokens.
(0, ops_1.mountObservability)(app, {
    logger: (0, logger_1.createLogger)(),
    metrics: (0, metrics_1.createMetricsRegistry)(),
    metricsToken: process.env.METRICS_TOKEN,
    readiness: [(0, ops_1.createDatabaseReadinessCheck)()],
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// API Routes
// Parent read-only views authenticate with their own scoped opaque HMAC token
// (`pv1.<payload>.<sig>`), not a JWT. It must be mounted BEFORE the optionalAuth
// guard below, because optionalAuth would jwt.verify the Bearer value and
// reject the opaque token with 401 "Invalid token". The surface is
// independently authenticated, so it can never verify an impersonation
// context: a presented `x-impersonation` header is explicitly REFUSED on this
// mount instead of being silently bypassed.
app.use('/api/parent', (req, res, next) => (0, impersonation_context_1.rejectImpersonationHeader)(req, res, next));
app.use('/api/parent', parent_views_1.default);
// Resolve any supplied credential before route handlers. Invalid credentials
// must never degrade into anonymous access; public routes still allow no token.
app.use('/api', auth_2.optionalAuth, tenant_authority_boundary_1.enforceTenantAuthorityBoundary, student_workspace_boundary_1.enforceStudentWorkspaceBoundary);
// M7 O6 impersonation — request-context enforcement. Registered immediately
// after the shared /api guard chain (and therefore after authentication) and
// BEFORE EVERY business router below, so a presented `x-impersonation` header
// is verified against the LIVE session row, bound to the authenticated support
// ACTOR, and resolved to the effective TARGET principal before any business
// handler can run; an absent header leaves the request an ordinary request.
// Path-less so every /api surface below is covered exactly like the guard
// chain above covers it, and it can never precede authentication.
app.use(impersonation_context_1.enforceImpersonationContext);
// Session management (start/approve/revoke/list) behind the router's own
// authenticate + verified platform permissions. An issued context can never
// manage sessions: the enforcement denies the management namespace first.
app.use('/api/platform/impersonation', impersonation_1.default);
app.use('/api/parent-links', parent_links_1.default);
app.use('/api/notification-consent', notification_consent_1.default);
app.use('/api/lesson-discussions', lesson_discussions_1.default);
app.use('/api/search', search_1.default);
app.use('/api/tenant-exports', tenant_export_1.default);
app.use('/api/platform/mfa', platform_mfa_1.default);
app.use('/api/auth', auth_1.default);
app.use('/api/groups', groups_1.default);
app.use('/api/grades', grades_1.default);
app.use('/api/students', students_1.default);
app.use('/api/courses', courses_1.default);
// M2-22 — anonymous read-only published-course discovery. Mounted under the
// same `/api` boundary as every other route, so `optionalAuth`, the tenant
// authority boundary and the student workspace boundary all still run: an
// INVALID credential is rejected upstream rather than degrading into anonymous
// access, a client-supplied tenant selector is refused, and a student without a
// selected workspace is refused. The router itself consults no principal and
// answers byte-identical results to an anonymous caller.
//
// ORDER IS DELIBERATE AND LOAD-BEARING: this router is mounted BEFORE
// publicIdentityRoutes so `GET /api/public/courses` can only ever resolve to
// the M2-22 contract (`{ courses, next_cursor }`, explicit publication gate).
// The legacy discovery handler that previously shadowed it here was removed
// from public-identity.ts; this order is defense in depth so a future
// `/courses` route added to the identity router can never win the collision
// again. See server/tests/m2-public-catalog-composition.test.ts.
app.use('/api/public', public_catalog_1.default);
// C1/C4 public identity pages (teacher/center). Registers NO course-list
// route; every course it projects is gated by explicit publication.
app.use('/api/public', public_identity_1.default);
app.use('/api/attendance', attendance_1.default);
app.use('/api/exams', exams_1.default);
app.use('/api/exam-results', exam_results_1.default);
app.use('/api/subscriptions', subscriptions_1.default);
app.use('/api/subscription-plans', subscription_plans_1.default);
app.use('/api/materials', materials_1.default);
app.use('/api/lectures', lectures_1.default);
app.use('/api/registration-requests', registration_requests_1.default);
app.use('/api/fees', fees_1.default);
app.use('/api/payment-requests', payment_requests_1.default);
app.use('/api/notifications', notifications_1.default);
app.use('/api/subscription-requests', subscription_requests_1.default);
app.use('/api/files', files_1.default);
app.use('/api/expenses', expenses_1.default);
app.use('/api/imports', imports_1.default);
app.use('/api/messages', messages_1.default);
app.use('/api/videos', videos_1.default);
app.use('/api/secure-video', secure_video_1.default);
app.use('/api/manual-grading', manual_grading_1.default);
app.use('/api/staff', staff_1.default);
app.use('/api/premium-lectures', premium_lectures_1.default);
app.use('/api/ai-chat', ai_chat_1.default);
app.use('/api/meetings', meetings_1.default);
app.use('/api/instructors', instructors_1.default);
app.use('/api/instructor-wallet', instructor_wallet_1.default);
app.use('/api/instructor-video-requests', instructor_video_requests_1.default);
app.use('/api/support-tickets', support_tickets_1.default);
app.use('/api/admin/work-items', admin_work_items_1.default);
app.use('/api/admin/platform', platform_tenants_1.default);
app.use('/api/tenant-invitations', tenant_invitations_1.default);
app.use('/api/admin/members', admin_members_1.default);
app.use('/api/tenants/me', tenant_self_1.default);
app.use('/api/admin/approvals', admin_approvals_1.default);
app.use('/api/admin/dashboard', admin_dashboard_1.default);
app.use('/api/admin/insights', admin_insights_1.default);
app.use('/api/student-enrollment', student_enrollment_1.default);
app.use('/api/branches', branches_1.default);
// M2/M3 surfaces. Every mount below sits behind the /api guards above, so a
// supplied credential is resolved to a verified principal before any handler
// and an anonymous caller is denied at the router's own authenticate step.
app.use('/api/content', content_access_1.default);
// M2-23 — server-authoritative student learning path. A separate router so the
// owner-only teaching catalog (`/api/tenants/me/catalog`) is never widened by
// it. Mounted under the same `/api` guards as every other route, so
// `optionalAuth`, the tenant authority boundary and the student workspace
// boundary all still run before the router's own student-only gate.
app.use('/api/student-course-access', student_course_access_1.default);
app.use('/api/tenant/branding', tenant_branding_1.default);
app.use('/api/tenant/domains', tenant_domains_1.default);
app.use('/api/announcements', announcements_1.default);
app.use('/api/student-import', student_import_1.default);
app.use('/api/video-assets', video_assets_1.default);
app.use('/api/playback', playback_sessions_1.default);
app.use('/api/question-bank', question_bank_1.default);
app.use('/api/assignments', assignments_1.default);
app.use('/api/exam-versions', exam_versions_1.default);
app.use('/api/gradebook', gradebook_1.default);
// Human decision (2026-10-19): the product serves school teachers and their
// students, not a graduation/certificate platform. The certificates router is
// intentionally NOT mounted here. Source, migrations and historic data are
// preserved (nothing deleted) — only public exposure is removed. See
// docs/streams/server/TEACHER-SCHOOL-PRODUCT-ALIGNMENT.md and docs17 A8 /
// docs18 certificate mentions (marked superseded by human decision).
app.use('/api/schedules', schedules_1.default);
app.use('/api/attendance-records', attendance_records_1.default);
// M7 platform surfaces. Mounted behind the same /api guards above: a supplied
// credential is resolved to a verified principal before any handler, and each
// router re-checks the verified platform permission / tenant authority
// (deny-by-default) rather than trusting a JWT role claim.
app.use('/api/platform/flags', platform_flags_1.default);
app.use('/api/audit-logs', audit_logs_1.default);
app.use('/api/moderation', moderation_1.default);
// B2-C school reporting surfaces. Mounted once, after the /api guard chain and
// the impersonation-context enforcement above, so the impersonation/auth
// context applies before any handler. Each router authenticates first and then
// runs the lazy schema-readiness check (503 fail-closed) before data access.
const schoolReportingRouters = (0, school_reporting_wiring_1.createSchoolReportingRouters)({
    db: (0, school_reporting_wiring_1.createDefaultReportingDatabase)(),
    authenticate: auth_2.authenticateToken,
});
app.use('/api/exam-manual-grading', schoolReportingRouters.examManualGrading);
app.use('/api/progress-reports', schoolReportingRouters.progressReports);
app.use('/api/attendance-reports', schoolReportingRouters.attendanceReports);
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});
// Error handler
app.use((err, _req, res, next) => {
    const response = getErrorResponse(err);
    // Driver exceptions may contain SQL, bound parameters and provider URLs.
    // Log only the classified status, never the upstream exception/body.
    console.error('Request failed', { status: response.status });
    if (res.destroyed || res.writableEnded)
        return;
    if (res.headersSent) {
        next(new Error('Request failed after response started'));
        return;
    }
    res.status(response.status).json(response.body);
});
// Start server
const startServer = async () => {
    try {
        // Initialize MinIO buckets
        console.log('🗄️  Initializing MinIO storage...');
        try {
            await (0, minio_1.initializeBuckets)();
            console.log('✅ MinIO storage ready');
        }
        catch (minioError) {
            console.warn('⚠️  MinIO initialization failed (video uploads will not work):', minioError);
        }
        // Optionally skip DB connection on start for local development
        const skipDb = process.env.SKIP_DB_ON_START === 'true';
        let dbConnected = false;
        if (!skipDb) {
            // Test database connection
            dbConnected = await (0, db_1.testConnection)();
            if (!dbConnected) {
                console.error('❌ Failed to connect to database. Server will not start.');
                process.exit(1);
            }
        }
        else {
            console.warn('⚠️ SKIP_DB_ON_START is set — skipping DB connectivity check (dev only)');
        }
        // Explicit deployment opt-in; no catalog access during module import.
        // Failure leaves the mounted export surface at its audited 503.
        if (!skipDb && process.env.TENANT_EXPORT_VERIFY_ON_START === 'true') {
            const report = await (0, tenant_export_1.initializeTenantExportOwnership)();
            console.log('[Tenant export] Ownership catalog verification:', report.status);
        }
        if (shutdownPromise) {
            console.warn('⚠️  Shutdown requested during startup; not opening the listener');
            return;
        }
        const server = httpServer.listen(Number(PORT), '0.0.0.0', () => {
            if (shutdownPromise) {
                httpServer.close();
                return;
            }
            console.log(`
╔════════════════════════════════════════════════╗
║                                                ║
║   🚀 Tabweb Academy Backend API Server          ║
║                                                ║
║   📡 Localhost: http://localhost:${PORT}       ║
║   📱 Network: http://0.0.0.0:${PORT}           ║
║   🗄️  Database: MySQL (${process.env.DB_NAME})           ║
║   🌍 CORS: All origins allowed (dev mode)  ║
║                                                ║
║   📚 Available API Routes:                     ║
║                                                ║
║   🔐 Authentication:                           ║
║   • POST   /api/auth/login                     ║
║   • POST   /api/auth/register                  ║
║   • GET    /api/auth/me                        ║
║                                                ║
║   👥 Students (CRUD):                          ║
║   • GET    /api/students                       ║
║   • POST   /api/students                       ║
║   • PUT    /api/students/:id                   ║
║   • DELETE /api/students/:id                   ║
║                                                ║
║   📖 Courses (CRUD):                           ║
║   • GET    /api/courses                        ║
║   • POST   /api/courses                        ║
║   • PUT    /api/courses/:id                    ║
║   • DELETE /api/courses/:id                    ║
║                                                ║
║   👨‍👩‍👧‍👦 Groups (CRUD):                           ║
║   • GET    /api/groups                         ║
║   • POST   /api/groups                         ║
║   • PUT    /api/groups/:id                     ║
║   • DELETE /api/groups/:id                     ║
║                                                ║
║   🎓 Grades (CRUD):                            ║
║   • GET    /api/grades                         ║
║   • POST   /api/grades                         ║
║   • PUT    /api/grades/:id                     ║
║   • DELETE /api/grades/:id                     ║
║                                                ║
║   📊 Attendance:                               ║
║   • GET    /api/attendance                     ║
║   • POST   /api/attendance                     ║
║                                                ║
║   📝 Exams:                                    ║
║   • GET    /api/exams                          ║
║                                                ║
║   ❤️  Health Check:                            ║
║   • GET    /health                             ║
║                                                ║
╚════════════════════════════════════════════════╝
            `);
            // Enabled by default after the SaaS migrations. Set the flag to "false"
            // only for an intentionally paused environment. A database advisory lock
            // keeps multiple API instances from processing the same batch.
            if (process.env.SAAS_LIFECYCLE_JOBS_ENABLED !== 'false' && !skipDb) {
                const reconcile = async () => {
                    try {
                        let processed;
                        do {
                            processed = await (0, subscription_lifecycle_1.reconcileTenantSubscriptions)();
                        } while (processed === 100);
                    }
                    catch (error) {
                        console.error('[SaaS lifecycle] Reconciliation failed:', error);
                    }
                };
                void reconcile();
                startOwnedInterval(() => void reconcile(), 60 * 1000);
            }
            // Single coherent consumer of the processing queue: an immediate
            // sweep at startup — a crash between the claim+enqueue commit
            // and the in-process run leaves a committed
            // video_processing_queue row no worker would otherwise pick up —
            // then a periodic sweep. Every run goes through the shared
            // protected path (cross-process named lock, exact tenant
            // matching, bounded concurrency, row settling). No path here
            // touches the processor directly.
            if (!skipDb) {
                videoQueueConsumer ?? (videoQueueConsumer = (0, videos_1.scheduleVideoQueueConsumer)());
                videoQueueConsumer.start();
                // Bootstrap owns the sweep; importing the router never starts it.
                (0, video_security_1.startDeadSessionCleanup)();
            }
            if (!skipDb) {
                const cleanupPrivacyData = async () => {
                    try {
                        await (0, student_enrollment_1.cleanupEnrollmentPrivacyData)();
                    }
                    catch (error) {
                        console.error('[Privacy cleanup] Failed:', error);
                    }
                };
                void cleanupPrivacyData();
                startOwnedInterval(() => void cleanupPrivacyData(), 6 * 60 * 60 * 1000);
            }
            // Non-interactive auto-submit: expire overdue exam attempts that no
            // student ever submitted, grading answers saved so far. An immediate
            // pass at startup, then a periodic sweep. A slow pass never overlaps
            // the next tick: an in-flight pass skips the tick it would collide with.
            if (!skipDb) {
                let examExpiryInFlight = false;
                const expireExamAttempts = async () => {
                    if (examExpiryInFlight)
                        return;
                    examExpiryInFlight = true;
                    try {
                        await (0, exam_versions_1.runExamAttemptExpiryPass)();
                    }
                    catch (error) {
                        console.error('[Exam expiry] Failed:', error);
                    }
                    finally {
                        examExpiryInFlight = false;
                    }
                };
                void expireExamAttempts();
                startOwnedInterval(() => void expireExamAttempts(), 60 * 1000);
            }
            // Recover stuck video processing happens through the unified
            // queue consumer above: no startup path resets a video status or
            // invokes the processor directly. Stale 'processing' rows are
            // re-claimed only after the named lock proves their claimant is
            // gone (server/src/routes/videos.ts runVideoProcessingJob).
        });
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                // Never locate or kill the unrelated owner of this port, and
                // never retry the same listener: startup fails explicitly.
                console.error(`❌ Port ${PORT} is already in use; refusing to kill the existing listener or retry`);
                process.exit(1);
            }
            console.error('❌ Server error:', error);
            void beginShutdown('Server error', 1);
        });
    }
    catch (error) {
        console.error('❌ Server startup failed:', error);
        process.exit(1);
    }
};
// Handle graceful shutdown
/** Bounded drain: in-flight processing runs settle, or the process exits anyway. */
const VIDEO_SHUTDOWN_DRAIN_MS = 30000;
/** Dedicated lock pools should close immediately once processing has drained. */
const LOCK_POOL_CLOSE_DRAIN_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Lets one close/drain promise settle, but never past its deadline. */
const waitForShutdownStep = async (work, deadline) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
        return;
    let timer;
    try {
        await Promise.race([
            work,
            new Promise((resolve) => {
                timer = setTimeout(resolve, remaining);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
};
const gracefulShutdown = async (exitCode) => {
    // Stop every interval this bootstrap owns, plus the timers owned by the
    // dead-session/queue services through their explicit stop ports.
    stopOwnedIntervals();
    (0, video_security_1.stopDeadSessionCleanup)();
    // Stop the queue consumer first: no NEW processing runs during shutdown.
    if (videoQueueConsumer)
        videoQueueConsumer.stop();
    (0, videos_1.requestVideoProcessingShutdown)();
    // Stop admitting HTTP connections, then disconnect Socket.IO clients.
    // io.close() also closes/waits for the attached HTTP server; the earlier
    // httpServer.close() is the admission cut and is safe to repeat.
    const deadline = Date.now() + VIDEO_SHUTDOWN_DRAIN_MS;
    httpServer.close();
    const socketClose = socketServer.close().catch((error) => {
        console.error('⚠️  Socket/HTTP close failed:', error);
    });
    // Bounded drain: an in-flight run holds a dedicated lock connection and
    // will settle its queue row when it finishes. It runs while sockets/HTTP
    // finish closing, so neither drain starves the other before the deadline.
    while ((0, videos_1.inFlightVideoProcessingCount)() > 0 && Date.now() < deadline) {
        await sleep(500);
    }
    if ((0, videos_1.inFlightVideoProcessingCount)() > 0) {
        console.warn('⚠️  Shutdown drain timed out with processing still in flight; exiting (MySQL releases owner-dead locks with their sessions)');
    }
    await waitForShutdownStep(socketClose, deadline);
    // Dedicated lock pools: closing them returns their sessions cleanly; a
    // held named lock dies with its connection either way. Never the
    // request pool — db.ts owns that one.
    const closeLockPools = Promise.allSettled([(0, videos_1.closeUploadLockPool)(), (0, videos_1.closeProcessingLockPool)()]);
    await waitForShutdownStep(closeLockPools, Date.now() + LOCK_POOL_CLOSE_DRAIN_MS);
    process.exit(exitCode);
};
/** Single-flight: duplicate SIGINT/SIGTERM or a late server error is a no-op. */
const beginShutdown = (reason, exitCode = 0) => {
    if (shutdownPromise) {
        console.warn(`⚠️  Shutdown already in progress; ignoring ${reason}`);
        return shutdownPromise;
    }
    console.log(`⚠️  ${reason}, shutting down gracefully...`);
    shutdownPromise = gracefulShutdown(exitCode).catch((error) => {
        console.error('❌ Graceful shutdown failed:', error);
        process.exit(1);
    });
    return shutdownPromise;
};
process.on('SIGTERM', () => {
    void beginShutdown('SIGTERM received');
});
process.on('SIGINT', () => {
    void beginShutdown('SIGINT received');
});
startServer();
