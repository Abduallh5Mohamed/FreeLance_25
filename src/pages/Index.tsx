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
  Music
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import alQaedLogo from "@/assets/al-qaed-logo-new.jpg";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Hero3DCard } from "@/components/Hero3DCard";
import { Interactive3DScene } from "@/components/Interactive3DScene";

const Index = () => {
  const navigate = useNavigate();

  const features = [
    {
      icon: Video,
      title: "دروس فيديو حصرية",
      description: "محتوى تعليمي احترافي بأسلوب مشوق وممتع"
    },
    {
      icon: BookOpen,
      title: "مذكرات شاملة",
      description: "ملخصات ومراجعات منظمة لجميع الدروس"
    },
    {
      icon: Trophy,
      title: "امتحانات إلكترونية",
      description: "تدريب مستمر على نماذج الامتحانات"
    },
    {
      icon: Users,
      title: "متابعة مستمرة",
      description: "نظام متابعة دقيق لتقدم كل طالب"
    }
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
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-secondary" dir="rtl">
      {/* Header */}
      <header className="border-b border-primary/20 bg-card/95 backdrop-blur-xl sticky top-0 z-50 shadow-glow">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
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
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Button 
              onClick={() => navigate("/auth")} 
              className="bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-300 font-bold"
            >
              تسجيل الدخول
            </Button>
          </div>
        </div>
      </header>

      {/* Hero Section with 3D Card */}
      <Hero3DCard />

      {/* Interactive 3D Scene */}
      <section className="py-16 px-4">
        <div className="container mx-auto">
          <h3 className="text-4xl md:text-5xl font-bold text-center mb-4 text-foreground">
            استكشف منصتنا
          </h3>
          <h4 className="text-2xl md:text-3xl font-bold text-center mb-8 text-primary">
            في عالم ثلاثي الأبعاد تفاعلي
          </h4>
          <Interactive3DScene />
          <div className="text-center mt-6">
            <Button 
              onClick={() => navigate("/promo")}
              className="bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-300 font-bold text-lg px-8 py-6"
            >
              <Video className="ml-2 h-5 w-5" />
              شاهد الفيديو الترويجي
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-4 bg-gradient-to-b from-card to-background">
        <div className="container mx-auto">
          <h3 className="text-4xl md:text-5xl font-bold text-center mb-4 text-foreground">
            لماذا تختار
          </h3>
          <h4 className="text-3xl md:text-4xl font-bold text-center mb-16 text-primary">
            منصة القائد؟
          </h4>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature, index) => (
              <Card 
                key={index} 
                className="text-center hover:shadow-glow transition-all duration-500 hover:scale-105 border-primary/20 bg-gradient-card backdrop-blur-sm group"
              >
                <CardContent className="pt-8 pb-6">
                  <div className="mb-6 flex justify-center">
                    <div className="p-4 bg-gradient-to-br from-primary/20 to-accent/20 rounded-full group-hover:from-primary/30 group-hover:to-accent/30 transition-all duration-300 shadow-lg">
                      <feature.icon className="h-10 w-10 text-primary group-hover:scale-110 transition-transform duration-300" />
                    </div>
                  </div>
                  <h4 className="font-bold text-lg mb-3 text-foreground">{feature.title}</h4>
                  <p className="text-muted-foreground text-sm leading-relaxed">{feature.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-24 px-4 bg-gradient-to-b from-background to-card">
        <div className="container mx-auto">
          <h3 className="text-4xl font-bold text-center mb-4 text-foreground">
            آراء
          </h3>
          <h4 className="text-3xl font-bold text-center mb-16 text-primary">
            طلابنا المتميزين
          </h4>
          <div className="grid md:grid-cols-3 gap-8">
            {testimonials.map((testimonial, index) => (
              <Card 
                key={index}
                className="border-primary/20 bg-gradient-card backdrop-blur-sm hover:shadow-glow transition-all duration-500 hover:scale-105"
              >
                <CardContent className="pt-8 pb-6">
                  <div className="flex items-center gap-1 mb-6 justify-center">
                    {[...Array(testimonial.rating)].map((_, i) => (
                      <Star key={i} className="h-6 w-6 fill-primary text-primary animate-pulse" style={{ animationDelay: `${i * 0.1}s` }} />
                    ))}
                  </div>
                  <p className="text-muted-foreground mb-6 italic text-center leading-relaxed">
                    "{testimonial.text}"
                  </p>
                  <div className="flex items-center gap-4 justify-center">
                    <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center border-2 border-primary/40">
                      <Users className="h-6 w-6 text-primary" />
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-foreground text-lg">{testimonial.name}</p>
                      <p className="text-sm text-primary">{testimonial.role}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="relative py-32 px-4 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-primary/20 via-accent/20 to-primary/20 animate-pulse"></div>
        <div className="container mx-auto text-center max-w-4xl relative z-10">
          <Award className="w-24 h-24 text-primary mx-auto mb-8 animate-bounce" />
          <h3 className="text-5xl md:text-6xl font-bold mb-6 text-foreground">
            جاهز للتميز؟
          </h3>
          <p className="text-2xl text-muted-foreground mb-12 leading-relaxed">
            انضم إلى آلاف الطلاب المتفوقين الذين حققوا أعلى الدرجات معنا
            <br />
            <span className="text-primary font-bold">ابدأ رحلتك نحو التفوق الآن!</span>
          </p>
          <Button 
            size="lg" 
            onClick={() => navigate("/auth")}
            className="text-xl px-16 py-10 bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-500 hover:scale-110 font-extrabold rounded-full shadow-2xl"
          >
            <Crown className="ml-2 h-7 w-7" />
            سجل الآن مجاناً
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-card border-t border-primary/20 py-12 px-4">
        <div className="container mx-auto text-center">
          <div className="flex items-center justify-center gap-3 mb-6">
            <img 
              src={alQaedLogo}
              alt="منصة القائد" 
              className="h-16 w-16 rounded-full object-cover border-2 border-primary shadow-golden"
            />
            <div>
              <h2 className="text-2xl font-bold text-primary">منصة القائد</h2>
              <p className="text-sm text-muted-foreground">تاريخ وجغرافيا للثانوية العامة</p>
            </div>
          </div>
          
          {/* Social Media Links */}
          <div className="mb-8">
            <h3 className="text-lg font-bold text-foreground mb-4">تواصل معنا</h3>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <a 
                href="https://www.facebook.com/share/1DkCgcmuQr/" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-3 bg-gradient-to-br from-primary/20 to-accent/20 rounded-full hover:from-primary/30 hover:to-accent/30 transition-all duration-300 hover:scale-110 hover:rotate-12 shadow-lg hover:shadow-glow"
              >
                <Facebook className="h-6 w-6 text-primary group-hover:scale-110 transition-transform duration-300" />
              </a>
              
              <a 
                href="https://youtube.com/@moramadan96-history?si=2Ae7CgmA3u2PIkmF" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-3 bg-gradient-to-br from-primary/20 to-accent/20 rounded-full hover:from-primary/30 hover:to-accent/30 transition-all duration-300 hover:scale-110 hover:rotate-12 shadow-lg hover:shadow-glow"
              >
                <Youtube className="h-6 w-6 text-primary group-hover:scale-110 transition-transform duration-300" />
              </a>
              
              <a 
                href="https://www.tiktok.com/@mohamed_ramadan_96?_t=ZS-90fb2EGlSvE&_r=1" 
                target="_blank" 
                rel="noopener noreferrer"
                className="group p-3 bg-gradient-to-br from-primary/20 to-accent/20 rounded-full hover:from-primary/30 hover:to-accent/30 transition-all duration-300 hover:scale-110 hover:rotate-12 shadow-lg hover:shadow-glow"
              >
                <Music className="h-6 w-6 text-primary group-hover:scale-110 transition-transform duration-300" />
              </a>
            </div>
            
            <div className="flex items-center justify-center gap-6 mt-6 flex-wrap">
              <a 
                href="tel:01034067686"
                className="group flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors duration-300"
              >
                <Phone className="h-5 w-5 group-hover:scale-110 group-hover:rotate-12 transition-all duration-300" />
                <span className="font-semibold" dir="ltr">01034067686</span>
              </a>
              
              <a 
                href="tel:01024083057"
                className="group flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors duration-300"
              >
                <Phone className="h-5 w-5 group-hover:scale-110 group-hover:rotate-12 transition-all duration-300" />
                <span className="font-semibold" dir="ltr">01024083057</span>
              </a>
            </div>
          </div>
          
          <p className="text-muted-foreground mb-2">
            © 2024 منصة القائد. جميع الحقوق محفوظة.
          </p>
          <p className="text-sm text-primary font-semibold">
            نحو التميز والتفوق في التاريخ والجغرافيا
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
