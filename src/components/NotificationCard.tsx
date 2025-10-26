import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X, Bell, Info, AlertTriangle, CheckCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export type NotificationType = "info" | "success" | "warning" | "announcement";

interface NotificationCardProps {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: Date;
  isNew?: boolean;
  onDismiss?: (id: string) => void;
  onAction?: () => void;
  actionLabel?: string;
  index?: number;
}

export const NotificationCard = ({
  id,
  type,
  title,
  message,
  timestamp,
  isNew = false,
  onDismiss,
  onAction,
  actionLabel,
  index = 0,
}: NotificationCardProps) => {
  const getTypeConfig = () => {
    switch (type) {
      case "success":
        return {
          icon: CheckCircle,
          gradient: "from-green-500 to-emerald-500",
          bg: "bg-green-500/10",
          border: "border-green-500/30",
          iconColor: "text-green-500",
        };
      case "warning":
        return {
          icon: AlertTriangle,
          gradient: "from-yellow-500 to-orange-500",
          bg: "bg-yellow-500/10",
          border: "border-yellow-500/30",
          iconColor: "text-yellow-500",
        };
      case "announcement":
        return {
          icon: Sparkles,
          gradient: "from-purple-500 to-pink-500",
          bg: "bg-purple-500/10",
          border: "border-purple-500/30",
          iconColor: "text-purple-500",
        };
      default:
        return {
          icon: Info,
          gradient: "from-blue-500 to-cyan-500",
          bg: "bg-blue-500/10",
          border: "border-blue-500/30",
          iconColor: "text-blue-500",
        };
    }
  };

  const config = getTypeConfig();
  const Icon = config.icon;

  const getRelativeTime = (date: Date) => {
    const now = new Date();
    const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / 60000);

    if (diffInMinutes < 1) return "الآن";
    if (diffInMinutes < 60) return `منذ ${diffInMinutes} دقيقة`;
    if (diffInMinutes < 1440) return `منذ ${Math.floor(diffInMinutes / 60)} ساعة`;
    return `منذ ${Math.floor(diffInMinutes / 1440)} يوم`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: -50 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 50 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      whileHover={{ scale: 1.02, x: 5 }}
    >
      <Card
        className={cn(
          "relative overflow-hidden border-2 transition-all duration-300",
          config.border,
          config.bg
        )}
      >
        {/* Gradient Accent Bar */}
        <div className={`absolute top-0 left-0 w-1 h-full bg-gradient-to-b ${config.gradient}`} />

        {/* New Badge */}
        {isNew && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute top-2 left-2"
          >
            <Badge className={`bg-gradient-to-r ${config.gradient} text-white border-0 text-xs`}>
              جديد
            </Badge>
          </motion.div>
        )}

        {/* Dismiss Button */}
        {onDismiss && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDismiss(id)}
            className="absolute top-2 right-2 h-8 w-8 rounded-full hover:bg-destructive/20"
          >
            <X className="h-4 w-4" />
          </Button>
        )}

        <CardContent className="p-4 pr-12">
          <div className="flex items-start gap-3">
            {/* Icon */}
            <motion.div
              className={cn("p-2 rounded-lg", config.bg)}
              animate={{ rotate: [0, 5, -5, 0] }}
              transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
            >
              <Icon className={cn("h-6 w-6", config.iconColor)} />
            </motion.div>

            {/* Content */}
            <div className="flex-1 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <h4 className="font-bold text-foreground">{title}</h4>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">{message}</p>
              <div className="flex items-center justify-between gap-2 mt-2">
                <p className="text-xs text-muted-foreground">{getRelativeTime(timestamp)}</p>
                {onAction && actionLabel && (
                  <Button
                    size="sm"
                    variant="link"
                    onClick={onAction}
                    className={cn("text-xs p-0 h-auto", config.iconColor)}
                  >
                    {actionLabel}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </CardContent>

        {/* Animated Background Pattern */}
        <motion.div
          className="absolute inset-0 opacity-5 pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle at 20% 50%, currentColor 1px, transparent 1px)`,
            backgroundSize: "20px 20px",
          }}
          animate={{
            backgroundPosition: ["0px 0px", "20px 20px"],
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            ease: "linear",
          }}
        />
      </Card>
    </motion.div>
  );
};

interface NotificationListProps {
  notifications: Array<{
    id: string;
    type: NotificationType;
    title: string;
    message: string;
    timestamp: Date;
    isNew?: boolean;
    actionLabel?: string;
    onAction?: () => void;
  }>;
  onDismiss?: (id: string) => void;
  maxHeight?: string;
}

export const NotificationList = ({
  notifications,
  onDismiss,
  maxHeight = "600px",
}: NotificationListProps) => {
  return (
    <div
      className="space-y-3 overflow-y-auto pr-2"
      style={{ maxHeight }}
    >
      <AnimatePresence mode="popLayout">
        {notifications.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <Bell className="h-16 w-16 mx-auto text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground">لا توجد إشعارات جديدة</p>
          </motion.div>
        ) : (
          notifications.map((notification, index) => (
            <NotificationCard
              key={notification.id}
              {...notification}
              index={index}
              onDismiss={onDismiss}
            />
          ))
        )}
      </AnimatePresence>
    </div>
  );
};
