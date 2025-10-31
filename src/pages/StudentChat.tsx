import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Send, Bot, Sparkles, Clock, CheckCheck, Loader, User } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { GlassmorphicCard } from "@/components/GlassmorphicCard";
import { useToast } from "@/hooks/use-toast";

interface Message {
  id: string;
  content: string;
  sender: 'student' | 'teacher' | 'ai';
  timestamp: Date;
  status?: 'sent' | 'delivered' | 'read';
  mode?: 'teacher' | 'ai'; // Track which chat this message belongs to
}

const StudentChat = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      content: 'السلام عليكم! أنا هنا لمساعدتك. كيف حالك؟',
      sender: 'teacher',
      timestamp: new Date(Date.now() - 3600000),
      status: 'read'
    }
  ]);
  const [newMessage, setNewMessage] = useState('');
  const [chatMode, setChatMode] = useState<'teacher' | 'ai'>('teacher');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async () => {
    if (!newMessage.trim()) return;

    const messageToSend = newMessage;
    setNewMessage('');
    setIsTyping(true);

    // Add student message with proper sender tracking
    const studentMsg: Message = {
      id: Date.now().toString(),
      content: messageToSend,
      sender: 'student',
      timestamp: new Date(),
      status: 'sent',
      mode: chatMode // Track which chat this belongs to
    };

    try {
      if (chatMode === 'ai') {
        setMessages(prev => [...prev, studentMsg]);
        // Call Google Generative AI API
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
                  parts: [{ text: messageToSend }]
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
        setIsTyping(false);

        if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          const aiResponseText = data.candidates[0].content.parts[0].text;
          const responseMsg: Message = {
            id: (Date.now() + 1).toString(),
            content: aiResponseText,
            sender: 'ai',
            timestamp: new Date(),
            status: 'delivered'
          };
          setMessages(prev => [...prev, responseMsg]);
        } else {
          const errorMsg: Message = {
            id: (Date.now() + 1).toString(),
            content: 'عذراً، لم نتمكن من الحصول على الرد من المساعد الذكي.',
            sender: 'ai',
            timestamp: new Date(),
            status: 'delivered'
          };
          setMessages(prev => [...prev, errorMsg]);
        }
      } else {
        // Teacher response (mock)
        setMessages(prev => [...prev, studentMsg]);
        setTimeout(() => {
          setIsTyping(false);
          const responseMsg: Message = {
            id: (Date.now() + 1).toString(),
            content: 'تم استلام رسالتك. سأقوم بالرد عليك قريباً إن شاء الله.',
            sender: 'teacher',
            timestamp: new Date(),
            status: 'delivered'
          };
          setMessages(prev => [...prev, responseMsg]);
        }, 1500);
      }
    } catch (error) {
      console.error('Error:', error);
      setIsTyping(false);
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        content: 'عذراً، حدث خطأ في الاتصال. يرجى المحاولة مجدداً.',
        sender: 'ai',
        timestamp: new Date(),
        status: 'delivered'
      };
      setMessages(prev => [...prev, errorMsg]);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const formatTime = (date: Date) => {
    return new Intl.DateTimeFormat('ar-EG', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };

  const getMessageBubbleClass = (sender: string) => {
    if (sender === 'student') {
      return 'bg-gradient-to-r from-primary to-primary/80 text-white ml-auto';
    }
    return 'bg-muted text-foreground mr-auto';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />
      <StudentHeader />

      <div className="container mx-auto px-4 py-6 relative z-10 max-w-7xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* Header */}
          <div className="mb-6">
            <h1 className="text-3xl font-bold mb-2 text-foreground">المحادثات</h1>
            <p className="text-muted-foreground">تواصل مع الأستاذ أو اسأل المساعد الذكي</p>
          </div>

          {/* Mode Toggle Buttons */}
          <div className="flex gap-3 mb-6">
            <Button
              onClick={() => setChatMode('teacher')}
              variant={chatMode === 'teacher' ? 'default' : 'outline'}
              className={`px-6 py-2 ${chatMode === 'teacher' ? 'bg-primary' : ''}`}
            >
              <User className="w-4 h-4 ml-2" />
              الأستاذ
            </Button>
            <Button
              onClick={() => setChatMode('ai')}
              variant={chatMode === 'ai' ? 'default' : 'outline'}
              className={`px-6 py-2 ${chatMode === 'ai' ? 'bg-purple-600' : ''}`}
            >
              <Bot className="w-4 h-4 ml-2" />
              <Sparkles className="w-4 h-4" />
              المساعد الذكي
            </Button>
          </div>

          {/* Two Containers Side by Side */}
          <div className="grid grid-cols-2 gap-6 mb-6">
            {/* Teacher Chat Container */}
            <GlassmorphicCard className={`h-[600px] flex flex-col border-2 transition-all ${chatMode === 'teacher' ? 'border-primary' : 'border-transparent'}`}>
              {/* Header */}
              <div className="border-b border-border/50 p-4 bg-primary/5">
                <div className="flex items-center gap-2 mb-1">
                  <User className="w-5 h-5 text-primary" />
                  <h2 className="text-xl font-bold text-foreground">الأستاذ</h2>
                </div>
                <p className="text-sm text-muted-foreground">محمد رمضان - التاريخ</p>
              </div>

              {/* Messages Area */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                <AnimatePresence>
                  {messages.filter(msg => msg.sender !== 'ai' && (msg.sender === 'teacher' || msg.mode === 'teacher')).map((msg) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="flex items-end gap-2"
                      style={{ justifyContent: msg.sender === 'student' ? 'flex-end' : 'flex-start' }}
                    >
                      {msg.sender !== 'student' && (
                        <Avatar className="w-8 h-8">
                          <AvatarFallback className="bg-primary text-white">أ</AvatarFallback>
                        </Avatar>
                      )}
                      
                      <div className={`max-w-[70%] rounded-2xl px-4 py-3 ${getMessageBubbleClass(msg.sender)}`}>
                        <p className="text-sm leading-relaxed">{msg.content}</p>
                        <div className="flex items-center gap-1 mt-1 text-xs opacity-70">
                          <Clock className="w-3 h-3" />
                          {formatTime(msg.timestamp)}
                        </div>
                      </div>

                      {msg.sender === 'student' && (
                        <Avatar className="w-8 h-8">
                          <AvatarFallback className="bg-gradient-to-r from-primary to-accent text-white">
                            أ
                          </AvatarFallback>
                        </Avatar>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>

                {isTyping && chatMode === 'teacher' && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2"
                  >
                    <Avatar className="w-8 h-8">
                      <AvatarFallback className="bg-primary text-white">أ</AvatarFallback>
                    </Avatar>
                    <div className="bg-muted rounded-2xl px-4 py-3">
                      <div className="flex gap-1">
                        <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0 }} className="w-2 h-2 bg-primary rounded-full" />
                        <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0.2 }} className="w-2 h-2 bg-primary rounded-full" />
                        <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0.4 }} className="w-2 h-2 bg-primary rounded-full" />
                      </div>
                    </div>
                  </motion.div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </GlassmorphicCard>

            {/* AI Chat Container */}
            <GlassmorphicCard className={`h-[600px] flex flex-col border-2 transition-all ${chatMode === 'ai' ? 'border-purple-600' : 'border-transparent'}`}>
              {/* Header */}
              <div className="border-b border-border/50 p-4 bg-purple-500/10">
                <div className="flex items-center gap-2 mb-1">
                  <Bot className="w-5 h-5 text-purple-500" />
                  <Sparkles className="w-5 h-5 text-purple-500" />
                  <h2 className="text-xl font-bold text-foreground">المساعد الذكي</h2>
                </div>
                <p className="text-sm text-muted-foreground">AI متخصص في التاريخ</p>
              </div>

              {/* Messages Area */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                <AnimatePresence>
                  {messages.filter(msg => msg.sender !== 'teacher' && (msg.sender === 'ai' || msg.mode === 'ai')).map((msg) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="flex items-end gap-2"
                      style={{ justifyContent: msg.sender === 'student' ? 'flex-end' : 'flex-start' }}
                    >
                      {msg.sender !== 'student' && (
                        <Avatar className="w-8 h-8">
                          <AvatarFallback className="bg-gradient-to-r from-purple-500 to-blue-500 text-white">
                            <Bot className="w-4 h-4" />
                          </AvatarFallback>
                        </Avatar>
                      )}
                      
                      <div className={`max-w-[70%] rounded-2xl px-4 py-3 ${getMessageBubbleClass(msg.sender)}`}>
                        <p className="text-sm leading-relaxed">{msg.content}</p>
                        <div className="flex items-center gap-1 mt-1 text-xs opacity-70">
                          <Clock className="w-3 h-3" />
                          {formatTime(msg.timestamp)}
                        </div>
                      </div>

                      {msg.sender === 'student' && (
                        <Avatar className="w-8 h-8">
                          <AvatarFallback className="bg-gradient-to-r from-primary to-accent text-white">
                            أ
                          </AvatarFallback>
                        </Avatar>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>

                {isTyping && chatMode === 'ai' && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2"
                  >
                    <Avatar className="w-8 h-8">
                      <AvatarFallback className="bg-gradient-to-r from-purple-500 to-blue-500 text-white">
                        <Bot className="w-4 h-4" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="bg-muted rounded-2xl px-4 py-3">
                      <div className="flex gap-1">
                        <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0 }} className="w-2 h-2 bg-purple-500 rounded-full" />
                        <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0.2 }} className="w-2 h-2 bg-purple-500 rounded-full" />
                        <motion.div animate={{ y: [0, -5, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0.4 }} className="w-2 h-2 bg-purple-500 rounded-full" />
                      </div>
                    </div>
                  </motion.div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </GlassmorphicCard>
          </div>

          {/* Unified Input Area */}
          <GlassmorphicCard className="p-4">
            <div className="flex gap-2">
              <Input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={chatMode === 'teacher' ? 'اكتب رسالتك للأستاذ...' : 'اسأل المساعد الذكي...'}
                className="flex-1 h-12"
              />
              <Button
                onClick={handleSendMessage}
                disabled={!newMessage.trim() || isTyping}
                className={`h-12 px-6 ${chatMode === 'teacher' ? 'bg-primary hover:bg-primary/90' : 'bg-purple-600 hover:bg-purple-700'}`}
              >
                {isTyping ? <Loader className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </Button>
            </div>
          </GlassmorphicCard>
        </motion.div>
      </div>
    </div>
  );
};

export default StudentChat;
