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
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/components/ui/use-toast";
import alQaedLogo from "@/assets/al-qaed-logo-new.jpg";
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
  const [courses, setCourses] = useState<any[]>([]);
  const [grades, setGrades] = useState<any[]>([]);
  const [groups, setGroups] = useState<any[]>([]);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchCourses();
    fetchGrades();
    fetchGroups();
  }, []);

  const fetchGroups = async () => {
    try {
      const { data, error } = await supabase
        .from('groups')
        .select('*')
        .eq('is_active', true);
      
      if (error) throw error;
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const fetchGrades = async () => {
    try {
      const { data, error } = await supabase
        .from('grades')
        .select('*')
        .eq('is_active', true);
      
      if (error) throw error;
      setGrades(data || []);
    } catch (error) {
      console.error('Error fetching grades:', error);
    }
  };

  const fetchCourses = async () => {
    try {
      const { data, error } = await supabase
        .from('courses')
        .select('*')
        .eq('is_active', true);
      
      if (error) throw error;
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
        
        // First, check if this is an offline student trying to login
        const { data: offlineStudent, error: offlineError } = await supabase
          .from('students')
          .select('*')
          .eq('email', email.toLowerCase().trim())
          .eq('is_offline', true)
          .eq('approval_status', 'approved')
          .maybeSingle();

        console.log('🔍 Offline student check:', { 
          found: !!offlineStudent, 
          error: offlineError, 
          email: email.toLowerCase().trim(),
          studentData: offlineStudent,
          hasPasswordHash: !!offlineStudent?.password_hash
        });

        if (!offlineError && offlineStudent) {
          console.log('🔍 Found offline student:', { 
            name: offlineStudent.name, 
            email: offlineStudent.email,
            hasPasswordHash: !!offlineStudent.password_hash 
          });
          
          // Check if password_hash exists
          if (!offlineStudent.password_hash) {
            throw new Error("لم يتم تعيين كلمة مرور لهذا الحساب. يرجى الاتصال بالإدارة لإعادة تعيين كلمة المرور.");
          }
          
          console.log('🔐 Starting password verification...');
          
          // Use bcrypt.compare (async) instead of compareSync
          const isPasswordValid = await bcrypt.compare(password, offlineStudent.password_hash);
          console.log('✅ Password verification result:', isPasswordValid);
          
          if (isPasswordValid) {
            // Store offline student session in localStorage
            const offlineSession = {
              student: {
                id: offlineStudent.id,
                name: offlineStudent.name,
                email: offlineStudent.email,
                grade_id: offlineStudent.grade_id,
                group_id: offlineStudent.group_id,
                phone: offlineStudent.phone,
                grade: offlineStudent.grade,
                is_offline: true
              },
              timestamp: new Date().getTime()
            };
            localStorage.setItem('offlineStudentSession', JSON.stringify(offlineSession));
            
            navigate("/student");
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${offlineStudent.name}`,
            });
            return;
          } else {
            throw new Error("كلمة المرور غير صحيحة");
          }
        }

        // Try Supabase Auth login for online students and admins
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        
        if (!error && data.user) {
          // Check user role to determine where to redirect
          const { data: userRoles } = await supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', data.user.id);
          
          // Check if user is admin
          const isAdmin = userRoles?.some(r => r.role === 'admin');
          
          if (isAdmin) {
            // Admin login
            const { data: profile } = await supabase
              .from('profiles')
              .select('name')
              .eq('user_id', data.user.id)
              .maybeSingle();
            
            navigate("/teacher");
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${profile?.name || 'الأستاذ'}`,
            });
            return;
          }
          
          // Online student login - get student data
          const { data: student } = await supabase
            .from('students')
            .select('*')
            .eq('email', email)
            .eq('is_offline', false)
            .eq('approval_status', 'approved')
            .maybeSingle();
          
          if (student) {
            navigate("/student");
            toast({
              title: "تم تسجيل الدخول بنجاح",
              description: `مرحباً بك ${student.name}`,
            });
            return;
          } else {
            throw new Error("حسابك في انتظار الموافقة من الإدارة");
          }
        }

        // If all fails, show error
        throw new Error("البريد الإلكتروني أو كلمة المرور غير صحيحة");
      } else {
        // Sign up - Create registration request instead of direct account
        if (!name.trim()) {
          throw new Error("يجب إدخال اسم الطالب");
        }
        if (!phone.trim()) {
          throw new Error("يجب إدخال رقم الهاتف");
        }
        if (!gradeId) {
          throw new Error("يجب اختيار الصف الدراسي");
        }

        // Hash password for storage
        const passwordHash = await bcrypt.hash(password, 10);

        // Create registration request
        const { error: requestError } = await supabase
          .from("student_registration_requests")
          .insert({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            phone: phone.trim(),
            grade_id: gradeId || null,
            group_id: selectedGroup || null,
            password_hash: passwordHash,
            requested_courses: selectedCourses,
            status: 'pending'
          });

        if (requestError) {
          if (requestError.code === '23505') {
            throw new Error("البريد الإلكتروني مستخدم بالفعل");
          }
          throw requestError;
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
          title: "تم إرسال طلب التسجيل",
          description: "تم إرسال طلبك بنجاح. سيتم مراجعته والموافقة عليه من قبل الإدارة قريباً. ستتمكن من تسجيل الدخول بعد الموافقة.",
        });
        
        setIsLogin(true); // Switch back to login view
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
    <div className="min-h-screen bg-gradient-to-br from-blue-600 via-purple-600 to-pink-600 flex items-center justify-center p-3 md:p-4 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      
      {/* Animated Background Elements */}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div
          animate={{
            scale: [1, 1.2, 1],
            rotate: [0, 180, 360],
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          className="absolute -top-1/2 -right-1/2 w-full h-full bg-gradient-to-br from-yellow-400/20 to-orange-500/20 rounded-full blur-3xl"
        />
        <motion.div
          animate={{
            scale: [1.2, 1, 1.2],
            rotate: [360, 180, 0],
          }}
          transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
          className="absolute -bottom-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-cyan-400/20 to-blue-500/20 rounded-full blur-3xl"
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative z-10"
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