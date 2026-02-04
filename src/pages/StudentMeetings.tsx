import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Video, ExternalLink, Calendar, Clock, ArrowRight, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import axios from "axios";

// Helper to get API URL - same pattern as other pages
const getApiUrl = () => {
  const envApiUrl = import.meta.env.VITE_API_URL;
  if (envApiUrl) return envApiUrl;
  
  // In production, use relative path (nginx proxies /api to backend)
  const currentHost = window.location.hostname;
  if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
    return '/api';
  }
  return 'http://localhost:3001/api';
};

const API_URL = getApiUrl();

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
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const navigate = useNavigate();

  const getToken = () => localStorage.getItem('token');
  const getUser = () => {
    const userData = localStorage.getItem('currentUser');
    return userData ? JSON.parse(userData) : null;
  };

  const fetchMeetings = async () => {
    try {
      const user = getUser();
      if (!user) {
        navigate('/auth');
        return;
      }

      const res = await axios.get(`${API_URL}/meetings/student/${user.id}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      setMeetings(res.data);
    } catch (error) {
      console.error('Error fetching meetings:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMeetings();
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/student')}>
              <ArrowRight className="w-5 h-5" />
            </Button>
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
                  className={`shadow-soft transition-all ${
                    live ? 'ring-2 ring-green-500 bg-green-50/50 dark:bg-green-950/20' : ''
                  }`}
                >
                  <CardContent className="p-6">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-3">
                          <div className={`w-3 h-3 rounded-full ${
                            live ? 'bg-green-500 animate-pulse' : 
                            upcoming ? 'bg-yellow-500' : 'bg-gray-400'
                          }`}></div>
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
                          onClick={() => window.open(meeting.meeting_link, '_blank')}
                        >
                          <ExternalLink className="w-5 h-5 ml-2" />
                          {live ? 'انضم الآن' : 'انضم للاجتماع'}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            navigator.clipboard.writeText(meeting.meeting_link);
                            toast({ title: "تم النسخ", description: "تم نسخ رابط الاجتماع" });
                          }}
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
