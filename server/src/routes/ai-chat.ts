import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Authentication middleware
interface AuthRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// AI Chat endpoint
router.post('/chat', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!apiKey) {
      return res.status(500).json({ error: 'AI API key not configured' });
    }

    const systemPrompt = `أنت مساعد تعليمي ذكي متخصص في مادة التاريخ للمرحلة الثانوية المصرية. 
أجب على أسئلة الطلاب بطريقة واضحة ومفيدة باللغة العربية.`;

    // Try different API versions and models (updated for 2026)
    const apiConfigs = [
      { version: 'v1', model: 'gemini-2.5-flash' },
      { version: 'v1', model: 'gemini-2.0-flash' },
      { version: 'v1', model: 'gemini-2.5-pro' },
      { version: 'v1beta', model: 'gemini-2.5-flash' },
      { version: 'v1beta', model: 'gemini-2.0-flash' }
    ];

    let lastError;

    for (const config of apiConfigs) {
      try {
        console.log(`🤖 Trying ${config.version}/models/${config.model}`);

        const apiResponse = await fetch(
          `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{ text: `${systemPrompt}\n\nسؤال الطالب: ${message}` }]
              }],
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 800,
              }
            })
          }
        );

        // Check if response has content before parsing
        const responseText = await apiResponse.text();

        if (!responseText) {
          lastError = 'Empty response from API';
          console.log(`❌ ${config.version}/${config.model}: Empty response`);
          continue;
        }

        let data;
        try {
          data = JSON.parse(responseText);
        } catch (parseError) {
          lastError = `Parse error: ${responseText.substring(0, 100)}`;
          console.log(`❌ ${config.version}/${config.model}: JSON parse failed`);
          continue;
        }

        if (apiResponse.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          const aiText = data.candidates[0].content.parts[0].text;
          console.log(`✅ SUCCESS with ${config.version}/${config.model}`);
          return res.json({
            response: aiText,
            model: `${config.version}/${config.model}`
          });
        }

        lastError = data.error?.message || JSON.stringify(data).substring(0, 200);
        console.log(`❌ ${config.version}/${config.model}:`, lastError);
      } catch (err: any) {
        lastError = err.message || 'Unknown error';
        console.log(`❌ ${config.version}/${config.model} exception:`, lastError);
        continue;
      }
    }

    // If all configs failed, return detailed error
    console.error('🚨 All AI models failed. Last error:', lastError);
    return res.status(500).json({
      error: 'AI service temporarily unavailable',
      details: lastError
    });

  } catch (error: any) {
    console.error('AI Chat Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
