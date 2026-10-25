import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Video, ExternalLink, Calendar, Clock, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import StudentHeader from "@/components/StudentHeader";
import * as apiHttp from "@/lib/api-http";

/**
 * A meeting link may only be opened when it is an absolute http(s) URL with a
 * host. Every other scheme (javascript:, data:, blob:, file:, ...) is rejected
 * so a server-provided link can never execute script or navigate the student
 * away from the app.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
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
    if (typeof error === "object" && error !== null) {
        if ("status" in error) {
            const status = (error as { status?: unknown }).status;
            if (typeof status === "number") return status;
        }
        if ("response" in error) {
            const response = (error as { response?: { status?: unknown } }).response;
            if (typeof response?.status === "number") return response.status;
        }
    }
    return undefined;
};

/**
 * Maps a failed meetings fetch to an honest Arabic message. A 401/403 must not
 * be presented as "no meetings": the student needs to know the list failed to
 * load (session expired / no permission) so they can retry or re-authenticate.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export const describeMeetingsLoadError = (error: unknown): string => {
    const status = extractHttpStatus(error);
    if (status === 401) return "انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.";
    if (status === 403) return "لا تملك صلاحية عرض الاجتماعات.";
    if (typeof status === "number") return "تعذر تحميل الاجتماعات من الخادم. حاول مرة أخرى.";
    return "تعذر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.";
};

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
    grade_name: string;
    group_name: string | null;
    created_by_name: string;
}

const StudentMeetings = () => {
    const [meetings, setMeetings] = useState<Meeting[]>([]);
    const [meetingsError, setMeetingsError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const { toast } = useToast();
    const navigate = useNavigate();

    const isMountedRef = useRef(true);
    const loadSeqRef = useRef(0);
    const joinGuardRef = useRef(false);

    // Copy to clipboard with fallback for non-HTTPS
    const copyToClipboard = async (text: string) => {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                toast({ title: "تم النسخ", description: "تم نسخ رابط الاجتماع" });
            } else {
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
                    toast({ title: "تم النسخ", description: "تم نسخ رابط الاجتماع" });
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

    const fetchMeetings = async () => {
        const requestSeq = ++loadSeqRef.current;
        const startingToken = localStorage.getItem('authToken') ?? '';
        setLoading(true);
        setMeetingsError(null);
        // Never show links from a previous student or scope: clear before loading.
        setMeetings([]);

        let studentId = '';
        try {
            const userData = localStorage.getItem('currentUser');
            if (!startingToken || !userData) {
                navigate('/auth');
                return;
            }
            const user = JSON.parse(userData) as { id?: unknown; role?: unknown };
            if (user.role !== 'student' || typeof user.id !== 'string' || !user.id) {
                navigate('/forbidden');
                return;
            }
            studentId = user.id;
        } catch {
            navigate('/auth');
            return;
        }

        const isCurrent = () =>
            isMountedRef.current
            && requestSeq === loadSeqRef.current
            && startingToken === (localStorage.getItem('authToken') ?? '');

        try {
            const response = await apiHttp.authenticatedApiFetch(
                `/meetings/student/${encodeURIComponent(studentId)}`,
            );
            if (!isCurrent()) return;
            if (response.status === 401) {
                navigate('/auth');
                return;
            }
            if (!response.ok) {
                setMeetingsError(describeMeetingsLoadError({ response: { status: response.status } }));
                return;
            }
            const data = await apiHttp.readAuthenticatedApiJson(response);
            if (!isCurrent()) return;
            if (!Array.isArray(data)) throw new Error('Invalid meetings response');
            setMeetings(data);
        } catch (error) {
            if (!isCurrent()) return;
            if ((error as { code?: unknown })?.code === 'CLIENT_SESSION_CHANGED') return;
            console.error('Error fetching meetings:', error);
            if (extractHttpStatus(error) === 401) {
                navigate('/auth');
                return;
            }
            setMeetings([]);
            setMeetingsError(describeMeetingsLoadError(error));
        } finally {
            if (isCurrent()) setLoading(false);
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
        if (joinGuardRef.current) return;
        joinGuardRef.current = true;
        try {
            // noopener/noreferrer prevents the opened meeting tab from reaching
            // back into this window (reverse tabnabbing).
            window.open(link.trim(), "_blank", "noopener,noreferrer");
        } finally {
            window.setTimeout(() => {
                joinGuardRef.current = false;
            }, 1000);
        }
    };

    useEffect(() => {
        isMountedRef.current = true;
        void fetchMeetings();

        const refreshSession = () => {
            loadSeqRef.current += 1;
            setMeetings([]);
            setMeetingsError(null);
            void fetchMeetings();
        };
        const onStorage = (event: StorageEvent) => {
            if (!event.key || event.key === 'authToken' || event.key === 'currentUser') refreshSession();
        };

        window.addEventListener(apiHttp.AUTH_SESSION_CHANGED_EVENT, refreshSession);
        window.addEventListener('storage', onStorage);
        return () => {
            isMountedRef.current = false;
            loadSeqRef.current += 1;
            window.removeEventListener(apiHttp.AUTH_SESSION_CHANGED_EVENT, refreshSession);
            window.removeEventListener('storage', onStorage);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    const getMeetingTypeColor = (type: string) => {
        switch (type) {
            case 'zoom': return 'bg-blue-500';
            case 'google_meet': return 'bg-green-500';
            default: return 'bg-gray-500';
        }
    };

    const isUpcoming = (dateString: string) => {
        const meetingDate = new Date(dateString);
        const now = new Date();
        return meetingDate > now;
    };

    const isLive = (dateString: string, durationMinutes: number) => {
        const meetingStart = new Date(dateString);
        const meetingEnd = new Date(meetingStart.getTime() + durationMinutes * 60000);
        const now = new Date();
        return now >= meetingStart && now <= meetingEnd;
    };

    // Sort meetings: live first, then upcoming, then past
    const sortedMeetings = [...meetings].sort((a, b) => {
        const aLive = isLive(a.scheduled_at, a.duration_minutes);
        const bLive = isLive(b.scheduled_at, b.duration_minutes);
        if (aLive && !bLive) return -1;
        if (!aLive && bLive) return 1;
        return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
    });

    return (
        <div className="min-h-screen bg-gradient-to-br from-amber-50/80 via-orange-50/60 to-yellow-50/80 dark:from-slate-900 dark:via-amber-950/30 dark:to-slate-900" dir="rtl">
            <StudentHeader />
            <div className="container mx-auto px-4 py-8">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                            <Video className="w-6 h-6 text-primary" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-foreground">الاجتماعات الأونلاين</h1>
                            <p className="text-muted-foreground">اجتماعات الفيديو المجدولة لك</p>
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="flex justify-center items-center py-12">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
                    </div>
                ) : meetingsError ? (
                    <Card className="shadow-soft">
                        <CardContent className="py-12">
                            <div className="text-center">
                                <p role="alert" className="text-destructive mb-4">{meetingsError}</p>
                                <Button variant="outline" onClick={fetchMeetings}>إعادة المحاولة</Button>
                            </div>
                        </CardContent>
                    </Card>
                ) : sortedMeetings.length === 0 ? (
                    <Card className="shadow-soft">
                        <CardContent className="py-12">
                            <div className="text-center">
                                <Video className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                                <h3 className="text-lg font-semibold mb-2">لا توجد اجتماعات مجدولة</h3>
                                <p className="text-muted-foreground">
                                    سيتم عرض الاجتماعات هنا عندما يقوم المدرس بجدولة اجتماع جديد
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid gap-4">
                        {sortedMeetings.map((meeting) => {
                            const live = isLive(meeting.scheduled_at, meeting.duration_minutes);
                            const upcoming = isUpcoming(meeting.scheduled_at);

                            return (
                                <Card
                                    key={meeting.id}
                                    className={`shadow-soft transition-all ${live ? 'ring-2 ring-green-500 bg-green-50/50 dark:bg-green-950/20' : ''}`}
                                >
                                    <CardContent className="p-6">
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <div className="flex items-center gap-3 mb-3">
                                                    <div className={`w-3 h-3 rounded-full ${live ? 'bg-green-500 animate-pulse' : upcoming ? 'bg-yellow-500' : 'bg-gray-400'}`}></div>
                                                    <h3 className="font-bold text-xl">{meeting.title}</h3>
                                                    <span className={`text-xs px-3 py-1 rounded-full text-white ${getMeetingTypeColor(meeting.meeting_type)}`}>
                                                        {getMeetingTypeLabel(meeting.meeting_type)}
                                                    </span>
                                                    {live && (
                                                        <span className="text-xs px-3 py-1 rounded-full bg-green-500 text-white animate-pulse">
                                                            🔴 مباشر الآن
                                                        </span>
                                                    )}
                                                </div>

                                                {meeting.description && (
                                                    <p className="text-muted-foreground mb-4">{meeting.description}</p>
                                                )}

                                                <div className="flex flex-wrap gap-6 text-sm">
                                                    <div className="flex items-center gap-2 text-muted-foreground">
                                                        <Calendar className="w-4 h-4" />
                                                        <span>{formatDate(meeting.scheduled_at)}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-muted-foreground">
                                                        <Clock className="w-4 h-4" />
                                                        <span>{meeting.duration_minutes} دقيقة</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-muted-foreground">
                                                        <Users className="w-4 h-4" />
                                                        <span>{meeting.grade_name}</span>
                                                        {meeting.group_name && <span>- {meeting.group_name}</span>}
                                                    </div>
                                                </div>

                                                {meeting.meeting_password && (
                                                    <div className="mt-4 p-3 bg-muted/50 rounded-lg inline-block">
                                                        <span className="text-sm text-muted-foreground">كلمة المرور: </span>
                                                        <code className="font-mono font-bold">{meeting.meeting_password}</code>
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex flex-col gap-2 mr-6">
                                                <Button
                                                    size="lg"
                                                    className={live ? 'bg-green-600 hover:bg-green-700' : ''}
                                                    onClick={() => joinMeeting(meeting.meeting_link)}
                                                >
                                                    <ExternalLink className="w-5 h-5 ml-2" />
                                                    {live ? 'انضم الآن' : 'انضم للاجتماع'}
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    onClick={() => copyToClipboard(meeting.meeting_link)}
                                                >
                                                    نسخ الرابط
                                                </Button>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

export default StudentMeetings;
