import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect, lazy, Suspense } from "react";
import { RouteBoundary } from "./components/RouteBoundary";
import { startVersionCheck, stopVersionCheck } from "./utils/versionChecker";
import AuthGuard, { RouteLoading } from "./components/AuthGuard";
import { UploadProvider } from "./contexts/UploadContext";
import { UploadNotification } from "./components/UploadNotification";
// M2-22 — the anonymous published-course discovery page. It is mounted WITHOUT
// AuthGuard on purpose: discovery is public and read only, and it consults no
// principal. It never enrolls, grants access, delivers a lesson or a file, or
// takes payment.

const Index = lazy(() => import("./pages/Index"));
const Auth = lazy(() => import("./pages/Auth"));
const TeacherDashboard = lazy(() => import("./pages/TeacherDashboard"));
const StudentDashboard = lazy(() => import("./pages/StudentDashboard"));
const StudentChat = lazy(() => import("./pages/StudentChat"));
const StudentContent = lazy(() => import("./pages/StudentContent"));
const StudentExams = lazy(() => import("./pages/StudentExams"));
const Courses = lazy(() => import("./pages/Courses"));
const Students = lazy(() => import("./pages/Students"));
const OfflineStudents = lazy(() => import("./pages/OfflineStudents"));
const Subscriptions = lazy(() => import("./pages/Subscriptions"));
const Attendance = lazy(() => import("./pages/Attendance"));
const AttendanceLog = lazy(() => import("./pages/AttendanceLog"));
const Fees = lazy(() => import("./pages/Fees"));
const Messages = lazy(() => import("./pages/Messages"));
const Reports = lazy(() => import("./pages/Reports"));
const CourseContentManager = lazy(() => import("./pages/CourseContentManager"));
const TakeExam = lazy(() => import("./pages/TakeExam"));
const ExamAccess = lazy(() => import("./pages/ExamAccess"));
const Groups = lazy(() => import("./pages/Groups"));
const QRAttendance = lazy(() => import("./pages/QRAttendance"));
const Expenses = lazy(() => import("./pages/Expenses"));
const AccountStatement = lazy(() => import("./pages/AccountStatement"));
const Imports = lazy(() => import("./pages/Imports"));
const StudentBarcodes = lazy(() => import("./pages/StudentBarcodes"));
const BarcodeAttendance = lazy(() => import("./pages/BarcodeAttendance"));
const StudentPayments = lazy(() => import("./pages/StudentPayments"));
const Profits = lazy(() => import("./pages/Profits"));
const Staff = lazy(() => import("./pages/Staff"));
const OnlineMeeting = lazy(() => import("./pages/OnlineMeeting"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Forbidden = lazy(() => import("./pages/Forbidden"));
const Support = lazy(() => import("./pages/Support"));
const Family = lazy(() => import("./pages/Family"));
const PromoVideo = lazy(() => import("./pages/PromoVideo"));
const StudentLectures = lazy(() => import("./pages/StudentLectures"));
const Grades = lazy(() => import("./pages/Grades"));
const StudentRegistrationRequests = lazy(() => import("./pages/StudentRegistrationRequests"));
const TeacherContentManager = lazy(() => import("./pages/TeacherContentManager"));
const TeacherLectures = lazy(() => import("./pages/TeacherLectures"));
const TeacherExams = lazy(() => import("./pages/TeacherExams"));
const EditExam = lazy(() => import("./pages/EditExam"));
const ExamReports = lazy(() => import("./pages/ExamReports"));
const ExamResults = lazy(() => import("./pages/ExamResults"));
const StudentExamResults = lazy(() => import("./pages/StudentExamResults"));
const ExamReview = lazy(() => import("./pages/ExamReview"));
const ManualGrading = lazy(() => import("./pages/ManualGrading"));
const TeachingWorkspace = lazy(() => import("./pages/TeachingWorkspace"));
const ChatAssistant = lazy(() => import("./pages/ChatAssistant"));
const StudentReports = lazy(() => import("./pages/StudentReports"));
const TestVideo = lazy(() => import("./pages/TestVideo"));
const TeacherPremiumLectures = lazy(() => import("./pages/TeacherPremiumLectures"));
const StudentPremiumLectures = lazy(() => import("./pages/StudentPremiumLectures"));
const StudentMeetings = lazy(() => import("./pages/StudentMeetings"));
const InstructorDashboard = lazy(() => import("./pages/InstructorDashboard"));
const InstructorLectures = lazy(() => import("./pages/InstructorLectures"));
const InstructorWallet = lazy(() => import("./pages/InstructorWallet"));
const InstructorVideoRequests = lazy(() => import("./pages/InstructorVideoRequests"));
const InstructorStudents = lazy(() => import("./pages/InstructorStudents"));
const AdminInstructors = lazy(() => import("./pages/AdminInstructors"));
const AdminDashboard = lazy(() => import("./pages/AdminDashboard"));
const AdminInstructorOverview = lazy(() => import("./pages/AdminInstructorOverview"));
const AdminOperations = lazy(() => import("./pages/AdminOperations"));
const AdminPlatform = lazy(() => import("./pages/AdminPlatform"));
const TenantInvitation = lazy(() => import("./pages/TenantInvitation"));
const InstructorSubscription = lazy(() => import("./pages/InstructorSubscription"));
const AdminApprovals = lazy(() => import("./pages/AdminApprovals"));
const AdminTeam = lazy(() => import("./pages/AdminTeam"));
const AdminFinance = lazy(() => import("./pages/AdminFinance"));
const AdminSecurity = lazy(() => import("./pages/AdminSecurity"));
const JoinInstructor = lazy(() => import("./pages/JoinInstructor"));
const StudentSpaces = lazy(() => import("./pages/StudentSpaces"));
const CenterWork = lazy(() => import("./pages/CenterWork"));
const StudentPasswordReset = lazy(() => import("./pages/StudentPasswordReset"));
const PublicCourseDiscovery = lazy(() => import("./pages/PublicCourseDiscovery"));

const queryClient = new QueryClient();

const App = () => {
  // Auto-reload when new build is detected
  useEffect(() => {
    console.log('🚀 App mounted - Starting version checker');
    startVersionCheck();

    // Service workers and Vite HMR must not run together: a development SW can
    // keep stale modules and produce misleading 404/old-line console errors.
    if ('serviceWorker' in navigator) {
      if (import.meta.env.PROD) {
        navigator.serviceWorker.register('/security-sw.js')
          .then(() => console.log('🛡️ Security SW registered'))
          .catch(err => console.warn('⚠️ Security SW registration failed:', err));
      } else {
        void navigator.serviceWorker.getRegistrations().then(registrations =>
          Promise.all(registrations.map(registration => registration.unregister()))
        );
      }
    }

    return () => {
      console.log('🛑 App unmounting - Stopping version checker');
      stopVersionCheck();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <UploadProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <UploadNotification />
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <RouteBoundary><Suspense fallback={<RouteLoading />}><Routes>
              <Route path="/" element={<Index />} />
              <Route path="/promo" element={<PromoVideo />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/login" element={<Auth />} />
              <Route path="/join/:token" element={<JoinInstructor />} />
              <Route path="/student-password-reset" element={<StudentPasswordReset />} />
              <Route path="/student-spaces" element={<AuthGuard requiredRole="student"><StudentSpaces /></AuthGuard>} />
              <Route path="/center-work" element={<AuthGuard><CenterWork /></AuthGuard>} />
              {import.meta.env.DEV && <Route path="/test-video" element={<TestVideo />} />}
              <Route path="/forbidden" element={<Forbidden />} />
              <Route path="/invite" element={<TenantInvitation />} />
              <Route path="/support" element={<AuthGuard><Support /></AuthGuard>} />
              <Route path="/family" element={<AuthGuard><Family /></AuthGuard>} />
              {/* Public: no AuthGuard, no session, no principal. */}
              <Route path="/discover" element={<PublicCourseDiscovery />} />

              {/* Teacher Routes - Protected */}
              <Route path="/teacher" element={<AuthGuard requiredRole="teacher"><TeacherDashboard /></AuthGuard>} />
              <Route path="/courses" element={<AuthGuard requiredRole="teacher"><Courses /></AuthGuard>} />
              <Route path="/students" element={<AuthGuard requiredRole="teacher"><Students /></AuthGuard>} />
              <Route path="/offline-students" element={<AuthGuard requiredRole="teacher"><OfflineStudents /></AuthGuard>} />
              <Route path="/registration-requests" element={<AuthGuard requiredRole="teacher"><StudentRegistrationRequests /></AuthGuard>} />
              <Route path="/subscriptions" element={<AuthGuard requiredRole="teacher"><Subscriptions /></AuthGuard>} />
              <Route path="/groups" element={<AuthGuard requiredRole="teacher"><Groups /></AuthGuard>} />
              <Route path="/grades" element={<AuthGuard requiredRole="teacher"><Grades /></AuthGuard>} />
              <Route path="/attendance" element={<AuthGuard requiredRole="teacher"><Attendance /></AuthGuard>} />
              <Route path="/barcode-attendance" element={<AuthGuard requiredRole="teacher"><BarcodeAttendance /></AuthGuard>} />
              <Route path="/attendance-log" element={<AuthGuard requiredRole="teacher"><AttendanceLog /></AuthGuard>} />
              <Route path="/student-payments" element={<AuthGuard requiredRole="teacher"><StudentPayments /></AuthGuard>} />
              <Route path="/fees" element={<AuthGuard requiredRole="teacher"><Fees /></AuthGuard>} />
              <Route path="/messages" element={<AuthGuard requiredRole="teacher"><Messages /></AuthGuard>} />
              <Route path="/reports" element={<AuthGuard requiredRole="teacher"><Reports /></AuthGuard>} />
              <Route path="/expenses" element={<AuthGuard requiredRole="teacher"><Expenses /></AuthGuard>} />
              <Route path="/account-statement" element={<AuthGuard requiredRole="teacher"><AccountStatement /></AuthGuard>} />
              <Route path="/imports" element={<AuthGuard requiredRole="teacher"><Imports /></AuthGuard>} />
              <Route path="/student-barcodes" element={<AuthGuard requiredRole="teacher"><StudentBarcodes /></AuthGuard>} />
              <Route path="/profits" element={<AuthGuard requiredRole="teacher"><Profits /></AuthGuard>} />
              <Route path="/staff" element={<AuthGuard requiredRole="teacher"><Staff /></AuthGuard>} />
              <Route path="/online-meeting" element={<AuthGuard requiredRole="teacher"><OnlineMeeting /></AuthGuard>} />
              <Route path="/course-content" element={<AuthGuard requiredRole="teacher"><CourseContentManager /></AuthGuard>} />
              <Route path="/teacher-content-manager" element={<AuthGuard requiredRole="teacher"><TeacherContentManager /></AuthGuard>} />
              <Route path="/teacher-lectures" element={<AuthGuard requiredRole="teacher"><TeacherLectures /></AuthGuard>} />
              <Route path="/teacher-exams" element={<AuthGuard requiredRole="teacher"><TeacherExams /></AuthGuard>} />
              <Route path="/teacher/exams/:examId/edit" element={<AuthGuard requiredRole="teacher"><EditExam /></AuthGuard>} />
              <Route path="/exam-reports/:examId" element={<AuthGuard requiredRole="teacher"><ExamReports /></AuthGuard>} />
              <Route path="/exam-manager" element={<Navigate to="/teacher-exams" replace />} />
              <Route path="/exam-results" element={<AuthGuard requiredRole="teacher"><ExamResults /></AuthGuard>} />
              <Route path="/manual-grading" element={<AuthGuard requiredRole="teacher"><ManualGrading /></AuthGuard>} />
              <Route path="/teacher-workspace" element={<AuthGuard requiredRole="teacher"><TeachingWorkspace /></AuthGuard>} />
              <Route path="/student-reports" element={<AuthGuard requiredRole="teacher"><StudentReports /></AuthGuard>} />
              <Route path="/chat-assistant" element={<AuthGuard requiredRole="teacher"><ChatAssistant /></AuthGuard>} />
              <Route path="/teacher-premium-lectures" element={<AuthGuard requiredRole="teacher"><TeacherPremiumLectures /></AuthGuard>} />

              {/* Admin Routes - Instructor Management */}
              <Route path="/admin" element={<AuthGuard requiredRole="admin"><AdminDashboard /></AuthGuard>} />
              <Route path="/admin/instructors" element={<AuthGuard requiredRole="admin"><AdminInstructors /></AuthGuard>} />
              <Route path="/admin/instructors/:id" element={<AuthGuard requiredRole="admin"><AdminInstructorOverview /></AuthGuard>} />
              <Route path="/admin/operations" element={<AuthGuard requiredRole="admin"><AdminOperations /></AuthGuard>} />
              <Route path="/admin/platform" element={<AuthGuard requiredRole="admin"><AdminPlatform /></AuthGuard>} />
              <Route path="/admin/approvals" element={<AuthGuard requiredRole="admin"><AdminApprovals /></AuthGuard>} />
              <Route path="/admin/team" element={<AuthGuard requiredRole="admin"><AdminTeam /></AuthGuard>} />
              <Route path="/admin/finance" element={<Navigate to="/admin/analytics/overview" replace />} />
              <Route path="/admin/analytics/overview" element={<AuthGuard requiredRole="admin"><AdminFinance view="overview" /></AuthGuard>} />
              <Route path="/admin/analytics/charts" element={<AuthGuard requiredRole="admin"><AdminFinance view="charts" /></AuthGuard>} />
              <Route path="/admin/analytics/scenarios" element={<AuthGuard requiredRole="admin"><AdminFinance view="scenarios" /></AuthGuard>} />
              <Route path="/admin/analytics/reports" element={<AuthGuard requiredRole="admin"><AdminFinance view="reports" /></AuthGuard>} />
              <Route path="/admin/analytics/governance" element={<AuthGuard requiredRole="admin"><AdminFinance view="governance" /></AuthGuard>} />
              <Route path="/admin/security" element={<AuthGuard requiredRole="admin"><AdminSecurity /></AuthGuard>} />

              {/* Instructor Routes - Protected */}
              <Route path="/instructor" element={<AuthGuard requiredRole="instructor"><InstructorDashboard /></AuthGuard>} />
              <Route path="/instructor-lectures" element={<AuthGuard requiredRole="instructor"><InstructorLectures /></AuthGuard>} />
              <Route path="/instructor-wallet" element={<AuthGuard requiredRole="instructor"><InstructorWallet /></AuthGuard>} />
              <Route path="/instructor-subscription" element={<AuthGuard requiredRole="instructor"><InstructorSubscription /></AuthGuard>} />
              <Route path="/instructor-video-requests" element={<AuthGuard requiredRole="instructor"><InstructorVideoRequests /></AuthGuard>} />
              <Route path="/instructor-students" element={<AuthGuard requiredRole="instructor"><InstructorStudents /></AuthGuard>} />

              {/* Student Routes - Protected */}
              <Route path="/student" element={<AuthGuard requiredRole="student"><StudentDashboard /></AuthGuard>} />
              <Route path="/student-ai-chat" element={<AuthGuard requiredRole="student"><ChatAssistant /></AuthGuard>} />
              <Route path="/student-chat" element={<AuthGuard requiredRole="student"><StudentChat /></AuthGuard>} />
              <Route path="/student-messages" element={<AuthGuard requiredRole="student"><Messages /></AuthGuard>} />
              <Route path="/student-content" element={<AuthGuard requiredRole="student"><StudentContent /></AuthGuard>} />
              <Route path="/student-lectures" element={<AuthGuard requiredRole="student"><StudentLectures /></AuthGuard>} />
              <Route path="/student-exams" element={<AuthGuard requiredRole="student"><StudentExams /></AuthGuard>} />
              <Route path="/student-exam-results" element={<AuthGuard requiredRole="student"><StudentExamResults /></AuthGuard>} />
              <Route path="/exam-review/:examId" element={<AuthGuard requiredRole="student"><ExamReview /></AuthGuard>} />
              <Route path="/student-premium-lectures" element={<AuthGuard requiredRole="student"><StudentPremiumLectures /></AuthGuard>} />
              <Route path="/student-meetings" element={<AuthGuard requiredRole="student"><StudentMeetings /></AuthGuard>} />
              <Route path="/exam-access" element={<AuthGuard requiredRole="student"><ExamAccess /></AuthGuard>} />
              <Route path="/take-exam/:examId" element={<AuthGuard requiredRole="student"><TakeExam /></AuthGuard>} />

              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes></Suspense></RouteBoundary>
          </BrowserRouter>
        </TooltipProvider>
      </UploadProvider>
    </QueryClientProvider>
  );
};

export default App;
