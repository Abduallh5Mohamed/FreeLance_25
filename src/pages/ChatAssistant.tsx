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
      // Call Groq API directly
      const groqApiKey = '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';
      
      const systemPrompt = `أنت مساعد ذكي تعليمي متخصص حصراً في مساعدة طلاب المرحلة الثانوية المصريين في دراسة التاريخ.

وظيفتك الأساسية:
- شرح الأحداث التاريخية والشخصيات والفترات بوضوح ودقة
- مساعدة الطلاب على فهم دروس المنهج المصري للتاريخ
- تقديم ملخصات وتحليلات ومقارنات للأحداث التاريخية
- الإجابة على أسئلة من نمط الامتحانات
- مساعدة الطالب على كتابة الإجابات الطويلة

رد دائماً بالعربية فقط، وكن ودوداً وصبوراً - بدو كمعلم مختص وليس روبوت.`;

      const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${groqApiKey}`,
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              {
                role: 'system',
                content: systemPrompt
              },
              {
                role: 'user',
                content: input
              }
            ],
            temperature: 0.7,
            max_tokens: 1000,
          }),
        }
      );

      const data = await response.json();

      if (response.ok && data.choices?.[0]?.message?.content) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: data.choices[0].message.content,
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
    <div className="min-h-screen w-full flex flex-col bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      {/* Header */}
      {/* NavBar - شبيه واتساب */}
      <div className="sticky top-0 left-0 w-full z-30 bg-gradient-to-br from-primary/90 to-cyan-700 dark:from-slate-900 dark:to-cyan-950 border-b border-primary/30 p-3 flex items-center gap-3 shadow-lg">
        <div className="w-10 h-10 bg-white/20 dark:bg-slate-700/40 rounded-lg flex items-center justify-center">
          <span className="text-lg">🤖</span>
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg md:text-xl font-bold text-white truncate">مساعد التاريخ الذكي</h1>
          <p className="text-xs md:text-sm text-cyan-100 truncate">متخصص في شرح دروس التاريخ</p>
        </div>
      </div>

      {/* Messages Container - FIXED SIZE, NO SCROLL OUTSIDE */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto px-1 py-2 md:px-4 md:py-6 space-y-3 md:space-y-4 mb-[90px] md:mb-0 bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950"
        style={{scrollBehavior:'smooth', WebkitOverflowScrolling:'touch'}}
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${message.role === 'user' ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`max-w-[85vw] sm:max-w-xs md:max-w-md xl:max-w-lg px-4 py-3 rounded-2xl shadow-md ${
                  message.role === 'user'
                    ? 'bg-primary text-white rounded-bl-none'
                    : 'bg-white dark:bg-slate-800 text-foreground border border-primary/20 rounded-br-none'
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
      <div className="fixed bottom-0 left-0 w-full z-40 bg-white/95 dark:bg-slate-800/95 border-t border-primary/20 p-2 md:p-4 shadow-2xl backdrop-blur-md flex flex-col" style={{maxWidth:'100vw'}}>
        <form onSubmit={sendMessage} className="flex gap-2 w-full items-end">
          <textarea
            rows={1}
            placeholder="اكتب رسالة..."
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={loading}
            className="flex-1 resize-none bg-slate-50 dark:bg-slate-700 border border-primary/20 placeholder:text-muted-foreground text-base md:text-lg py-2 md:py-3 px-3 md:px-4 rounded-2xl focus:ring-2 focus:ring-primary/40 min-h-[44px] max-h-[120px] transition-all duration-200 shadow-inner"
            style={{fontFamily:'inherit',lineHeight:'1.7'}}
            onFocus={e => { e.target.scrollIntoView({behavior:'smooth',block:'center'}); }}
          />
          <Button
            type="submit"
            disabled={loading || !input.trim()}
            className="bg-primary hover:bg-primary/90 text-white px-4 py-2 md:py-3 rounded-2xl text-base md:text-lg min-w-[44px] min-h-[44px] flex items-center justify-center shadow-lg"
            aria-label="إرسال"
            style={{boxShadow:'0 2px 8px 0 #06b6d4a0'}}
          >
            <Send className="w-5 h-5" />
          </Button>
        </form>
        <p className="text-xs text-muted-foreground mt-2 text-center md:text-right select-none">
          💡 نصيحة: اسأل عن أي موضوع تاريخي أو معادلة أو إجابة امتحان
        </p>
      </div>
    </div>
  );
}
