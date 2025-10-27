# دليل التحويل من Supabase إلى MySQL

## الخطوات المطلوبة للإعداد

### 1. تثبيت MySQL

تأكد من تثبيت MySQL Server على جهازك:
- تحميل من: https://dev.mysql.com/downloads/mysql/
- أو استخدام XAMPP/WAMP/MAMP

### 2. إنشاء قاعدة البيانات

افتح MySQL command line أو phpMyAdmin وقم بتشغيل السكريبت:

```bash
mysql -u root -p < database/mysql-schema.sql
```

أو من داخل MySQL:

```sql
source database/mysql-schema.sql;
```

### 3. تكوين المتغيرات البيئية

انسخ ملف `.env.example` إلى `.env` وعدّل القيم:

```bash
cp .env.example .env
```

عدّل الملف `.env`:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=educational_platform
```

### 4. تثبيت الحزم الجديدة

```bash
npm install
```

هذا سيثبت `mysql2` ويزيل `@supabase/supabase-js`.

### 5. تحديث الكود

#### البديل عن Supabase Client

**قبل (Supabase):**
```typescript
import { supabase } from '@/integrations/supabase/client';

const { data, error } = await supabase
  .from('students')
  .select('*')
  .eq('id', studentId);
```

**بعد (MySQL):**
```typescript
import api from '@/lib/api';

const student = await api.getStudentById(studentId);
```

#### البديل عن Authentication

**قبل (Supabase):**
```typescript
const { data: { user } } = await supabase.auth.getUser();
const { error } = await supabase.auth.signInWithPassword({ email, password });
```

**بعد (MySQL):**
```typescript
import { signIn, getUserByEmail } from '@/lib/api';

const { user, error } = await signIn(email, password);
// حفظ الجلسة في localStorage أو استخدام Context API
```

### 6. استبدال استدعاءات Supabase

ابحث في المشروع عن جميع الملفات التي تستخدم Supabase:

```bash
# في PowerShell
Get-ChildItem -Path src -Filter *.tsx -Recurse | Select-String "supabase"
```

قم باستبدال كل استدعاء بالدالة المناسبة من `api.ts`.

## API Functions المتاحة

### Authentication
- `signIn(email, password)` - تسجيل الدخول
- `signUp(email, password, name)` - إنشاء حساب جديد
- `getUserByEmail(email)` - الحصول على مستخدم

### Students
- `getStudents()` - كل الطلاب
- `getStudentById(id)` - طالب بالـ ID
- `getStudentByEmail(email)` - طالب بالبريد
- `createStudent(student)` - إضافة طالب
- `updateStudent(id, student)` - تحديث طالب
- `deleteStudent(id)` - حذف طالب

### Courses
- `getCourses()` - كل الكورسات
- `getCourseById(id)` - كورس بالـ ID
- `createCourse(course)` - إضافة كورس

### Attendance
- `markAttendance(attendance)` - تسجيل حضور
- `getAttendanceByDate(date, groupId?)` - حضور بالتاريخ

### Exams
- `getExams(courseId?)` - كل الامتحانات
- `getExamById(id)` - امتحان بالـ ID

## إضافة دوال جديدة

عند الحاجة لدوال جديدة، أضفها في `src/lib/api.ts`:

```typescript
export const getStudentCourses = async (studentId: string) => {
  return db.query(
    `SELECT c.* FROM courses c
     JOIN student_courses sc ON c.id = sc.course_id
     WHERE sc.student_id = ?`,
    [studentId]
  );
};
```

## مثال كامل للتحويل

### ملف Auth.tsx (قبل):

```typescript
const handleAuth = async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });
};
```

### بعد التحويل:

```typescript
import { signIn } from '@/lib/api';

const handleAuth = async () => {
  const { user, error } = await signIn(email, password);
  
  if (user) {
    // حفظ بيانات المستخدم في localStorage أو Context
    localStorage.setItem('user', JSON.stringify(user));
    navigate('/dashboard');
  }
};
```

## إدارة الجلسات

بما أن MySQL لا يدير الجلسات تلقائياً، استخدم:

1. **localStorage** للتطبيقات البسيطة
2. **Context API** لمشاركة بيانات المستخدم
3. **JWT Tokens** للأمان الأفضل (مستقبلاً)

### مثال Context للمستخدم:

```typescript
// src/contexts/AuthContext.tsx
import { createContext, useContext, useState } from 'react';

const AuthContext = createContext<{
  user: User | null;
  setUser: (user: User | null) => void;
}>({ user: null, setUser: () => {} });

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });

  return (
    <AuthContext.Provider value={{ user, setUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
```

## الملفات المهمة

- `database/mysql-schema.sql` - هيكل قاعدة البيانات الكامل
- `src/lib/db.ts` - الاتصال بـ MySQL
- `src/lib/api.ts` - دوال API للعمليات
- `.env` - إعدادات الاتصال

## الدعم

لأي مشكلة أو سؤال، راجع:
- MySQL Documentation: https://dev.mysql.com/doc/
- mysql2 Package: https://github.com/sidorares/node-mysql2

## ملاحظات مهمة

1. تأكد من تشغيل MySQL Server قبل بدء التطبيق
2. استخدم hash قوي للباسوورد في جدول users
3. راجع جميع الملفات التي تستخدم `supabase.auth` أو `supabase.from()`
4. اختبر كل وظيفة بعد التحويل
5. احتفظ بنسخة احتياطية من البيانات قبل الهجرة
