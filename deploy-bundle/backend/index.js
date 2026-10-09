"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const db_1 = require("./db");
const http_1 = require("http");
const socket_1 = require("./services/socket");
const path_1 = __importDefault(require("path"));
// Import routes
const auth_1 = __importDefault(require("./routes/auth"));
const groups_1 = __importDefault(require("./routes/groups"));
const grades_1 = __importDefault(require("./routes/grades"));
const students_1 = __importDefault(require("./routes/students"));
const courses_1 = __importDefault(require("./routes/courses"));
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
const expenses_1 = __importDefault(require("./routes/expenses"));
const imports_1 = __importDefault(require("./routes/imports"));
const migrations_1 = __importDefault(require("./routes/migrations"));
const messages_1 = __importDefault(require("./routes/messages"));
const videos_1 = __importDefault(require("./routes/videos"));
const secure_video_1 = __importDefault(require("./routes/secure-video"));
const manual_grading_1 = __importDefault(require("./routes/manual-grading"));
const staff_1 = __importDefault(require("./routes/staff"));
const premium_lectures_1 = __importDefault(require("./routes/premium-lectures"));
const ai_chat_1 = __importDefault(require("./routes/ai-chat"));
const meetings_1 = __importDefault(require("./routes/meetings"));
const minio_1 = require("./services/minio");
const db_2 = require("./db");
const video_processor_1 = require("./services/video-processor");
dotenv_1.default.config();
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
const PORT = process.env.PORT || 3001;
// Middleware
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        const allowedOrigins = [
            'http://localhost:8080',
            'http://localhost:8081',
            'http://localhost:3000',
            'http://127.0.0.1:8080',
            'http://127.0.0.1:8081',
            'http://127.0.0.1:3000',
            process.env.CORS_ORIGIN,
            process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
        ].filter(Boolean);
        // Allow requests from localhost on any port (development)
        if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1') || allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(null, true); // Allow all in production (Vercel will handle it)
        }
    },
    credentials: true,
}));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Serve uploaded files - both with and without /api prefix
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
app.use('/api/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Initialize Socket.IO
(0, socket_1.setupSocketIO)(httpServer);
// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// Serve uploaded files
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// API Routes
app.use('/api/auth', auth_1.default);
app.use('/api/groups', groups_1.default);
app.use('/api/grades', grades_1.default);
app.use('/api/students', students_1.default);
app.use('/api/courses', courses_1.default);
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
app.use('/api/expenses', expenses_1.default);
app.use('/api/imports', imports_1.default);
app.use('/api/migrations', migrations_1.default);
app.use('/api/messages', messages_1.default);
app.use('/api/videos', videos_1.default);
app.use('/api/secure-video', secure_video_1.default);
app.use('/api/manual-grading', manual_grading_1.default);
app.use('/api/staff', staff_1.default);
app.use('/api/premium-lectures', premium_lectures_1.default);
app.use('/api/ai-chat', ai_chat_1.default);
app.use('/api/meetings', meetings_1.default);
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});
// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
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
        const server = httpServer.listen(Number(PORT), '0.0.0.0', () => {
            console.log(`
╔════════════════════════════════════════════════╗
║                                                ║
║   🚀 Al-Qaed Backend API Server                ║
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
            // Recover stuck video processing (from previous server crash/restart)
            setTimeout(async () => {
                try {
                    const stuck = await (0, db_2.query)(`SELECT id FROM videos WHERE status IN ('processing') AND created_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)`, []);
                    if (stuck && stuck.length > 0) {
                        console.log(`[Startup] Found ${stuck.length} stuck processing videos, re-triggering...`);
                        for (const video of stuck) {
                            await (0, db_2.execute)(`UPDATE videos SET status = 'uploading', processing_progress = 0 WHERE id = ?`, [video.id]);
                            // Stagger processing to avoid overloading
                            await new Promise(r => setTimeout(r, 2000));
                            (0, video_processor_1.processVideo)(video.id).catch(err => {
                                console.error(`[Startup] Failed to re-process video ${video.id}:`, err);
                            });
                        }
                    }
                }
                catch (err) {
                    console.error('[Startup] Error recovering stuck videos:', err);
                }
            }, 15000); // Wait 15s after startup to let everything stabilize
        });
        server.on('error', (error) => {
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
                }
                catch {
                    process.exit(1);
                }
            }
            else {
                console.error('❌ Server error:', error);
                process.exit(1);
            }
        });
    }
    catch (error) {
        console.error('❌ Server startup failed:', error);
        process.exit(1);
    }
};
// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received, shutting down gracefully...');
    process.exit(0);
});
process.on('SIGINT', () => {
    console.log('⚠️  SIGINT received, shutting down gracefully...');
    process.exit(0);
});
startServer();
