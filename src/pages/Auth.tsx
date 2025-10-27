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

    </div>
  );
};

export default Auth;