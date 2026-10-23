import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useEffect } from "react";
import { startVersionCheck, stopVersionCheck } from "./utils/versionChecker";
import Index from "./pages/Index";
import Auth from "./pages/Auth";
import TeacherDashboard from "./pages/TeacherDashboard";
import StudentDashboard from "./pages/StudentDashboard";
import StudentChat from "./pages/StudentChat";
import StudentContent from "./pages/StudentContent";
import StudentExams from "./pages/StudentExams";
import Courses from "./pages/Courses";
import Students from "./pages/Students";
import OfflineStudents from "./pages/OfflineStudents";
import Subscriptions from "./pages/Subscriptions";
import Attendance from "./pages/Attendance";
import AttendanceLog from "./pages/AttendanceLog";
import Fees from "./pages/Fees";
import Messages from "./pages/Messages";
import Reports from "./pages/Reports";
import CourseContentManager from "./pages/CourseContentManager";
import TakeExam from "./pages/TakeExam";
import ExamAccess from "./pages/ExamAccess";
import Groups from "./pages/Groups";
import QRAttendance from "./pages/QRAttendance";
import Expenses from "./pages/Expenses";
import AccountStatement from "./pages/AccountStatement";
import Imports from "./pages/Imports";
import StudentBarcodes from "./pages/StudentBarcodes";
import BarcodeAttendance from "./pages/BarcodeAttendance";
import StudentPayments from "./pages/StudentPayments";
import Profits from "./pages/Profits";
import Staff from "./pages/Staff";
import OnlineMeeting from "./pages/OnlineMeeting";
import NotFound from "./pages/NotFound";
import Forbidden from "./pages/Forbidden";
import Support from "./pages/Support";
import PromoVideo from "./pages/PromoVideo";
import StudentLectures from "./pages/StudentLectures";
import Grades from "./pages/Grades";
import StudentRegistrationRequests from "./pages/StudentRegistrationRequests";
import TeacherContentManager from "./pages/TeacherContentManager";
import TeacherLectures from "./pages/TeacherLectures";
import TeacherExams from "./pages/TeacherExams";
import EditExam from "./pages/EditExam";
import ExamReports from "./pages/ExamReports";
import ExamResults from "./pages/ExamResults";
import StudentExamResults from "./pages/StudentExamResults";
import ExamReview from "./pages/ExamReview";
import ManualGrading from "./pages/ManualGrading";
import ChatAssistant from "./pages/ChatAssistant";
import StudentReports from "./pages/StudentReports";
import TestVideo from "./pages/TestVideo";
import TeacherPremiumLectures from "./pages/TeacherPremiumLectures";
import StudentPremiumLectures from "./pages/StudentPremiumLectures";
import StudentMeetings from "./pages/StudentMeetings";
import InstructorDashboard from "./pages/InstructorDashboard";
import InstructorLectures from "./pages/InstructorLectures";
import InstructorWallet from "./pages/InstructorWallet";
import InstructorVideoRequests from "./pages/InstructorVideoRequests";
import InstructorStudents from "./pages/InstructorStudents";
import AdminInstructors from "./pages/AdminInstructors";
import AdminDashboard from "./pages/AdminDashboard";
import AdminInstructorOverview from "./pages/AdminInstructorOverview";
import AdminOperations from "./pages/AdminOperations";
import AdminPlatform from "./pages/AdminPlatform";
import TenantInvitation from "./pages/TenantInvitation";
import InstructorSubscription from "./pages/InstructorSubscription";
import AdminApprovals from "./pages/AdminApprovals";
import AdminTeam from "./pages/AdminTeam";
import AdminFinance from "./pages/AdminFinance";
import AdminSecurity from "./pages/AdminSecurity";
import AuthGuard from "./components/AuthGuard";
import { UploadProvider } from "./contexts/UploadContext";
import { UploadNotification } from "./components/UploadNotification";
import JoinInstructor from "./pages/JoinInstructor";
import StudentSpaces from "./pages/StudentSpaces";
import StudentPasswordReset from "./pages/StudentPasswordReset";
// M2-22 — the anonymous published-course discovery page. It is mounted WITHOUT
// AuthGuard on purpose: discovery is public and read only, and it consults no
// principal. It never enrolls, grants access, delivers a lesson or a file, or
// takes payment.
import PublicCourseDiscovery from "./pages/PublicCourseDiscovery";

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
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/promo" element={<PromoVideo />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/login" element={<Auth />} />
              <Route path="/join/:token" element={<JoinInstructor />} />
              <Route path="/student-password-reset" element={<StudentPasswordReset />} />
              <Route path="/student-spaces" element={<AuthGuard requiredRole="student"><StudentSpaces /></AuthGuard>} />
              {import.meta.env.DEV && <Route path="/test-video" element={<TestVideo />} />}
              <Route path="/forbidden" element={<Forbidden />} />
              <Route path="/invite" element={<TenantInvitation />} />
              <Route path="/support" element={<AuthGuard><Support /></AuthGuard>} />
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
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </UploadProvider>
    </QueryClientProvider>
  );
};

export default App;
