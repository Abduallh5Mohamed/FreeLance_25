import { Button } from "@/components/ui/button";
import { GraduationCap, BookOpen, Users, Award, ChevronDown, Mail, Phone, MapPin, Facebook, Twitter, Instagram, Youtube, Star, TrendingUp, Target, Zap, Shield, Clock, CheckCircle, Sparkles, Trophy, Rocket } from "lucide-react";
import { useNavigate } from "react-router-dom";
import alQaedLogo from "@/assets/Qaad_Logo.png";
import heroBgImage from "@/assets/Hero-bg.jpg";
import { FloatingParticles } from "@/components/FloatingParticles";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect } from "react";

const Index = () => {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    element?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen dark bg-[#14192a] relative overflow-hidden" dir="rtl">
      {/* Floating Particles Background */}
      <FloatingParticles />
      
      {/* Modern Navbar */}
      <motion.nav
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
          scrolled ? 'bg-[#14192a]/95 backdrop-blur-xl shadow-2xl border-b border-purple-500/20' : 'bg-transparent'
        }`}
      >
        <div className="container mx-auto px-4 md:px-6 lg:px-12">
          <div className="flex items-center justify-between h-20">
            {/* Desktop Navigation - Centered */}
            <div className="hidden md:flex items-center gap-10 flex-1 justify-center">
              <button onClick={() => scrollToSection('hero')} className="text-white/90 hover:text-cyan-400 transition-all duration-300 font-semibold text-lg hover:scale-110">
                الرئيسية
              </button>
              <button onClick={() => scrollToSection('features')} className="text-white/90 hover:text-cyan-400 transition-all duration-300 font-semibold text-lg hover:scale-110">
                المميزات
              </button>
              <button onClick={() => scrollToSection('courses')} className="text-white/90 hover:text-cyan-400 transition-all duration-300 font-semibold text-lg hover:scale-110">
                الدورات
              </button>
              <button onClick={() => scrollToSection('about')} className="text-white/90 hover:text-cyan-400 transition-all duration-300 font-semibold text-lg hover:scale-110">
                من نحن
              </button>
              <button onClick={() => scrollToSection('contact')} className="text-white/90 hover:text-cyan-400 transition-all duration-300 font-semibold text-lg hover:scale-110">
                تواصل معنا
              </button>
            </div>

          </div>
        </div>
      </motion.nav>

      {/* Chat Bot Icon - Bottom Right Corner (Fixed Position) */}
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 1, duration: 0.5 }}
        whileHover={{ scale: 1.15, rotate: 10 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => navigate("/student-chat")}
        className="fixed bottom-8 right-8 bg-gradient-to-r from-yellow-500 to-amber-500 p-4 rounded-full cursor-pointer shadow-2xl hover:shadow-[0_0_30px_rgba(234,179,8,0.7)] transition-all duration-300 z-50 group"
      >
        <svg className="w-8 h-8 text-white group-hover:scale-110 transition-transform duration-300 font-black" fill="currentColor" viewBox="0 0 24 24">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12h-8v-2h8v2zm0-4h-8V8h8v2z"/>
        </svg>
      </motion.div>

      {/* Hero Section with Background Image */}
      <section 
        id="hero"
        className="relative min-h-screen px-4 overflow-hidden bg-no-repeat flex flex-col"
        style={{
          backgroundImage: `url(${heroBgImage})`,
          backgroundAttachment: 'fixed',
          backgroundSize: '100% auto',
          backgroundPosition: 'center 20%'
        }}
      >
        {/* Cinematic dark overlay */}
        <div className="absolute inset-0 cinematic-overlay pointer-events-none" />
        
        {/* Qaad logo - top-left of hero with glow effect */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8 }}
          className="absolute top-0 left-6 md:left-12 lg:left-24 z-30"
        >
          <img src={alQaedLogo} alt="Qa'ad Logo" className="h-24 md:h-28 lg:h-32 object-contain drop-shadow-[0_0_30px_rgba(234,179,8,0.8)]" />
        </motion.div>
        
        {/* Login button - top-right of hero - PREMIUM GRADIENT */}
        <motion.div 
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="absolute top-6 right-6 md:right-12 lg:right-24 z-30"
        >
          <Button
            size="lg"
            onClick={() => navigate("/auth")}
            className="bg-gradient-to-r from-yellow-500 to-amber-500 text-black hover:shadow-[0_0_25px_rgba(234,179,8,0.8)] px-8 py-6 rounded-full font-black text-lg hover:scale-105 transition-all duration-300"
          >
            تسجيل الدخول
          </Button>
        </motion.div>

        {/* Hero Content - ULTRA LUXURIOUS */}
        <div className="flex-1 relative z-20 flex items-center">
          <motion.div
            initial={{ opacity: 0, x: 50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 1, delay: 0.5 }}
            className="absolute top-[22%] right-6 md:right-12 lg:right-24 transform -translate-y-1/2 text-right max-w-[900px]"
          >
            <motion.h2 
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.7 }}
              className="text-7xl md:text-8xl lg:text-9xl font-black mb-8 leading-[1.1] text-white drop-shadow-lg"
            >
              <span className="block bg-gradient-to-b from-[#F6D07A] to-[#E6A445] bg-clip-text text-transparent drop-shadow-[0_0_25px_rgba(240,200,107,0.35)]">نُعلّم</span>
              <span className="block bg-gradient-to-b from-[#B85AE8] to-[#6E2CC9] bg-clip-text text-transparent drop-shadow-[0_0_25px_rgba(110,44,201,0.35)]">بإتقان</span>
            </motion.h2>
            <motion.p 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.9 }}
              className="text-2xl md:text-3xl text-gray-200 mb-12 drop-shadow-2xl font-semibold"
            >
              منصة تعليمية متكاملة لتحقيق التميز الأكاديمي
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 1.1 }}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.95 }}
            >
              <Button 
                size="lg" 
                onClick={() => navigate("/auth")}
                className="text-xl px-12 py-8 bg-gradient-to-r from-yellow-500 to-amber-500 text-black hover:shadow-[0_0_35px_rgba(234,179,8,0.8)] hover:scale-110 transition-all duration-500 font-black rounded-full shadow-2xl"
              >
                ابدأ الآن
              </Button>
            </motion.div>
          </motion.div>
        </div>

        {/* Scroll Indicator - Gradient */}
        <motion.div
          animate={{ y: [0, 15, 0] }}
          transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
          className="absolute bottom-12 left-1/2 transform -translate-x-1/2 z-20"
        >
          <ChevronDown className="w-10 h-10 text-yellow-400 drop-shadow-[0_0_15px_rgba(234,179,8,0.9)]" />
        </motion.div>
      </section>

      {/* Features Section - CLEAN & SIMPLE */}
      <section id="features" className="py-24 px-4 bg-[#14192a] relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-0 right-0 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-0 left-0 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <motion.h2 
              initial={{ opacity: 0, scale: 0.9 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              className="text-5xl md:text-6xl font-black mb-6 bg-gradient-to-r from-purple-400 via-purple-500 to-pink-400 bg-clip-text text-transparent"
            >
              لماذا نحن الخيار الأفضل؟
            </motion.h2>
            <p className="text-xl md:text-2xl text-purple-300 font-medium">
              نقدم تجربة تعليمية فريدة تجمع بين التكنولوجيا والجودة
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-10">
            {[
              {
                icon: BookOpen,
                title: "محتوى تعليمي متميز",
                description: "دروس شاملة ومنظمة بعناية من قبل نخبة من المعلمين"
              },
              {
                icon: Users,
                title: "تفاعل مباشر",
                description: "جلسات مباشرة ودعم فوري من المعلمين والزملاء"
              },
              {
                icon: Award,
                title: "شهادات معتمدة",
                description: "احصل على شهادات معترف بها عند إتمام الدورات"
              }
            ].map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.2, duration: 0.6 }}
                whileHover={{ y: -15, scale: 1.03 }}
                className="bg-[#1a1f30]/60 backdrop-blur-sm p-10 rounded-3xl shadow-2xl hover:shadow-[0_0_30px_rgba(168,85,247,0.3)] transition-all duration-500 border border-purple-500/20 hover:border-purple-400/40 relative group overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <div className="relative z-10">
                  <div className="bg-gradient-to-br from-purple-600 to-purple-500 w-20 h-20 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-purple-500/50">
                    <feature.icon className="w-10 h-10 text-white font-black" />
                  </div>
                  <h3 className="text-3xl font-black mb-4 text-transparent bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text">{feature.title}</h3>
                  <p className="text-white/80 text-lg leading-relaxed">{feature.description}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* About/Stats Section - MOVED UP */}
      <section id="about" className="py-32 px-4 bg-[#14192a] relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/2 left-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <h2 className="text-5xl md:text-6xl font-black mb-6 bg-gradient-to-r from-purple-400 via-pink-500 to-cyan-400 bg-clip-text text-transparent">
              إنجازاتنا بالأرقام
            </h2>
            <p className="text-xl md:text-2xl text-cyan-300 font-medium">
              أرقام تتحدث عن نفسها وتثبت تميزنا
            </p>
          </motion.div>

          <div className="grid md:grid-cols-4 gap-10">
            {[
              { number: "5000+", label: "طالب نشط", icon: Users },
              { number: "150+", label: "دورة تعليمية", icon: BookOpen },
              { number: "50+", label: "معلم متميز", icon: Award },
              { number: "98%", label: "رضا الطلاب", icon: Star }
            ].map((stat, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, scale: 0.5 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.15, type: "spring", stiffness: 200 }}
                whileHover={{ scale: 1.1, y: -10 }}
                className="text-center relative group"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-purple-500/20 to-cyan-500/20 rounded-3xl blur-2xl group-hover:blur-3xl transition-all duration-500"></div>
                <div className="relative bg-[#1a1f30]/60 backdrop-blur-sm p-10 rounded-3xl shadow-2xl border border-purple-500/20 group-hover:border-purple-400/40 transition-all duration-500">
                  <div className="bg-gradient-to-br from-purple-600 to-purple-500 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-purple-500/40 group-hover:shadow-purple-400/50 transition-all duration-500">
                    <stat.icon className="w-10 h-10 text-white font-black" />
                  </div>
                  <div className="text-6xl md:text-7xl font-black bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent mb-3">
                    {stat.number}
                  </div>
                  <div className="text-xl text-gray-300 font-semibold">{stat.label}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Courses Section - PREMIUM */}
      <section id="courses" className="py-24 px-4 bg-[#14192a] relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/2 right-1/4 w-96 h-96 bg-cyan-400/10 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <h2 className="text-5xl md:text-6xl font-black mb-6 bg-gradient-to-r from-purple-400 via-pink-500 to-cyan-400 bg-clip-text text-transparent">
              دوراتنا المميزة
            </h2>
            <p className="text-xl md:text-2xl text-cyan-300 font-medium">
              اختر من مجموعة واسعة من الدورات التعليمية المتخصصة
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-10">
            {[
              { title: "الرياضيات المتقدمة", students: 245, lessons: 48 },
              { title: "اللغة العربية", students: 312, lessons: 36 },
              { title: "العلوم الطبيعية", students: 189, lessons: 42 }
            ].map((course, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.2, duration: 0.6 }}
                whileHover={{ y: -15, scale: 1.05 }}
                className="rounded-3xl overflow-hidden shadow-2xl hover:shadow-[0_0_40px_rgba(168,85,247,0.3)] transition-all duration-500 cursor-pointer border border-purple-500/20 hover:border-purple-400/40 group bg-[#1a1f30]/60 backdrop-blur-sm"
              >
                <div className="h-56 bg-gradient-to-br from-purple-600 via-pink-600 to-cyan-500 relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-[#14192a]/95 to-transparent"></div>
                  <div className="absolute bottom-4 right-4 left-4">
                    <h3 className="text-3xl font-black text-white drop-shadow-lg">{course.title}</h3>
                  </div>
                </div>
                <div className="p-8">
                  <div className="flex items-center justify-between text-white/80 mb-6 text-lg">
                    <span className="flex items-center gap-2 font-semibold">
                      <Users className="w-5 h-5 text-pink-500" />
                      {course.students} طالب
                    </span>
                    <span className="flex items-center gap-2 font-semibold">
                      <BookOpen className="w-5 h-5 text-cyan-400" />
                      {course.lessons} درس
                    </span>
                  </div>
                  <Button className="w-full bg-gradient-to-r from-purple-600 via-pink-600 to-cyan-500 text-white hover:shadow-[0_0_20px_rgba(236,72,153,0.5)] text-lg font-black py-6 rounded-xl transition-all duration-300">
                    تفاصيل الدورة
                  </Button>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
      <section className="py-24 px-4 bg-[#14192a] relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-0 right-1/3 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-cyan-400/10 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <motion.div
              initial={{ rotate: -180, scale: 0 }}
              whileInView={{ rotate: 0, scale: 1 }}
              viewport={{ once: true }}
              transition={{ type: "spring", stiffness: 200 }}
              className="inline-block mb-6"
            >
              <div className="bg-gradient-to-r from-purple-600 to-purple-400 p-4 rounded-full shadow-lg shadow-purple-600/50">
                <Sparkles className="w-14 h-14 text-white font-black" />
              </div>
            </motion.div>
            <h2 className="text-5xl md:text-6xl font-black mb-6 bg-gradient-to-r from-purple-400 via-purple-600 to-purple-400 bg-clip-text text-transparent">
              ماذا يقول طلابنا؟
            </h2>
            <p className="text-xl md:text-2xl text-purple-300 font-medium">
              آراء حقيقية من طلاب حققوا النجاح معنا
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                name: "أحمد محمد",
                role: "طالب ثانوية",
                comment: "منصة رائعة ساعدتني كثيراً في فهم الرياضيات. المعلمون محترفون والشرح واضح جداً!",
                rating: 5,
                image: "👨‍🎓"
              },
              {
                name: "فاطمة علي",
                role: "طالبة جامعية",
                comment: "أفضل تجربة تعليمية مررت بها! الدورات منظمة والمحتوى غني بالمعلومات القيمة.",
                rating: 5,
                image: "👩‍🎓"
              },
              {
                name: "خالد سعيد",
                role: "ولي أمر",
                comment: "شاهدت تحسناً كبيراً في مستوى أبنائي الدراسي. شكراً لكم على جهودكم الرائعة!",
                rating: 5,
                image: "👨‍💼"
              }
            ].map((testimonial, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.2, duration: 0.6 }}
                whileHover={{ y: -15, scale: 1.03 }}
                className="bg-[#1a1f30]/60 backdrop-blur-sm p-10 rounded-3xl shadow-2xl border border-purple-500/20 relative group hover:border-purple-400/40 transition-all duration-500"
              >
                <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-purple-600/40 to-transparent rounded-bl-full"></div>
                <div className="text-7xl mb-6 relative z-10">{testimonial.image}</div>
                <div className="flex gap-2 mb-6">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <Star key={i} className="w-6 h-6 fill-purple-400 text-purple-400 drop-shadow-[0_0_5px_rgba(168,85,247,0.5)]" />
                  ))}
                </div>
                <p className="text-white/90 text-lg mb-8 italic leading-relaxed">"{testimonial.comment}"</p>
                <div>
                  <p className="font-black text-xl text-purple-300 mb-1">{testimonial.name}</p>
                  <p className="text-base text-white/60 font-semibold">{testimonial.role}</p>
                </div>
                <div className="absolute bottom-0 left-0 w-full h-2 bg-gradient-to-r from-purple-600 to-purple-400 transform scale-x-0 group-hover:scale-x-100 transition-transform duration-500 rounded-b-3xl"></div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Why Choose Us - Advanced */}
      <section className="py-20 px-4 bg-[#14192a] relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute bottom-1/2 left-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-4xl md:text-5xl font-black mb-4 bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
              لماذا نحن الأفضل؟
            </h2>
            <p className="text-lg text-purple-300 font-semibold">
              مميزات فريدة تجعلنا الخيار الأول للطلاب
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: Target,
                title: "هدفنا نجاحك",
                description: "نركز على تحقيق أهدافك الدراسية بأحدث الأساليب",
                gradient: "from-purple-600 to-pink-500"
              },
              {
                icon: Zap,
                title: "تعلم سريع وفعال",
                description: "منهجيات حديثة لتسريع عملية الفهم والاستيعاب",
                gradient: "from-purple-400 to-blue-500"
              },
              {
                icon: Shield,
                title: "جودة مضمونة",
                description: "محتوى معتمد ومراجع من قبل خبراء في التعليم",
                gradient: "from-green-400 to-emerald-500"
              },
              {
                icon: Clock,
                title: "متاح 24/7",
                description: "تعلم في أي وقت ومن أي مكان يناسبك",
                gradient: "from-purple-400 to-indigo-500"
              },
              {
                icon: CheckCircle,
                title: "دعم مستمر",
                description: "فريق دعم متواجد دائماً للإجابة على استفساراتك",
                gradient: "from-red-400 to-rose-500"
              },
              {
                icon: TrendingUp,
                title: "تقدم ملحوظ",
                description: "تتبع تقدمك وتحسن مستواك بشكل مستمر",
                gradient: "from-yellow-400 to-orange-500"
              }
            ].map((item, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, scale: 0.8 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                whileHover={{ scale: 1.05, y: -10 }}
                className="relative group"
              >
                <div className={`absolute inset-0 bg-gradient-to-br ${item.gradient} opacity-0 group-hover:opacity-20 transition-opacity duration-300 rounded-2xl blur-xl`}></div>
                <div className="relative bg-[#1a1f30]/60 backdrop-blur-sm p-6 rounded-2xl border border-purple-500/20 group-hover:border-purple-400/40 transition-all shadow-lg">
                  <div className={`bg-gradient-to-br ${item.gradient} w-14 h-14 rounded-xl flex items-center justify-center mb-4 shadow-lg`}>
                    <item.icon className="w-7 h-7 text-white font-black" />
                  </div>
                  <h3 className="text-xl font-black mb-3 text-purple-400">{item.title}</h3>
                  <p className="text-white/80 text-sm leading-relaxed">{item.description}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section - PREMIUM */}
      <section className="py-40 px-4 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-purple-600 via-purple-400 to-purple-600 skew-y-3"></div>
        <div className="absolute inset-0 opacity-20 bg-gradient-to-t from-black to-transparent"></div>
        <div className="container mx-auto max-w-5xl relative z-10 text-center">
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
          >
            <h2 className="text-6xl md:text-7xl lg:text-8xl font-black mb-8 text-white drop-shadow-lg">
              هل أنت مستعد للانطلاق؟
            </h2>
            <p className="text-2xl md:text-3xl mb-14 text-white/90 font-bold">
              انضم لآلاف الطلاب الذين غيروا مستقبلهم معنا!
            </p>
            <div className="flex flex-col sm:flex-row gap-6 justify-center">
              <motion.div whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.92 }}>
                <Button
                  size="lg"
                  onClick={() => navigate("/auth")}
                  className="bg-white text-purple-600 hover:bg-white/90 px-14 py-9 text-2xl font-black rounded-full shadow-2xl"
                >
                  ابدأ الآن
                </Button>
              </motion.div>
              <motion.div whileHover={{ scale: 1.12 }} whileTap={{ scale: 0.92 }}>
                <Button
                  size="lg"
                  onClick={() => scrollToSection('courses')}
                  className="border-4 border-white text-white hover:bg-white/10 px-14 py-9 text-2xl font-black rounded-full bg-transparent"
                >
                  استكشف الدورات
                </Button>
              </motion.div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Partners/Trust Section - PREMIUM */}
      <section className="py-20 px-4 bg-[#14192a] relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/3 right-1/3 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-4xl md:text-5xl font-black mb-4 bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">
              شركاء النجاح
            </h2>
            <p className="text-lg text-purple-300 font-semibold">
              نفخر بشراكتنا مع أفضل المؤسسات التعليمية
            </p>
          </motion.div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {[1, 2, 3, 4].map((_, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, scale: 0.8 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                whileHover={{ scale: 1.1 }}
                className="bg-[#1a1f30]/60 backdrop-blur-sm p-8 rounded-2xl flex items-center justify-center h-32 shadow-md hover:shadow-[0_0_20px_rgba(168,85,247,0.3)] transition-all border border-purple-500/20 hover:border-purple-400/40"
              >
                <div className="text-4xl font-black bg-gradient-to-r from-purple-600 to-purple-400 bg-clip-text text-transparent">
                  Partner {index + 1}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Contact/Footer Section - PREMIUM */}
      <section id="contact" className="py-28 px-4 bg-[#14192a] relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-purple-600/5 to-transparent"></div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <div className="grid md:grid-cols-2 gap-16 mb-20">
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <h2 className="text-5xl md:text-6xl font-black mb-6 bg-gradient-to-r from-purple-400 to-purple-600 bg-clip-text text-transparent">تواصل معنا</h2>
              <p className="text-white/80 text-xl mb-12 font-medium leading-relaxed">
                نحن هنا للإجابة على استفساراتك ومساعدتك في رحلتك التعليمية
              </p>
              <div className="space-y-6">
                <motion.div 
                  whileHover={{ x: 10 }}
                  className="flex items-center gap-5 group"
                >
                  <div className="bg-gradient-to-br from-purple-600 to-purple-400 w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-600/50 group-hover:shadow-purple-400/50 transition-all duration-300">
                    <Mail className="w-8 h-8 text-white font-black" />
                  </div>
                  <div>
                    <p className="font-bold text-purple-300 text-lg mb-1">البريد الإلكتروني</p>
                    <p className="text-white/70 text-lg">info@qaad.edu</p>
                  </div>
                </motion.div>
                <motion.div 
                  whileHover={{ x: 10 }}
                  className="flex items-center gap-5 group"
                >
                  <div className="bg-gradient-to-br from-purple-400 to-purple-600 w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-400/50 group-hover:shadow-purple-600/50 transition-all duration-300">
                    <Phone className="w-8 h-8 text-white font-black" />
                  </div>
                  <div>
                    <p className="font-bold text-purple-300 text-lg mb-1">الهاتف</p>
                    <p className="text-white/70 text-lg">+966 XX XXX XXXX</p>
                  </div>
                </motion.div>
                <motion.div 
                  whileHover={{ x: 10 }}
                  className="flex items-center gap-5 group"
                >
                  <div className="bg-gradient-to-br from-purple-600 to-purple-400 w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-600/50 group-hover:shadow-purple-400/50 transition-all duration-300">
                    <MapPin className="w-8 h-8 text-white font-black" />
                  </div>
                  <div>
                    <p className="font-bold text-purple-300 text-lg mb-1">العنوان</p>
                    <p className="text-white/70 text-lg">الرياض، المملكة العربية السعودية</p>
                  </div>
                </motion.div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
              className="bg-[#1a1f30]/60 backdrop-blur-sm p-10 rounded-3xl shadow-2xl border border-purple-500/20"
            >
              <h3 className="text-3xl font-black mb-8 text-purple-300">أرسل رسالة</h3>
              <form className="space-y-6">
                <input
                  type="text"
                  placeholder="الاسم"
                  className="w-full px-6 py-4 rounded-xl border border-purple-500/20 bg-[#1a1f30]/60 text-white placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-all text-lg"
                />
                <input
                  type="email"
                  placeholder="البريد الإلكتروني"
                  className="w-full px-6 py-4 rounded-xl border border-purple-500/20 bg-[#1a1f30]/60 text-white placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-all text-lg"
                />
                <textarea
                  placeholder="رسالتك"
                  rows={5}
                  className="w-full px-6 py-4 rounded-xl border border-purple-500/20 bg-[#1a1f30]/60 text-white placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-all text-lg resize-none"
                ></textarea>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Button className="w-full bg-gradient-to-r from-purple-600 to-purple-400 text-white hover:shadow-[0_0_20px_rgba(168,85,247,0.5)] py-6 text-xl font-black rounded-xl transition-all duration-300">
                    إرسال الرسالة
                  </Button>
                </motion.div>
              </form>
            </motion.div>
          </div>

          {/* Footer - ULTRA LUXURIOUS */}
          <div className="border-t-2 border-purple-400/20 pt-12 mt-8">
            <div className="flex flex-col md:flex-row items-center justify-between gap-8">
              <div className="flex items-center gap-6">
                <img src={alQaedLogo} alt="Qa'ad Logo" className="h-14 object-contain drop-shadow-[0_0_15px_rgba(168,85,247,0.4)]" />
                <p className="text-white/80 text-lg font-semibold">© 2025 قاعد. جميع الحقوق محفوظة</p>
              </div>
              <div className="flex gap-5">
                {[Facebook, Twitter, Instagram, Youtube].map((Icon, index) => (
                  <motion.div
                    key={index}
                    whileHover={{ scale: 1.25, rotate: 5 }}
                    whileTap={{ scale: 0.9 }}
                    className="bg-gradient-to-br from-purple-600 to-purple-400 w-14 h-14 rounded-xl flex items-center justify-center cursor-pointer shadow-lg shadow-purple-600/50 hover:shadow-purple-400/50 transition-all duration-300"
                  >
                    <Icon className="w-7 h-7 text-white font-black" />
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Index;
