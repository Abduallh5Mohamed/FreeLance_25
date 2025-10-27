# دليل سريع لاستبدال Supabase بـ MySQL

## الخطوات العملية للتحويل

### 1. تثبيت MySQL وإنشاء قاعدة البيانات

```powershell
# تشغيل MySQL Schema
mysql -u root -p educational_platform < database\mysql-schema.sql
```

### 2. تحديث package.json وتثبيت الحزم

```powershell
npm install mysql2
npm install tsx --save-dev  # لتشغيل سكريبتات TypeScript
npm uninstall @supabase/supabase-js
```

### 3. إنشاء ملف .env

```powershell
cp .env.example .env
```

ثم عدّل `.env`:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=educational_platform
```

### 4. اختبار الاتصال

```powershell
npm run db:test
```

### 5. استبدالات شائعة في الكود

#### Authentication

**Supabase (القديم):**
```typescript
import { supabase } from "@/integrations/supabase/client";

const { data: { user } } = await supabase.auth.getUser();
const { error } = await supabase.auth.signInWithPassword({ email, password });
```

**MySQL (الجديد):**
```typescript
import { signIn, getUserByEmail } from "@/lib/api";

// تسجيل الدخول
const { user, error } = await signIn(email, password);
if (user) {
  localStorage.setItem('user', JSON.stringify(user));
}

// الحصول على المستخدم الحالي
const userStr = localStorage.getItem('user');
const user = userStr ? JSON.parse(userStr) : null;
```

#### Students Query

**Supabase (القديم):**
```typescript
const { data: students, error } = await supabase
  .from('students')
  .select('*')
  .eq('grade_id', gradeId);
```

**MySQL (الجديد):**
```typescript
import db from "@/lib/db";

const students = await db.query(
  'SELECT * FROM students WHERE grade_id = ?',
  [gradeId]
);
```

أو استخدم الدوال الجاهزة:
```typescript
import { getStudents } from "@/lib/api";

const students = await getStudents();
```

#### Insert Data

**Supabase (القديم):**
```typescript
const { data, error } = await supabase
  .from('students')
  .insert({ name, email, phone });
```

**MySQL (الجديد):**
```typescript
import { createStudent } from "@/lib/api";

const studentId = await createStudent({ name, email, phone });
```

#### Update Data

**Supabase (القديم):**
```typescript
const { error } = await supabase
  .from('students')
  .update({ name, email })
  .eq('id', studentId);
```

**MySQL (الجديد):**
```typescript
import { updateStudent } from "@/lib/api";

await updateStudent(studentId, { name, email });
```

#### Delete Data

**Supabase (القديم):**
```typescript
const { error } = await supabase
  .from('students')
  .delete()
  .eq('id', studentId);
```

**MySQL (الجديد):**
```typescript
import { deleteStudent } from "@/lib/api";

await deleteStudent(studentId);
```

#### Join Queries

**Supabase (القديم):**
```typescript
const { data } = await supabase
  .from('students')
  .select(`
    *,
    student_courses (
      courses (*)
    )
  `);
```

**MySQL (الجديد):**
```typescript
import db from "@/lib/db";

const students = await db.query(`
  SELECT 
    s.*,
    c.id as course_id,
    c.name as course_name
  FROM students s
  LEFT JOIN student_courses sc ON s.id = sc.student_id
  LEFT JOIN courses c ON sc.course_id = c.id
`);
```

### 6. إدارة الجلسات

بدلاً من `supabase.auth`، استخدم localStorage مع Context API:

**إنشاء AuthContext:**
```typescript
// src/contexts/AuthContext.tsx
import { createContext, useContext, useState, useEffect } from 'react';
import type { User } from '@/lib/api';

interface AuthContextType {
  user: User | null;
  setUser: (user: User | null) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  setUser: () => {},
  logout: () => {},
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });

  const logout = () => {
    localStorage.removeItem('user');
    setUser(null);
  };

  useEffect(() => {
    if (user) {
      localStorage.setItem('user', JSON.stringify(user));
    } else {
      localStorage.removeItem('user');
    }
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
```

**استخدام في App.tsx:**
```typescript
import { AuthProvider } from './contexts/AuthContext';

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        {/* ... */}
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);
```

**استخدام في الكومبوننتات:**
```typescript
import { useAuth } from '@/contexts/AuthContext';

const MyComponent = () => {
  const { user, logout } = useAuth();
  
  if (!user) {
    return <Navigate to="/auth" />;
  }
  
  return (
    <div>
      <p>Welcome {user.name}</p>
      <button onClick={logout}>Logout</button>
    </div>
  );
};
```

### 7. الملفات التي تحتاج تحديث

ابحث عن جميع الملفات التي تستخدم Supabase:

```powershell
# في PowerShell
Get-ChildItem -Path src -Filter *.tsx -Recurse | Select-String "supabase" | Select-Object -ExpandProperty Path -Unique
```

قائمة الملفات المتوقعة:
- `src/pages/Auth.tsx`
- `src/pages/StudentDashboard.tsx`
- `src/pages/TeacherDashboard.tsx`
- `src/pages/Students.tsx`
- `src/pages/Courses.tsx`
- `src/pages/Attendance.tsx`
- `src/pages/Exams.tsx`
- `src/pages/ExamManager.tsx`
- `src/pages/TakeExam.tsx`
- `src/pages/Messages.tsx`
- `src/components/Header.tsx`
- `src/components/StudentHeader.tsx`

### 8. حذف ملفات Supabase

بعد التأكد من التحويل الكامل:

```powershell
Remove-Item -Recurse -Force src\integrations\supabase
Remove-Item -Recurse -Force supabase
```

### 9. التحقق من التحويل

- [ ] تم تثبيت MySQL وإنشاء قاعدة البيانات
- [ ] تم تحديث package.json وتثبيت mysql2
- [ ] تم إنشاء ملف .env بالإعدادات الصحيحة
- [ ] تم اختبار الاتصال بقاعدة البيانات (npm run db:test)
- [ ] تم تحديث كل ملفات Auth لاستخدام API الجديد
- [ ] تم تحديث استعلامات البيانات (select/insert/update/delete)
- [ ] تم إنشاء AuthContext وإضافته في App.tsx
- [ ] تم اختبار تسجيل الدخول والخروج
- [ ] تم اختبار جميع الوظائف الأساسية

### 10. نصائح إضافية

1. **استخدم Transactions للعمليات المعقدة:**
```typescript
import db from '@/lib/db';

await db.transaction(async (conn) => {
  await conn.execute('INSERT INTO students ...', [values]);
  await conn.execute('INSERT INTO student_courses ...', [values]);
});
```

2. **أضف دوال مساعدة جديدة عند الحاجة:**
```typescript
// في src/lib/api.ts
export const getStudentWithCourses = async (studentId: string) => {
  return db.query(`
    SELECT 
      s.*,
      JSON_ARRAYAGG(
        JSON_OBJECT('id', c.id, 'name', c.name)
      ) as courses
    FROM students s
    LEFT JOIN student_courses sc ON s.id = sc.student_id
    LEFT JOIN courses c ON sc.course_id = c.id
    WHERE s.id = ?
    GROUP BY s.id
  `, [studentId]);
};
```

3. **استخدم Prepared Statements دائماً لمنع SQL Injection:**
```typescript
// ✅ صحيح
const student = await db.queryOne(
  'SELECT * FROM students WHERE id = ?',
  [studentId]
);

// ❌ خطأ - عرضة لـ SQL Injection
const student = await db.queryOne(
  `SELECT * FROM students WHERE id = '${studentId}'`
);
```

## الدعم والمساعدة

إذا واجهت مشاكل:
1. تحقق من أن MySQL يعمل: `mysql -u root -p`
2. تحقق من ملف .env
3. راجع ملف MIGRATION_GUIDE.md
4. تحقق من الأخطاء في console

الملفات المرجعية:
- `database/mysql-schema.sql` - هيكل قاعدة البيانات
- `src/lib/db.ts` - الاتصال بقاعدة البيانات
- `src/lib/api.ts` - دوال API
- `database/examples/Auth-MySQL-Example.tsx` - مثال كامل
