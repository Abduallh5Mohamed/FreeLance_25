# 🎨 دليل استخدام المكونات المتقدمة | Advanced Components Guide

هذا الملف يشرح كيفية استخدام جميع المكونات المتقدمة التي تم إضافتها للمنصة.

---

## 📑 جدول المحتويات

1. [AnimatedSection](#animatedsection)
2. [GlassmorphicCard](#glassmorphiccard)
3. [FloatingParticles](#floatingparticles)
4. [AnimatedCounter](#animatedcounter)
5. [CourseCard](#coursecard)
6. [StatsCardEnhanced](#statscardenhanced)
7. [UpcomingClassCard](#upcomingclasscard)
8. [CircularProgress](#circularprogress)
9. [ModernAuthForm](#modernauthform)
10. [AchievementBadge](#achievementbadge)
11. [NotificationCard](#notificationcard)
12. [PageHeader](#pageheader)
13. [SearchAndFilter](#searchandfilter)

---

## 1. AnimatedSection

مكون لتغليف المحتوى وإضافة أنيميشن عند الظهور في الشاشة.

### الاستخدام

```tsx
import { AnimatedSection } from "@/components/AnimatedSection";

<AnimatedSection delay={0.2} className="py-16">
  <h2>محتوى متحرك</h2>
  <p>هذا المحتوى سيظهر بأنيميشن عند التمرير</p>
</AnimatedSection>
```

### الخصائص

- `children`: ReactNode - المحتوى المراد عرضه
- `delay?`: number - تأخير الأنيميشن بالثواني (افتراضي: 0)
- `className?`: string - CSS classes إضافية

---

## 2. GlassmorphicCard

بطاقة بتأثير الزجاج المطفي (Glassmorphism).

### الاستخدام

```tsx
import { GlassmorphicCard } from "@/components/GlassmorphicCard";

<GlassmorphicCard hoverScale={1.05} delay={0.1}>
  <div className="p-6">
    <h3>عنوان البطاقة</h3>
    <p>محتوى البطاقة مع تأثير زجاجي</p>
  </div>
</GlassmorphicCard>
```

### الخصائص

- `children`: ReactNode - المحتوى
- `className?`: string - CSS classes
- `hoverScale?`: number - مقدار التكبير عند hover (افتراضي: 1.05)
- `delay?`: number - تأخير الأنيميشن

---

## 3. FloatingParticles

جزيئات عائمة في الخلفية لإضافة حركة ديناميكية.

### الاستخدام

```tsx
import { FloatingParticles } from "@/components/FloatingParticles";

// في أي صفحة
<div className="relative">
  <FloatingParticles />
  {/* محتوى الصفحة */}
</div>
```

### ملاحظات

- يتم وضعه مرة واحدة في الصفحة
- تلقائياً يكون `position: fixed`
- لا يحتاج خصائص

---

## 4. AnimatedCounter

عداد متحرك يعد من رقم إلى آخر.

### الاستخدام

```tsx
import { AnimatedCounter } from "@/components/AnimatedCounter";

<div>
  <AnimatedCounter 
    from={0} 
    to={5000} 
    suffix="+" 
    duration={2}
    className="text-4xl font-bold text-primary"
  />
  <p>طالب متفوق</p>
</div>
```

### الخصائص

- `to`: number - الرقم النهائي (مطلوب)
- `from?`: number - الرقم الابتدائي (افتراضي: 0)
- `duration?`: number - مدة الأنيميشن بالثواني (افتراضي: 2)
- `suffix?`: string - نص بعد الرقم
- `prefix?`: string - نص قبل الرقم
- `className?`: string - CSS classes

---

## 5. CourseCard

بطاقة عرض الكورس بتصميم احترافي.

### الاستخدام

```tsx
import { CourseCard } from "@/components/CourseCard";

<CourseCard
  title="التاريخ الحديث"
  description="دراسة شاملة للأحداث التاريخية الحديثة"
  level="المستوى الأول"
  duration="12 ساعة"
  students={150}
  rating={4.8}
  image="/path/to/image.jpg"
  onEnroll={() => handleEnroll()}
  index={0}
/>
```

### الخصائص

- `title`: string - اسم الكورس
- `description`: string - وصف الكورس
- `level`: string - المستوى
- `duration`: string - المدة
- `students`: number - عدد الطلاب
- `rating`: number - التقييم (من 5)
- `image?`: string - صورة الكورس
- `onEnroll?`: () => void - دالة عند التسجيل
- `index?`: number - للأنيميشن المتسلسل

---

## 6. StatsCardEnhanced

بطاقة إحصائيات متقدمة مع progress bar.

### الاستخدام

```tsx
import { StatsCard } from "@/components/StatsCardEnhanced";
import { Users, TrendingUp } from "lucide-react";

<StatsCard
  title="إجمالي الطلاب"
  value={5000}
  suffix="+"
  icon={Users}
  progress={85}
  gradient="from-purple-500 to-pink-500"
  description="زيادة عن الشهر الماضي"
  trend={{ value: 12, isPositive: true }}
/>
```

### الخصائص

- `title`: string - العنوان
- `value`: number - القيمة الرقمية
- `icon`: LucideIcon - الأيقونة
- `suffix?`: string - لاحقة
- `prefix?`: string - بادئة
- `progress?`: number - نسبة التقدم (0-100)
- `gradient?`: string - Tailwind gradient classes
- `description?`: string - وصف إضافي
- `trend?`: { value: number, isPositive: boolean } - اتجاه التغيير

---

## 7. UpcomingClassCard

بطاقة عرض الحصة القادمة.

### الاستخدام

```tsx
import { UpcomingClassCard } from "@/components/UpcomingClassCard";

<UpcomingClassCard
  title="درس التاريخ الحديث"
  subject="التاريخ"
  instructor="أ. محمد رمضان"
  dateTime={new Date("2024-12-01T10:00:00")}
  duration={60}
  location="قاعة A"
  isOnline={true}
  attendees={45}
  meetingLink="https://meet.google.com/xxx"
  status="upcoming"
  index={0}
/>
```

### الخصائص

- `title`: string - عنوان الحصة
- `subject`: string - المادة
- `instructor`: string - المعلم
- `dateTime`: Date - التاريخ والوقت
- `duration`: number - المدة بالدقائق
- `location?`: string - المكان
- `isOnline?`: boolean - أونلاين أم لا
- `attendees?`: number - عدد الحضور
- `meetingLink?`: string - رابط الاجتماع
- `status?`: "upcoming" | "live" | "completed"
- `index?`: number - للأنيميشن

---

## 8. CircularProgress

دائرة تقدم متحركة.

### الاستخدام

```tsx
import { CircularProgress } from "@/components/CircularProgress";

<CircularProgress
  value={75}
  size={120}
  strokeWidth={8}
  label="التقدم الكلي"
  showPercentage={true}
  gradient={true}
  className="mx-auto"
/>
```

### الخصائص

- `value`: number - نسبة التقدم (0-100)
- `size?`: number - الحجم بالبكسل (افتراضي: 120)
- `strokeWidth?`: number - سمك الخط (افتراضي: 8)
- `label?`: string - نص تحت النسبة
- `showPercentage?`: boolean - إظهار النسبة
- `gradient?`: boolean - استخدام تدرج لوني
- `color?`: string - لون مخصص
- `className?`: string - CSS classes

---

## 9. ModernAuthForm

فورم تسجيل دخول/تسجيل حساب عصري.

### الاستخدام

```tsx
import { ModernAuthForm } from "@/components/ModernAuthForm";

<ModernAuthForm
  isLogin={isLogin}
  onToggleMode={() => setIsLogin(!isLogin)}
  onSubmit={handleSubmit}
  email={email}
  setEmail={setEmail}
  password={password}
  setPassword={setPassword}
  name={name}
  setName={setName}
  phone={phone}
  setPhone={setPhone}
  loading={loading}
  error={error}
  additionalFields={
    <div>
      {/* حقول إضافية للتسجيل */}
    </div>
  }
/>
```

### الخصائص

- `isLogin`: boolean - وضع تسجيل الدخول أم التسجيل
- `onToggleMode`: () => void - التبديل بين الوضعين
- `onSubmit`: (e: FormEvent) => void - عند إرسال الفورم
- `email`: string - البريد الإلكتروني
- `setEmail`: (value: string) => void
- `password`: string - كلمة المرور
- `setPassword`: (value: string) => void
- `name?`: string - الاسم (للتسجيل)
- `setName?`: (value: string) => void
- `phone?`: string - الهاتف (للتسجيل)
- `setPhone?`: (value: string) => void
- `loading`: boolean - حالة التحميل
- `error`: string - رسالة الخطأ
- `additionalFields?`: ReactNode - حقول إضافية

---

## 10. AchievementBadge

شارة إنجاز مع تأثيرات بصرية.

### الاستخدام

```tsx
import { AchievementBadge } from "@/components/AchievementBadge";
import { Trophy } from "lucide-react";

<AchievementBadge
  title="نجم اليوم"
  description="حصلت على أعلى درجة في الامتحان"
  icon={Trophy}
  earned={true}
  progress={100}
  rarity="legendary"
  date={new Date()}
  index={0}
/>
```

### الخصائص

- `title`: string - العنوان
- `description`: string - الوصف
- `icon`: LucideIcon - الأيقونة
- `earned`: boolean - تم الحصول عليه أم لا
- `progress?`: number - التقدم (0-100)
- `rarity?`: "common" | "rare" | "epic" | "legendary"
- `date?`: Date - تاريخ الحصول عليه
- `index?`: number - للأنيميشن

---

## 11. NotificationCard & NotificationList

بطاقات الإشعارات بأنواع مختلفة.

### الاستخدام

```tsx
import { NotificationList } from "@/components/NotificationCard";

const notifications = [
  {
    id: "1",
    type: "success" as const,
    title: "تم إكمال الدرس",
    message: "أحسنت! لقد أكملت درس التاريخ الحديث",
    timestamp: new Date(),
    isNew: true,
    actionLabel: "عرض الدرس",
    onAction: () => navigate("/course/1"),
  },
  {
    id: "2",
    type: "warning" as const,
    title: "امتحان قريب",
    message: "لديك امتحان في التاريخ خلال 3 أيام",
    timestamp: new Date(Date.now() - 3600000),
    isNew: false,
  },
];

<NotificationList
  notifications={notifications}
  onDismiss={(id) => handleDismiss(id)}
  maxHeight="600px"
/>
```

### الخصائص (NotificationCard)

- `id`: string - معرف فريد
- `type`: "info" | "success" | "warning" | "announcement"
- `title`: string - العنوان
- `message`: string - الرسالة
- `timestamp`: Date - الوقت
- `isNew?`: boolean - جديد أم لا
- `onDismiss?`: (id: string) => void - عند الإغلاق
- `onAction?`: () => void - إجراء إضافي
- `actionLabel?`: string - نص الإجراء
- `index?`: number - للأنيميشن

---

## 12. PageHeader

رأس صفحة احترافي مع تدرج لوني.

### الاستخدام

```tsx
import { PageHeader } from "@/components/PageHeader";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

<PageHeader
  title="الكورسات"
  subtitle="استكشف جميع الكورسات المتاحة"
  icon={BookOpen}
  gradient="from-blue-500 to-purple-500"
  actions={
    <Button size="lg">
      <Plus className="ml-2" />
      إضافة كورس
    </Button>
  }
/>
```

### الخصائص

- `title`: string - العنوان الرئيسي
- `subtitle?`: string - العنوان الفرعي
- `icon?`: LucideIcon - أيقونة
- `gradient?`: string - Tailwind gradient classes
- `actions?`: ReactNode - أزرار أو إجراءات

---

## 13. SearchAndFilter

شريط البحث والفلاتر.

### الاستخدام

```tsx
import { SearchAndFilter } from "@/components/SearchAndFilter";

<SearchAndFilter
  searchTerm={searchTerm}
  onSearchChange={setSearchTerm}
  filters={[
    {
      label: "المستوى",
      value: selectedLevel,
      options: [
        { label: "الكل", value: "all" },
        { label: "المستوى الأول", value: "level1" },
        { label: "المستوى الثاني", value: "level2" },
      ],
      onChange: setSelectedLevel,
    },
    {
      label: "المادة",
      value: selectedSubject,
      options: [
        { label: "الكل", value: "all" },
        { label: "التاريخ", value: "history" },
        { label: "الجغرافيا", value: "geography" },
      ],
      onChange: setSelectedSubject,
    },
  ]}
  activeFiltersCount={2}
  onClearFilters={() => {
    setSelectedLevel("all");
    setSelectedSubject("all");
  }}
/>
```

### الخصائص

- `searchTerm`: string - نص البحث
- `onSearchChange`: (value: string) => void - عند تغيير البحث
- `filters?`: Array - مصفوفة الفلاتر
- `activeFiltersCount?`: number - عدد الفلاتر النشطة
- `onClearFilters?`: () => void - مسح جميع الفلاتر

---

## 🎨 نصائح للاستخدام

### 1. الأنيميشن المتسلسل

استخدم خاصية `index` للحصول على أنيميشن متسلسل:

```tsx
{courses.map((course, index) => (
  <CourseCard key={course.id} {...course} index={index} />
))}
```

### 2. التدرجات اللونية

استخدم Tailwind gradient classes:

```tsx
gradient="from-purple-500 via-pink-500 to-red-500"
```

### 3. الأيقونات

استخدم Lucide React icons:

```tsx
import { Trophy, Star, Award, Crown } from "lucide-react";
```

### 4. الأداء

- استخدم `viewport={{ once: true }}` في Framer Motion لتحسين الأداء
- استخدم `lazy loading` للصور الكبيرة

---

## 🚀 أمثلة متقدمة

### مثال: صفحة Dashboard كاملة

```tsx
import { PageHeader } from "@/components/PageHeader";
import { StatsCard } from "@/components/StatsCardEnhanced";
import { UpcomingClassCard } from "@/components/UpcomingClassCard";
import { CircularProgress } from "@/components/CircularProgress";
import { AnimatedSection } from "@/components/AnimatedSection";
import { FloatingParticles } from "@/components/FloatingParticles";
import { Users, BookOpen, Trophy, TrendingUp } from "lucide-react";

const Dashboard = () => {
  return (
    <div className="min-h-screen relative">
      <FloatingParticles />
      
      <PageHeader
        title="لوحة التحكم"
        subtitle="مرحباً بك، أحمد محمود"
        icon={Users}
        gradient="from-purple-500 to-pink-500"
      />

      <AnimatedSection className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <StatsCard
            title="الكورسات المكتملة"
            value={12}
            icon={BookOpen}
            progress={80}
            gradient="from-blue-500 to-cyan-500"
          />
          <StatsCard
            title="التقدم الكلي"
            value={85}
            suffix="%"
            icon={TrendingUp}
            gradient="from-green-500 to-emerald-500"
          />
          {/* المزيد من البطاقات */}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <h2 className="text-2xl font-bold mb-4">الحصص القادمة</h2>
            <UpcomingClassCard
              title="درس التاريخ الحديث"
              subject="التاريخ"
              instructor="أ. محمد رمضان"
              dateTime={new Date()}
              duration={60}
              isOnline={true}
              status="upcoming"
            />
          </div>

          <div>
            <h2 className="text-2xl font-bold mb-4">التقدم</h2>
            <CircularProgress
              value={85}
              size={200}
              label="التقدم الكلي"
            />
          </div>
        </div>
      </AnimatedSection>
    </div>
  );
};
```

---

## 📚 المزيد من الموارد

- [Framer Motion Docs](https://www.framer.com/motion/)
- [Tailwind CSS Docs](https://tailwindcss.com/docs)
- [Lucide Icons](https://lucide.dev/)
- [Shadcn/ui](https://ui.shadcn.com/)

---

**ملاحظة**: جميع المكونات تدعم RTL (من اليمين لليسار) افتراضياً.
