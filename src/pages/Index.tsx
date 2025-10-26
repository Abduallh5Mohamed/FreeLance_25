import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { 
  GraduationCap, 
  Users, 
  BookOpen, 
  Video,
  Crown,
  Star,
  Award,
  Trophy,
  Facebook,
  Youtube,
  Phone,
  Music,
  Sparkles,
  TrendingUp,
  Target,
  Zap
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import alQaedLogo from "@/assets/al-qaed-logo-new.jpg";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Hero3DCard } from "@/components/Hero3DCard";
import { Interactive3DScene } from "@/components/Interactive3DScene";
import { AnimatedSection } from "@/components/AnimatedSection";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { FloatingParticles } from "@/components/FloatingParticles";
import { AnimatedCounter } from "@/components/AnimatedCounter";
import { motion } from "framer-motion";

const Index = () => {
  const navigate = useNavigate();

  const features = [
    {
      icon: Video,
      title: "دروس فيديو حصرية",
      description: "محتوى تعليمي احترافي بأسلوب مشوق وممتع",
      gradient: "from-purple-500 to-pink-500"
    },
    {
      icon: BookOpen,
      title: "مذكرات شاملة",
      description: "ملخصات ومراجعات منظمة لجميع الدروس",
      gradient: "from-blue-500 to-cyan-500"
    },
    {
      icon: Trophy,
      title: "امتحانات إلكترونية",
      description: "تدريب مستمر على نماذج الامتحانات",
      gradient: "from-yellow-500 to-orange-500"
    },
    {
      icon: Users,
      title: "متابعة مستمرة",
      description: "نظام متابعة دقيق لتقدم كل طالب",
      gradient: "from-green-500 to-emerald-500"
    }
  ];

  const stats = [
    { value: 5000, suffix: "+", label: "طالب متفوق", icon: Users },
    { value: 98, suffix: "%", label: "نسبة النجاح", icon: TrendingUp },
    { value: 150, suffix: "+", label: "درس تفاعلي", icon: BookOpen },
    { value: 50, suffix: "+", label: "معلم محترف", icon: Award },
  ];

  const testimonials = [
    {
      name: "أحمد محمود",
      role: "طالب ثانوية عامة",
      rating: 5,
      text: "شرح الأستاذ محمد ممتاز ومبسط، حصلت على درجة نهائية في التاريخ والجغرافيا"
    },
    {
      name: "فاطمة علي",
      role: "طالبة صف ثاني ثانوي", 
      rating: 5,
      text: "الدروس التفاعلية والامتحانات الإلكترونية ساعدتني كثيراً في الفهم والحفظ"
    },
    {
      name: "محمد حسن",
      role: "طالب صف أول ثانوي",
      rating: 5,
      text: "أسلوب التدريس احترافي والمنصة سهلة الاستخدام، أنصح بها بشدة"
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-secondary relative overflow-hidden" dir="rtl">
      {/* Floating Particles Background */}
      <FloatingParticles />
      
      {/* Header */}
      <motion.header 
        initial={{ y: -100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="border-b border-primary/20 bg-card/95 backdrop-blur-xl sticky top-0 z-50 shadow-glow"
      >
        <div className="container mx-auto px-3 md:px-4 lg:px-6 py-4 flex flex-col sm:flex-row justify-between items-center gap-3">
          <motion.div 
            className="flex items-center gap-3"
            whileHover={{ scale: 1.05 }}
            transition={{ type: "spring", stiffness: 300 }}
          >
            <img 
              src={alQaedLogo}
              alt="منصة القائد" 
              className="h-14 w-14 rounded-full object-cover border-2 border-primary shadow-golden"
            />
            <div>
              <h1 className="text-2xl font-bold text-primary bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                منصة القائد
              </h1>
              <p className="text-sm text-muted-foreground">تاريخ وجغرافيا</p>
            </div>
          </motion.div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Button 
                onClick={() => navigate("/auth")} 
                className="bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-300 font-bold"
              >
                <Sparkles className="ml-2 h-4 w-4" />
                تسجيل الدخول
              </Button>
            </motion.div>
          </div>
        </div>
      </motion.header>

      {/* Hero Section with 3D Card */}
      <Hero3DCard />

      {/* Stats Section */}
      <AnimatedSection className="py-16 px-4 relative z-10">
        <div className="container mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {stats.map((stat, index) => (
              <GlassmorphicCard key={index} delay={index * 0.1} className="p-6 text-center">
                <stat.icon className="h-12 w-12 mx-auto mb-4 text-primary" />
                <div className="text-4xl font-bold text-primary mb-2">
                  <AnimatedCounter to={stat.value} suffix={stat.suffix} />
                </div>
                <div className="text-sm text-muted-foreground font-semibold">{stat.label}</div>
              </GlassmorphicCard>
            ))}
          </div>
        </div>
      </AnimatedSection>

      {/* Interactive 3D Scene */}
      <AnimatedSection className="py-16 px-4 relative z-10">
        <div className="container mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
          >
            <h3 className="text-4xl md:text-5xl font-bold text-center mb-4 text-foreground">
              استكشف منصتنا
            </h3>
            <h4 className="text-2xl md:text-3xl font-bold text-center mb-8 text-primary flex items-center justify-center gap-2">
              <Sparkles className="h-8 w-8" />
              في عالم ثلاثي الأبعاد تفاعلي
              <Sparkles className="h-8 w-8" />
            </h4>
          </motion.div>
          <Interactive3DScene />
          <motion.div 
            className="text-center mt-8"
            initial={{ opacity: 0, scale: 0.8 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.3 }}
          >
            <Button 
              onClick={() => navigate("/promo")}
              size="lg"
              className="bg-gradient-to-r from-primary via-accent to-primary hover:shadow-glow transition-all duration-300 font-bold text-lg px-10 py-7 rounded-full animate-pulse hover:animate-none"
            >
              <Video className="ml-2 h-6 w-6" />
              شاهد الفيديو الترويجي
              <Zap className="mr-2 h-6 w-6" />
            </Button>
          </motion.div>
        </div>
      </AnimatedSection>

      {/* Features */}
      <AnimatedSection className="py-24 px-4 bg-gradient-to-b from-card to-background relative z-10">
        <div className="container mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
          >
            <h3 className="text-4xl md:text-5xl font-bold text-center mb-4 text-foreground">
              لماذا تختار
            </h3>
            <h4 className="text-3xl md:text-4xl font-bold text-center mb-16 text-primary">
              منصة القائد؟
            </h4>
          </motion.div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 50 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                whileHover={{ y: -10, scale: 1.02 }}
              >
                <Card className="text-center h-full border-primary/20 bg-gradient-to-br from-card/50 to-card backdrop-blur-sm hover:shadow-2xl hover:shadow-primary/20 transition-all duration-500 group relative overflow-hidden">
                  <div className={`absolute inset-0 bg-gradient-to-br ${feature.gradient} opacity-0 group-hover:opacity-10 transition-opacity duration-500`} />
                  <CardContent className="pt-8 pb-6 relative z-10">
                    <motion.div 
                      className="mb-6 flex justify-center"
                      whileHover={{ rotate: 360, scale: 1.2 }}
                      transition={{ duration: 0.6 }}
                    >
                      <div className={`p-5 bg-gradient-to-br ${feature.gradient} rounded-2xl shadow-lg`}>
                        <feature.icon className="h-12 w-12 text-white" />
                      </div>
                    </motion.div>
                    <h4 className="font-bold text-xl mb-3 text-foreground">{feature.title}</h4>
                    <p className="text-muted-foreground text-sm leading-relaxed">{feature.description}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </AnimatedSection>

      {/* Testimonials */}
      <AnimatedSection className="py-24 px-4 bg-gradient-to-b from-background to-card relative z-10">
        <div className="container mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
          >
            <h3 className="text-4xl font-bold text-center mb-4 text-foreground">
              آراء
            </h3>
            <h4 className="text-3xl font-bold text-center mb-16 text-primary">
              طلابنا المتميزين
            </h4>
          </motion.div>
          <div className="grid md:grid-cols-3 gap-8">
            {testimonials.map((testimonial, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.15 }}
                whileHover={{ y: -10, scale: 1.02 }}
              >
                <GlassmorphicCard className="h-full">
                  <CardContent className="pt-8 pb-6">
                    <div className="flex items-center gap-1 mb-6 justify-center">
                      {[...Array(testimonial.rating)].map((_, i) => (
                        <motion.div
                          key={i}
                          initial={{ opacity: 0, scale: 0 }}
                          whileInView={{ opacity: 1, scale: 1 }}
                          transition={{ delay: index * 0.15 + i * 0.1 }}
                        >
                          <Star className="h-6 w-6 fill-yellow-500 text-yellow-500" />
                        </motion.div>
                      ))}
                    </div>
                    <p className="text-muted-foreground mb-6 italic text-center leading-relaxed text-lg">
                      "{testimonial.text}"
                    </p>
                    <div className="flex items-center gap-4 justify-center">
                      <div className="w-14 h-14 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center border-2 border-primary/40 shadow-glow">
                        <Users className="h-7 w-7 text-white" />
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-foreground text-lg">{testimonial.name}</p>
                        <p className="text-sm text-primary font-semibold">{testimonial.role}</p>
                      </div>
                    </div>
                  </CardContent>
                </GlassmorphicCard>
              </motion.div>
            ))}
          </div>
        </div>
      </AnimatedSection>

      {/* CTA Section */}
      <motion.section 
        className="relative py-32 px-4 overflow-hidden z-10"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 1 }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-primary/20 via-accent/20 to-primary/20">
          <motion.div
            className="absolute inset-0"
            animate={{
              background: [
                "linear-gradient(90deg, rgba(255,215,0,0.2) 0%, rgba(255,193,7,0.2) 100%)",
                "linear-gradient(180deg, rgba(255,193,7,0.2) 0%, rgba(255,215,0,0.2) 100%)",
                "linear-gradient(270deg, rgba(255,215,0,0.2) 0%, rgba(255,193,7,0.2) 100%)",
                "linear-gradient(360deg, rgba(255,193,7,0.2) 0%, rgba(255,215,0,0.2) 100%)",
              ]
            }}
            transition={{ duration: 8, repeat: Infinity }}
          />
        </div>
        <div className="container mx-auto text-center max-w-4xl relative z-10">
          <motion.div
            initial={{ scale: 0 }}
            whileInView={{ scale: 1 }}
            viewport={{ once: true }}
            transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
          >
            <Award className="w-32 h-32 text-primary mx-auto mb-8 drop-shadow-2xl" />
          </motion.div>
          <motion.h3 
            className="text-5xl md:text-7xl font-bold mb-6 text-foreground"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.3 }}
          >
            جاهز للتميز؟
          </motion.h3>
          <motion.p 
            className="text-2xl text-muted-foreground mb-12 leading-relaxed"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.4 }}
          >
            انضم إلى آلاف الطلاب المتفوقين الذين حققوا أعلى الدرجات معنا
            <br />
            <span className="text-primary font-bold text-3xl block mt-4">
              ابدأ رحلتك نحو التفوق الآن! 🚀
            </span>
          </motion.p>
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.5 }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
          >
            <Button 
              size="lg" 
              onClick={() => navigate("/auth")}
              className="text-2xl px-20 py-12 bg-gradient-to-r from-primary via-accent to-primary hover:shadow-glow transition-all duration-500 font-extrabold rounded-full shadow-2xl animate-pulse hover:animate-none"
            >
              <Crown className="ml-3 h-9 w-9" />
              سجل الآن مجاناً
              <Sparkles className="mr-3 h-9 w-9" />
            </Button>
          </motion.div>
        </div>
      </motion.section>

      {/* Footer */}
      <footer className="bg-card border-t border-primary/20 py-12 px-4 relative z-10">
        <div className="container mx-auto text-center">
          <motion.div 
            className="flex items-center justify-center gap-3 mb-6"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
          >
            <img 
              src={alQaedLogo}
              alt="منصة القائد" 
              className="h-16 w-16 rounded-full object-cover border-2 border-primary shadow-golden"
            />
            <div>
              <h2 className="text-2xl font-bold text-primary">منصة القائد</h2>
              <p className="text-sm text-muted-foreground">تاريخ وجغرافيا للثانوية العامة</p>
            </div>
          </motion.div>
          
          {/* Social Media Links */}
          <motion.div 
            className="mb-8"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <h3 className="text-lg font-bold text-foreground mb-4">تواصل معنا</h3>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <motion.a 
                href="https://www.facebook.com/share/1DkCgcmuQr/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-4 bg-gradient-to-br from-blue-500/20 to-blue-600/20 rounded-full hover:from-blue-500/40 hover:to-blue-600/40 transition-all duration-300 shadow-lg"
                whileHover={{ scale: 1.2, rotate: 360 }}
                transition={{ type: "spring", stiffness: 300 }}
              >
                <Facebook className="h-6 w-6 text-blue-500" />
              </motion.a>
              
              <motion.a 
                href="https://youtube.com/@moramadan96-history?si=2Ae7CgmA3u2PIkmF" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-4 bg-gradient-to-br from-red-500/20 to-red-600/20 rounded-full hover:from-red-500/40 hover:to-red-600/40 transition-all duration-300 shadow-lg"
                whileHover={{ scale: 1.2, rotate: 360 }}
                transition={{ type: "spring", stiffness: 300 }}
              >
                <Youtube className="h-6 w-6 text-red-500" />
              </motion.a>
              
              <motion.a 
                href="https://www.tiktok.com/@mohamed_ramadan_96?_t=ZS-90fb2EGlSvE&_r=1" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-4 bg-gradient-to-br from-pink-500/20 to-purple-600/20 rounded-full hover:from-pink-500/40 hover:to-purple-600/40 transition-all duration-300 shadow-lg"
                whileHover={{ scale: 1.2, rotate: 360 }}
                transition={{ type: "spring", stiffness: 300 }}
              >
                <Music className="h-6 w-6 text-pink-500" />
              </motion.a>
            </div>
            
            <div className="flex items-center justify-center gap-6 mt-6 flex-wrap">
              <motion.a 
                href="tel:01034067686"
                className="group flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors duration-300"
                whileHover={{ scale: 1.1 }}
              >
                <Phone className="h-5 w-5 group-hover:animate-bounce" />
                <span className="font-semibold" dir="ltr">01034067686</span>
              </motion.a>
              
              <motion.a 
                href="tel:01024083057"
                className="group flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors duration-300"
                whileHover={{ scale: 1.1 }}
              >
                <Phone className="h-5 w-5 group-hover:animate-bounce" />
                <span className="font-semibold" dir="ltr">01024083057</span>
              </motion.a>
            </div>
          </motion.div>
          
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.4 }}
          >
            <p className="text-muted-foreground mb-2">
              © 2024 منصة القائد. جميع الحقوق محفوظة.
            </p>
            <p className="text-sm text-primary font-semibold">
              نحو التميز والتفوق في التاريخ والجغرافيا 🏆
            </p>
          </motion.div>
        </div>
      </footer>
    </div>
  );
};

export default Index;
