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
import { signIn, signUp, getStudentByPhone, getCourses, getGrades, getGroups, createRegistrationRequest, getStudents } from "@/lib/api";
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
  const [guardianPhone, setGuardianPhone] = useState(""); // رقم ولي الأمر
  const [grade, setGrade] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [selectedCourses, setSelectedCourses] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [courses, setCourses] = useState<Array<{ id: string; name: string; grade?: string }>>([]);
  const [grades, setGrades] = useState<Array<{ id: string; name: string }>>([]);
  const [groups, setGroups] = useState<Array<{ id: string; name: string; grade_id?: string }>>([]);
  const [studentType, setStudentType] = useState<"online" | "offline">("online");
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
      console.log('📦 Fetched groups:', data);
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const fetchGrades = async () => {
    try {
      const data = await getGrades();
      console.log('🎓 Fetched grades:', data);
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchCourses = async () => {
    try {
      const data = await getCourses();
      console.log('📚 Fetched courses:', data);
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
          console.log('✅ Login successful, user:', result.user);

          // Store user session in localStorage
          localStorage.setItem('currentUser', JSON.stringify(result.user));
          console.log('✅ User stored in localStorage');

          // Redirect based on role
          if (result.user.role === 'admin' || result.user.role === 'teacher') {
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${result.user.name}`,
            });
            console.log('✅ Navigating to /teacher...');
            // Small delay to ensure localStorage is updated before navigation
            setTimeout(() => {
              navigate("/teacher");
            }, 300);
          } else {
            // Student login - check if student exists
            const student = await getStudentByPhone(phone.trim());

            if (student && student.approval_status === 'approved') {
              localStorage.setItem('currentStudent', JSON.stringify(student));
              console.log('✅ Student stored in localStorage');
              toast({
                title: "تم تسجيل الدخول بنجاح",
                description: `مرحباً بك ${student.name}`,
              });
              console.log('✅ Navigating to /student...');
              // Small delay to ensure localStorage is updated before navigation
              setTimeout(() => {
                navigate("/student");
              }, 300);
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
        if (!guardianPhone.trim()) {
          throw new Error("يجب إدخال رقم ولي الأمر");
        }

        // Client-side duplicate checks (students list)
        try {
          const allStudents = await getStudents();
          if (allStudents.some(s => s.phone === phone.trim())) {
            throw new Error('رقم الهاتف مسجل بالفعل');
          }
          if (allStudents.some(s => s.guardian_phone === guardianPhone.trim())) {
            throw new Error('رقم ولي الأمر مستخدم مع طالب آخر');
          }
        } catch (dupErr) {
          // If fetching students fails, continue; server will still validate
          if (dupErr instanceof Error && dupErr.message.includes('رقم')) {
            throw dupErr; // rethrow duplicate error
          }
        }

        // Create registration request with student type
        const result = await createRegistrationRequest({
          name: name.trim(),
          phone: phone.trim(),
          password,
          guardian_phone: guardianPhone.trim(), // رقم ولي الأمر
          grade_id: gradeId,
          group_id: selectedGroup || null,
          requested_courses: selectedCourses.length > 0 ? selectedCourses : undefined,
          is_offline: studentType === "offline",
        });

        // Clear form
        setPhone("");
        setPassword("");
        setName("");
        setEmail("");
        setGuardianPhone(""); // Clear guardian phone
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
          <div className={`bg-black/50 backdrop-blur-xl rounded-3xl border border-white/10 shadow-2xl mt-3 ${isLogin ? 'p-10' : 'p-6'}`}>
            <form onSubmit={handleAuth} className={isLogin ? 'space-y-6' : 'space-y-5'}>
              {/* Name & Phone - Side by side on desktop (for registration) */}
              {!isLogin ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Name Input */}
                  <div className="space-y-1.5">
                    <Label htmlFor="name" className="text-white text-right block text-sm">
                      اسم الطالب
                    </Label>
                    <div className="relative">
                      <Input
                        id="name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="أدخل اسم الطالب"
                        required
                        className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 h-11 rounded-xl text-right"
                      />
                    </div>
                  </div>

                  {/* Phone Input */}
                  <div className="space-y-1.5">
                    <Label htmlFor="phone" className="text-white text-right block text-sm">
                      رقم الهاتف
                    </Label>
                    <div className="relative">
                      <Input
                        id="phone"
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="01234567890"
                        required
                        className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 h-11 rounded-xl text-right"
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
                    <Input
                      id="phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="01234567890"
                      required
                      className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 h-14 rounded-xl text-right"
                    />
                  </div>
                </div>
              )}

              {/* Password & Grade - 2 fields side by side on desktop (for registration) */}
              {!isLogin ? (
                <>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {/* Password Input */}
                    <div className="space-y-1.5">
                      <Label htmlFor="password-register" className="text-white text-right block text-sm">
                        كلمة المرور
                      </Label>
                      <div className="relative">
                        <Input
                          id="password-register"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          required
                          className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 h-11 rounded-xl text-right"
                        />
                      </div>
                    </div>

                    {/* Grade Select */}
                    <div className="space-y-1.5">
                      <Label htmlFor="grade" className="text-white text-right block text-sm">
                        الصف الدراسي
                      </Label>
                      <div className="relative">
                        <Select value={gradeId} onValueChange={(value) => {
                          console.log('✅ Selected grade:', value);
                          console.log('📋 All groups:', groups);
                          const filtered = groups.filter(g => g.grade_id === value);
                          console.log('📋 Filtered groups for grade:', filtered);
                          setGradeId(value);
                          setSelectedGroup(''); // Reset group when grade changes
                          setSelectedCourses([]); // Reset courses when grade changes
                        }} required>
                          <SelectTrigger className="bg-white/10 border-white/20 text-white h-11 rounded-xl text-right">
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
                  </div>

                  {/* Guardian Phone - Full width */}
                  <div className="space-y-1.5">
                    <Label htmlFor="guardianPhone" className="text-white text-right block text-sm">
                      رقم هاتف ولي الأمر
                    </Label>
                    <div className="relative">
                      <Input
                        id="guardianPhone"
                        type="tel"
                        value={guardianPhone}
                        onChange={(e) => setGuardianPhone(e.target.value)}
                        placeholder="01234567890"
                        required
                        className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 h-11 rounded-xl text-right"
                      />
                    </div>
                  </div>
                </>
              ) : (
                /* Password only for login */
                <div className="space-y-2">
                  <Label htmlFor="password-login" className="text-white text-right block">
                    كلمة المرور
                  </Label>
                  <div className="relative">
                    <Input
                      id="password-login"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className="bg-white/10 border-white/20 text-white placeholder:text-gray-400 h-14 rounded-xl text-right"
                    />
                  </div>
                </div>
              )}

              {/* Student Type & Group - Side by side (for registration) */}
              {!isLogin && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Student Type Select */}
                  <div className="space-y-1.5">
                    <Label htmlFor="studentType" className="text-white text-right block text-sm">
                      نوع الطالب
                    </Label>
                    <div className="relative">
                      <Select
                        value={studentType}
                        onValueChange={(value: "online" | "offline") => setStudentType(value)}
                        required
                      >
                        <SelectTrigger className="bg-white/10 border-white/20 text-white h-11 rounded-xl text-right">
                          <SelectValue placeholder="اختر نوع الطالب" />
                        </SelectTrigger>
                        <SelectContent className="bg-gray-900 border-white/20">
                          <SelectItem value="online" className="text-white">أونلاين</SelectItem>
                          <SelectItem value="offline" className="text-white">أوفلاين</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Group Select */}
                  <div className="space-y-1.5">
                    <Label htmlFor="group" className="text-white text-right block text-sm">
                      المجموعة
                    </Label>
                    <div className="relative">
                      <Select
                        value={selectedGroup}
                        onValueChange={setSelectedGroup}
                        required
                        disabled={!gradeId}
                      >
                        <SelectTrigger className="bg-white/10 border-white/20 text-white h-11 rounded-xl text-right">
                          <SelectValue placeholder={gradeId ? "اختر المجموعة" : "اختر الصف أولاً"} />
                        </SelectTrigger>
                        <SelectContent className="bg-gray-900 border-white/20">
                          {groups
                            .filter(g => !gradeId || g.grade_id === gradeId)
                            .map((group) => (
                              <SelectItem key={group.id} value={group.id} className="text-white">
                                {group.name}
                              </SelectItem>
                            ))}
                          {gradeId && groups.filter(g => g.grade_id === gradeId).length === 0 && (
                            <div className="p-2 text-sm text-gray-400 text-center">
                              لا توجد مجموعات لهذا الصف
                            </div>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}

              {/* Courses Selection - Only for registration, filtered by grade */}
              {!isLogin && (
                <div className="space-y-1.5">
                  <Label className="text-white text-right block text-sm">
                    اختر الكورسات المسجلة
                  </Label>
                  <div className="bg-white/5 rounded-xl p-3 max-h-32 overflow-y-auto space-y-2">
                    {gradeId ? (
                      <>
                        {courses
                          .filter(course => {
                            const selectedGrade = grades.find(g => g.id === gradeId);
                            const gradeName = selectedGrade?.name;
                            console.log('🔍 Course:', course.name, '| Course Grade:', course.grade, '| Selected Grade Name:', gradeName, '| Match:', course.grade === gradeName);
                            return course.grade === gradeName;
                          })
                          .map((course) => (
                          <div key={course.id} className="flex items-center justify-end gap-2">
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
                        {(() => {
                          const selectedGrade = grades.find(g => g.id === gradeId);
                          const gradeName = selectedGrade?.name;
                          return courses.filter(c => c.grade === gradeName).length === 0;
                        })() && (
                          <div className="p-2 text-sm text-gray-400 text-center">
                            لا توجد كورسات لهذا الصف
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="p-2 text-sm text-gray-400 text-center">
                        اختر الصف الدراسي أولاً
                      </div>
                    )}
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
                className={`w-full bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-600 hover:to-orange-600 text-white rounded-xl font-semibold shadow-lg ${isLogin ? 'h-14 text-lg' : 'h-11 text-base'}`}
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
                    <Select
                      value={selectedGroup}
                      onValueChange={setSelectedGroup}
                      disabled={!gradeId}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={gradeId ? "اختر المجموعة" : "اختر الصف أولاً"} />
                      </SelectTrigger>
                      <SelectContent>
                        {groups
                          .filter(g => !gradeId || g.grade_id === gradeId)
                          .map((group) => (
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