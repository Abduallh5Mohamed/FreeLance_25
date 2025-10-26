import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  BookOpen, 
  Clock, 
  Users, 
  Star,
  Play,
  Award
} from "lucide-react";

interface CourseCardProps {
  title: string;
  description: string;
  level: string;
  duration: string;
  students: number;
  rating: number;
  image?: string;
  onEnroll?: () => void;
  index?: number;
}

export const CourseCard = ({
  title,
  description,
  level,
  duration,
  students,
  rating,
  image,
  onEnroll,
  index = 0,
}: CourseCardProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay: index * 0.1 }}
      whileHover={{ y: -10 }}
    >
      <Card className="group relative overflow-hidden border-primary/20 bg-gradient-to-br from-card/50 to-card backdrop-blur-sm hover:shadow-2xl hover:shadow-primary/20 transition-all duration-500 h-full">
        {/* Background Gradient Effect */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
        
        {/* Image Section */}
        <div className="relative h-48 overflow-hidden bg-gradient-to-br from-primary/20 to-accent/20">
          {image ? (
            <img 
              src={image} 
              alt={title}
              className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <BookOpen className="h-24 w-24 text-primary/40 group-hover:scale-125 group-hover:rotate-12 transition-all duration-500" />
            </div>
          )}
          
          {/* Play Button Overlay */}
          <motion.div 
            className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
            whileHover={{ scale: 1.1 }}
          >
            <div className="w-16 h-16 rounded-full bg-primary/90 flex items-center justify-center backdrop-blur-sm">
              <Play className="h-8 w-8 text-white mr-1" fill="white" />
            </div>
          </motion.div>
          
          {/* Level Badge */}
          <Badge className="absolute top-4 right-4 bg-primary/90 backdrop-blur-sm">
            {level}
          </Badge>
        </div>

        <CardHeader className="relative">
          <CardTitle className="text-xl font-bold text-right group-hover:text-primary transition-colors duration-300">
            {title}
          </CardTitle>
          <CardDescription className="text-right line-clamp-2">
            {description}
          </CardDescription>
        </CardHeader>

        <CardContent className="relative space-y-4">
          {/* Stats */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />
              <span className="font-semibold">{rating}</span>
            </div>
            
            <div className="flex items-center gap-1">
              <Users className="h-4 w-4" />
              <span>{students} طالب</span>
            </div>
            
            <div className="flex items-center gap-1">
              <Clock className="h-4 w-4" />
              <span>{duration}</span>
            </div>
          </div>

          {/* Enroll Button */}
          <Button 
            onClick={onEnroll}
            className="w-full bg-gradient-to-r from-primary to-accent hover:shadow-glow transition-all duration-300 group-hover:scale-105"
          >
            <Award className="ml-2 h-4 w-4" />
            ابدأ التعلم الآن
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
};
