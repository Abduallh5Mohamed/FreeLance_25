import { motion } from "framer-motion";
import { Search, Filter, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface SearchAndFilterProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  filters?: Array<{
    label: string;
    value: string;
    options: Array<{ label: string; value: string }>;
    onChange: (value: string) => void;
  }>;
  activeFiltersCount?: number;
  onClearFilters?: () => void;
}

export const SearchAndFilter = ({
  searchTerm,
  onSearchChange,
  filters = [],
  activeFiltersCount = 0,
  onClearFilters,
}: SearchAndFilterProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="bg-card/50 backdrop-blur-sm border border-primary/20 rounded-2xl p-6 mb-8 shadow-lg"
    >
      <div className="flex flex-col md:flex-row gap-4">
        {/* Search Input */}
        <div className="flex-1 relative">
          <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="ابحث عن الكورسات..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pr-10 h-12 text-lg border-primary/30 focus:border-primary transition-all duration-300"
          />
        </div>

        {/* Filters */}
        {filters.map((filter, index) => (
          <motion.div
            key={index}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: index * 0.1 }}
            className="w-full md:w-48"
          >
            <Select value={filter.value} onValueChange={filter.onChange}>
              <SelectTrigger className="h-12 border-primary/30 focus:border-primary">
                <SelectValue placeholder={filter.label} />
              </SelectTrigger>
              <SelectContent>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </motion.div>
        ))}

        {/* Clear Filters Button */}
        {activeFiltersCount > 0 && onClearFilters && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <Button
              variant="outline"
              size="lg"
              onClick={onClearFilters}
              className="h-12 border-primary/30 hover:bg-destructive hover:text-white transition-all duration-300"
            >
              <X className="h-5 w-5 ml-2" />
              مسح الفلاتر
              <Badge className="mr-2 bg-primary">{activeFiltersCount}</Badge>
            </Button>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
};
