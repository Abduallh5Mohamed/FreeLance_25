import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface AchievementBadgeProps {
  title: string;
  description: string;
  icon: LucideIcon;
  earned: boolean;
  progress?: number;
  rarity?: "common" | "rare" | "epic" | "legendary";
  date?: Date;
  index?: number;
}

export const AchievementBadge = ({
  title,
  description,
  icon: Icon,
  earned,
  progress = 0,
  rarity = "common",
  date,
  index = 0,
}: AchievementBadgeProps) => {
  const getRarityColors = () => {
    switch (rarity) {
      case "legendary":
        return {
          gradient: "from-yellow-400 via-yellow-500 to-orange-500",
          glow: "shadow-yellow-500/50",
          border: "border-yellow-500/50",
        };
      case "epic":
        return {
          gradient: "from-purple-400 via-purple-500 to-pink-500",
          glow: "shadow-purple-500/50",
          border: "border-purple-500/50",
        };
      case "rare":
        return {
          gradient: "from-blue-400 via-blue-500 to-cyan-500",
          glow: "shadow-blue-500/50",
          border: "border-blue-500/50",
        };
      default:
        return {
          gradient: "from-gray-400 via-gray-500 to-gray-600",
          glow: "shadow-gray-500/50",
          border: "border-gray-500/50",
        };
    }
  };

  const colors = getRarityColors();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      whileInView={{ opacity: 1, scale: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      whileHover={{ scale: earned ? 1.05 : 1, y: earned ? -5 : 0 }}
    >
      <Card
        className={cn(
          "relative overflow-hidden transition-all duration-300",
          earned
            ? `border-2 ${colors.border} shadow-xl ${colors.glow}`
            : "border-muted/20 opacity-60 grayscale"
        )}
      >
        {/* Animated Background for Earned Badges */}
        {earned && (
          <motion.div
            className={`absolute inset-0 bg-gradient-to-br ${colors.gradient} opacity-10`}
            animate={{
              scale: [1, 1.2, 1],
              rotate: [0, 180, 360],
            }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          />
        )}

        {/* Rarity Badge */}
        {earned && (
          <Badge
            className={cn(
              "absolute top-2 left-2 text-xs font-bold",
              `bg-gradient-to-r ${colors.gradient} text-white border-0`
            )}
          >
            {rarity === "legendary" && "أسطوري"}
            {rarity === "epic" && "ملحمي"}
            {rarity === "rare" && "نادر"}
            {rarity === "common" && "عادي"}
          </Badge>
        )}

        <CardContent className="p-6 relative z-10">
          <div className="flex flex-col items-center text-center space-y-3">
            {/* Icon */}
            <motion.div
              className={cn(
                "p-4 rounded-full",
                earned
                  ? `bg-gradient-to-br ${colors.gradient} shadow-lg`
                  : "bg-muted"
              )}
              animate={
                earned
                  ? {
                      rotate: [0, 10, -10, 0],
                      scale: [1, 1.1, 1],
                    }
                  : {}
              }
              transition={
                earned
                  ? {
                      duration: 2,
                      repeat: Infinity,
                      repeatDelay: 3,
                    }
                  : {}
              }
            >
              <Icon
                className={cn(
                  "h-10 w-10",
                  earned ? "text-white" : "text-muted-foreground"
                )}
              />
            </motion.div>

            {/* Title */}
            <h3
              className={cn(
                "font-bold text-lg",
                earned ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {title}
            </h3>

            {/* Description */}
            <p className="text-sm text-muted-foreground">{description}</p>

            {/* Progress Bar (if not earned) */}
            {!earned && progress > 0 && (
              <div className="w-full space-y-1">
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-primary to-accent"
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                  />
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {progress}% مكتمل
                </p>
              </div>
            )}

            {/* Earned Date */}
            {earned && date && (
              <p className="text-xs text-muted-foreground">
                تم الحصول عليه في {date.toLocaleDateString("ar-EG")}
              </p>
            )}
          </div>
        </CardContent>

        {/* Sparkle Effect for Earned Badges */}
        {earned && (
          <>
            <motion.div
              className="absolute top-2 right-2 w-2 h-2 bg-white rounded-full"
              animate={{
                scale: [0, 1, 0],
                opacity: [0, 1, 0],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                repeatDelay: 1,
              }}
            />
            <motion.div
              className="absolute bottom-2 left-2 w-2 h-2 bg-white rounded-full"
              animate={{
                scale: [0, 1, 0],
                opacity: [0, 1, 0],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                repeatDelay: 1,
                delay: 1,
              }}
            />
          </>
        )}
      </Card>
    </motion.div>
  );
};
