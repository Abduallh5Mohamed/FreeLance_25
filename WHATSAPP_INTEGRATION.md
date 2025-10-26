# دليل تكامل الواتساب مع منصة القائد

## المتطلبات الأساسية

1. **Meta Business Account**
   - قم بإنشاء حساب على [Meta for Developers](https://developers.facebook.com/)
   - أنشئ تطبيق جديد من نوع "WhatsApp Business"

2. **رقم هاتف مخصص**
   - يجب أن يكون رقم هاتف جديد غير مستخدم مع واتساب شخصي
   - يفضل استخدام رقم أعمال

3. **التحقق من الأعمال (Business Verification)**
   - قد تحتاج للتحقق من هوية الأعمال لدى Meta
   - هذا يتطلب مستندات رسمية للمنشأة التعليمية

## خطوات التفعيل

### 1. إعداد WhatsApp Business API

```bash
1. سجل الدخول إلى Meta for Developers
2. اذهب إلى تطبيقك > WhatsApp > Getting Started
3. أضف رقم الهاتف الخاص بك
4. قم بتأكيد الرقم عبر رمز التحقق
```

### 2. الحصول على Access Token

```bash
1. من لوحة تحكم Meta Business
2. اذهب إلى System Users > Create System User
3. اختر Permissions: whatsapp_business_management, whatsapp_business_messaging
4. احفظ الـ Access Token (سيستخدم مرة واحدة فقط!)
```

### 3. الحصول على Phone Number ID

```bash
1. من لوحة WhatsApp > API Setup
2. انسخ الـ "Phone Number ID" (مختلف عن رقم الهاتف)
3. انسخ الـ "WhatsApp Business Account ID"
```

### 4. إضافة Webhook للاستقبال

```bash
1. في لوحة WhatsApp > Configuration
2. أضف Webhook URL:
   https://mofdqmtyjgzlkrnmkbsa.supabase.co/functions/v1/whatsapp-webhook

3. Verify Token: اختر كلمة سر قوية (سنحتاجها لاحقاً)
4. اشترك في Events: messages (لاستقبال الرسائل)
```

## إضافة المفاتيح السرية في Lovable

بعد الحصول على المفاتيح، أضفها في Lovable:

```typescript
// المفاتيح المطلوبة:
WHATSAPP_ACCESS_TOKEN     // من Meta Business
WHATSAPP_PHONE_NUMBER_ID  // من WhatsApp API Setup
WHATSAPP_VERIFY_TOKEN     // الذي اخترته للـ Webhook
WHATSAPP_BUSINESS_ID      // من WhatsApp API Setup
```

## الميزات المتاحة

### 1. إرسال رسائل للطلاب
- إشعارات الحضور
- تنبيهات الامتحانات
- تذكير بالواجبات
- إرسال المحتوى التعليمي

### 2. استقبال رسائل من الطلاب
- الأسئلة والاستفسارات
- طلبات المساعدة
- الشكاوى والاقتراحات

### 3. الرد الآلي بالـ AI
- ربط الواتساب مع المساعد الذكي
- ردود تلقائية على الأسئلة الشائعة
- توجيه الرسائل المهمة للأدمن

## التكاليف المتوقعة

### أسعار Meta WhatsApp Business API (تقريبية):
- **أول 1000 محادثة شهرياً**: مجانية
- **بعد ذلك**: 
  - محادثة مع الطالب: ~$0.005 - $0.01
  - إشعارات للطالب: ~$0.005

### نصيحة للتوفير:
- استخدم الواتساب للإشعارات المهمة فقط
- شجع الطلاب على استخدام الشات الداخلي للأسئلة العادية
- استخدم الواتساب للتذكيرات والتنبيهات الهامة

## الخطوات التالية

بعد الحصول على المفاتيح:

1. **أضف المفاتيح في Lovable** (سأساعدك في هذا)
2. **سأنشئ Edge Function لإرسال واستقبال رسائل الواتساب**
3. **سأربط الواتساب مع المساعد الذكي**
4. **سأضيف واجهة في لوحة الأدمن لإرسال رسائل جماعية**

## روابط مفيدة

- [Meta for Developers - WhatsApp](https://developers.facebook.com/docs/whatsapp)
- [WhatsApp Business API Pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- [Get Started with WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started)

## ملاحظات هامة

⚠️ **تحذيرات:**
- لا تشارك الـ Access Token مع أحد
- قم بتجديد الـ Token بشكل دوري (كل 90 يوم)
- تأكد من الالتزام بسياسات Meta لتجنب حظر الحساب

✅ **أفضل الممارسات:**
- لا ترسل رسائل spam
- احصل على موافقة الطلاب قبل إرسال الرسائل
- استخدم قوالب رسائل معتمدة من Meta للإشعارات
- راقب استخدامك لتجنب تجاوز الحد المجاني

---

## هل أنت جاهز؟

عندما تحصل على:
1. WHATSAPP_ACCESS_TOKEN
2. WHATSAPP_PHONE_NUMBER_ID  
3. WHATSAPP_VERIFY_TOKEN
4. WHATSAPP_BUSINESS_ID

أخبرني وسأكمل التكامل! 🚀
