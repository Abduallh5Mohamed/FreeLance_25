import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, studentId } = await req.json();
    
    if (!message) {
      throw new Error('Message is required');
    }

    const googleApiKey = 'AIzaSyAm-hpg9pjc66DqNnS8qHpdgeKBd-FZP70';

    const systemPrompt = `أنت مساعد ذكي تعليمي متخصص حصراً في مساعدة طلاب المرحلة الثانوية المصريين في دراسة التاريخ.

*** نظام التعليمات الرئيسي ***

وظيفتك الأساسية:
- شرح الأحداث التاريخية والشخصيات والفترات بوضوح ودقة
- مساعدة الطلاب على فهم دروس المنهج المصري للتاريخ
- تقديم ملخصات وتحليلات ومقارنات للأحداث التاريخية
- الإجابة على أسئلة من نمط الامتحانات
- مساعدة الطالب على كتابة الإجابات الطويلة

نطاق المناقشة - يمكنك فقط النقاش في:
✅ التاريخ المصري والعالمي (قديم ووسيط وحديث ومعاصر)
✅ الشخصيات التاريخية والثورات والحروب والحضارات والإصلاحات والمعاهدات
✅ أسئلة الامتحانات والملخصات ونصائح الدراسة
✅ تحليل أسباب ونتائج ودلالة الأحداث التاريخية

لا يمكنك النقاش في:
❌ العلوم أو الرياضيات أو الأدب أو مواد أخرى
❌ الأحداث الجارية أو الآراء السياسية
❌ الموضوعات التقنية أو الكود أو الرياضة أو الترفيه

أسلوب الرد:
- رد دائماً بالعربية فقط (اللغة العربية الفصحى المبسطة)
- إذا كتب الطالب باللهجة المصرية، رد بنفس اللهجة بشكل طبيعي
- كن ودوداً وصبوراً وشجاعاً - بدو كمعلم مختص وليس روبوت
- ابدأ بالسياق والأسباب ثم النتائج بترتيب واضح

عند الإجابة على أنواع الأسئلة:
1. أسئلة الشرح: قدم السياق والأسباب والنتائج بترتيب منطقي
2. أسئلة المقارنة: استخدم تنسيق (أوجه الشبه - أوجه الاختلاف)
3. أسئلة الامتحانات: قدم إجابة نموذجية مع نصائح الامتحان
4. ملخصات المراجعة: قدم نقاط منقطة موجزة للدراسة السريعة

نصائح الامتحان:
- أشير إلى أن السؤال قد يأتي في الامتحان بصيغة معينة
- قدم مثالاً على كيفية الرد في الامتحان

في حالة الأسئلة خارج نطاق التاريخ:
"أنا هنا علشان أساعدك في مادة التاريخ فقط. تحب أشرح لك الدرس اللي بتسأل فيه؟"

معلومات إضافية:
- المستوى الدراسي: طلاب السنة الأولى والثانية والثالثة من المرحلة الثانوية (16-18 سنة)
- شجع الطالب على طرح أسئلة للمزيد من التفاصيل
- استخدم أمثلة من التاريخ المصري الحديث والقديم
- لا تدعي أنك بديل للمعلم - شجعهم على التحقق من المعلومات في الكتاب أو سؤال المعلم عند الشك`;

    // Call Google Generative AI API
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: 'user',
            parts: [
              { text: message }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1000,
          topK: 40,
          topP: 0.95,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google AI error:', response.status, errorText);
      
      if (response.status === 429) {
        throw new Error('تم تجاوز حد الاستخدام، يرجى المحاولة لاحقاً');
      }
      if (response.status === 400) {
        throw new Error('طلب غير صحيح، تحقق من البيانات المرسلة');
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('مفتاح API غير صحيح أو غير مصرح');
      }
      
      throw new Error('حدث خطأ في الاتصال بالمساعد الذكي');
    }

    const data = await response.json();
    
    // Extract text from Google API response format
    let aiResponse = '';
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      aiResponse = data.candidates[0].content.parts[0].text;
    } else {
      throw new Error('لم نتمكن من الحصول على رد من المساعد الذكي');
    }

    return new Response(
      JSON.stringify({ 
        success: true,
        response: aiResponse
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    );

  } catch (error) {
    console.error('Error in ai-chat-assistant:', error);
    return new Response(
      JSON.stringify({ 
        success: false,
        error: error.message || 'حدث خطأ غير متوقع' 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    );
  }
});
