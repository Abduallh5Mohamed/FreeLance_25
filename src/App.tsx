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
import ExamManager from "./pages/ExamManager";
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
import TeacherMaterials from "./pages/TeacherMaterials";
import TeacherExams from "./pages/TeacherExams";

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
          <Route path="/teacher" element={<TeacherDashboard />} />
          <Route path="/student" element={<StudentDashboard />} />
          <Route path="/student-chat" element={<StudentChat />} />
          <Route path="/student-content" element={<StudentContent />} />
          <Route path="/student-lectures" element={<StudentLectures />} />
          <Route path="/student-exams" element={<StudentExams />} />
          <Route path="/courses" element={<Courses />} />
          <Route path="/students" element={<Students />} />
          <Route path="/offline-students" element={<OfflineStudents />} />
          <Route path="/registration-requests" element={<StudentRegistrationRequests />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/groups" element={<Groups />} />
          <Route path="/grades" element={<Grades />} />
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/barcode-attendance" element={<QRAttendance />} />
          <Route path="/fees" element={<Fees />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/account-statement" element={<AccountStatement />} />
          <Route path="/imports" element={<Imports />} />
          <Route path="/student-barcodes" element={<StudentBarcodes />} />
          <Route path="/barcode-attendance" element={<BarcodeAttendance />} />
          <Route path="/profits" element={<Profits />} />
          <Route path="/staff" element={<Staff />} />
          <Route path="/online-meeting" element={<OnlineMeeting />} />
          <Route path="/course-content" element={<CourseContentManager />} />
          <Route path="/teacher-content-manager" element={<TeacherContentManager />} />
          <Route path="/teacher-lectures" element={<TeacherLectures />} />
          <Route path="/teacher-materials" element={<TeacherMaterials />} />
          <Route path="/teacher-exams" element={<TeacherExams />} />
          <Route path="/exam-manager" element={<ExamManager />} />
          <Route path="/exam-access" element={<ExamAccess />} />
          <Route path="/take-exam/:examId" element={<TakeExam />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
