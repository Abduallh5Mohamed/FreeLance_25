# 🧪 دليل الاختبار السريع - Quick Testing Guide

## ⚡ اختبارات يجب القيام بها الآن

### 1️⃣ اختبار Watermarks
```
✅ افتح أي فيديو
✅ تأكد من رؤية:
   - 150+ علامة صغيرة منتشرة في كل مكان
   - 3 علامات كبيرة بارزة
   - النص: "اسم الطالب: [اسمك] | المجموعة: [مجموعتك]"
```

### 2️⃣ اختبار Print Screen
```
❌ اضغط Print Screen
✅ يجب أن تظهر شاشة سوداء فوراً
✅ رسالة تسجيل خروج بعد 2 ثانية
✅ تحويل إلى صفحة تسجيل الدخول
```

### 3️⃣ اختبار Windows Snipping Tool
```
❌ اضغط Win + Shift + S
✅ يجب أن تظهر شاشة سوداء فوراً
✅ Logout فوري
```

### 4️⃣ اختبار Alt+Tab (NEW!)
```
❌ اضغط Alt + Tab
✅ شاشة سوداء فوراً
✅ الفيديو يتوقف
✅ Logout بعد 2 ثانية
```

### 5️⃣ اختبار Windows Key (NEW!)
```
❌ اضغط Windows Key (⊞)
✅ شاشة سوداء فوراً
✅ Logout فوري
✅ لا يمكن فتح Start Menu
```

### 6️⃣ اختبار Right Click
```
❌ اضغط بالزر الأيمن على الفيديو
✅ شاشة سوداء فوراً
✅ Logout فوري
```

### 7️⃣ اختبار DevTools
```
❌ اضغط F12
✅ شاشة سوداء فوراً
✅ Logout فوري
```

### 8️⃣ اختبار Screen Recording Software
```
❌ افتح OBS أو أي برنامج تسجيل شاشة
❌ حاول بدء التسجيل
✅ يجب أن تظهر شاشة سوداء
✅ الفيديو يصبح Blur + Black
```

---

## 📊 جدول النتائج المتوقعة

| الإجراء | النتيجة المتوقعة | الوقت |
|---------|------------------|-------|
| Print Screen | شاشة سوداء + Logout | فوري |
| Win + Shift + S | شاشة سوداء + Logout | فوري |
| Alt + Tab | شاشة سوداء + Logout | فوري |
| Windows Key | شاشة سوداء + Logout | فوري |
| F12 | شاشة سوداء + Logout | فوري |
| Right Click | شاشة سوداء + Logout | فوري |
| Ctrl + U | شاشة سوداء + Logout | فوري |
| Ctrl + S | شاشة سوداء + Logout | فوري |
| Window Blur | شاشة سوداء مؤقتة | فوري |
| OBS Recording | الفيديو Blur + Black | فوري |

---

## ⚠️ ملاحظات مهمة

### الشاشة السوداء:
- تظهر **فوراً** عند اكتشاف أي نشاط مشبوه
- تغطي الفيديو بالكامل
- الفيديو تحتها يصبح: `filter: blur(50px) brightness(0)`

### تسجيل الخروج:
- يحدث بعد **2 ثانية** من الشاشة السوداء
- يتم حذف جميع البيانات: `localStorage` + `sessionStorage`
- التحويل لصفحة `/auth`

### Watermarks:
- **150 علامة صغيرة**: Grid pattern (15 columns × 10 rows)
- **3 علامات كبيرة**: في مواقع استراتيجية
- **تحديث كل 10 ثواني**: Rotation + Opacity تتغير

---

## 🐛 إذا لم تعمل الحماية

### المشكلة: Print Screen لا يتم اكتشافه
**الحل:** بعض المتصفحات لا تدعم `keydown` لـ Print Screen
```javascript
// تم إضافة keyup detection
handleKeyUp(e: KeyboardEvent) {
    if (e.key === 'PrintScreen') {
        setShowBlackScreen(true);
        forceLogout('محاولة تصوير الشاشة');
    }
}
```

### المشكلة: Alt+Tab لا يعمل
**الحل:** تم إضافة detection على أكثر من مستوى
```javascript
// 1. Keyboard event
if (e.altKey && e.key === 'Tab') { ... }

// 2. Window blur
window.addEventListener('blur', handleWindowBlur);

// 3. Document hidden
document.addEventListener('visibilitychange', handleVisibilityChange);
```

### المشكلة: Windows Key لا يعمل
**الحل:** تم إضافة keyCode checks
```javascript
if (e.key === 'Meta' || e.keyCode === 91 || e.keyCode === 92) {
    setShowBlackScreen(true);
    forceLogout('محاولة فتح قائمة Start');
}
```

---

## 📱 الاختبار على أجهزة مختلفة

### Windows:
- [ ] Print Screen
- [ ] Win + Shift + S (Snipping Tool)
- [ ] Alt + Tab
- [ ] Windows Key
- [ ] Win + G (Game Bar)
- [ ] ShareX (Ctrl + Print Screen)

### Mac:
- [ ] Cmd + Shift + 3 (Full screenshot)
- [ ] Cmd + Shift + 4 (Area screenshot)
- [ ] Cmd + Shift + 5 (Screenshot menu)
- [ ] Cmd + Tab (App switcher)

### Linux:
- [ ] Print Screen
- [ ] Shift + Print Screen
- [ ] Alt + Print Screen

---

## 🎬 سيناريو الاختبار الكامل

### الخطوات:
1. سجل دخول كطالب
2. افتح أي فيديو
3. انتظر حتى يبدأ التشغيل
4. **تحقق من Watermarks**: هل تراها؟
5. **اضغط Print Screen**: هل ظهرت شاشة سوداء؟
6. سجل دخول مرة أخرى
7. افتح نفس الفيديو
8. **اضغط Alt + Tab**: هل ظهرت شاشة سوداء فوراً؟
9. سجل دخول مرة أخرى
10. **حاول التسجيل بـ OBS**: هل الفيديو أصبح أسود؟

---

## ✅ النتيجة النهائية المتوقعة

بعد كل الاختبارات، يجب أن:
- ✅ تظهر الشاشة السوداء فوراً عند أي محاولة
- ✅ Watermarks واضحة ومنتشرة في كل مكان
- ✅ لا يمكن أخذ Screenshot واضح
- ✅ لا يمكن تسجيل الفيديو
- ✅ حتى Alt+Tab يؤدي للخروج

---

## 🚀 الخطوة التالية

إذا نجحت جميع الاختبارات:
```
✅ الحماية تعمل 100%
✅ هذا أعلى مستوى أمان ممكن بدون DRM
✅ جاهز للإنتاج
```

إذا فشل أي اختبار:
```
❌ أخبرني بالضبط ما الذي لم يعمل
❌ سنضيف حماية إضافية
```

---

## 💡 Tips للاختبار

1. **افتح Console**: `Ctrl + Shift + J` (يجب أن يؤدي للخروج)
2. **افتح في Tab جديد**: `Ctrl + T` (الفيديو يتوقف)
3. **استخدم هاتف آخر**: صور الشاشة → Watermarks يجب أن تظهر
4. **جرب VM**: افتح الموقع في Virtual Machine → نفس الحماية

---

**ملاحظة مهمة:** إذا استطعت تجاوز أي من هذه الحمايات، أخبرني فوراً لإضافة طبقة أمان أقوى! 🔒
