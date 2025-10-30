import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Send, Loader } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export default function ChatAssistant() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'assistant',
      content: 'السلام عليكم! أنا مساعدك الذكي المتخصص في مادة التاريخ. كيف يمكنني مساعدتك اليوم؟',
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      // Call Google Generative AI API directly
      const googleApiKey = 'AIzaSyAm-hpg9pjc66DqNnS8qHpdgeKBd-FZP70';
      
      const systemPrompt = `أنت مساعد ذكي تعليمي متخصص حصراً في مساعدة طلاب المرحلة الثانوية المصريين في دراسة التاريخ.

وظيفتك الأساسية:
- شرح الأحداث التاريخية والشخصيات والفترات بوضوح ودقة
- مساعدة الطلاب على فهم دروس المنهج المصري للتاريخ
- تقديم ملخصات وتحليلات ومقارنات للأحداث التاريخية
- الإجابة على أسئلة من نمط الامتحانات
- مساعدة الطالب على كتابة الإجابات الطويلة

رد دائماً بالعربية فقط، وكن ودوداً وصبوراً - بدو كمعلم مختص وليس روبوت.`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`,
        {
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
                parts: [{ text: input }]
              }
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 1000,
              topK: 40,
              topP: 0.95,
            },
          }),
        }
      );

      const data = await response.json();

      if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.candidates[0].content.parts[0].text,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } else {
        const errorMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: 'عذراً، لم نتمكن من الحصول على الرد من المساعد الذكي.',
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      }
    } catch (error) {
      console.error('Error:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'عذراً، حدث خطأ في الاتصال. يرجى المحاولة مجدداً.',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-full flex flex-col bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-800 border-b border-primary/20 p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <span className="text-lg">🤖</span>
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">مساعد التاريخ الذكي</h1>
            <p className="text-sm text-muted-foreground">متخصص في شرح دروس التاريخ</p>
          </div>
        </div>
      </div>

      {/* Messages Container - FIXED SIZE, NO SCROLL OUTSIDE */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-4"
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === 'user' ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`max-w-xs lg:max-w-md xl:max-w-lg px-4 py-3 rounded-lg ${
                message.role === 'user'
                  ? 'bg-primary text-white rounded-bl-none'
                  : 'bg-white dark:bg-slate-800 text-foreground border border-primary/20 rounded-br-none shadow-sm'
              }`}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
              <span className={`text-xs mt-2 block ${
                message.role === 'user' ? 'text-blue-100' : 'text-muted-foreground'
              }`}>
                {message.timestamp.toLocaleTimeString('ar-EG', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-end">
            <div className="bg-white dark:bg-slate-800 text-foreground border border-primary/20 px-4 py-3 rounded-lg rounded-br-none shadow-sm flex items-center gap-2">
              <Loader className="w-4 h-4 animate-spin text-primary" />
              <span className="text-sm">جاري الكتابة...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area - FIXED AT BOTTOM */}
      <div className="bg-white dark:bg-slate-800 border-t border-primary/20 p-4 shadow-lg">
        <form onSubmit={sendMessage} className="flex gap-2">
          <Input
            type="text"
            placeholder="اسأل عن التاريخ..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            className="flex-1 bg-slate-50 dark:bg-slate-700 border-primary/20 placeholder:text-muted-foreground"
          />
          <Button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-primary hover:bg-primary/90 text-white px-4"
          >
            <Send className="w-4 h-4" />
          </Button>
        </form>
        <p className="text-xs text-muted-foreground mt-2">
          💡 نصيحة: اسأل عن أي موضوع تاريخي أو معادلة أو إجابة امتحان
        </p>
      </div>
    </div>
  );
}
