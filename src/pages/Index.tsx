import { Button } from "@/components/ui/button";
import { GraduationCap, BookOpen, Users, Award, ChevronDown, Mail, Phone, MapPin, Facebook, Twitter, Instagram, Youtube, Star, TrendingUp, Target, Zap, Shield, Clock, CheckCircle, Sparkles, Trophy, Rocket, X, Music } from "lucide-react";
import { useNavigate } from "react-router-dom";
import alQaedLogo from "@/assets/Hero_Logo.png";
import heroBgImage from "@/assets/Hero-bg.jpg";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo } from "react";

type HeroOrb = {
  size: number;
  top: string;
  left: string;
  gradient: string;
  blurClass: string;
  duration: number;
  delay: number;
  animate: {
    x: number[];
    y: number[];
    scale: number[];
    opacity: number[];
    rotate: number[];
  };
};

const Index = () => {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [quickMessage, setQuickMessage] = useState("");
  const [chatHistory, setChatHistory] = useState<{ id: string; text: string; sender: "user" | "assistant" }[]>([]);
  const [isSendingQuickMessage, setIsSendingQuickMessage] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const toggleChat = () => setIsChatOpen((previous) => !previous);

  const openFullChat = () => {
    setIsChatOpen(false);
    navigate("/student-chat");
  };

  const sendQuickMessage = async () => {
    const trimmed = quickMessage.trim();
    if (!trimmed || isSendingQuickMessage) {
      return;
    }

    const userEntry = { id: `user-${Date.now()}`, text: trimmed, sender: "user" } as const;
    setChatHistory((previous) => [...previous, userEntry]);
    setQuickMessage("");
    setIsSendingQuickMessage(true);

    try {
      // Call the same AI endpoint used in the dedicated chat assistant
      const googleApiKey = "AIzaSyAm-hpg9pjc66DqNnS8qHpdgeKBd-FZP70";
      const systemPrompt = `أنت مساعد ذكي تعليمي متخصص حصراً في مساعدة طلاب المرحلة الثانوية المصريين في دراسة التاريخ.

وظيفتك الأساسية:
- شرح الأحداث التاريخية والشخصيات والفترات بوضوح ودقة
- مساعدة الطلاب على فهم دروس المنهج المصري للتاريخ
- تقديم ملخصات وتحليلات ومقارنات للأحداث التاريخية
- الإجابة على أسئلة من نمط الامتحانات
- مساعدة الطالب على كتابة الإجابات الطويلة

رد دائماً بالعربية فقط، وكن ودوداً وصبوراً - بدو كمعلم مختص وليس روبوت.`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
            contents: [
              {
                role: "user",
                parts: [{ text: trimmed }],
              },
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 600,
              topK: 40,
              topP: 0.95,
            },
          }),
        }
      );

      const data = await response.json();

      if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const assistantMessage = data.candidates[0].content.parts[0].text.trim();
        const assistantEntry = {
          id: `assistant-${Date.now()}`,
          text: assistantMessage,
          sender: "assistant" as const,
        };
        setChatHistory((previous) => [...previous, assistantEntry]);
        setIsSendingQuickMessage(false);
        return;
      }

      throw new Error("Empty response");
    } catch (error) {
      console.error("Quick chat error", error);
      const fallbackEntry = {
        id: `assistant-${Date.now()}`,
        text: "عذراً، حدث خطأ أثناء الاتصال بالمساعد. جرّب مرة أخرى أو افتح المحادثة الكاملة.",
        sender: "assistant" as const,
      };
      setChatHistory((previous) => [...previous, fallbackEntry]);
    } finally {
      setIsSendingQuickMessage(false);
    }
  };

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    element?.scrollIntoView({ behavior: "smooth" });
  };

  const heroOrbs = useMemo<HeroOrb[]>(() => {
    const gradients = [
      "bg-gradient-to-br from-[#0d9488]/45 via-[#67e8f9]/30 to-transparent",
      "bg-gradient-to-br from-[#06b6d4]/40 via-[#22d3ee]/28 to-transparent",
      "bg-gradient-to-br from-[#14b8a6]/38 via-[#38bdf8]/26 to-transparent",
      "bg-gradient-to-br from-[#0ea5e9]/36 via-[#5eead4]/24 to-transparent",
    ];

    const blurLevels = ["blur-[130px]", "blur-[110px]", "blur-[150px]", "blur-[90px]"];

    return Array.from({ length: 8 }, (_, index) => {
      const size = 180 + Math.random() * 220;
      const top = 18 + Math.random() * 60;
      const left = 20 + Math.random() * 60;
      const gradient = gradients[index % gradients.length];
      const blurClass = blurLevels[index % blurLevels.length];

      const horizontalRange = 60 + Math.random() * 140;
      const verticalRange = 60 + Math.random() * 140;
      const rotationRange = 10 + Math.random() * 18;
      const baseScale = 0.75 + Math.random() * 0.45;

      return {
        size,
        top: `${top}%`,
        left: `${left}%`,
        gradient,
        blurClass,
        duration: 14 + Math.random() * 10,
        delay: Math.random() * 2,
        animate: {
          x: [0, horizontalRange, -horizontalRange * 0.7, horizontalRange * 0.4, 0],
          y: [0, -verticalRange, verticalRange * 0.65, -verticalRange * 0.35, 0],
          scale: [baseScale, baseScale * 1.08, baseScale * 0.92, baseScale * 1.05, baseScale],
          opacity: [0.35, 0.78, 0.5, 0.7, 0.4],
          rotate: [0, rotationRange, -rotationRange * 0.6, rotationRange * 0.35, 0],
        },
      };
    });
  }, []);

  return (
    <div className="min-h-screen dark bg-white relative overflow-hidden" dir="rtl">

      {/* Modern Navbar */}
      <motion.nav
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${scrolled ? 'bg-white/95 backdrop-blur-xl shadow-2xl border-b border-[#0d9488]/20' : 'bg-white/80'
          }`}
      >
        <div className="container mx-auto px-4 md:px-6 lg:px-12">
          <div className="flex items-center justify-between h-20">
            {/* Login Button on the left */}
            <div className="flex-shrink-0">
              <Button
                onClick={() => navigate('/auth')}
                className="bg-gradient-to-r from-[#0d9488] to-[#06b6d4] hover:from-[#06b6d4] hover:to-[#0d9488] text-white font-bold py-2 px-6 rounded-full transition-all duration-300 hover:shadow-lg hover:scale-105"
              >
                تسجيل الدخول
              </Button>
            </div>

            {/* Navigation Links - Centered */}
            <div className="hidden md:flex items-center gap-10 flex-1 justify-center">
              <button onClick={() => scrollToSection('hero')} className="text-gray-700 hover:text-[#0d9488] transition-all duration-300 font-semibold text-lg hover:scale-110">
                الرئيسية
              </button>
              <button onClick={() => scrollToSection('features')} className="text-gray-700 hover:text-[#06b6d4] transition-all duration-300 font-semibold text-lg hover:scale-110">
                المميزات
              </button>
              <button onClick={() => scrollToSection('courses')} className="text-gray-700 hover:text-[#0d9488] transition-all duration-300 font-semibold text-lg hover:scale-110">
                الدورات
              </button>
              <button onClick={() => scrollToSection('about')} className="text-gray-700 hover:text-[#06b6d4] transition-all duration-300 font-semibold text-lg hover:scale-110">
                من نحن
              </button>
              <button onClick={() => scrollToSection('contact')} className="text-gray-700 hover:text-[#0d9488] transition-all duration-300 font-semibold text-lg hover:scale-110">
                تواصل معنا
              </button>
            </div>

            {/* Logo on the right */}
            <div className="flex-shrink-0 relative mt-1" style={{ transform: 'scale(1.35)', transformOrigin: 'center' }}>
              <img
                src={alQaedLogo}
                alt="Qaad Logo"
                className="h-24 w-auto cursor-pointer relative z-10 transform hover:scale-105 transition-transform duration-300 p-1"
                style={{
                  filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1)) brightness(1.02) saturate(1.1)',
                  WebkitFilter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1)) brightness(1.02) saturate(1.1)'
                }}
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              />
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
        onClick={toggleChat}
        className="fixed bottom-8 right-8 bg-gradient-to-r from-[#0d9488] to-[#06b6d4] p-4 rounded-full cursor-pointer shadow-2xl hover:shadow-[0_0_30px_rgba(13,148,136,0.45)] transition-all duration-300 z-50 group"
      >
        <svg className="w-8 h-8 text-white group-hover:scale-110 transition-transform duration-300" fill="currentColor" viewBox="0 0 24 24">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12h-8v-2h8v2zm0-4h-8V8h8v2z" />
        </svg>
      </motion.div>

      <AnimatePresence>
        {isChatOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.25 }}
            className="fixed bottom-28 right-8 w-80 max-w-[90vw] bg-white rounded-3xl shadow-2xl border border-[#0d9488]/20 z-50 overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-3 bg-gradient-to-r from-[#0d9488] to-[#06b6d4] text-white">
              <div>
                <p className="font-bold text-lg">مساعد الطلاب</p>
                <p className="text-sm text-white/80">اطرح سؤالك وسنرد عليك فورًا</p>
              </div>
              <button onClick={toggleChat} className="p-2 rounded-full hover:bg-white/20 transition" aria-label="إغلاق المحادثة">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4 text-right">
              <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
                <p className="text-gray-600 text-sm leading-relaxed">
                  مرحبًا بك! كيف يمكننا مساعدتك اليوم؟ يمكنك البدء بكتابة استفسارك في الأسفل.
                </p>
                {chatHistory.map((entry) => (
                  <div
                    key={entry.id}
                    className={`rounded-2xl px-4 py-2 text-sm leading-relaxed shadow-sm border ${entry.sender === "user"
                        ? "bg-[#0d9488]/10 border-[#0d9488]/30 text-[#0d9488] ml-auto max-w-[85%]"
                        : "bg-white border-[#06b6d4]/30 text-gray-700 mr-auto max-w-[90%]"
                      }`}
                  >
                    {entry.text}
                  </div>
                ))}
                {isSendingQuickMessage && (
                  <div className="bg-white border border-[#06b6d4]/20 text-gray-500 rounded-2xl px-4 py-2 text-sm w-fit mr-auto shadow-sm">
                    جاري إرسال الرسالة...
                  </div>
                )}
              </div>
              <textarea
                rows={3}
                placeholder="اكتب رسالتك هنا..."
                value={quickMessage}
                onChange={(event) => setQuickMessage(event.target.value)}
                className="w-full border border-[#0d9488]/30 rounded-2xl px-4 py-3 text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#0d9488] focus:border-[#0d9488] transition disabled:opacity-70 disabled:cursor-not-allowed"
                disabled={isSendingQuickMessage}
              ></textarea>
              <div className="flex items-center justify-between gap-3">
                <Button className="flex-1 bg-gradient-to-r from-[#0d9488] to-[#06b6d4] text-white" onClick={openFullChat}>
                  فتح المحادثة الكاملة
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1 bg-white text-[#0d9488] border border-[#0d9488]/30"
                  onClick={sendQuickMessage}
                  disabled={isSendingQuickMessage || !quickMessage.trim()}
                >
                  إرسال سريع
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hero Section with Background Image */}
      <section
        id="hero"
        className="relative px-4 py-12 overflow-hidden bg-white flex flex-col"
      >
        {/* Hero Container with rounded borders */}
        <div
          className="relative w-full mt-8 md:mt-12 rounded-3xl overflow-hidden shadow-2xl mx-auto max-w-7xl"
          style={{
            height: "720px",
            backgroundImage: `url(${heroBgImage})`,
            backgroundAttachment: "scroll",
            backgroundSize: "cover",
            backgroundPosition: "60% 75%",
          }}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-[#031b2f]/70 via-[#04364d]/55 to-[#041f2f]/85 mix-blend-multiply" />
          <div className="absolute inset-0 bg-gradient-to-br from-[#0ea5e9]/18 via-[#22d3ee]/14 to-transparent" />

          {/* Core-inspired ambient effect */}
          <div className="absolute inset-0 overflow-hidden">
            <motion.div
              initial={{ opacity: 0.4, scale: 0.85 }}
              animate={{
                opacity: [0.4, 0.7, 0.45],
                scale: [0.85, 1, 0.92],
                rotate: [0, 12, -10, 0],
              }}
              transition={{ duration: 10, repeat: Infinity, repeatType: "mirror" }}
              className="absolute top-1/2 left-1/2 w-[520px] h-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-br from-[#0d9488]/30 via-[#67e8f9]/20 to-transparent blur-3xl"
            />

            <motion.div
              initial={{ opacity: 0.5, scale: 0.7 }}
              animate={{
                opacity: [0.5, 0.9, 0.6],
                scale: [0.7, 0.95, 0.75],
                rotate: [0, -6, 8, 0],
              }}
              transition={{ duration: 8, repeat: Infinity, repeatType: "mirror" }}
              className="absolute top-1/2 left-1/2 w-[360px] h-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#22d3ee]/25 blur-[120px]"
            />

            <motion.div
              initial={{ opacity: 0.35, scale: 0.9 }}
              animate={{
                opacity: [0.35, 0.6, 0.35],
                scale: [0.9, 1.05, 0.9],
              }}
              transition={{ duration: 12, repeat: Infinity, repeatType: "mirror" }}
              className="absolute top-1/2 left-1/2 w-[440px] h-[440px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10"
              style={{ boxShadow: "0 0 80px rgba(13, 148, 136, 0.3) inset" }}
            />

            <motion.div
              initial={{ opacity: 0.25, scale: 0.6 }}
              animate={{
                opacity: [0.25, 0.5, 0.25],
                scale: [0.6, 0.75, 0.62],
              }}
              transition={{ duration: 9, repeat: Infinity, repeatType: "mirror" }}
              className="absolute top-1/2 left-1/2 w-[260px] h-[260px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0d9488]/35 blur-[90px]"
            />

            <div className="absolute inset-0 pointer-events-none">
              {heroOrbs.map((orb, index) => (
                <motion.div
                  key={index}
                  initial={{
                    x: Array.isArray(orb.animate.x) ? orb.animate.x[0] : 0,
                    y: Array.isArray(orb.animate.y) ? orb.animate.y[0] : 0,
                    scale: Array.isArray(orb.animate.scale) ? orb.animate.scale[0] : 1,
                    opacity: Array.isArray(orb.animate.opacity) ? orb.animate.opacity[0] : 0.6,
                    rotate: Array.isArray(orb.animate.rotate) ? orb.animate.rotate[0] : 0
                  }}
                  animate={orb.animate}
                  transition={{
                    duration: orb.duration,
                    delay: orb.delay,
                    repeat: Infinity,
                    repeatType: "loop",
                    ease: "easeInOut"
                  }}
                  className={`absolute ${orb.gradient} ${orb.blurClass} rounded-full opacity-70 mix-blend-screen`}
                  style={{
                    width: orb.size,
                    height: orb.size,
                    top: orb.top,
                    left: orb.left,
                    transform: "translate(-50%, -50%)"
                  }}
                />
              ))}
            </div>
          </div>

          {/* Hero Text Overlay */}
          <div className="absolute inset-0 z-20 flex items-center justify-start px-6 sm:px-10 lg:px-16">
            <motion.div
              initial={{ opacity: 0, x: 60 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 1.2, delay: 0.4 }}
              className="max-w-xl text-right space-y-6"
            >
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-snug drop-shadow-[0_8px_30px_rgba(6,182,212,0.4)]">
                مش بس بنحكي التاريخ…
                <br />
                بنخليك تعيشه
              </h1>
              <p className="text-lg sm:text-xl text-white/80 font-medium leading-relaxed drop-shadow-[0_4px_16px_rgba(15,118,110,0.35)]">
                رحلة تعليمية تفاعلية تغمرك في التفاصيل وتبني لك فهمًا عميقًا لأحداث الماضي بطريقة حديثة وملهمة.
              </p>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Features Section - CLEAN & SIMPLE */}
      <section id="features" className="py-24 px-4 bg-white relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-0 right-0 w-96 h-96 bg-[#0d9488]/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-0 left-0 w-96 h-96 bg-[#06b6d4]/10 rounded-full blur-3xl"></div>
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
              className="text-5xl md:text-6xl font-black mb-6 text-[#0d9488]"
            >
              لماذا نحن الخيار الأفضل؟
            </motion.h2>
            <p className="text-xl md:text-2xl text-[#0f766e] font-medium">
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
                title: "وجود AI شات بوت",
                description: "مساعد ذكي متاح على مدار الساعة للإجابة على استفساراتك"
              }
            ].map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.2, duration: 0.6 }}
                whileHover={{ y: -15, scale: 1.03 }}
                className="bg-gradient-to-br from-white to-gray-50 p-10 rounded-3xl shadow-lg hover:shadow-[0_0_30px_rgba(13,148,136,0.25)] transition-all duration-500 border-2 border-[#0d9488]/20 relative group overflow-hidden"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-[#0d9488]/10 to-[#06b6d4]/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <div className="relative z-10">
                  <div className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-20 h-20 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-[#0d9488]/50">
                    <feature.icon className="w-10 h-10 text-white font-black" />
                  </div>
                  <h3 className="text-3xl font-black mb-4 text-[#0d9488]">{feature.title}</h3>
                  <p className="text-gray-600 text-lg leading-relaxed">{feature.description}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* About/Stats Section - MOVED UP */}
      <section id="about" className="py-32 px-4 bg-gradient-to-br from-white via-slate-50 to-white relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/2 left-1/4 w-96 h-96 bg-[#0d9488]/12 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <h2 className="text-5xl md:text-6xl font-black mb-6 text-[#0d9488]">
              إنجازاتنا بالأرقام
            </h2>
            <p className="text-xl md:text-2xl text-[#0d9488] font-medium">
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
                <div className="absolute inset-0 bg-gradient-to-br from-[#0d9488]/15 to-[#06b6d4]/15 rounded-3xl blur-2xl group-hover:blur-3xl transition-all duration-500"></div>
                <div className="relative bg-gradient-to-br from-white to-gray-50 p-10 rounded-3xl shadow-lg border-2 border-[#0d9488]/30 group-hover:border-[#06b6d4] transition-all duration-500 shadow-[0_0_20px_rgba(13,148,136,0.15)]">
                  <div className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-[#0d9488]/50 group-hover:shadow-[#06b6d4]/50 transition-all duration-500">
                    <stat.icon className="w-10 h-10 text-white font-black" />
                  </div>
                  <div className="text-6xl md:text-7xl font-black bg-gradient-to-r from-[#06b6d4] to-[#0d9488] bg-clip-text text-transparent mb-3">
                    {stat.number}
                  </div>
                  <div className="text-xl text-[#0d9488] font-semibold">{stat.label}</div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Courses Section - PREMIUM */}
      <section id="courses" className="py-24 px-4 bg-white relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-1/2 right-1/4 w-96 h-96 bg-[#06b6d4]/10 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-20"
          >
            <h2 className="text-5xl md:text-6xl font-black mb-6 text-[#0d9488]">
              دوراتنا المميزة
            </h2>
            <p className="text-xl md:text-2xl text-[#0f766e] font-medium">
              اختر من مجموعة واسعة من الدورات التعليمية المتخصصة
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-10">
            {[
              { title: "التاريخ - الفصل الثاني", students: 420, lessons: 28 },
              { title: "مراجعة شاملة للفصل الأول", students: 385, lessons: 24 },
              { title: "منهج الصف الأول الثانوي كامل", students: 512, lessons: 40 }
            ].map((course, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.2, duration: 0.6 }}
                whileHover={{ y: -15, scale: 1.05 }}
                className="rounded-3xl overflow-hidden shadow-lg hover:shadow-[0_0_40px_rgba(13,148,136,0.2)] transition-all duration-500 cursor-pointer border-2 border-[#0d9488]/30 hover:border-[#06b6d4] group bg-white"
              >
                <div className="h-56 bg-gradient-to-br from-[#0d9488] via-[#06b6d4] to-[#0d9488] relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-white/80 to-transparent"></div>
                  <div className="absolute bottom-4 right-4 left-4">
                    <h3 className="text-3xl font-black text-white drop-shadow-lg">{course.title}</h3>
                  </div>
                </div>
                <div className="p-8">
                  <div className="flex items-center justify-between text-gray-700 mb-6 text-lg">
                    <span className="flex items-center gap-2 font-semibold">
                      <Users className="w-5 h-5 text-[#0d9488]" />
                      {course.students} طالب
                    </span>
                    <span className="flex items-center gap-2 font-semibold">
                      <BookOpen className="w-5 h-5 text-[#06b6d4]" />
                      {course.lessons} درس
                    </span>
                  </div>
                  <Button className="w-full bg-gradient-to-r from-[#0d9488] to-[#06b6d4] text-white hover:shadow-[0_0_20px_rgba(13,148,136,0.35)] text-lg font-black py-6 rounded-xl transition-all duration-300">
                    تفاصيل الدورة
                  </Button>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>
      <section className="py-24 px-4 bg-gray-50 relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute top-0 right-1/3 w-96 h-96 bg-[#0d9488]/12 rounded-full blur-3xl"></div>
          <div className="absolute bottom-0 left-1/4 w-96 h-96 bg-[#06b6d4]/12 rounded-full blur-3xl"></div>
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
              <div className="bg-gradient-to-r from-[#0d9488] to-[#06b6d4] p-4 rounded-full shadow-lg shadow-[#0d9488]/50">
                <Sparkles className="w-14 h-14 text-white font-black" />
              </div>
            </motion.div>
            <h2 className="text-5xl md:text-6xl font-black mb-6 text-[#0d9488]">
              ماذا يقول طلابنا؟
            </h2>
            <p className="text-xl md:text-2xl text-[#0d9488] font-medium">
              آراء حقيقية من طلاب حققوا النجاح معنا
            </p>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                name: "أحمد محمد",
                comment: "المنصة دي فادتني جدًا في التاريخ. الشرح مرتب وخلّاني أفهم الأحداث بسهولة!",
                rating: 5,
                image: "👨‍🎓"
              },
              {
                name: "فاطمة علي",
                comment: "أجمد تجربة في التاريخ شفتها! الكورسات منظمة والمحتوى مليان معلومات مهمة.",
                rating: 5,
                image: "👩‍🎓"
              },
              {
                name: "خالد سعيد",
                comment: "بصيت على أولادي ولاحظت فرق كبير في فهمهم للتاريخ. متشكرين جدًا!",
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
                className="bg-white p-10 rounded-3xl shadow-lg shadow-[#0d9488]/10 border-2 border-[#0d9488]/30 relative group hover:border-[#06b6d4] transition-all duration-500"
              >
                <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-[#0d9488]/25 to-transparent rounded-bl-full"></div>
                <div className="text-7xl mb-6 relative z-10">{testimonial.image}</div>
                <div className="flex gap-2 mb-6">
                  {[...Array(testimonial.rating)].map((_, i) => (
                    <Star key={i} className="w-6 h-6 fill-[#06b6d4] text-[#06b6d4] drop-shadow-[0_0_5px_rgba(6,182,212,0.35)]" />
                  ))}
                </div>
                <p className="text-gray-700 text-lg mb-8 italic leading-relaxed">"{testimonial.comment}"</p>
                <div>
                  <p className="font-black text-xl text-[#0d9488] mb-1">{testimonial.name}</p>
                </div>
                <div className="absolute bottom-0 left-0 w-full h-2 bg-gradient-to-r from-[#0d9488] to-[#06b6d4] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-500 rounded-b-3xl"></div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Why Choose Us - Advanced */}
      <section className="py-20 px-4 bg-white relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute bottom-1/2 left-1/4 w-96 h-96 bg-[#0d9488]/12 rounded-full blur-3xl"></div>
        </div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-4xl md:text-5xl font-black mb-4 text-[#0d9488]">
              لماذا نحن الأفضل؟
            </h2>
            <p className="text-lg text-[#0d9488] font-semibold">
              مميزات فريدة تجعلنا الخيار الأول للطلاب
            </p>
          </motion.div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: Target,
                title: "هدفنا نجاحك",
                description: "نركز على تحقيق أهدافك الدراسية بأحدث الأساليب",
                gradient: "from-[#0d9488] to-[#06b6d4]"
              },
              {
                icon: Zap,
                title: "تعلم سريع وفعال",
                description: "منهجيات حديثة لتسريع عملية الفهم والاستيعاب",
                gradient: "from-[#0f766e] to-[#22d3ee]"
              },
              {
                icon: Shield,
                title: "جودة مضمونة",
                description: "محتوى معتمد ومراجع من قبل خبراء في التعليم",
                gradient: "from-[#14b8a6] to-[#22d3ee]"
              },
              {
                icon: Clock,
                title: "متاح 24/7",
                description: "تعلم في أي وقت ومن أي مكان يناسبك",
                gradient: "from-[#0ea5e9] to-[#38bdf8]"
              },
              {
                icon: CheckCircle,
                title: "دعم مستمر",
                description: "فريق دعم متواجد دائماً للإجابة على استفساراتك",
                gradient: "from-[#0f766e] to-[#0ea5e9]"
              },
              {
                icon: TrendingUp,
                title: "تقدم ملحوظ",
                description: "تتبع تقدمك وتحسن مستواك بشكل مستمر",
                gradient: "from-[#06b6d4] to-[#0ea5e9]"
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
                <div className={`absolute inset-0 bg-gradient-to-br ${item.gradient} opacity-0 group-hover:opacity-10 transition-opacity duration-300 rounded-2xl blur-xl`}></div>
                <div className="relative bg-white p-6 rounded-2xl border-2 border-[#0d9488]/20 group-hover:border-[#06b6d4] transition-all shadow-md shadow-[#0d9488]/10 group-hover:shadow-[#06b6d4]/15">
                  <div className={`bg-gradient-to-br ${item.gradient} w-14 h-14 rounded-xl flex items-center justify-center mb-4 shadow-lg`}>
                    <item.icon className="w-7 h-7 text-white font-black" />
                  </div>
                  <h3 className="text-xl font-black mb-3 text-[#0d9488]">{item.title}</h3>
                  <p className="text-gray-600 text-sm leading-relaxed">{item.description}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section - PREMIUM */}
      <section className="py-40 px-4 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0d9488] via-[#06b6d4] to-[#0d9488] skew-y-3"></div>
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
                  onClick={() => navigate('/login')}
                  className="bg-white text-[#0d9488] hover:bg-white/90 px-14 py-9 text-2xl font-black rounded-full shadow-2xl"
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

      {/* Contact/Footer Section - PREMIUM */}
      <section id="contact" className="py-28 px-4 bg-gradient-to-b from-white to-gray-50 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0d9488]/6 to-transparent"></div>
        <div className="container mx-auto max-w-6xl relative z-10">
          <div className="grid md:grid-cols-2 gap-16 mb-20">
            <motion.div
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
            >
              <h2 className="text-5xl md:text-6xl font-black mb-6 text-[#0d9488]">تواصل معنا</h2>
              <p className="text-gray-700 text-xl mb-12 font-medium leading-relaxed">
                نحن هنا للإجابة على استفساراتك ومساعدتك في رحلتك التعليمية
              </p>
              <div className="space-y-6">
                <motion.div
                  whileHover={{ x: 10 }}
                  className="flex items-center gap-5 group"
                >
                  <div className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg shadow-[#0d9488]/50 group-hover:shadow-[#06b6d4]/50 transition-all duration-300">
                    <Mail className="w-8 h-8 text-white font-black" />
                  </div>
                  <div>
                    <p className="font-bold text-[#0d9488] text-lg mb-1">البريد الإلكتروني</p>
                    <p className="text-gray-600 text-lg">mohamed96ramadan1996@gmail.com</p>
                  </div>
                </motion.div>
                <motion.div
                  whileHover={{ x: 10 }}
                  className="flex items-center gap-5 group"
                >
                  <div className="bg-gradient-to-br from-[#06b6d4] to-[#0d9488] w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg shadow-[#0d9488]/50 group-hover:shadow-[#06b6d4]/50 transition-all duration-300">
                    <Phone className="w-8 h-8 text-white font-black" />
                  </div>
                  <div>
                    <p className="font-bold text-[#0d9488] text-lg mb-1">الهاتف</p>
                    <p className="text-gray-600 text-lg">01024083057 / 01034067686</p>
                  </div>
                </motion.div>
                <motion.div
                  whileHover={{ x: 10 }}
                  className="flex items-center gap-5 group"
                >
                  <div className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg shadow-[#0d9488]/50 group-hover:shadow-[#06b6d4]/50 transition-all duration-300">
                    <MapPin className="w-8 h-8 text-white font-black" />
                  </div>
                  <div>
                    <p className="font-bold text-[#0d9488] text-lg mb-1">العنوان</p>
                    <p className="text-gray-600 text-lg">مصر</p>
                  </div>
                </motion.div>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, x: 30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6 }}
              className="bg-white p-10 rounded-3xl shadow-lg border-2 border-[#0d9488]/20"
            >
              <h3 className="text-3xl font-black mb-8 text-[#0d9488]">أرسل رسالة</h3>
              <form className="space-y-6">
                <input
                  type="text"
                  placeholder="الاسم"
                  className="w-full px-6 py-4 rounded-xl border-2 border-[#0d9488]/30 bg-gray-50 text-gray-800 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#0d9488] focus:border-[#0d9488] transition-all text-lg"
                />
                <input
                  type="email"
                  placeholder="البريد الإلكتروني"
                  className="w-full px-6 py-4 rounded-xl border-2 border-[#06b6d4]/30 bg-gray-50 text-gray-800 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#06b6d4] focus:border-[#06b6d4] transition-all text-lg"
                />
                <textarea
                  placeholder="رسالتك"
                  rows={5}
                  className="w-full px-6 py-4 rounded-xl border-2 border-[#0d9488]/30 bg-gray-50 text-gray-800 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#0d9488] focus:border-[#0d9488] transition-all text-lg resize-none"
                ></textarea>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Button className="w-full bg-gradient-to-r from-[#0d9488] to-[#06b6d4] text-white hover:shadow-[0_0_20px_rgba(13,148,136,0.35)] py-6 text-xl font-black rounded-xl transition-all duration-300">
                    إرسال الرسالة
                  </Button>
                </motion.div>
              </form>
            </motion.div>
          </div>

          {/* Footer - ULTRA LUXURIOUS */}
          <div className="border-t-2 border-[#0d9488]/20 pt-12 mt-8">
            <div className="flex flex-col md:flex-row items-center justify-between gap-8">
              <div className="flex items-center gap-6">
                <img src={alQaedLogo} alt="القائد" className="h-14 object-contain drop-shadow-[0_0_15px_rgba(13,148,136,0.3)]" />
                <p className="text-gray-700 text-lg font-semibold">© 2025 القائد. جميع الحقوق محفوظة</p>
              </div>
              <div className="flex gap-5">
                <motion.a
                  href="https://www.facebook.com/share/1DkCgcmuQr/"
                  target="_blank"
                  rel="noopener noreferrer"
                  whileHover={{ scale: 1.25, rotate: 5 }}
                  whileTap={{ scale: 0.9 }}
                  className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-14 h-14 rounded-xl flex items-center justify-center cursor-pointer shadow-lg shadow-[#0d9488]/50 hover:shadow-[#06b6d4]/50 transition-all duration-300"
                >
                  <Facebook className="w-7 h-7 text-white font-black" />
                </motion.a>
                <motion.a
                  href="https://www.facebook.com/share/19tEtsDsTn/"
                  target="_blank"
                  rel="noopener noreferrer"
                  whileHover={{ scale: 1.25, rotate: 5 }}
                  whileTap={{ scale: 0.9 }}
                  className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-14 h-14 rounded-xl flex items-center justify-center cursor-pointer shadow-lg shadow-[#0d9488]/50 hover:shadow-[#06b6d4]/50 transition-all duration-300"
                >
                  <Facebook className="w-7 h-7 text-white font-black" />
                </motion.a>
                <motion.a
                  href="https://www.tiktok.com/@mohamed_ramadan_96"
                  target="_blank"
                  rel="noopener noreferrer"
                  whileHover={{ scale: 1.25, rotate: 5 }}
                  whileTap={{ scale: 0.9 }}
                  className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-14 h-14 rounded-xl flex items-center justify-center cursor-pointer shadow-lg shadow-[#0d9488]/50 hover:shadow-[#06b6d4]/50 transition-all duration-300"
                >
                  <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z" />
                  </svg>
                </motion.a>
                <motion.a
                  href="https://youtube.com/@moramadan96-history"
                  target="_blank"
                  rel="noopener noreferrer"
                  whileHover={{ scale: 1.25, rotate: 5 }}
                  whileTap={{ scale: 0.9 }}
                  className="bg-gradient-to-br from-[#0d9488] to-[#06b6d4] w-14 h-14 rounded-xl flex items-center justify-center cursor-pointer shadow-lg shadow-[#0d9488]/50 hover:shadow-[#06b6d4]/50 transition-all duration-300"
                >
                  <Youtube className="w-7 h-7 text-white font-black" />
                </motion.a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Index;
