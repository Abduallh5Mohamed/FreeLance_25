import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Send, Bot, User, Sparkles, Clock, CheckCheck } from "lucide-react";
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
}

const StudentChat = () => {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      content: 'مرحباً! كيف يمكنني مساعدتك اليوم؟',
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

    const studentMsg: Message = {
      id: Date.now().toString(),
      content: newMessage,
      sender: 'student',
      timestamp: new Date(),
      status: 'sent'
    };

    setMessages(prev => [...prev, studentMsg]);
    setNewMessage('');
    setIsTyping(true);

    // Simulate response
    setTimeout(() => {
      setIsTyping(false);
      const responseMsg: Message = {
        id: (Date.now() + 1).toString(),
        content: chatMode === 'ai' 
          ? `شكراً على سؤالك! ${newMessage.includes('امتحان') ? 'الامتحان القادم يوم الأحد الساعة 10 صباحاً. استعد جيداً!' : 'أنا هنا للمساعدة في أي استفسار تعليمي.'}`
          : `تم استلام رسالتك. سأقوم بالرد عليك قريباً إن شاء الله.`,
        sender: chatMode === 'ai' ? 'ai' : 'teacher',
        timestamp: new Date(),
        status: 'delivered'
      };
      setMessages(prev => [...prev, responseMsg]);
    }, 1500);
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

      <div className="container mx-auto px-4 py-6 relative z-10 max-w-5xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* Chat Mode Toggle */}
          <GlassmorphicCard className="mb-6">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-2xl font-bold flex items-center gap-2">
                  <MessageSquare className="w-6 h-6" />
                  المحادثات
                </CardTitle>
                <div className="flex gap-2">
                  <Button
                    variant={chatMode === 'teacher' ? 'default' : 'outline'}
                    onClick={() => setChatMode('teacher')}
                    className="gap-2"
                  >
                    <User className="w-4 h-4" />
                    الأستاذ
                  </Button>
                  <Button
                    variant={chatMode === 'ai' ? 'default' : 'outline'}
                    onClick={() => {
                      setChatMode('ai');
                      toast({
                        title: "وضع المساعد الذكي",
                        description: "يمكنك الآن طرح أسئلتك على المساعد الذكي",
                      });
                    }}
                    className="gap-2"
                  >
                    <Bot className="w-4 h-4" />
                    <Sparkles className="w-4 h-4" />
                    AI
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                {chatMode === 'teacher' 
                  ? 'تواصل مباشر مع الأستاذ محمد رمضان'
                  : 'مساعد ذكي متاح 24/7 للإجابة على استفساراتك'}
              </p>
            </CardHeader>
          </GlassmorphicCard>

          {/* Chat Window */}
          <GlassmorphicCard className="h-[600px] flex flex-col">
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <AnimatePresence>
                {messages.map((msg) => (
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
                        <AvatarFallback className={msg.sender === 'ai' ? 'bg-gradient-to-r from-purple-500 to-blue-500 text-white' : 'bg-primary text-white'}>
                          {msg.sender === 'ai' ? <Bot className="w-4 h-4" /> : 'أ'}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    
                    <div className={`max-w-[70%] rounded-2xl px-4 py-3 ${getMessageBubbleClass(msg.sender)}`}>
                      <p className="text-sm leading-relaxed">{msg.content}</p>
                      <div className="flex items-center gap-1 mt-1 text-xs opacity-70">
                        <Clock className="w-3 h-3" />
                        {formatTime(msg.timestamp)}
                        {msg.sender === 'student' && msg.status === 'read' && (
                          <CheckCheck className="w-4 h-4 text-blue-400" />
                        )}
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

              {/* Typing Indicator */}
              <AnimatePresence>
                {isTyping && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-2"
                  >
                    <Avatar className="w-8 h-8">
                      <AvatarFallback className={chatMode === 'ai' ? 'bg-gradient-to-r from-purple-500 to-blue-500 text-white' : 'bg-primary text-white'}>
                        {chatMode === 'ai' ? <Bot className="w-4 h-4" /> : 'أ'}
                      </AvatarFallback>
                    </Avatar>
                    <div className="bg-muted rounded-2xl px-4 py-3">
                      <div className="flex gap-1">
                        <motion.div
                          animate={{ y: [0, -5, 0] }}
                          transition={{ duration: 0.6, repeat: Infinity, delay: 0 }}
                          className="w-2 h-2 bg-primary rounded-full"
                        />
                        <motion.div
                          animate={{ y: [0, -5, 0] }}
                          transition={{ duration: 0.6, repeat: Infinity, delay: 0.2 }}
                          className="w-2 h-2 bg-primary rounded-full"
                        />
                        <motion.div
                          animate={{ y: [0, -5, 0] }}
                          transition={{ duration: 0.6, repeat: Infinity, delay: 0.4 }}
                          className="w-2 h-2 bg-primary rounded-full"
                        />
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="border-t border-border/50 p-4 bg-background/50 backdrop-blur-sm">
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
                  disabled={!newMessage.trim()}
                  className="h-12 px-6 bg-gradient-to-r from-primary to-accent hover:shadow-lg"
                >
                  <Send className="w-5 h-5" />
                </Button>
              </div>
            </div>
          </GlassmorphicCard>
        </motion.div>
      </div>
    </div>
  );
};

export default StudentChat;
