import { useState } from "react";
import { Button } from "@/components/ui/button";
import { GraduationCap, Crown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import mohamedRamadan3D from "@/assets/mohamed-ramadan-3d.jpg";

export const Hero3DCard = () => {
  const [rotation, setRotation] = useState({ x: 0, y: 0 });
  const navigate = useNavigate();

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = (y - centerY) / 10;
    const rotateY = (centerX - x) / 10;
    
    setRotation({ x: rotateX, y: rotateY });
  };

  const handleMouseLeave = () => {
    setRotation({ x: 0, y: 0 });
  };

  return (
    <section className="relative py-20 px-4 overflow-hidden" dir="rtl">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/5 to-transparent"></div>
      
      <div className="container mx-auto max-w-7xl relative z-10">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Text Section */}
          <div className="text-center lg:text-right order-2 lg:order-1">
            <Crown className="w-16 h-16 text-primary mx-auto lg:mr-0 mb-6 animate-pulse" />
            <h2 className="text-5xl md:text-6xl lg:text-7xl font-extrabold mb-6 leading-tight">
              <span className="text-foreground">مرحباً بكم في </span>
              <span className="text-primary bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent">
                منصة القائد
              </span>
            </h2>
            <p className="text-xl md:text-2xl text-muted-foreground mb-8 leading-relaxed max-w-2xl mx-auto lg:mx-0">
              أفضل الدورات المتقدمة في التاريخ والجغرافيا للثانوية العامة
              <br />
              مع أسلوب تدريس احترافي ومتابعة مستمرة
            </p>
            <Button 
              size="lg" 
              onClick={() => navigate("/auth")}
              className="text-xl px-12 py-8 bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-500 hover:scale-105 font-bold rounded-full"
            >
              <GraduationCap className="ml-2 h-6 w-6" />
              سجل الآن
            </Button>
          </div>

          {/* 3D Card Section */}
          <div className="order-1 lg:order-2 flex justify-center perspective-1000">
            <div
              className="relative w-full max-w-md"
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              style={{
                perspective: "1000px",
              }}
            >
              <div
                className="relative transition-transform duration-300 ease-out preserve-3d"
                style={{
                  transform: `rotateX(${rotation.x}deg) rotateY(${rotation.y}deg) translateZ(20px)`,
                  transformStyle: "preserve-3d",
                }}
              >
                {/* Card Container */}
                <div className="relative rounded-3xl overflow-hidden shadow-2xl bg-gradient-to-br from-background to-card border-4 border-primary/30 backdrop-blur-sm">
                  {/* Top Border Decoration */}
                  <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-primary via-accent to-primary"></div>
                  
                  {/* Image */}
                  <div className="relative">
                    <img 
                      src={mohamedRamadan3D}
                      alt="الأستاذ محمد رمضان - القائد" 
                      className="w-full h-auto object-cover"
                      style={{
                        transform: "translateZ(40px)",
                      }}
                    />
                  </div>
                  
                  {/* Bottom Border Decoration */}
                  <div className="absolute bottom-0 left-0 right-0 h-2 bg-gradient-to-r from-primary via-accent to-primary"></div>
                  
                  {/* Floating Glow Effect */}
                  <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-primary/20 via-transparent to-accent/20 opacity-0 hover:opacity-100 transition-opacity duration-500 pointer-events-none"></div>
                </div>

                {/* Shadow Effect */}
                <div 
                  className="absolute -bottom-8 left-1/2 -translate-x-1/2 w-4/5 h-8 bg-primary/20 blur-2xl rounded-full"
                  style={{
                    transform: `translateZ(-40px) translateX(-50%) scale(${1 + Math.abs(rotation.y) / 100})`,
                  }}
                ></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Animated Background Elements */}
      <div className="absolute top-20 left-10 w-20 h-20 bg-primary/10 rounded-full blur-3xl animate-pulse"></div>
      <div className="absolute bottom-20 right-10 w-32 h-32 bg-accent/10 rounded-full blur-3xl animate-pulse delay-1000"></div>
    </section>
  );
};
