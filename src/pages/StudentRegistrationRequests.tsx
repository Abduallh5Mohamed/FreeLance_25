import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
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

interface RegistrationRequest {
  id: string;
  name: string;
  email: string;
  phone: string;
  grade_id: string;
  group_id: string;
  requested_courses: string[];
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string;
  created_at: string;
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

export default function StudentRegistrationRequests() {
  const [requests, setRequests] = useState<RegistrationRequest[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRequest, setSelectedRequest] = useState<RegistrationRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [showRejectionDialog, setShowRejectionDialog] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [requestsRes, gradesRes, groupsRes, coursesRes] = await Promise.all([
        supabase.from('student_registration_requests').select('*').order('created_at', { ascending: false }),
        supabase.from('grades').select('id, name').eq('is_active', true),
        supabase.from('groups').select('id, name').eq('is_active', true),
        supabase.from('courses').select('id, name').eq('is_active', true)
      ]);

      if (requestsRes.data) setRequests(requestsRes.data as RegistrationRequest[]);
      if (gradesRes.data) setGrades(gradesRes.data);
      if (groupsRes.data) setGroups(groupsRes.data);
      if (coursesRes.data) setCourses(coursesRes.data);
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

  const handleApprove = async (request: RegistrationRequest) => {
    try {
      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("User not authenticated");

      // Check if student already exists in students table
      const { data: existingStudent } = await supabase
        .from('students')
        .select('*')
        .eq('email', request.email)
        .single();

      let studentId: string;
      let tempPassword = '';

      // Calculate total subscription price from requested courses
      let totalSubscriptionPrice = 0;
      if (request.requested_courses && request.requested_courses.length > 0) {
        const { data: coursesData, error: coursesError } = await supabase
          .from('courses')
          .select(`
            subscription_id,
            subscriptions (
              price
            )
          `)
          .in('id', request.requested_courses);

        if (!coursesError && coursesData) {
          totalSubscriptionPrice = coursesData.reduce((sum, course: any) => {
            return sum + (course.subscriptions?.price || 0);
          }, 0);
        }
      }

      if (existingStudent) {
        // Update existing student to approved status
        const { data: updatedStudent, error: updateError } = await supabase
          .from('students')
          .update({
            grade_id: request.grade_id,
            group_id: request.group_id,
            approval_status: 'approved',
            approved_by: user.id,
            approved_at: new Date().toISOString()
          })
          .eq('id', existingStudent.id)
          .select()
          .single();

        if (updateError) throw updateError;
        studentId = existingStudent.id;
      } else {
        // Create Supabase Auth account
        tempPassword = `${request.email.split('@')[0]}_${Math.random().toString(36).slice(2, 10)}`;
        
        // Try to create auth account, but if it exists, continue anyway
        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: request.email,
          password: tempPassword,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: {
              name: request.name,
              phone: request.phone
            }
          }
        });

        // Only throw error if it's not "User already registered"
        if (authError && !authError.message.includes('already registered')) {
          throw authError;
        }

        // Create student record
        const { data: student, error: studentError } = await supabase
          .from('students')
          .insert({
            name: request.name,
            email: request.email,
            phone: request.phone,
            grade_id: request.grade_id,
            group_id: request.group_id,
            is_offline: false,
            approval_status: 'approved',
            approved_by: user.id,
            approved_at: new Date().toISOString()
          })
          .select()
          .single();

        if (studentError) throw studentError;
        studentId = student.id;
      }

      // Enroll in requested courses
      if (request.requested_courses && request.requested_courses.length > 0) {
        // First, delete existing enrollments to avoid duplicates
        await supabase
          .from('student_courses')
          .delete()
          .eq('student_id', studentId);

        const courseEnrollments = request.requested_courses.map(courseId => ({
          student_id: studentId,
          course_id: courseId
        }));

        await supabase.from('student_courses').insert(courseEnrollments);
      }

      // Add to account statement if there's a subscription fee
      if (totalSubscriptionPrice > 0) {
        const { error: accountError } = await supabase
          .from('account_statement')
          .insert({
            student_id: studentId,
            amount: totalSubscriptionPrice,
            payment_date: new Date().toISOString().split('T')[0],
            description: 'رسوم اشتراك الكورسات'
          });

        if (accountError) {
          console.error('Account statement error:', accountError);
        }

        // Add to profits
        const { error: profitError } = await supabase
          .from('profits')
          .insert({
            type: 'subscription',
            amount: totalSubscriptionPrice,
            description: `اشتراك الطالب ${request.name}`,
            date: new Date().toISOString().split('T')[0],
            time: new Date().toTimeString().split(' ')[0]
          });

        if (profitError) {
          console.error('Profit record error:', profitError);
        }
      }

      // Update request status
      await supabase
        .from('student_registration_requests')
        .update({
          status: 'approved',
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString()
        })
        .eq('id', request.id);

      toast({
        title: "تم قبول الطالب",
        description: existingStudent 
          ? `تم تحديث بيانات الطالب ${request.name} ونقله للمقبولين. مبلغ الاشتراك: ${totalSubscriptionPrice} جنيه`
          : `تم قبول طلب التسجيل لـ ${request.name}. كلمة المرور المؤقتة: ${tempPassword}. مبلغ الاشتراك: ${totalSubscriptionPrice} جنيه`,
      });

      fetchData();
    } catch (error: any) {
      console.error('Error approving request:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ أثناء قبول الطلب",
        variant: "destructive"
      });
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

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("User not authenticated");

      await supabase
        .from('student_registration_requests')
        .update({
          status: 'rejected',
          rejection_reason: rejectionReason,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString()
        })
        .eq('id', selectedRequest.id);

      toast({
        title: "تم رفض الطلب",
        description: `تم رفض طلب التسجيل لـ ${selectedRequest.name}`,
      });

      setShowRejectionDialog(false);
      setRejectionReason("");
      setSelectedRequest(null);
      fetchData();
    } catch (error: any) {
      console.error('Error rejecting request:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ أثناء رفض الطلب",
        variant: "destructive"
      });
    }
  };

  const getGradeName = (gradeId: string) => {
    return grades.find(g => g.id === gradeId)?.name || 'غير محدد';
  };

  const getGroupName = (groupId: string) => {
    return groups.find(g => g.id === groupId)?.name || 'غير محدد';
  };

  const getRequestedCoursesNames = (courseIds: string[]) => {
    return courseIds.map(id => courses.find(c => c.id === id)?.name || 'غير معروف').join(', ') || 'لا يوجد';
  };

  const renderRequestCard = (request: RegistrationRequest) => (
    <Card key={request.id} className="mb-4">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <CardTitle>{request.name}</CardTitle>
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
          تاريخ التقديم: {new Date(request.created_at).toLocaleDateString('ar-EG')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            <span>البريد الإلكتروني: {request.email}</span>
          </div>
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4" />
            <span>الهاتف: {request.phone}</span>
          </div>
          <div className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4" />
            <span>الصف: {getGradeName(request.grade_id)}</span>
          </div>
          <div className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4" />
            <span>المجموعة: {getGroupName(request.group_id)}</span>
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
            >
              <X className="mr-2 h-4 w-4" />
              رفض
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const approvedRequests = requests.filter(r => r.status === 'approved');
  const rejectedRequests = requests.filter(r => r.status === 'rejected');

  if (loading) {
    return <div className="p-8 text-center">جاري التحميل...</div>;
  }

  return (
    <div className="container mx-auto p-6" dir="rtl">
      <Card>
        <CardHeader>
          <CardTitle>طلبات التسجيل للطلاب</CardTitle>
          <CardDescription>
            إدارة طلبات التسجيل الجديدة من الطلاب الأونلاين
          </CardDescription>
        </CardHeader>
        <CardContent>
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
      </Card>

      <Dialog open={showRejectionDialog} onOpenChange={setShowRejectionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>رفض طلب التسجيل</DialogTitle>
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
            <Button variant="destructive" onClick={handleReject}>
              تأكيد الرفض
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}