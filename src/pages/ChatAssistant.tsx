import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, Loader } from 'lucide-react';
import Header from '@/components/Header';
import StudentHeader from '@/components/StudentHeader';
import { sendAiChatMessage } from '@/lib/api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export default function ChatAssistant() {
  // Render the correct app shell for the logged-in role: the vertical
  // sidebar (Header) for teacher/admin/instructor accounts and the
  // student top bar (StudentHeader) for students — so the sidebar never
  // disappears when this page is opened.
  const isStudent = (() => {
    try {
      const raw = localStorage.getItem('currentUser');
      if (!raw) return false;
      return JSON.parse(raw)?.role === 'student';
    } catch {
      return false;
    }
  })();

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
      const aiResponse = await sendAiChatMessage(input);

      if (aiResponse) {
        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: aiResponse,
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
      {/* App shell: sidebar for teacher/admin/instructor, top bar for students */}
      {isStudent ? <StudentHeader /> : <Header />}

      {/* Header */}
      <div className="bg-white dark:bg-slate-800 border-b border-primary/20 p-4 shadow-sm shrink-0">
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
      <div className="bg-white dark:bg-slate-800 border-t border-primary/20 p-4 shadow-lg shrink-0">
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
