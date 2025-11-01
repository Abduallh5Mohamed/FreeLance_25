import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
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
import Profits from "./pages/Profits";
import Staff from "./pages/Staff";
import OnlineMeeting from "./pages/OnlineMeeting";
import NotFound from "./pages/NotFound";
import PromoVideo from "./pages/PromoVideo";
import StudentLectures from "./pages/StudentLectures";
import Grades from "./pages/Grades";
import StudentRegistrationRequests from "./pages/StudentRegistrationRequests";
import TeacherContentManager from "./pages/TeacherContentManager";
import TeacherLectures from "./pages/TeacherLectures";
import TeacherExams from "./pages/TeacherExams";
import ChatAssistant from "./pages/ChatAssistant";
import AuthGuard from "./components/AuthGuard";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/promo" element={<PromoVideo />} />
          <Route path="/auth" element={<Auth />} />

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
          <Route path="/barcode-attendance" element={<AuthGuard requiredRole="teacher"><QRAttendance /></AuthGuard>} />
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
          <Route path="/chat-assistant" element={<AuthGuard requiredRole="teacher"><ChatAssistant /></AuthGuard>} />

          {/* Student Routes - Protected */}
          <Route path="/student" element={<AuthGuard requiredRole="student"><StudentDashboard /></AuthGuard>} />
          <Route path="/student-chat" element={<AuthGuard requiredRole="student"><StudentChat /></AuthGuard>} />
          <Route path="/student-content" element={<AuthGuard requiredRole="student"><StudentContent /></AuthGuard>} />
          <Route path="/student-lectures" element={<AuthGuard requiredRole="student"><StudentLectures /></AuthGuard>} />
          <Route path="/student-exams" element={<AuthGuard requiredRole="student"><StudentExams /></AuthGuard>} />
          <Route path="/exam-access" element={<AuthGuard requiredRole="student"><ExamAccess /></AuthGuard>} />
          <Route path="/take-exam/:examId" element={<AuthGuard requiredRole="student"><TakeExam /></AuthGuard>} />

          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
