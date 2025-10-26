import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { 
  Video, 
  GraduationCap, 
  Users, 
  BookOpen, 
  Award, 
  CreditCard,
  MessageSquare,
  QrCode,
  BarChart,
  Download,
  CheckCircle,
  Star,
  Sparkles,
  Crown
} from 'lucide-react';
import mohamedRamadanLogo from '@/assets/mohamed-ramadan-logo.jpg';

const PromoVideo = () => {
  const navigate = useNavigate();
  const [currentScene, setCurrentScene] = useState(0);

  const scenes = [
    {
      title: "منصة القائد التعليمية",
      subtitle: "نظام إدارة تعليمي متكامل",
      icon: <Crown className="w-24 h-24 text-primary animate-pulse" />,
      gradient: "from-primary/20 via-accent/20 to-primary/20"
    },
    {
      title: "لوحة تحكم ذكية",
      subtitle: "إدارة الدورات والامتحانات والحضور",
      icon: <BarChart className="w-20 h-20 text-primary animate-bounce" />,
      gradient: "from-blue-500/20 via-purple-500/20 to-blue-500/20"
    },
    {
      title: "الأستاذ محمد رمضان",
      subtitle: "معلم التاريخ والجغرافيا",
      icon: <GraduationCap className="w-20 h-20 text-primary animate-pulse" />,
      gradient: "from-green-500/20 via-emerald-500/20 to-green-500/20"
    },
    {
      title: "فصول ذكية",
      subtitle: "شروحات تفاعلية وعناصر ثلاثية الأبعاد",
      icon: <Video className="w-20 h-20 text-primary animate-bounce" />,
      gradient: "from-orange-500/20 via-yellow-500/20 to-orange-500/20"
    },
    {
      title: "تعلم متعدد الأوجه",
      subtitle: "فيديوهات، ملفات PDF، امتحانات تصحيح آلي",
      icon: <BookOpen className="w-20 h-20 text-primary animate-pulse" />,
      gradient: "from-pink-500/20 via-rose-500/20 to-pink-500/20"
    },
    {
      title: "تواصل مستمر",
      subtitle: "إشعارات للأولياء عن الحضور والمدفوعات",
      icon: <MessageSquare className="w-20 h-20 text-primary animate-bounce" />,
      gradient: "from-indigo-500/20 via-blue-500/20 to-indigo-500/20"
    },
    {
      title: "لوحة تحكم الإدارة",
      subtitle: "مخططات، إحصائيات مالية، وإدارة الدورات",
      icon: <Users className="w-20 h-20 text-primary animate-pulse" />,
      gradient: "from-teal-500/20 via-cyan-500/20 to-teal-500/20"
    },
    {
      title: "شهادات التقدير",
      subtitle: "تكريم أفضل 10 طلاب",
      icon: <Award className="w-20 h-20 text-primary animate-bounce" />,
      gradient: "from-amber-500/20 via-yellow-500/20 to-amber-500/20"
    },
    {
      title: "بوابات دفع آمنة",
      subtitle: "نظام مدفوعات متكامل",
      icon: <CreditCard className="w-20 h-20 text-primary animate-pulse" />,
      gradient: "from-violet-500/20 via-purple-500/20 to-violet-500/20"
    },
    {
      title: "حضور بكود QR",
      subtitle: "تتبع دقيق وسريع للحضور",
      icon: <QrCode className="w-20 h-20 text-primary animate-bounce" />,
      gradient: "from-lime-500/20 via-green-500/20 to-lime-500/20"
    }
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentScene((prev) => (prev + 1) % scenes.length);
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-secondary to-background relative overflow-hidden" dir="rtl">
      {/* Animated background particles */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {[...Array(30)].map((_, i) => (
          <div
            key={i}
            className="absolute w-2 h-2 bg-primary/30 rounded-full animate-pulse"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 2}s`,
              animationDuration: `${2 + Math.random() * 3}s`
            }}
          />
        ))}
      </div>

      {/* Scene transition container */}
      <div className="relative z-10 min-h-screen flex items-center justify-center p-8">
        <div className="max-w-6xl w-full">
          {/* Main scene */}
          <div 
            className={`bg-gradient-to-br ${scenes[currentScene].gradient} backdrop-blur-xl rounded-3xl border-2 border-primary/30 shadow-2xl p-12 transition-all duration-1000 transform hover:scale-105`}
          >
            <div className="text-center space-y-8">
              {/* Icon */}
              <div className="flex justify-center">
                {scenes[currentScene].icon}
              </div>

              {/* Title */}
              <h1 className="text-5xl md:text-7xl font-bold text-foreground mb-4 animate-fade-in">
                {scenes[currentScene].title}
              </h1>

              {/* Subtitle */}
              <p className="text-2xl md:text-3xl text-primary font-semibold animate-fade-in">
                {scenes[currentScene].subtitle}
              </p>

              {/* Scene indicator dots */}
              <div className="flex justify-center gap-2 pt-6">
                {scenes.map((_, index) => (
                  <div
                    key={index}
                    className={`h-3 rounded-full transition-all duration-300 ${
                      index === currentScene 
                        ? 'w-12 bg-primary' 
                        : 'w-3 bg-muted-foreground/30'
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Feature highlights */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-8">
            {[
              { icon: Video, label: "فيديوهات" },
              { icon: Download, label: "تحميل PDF" },
              { icon: CheckCircle, label: "تصحيح آلي" },
              { icon: QrCode, label: "حضور QR" },
              { icon: Star, label: "شهادات" }
            ].map((item, index) => (
              <div
                key={index}
                className="bg-card/50 backdrop-blur-sm rounded-xl p-4 text-center border border-primary/20 hover:border-primary/50 transition-all hover:scale-110"
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                <item.icon className="w-8 h-8 text-primary mx-auto mb-2" />
                <p className="text-sm font-semibold text-foreground">{item.label}</p>
              </div>
            ))}
          </div>

          {/* Logo and CTA */}
          <div className="mt-12 text-center space-y-6">
            <div className="flex items-center justify-center gap-4 animate-fade-in">
              <img 
                src={mohamedRamadanLogo}
                alt="الأستاذ محمد رمضان"
                className="w-20 h-20 rounded-full border-4 border-primary shadow-glow object-cover"
              />
              <div className="text-right">
                <h2 className="text-3xl font-bold text-primary flex items-center gap-2">
                  <Sparkles className="w-6 h-6" />
                  الأستاذ محمد رمضان
                </h2>
                <p className="text-muted-foreground">قائد علم التاريخ والجغرافيا</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              <Button
                size="lg"
                onClick={() => navigate('/')}
                className="text-xl px-12 py-8 bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-300 font-bold rounded-full"
              >
                <Crown className="ml-2 w-6 h-6" />
                ابدأ الآن
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => { /* auth guard disabled - redirect suppressed */ }}
                className="text-xl px-12 py-8 border-2 border-primary hover:bg-primary/10 transition-all duration-300 font-bold rounded-full"
              >
                تسجيل الدخول
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Glowing orbs */}
      <div className="absolute top-20 left-20 w-64 h-64 bg-primary/20 rounded-full blur-3xl animate-pulse"></div>
      <div className="absolute bottom-20 right-20 w-96 h-96 bg-accent/20 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }}></div>
    </div>
  );
};

export default PromoVideo;
