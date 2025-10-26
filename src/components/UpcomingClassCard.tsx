import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, Clock, Users, MapPin, Video } from "lucide-react";
import { format } from "date-fns";
import { ar } from "date-fns/locale";

interface UpcomingClassProps {
  title: string;
  subject: string;
  instructor: string;
  dateTime: Date;
  duration: number;
  location?: string;
  isOnline?: boolean;
  attendees?: number;
  meetingLink?: string;
  status?: "upcoming" | "live" | "completed";
  index?: number;
}

export const UpcomingClassCard = ({
  title,
  subject,
  instructor,
  dateTime,
  duration,
  location,
  isOnline = false,
  attendees = 0,
  meetingLink,
  status = "upcoming",
  index = 0,
}: UpcomingClassProps) => {
  const getStatusColor = () => {
    switch (status) {
      case "live":
        return "bg-green-500";
      case "completed":
        return "bg-gray-500";
      default:
        return "bg-blue-500";
    }
  };

  const getStatusLabel = () => {
    switch (status) {
      case "live":
        return "جاري الآن";
      case "completed":
        return "انتهى";
      default:
        return "قادم";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: -50 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      whileHover={{ scale: 1.02, x: 5 }}
    >
      <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-card/80 to-card backdrop-blur-sm hover:shadow-xl hover:shadow-primary/10 transition-all duration-300">
        {/* Status Indicator */}
        <div className={`absolute top-0 right-0 w-2 h-full ${getStatusColor()}`} />
        
        {/* Live Pulse Animation */}
        {status === "live" && (
          <motion.div
            className="absolute top-4 left-4 w-3 h-3 bg-green-500 rounded-full"
            animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        )}

        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <CardTitle className="text-lg font-bold mb-1">{title}</CardTitle>
              <Badge variant="secondary" className="text-xs">
                {subject}
              </Badge>
            </div>
            <Badge className={`${getStatusColor()} text-white`}>
              {getStatusLabel()}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {/* Instructor */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4" />
            <span>{instructor}</span>
          </div>

          {/* Date & Time */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Calendar className="h-4 w-4" />
            <span>{format(dateTime, "dd MMMM yyyy", { locale: ar })}</span>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span>{format(dateTime, "hh:mm a", { locale: ar })} • {duration} دقيقة</span>
          </div>

          {/* Location or Online */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {isOnline ? (
              <>
                <Video className="h-4 w-4 text-green-500" />
                <span className="text-green-500 font-semibold">حصة أونلاين</span>
              </>
            ) : (
              <>
                <MapPin className="h-4 w-4" />
                <span>{location || "مركز التدريب"}</span>
              </>
            )}
          </div>

          {/* Attendees Count */}
          {attendees > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-primary" />
              <span className="text-primary font-semibold">{attendees} طالب مسجل</span>
            </div>
          )}

          {/* Action Button */}
          {status === "live" && meetingLink && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Button
                className="w-full bg-gradient-to-r from-green-500 to-green-600 hover:shadow-glow"
                onClick={() => window.open(meetingLink, "_blank")}
              >
                <Video className="ml-2 h-4 w-4" />
                انضم الآن
              </Button>
            </motion.div>
          )}

          {status === "upcoming" && meetingLink && (
            <Button variant="outline" className="w-full" size="sm">
              <Calendar className="ml-2 h-4 w-4" />
              إضافة للتقويم
            </Button>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
};
