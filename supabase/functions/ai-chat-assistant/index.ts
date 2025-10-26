import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    
    if (!message || !studentId) {
      throw new Error('Message and studentId are required');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const lovableApiKey = Deno.env.get('LOVABLE_API_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get student info and enrolled courses
    const { data: student, error: studentError } = await supabase
      .from('students')
      .select(`
        id,
        name,
        grade,
        student_courses (
          courses (
            id,
            name,
            subject,
            description
          )
        )
      `)
      .eq('id', studentId)
      .single();

    if (studentError) {
      console.error('Error fetching student:', studentError);
      throw new Error('Failed to fetch student data');
    }

    // Get course materials for student's enrolled courses
    const courseIds = student.student_courses?.map(sc => sc.courses.id) || [];
    let courseMaterials = [];
    
    if (courseIds.length > 0) {
      const { data: materials } = await supabase
        .from('course_materials')
        .select('id, title, description, courses(name, subject)')
        .in('course_id', courseIds)
        .limit(10);
      
      courseMaterials = materials || [];
    }

    // Prepare context for AI
    const courses = student.student_courses?.map(sc => sc.courses) || [];
    const coursesInfo = courses.map(c => 
      `- ${c.name} (${c.subject})${c.description ? ': ' + c.description : ''}`
    ).join('\n');
    
    const materialsInfo = courseMaterials.map(m =>
      `- ${m.title} من كورس ${m.courses.name}${m.description ? ': ' + m.description : ''}`
    ).join('\n');

    const systemPrompt = `أنت مساعد ذكي لمنصة القائد التعليمية للأستاذ محمد رمضان (التاريخ والجغرافيا).

معلومات الطالب:
- الاسم: ${student.name}
- الصف: ${student.grade}

الكورسات المسجل فيها الطالب:
${coursesInfo || 'لم يسجل في أي كورسات بعد'}

المحتوى التعليمي المتاح:
${materialsInfo || 'لا يوجد محتوى متاح حالياً'}

دورك:
1. الإجابة على أسئلة الطلاب المتعلقة بالتاريخ والجغرافيا
2. شرح المواضيع الدراسية بطريقة بسيطة ومفهومة
3. مساعدة الطلاب في فهم المحتوى التعليمي
4. تقديم نصائح دراسية مفيدة
5. الرد بالعربية دائماً

إذا سأل الطالب عن:
- معلومات شخصية → ارجع لمعلوماته أعلاه
- كورساته → اذكر الكورسات المسجل فيها
- محتوى تعليمي → اشرح بناءً على المحتوى المتاح
- أسئلة عامة في التاريخ/الجغرافيا → أجب بناءً على معرفتك

ملاحظات مهمة:
- كن لطيفاً ومشجعاً
- استخدم أمثلة من التاريخ المصري والعربي عند الحاجة
- إذا لم تكن متأكداً من إجابة، أخبر الطالب أن يسأل الأستاذ محمد رمضان مباشرة
- لا تقدم معلومات خاطئة أو مضللة`;

    // Call Lovable AI Gateway
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', response.status, errorText);
      
      if (response.status === 429) {
        throw new Error('تم تجاوز حد الاستخدام، يرجى المحاولة لاحقاً');
      }
      if (response.status === 402) {
        throw new Error('الرصيد غير كافٍ، يرجى التواصل مع الإدارة');
      }
      
      throw new Error('حدث خطأ في الاتصال بالمساعد الذكي');
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    return new Response(
      JSON.stringify({ 
        success: true,
        response: aiResponse,
        studentName: student.name
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
