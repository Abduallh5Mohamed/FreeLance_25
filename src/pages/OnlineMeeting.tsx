import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Video, ExternalLink, Trash2, Edit2, Calendar, Clock, Users } from "lucide-react";
import Header from "@/components/Header";
import { useToast } from "@/hooks/use-toast";
import axios from "axios";

// Helper to get API URL - same pattern as other pages.
// Vite injects `import.meta.env` at build time; it is absent when this module
// is imported outside Vite (isolated Node tests), hence the guards below.
const getApiUrl = () => {
  const viteEnv: ImportMetaEnv | undefined = import.meta.env;
  const envApiUrl = viteEnv?.VITE_API_URL;
  if (envApiUrl) return envApiUrl;

  // In production, use relative path (nginx proxies /api to backend)
  const currentHost = typeof window !== "undefined" ? window.location.hostname : "";
  if (currentHost !== "localhost" && currentHost !== "127.0.0.1" && currentHost !== "") {
    return '/api';
  }
  return 'http://localhost:3001/api';
};

const API_URL = getApiUrl();

/**
 * Synchronous in-flight latch for async UI actions.
 *
 * A disabled button bound to a `loading` state only blocks a second click
 * after React re-renders; two clicks in the same tick both still see
 * `loading === false`. The latch is acquired synchronously inside the handler
 * so a same-tick duplicate submit is rejected before any request is sent.
 * `release` must run in a `finally` so a failed attempt stays retryable.
 */
export interface SubmitGuard {
  tryAcquire(): boolean;
  release(): void;
}

export function createSubmitGuard(): SubmitGuard {
  let inFlight = false;
  return {
    tryAcquire: () => {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release: () => {
      inFlight = false;
    },
  };
}

/**
 * A meeting link may only be stored or opened when it is an absolute http(s)
 * URL with a host. Every other scheme (javascript:, data:, blob:, file:, ...)
 * is rejected so a stored or server-provided link can never execute script or
 * navigate the teacher or student away from the app.
 *
 * Mirrored in StudentMeetings.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const isSafeMeetingUrl = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
};

const extractHttpStatus = (error: unknown): number | undefined => {
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = (error as { response?: { status?: unknown } }).response;
    if (typeof response?.status === "number") return response.status;
  }
  return undefined;
};

/**
 * Maps a failed meetings fetch to an honest Arabic message. A 401/403 must not
 * be presented as "no meetings": the user needs to know the list failed to
 * load (session expired / no permission) so they can retry or re-authenticate.
 *
 * Mirrored in StudentMeetings.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const describeMeetingsLoadError = (error: unknown): string => {
  const status = extractHttpStatus(error);
  if (status === 401) return "انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.";
  if (status === 403) return "لا تملك صلاحية عرض الاجتماعات.";
  if (typeof status === "number") return "تعذر تحميل الاجتماعات من الخادم. حاول مرة أخرى.";
  return "تعذر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.";
};

interface Grade {
  id: string;
  name: string;
}

interface Group {
  id: string;
  name: string;
  grade_id: string;
}

interface Meeting {
  id: string;
  title: string;
  description: string;
  meeting_link: string;
  meeting_type: string;
  meeting_password: string;
  grade_id: string;
  group_id: string | null;
  scheduled_at: string;
  duration_minutes: number;
  is_active: boolean;
  grade_name: string;
  group_name: string | null;
  created_by_name: string;
}

const OnlineMeeting = () => {
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [filteredGroups, setFilteredGroups] = useState<Group[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meetingsError, setMeetingsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  // Synchronous latch so a same-tick double click cannot create two meetings.
  const submitGuardRef = useRef<SubmitGuard | null>(null);
  submitGuardRef.current ??= createSubmitGuard();

  // Copy to clipboard with fallback for non-HTTPS
  const copyToClipboard = async (text: string) => {
    try {
      // Try modern clipboard API first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast({ title: "تم النسخ", description: "تم نسخ الرابط" });
      } else {
        // Fallback for HTTP (non-secure contexts)
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
          document.execCommand('copy');
          toast({ title: "تم النسخ", description: "تم نسخ الرابط" });
        } catch (err) {
          console.error('Fallback copy failed:', err);
          toast({
            title: "فشل النسخ",
            description: "الرجاء نسخ الرابط يدوياً",
            variant: "destructive"
          });
        } finally {
          textArea.remove();
        }
      }
    } catch (err) {
      console.error('Copy failed:', err);
      toast({
        title: "فشل النسخ",
        description: "الرجاء نسخ الرابط يدوياً",
        variant: "destructive"
      });
    }
  };

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [meetingType, setMeetingType] = useState("zoom");
  const [meetingPassword, setMeetingPassword] = useState("");
  const [selectedGrade, setSelectedGrade] = useState("");
  const [selectedGroup, setSelectedGroup] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    fetchGrades();
    fetchGroups();
    fetchMeetings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter groups when grade changes
  useEffect(() => {
    if (selectedGrade) {
      const filtered = groups.filter(g => g.grade_id === selectedGrade);
      setFilteredGroups(filtered);
    } else {
      setFilteredGroups([]);
    }
    setSelectedGroup(""); // Reset group when grade changes
  }, [selectedGrade, groups]);

  const getToken = () => localStorage.getItem('token');
  const getUser = () => {
    const userData = localStorage.getItem('currentUser');
    return userData ? JSON.parse(userData) : null;
  };

  const fetchGrades = async () => {
    try {
      const res = await axios.get(`${API_URL}/grades`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      setGrades(res.data);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchGroups = async () => {
    try {
      const res = await axios.get(`${API_URL}/groups`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      setGroups(res.data);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const fetchMeetings = async () => {
    try {
      const res = await axios.get(`${API_URL}/meetings`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      setMeetings(res.data);
      setMeetingsError(null);
    } catch (error) {
      console.error('Error fetching meetings:', error);
      setMeetingsError(describeMeetingsLoadError(error));
    }
  };

  const joinMeeting = (link: string) => {
    if (!isSafeMeetingUrl(link)) {
      toast({
        title: "خطأ",
        description: "رابط الاجتماع غير صالح أو غير متاح",
        variant: "destructive"
      });
      return;
    }
    // noopener/noreferrer prevents the opened meeting tab from reaching back
    // into this window (reverse tabnabbing).
    window.open(link.trim(), "_blank", "noopener,noreferrer");
  };

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setMeetingLink("");
    setMeetingType("zoom");
    setMeetingPassword("");
    setSelectedGrade("");
    setSelectedGroup("");
    setScheduledAt("");
    setDurationMinutes("60");
    setEditingId(null);
  };

  const saveMeeting = async () => {
    if (!title.trim()) {
      toast({ title: "خطأ", description: "يجب إدخال عنوان الاجتماع", variant: "destructive" });
      return;
    }
    if (!meetingLink.trim()) {
      toast({ title: "خطأ", description: "يجب إدخال رابط الاجتماع", variant: "destructive" });
      return;
    }
    if (!selectedGrade) {
      toast({ title: "خطأ", description: "يجب اختيار الصف", variant: "destructive" });
      return;
    }
    if (!scheduledAt) {
      toast({ title: "خطأ", description: "يجب تحديد موعد الاجتماع", variant: "destructive" });
      return;
    }
    if (!isSafeMeetingUrl(meetingLink)) {
      toast({
        title: "خطأ",
        description: "رابط الاجتماع غير صالح. يجب أن يبدأ بـ https:// أو http://",
        variant: "destructive"
      });
      return;
    }

    // Synchronous latch: a same-tick duplicate click is rejected here, before
    // any request is sent, so two meetings can never be created.
    if (!submitGuardRef.current?.tryAcquire()) return;

    const user = getUser();
    setLoading(true);

    try {
      const payload = {
        title,
        description,
        meeting_link: meetingLink.trim(),
        meeting_type: meetingType,
        meeting_password: meetingPassword || null,
        grade_id: selectedGrade,
        group_id: selectedGroup || null,
        scheduled_at: scheduledAt,
        duration_minutes: parseInt(durationMinutes),
        created_by: user?.id
      };

      if (editingId) {
        await axios.put(`${API_URL}/meetings/${editingId}`, payload, {
          headers: { Authorization: `Bearer ${getToken()}` }
        });
        toast({ title: "تم التحديث", description: "تم تحديث الاجتماع بنجاح" });
      } else {
        await axios.post(`${API_URL}/meetings`, payload, {
          headers: { Authorization: `Bearer ${getToken()}` }
        });
        toast({ title: "تم الحفظ", description: "تم إنشاء الاجتماع بنجاح" });
      }

      resetForm();
      fetchMeetings();
    } catch (error) {
      console.error('Error saving meeting:', error);
      toast({ title: "خطأ", description: "فشل حفظ الاجتماع", variant: "destructive" });
    } finally {
      submitGuardRef.current?.release();
      setLoading(false);
    }
  };

  const editMeeting = (meeting: Meeting) => {
    setTitle(meeting.title);
    setDescription(meeting.description || "");
    setMeetingLink(meeting.meeting_link);
    setMeetingType(meeting.meeting_type);
    setMeetingPassword(meeting.meeting_password || "");
    setSelectedGrade(meeting.grade_id);
    setSelectedGroup(meeting.group_id || "");
    setScheduledAt(meeting.scheduled_at?.slice(0, 16) || "");
    setDurationMinutes(String(meeting.duration_minutes));
    setEditingId(meeting.id);
  };

  const deleteMeeting = async (id: string) => {
    if (!confirm("هل أنت متأكد من حذف هذا الاجتماع؟")) return;

    try {
      await axios.delete(`${API_URL}/meetings/${id}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      toast({ title: "تم الحذف", description: "تم حذف الاجتماع بنجاح" });
      fetchMeetings();
    } catch (error) {
      console.error('Error deleting meeting:', error);
      toast({ title: "خطأ", description: "فشل حذف الاجتماع", variant: "destructive" });
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('ar-EG', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getMeetingTypeLabel = (type: string) => {
    switch (type) {
      case 'zoom': return 'Zoom';
      case 'google_meet': return 'Google Meet';
      default: return 'أخرى';
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

        {/* Create/Edit Meeting Form */}
        <Card className="shadow-soft mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Video className="w-5 h-5" />
              {editingId ? 'تعديل الاجتماع' : 'إنشاء اجتماع جديد'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Title */}
              <div className="space-y-2">
                <Label htmlFor="meeting-title">عنوان الاجتماع *</Label>
                <Input
                  id="meeting-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="مثال: مراجعة الفصل الأول"
                />
              </div>

              {/* Meeting Type */}
              <div className="space-y-2">
                <Label htmlFor="meeting-type">نوع الاجتماع</Label>
                <Select value={meetingType} onValueChange={setMeetingType}>
                  <SelectTrigger id="meeting-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zoom">Zoom</SelectItem>
                    <SelectItem value="google_meet">Google Meet</SelectItem>
                    <SelectItem value="other">أخرى</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Meeting Link */}
              <div className="space-y-2">
                <Label htmlFor="meeting-link">رابط الاجتماع *</Label>
                <Input
                  id="meeting-link"
                  value={meetingLink}
                  onChange={(e) => setMeetingLink(e.target.value)}
                  placeholder="https://zoom.us/j/... أو https://meet.google.com/..."
                />
              </div>

              {/* Meeting Password */}
              <div className="space-y-2">
                <Label htmlFor="meeting-password">كلمة مرور الاجتماع (اختياري)</Label>
                <Input
                  id="meeting-password"
                  value={meetingPassword}
                  onChange={(e) => setMeetingPassword(e.target.value)}
                  placeholder="كلمة المرور إن وجدت"
                />
              </div>

              {/* Grade Selection - Required */}
              <div className="space-y-2">
                <Label htmlFor="meeting-grade">الصف الدراسي * (إجباري)</Label>
                <Select value={selectedGrade} onValueChange={setSelectedGrade}>
                  <SelectTrigger id="meeting-grade">
                    <SelectValue placeholder="اختر الصف" />
                  </SelectTrigger>
                  <SelectContent>
                    {grades.map((grade) => (
                      <SelectItem key={grade.id} value={grade.id}>
                        {grade.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Group Selection - Optional */}
              <div className="space-y-2">
                <Label htmlFor="meeting-group">المجموعة (اختياري - اتركه فارغ لكل الصف)</Label>
                <Select value={selectedGroup} onValueChange={setSelectedGroup} disabled={!selectedGrade}>
                  <SelectTrigger id="meeting-group">
                    <SelectValue placeholder={selectedGrade ? "كل المجموعات" : "اختر الصف أولاً"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل المجموعات في الصف</SelectItem>
                    {filteredGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  إذا لم تختر مجموعة، سيظهر الاجتماع لكل طلاب الصف
                </p>
              </div>

              {/* Scheduled At */}
              <div className="space-y-2">
                <Label htmlFor="meeting-scheduled-at">موعد الاجتماع *</Label>
                <Input
                  id="meeting-scheduled-at"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </div>

              {/* Duration */}
              <div className="space-y-2">
                <Label htmlFor="meeting-duration">مدة الاجتماع (بالدقائق)</Label>
                <Select value={durationMinutes} onValueChange={setDurationMinutes}>
                  <SelectTrigger id="meeting-duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 دقيقة</SelectItem>
                    <SelectItem value="45">45 دقيقة</SelectItem>
                    <SelectItem value="60">ساعة</SelectItem>
                    <SelectItem value="90">ساعة ونصف</SelectItem>
                    <SelectItem value="120">ساعتين</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="meeting-description">وصف الاجتماع (اختياري)</Label>
              <Textarea
                id="meeting-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="وصف موجز للاجتماع..."
                rows={3}
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={saveMeeting} disabled={loading}>
                {loading ? 'جاري الحفظ...' : (editingId ? 'تحديث الاجتماع' : 'إنشاء الاجتماع')}
              </Button>
              {editingId && (
                <Button variant="outline" onClick={resetForm}>
                  إلغاء التعديل
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Meetings List */}
        <Card className="shadow-soft">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              الاجتماعات المجدولة ({meetings.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {meetingsError && (
              <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                <p>{meetingsError}</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={fetchMeetings}>
                  إعادة المحاولة
                </Button>
              </div>
            )}
            {meetings.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {meetingsError ? "تعذر عرض الاجتماعات الآن." : "لا توجد اجتماعات مجدولة حالياً"}
              </div>
            ) : (
              <div className="space-y-4">
                {meetings.map((meeting) => (
                  <div key={meeting.id} className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h3 className="font-semibold text-lg">{meeting.title}</h3>
                          <span className={`text-xs px-2 py-1 rounded-full ${meeting.meeting_type === 'zoom' ? 'bg-blue-100 text-blue-700' :
                            meeting.meeting_type === 'google_meet' ? 'bg-green-100 text-green-700' :
                              'bg-gray-100 text-gray-700'
                            }`}>
                            {getMeetingTypeLabel(meeting.meeting_type)}
                          </span>
                        </div>

                        {meeting.description && (
                          <p className="text-sm text-muted-foreground mb-2">{meeting.description}</p>
                        )}

                        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Users className="w-4 h-4" />
                            <span>{meeting.grade_name}</span>
                            {meeting.group_name && <span>- {meeting.group_name}</span>}
                            {!meeting.group_id && <span className="text-primary">(كل المجموعات)</span>}
                          </div>
                          <div className="flex items-center gap-1">
                            <Calendar className="w-4 h-4" />
                            <span>{formatDate(meeting.scheduled_at)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Clock className="w-4 h-4" />
                            <span>{meeting.duration_minutes} دقيقة</span>
                          </div>
                        </div>

                        {meeting.meeting_password && (
                          <p className="text-sm text-muted-foreground mt-2">
                            كلمة المرور: <code className="bg-muted px-2 py-1 rounded">{meeting.meeting_password}</code>
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col gap-2 mr-4">
                        <Button
                          size="sm"
                          onClick={() => joinMeeting(meeting.meeting_link)}
                        >
                          <ExternalLink className="w-4 h-4 ml-1" />
                          انضم
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => copyToClipboard(meeting.meeting_link)}
                        >
                          نسخ الرابط
                        </Button>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label="تعديل الاجتماع"
                            onClick={() => editMeeting(meeting)}
                          >
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-destructive"
                            aria-label="حذف الاجتماع"
                            onClick={() => deleteMeeting(meeting.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default OnlineMeeting;
