import express, { Response } from 'express';
import { AuthRequest, authenticateToken } from '../middleware/auth';

const router = express.Router();

// AI Chat endpoint
router.post('/chat', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;
    const apiKey = process.env.GROQ_API_KEY;

    console.log('🤖 AI Chat request received:', { message: message?.substring(0, 50), userId: req.user?.id });

    if (!message) {
      console.log('❌ AI Chat: Message is required');
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!apiKey) {
      console.log('❌ AI Chat: API key not configured');
      return res.status(503).json({ error: 'AI service is not configured' });
    }

    const systemPrompt = `أنت مساعد Tabweb Academy التعليمي الذكي الخاص بالمنصة.

📚 **تخصصك الحصري:**
- مادة التاريخ للمرحلة الثانوية المصرية (الصف الأول والثاني والثالث الثانوي)
- المنهج المصري فقط
- التاريخ الفرعوني، الإسلامي، الحديث والمعاصر

⚠️ **قواعد صارمة يجب الالتزام بها:**
1. أجب فقط على الأسئلة المتعلقة بمادة التاريخ
2. إذا سألك أحد عن أي موضوع آخر (رياضيات، فيزياء، كيمياء، أحياء، لغات، أو أي مادة أخرى)، قل له بأدب: "أنا متخصص في مادة التاريخ فقط 📖 للمرحلة الثانوية. هل لديك سؤال في التاريخ؟"
3. لا تجب عن أسئلة خارج نطاق التاريخ مهما كان السؤال
4. استخدم اللغة العربية الفصحى البسيطة
5. قدم إجابات واضحة ومختصرة ومفيدة للطالب
6. يمكنك إضافة معلومات إثرائية مفيدة للامتحان

🎓 **أسلوبك:**
- ودود ومشجع للطلاب
- استخدم الإيموجي بشكل معتدل
- قدم أمثلة من المنهج المصري
- اذكر الدروس والوحدات المرتبطة عند الإمكان

🎓 المنصة: Tabweb Academy`;

    // Try Groq models (fast and high rate limits)
    const groqModels = [
      'llama-3.3-70b-versatile',
      'llama-3.1-70b-versatile',
      'mixtral-8x7b-32768'
    ];

    let lastError;

    for (const model of groqModels) {
      try {
        console.log(`🤖 Trying Groq model: ${model}`);

        const apiResponse = await fetch(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: model,
              messages: [
                {
                  role: 'system',
                  content: systemPrompt
                },
                {
                  role: 'user',
                  content: message
                }
              ],
              temperature: 0.7,
              max_tokens: 800,
              top_p: 1
            })
          }
        );

        // Check if response has content before parsing
        const responseText = await apiResponse.text();

        if (!responseText) {
          lastError = 'Empty response from API';
          console.log(`❌ ${model}: Empty response`);
          continue;
        }

        let data;
        try {
          data = JSON.parse(responseText);
        } catch (parseError) {
          lastError = `Parse error: ${responseText.substring(0, 100)}`;
          console.log(`❌ ${model}: JSON parse failed`);
          continue;
        }

        if (apiResponse.ok && data.choices?.[0]?.message?.content) {
          const aiText = data.choices[0].message.content;
          console.log(`✅ SUCCESS with Groq model: ${model}`);
          return res.json({
            response: aiText,
            model: model
          });
        }

        lastError = data.error?.message || JSON.stringify(data).substring(0, 200);
        console.log(`❌ ${model}:`, lastError);
      } catch (err: any) {
        lastError = err.message || 'Unknown error';
        console.log(`❌ ${model} exception:`, lastError);
        continue;
      }
    }

    // If all configs failed, return detailed error
    console.error('🚨 All AI models failed. Last error:', lastError);
    
    // Check if it's a quota/rate limit error
    const isQuotaError = lastError?.includes('quota') || lastError?.includes('Quota') || 
                         lastError?.includes('rate limit') || lastError?.includes('429');
    
    if (isQuotaError) {
      return res.status(429).json({
        error: 'خدمة المساعد الذكي مشغولة حالياً',
        message: 'عذراً، خدمة المساعد الذكي وصلت للحد الأقصى من الطلبات.\n\nالرجاء المحاولة مرة أخرى بعد دقيقة أو التواصل مع الأستاذ مباشرة.',
        details: 'AI quota exceeded'
      });
    }
    
    return res.status(500).json({
      error: 'خدمة المساعد الذكي غير متاحة مؤقتاً',
      message: 'عذراً، حدث خطأ في خدمة المساعد الذكي.\n\nالرجاء المحاولة مرة أخرى لاحقاً أو التواصل مع الأستاذ.',
      details: lastError
    });

  } catch (error: any) {
    console.error('AI Chat Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
