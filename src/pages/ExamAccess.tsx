import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Key } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

type LocalSessionSnapshot = {
  token: string | null;
  userId: string | null;
};

/** Reads the local session without throwing on a malformed payload. */
const readLocalSession = (): LocalSessionSnapshot | null => {
  const token = localStorage.getItem('authToken');
  const userStr = localStorage.getItem('currentUser');
  if (!userStr) return null;
  try {
    const parsed: unknown = JSON.parse(userStr);
    if (!parsed || typeof parsed !== 'object') return null;
    const id = (parsed as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) return null;
    return { token, userId: id };
  } catch {
    return null;
  }
};

const sessionIdentity = (session: LocalSessionSnapshot | null): string =>
  session ? `${session.token ?? ''}|${session.userId ?? ''}` : '';

const ExamAccess = () => {
  const [examCode, setExamCode] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  // Synchronous entry latch: a double submit cannot run two code lookups or
  // navigate twice before React has re-rendered the disabled button.
  const submittingRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

    const code = examCode.trim().toUpperCase();
    if (!code) return;

    submittingRef.current = true;
    setLoading(true);

    const startingSessionKey = sessionIdentity(readLocalSession());
    let navigated = false;

    try {
      // Check if exam code exists
      const { data: exam, error } = await supabase
        .from('exams')
        .select('id, title, exam_code, is_active')
        .eq('exam_code', code)
        .eq('is_active', true)
        .single();

      if (!isMountedRef.current) return;

      // An entry into a different account must not be completed with the
      // result of a lookup started under the previous session.
      if (sessionIdentity(readLocalSession()) !== startingSessionKey) {
        toast({
          title: "انتهت الجلسة",
          description: "تغيرت جلسة الدخول. يرجى إعادة المحاولة.",
          variant: "destructive",
        });
        return;
      }

      if (error || !exam) {
        toast({
          title: "خطأ",
          description: "كود الامتحان غير صحيح أو الامتحان غير متاح",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "تم التحقق بنجاح",
        description: `جاري الانتقال لامتحان: ${exam.title}`,
      });

      // Navigate to exam
      navigated = true;
      navigate(`/take-exam/${exam.id}`);
    } catch (error: any) {
      if (!isMountedRef.current) return;
      console.error('Error:', error);
      toast({
        title: "خطأ",
        description: error.message || "حدث خطأ، حاول مرة أخرى",
        variant: "destructive",
      });
    } finally {
      if (isMountedRef.current) {
        if (!navigated) submittingRef.current = false;
        setLoading(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <StudentHeader />
      
      <div className="container mx-auto px-4 py-16">
        <Card className="max-w-md mx-auto shadow-soft">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 justify-center">
              <Key className="w-6 h-6 text-primary" />
              الدخول للامتحان
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="examCode">كود الامتحان</Label>
                <Input
                  id="examCode"
                  value={examCode}
                  onChange={(e) => setExamCode(e.target.value.toUpperCase())}
                  placeholder="أدخل كود الامتحان"
                  required
                  className="text-center text-lg font-mono tracking-wider"
                />
                <p className="text-sm text-muted-foreground text-center">
                  الرجاء إدخال كود الامتحان المرسل إليك
                </p>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "جاري التحقق..." : "دخول الامتحان"}
              </Button>
            </form>

            <div className="mt-6 p-4 bg-muted rounded-lg">
              <h3 className="font-medium mb-2 text-sm">ملاحظات هامة:</h3>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>• تأكد من إدخال الكود بشكل صحيح</li>
                <li>• الامتحان متاح فقط في الوقت المحدد</li>
                <li>• لن تستطيع الخروج من الامتحان بعد البدء</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default ExamAccess;