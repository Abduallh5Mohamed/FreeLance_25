import { Card, CardContent } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  trend?: "up" | "down" | "neutral";
  className?: string;
}

const StatsCard = ({ 
  title, 
  value, 
  subtitle, 
  icon: Icon, 
  trend = "neutral",
  className 
}: StatsCardProps) => {
  return (
    <Card className={cn(
      "bg-gradient-card border-border/50 shadow-soft hover:shadow-medium transition-all duration-300 group",
      className
    )} dir="rtl">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div className="space-y-2 flex-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <div className="space-y-1">
              <p className="text-3xl font-bold text-foreground group-hover:text-primary transition-colors">
                {value}
              </p>
              {subtitle && (
                <p className={cn(
                  "text-xs font-medium",
                  trend === "up" && "text-success",
                  trend === "down" && "text-destructive",
                  trend === "neutral" && "text-muted-foreground"
                )}>
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center group-hover:bg-primary/20 transition-colors">
            <Icon className="w-6 h-6 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default StatsCard;