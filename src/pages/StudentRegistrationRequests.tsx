import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, X, Clock, User, Mail, Phone, GraduationCap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import Header from "@/components/Header";
import { motion } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { getStudents, updateStudent, getGrades, getGroups, getCourses, getRegistrationRequests, approveRegistrationRequest, rejectRegistrationRequest } from "@/lib/api";

interface RegistrationRequest {
  id: string;
  name: string;
  email?: string | null;
  phone: string;
  grade_id?: string | null;
  group_id?: string | null;
  requested_courses?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string | null;
  created_at?: string;
  grade_name?: string;
  group_name?: string;
  is_offline?: boolean; // Add this to track online/offline status
}

interface Grade {
  id: string;
  name: string;
}

interface Group {
  id: string;
  name: string;
}

interface Course {
  id: string;
  name: string;
}

export interface RegistrationDecisionDeps {
  approveRegistrationRequest: (id: string) => Promise<{ message?: string }>;
  rejectRegistrationRequest: (id: string, reason: string) => Promise<{ message?: string }>;
  /** Server-authoritative refresh: only invoked after the server confirms success. */
  refresh: () => void | Promise<void>;
  notify: (kind: "success" | "error", title: string, description: string) => void;
}

export interface RegistrationDecisionOutcome {
  ok: boolean;
}

/**
 * Decision controller for registration requests. Every decision is
 * single-flight (a repeat click while a request for the same target is in
 * flight reuses it instead of issuing a duplicate request — the server
 * rejects an already-processed request with 404), the list is refreshed only
 * after the server confirms success, and failures keep the caller's state
 * untouched so no false success is shown.
 */
export const createRegistrationDecisionController = (deps: RegistrationDecisionDeps) => {
  const inFlight = new Map<string, Promise<RegistrationDecisionOutcome>>();

  const run = (key: string, op: () => Promise<RegistrationDecisionOutcome>): Promise<RegistrationDecisionOutcome> => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = op().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };

  return {
    approve: (request: RegistrationRequest) =>
      run(`approve:${request.id}`, async () => {
        try {
          const result = await deps.approveRegistrationRequest(request.id);
          try {
            await deps.refresh();
          } catch (refreshError) {
            // The decision was accepted by the server; the list refresh failure
            // is reported by the page's own fetch error handling.
            console.error('Error refreshing after approval:', refreshError);
          }
          deps.notify("success", "تم قبول الطلب", result.message || `تم قبول طلب الطالب ${request.name} بنجاح`);
          return { ok: true };
        } catch (error: unknown) {
          deps.notify(
            "error",
            "خطأ",
            error instanceof Error ? error.message : "حدث خطأ أثناء قبول الطلب"
          );
          return { ok: false };
        }
      }),
    reject: (request: RegistrationRequest, reason: string) =>
      run(`reject:${request.id}`, async () => {
        try {
          const result = await deps.rejectRegistrationRequest(request.id, reason);
          try {
            await deps.refresh();
          } catch (refreshError) {
            console.error('Error refreshing after rejection:', refreshError);
          }
          deps.notify("success", "تم رفض الطلب", result.message || `تم رفض طلب الطالب ${request.name}`);
          return { ok: true };
        } catch (error: unknown) {
          deps.notify(
            "error",
            "خطأ",
            error instanceof Error ? error.message : "حدث خطأ أثناء رفض الطلب"
          );
          return { ok: false };
        }
      }),
  };
};

export interface RegistrationPageData {
  requests: RegistrationRequest[];
  grades: Grade[];
  groups: Group[];
  courses: Course[];
}

export interface RegistrationPageDataDeps {
  getRegistrationRequests: (status?: 'pending' | 'approved' | 'rejected') => Promise<RegistrationRequest[]>;
  getGrades: () => Promise<Grade[]>;
  getGroups: () => Promise<Group[]>;
  getCourses: () => Promise<Course[]>;
}

/**
 * Load every registration status — not just pending. The page renders
 * pending/approved/rejected tabs and filters client-side; requesting only
 * pending would leave the approved/rejected tabs permanently empty.
 */
export const loadRegistrationPageData = async (deps: RegistrationPageDataDeps): Promise<RegistrationPageData> => {
  const [requests, grades, groups, courses] = await Promise.all([
    deps.getRegistrationRequests(),
    deps.getGrades(),
    deps.getGroups(),
    deps.getCourses(),
  ]);
  return { requests, grades, groups, courses };
};

/** Split the loaded requests into the three tab lists. */
export const splitRequestsByStatus = (requests: RegistrationRequest[]): {
  pending: RegistrationRequest[];
  approved: RegistrationRequest[];
  rejected: RegistrationRequest[];
} => ({
  pending: requests.filter(r => r.status === 'pending'),
  approved: requests.filter(r => r.status === 'approved'),
  rejected: requests.filter(r => r.status === 'rejected'),
});

export default function StudentRegistrationRequests() {
  const [requests, setRequests] = useState<RegistrationRequest[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<RegistrationRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [showRejectionDialog, setShowRejectionDialog] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    // Check if user is logged in and is admin
    const currentUser = localStorage.getItem('currentUser');
    if (!currentUser) {
      toast({
        title: "غير مصرح",
        description: "يجب تسجيل الدخول أولاً",
        variant: "destructive"
      });
      navigate('/auth');
      return;
    }

    try {
      const user = JSON.parse(currentUser);
      if (user.role !== 'admin') {
        toast({
          title: "غير مصرح",
          description: "هذه الصفحة متاحة للمسؤولين فقط",
          variant: "destructive"
        });
        navigate('/');
        return;
      }
    } catch (error) {
      console.error('Error parsing user data:', error);
      navigate('/auth');
      return;
    }

    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchData = async () => {
    try {
      const data = await loadRegistrationPageData({ getRegistrationRequests, getGrades, getGroups, getCourses });

      // Show both online and offline requests
      setRequests(data.requests);
      setGrades(data.grades);
      setGroups(data.groups);
      setCourses(data.courses);
    } catch (error) {
      console.error('Error fetching data:', error);
      toast({
        title: "خطأ",
        description: "حدث خطأ أثناء تحميل البيانات",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const decisions = useMemo(() => createRegistrationDecisionController({
    approveRegistrationRequest,
    rejectRegistrationRequest,
    refresh: fetchData,
    notify: (kind, title, description) => toast({
      title,
      description,
      ...(kind === "error" ? { variant: "destructive" as const } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const handleApprove = async (request: RegistrationRequest) => {
    if (processingId) return; // a decision is already in flight
    setProcessingId(request.id);
    try {
      await decisions.approve(request);
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async () => {
    if (!selectedRequest || !rejectionReason.trim()) {
      toast({
        title: "خطأ",
        description: "يجب إدخال سبب الرفض",
        variant: "destructive"
      });
      return;
    }

    if (processingId) return; // a decision is already in flight
    setProcessingId(selectedRequest.id);
    try {
      const outcome = await decisions.reject(selectedRequest, rejectionReason);
      if (!outcome.ok) return; // keep the reason and dialog open for retry
      setShowRejectionDialog(false);
      setRejectionReason("");
      setSelectedRequest(null);
    } finally {
      setProcessingId(null);
    }
  };

  const getGradeName = (gradeId?: string | null) => {
    if (!gradeId) return 'غير محدد';
    return grades.find(g => g.id === gradeId)?.name || 'غير محدد';
  };

  const getGroupName = (groupId?: string | null) => {
    if (!groupId) return 'غير محدد';
    return groups.find(g => g.id === groupId)?.name || 'غير محدد';
  };

  const getRequestedCoursesNames = (requestedCourses?: string | null) => {
    if (!requestedCourses) return 'لا يوجد';
    try {
      const courseIds: string[] = JSON.parse(requestedCourses);
      return courseIds.map(id => courses.find(c => c.id === id)?.name || 'غير معروف').join(', ') || 'لا يوجد';
    } catch {
      return 'لا يوجد';
    }
  };

  const renderRequestCard = (request: RegistrationRequest) => (
    <Card key={request.id} className="mb-4">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <CardTitle>{request.name}</CardTitle>
            {/* Badge for Online/Offline */}
            <Badge variant="outline" className={request.is_offline ? "bg-purple-100 text-purple-800 border-purple-300" : "bg-blue-100 text-blue-800 border-blue-300"}>
              {request.is_offline ? "📍 أوفلاين" : "🌐 أونلاين"}
            </Badge>
          </div>
          <Badge variant={
            request.status === 'pending' ? 'secondary' :
              request.status === 'approved' ? 'default' : 'destructive'
          }>
            {request.status === 'pending' ? 'قيد الانتظار' :
              request.status === 'approved' ? 'مقبول' : 'مرفوض'}
          </Badge>
        </div>
        <CardDescription>
          تاريخ التقديم: {request.created_at ? new Date(request.created_at).toLocaleDateString('ar-EG') : 'غير محدد'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          {request.email && (
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4" />
              <span>البريد الإلكتروني: {request.email}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            <span>الهاتف: {request.phone}</span>
          </div>
          <div className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4" />
            <span>الصف: {request.grade_name || getGradeName(request.grade_id)}</span>
          </div>
          <div className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4" />
            <span>المجموعة: {request.group_name || getGroupName(request.group_id)}</span>
          </div>
          <div>
            <span className="font-semibold">الكورسات المطلوبة: </span>
            {getRequestedCoursesNames(request.requested_courses)}
          </div>
          {request.status === 'rejected' && request.rejection_reason && (
            <div className="mt-2 p-2 bg-destructive/10 rounded">
              <span className="font-semibold">سبب الرفض: </span>
              {request.rejection_reason}
            </div>
          )}
        </div>

        {request.status === 'pending' && (
          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => handleApprove(request)}
              className="flex-1"
              variant="default"
              disabled={processingId !== null}
            >
              <Check className="mr-2 h-4 w-4" />
              قبول
            </Button>
            <Button
              onClick={() => {
                setSelectedRequest(request);
                setShowRejectionDialog(true);
              }}
              className="flex-1"
              variant="destructive"
              disabled={processingId !== null}
            >
              <X className="mr-2 h-4 w-4" />
              رفض
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const { pending: pendingRequests, approved: approvedRequests, rejected: rejectedRequests } = splitRequestsByStatus(requests);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950 relative overflow-hidden">
        <FloatingParticles />
        <Header />
        <div className="flex items-center justify-center min-h-[80vh] relative z-10">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
              className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4"
            />
            <p className="text-lg font-medium text-primary">جاري تحميل الطلبات...</p>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <Header />

      <div className="container mx-auto p-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <GlassmorphicCard>
            <CardHeader className="bg-gradient-to-r from-primary/10 via-accent/10 to-primary/10">
              <CardTitle className="text-2xl flex items-center gap-3">
                <motion.div
                  animate={{ rotate: [0, 10, -10, 0] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <GraduationCap className="h-7 w-7 text-primary" />
                </motion.div>
                طلبات التسجيل للطلاب
              </CardTitle>
              <CardDescription className="text-base">
                إدارة طلبات التسجيل الجديدة من الطلاب الأونلاين
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <Tabs defaultValue="pending" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="pending" className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    قيد الانتظار ({pendingRequests.length})
                  </TabsTrigger>
                  <TabsTrigger value="approved" className="flex items-center gap-2">
                    <Check className="h-4 w-4" />
                    مقبول ({approvedRequests.length})
                  </TabsTrigger>
                  <TabsTrigger value="rejected" className="flex items-center gap-2">
                    <X className="h-4 w-4" />
                    مرفوض ({rejectedRequests.length})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="pending" className="mt-4">
                  {pendingRequests.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">
                      لا توجد طلبات قيد الانتظار
                    </p>
                  ) : (
                    pendingRequests.map(renderRequestCard)
                  )}
                </TabsContent>

                <TabsContent value="approved" className="mt-4">
                  {approvedRequests.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">
                      لا توجد طلبات مقبولة
                    </p>
                  ) : (
                    approvedRequests.map(renderRequestCard)
                  )}
                </TabsContent>

                <TabsContent value="rejected" className="mt-4">
                  {rejectedRequests.length === 0 ? (
                    <p className="text-center text-muted-foreground py-8">
                      لا توجد طلبات مرفوضة
                    </p>
                  ) : (
                    rejectedRequests.map(renderRequestCard)
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </GlassmorphicCard>
        </motion.div>

        <Dialog open={showRejectionDialog} onOpenChange={setShowRejectionDialog}>
          <DialogContent className="bg-card/95 backdrop-blur-xl border-primary/20">
            <DialogHeader>
              <DialogTitle className="text-xl">رفض طلب التسجيل</DialogTitle>
              <DialogDescription>
                يرجى إدخال سبب رفض طلب التسجيل لـ {selectedRequest?.name}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="rejection-reason">سبب الرفض</Label>
                <Textarea
                  id="rejection-reason"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="اكتب سبب الرفض هنا..."
                  rows={4}
                  className="bg-background/50 border-2 focus:border-primary"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => {
                setShowRejectionDialog(false);
                setRejectionReason("");
                setSelectedRequest(null);
              }}>
                إلغاء
              </Button>
              <Button
                variant="destructive"
                onClick={handleReject}
                className="bg-gradient-to-r from-red-500 to-red-600 hover:shadow-lg"
                disabled={processingId !== null}
              >
                تأكيد الرفض
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
