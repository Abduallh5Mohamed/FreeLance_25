"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const db_1 = require("./db");
// Import routes
const auth_1 = __importDefault(require("./routes/auth"));
const groups_1 = __importDefault(require("./routes/groups"));
const grades_1 = __importDefault(require("./routes/grades"));
const students_1 = __importDefault(require("./routes/students"));
const courses_1 = __importDefault(require("./routes/courses"));
const attendance_1 = __importDefault(require("./routes/attendance"));
const exams_1 = __importDefault(require("./routes/exams"));
const subscriptions_1 = __importDefault(require("./routes/subscriptions"));
const materials_1 = __importDefault(require("./routes/materials"));
const lectures_1 = __importDefault(require("./routes/lectures"));
const registration_requests_1 = __importDefault(require("./routes/registration-requests"));
const fees_1 = __importDefault(require("./routes/fees"));
const payment_requests_1 = __importDefault(require("./routes/payment-requests"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const subscription_requests_1 = __importDefault(require("./routes/subscription-requests"));
const expenses_1 = __importDefault(require("./routes/expenses"));
const imports_1 = __importDefault(require("./routes/imports"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// Middleware
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        // Allow requests from localhost on any port (development)
        if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
            callback(null, true);
        }
        else {
            callback(null, process.env.CORS_ORIGIN || 'http://localhost:8080');
        }
    },
    credentials: true,
}));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '50mb' }));
// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});
// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
// API Routes
app.use('/api/auth', auth_1.default);
app.use('/api/groups', groups_1.default);
app.use('/api/grades', grades_1.default);
app.use('/api/students', students_1.default);
app.use('/api/courses', courses_1.default);
app.use('/api/attendance', attendance_1.default);
app.use('/api/exams', exams_1.default);
app.use('/api/subscriptions', subscriptions_1.default);
app.use('/api/materials', materials_1.default);
app.use('/api/lectures', lectures_1.default);
app.use('/api/registration-requests', registration_requests_1.default);
app.use('/api/fees', fees_1.default);
app.use('/api/payment-requests', payment_requests_1.default);
app.use('/api/notifications', notifications_1.default);
app.use('/api/subscription-requests', subscription_requests_1.default);
app.use('/api/expenses', expenses_1.default);
app.use('/api/imports', imports_1.default);
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
        // Test database connection
        const dbConnected = await (0, db_1.testConnection)();
        if (!dbConnected) {
            console.error('❌ Failed to connect to database. Server will not start.');
            process.exit(1);
        }
        const server = app.listen(PORT, () => {
            console.log(`
╔════════════════════════════════════════════════╗
║                                                ║
║   🚀 Al-Qaed Backend API Server                ║
║                                                ║
║   📡 Server running on: http://localhost:${PORT}  ║
║   🗄️  Database: MySQL (${process.env.DB_NAME})           ║
║   🌍 CORS: localhost (all ports)           ║
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
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${PORT} is already in use`);
            }
            else {
                console.error('❌ Server error:', error);
            }
            process.exit(1);
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
