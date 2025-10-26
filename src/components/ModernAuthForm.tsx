import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  GraduationCap, 
  LogIn, 
  UserPlus, 
  Mail, 
  Lock,
  Sparkles,
  ArrowRight
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AuthFormProps {
  isLogin: boolean;
  onToggleMode: () => void;
  onSubmit: (e: React.FormEvent) => void;
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  name?: string;
  setName?: (value: string) => void;
  phone?: string;
  setPhone?: (value: string) => void;
  loading: boolean;
  error: string;
  additionalFields?: React.ReactNode;
}

export const ModernAuthForm = ({
  isLogin,
  onToggleMode,
  onSubmit,
  email,
  setEmail,
  password,
  setPassword,
  name = "",
  setName = () => {},
  phone = "",
  setPhone = () => {},
  loading,
  error,
  additionalFields,
}: AuthFormProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5 }}
      className="w-full max-w-md"
    >
      <Card className="relative overflow-hidden border-primary/20 bg-card/95 backdrop-blur-xl shadow-2xl">
        {/* Animated Background Gradient */}
        <motion.div
          className="absolute inset-0 bg-gradient-to-br from-primary/10 via-accent/10 to-primary/10"
          animate={{
            backgroundPosition: ["0% 0%", "100% 100%", "0% 0%"],
          }}
          transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
          style={{ backgroundSize: "200% 200%" }}
        />

        <CardHeader className="relative z-10 space-y-1 pb-4">
          <motion.div
            className="flex justify-center mb-4"
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
          >
            <div className="p-4 bg-gradient-to-br from-primary to-accent rounded-2xl shadow-glow">
              {isLogin ? (
                <LogIn className="h-12 w-12 text-white" />
              ) : (
                <UserPlus className="h-12 w-12 text-white" />
              )}
            </div>
          </motion.div>

          <CardTitle className="text-3xl font-bold text-center text-foreground">
            {isLogin ? "مرحباً بعودتك" : "انضم إلينا"}
          </CardTitle>
          <p className="text-center text-muted-foreground">
            {isLogin
              ? "سجل دخولك للوصول إلى حسابك"
              : "أنشئ حسابك وابدأ رحلة التعلم"}
          </p>
        </CardHeader>

        <CardContent className="relative z-10">
          <form onSubmit={onSubmit} className="space-y-4">
            {/* Registration Fields */}
            {!isLogin && (
              <>
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-2"
                >
                  <Label htmlFor="name" className="text-right font-semibold">
                    الاسم الكامل
                  </Label>
                  <div className="relative">
                    <GraduationCap className="absolute right-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="أدخل اسمك الكامل"
                      required={!isLogin}
                      className="pr-10 h-12 border-primary/30 focus:border-primary transition-all"
                      dir="rtl"
                    />
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: 0.1 }}
                  className="space-y-2"
                >
                  <Label htmlFor="phone" className="text-right font-semibold">
                    رقم الهاتف
                  </Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="01xxxxxxxxx"
                    required={!isLogin}
                    className="h-12 border-primary/30 focus:border-primary transition-all"
                    dir="ltr"
                  />
                </motion.div>
              </>
            )}

            {/* Email Field */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: isLogin ? 0 : 0.2 }}
              className="space-y-2"
            >
              <Label htmlFor="email" className="text-right font-semibold">
                البريد الإلكتروني
              </Label>
              <div className="relative">
                <Mail className="absolute right-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="example@domain.com"
                  required
                  className="pr-10 h-12 border-primary/30 focus:border-primary transition-all"
                  dir="ltr"
                />
              </div>
            </motion.div>

            {/* Password Field */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: isLogin ? 0.1 : 0.3 }}
              className="space-y-2"
            >
              <Label htmlFor="password" className="text-right font-semibold">
                كلمة المرور
              </Label>
              <div className="relative">
                <Lock className="absolute right-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="pr-10 h-12 border-primary/30 focus:border-primary transition-all"
                />
              </div>
            </motion.div>

            {/* Additional Fields (for registration) */}
            {additionalFields}

            {/* Error Message */}
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm text-center"
              >
                {error}
              </motion.div>
            )}

            {/* Submit Button */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.4 }}
            >
              <Button
                type="submit"
                disabled={loading}
                className={cn(
                  "w-full h-12 text-lg font-bold bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-300",
                  loading && "opacity-50 cursor-not-allowed"
                )}
              >
                {loading ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  >
                    <Sparkles className="h-5 w-5" />
                  </motion.div>
                ) : (
                  <>
                    {isLogin ? "تسجيل الدخول" : "إنشاء حساب"}
                    <ArrowRight className="mr-2 h-5 w-5" />
                  </>
                )}
              </Button>
            </motion.div>
          </form>

          {/* Toggle Mode */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.5 }}
            className="mt-6 text-center"
          >
            <p className="text-sm text-muted-foreground">
              {isLogin ? "ليس لديك حساب؟" : "لديك حساب بالفعل؟"}
            </p>
            <Button
              type="button"
              variant="link"
              onClick={onToggleMode}
              className="text-primary font-semibold hover:underline"
            >
              {isLogin ? "أنشئ حساب جديد" : "سجل دخولك"}
            </Button>
          </motion.div>
        </CardContent>
      </Card>
    </motion.div>
  );
};
