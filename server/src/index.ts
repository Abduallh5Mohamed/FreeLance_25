import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { testConnection } from './db';
import { createServer } from 'http';
import { setupSocketIO } from './services/socket';
import path from 'path';

// Import routes
import authRoutes from './routes/auth';
import groupsRoutes from './routes/groups';
import gradesRoutes from './routes/grades';
import studentsRoutes from './routes/students';
import coursesRoutes from './routes/courses';
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
import expensesRoutes from './routes/expenses';
import importsRoutes from './routes/imports';
import migrationsRoutes from './routes/migrations';
import messagesRoutes from './routes/messages';
import videosRoutes from './routes/videos';
import manualGradingRoutes from './routes/manual-grading';
import staffRoutes from './routes/staff';
import premiumLecturesRoutes from './routes/premium-lectures';
import aiChatRoutes from './routes/ai-chat';
import meetingsRoutes from './routes/meetings';
import { initializeBuckets } from './services/minio';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
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
        } else {
            callback(null, true); // Allow all in production (Vercel will handle it)
        }
    },
    credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded files - both with and without /api prefix
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/api/uploads', express.static(path.join(__dirname, '../uploads')));

// Initialize Socket.IO
setupSocketIO(httpServer);

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/grades', gradesRoutes);
app.use('/api/students', studentsRoutes);
app.use('/api/courses', coursesRoutes);
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
app.use('/api/expenses', expensesRoutes);
app.use('/api/imports', importsRoutes);
app.use('/api/migrations', migrationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/videos', videosRoutes);
app.use('/api/manual-grading', manualGradingRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/premium-lectures', premiumLecturesRoutes);
app.use('/api/ai-chat', aiChatRoutes);
app.use('/api/meetings', meetingsRoutes);

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
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
        });

        server.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use`);
            } else {
                console.error('❌ Server error:', error);
            }
            process.exit(1);
        });
    } catch (error) {
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
