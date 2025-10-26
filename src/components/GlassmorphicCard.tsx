import { motion } from "framer-motion";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface GlassmorphicCardProps {
  children: ReactNode;
  className?: string;
  hoverScale?: number;
  delay?: number;
}

export const GlassmorphicCard = ({ 
  children, 
  className = "", 
  hoverScale = 1.05,
  delay = 0 
}: GlassmorphicCardProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      whileInView={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: hoverScale, y: -5 }}
      viewport={{ once: true }}
      transition={{
        duration: 0.5,
        delay,
        ease: [0.25, 0.1, 0.25, 1],
      }}
      className={cn(
        "relative backdrop-blur-xl bg-white/5 dark:bg-black/20 border border-white/10",
        "shadow-[0_8px_32px_0_rgba(31,38,135,0.37)]",
        "rounded-2xl overflow-hidden",
        "before:absolute before:inset-0 before:bg-gradient-to-br before:from-white/10 before:to-transparent before:opacity-0 hover:before:opacity-100",
        "before:transition-opacity before:duration-500",
        className
      )}
    >
      <div className="relative z-10">{children}</div>
    </motion.div>
  );
};
