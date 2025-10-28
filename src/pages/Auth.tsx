import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { GraduationCap, LogIn, UserPlus, Sparkles, Lock, Mail, User, Phone as PhoneIcon, BookOpen, Users } from "lucide-react";
import { useNavigate, Link } from "react-router-dom";
import { signIn, signUp, getStudentByPhone, getCourses, getGrades, getGroups, createRegistrationRequest } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import alQaedLogo from "@/assets/Qaad_Logo.png";
import logBackground from "@/assets/Log_Background.jpg";
import mohamedRamadan from "@/assets/Mohamed_Ramadan.png";
import bcrypt from "bcryptjs";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";

const Auth = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(""); // Optional, now for registration only
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
        console.log('🚀 Login attempt started with phone:', phone.trim());

        // Phone-based login
        const result = await signIn(phone.trim(), password);

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
            const student = await getStudentByPhone(phone.trim());

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

        throw new Error("رقم الهاتف أو كلمة المرور غير صحيحة");
      } else {
        // Sign up - Create registration request (not direct user creation)
        if (!name.trim()) {
          throw new Error("يجب إدخال اسم الطالب");
        }
        if (!phone.trim()) {
          throw new Error("يجب إدخال رقم الهاتف");
        }
        if (!gradeId) {
          throw new Error("يجب اختيار الصف الدراسي");
        }

        // Create registration request
        const result = await createRegistrationRequest({
          name: name.trim(),
          phone: phone.trim(),
          password,
          grade_id: gradeId,
          group_id: selectedGroup || null,
          requested_courses: selectedCourses.length > 0 ? selectedCourses : undefined,
        });

        // Clear form
        setPhone("");
        setPassword("");
        setName("");
        setEmail("");
        setGrade("");
        setGradeId("");
        setSelectedCourses([]);
        setSelectedGroup("");

        toast({
          title: "تم إرسال طلب التسجيل بنجاح",
          description: "سيتم مراجعة طلبك من قبل الإدارة وسيتم إخطارك بالقبول",
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
    <div className="min-h-screen relative overflow-hidden" dir="rtl">
      {/* Background Image - Full screen with edge blur */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url(${logBackground})`,
        }}
      />

      {/* Top Navbar */}
      <nav className="absolute -top-4 left-0 right-0 z-50 px-8 py-0">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          {/* Toggle button */}
          <Button 
            onClick={() => setIsLogin(!isLogin)}
            className="bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 text-white px-8 py-2 rounded-lg font-semibold shadow-lg"
          >
            {isLogin ? "إنشاء حساب جديد" : "تسجيل الدخول"}
          </Button>

          {/* Navigation links */}
          <div className="hidden md:flex items-center gap-8 text-white text-lg">
            <a href="#" className="hover:text-yellow-400 transition-colors">الرئيسية</a>
            <a href="#" className="hover:text-yellow-400 transition-colors">النتائج</a>
            <a href="#" className="hover:text-yellow-400 transition-colors">اتصال</a>
            <a href="#" className="hover:text-yellow-400 transition-colors">الدعم</a>
            <a href="#" className="hover:text-yellow-400 transition-colors">اليوميات</a>
          </div>

          {/* Logo on the right */}
          <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity cursor-pointer">
            <img src={alQaedLogo} alt="منصة القائد" className="w-32 h-32 rounded-lg object-cover" />
          </Link>
        </div>
      </nav>

      {/* Edge Blur Overlay - removed for cleaner look */}

      <FloatingParticles />

      {/* Animated Background Elements - removed for cleaner look */}

      {/* Mohamed Ramadan Image - Left Side */}
      <motion.div
        initial={{ opacity: 0, x: -100 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.8, delay: 0.3 }}
        className="hidden lg:block absolute left-0 top-0 bottom-0 z-10 pointer-events-none"
      >
        <div className="relative h-full flex items-center pt-16">
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.5 }}
            whileHover={{ scale: 1.02 }}
          >
            <img
              src={mohamedRamadan}
              alt="الأستاذ محمد رمضان"
              className="h-[95vh] w-auto object-cover"
            />
          </motion.div>
        </div>
      </motion.div>

      {/* Main Content - Form on the right with more spacing */}
      <div className="flex items-center justify-center min-h-screen px-8 lg:px-0 pt-12">
        <motion.div
          initial={{ opacity: 0, x: -50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-lg lg:max-w-xl z-20 lg:fixed lg:right-24"
        >
          {/* Welcome Text - Above form, centered */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="mb-2 text-center mt-16"
          >
            <h1 className="text-6xl font-bold text-white mb-4 leading-tight">
              {isLogin ? "مرحباً أهلاً بعودتك!" : "إنشاء حساب جديد"}
            </h1>
          </motion.div>

          {/* Login/Register Form */}
          <div className="bg-black/50 backdrop-blur-xl rounded-3xl p-10 border border-white/10 shadow-2xl mt-3">
            <form onSubmit={handleAuth} className="space-y-6">
              {/* Name & Phone - Side by side on desktop (for registration) */}
              {!isLogin ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Name Input */}
                  <div className="space-y-2">
                    <Label htmlFor="name" className="text-white text-right block">
                      اسم الطالب
                    </Label>
                    <div className="relative">
                      <User className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <Input
                        id="name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="أدخل اسم الطالب"
                        required
                        className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 pr-12 h-14 rounded-xl text-right"
                      />
                    </div>
                  </div>

                  {/* Phone Input */}
                  <div className="space-y-2">
                    <Label htmlFor="phone" className="text-white text-right block">
                      رقم الهاتف
                    </Label>
                    <div className="relative">
                      <PhoneIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <Input
                        id="phone"
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="01234567890"
                        required
                        className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 pr-12 h-14 rounded-xl text-right"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                /* Phone only for login */
                <div className="space-y-2">
                  <Label htmlFor="phone" className="text-white text-right block">
                    رقم الهاتف
                  </Label>
                  <div className="relative">
                    <PhoneIcon className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="01234567890"
                      required
                      className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 pr-12 h-14 rounded-xl text-right"
                    />
                  </div>
                </div>
              )}

              {/* Email & Password - Side by side on desktop (for registration) */}
              {!isLogin ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Email Input (optional) */}
                  <div className="space-y-2">
                    <Label htmlFor="email" className="text-white text-right block">
                      البريد الإلكتروني (اختياري)
                    </Label>
                    <div className="relative">
                      <Mail className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="example@email.com"
                        className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 pr-12 h-14 rounded-xl text-right"
                      />
                    </div>
                  </div>

                  {/* Password Input */}
                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-white text-right block">
                      كلمة المرور
                    </Label>
                    <div className="relative">
                      <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        required
                        className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 pr-12 h-14 rounded-xl text-right"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                /* Password only for login */
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-white text-right block">
                    كلمة المرور
                  </Label>
                  <div className="relative">
                    <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 pr-12 h-14 rounded-xl text-right"
                    />
                  </div>
                </div>
              )}

              {/* Grade & Group - Side by side on desktop (for registration) */}
              {!isLogin && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Grade Select */}
                  <div className="space-y-2">
                    <Label htmlFor="grade" className="text-white text-right block">
                      الصف الدراسي
                    </Label>
                    <div className="relative">
                      <GraduationCap className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 z-10" />
                      <Select value={gradeId} onValueChange={setGradeId} required>
                        <SelectTrigger className="bg-white/10 border-white/20 text-white pr-12 h-14 rounded-xl text-right">
                          <SelectValue placeholder="اختر الصف الدراسي" />
                        </SelectTrigger>
                        <SelectContent className="bg-gray-900 border-white/20">
                          {grades.map((gradeItem) => (
                            <SelectItem key={gradeItem.id} value={gradeItem.id} className="text-white">
                              {gradeItem.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Group Select */}
                  <div className="space-y-2">
                    <Label htmlFor="group" className="text-white text-right block">
                      المجموعة (اختياري)
                    </Label>
                    <div className="relative">
                      <Users className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 z-10" />
                      <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                        <SelectTrigger className="bg-white/10 border-white/20 text-white pr-12 h-14 rounded-xl text-right">
                          <SelectValue placeholder="اختر المجموعة" />
                        </SelectTrigger>
                        <SelectContent className="bg-gray-900 border-white/20">
                          {groups.map((group) => (
                            <SelectItem key={group.id} value={group.id} className="text-white">
                              {group.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}

              {/* Courses Selection - Only for registration */}
              {!isLogin && (
                <div className="space-y-2">
                  <Label className="text-white text-right block">
                    اختر الكورسات المسجلة
                  </Label>
                  <div className="bg-white/5 rounded-xl p-4 max-h-40 overflow-y-auto space-y-3">
                    {courses.map((course) => (
                      <div key={course.id} className="flex items-center justify-end gap-3">
                        <Label htmlFor={course.id} className="text-white text-sm cursor-pointer">
                          {course.name}
                        </Label>
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
                          className="border-white/30"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Remember me & Forgot password */}
              <div className="flex items-center justify-between text-sm">
                <a href="#" className="text-white hover:text-yellow-400 transition-colors">
                  نسيت كلمة المرور؟
                </a>
                <div className="flex items-center gap-2">
                  <label htmlFor="remember" className="text-white cursor-pointer">
                    تذكر بشكل
                  </label>
                  <Checkbox id="remember" className="border-white/30" />
                </div>
              </div>

              {/* Submit Button */}
              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 text-white h-14 rounded-xl text-lg font-semibold shadow-lg"
              >
                {loading ? "جاري المعالجة..." : (isLogin ? "تسجيل الدخول" : "إنشاء حساب جديد")}
              </Button>

              {/* Divider - Only show for login */}
              {isLogin && (
                <>
                  <div className="relative my-6">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-white/20"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                      <span className="px-4 bg-black/40 text-white">سجل الدخول ب</span>
                    </div>
                  </div>

                  {/* Social Login Buttons */}
                  <div className="grid grid-cols-2 gap-4">
                    <Button
                      type="button"
                      variant="outline"
                      className="bg-white/10 border-white/20 text-white hover:bg-white/20 h-12 rounded-xl"
                    >
                      <svg className="w-5 h-5 ml-2" viewBox="0 0 24 24">
                        <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                        <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                        <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                        <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                      </svg>
                      Google
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="bg-white/10 border-white/20 text-white hover:bg-white/20 h-12 rounded-xl"
                    >
                      <svg className="w-5 h-5 ml-2" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                      </svg>
                      Facebook
                    </Button>
                  </div>
                </>
              )}

              {/* Toggle between login and signup */}
              <div className="text-center text-sm text-white mt-6">
                {isLogin ? (
                  <>
                    لا يوجد حساب بعد؟{" "}
                    <button
                      type="button"
                      onClick={() => setIsLogin(false)}
                      className="text-yellow-400 hover:text-yellow-300 font-semibold"
                    >
                      حساب جديد
                    </button>
                  </>
                ) : (
                  <>
                    لديك حساب بالفعل؟{" "}
                    <button
                      type="button"
                      onClick={() => setIsLogin(true)}
                      className="text-yellow-400 hover:text-yellow-300 font-semibold"
                    >
                      تسجيل الدخول
                    </button>
                  </>
                )}
              </div>

              {error && (
                <Alert variant="destructive" className="mt-4">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </form>
          </div>
        </motion.div>
      </div>

      {/* Old form hidden */}
      <div className="hidden">
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
      </div>

    </div>
  );
};

export default Auth;