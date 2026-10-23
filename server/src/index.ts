// Load environment before route defaults capture dedicated service secrets.
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { testConnection } from './db';
import { createServer } from 'http';
import { setupSocketIO } from './services/socket';
import studentEnrollmentRoutes, { cleanupEnrollmentPrivacyData } from './routes/student-enrollment';
import branchesRoutes from './routes/branches';
import contentAccessRoutes from './routes/content-access';
import questionBankRoutes from './routes/question-bank';
import assignmentsRoutes from './routes/assignments';
import tenantBrandingRoutes from './routes/tenant-branding';
import tenantDomainsRoutes from './routes/tenant-domains';
import announcementsRoutes from './routes/announcements';
import studentImportRoutes from './routes/student-import';
import videoAssetsRoutes from './routes/video-assets';
import playbackSessionsRoutes from './routes/playback-sessions';
import parentLinksRoutes from './routes/parent-links';
import parentViewsRoutes from './routes/parent-views';
import notificationConsentRoutes from './routes/notification-consent';
import lessonDiscussionsRoutes from './routes/lesson-discussions';

// Import routes
import authRoutes from './routes/auth';
import groupsRoutes from './routes/groups';
import gradesRoutes from './routes/grades';
import studentsRoutes from './routes/students';
import coursesRoutes from './routes/courses';
import publicCatalogRoutes from './routes/public-catalog';
import attendanceRoutes from './routes/attendance';
import examsRoutes from './routes/exams';
import examResultsRoutes from './routes/exam-results';
import subscriptionsRoutes from './routes/subscriptions';
import subscriptionPlansRoutes from './routes/subscription-plans';
import materialsRoutes from './routes/materials';
import lecturesRoutes from './routes/lectures';
import registrationRequestsRoutes from './routes/registration-requests';
import feesRoutes from './routes/fees';
import paymentRequestsRoutes from './routes/payment-requests';
import notificationsRoutes from './routes/notifications';
import subscriptionRequestsRoutes from './routes/subscription-requests';
import filesRoutes from './routes/files';
import expensesRoutes from './routes/expenses';
import importsRoutes from './routes/imports';
import messagesRoutes from './routes/messages';
import videosRoutes, {
    scheduleVideoQueueConsumer,
    requestVideoProcessingShutdown,
    inFlightVideoProcessingCount,
    closeUploadLockPool,
    closeProcessingLockPool,
} from './routes/videos';
import secureVideoRoutes from './routes/secure-video';
import manualGradingRoutes from './routes/manual-grading';
import staffRoutes from './routes/staff';
import premiumLecturesRoutes from './routes/premium-lectures';
import aiChatRoutes from './routes/ai-chat';
import meetingsRoutes from './routes/meetings';
import instructorsRoutes from './routes/instructors';
import publicIdentityRoutes from './routes/public-identity';
import instructorWalletRoutes from './routes/instructor-wallet';
import instructorVideoRequestsRoutes from './routes/instructor-video-requests';
import supportTicketsRoutes from './routes/support-tickets';
import adminWorkItemsRoutes from './routes/admin-work-items';
import platformTenantsRoutes from './routes/platform-tenants';
import tenantInvitationsRoutes from './routes/tenant-invitations';
import adminMembersRoutes from './routes/admin-members';
import tenantSelfRoutes from './routes/tenant-self';
import adminApprovalsRoutes from './routes/admin-approvals';
import adminDashboardRoutes from './routes/admin-dashboard';
import adminInsightsRoutes from './routes/admin-insights';
import examVersionsRoutes, { runExamAttemptExpiryPass } from './routes/exam-versions';
import gradebookRoutes from './routes/gradebook';
import schedulesRoutes from './routes/schedules';
import attendanceRecordsRoutes from './routes/attendance-records';
import platformFlagsRoutes from './routes/platform-flags';
import auditLogsRoutes from './routes/audit-logs';
import moderationRoutes from './routes/moderation';
import searchRoutes from './routes/search';
import tenantExportRoutes from './routes/tenant-export';
import platformMfaRoutes from './routes/platform-mfa';
import impersonationRoutes from './routes/impersonation';
import { mountObservability, createDatabaseReadinessCheck } from './routes/ops';
import { createLogger } from './services/logger';
import { createMetricsRegistry } from './services/metrics';
import { initializeBuckets } from './services/minio';
import { reconcileTenantSubscriptions } from './services/subscription-lifecycle';
import { optionalAuth, authenticateToken } from './middleware/auth';
import { enforceImpersonationContext, rejectImpersonationHeader } from './middleware/impersonation-context';
import { enforceStudentWorkspaceBoundary } from './middleware/student-workspace-boundary';
import { enforceTenantAuthorityBoundary } from './middleware/tenant-authority-boundary';
import { createDefaultReportingDatabase, createSchoolReportingRouters } from './services/school-reporting-wiring';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

/** The single processing-queue consumer; started when the DB is available. */
let videoQueueConsumer: ReturnType<typeof scheduleVideoQueueConsumer> | null = null;

function isAllowedCorsOrigin(origin: string | undefined, corsOrigin: string | undefined, vercelUrl: string | undefined): boolean {
    const allowedOrigins = [
        'http://localhost:8080',
        'http://localhost:8081',
        'http://localhost:3000',
        'http://127.0.0.1:8080',
        'http://127.0.0.1:8081',
        'http://127.0.0.1:3000',
        corsOrigin,
        vercelUrl ? `https://${vercelUrl}` : undefined,
    ].filter((value): value is string => Boolean(value));

    if (!origin || allowedOrigins.includes(origin)) return true;

    try {
        const parsedOrigin = new URL(origin);
        return parsedOrigin.origin === origin
            && (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:')
            && (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1');
    } catch {
        return false;
    }
}

function trustedProxyAddresses(value: string | undefined): string[] {
    return value ? value.split(',').map((address) => address.trim()).filter(Boolean) : [];
}

function getErrorResponse(error: unknown) {
    const record = typeof error === 'object' && error !== null ? error as { name?: unknown; type?: unknown } : {};
    if (record.type === 'entity.parse.failed') return { status: 400, body: { error: 'Invalid JSON body' } };
    if (record.type === 'entity.too.large') return { status: 413, body: { error: 'Request body too large' } };
    if (record.type === 'request.aborted') return { status: 400, body: { error: 'Request interrupted' } };
    if (record.name === 'MulterError') {
        return { status: 400, body: { error: 'ملف الإثبات غير صالح أو يتجاوز الحد الأقصى 8MB' } };
    }
    return { status: 500, body: { error: 'Internal server error', message: 'Internal server error' } };
}

// Only explicitly configured proxy addresses may supply client IPs through X-Forwarded-For.
app.set('trust proxy', trustedProxyAddresses(process.env.TRUSTED_PROXY_IPS));

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        if (isAllowedCorsOrigin(origin, process.env.CORS_ORIGIN, process.env.VERCEL_URL)) {
            callback(null, true);
        } else callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
    exposedHeaders: ['X-Results-Truncated'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize Socket.IO
setupSocketIO(httpServer);

// One structured request observer; no raw URL/query logging of signed tokens.
mountObservability(app, {
    logger: createLogger(),
    metrics: createMetricsRegistry(),
    metricsToken: process.env.METRICS_TOKEN,
    readiness: [createDatabaseReadinessCheck()],
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
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
app.use('/api/parent', (req: Request, res: Response, next: NextFunction) => rejectImpersonationHeader(req, res, next));
app.use('/api/parent', parentViewsRoutes);

// Resolve any supplied credential before route handlers. Invalid credentials
// must never degrade into anonymous access; public routes still allow no token.
app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary);

// M7 O6 impersonation — request-context enforcement. Registered immediately
// after the shared /api guard chain (and therefore after authentication) and
// BEFORE EVERY business router below, so a presented `x-impersonation` header
// is verified against the LIVE session row, bound to the authenticated support
// ACTOR, and resolved to the effective TARGET principal before any business
// handler can run; an absent header leaves the request an ordinary request.
// Path-less so every /api surface below is covered exactly like the guard
// chain above covers it, and it can never precede authentication.
app.use(enforceImpersonationContext);
// Session management (start/approve/revoke/list) behind the router's own
// authenticate + verified platform permissions. An issued context can never
// manage sessions: the enforcement denies the management namespace first.
app.use('/api/platform/impersonation', impersonationRoutes);

app.use('/api/parent-links', parentLinksRoutes);
app.use('/api/notification-consent', notificationConsentRoutes);
app.use('/api/lesson-discussions', lessonDiscussionsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/tenant-exports', tenantExportRoutes);
app.use('/api/platform/mfa', platformMfaRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/grades', gradesRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/courses', coursesRoutes);
app.use('/api/public', publicIdentityRoutes);
// M2-22 — anonymous read-only published-course discovery. Mounted under the
// same `/api` boundary as every other route, so `optionalAuth`, the tenant
// authority boundary and the student workspace boundary all still run: an
// INVALID credential is rejected upstream rather than degrading into anonymous
// access, a client-supplied tenant selector is refused, and a student without a
// selected workspace is refused. The router itself consults no principal and
// answers byte-identical results to an anonymous caller.
app.use('/api/public', publicCatalogRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/exams', examsRoutes);
app.use('/api/exam-results', examResultsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/subscription-plans', subscriptionPlansRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/lectures', lecturesRoutes);
app.use('/api/registration-requests', registrationRequestsRoutes);
app.use('/api/fees', feesRoutes);
app.use('/api/payment-requests', paymentRequestsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/subscription-requests', subscriptionRequestsRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/imports', importsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/videos', videosRoutes);
app.use('/api/secure-video', secureVideoRoutes);
app.use('/api/manual-grading', manualGradingRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/premium-lectures', premiumLecturesRoutes);
app.use('/api/ai-chat', aiChatRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/api/instructors', instructorsRoutes);
app.use('/api/instructor-wallet', instructorWalletRoutes);
app.use('/api/instructor-video-requests', instructorVideoRequestsRoutes);
app.use('/api/support-tickets', supportTicketsRoutes);
app.use('/api/admin/work-items', adminWorkItemsRoutes);
app.use('/api/admin/platform', platformTenantsRoutes);
app.use('/api/tenant-invitations', tenantInvitationsRoutes);
app.use('/api/admin/members', adminMembersRoutes);
app.use('/api/tenants/me', tenantSelfRoutes);
app.use('/api/admin/approvals', adminApprovalsRoutes);
app.use('/api/admin/dashboard', adminDashboardRoutes);
app.use('/api/admin/insights', adminInsightsRoutes);
app.use('/api/student-enrollment', studentEnrollmentRoutes);
app.use('/api/branches', branchesRoutes);

// M2/M3 surfaces. Every mount below sits behind the /api guards above, so a
// supplied credential is resolved to a verified principal before any handler
// and an anonymous caller is denied at the router's own authenticate step.
app.use('/api/content', contentAccessRoutes);
app.use('/api/tenant/branding', tenantBrandingRoutes);
app.use('/api/tenant/domains', tenantDomainsRoutes);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/student-import', studentImportRoutes);
app.use('/api/video-assets', videoAssetsRoutes);
app.use('/api/playback', playbackSessionsRoutes);
app.use('/api/question-bank', questionBankRoutes);
app.use('/api/assignments', assignmentsRoutes);
app.use('/api/exam-versions', examVersionsRoutes);
app.use('/api/gradebook', gradebookRoutes);
// Human decision (2026-10-19): the product serves school teachers and their
// students, not a graduation/certificate platform. The certificates router is
// intentionally NOT mounted here. Source, migrations and historic data are
// preserved (nothing deleted) — only public exposure is removed. See
// docs/streams/server/TEACHER-SCHOOL-PRODUCT-ALIGNMENT.md and docs17 A8 /
// docs18 certificate mentions (marked superseded by human decision).
app.use('/api/schedules', schedulesRoutes);
app.use('/api/attendance-records', attendanceRecordsRoutes);

// M7 platform surfaces. Mounted behind the same /api guards above: a supplied
// credential is resolved to a verified principal before any handler, and each
// router re-checks the verified platform permission / tenant authority
// (deny-by-default) rather than trusting a JWT role claim.
app.use('/api/platform/flags', platformFlagsRoutes);
app.use('/api/audit-logs', auditLogsRoutes);
app.use('/api/moderation', moderationRoutes);

// B2-C school reporting surfaces. Mounted once, after the /api guard chain and
// the impersonation-context enforcement above, so the impersonation/auth
// context applies before any handler. Each router authenticates first and then
// runs the lazy schema-readiness check (503 fail-closed) before data access.
const schoolReportingRouters = createSchoolReportingRouters({
    db: createDefaultReportingDatabase(),
    authenticate: authenticateToken,
});
app.use('/api/exam-manual-grading', schoolReportingRouters.examManualGrading);
app.use('/api/progress-reports', schoolReportingRouters.progressReports);
app.use('/api/attendance-reports', schoolReportingRouters.attendanceReports);

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const response = getErrorResponse(err);
    // Driver exceptions may contain SQL, bound parameters and provider URLs.
    // Log only the classified status, never the upstream exception/body.
    console.error('Request failed', { status: response.status });
    if (res.destroyed || res.writableEnded) return;
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
            await initializeBuckets();
            console.log('✅ MinIO storage ready');
        } catch (minioError) {
            console.warn('⚠️  MinIO initialization failed (video uploads will not work):', minioError);
        }

        // Optionally skip DB connection on start for local development
        const skipDb = process.env.SKIP_DB_ON_START === 'true';
        let dbConnected = false;
        if (!skipDb) {
            // Test database connection
            dbConnected = await testConnection();

            if (!dbConnected) {
                console.error('❌ Failed to connect to database. Server will not start.');
                process.exit(1);
            }
        } else {
            console.warn('⚠️ SKIP_DB_ON_START is set — skipping DB connectivity check (dev only)');
        }

        const server = httpServer.listen(Number(PORT), '0.0.0.0', () => {
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
                        let processed: number;
                        do {
                            processed = await reconcileTenantSubscriptions();
                        } while (processed === 100);
                    } catch (error) {
                        console.error('[SaaS lifecycle] Reconciliation failed:', error);
                    }
                };
                void reconcile();
                const lifecycleTimer = setInterval(() => void reconcile(), 60 * 1000);
                lifecycleTimer.unref();
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
                videoQueueConsumer ??= scheduleVideoQueueConsumer();
                videoQueueConsumer.start();
            }

            if (!skipDb) {
                const cleanupPrivacyData = async () => {
                    try { await cleanupEnrollmentPrivacyData(); }
                    catch (error) { console.error('[Privacy cleanup] Failed:', error); }
                };
                void cleanupPrivacyData();
                const privacyTimer = setInterval(() => void cleanupPrivacyData(), 6 * 60 * 60 * 1000);
                privacyTimer.unref();
            }

            // Non-interactive auto-submit: expire overdue exam attempts that no
            // student ever submitted, grading answers saved so far. An immediate
            // pass at startup, then a periodic sweep. A slow pass never overlaps
            // the next tick: an in-flight pass skips the tick it would collide with.
            if (!skipDb) {
                let examExpiryInFlight = false;
                const expireExamAttempts = async () => {
                    if (examExpiryInFlight) return;
                    examExpiryInFlight = true;
                    try { await runExamAttemptExpiryPass(); }
                    catch (error) { console.error('[Exam expiry] Failed:', error); }
                    finally { examExpiryInFlight = false; }
                };
                void expireExamAttempts();
                const examExpiryTimer = setInterval(() => void expireExamAttempts(), 60 * 1000);
                examExpiryTimer.unref();
            }

            // Recover stuck video processing happens through the unified
            // queue consumer above: no startup path resets a video status or
            // invokes the processor directly. Stale 'processing' rows are
            // re-claimed only after the named lock proves their claimant is
            // gone (server/src/routes/videos.ts runVideoProcessingJob).
        });

        server.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use`);
                // Try to kill the process on the port and retry once
                const { execSync } = require('child_process');
                try {
                    execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`, { stdio: 'ignore' });
                    console.log(`🔄 Killed process on port ${PORT}, retrying in 3s...`);
                    setTimeout(() => {
                        server.listen(Number(PORT), '0.0.0.0');
                    }, 3000);
                } catch {
                    process.exit(1);
                }
            } else {
                console.error('❌ Server error:', error);
                process.exit(1);
            }
        });
    } catch (error) {
        console.error('❌ Server startup failed:', error);
        process.exit(1);
    }
};

// Handle graceful shutdown
/** Bounded drain: in-flight processing runs settle, or the process exits anyway. */
const VIDEO_SHUTDOWN_DRAIN_MS = 30_000;

const gracefulShutdown = async (signal: string): Promise<void> => {
    console.log(`⚠️  ${signal} received, shutting down gracefully...`);
    // Stop the queue consumer first: no NEW processing runs during shutdown.
    if (videoQueueConsumer) videoQueueConsumer.stop();
    requestVideoProcessingShutdown();
    httpServer.close();

    // Bounded drain: an in-flight run holds a dedicated lock connection and
    // will settle its queue row when it finishes.
    const deadline = Date.now() + VIDEO_SHUTDOWN_DRAIN_MS;
    while (inFlightVideoProcessingCount() > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (inFlightVideoProcessingCount() > 0) {
        console.warn('⚠️  Shutdown drain timed out with processing still in flight; exiting (MySQL releases owner-dead locks with their sessions)');
    }

    // Dedicated lock pools: closing them returns their sessions cleanly; a
    // held named lock dies with its connection either way. Never the
    // request pool — db.ts owns that one.
    await Promise.allSettled([closeUploadLockPool(), closeProcessingLockPool()]);
    process.exit(0);
};

process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
});

startServer();
