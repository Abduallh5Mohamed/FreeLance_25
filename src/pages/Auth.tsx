import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { GraduationCap, LogIn, UserPlus, Sparkles, Lock, Mail, User, Phone as PhoneIcon, BookOpen, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { signIn, signUp, getStudentByEmail, getCourses, getGrades, getGroups } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import alQaedLogo from "@/assets/al-qaed-logo-new.jpg";
import logBackground from "@/assets/Log_Background.jpg";
import mohamedRamadan from "@/assets/Mohamed_Ramadan.png";
import bcrypt from "bcryptjs";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";

const Auth = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [grade, setGrade] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [grades, setGrades] = useState<Array<{ id: string; name: string }>>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchCourses();
    fetchGrades();
    fetchGroups();
  }, []);

  const fetchGroups = async () => {
    try {
      const data = await getGroups();
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const fetchGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data || []);
    } catch (error) {
      console.error('Error fetching courses:', error);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (isLogin) {
        console.log('🚀 Login attempt started with email:', email.toLowerCase().trim());

        // Try MySQL API signIn
        const result = await signIn(email.toLowerCase().trim(), password);

        if (result.error) {
          throw new Error(result.error);
        }

        if (result.user) {
          // Store user session in localStorage
          localStorage.setItem('currentUser', JSON.stringify(result.user));

          // Redirect based on role
          if (result.user.role === 'admin' || result.user.role === 'teacher') {
            navigate("/teacher");
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${result.user.name}`,
            });
          } else {
            // Student login - check if student exists
            const student = await getStudentByEmail(email.toLowerCase().trim());

            if (student && student.approval_status === 'approved') {
              localStorage.setItem('currentStudent', JSON.stringify(student));
              navigate("/student");
              toast({
                title: "تم تسجيل الدخول بنجاح",
                description: `مرحباً بك ${student.name}`,
              });
            } else {
              throw new Error("حسابك في انتظار الموافقة من الإدارة");
            }
          }
          return;
        }

        throw new Error("البريد الإلكتروني أو كلمة المرور غير صحيحة");
      } else {
        // Sign up - Create new user
        if (!name.trim()) {
          throw new Error("يجب إدخال اسم الطالب");
        }
        if (!phone.trim()) {
          throw new Error("يجب إدخال رقم الهاتف");
        }
        if (!gradeId) {
          throw new Error("يجب اختيار الصف الدراسي");
        }

        const result = await signUp(email.toLowerCase().trim(), password, name.trim(), 'student');

        if (result.error) {
          throw new Error(result.error);
        }

        // Clear form
        setEmail("");
        setPassword("");
        setName("");
        setPhone("");
        setGrade("");
        setGradeId("");
        setSelectedCourses([]);

        toast({
          title: "تم إنشاء الحساب بنجاح",
          description: "يمكنك الآن تسجيل الدخول باستخدام بياناتك",
        });

        setIsLogin(true); // Switch back to login view
      }
    } catch (error) {
      console.error('Auth error:', error);
      const errorMessage = error instanceof Error ? error.message : "حدث خطأ غير متوقع";
      setError(errorMessage);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-3 md:p-4 relative overflow-hidden" dir="rtl">
      {/* Background Image - Full screen with edge blur */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url(${logBackground})`,
        }}
      />
      
      {/* Edge Blur Overlay */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-black/30 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black/30 to-transparent" />
        <div className="absolute top-0 bottom-0 left-0 w-32 bg-gradient-to-r from-black/30 to-transparent" />
        <div className="absolute top-0 bottom-0 right-0 w-32 bg-gradient-to-l from-black/30 to-transparent" />
      </div>

      <FloatingParticles />

      {/* Animated Background Elements */}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div
          animate={{
            scale: [1, 1.2, 1],
            rotate: [0, 180, 360],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          className="absolute -top-1/2 -right-1/2 w-full h-full bg-gradient-to-br from-yellow-400/10 to-orange-500/10 rounded-full blur-3xl"
        />
        <motion.div
          animate={{
            scale: [1.2, 1, 1.2],
            rotate: [360, 180, 0],
          }}
          transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
          className="absolute -bottom-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-cyan-400/10 to-blue-500/10 rounded-full blur-3xl"
        />
      </div>

      {/* Mohamed Ramadan Image - Left Side, No Border, No Shadow */}
      <motion.div
        initial={{ opacity: 0, x: -100 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.8, delay: 0.3 }}
        className="hidden lg:block absolute left-0 top-0 bottom-0 z-10 pointer-events-none"
      >
        <GlassmorphicCard className="overflow-hidden max-w-md">
          <CardHeader className="text-center space-y-4 pb-6 bg-gradient-to-r from-primary/10 to-accent/10 px-4 md:px-6">
            <motion.div 
              className="flex justify-center"
              whileHover={{ scale: 1.1, rotate: 360 }}
              transition={{ duration: 0.6 }}
            >
              <div className="relative">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                  className="absolute inset-0 bg-gradient-to-r from-yellow-400 to-orange-500 rounded-2xl blur-xl opacity-50"
                />
                <div className="relative w-24 h-24 rounded-2xl overflow-hidden shadow-2xl border-4 border-white/20">
                  <img src={alQaedLogo} alt="منصة القائد" className="w-full h-full object-cover" />
                </div>
              </div>
            </motion.div>
            <div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
              >
                <CardTitle className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent mb-2 flex items-center justify-center gap-2">
                  <Sparkles className="w-6 h-6 text-yellow-500" />
                  منصة القائد
                </CardTitle>
                <p className="text-muted-foreground font-medium">أ/ محمد رمضان - التاريخ والجغرافيا</p>
              </motion.div>
            </div>
            
            {/* Tab Switcher */}
            <div className="flex gap-2 p-1 bg-muted/50 rounded-xl backdrop-blur-sm">
              <Button
                type="button"
                variant={isLogin ? "default" : "ghost"}
                onClick={() => setIsLogin(true)}
                className={`flex-1 transition-all duration-300 ${isLogin ? 'bg-gradient-to-r from-primary to-accent shadow-lg' : ''}`}
              >
                <LogIn className="w-4 h-4 ml-2" />
                تسجيل الدخول
              </Button>
              <Button
                type="button"
                variant={!isLogin ? "default" : "ghost"}
                onClick={() => setIsLogin(false)}
                className={`flex-1 transition-all duration-300 ${!isLogin ? 'bg-gradient-to-r from-primary to-accent shadow-lg' : ''}`}
              >
                <UserPlus className="w-4 h-4 ml-2" />
                حساب جديد
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6 px-4 md:px-6">
            <form onSubmit={handleAuth} className="space-y-4">
            {!isLogin && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-2"
              >
                <Label htmlFor="name" className="flex items-center gap-2">
                  <User className="w-4 h-4" />
                  اسم الطالب
                </Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="أدخل اسم الطالب"
                  required
                  className="text-right bg-background/50 border-2 focus:border-primary transition-all"
                />
              </motion.div>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="email" className="flex items-center gap-2">
                <Mail className="w-4 h-4" />
                البريد الإلكتروني
              </Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="example@email.com"
                required
                className="text-right bg-background/50 border-2 focus:border-primary transition-all"
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

            {!isLogin && (
              <>
                 <div className="space-y-2">
                  <Label htmlFor="grade">الصف الدراسي</Label>
                  <Select value={gradeId} onValueChange={setGradeId} required>
                    <SelectTrigger>
                      <SelectValue placeholder="اختر الصف الدراسي" />
                    </SelectTrigger>
                    <SelectContent>
                      {grades.map((gradeItem) => (
                        <SelectItem key={gradeItem.id} value={gradeItem.id}>
                          {gradeItem.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="group">المجموعة (اختياري)</Label>
                  <Select value={selectedGroup} onValueChange={setSelectedGroup}>
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
                  <Label htmlFor="courses">اختر الكورسات المسجلة</Label>
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {courses.map((course) => (
                      <div key={course.id} className="flex items-center space-x-2 space-x-reverse">
                        <Checkbox
                          id={course.id}
                          checked={selectedCourses.includes(course.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedCourses([...selectedCourses, course.id]);
                            } else {
                              setSelectedCourses(selectedCourses.filter(id => id !== course.id));
                            }
                          }}
                        />
                        <Label htmlFor={course.id} className="text-sm font-normal">
                          {course.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
            
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
              <Button 
                type="submit" 
                className="w-full bg-gradient-to-r from-primary via-accent to-primary bg-[length:200%_100%] hover:bg-[position:100%_0] transition-all duration-500 shadow-lg hover:shadow-glow" 
                disabled={loading}
              >
                {loading ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    className="flex items-center gap-2"
                  >
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
                    جاري المعالجة...
                  </motion.div>
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
            </motion.div>
          </form>

        </CardContent>
      </GlassmorphicCard>
      </motion.div>

    </div>
  );
};

export default Auth;