import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Video, ExternalLink } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface Group {
  id: string;
  name: string;
}

interface OnlineMeeting {
  id: string;
  group_id: string;
  meeting_link: string;
  meeting_type: string;
  created_at: string;
  groups: {
    name: string;
  };
}

const OnlineMeeting = () => {
  const [googleMeetLink, setGoogleMeetLink] = useState("");
  const [zoomLink, setZoomLink] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupGoogleMeet, setSelectedGroupGoogleMeet] = useState<string>("");
  const [selectedGroupZoom, setSelectedGroupZoom] = useState<string>("");
  const [savedMeetings, setSavedMeetings] = useState<OnlineMeeting[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    fetchGroups();
    fetchSavedMeetings();
  }, []);

  const fetchGroups = async () => {
    const { data, error } = await supabase
      .from("groups")
      .select("id, name")
      .eq("is_active", true)
      .order("name");

    if (error) {
      toast({
        title: "خطأ",
        description: "فشل تحميل المجموعات",
        variant: "destructive",
      });
      return;
    }

    setGroups(data || []);
  };

  const fetchSavedMeetings = async () => {
    const { data, error } = await supabase
      .from("online_meetings")
      .select(`
        id,
        group_id,
        meeting_link,
        meeting_type,
        created_at,
        groups (
          name
        )
      `)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to fetch meetings:", error);
      return;
    }

    setSavedMeetings(data || []);
  };

  const sendMeetingLinkToStudents = async (groupId: string, meetingLink: string, meetingType: string) => {
    // Get all students in the selected group
    const { data: students, error: studentsError } = await supabase
      .from("students")
      .select("id, name, email")
      .eq("group_id", groupId)
      .eq("approval_status", "approved");

    if (studentsError || !students || students.length === 0) {
      console.error("Failed to fetch students:", studentsError);
      return;
    }

    const groupName = groups.find(g => g.id === groupId)?.name;
    const meetingTypeName = meetingType === "google_meet" ? "Google Meet" : "Zoom";
    const messageText = `تم إنشاء اجتماع ${meetingTypeName} جديد للمجموعة: ${groupName}\n\nرابط الاجتماع:\n${meetingLink}`;

    // Send message to each student
    const messages = students.map(student => ({
      student_id: student.id,
      message_text: messageText,
      sent_at: new Date().toISOString(),
    }));

    const { error: messageError } = await supabase
      .from("teacher_messages")
      .insert(messages);

    if (messageError) {
      console.error("Failed to send messages:", messageError);
      toast({
        title: "تحذير",
        description: "تم حفظ الاجتماع لكن فشل إرسال الرسائل للطلاب",
        variant: "destructive",
      });
    } else {
      toast({
        title: "تم الإرسال",
        description: `تم إرسال رابط الاجتماع لـ ${students.length} طالب`,
      });
    }
  };

  const saveGoogleMeetMeeting = async () => {
    if (!selectedGroupGoogleMeet) {
      toast({
        title: "خطأ",
        description: "يجب اختيار المجموعة أولاً",
        variant: "destructive",
      });
      return;
    }

    if (!googleMeetLink) {
      toast({
        title: "خطأ",
        description: "يجب إدخال رابط الاجتماع",
        variant: "destructive",
      });
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("online_meetings")
      .insert({
        group_id: selectedGroupGoogleMeet,
        meeting_link: googleMeetLink,
        meeting_type: "google_meet",
        created_by: user?.id,
      });

    if (error) {
      toast({
        title: "خطأ",
        description: "فشل حفظ الاجتماع",
        variant: "destructive",
      });
      return;
    }

    const selectedGroupName = groups.find(g => g.id === selectedGroupGoogleMeet)?.name;
    
    toast({
      title: "تم الحفظ",
      description: `تم حفظ اجتماع Google Meet للمجموعة: ${selectedGroupName}`,
    });

    // Send link to students
    await sendMeetingLinkToStudents(selectedGroupGoogleMeet, googleMeetLink, "google_meet");

    setGoogleMeetLink("");
    setSelectedGroupGoogleMeet("");
    fetchSavedMeetings();
  };

  const saveZoomMeeting = async () => {
    if (!selectedGroupZoom) {
      toast({
        title: "خطأ",
        description: "يجب اختيار المجموعة أولاً",
        variant: "destructive",
      });
      return;
    }

    if (!zoomLink) {
      toast({
        title: "خطأ",
        description: "يجب إدخال رابط الاجتماع",
        variant: "destructive",
      });
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("online_meetings")
      .insert({
        group_id: selectedGroupZoom,
        meeting_link: zoomLink,
        meeting_type: "zoom",
        created_by: user?.id,
      });

    if (error) {
      toast({
        title: "خطأ",
        description: "فشل حفظ الاجتماع",
        variant: "destructive",
      });
      return;
    }

    const selectedGroupName = groups.find(g => g.id === selectedGroupZoom)?.name;
    
    toast({
      title: "تم الحفظ",
      description: `تم حفظ اجتماع Zoom للمجموعة: ${selectedGroupName}`,
    });

    // Send link to students
    await sendMeetingLinkToStudents(selectedGroupZoom, zoomLink, "zoom");

    setZoomLink("");
    setSelectedGroupZoom("");
    fetchSavedMeetings();
  };

  const openMeeting = (link: string) => {
    if (link) {
      window.open(link, '_blank');
    } else {
      toast({
        title: "خطأ",
        description: "يجب إنشاء رابط أولاً",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Video className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">الاجتماعات الأونلاين</h1>
              <p className="text-muted-foreground">إنشاء وإدارة الاجتماعات مع الطلاب</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Google Meet Card */}
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Video className="w-5 h-5" />
                Google Meet
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>اختر المجموعة</Label>
                <Select value={selectedGroupGoogleMeet} onValueChange={setSelectedGroupGoogleMeet}>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر المجموعة" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>رابط Google Meet</Label>
                <div className="flex gap-2">
                  <Input
                    value={googleMeetLink}
                    onChange={(e) => setGoogleMeetLink(e.target.value)}
                    placeholder="https://meet.google.com/..."
                  />
                  <Button onClick={saveGoogleMeetMeeting}>
                    حفظ
                  </Button>
                </div>
              </div>

              <div className="text-sm text-muted-foreground">
                <p>• الصق رابط Google Meet الخاص بك</p>
                <p>• اختر المجموعة وانقر حفظ</p>
                <p>• سيتم إرسال الرابط تلقائياً لجميع الطلاب في المجموعة</p>
              </div>
            </CardContent>
          </Card>

          {/* Zoom Card */}
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Video className="w-5 h-5" />
                Zoom
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>اختر المجموعة</Label>
                <Select value={selectedGroupZoom} onValueChange={setSelectedGroupZoom}>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر المجموعة" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>رابط Zoom</Label>
                <div className="flex gap-2">
                  <Input
                    value={zoomLink}
                    onChange={(e) => setZoomLink(e.target.value)}
                    placeholder="https://zoom.us/j/..."
                  />
                  <Button onClick={saveZoomMeeting}>
                    حفظ
                  </Button>
                </div>
              </div>

              <div className="text-sm text-muted-foreground">
                <p>• الصق رابط اجتماع Zoom الخاص بك</p>
                <p>• اختر المجموعة وانقر حفظ</p>
                <p>• سيتم إرسال الرابط تلقائياً لجميع الطلاب في المجموعة</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Saved Meetings List */}
        {savedMeetings.length > 0 && (
          <Card className="shadow-soft mt-6">
            <CardHeader>
              <CardTitle>الاجتماعات المحفوظة</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {savedMeetings.map((meeting) => (
                  <div key={meeting.id} className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                        <Video className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-semibold">{meeting.groups.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {meeting.meeting_type === 'google_meet' ? 'Google Meet' : 'Zoom'}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => openMeeting(meeting.meeting_link)}
                      >
                        <ExternalLink className="w-4 h-4 ml-2" />
                        انضم
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          navigator.clipboard.writeText(meeting.meeting_link);
                          toast({
                            title: "تم النسخ",
                            description: "تم نسخ الرابط للحافظة",
                          });
                        }}
                      >
                        نسخ
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="shadow-soft mt-6">
          <CardHeader>
            <CardTitle>تعليمات الاستخدام</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p><strong>Google Meet:</strong></p>
              <ul className="list-disc list-inside mr-4">
                <li>أنشئ اجتماع Google Meet من حسابك</li>
                <li>انسخ الرابط والصقه في الحقل</li>
                <li>اختر المجموعة واضغط "حفظ"</li>
                <li>سيتم إرسال الرابط تلقائياً لجميع طلاب المجموعة</li>
              </ul>
              
              <p className="mt-4"><strong>Zoom:</strong></p>
              <ul className="list-disc list-inside mr-4">
                <li>أنشئ اجتماع Zoom من حسابك</li>
                <li>انسخ الرابط والصقه في الحقل</li>
                <li>اختر المجموعة واضغط "حفظ"</li>
                <li>سيتم إرسال الرابط تلقائياً لجميع طلاب المجموعة</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default OnlineMeeting;