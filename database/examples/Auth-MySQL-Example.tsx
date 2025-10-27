// مثال على كيفية تحديث Auth.tsx للعمل مع MySQL بدلاً من Supabase

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { GraduationCap, LogIn, UserPlus } from "lucide-react";
import { useNavigate } from "react-router-dom";
// استبدال Supabase بـ API الجديد
import { signIn, signUp } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import alQaedLogo from "@/assets/al-qaed-logo-new.jpg";

const Auth = () => {
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const navigate = useNavigate();
    const { toast } = useToast();

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError("");

        try {
            if (isLogin) {
                // تسجيل الدخول باستخدام MySQL API
                const { user, error: authError } = await signIn(email, password);

                if (authError || !user) {
                    setError(authError || "فشل تسجيل الدخول");
                    toast({
                        variant: "destructive",
                        title: "خطأ",
                        description: authError || "فشل تسجيل الدخول",
                    });
                    return;
                }

                // حفظ بيانات المستخدم في localStorage
                localStorage.setItem('user', JSON.stringify(user));

                // التوجيه حسب نوع المستخدم
                if (user.role === 'admin' || user.role === 'teacher') {
                    navigate("/teacher");
                } else {
                    navigate("/student");
                }

                toast({
                    title: "تم تسجيل الدخول بنجاح",
                    description: `مرحباً بك ${user.name}`,
                });
            } else {
                // إنشاء حساب جديد
                if (!name.trim()) {
                    setError("يجب إدخال الاسم");
                    return;
                }

                const { user, error: authError } = await signUp(email, password, name);

                if (authError || !user) {
                    setError(authError || "فشل إنشاء الحساب");
                    toast({
                        variant: "destructive",
                        title: "خطأ",
                        description: authError || "فشل إنشاء الحساب",
                    });
                    return;
                }

                // حفظ بيانات المستخدم
                localStorage.setItem('user', JSON.stringify(user));

                toast({
                    title: "تم إنشاء الحساب بنجاح",
                    description: "يمكنك الآن تسجيل الدخول",
                });

                setIsLogin(true);
            }
        } catch (error: any) {
            console.error('Auth error:', error);
            setError(error.message || "حدث خطأ غير متوقع");
            toast({
                variant: "destructive",
                title: "خطأ",
                description: error.message || "حدث خطأ أثناء المعالجة",
            });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-hero flex items-center justify-center p-4" dir="rtl">
            <Card className="w-full max-w-md shadow-glow border-border/50">
                <CardHeader className="text-center space-y-4">
                    <div className="flex justify-center">
                        <div className="w-20 h-20 rounded-xl overflow-hidden shadow-medium">
                            <img src={alQaedLogo} alt="منصة القائد" className="w-full h-full object-cover" />
                        </div>
                    </div>
                    <div>
                        <CardTitle className="text-2xl text-foreground">منصة القائد</CardTitle>
                        <p className="text-muted-foreground">أ/ محمد رمضان - التاريخ والجغرافيا</p>
                    </div>
                </CardHeader>
                <CardContent>
                    <form onSubmit={handleAuth} className="space-y-4">
                        {!isLogin && (
                            <div className="space-y-2">
                                <Label htmlFor="name">اسم الطالب</Label>
                                <Input
                                    id="name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="أدخل اسم الطالب"
                                    required
                                    className="text-right"
                                />
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="email">البريد الإلكتروني</Label>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="example@email.com"
                                required
                                className="text-right"
                            />
                        </div>

                        {!isLogin && (
                            <div className="space-y-2">
                                <Label htmlFor="phone">رقم الهاتف</Label>
                                <Input
                                    id="phone"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                    placeholder="01234567890"
                                    required
                                    className="text-right"
                                />
                            </div>
                        )}

                        <div className="space-y-2">
                            <Label htmlFor="password">كلمة المرور</Label>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••"
                                required
                                className="text-right"
                            />
                        </div>

                        {error && (
                            <Alert variant="destructive">
                                <AlertDescription>{error}</AlertDescription>
                            </Alert>
                        )}

                        <Button
                            type="submit"
                            className="w-full"
                            disabled={loading}
                        >
                            {loading ? (
                                "جاري المعالجة..."
                            ) : isLogin ? (
                                <>
                                    <LogIn className="w-4 h-4 ml-2" />
                                    تسجيل الدخول
                                </>
                            ) : (
                                <>
                                    <UserPlus className="w-4 h-4 ml-2" />
                                    إنشاء حساب جديد
                                </>
                            )}
                        </Button>
                    </form>

                    <div className="mt-4 text-center">
                        <Button
                            variant="link"
                            onClick={() => setIsLogin(!isLogin)}
                            className="text-primary"
                        >
                            {isLogin
                                ? "لا تملك حساب؟ إنشاء حساب كطالب"
                                : "تملك حساب بالفعل؟ تسجيل الدخول"}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

export default Auth;
