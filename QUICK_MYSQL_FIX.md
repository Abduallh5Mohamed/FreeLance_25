# ⚡ الحل السريع - MySQL غير متاح

## المشكلة
```
❌ ECONNREFUSED - MySQL غير مشغّل
```

## الحل (أسهل طريقة)

### 1. افتح PowerShell كمسؤول
```
كليك يمين على PowerShell → Run as Administrator
```

### 2. شغّل MySQL
```powershell
net start MySQL80
```

### 3. الآن شغّل الخادم
```bash
cd server
npm run dev
```

### 4. يجب أن ترى:
```
✅ MySQL connection successful
✅ Server running on http://localhost:3001
```

---

## إذا لم تجد MySQL80

جرب هذه الخيارات:

```powershell
# اعرض جميع الخدمات المتعلقة بـ MySQL
Get-Service | Where-Object { $_.Name -like '*MySQL*' }

# ثم شغّل الخدمة الصحيحة (مثلاً):
net start MySQL57
# أو
net start MySQL
```

---

## بعد تشغيل MySQL

```
✅ الآن النظام يجب أن يعمل
✅ الطلاب يجب أن يظهروا
✅ الباركودات يجب أن تُنشأ بشكل صحيح
```

**جرّب الآن! 🚀**
