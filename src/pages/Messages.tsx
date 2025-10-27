import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MessageCircle, Send, User, Bot, Sparkles, Zap, Star, MessageSquare } from "lucide-react";
import Header from "@/components/Header";
import StudentHeader from "@/components/StudentHeader";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";

const Messages = () => {
  const [messages, setMessages] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [newMessage, setNewMessage] = useState("");
  const [conversations, setConversations] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [isStudent, setIsStudent] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [showAiHelper, setShowAiHelper] = useState(false);
  const [isAiMode, setIsAiMode] = useState(false); // New state for AI mode toggle
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  const { toast } = useToast();

  // Auto scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    checkUserRole();
  }, []);

  useEffect(() => {
    if (currentUser) {
      fetchConversations();
    }
  }, [currentUser, isStudent]);

  const checkUserRole = async () => {
    try {
      // Check for admin user FIRST
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setCurrentUser({ email: user.email, type: 'admin' });
        setIsStudent(false);
        return; // Stop here if admin
      }

      // Check if this is an offline student
      const offlineSession = localStorage.getItem('offlineStudentSession');
      if (offlineSession) {
        const session = JSON.parse(offlineSession);
        const isValid = new Date().getTime() - session.timestamp < 24 * 60 * 60 * 1000;
        
        if (isValid) {
          setCurrentUser({ 
            email: session.student.email, 
            studentId: session.student.id,
            type: 'student' 
          });
          setIsStudent(true);
          return;
        } else {
          localStorage.removeItem('offlineStudentSession');
        }
      }

      // Check if student is logged in via temporary session
      const studentSession = localStorage.getItem('student_session');
      
      if (studentSession) {
        const session = JSON.parse(studentSession);
        // Check if session is still valid (24 hours)
        if (Date.now() - session.loginTime < 24 * 60 * 60 * 1000) {
          setCurrentUser({ email: session.email, type: 'student' });
          setIsStudent(true);
          return;
        } else {
          localStorage.removeItem('student_session');
        }
      }
    } catch (error) {
      console.error('Error checking user role:', error);
    }
  };

  const fetchConversations = async () => {
    try {
      if (!currentUser) return;

      if (isStudent) {
        // For students, fetch their messages with admin
        // Use studentId from currentUser if available (for offline students)
        let studentId = currentUser.studentId;
        let studentName = '';
        
        if (!studentId) {
          // If no studentId, fetch from students table
          console.log('🔍 Fetching student by email:', currentUser.email);
          const { data: studentData, error: studentError } = await supabase
            .from('students')
            .select('id, name')
            .eq('email', currentUser.email)
            .maybeSingle();

          if (studentError) {
            console.error('❌ Error fetching student:', studentError);
            toast({
              title: "خطأ",
              description: "لم يتم العثور على بيانات الطالب",
              variant: "destructive"
            });
            return;
          }

          if (!studentData) {
            console.error('❌ Student not found with email:', currentUser.email);
            toast({
              title: "خطأ",
              description: "لم يتم العثور على حساب الطالب",
              variant: "destructive"
            });
            return;
          }
          
          studentId = studentData.id;
          studentName = studentData.name;
        } else {
          // Fetch student name
          const { data: studentData } = await supabase
            .from('students')
            .select('name')
            .eq('id', studentId)
            .maybeSingle();
          
          studentName = studentData?.name || '';
        }

        console.log('✅ Student ID found:', studentId);
        console.log('✅ Student Name:', studentName);

        // Set conversation FIRST, before fetching messages
        setSelectedConversation({ 
          id: 'admin', 
          studentName: 'الأستاذ محمد رمضان', 
          studentId: studentId 
        });

        const { data: messagesData, error: messagesError } = await supabase
          .from('teacher_messages')
          .select('*')
          .eq('student_id', studentId)
          .order('sent_at', { ascending: true });

        if (messagesError) {
          console.error('❌ Error fetching messages:', messagesError);
        }

        // Format messages
        const formattedMessages = messagesData?.map(msg => ({
          ...msg,
          isFromTeacher: !msg.sender_id,
          isAi: false,
          time: new Date(msg.sent_at).toLocaleTimeString('ar-SA', { 
            hour: '2-digit', 
            minute: '2-digit' 
          })
        })) || [];

        setMessages(formattedMessages);
      } else {
        // For admin, fetch all conversations with students
        const { data: messagesData } = await supabase
          .from('teacher_messages')
          .select('*, student_id')
          .order('sent_at', { ascending: false });

        // Get unique students who have sent messages
        const studentIds = [...new Set(messagesData?.map(m => m.student_id).filter(Boolean))];
        
        if (studentIds.length > 0) {
          const { data: studentsData } = await supabase
            .from('students')
            .select('id, name, email')
            .in('id', studentIds);

          // Group messages by student
          const conversationsMap = new Map();
          studentsData?.forEach(student => {
            const studentMessages = messagesData?.filter(m => m.student_id === student.id);
            const lastMessage = studentMessages?.[0];
            
            conversationsMap.set(student.id, {
              id: student.id,
              studentName: student.name,
              studentEmail: student.email,
              lastMessage: lastMessage?.message_text?.substring(0, 50) + '...' || 'لا توجد رسائل',
              lastMessageTime: lastMessage?.sent_at
            });
          });

          setConversations(Array.from(conversationsMap.values()));
        }
      }
    } catch (error) {
      console.error('Error fetching conversations:', error);
    }
  };

  const loadMessagesForConversation = async (conversationId) => {
    try {
      const { data: messagesData } = await supabase
        .from('teacher_messages')
        .select('*')
        .eq('student_id', conversationId)
        .order('sent_at', { ascending: true });

      // Add a property to identify if message is from teacher (admin)
      const formattedMessages = messagesData?.map(msg => ({
        ...msg,
        isFromTeacher: !msg.sender_id, // If sender_id is null, it's from teacher
        time: new Date(msg.sent_at).toLocaleTimeString('ar-SA', { 
          hour: '2-digit', 
          minute: '2-digit' 
        })
      })) || [];

      setMessages(formattedMessages);
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  const askAiAssistant = async () => {
    if (!newMessage.trim() || !currentUser || !isStudent) return;
    
    setIsAiLoading(true);
    
    try {
      const { data: studentData } = await supabase
        .from('students')
        .select('id')
        .eq('email', currentUser.email)
        .single();

      if (!studentData) throw new Error('Student not found');

      // Add user question to messages immediately
      const userMessageObj = {
        id: Date.now().toString(),
        message_text: newMessage,
        sender_id: studentData.id,
        student_id: studentData.id,
        sent_at: new Date().toISOString(),
        isFromTeacher: false,
        isAi: false,
        time: new Date().toLocaleTimeString('ar-SA', { 
          hour: '2-digit', 
          minute: '2-digit' 
        })
      };
      setMessages(prevMessages => [...prevMessages, userMessageObj]);

      const userQuestion = newMessage;
      setNewMessage("");

      // Call AI assistant
      const { data, error } = await supabase.functions.invoke('ai-chat-assistant', {
        body: { 
          message: userQuestion,
          studentId: studentData.id
        }
      });

      if (error) throw error;

      if (data.success) {
        // Add AI response to messages
        const aiMessageObj = {
          id: (Date.now() + 1).toString(),
          message_text: data.response,
          sender_id: null,
          student_id: studentData.id,
          sent_at: new Date().toISOString(),
          isFromTeacher: false,
          isAi: true,
          time: new Date().toLocaleTimeString('ar-SA', { 
            hour: '2-digit', 
            minute: '2-digit' 
          })
        };
        setMessages(prevMessages => [...prevMessages, aiMessageObj]);

        toast({
          title: "المساعد الذكي",
          description: "تم الحصول على الإجابة بنجاح",
        });
      } else {
        throw new Error(data.error || 'Failed to get AI response');
      }
    } catch (error) {
      console.error('Error calling AI assistant:', error);
      toast({
        title: "خطأ",
        description: error.message || "فشل الاتصال بالمساعد الذكي",
        variant: "destructive",
      });
    } finally {
      setIsAiLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!newMessage.trim() || !currentUser) {
      console.log('⚠️ Cannot send: empty message or no user');
      return;
    }
    
    console.log('📤 Attempting to send message...');
    console.log('Current user:', currentUser);
    console.log('Is student:', isStudent);
    console.log('Selected conversation:', selectedConversation);
    
    try {
      if (isStudent) {
        // Student sending message to admin
        // Use studentId from selectedConversation first, fallback to currentUser
        let studentId = selectedConversation?.studentId || currentUser.studentId;
        
        if (!studentId) {
          console.log('🔍 No studentId in context, fetching from database...');
          // If no studentId, fetch from students table
          const { data: studentData, error: fetchError } = await supabase
            .from('students')
            .select('id')
            .eq('email', currentUser.email)
            .maybeSingle();

          if (fetchError) {
            console.error('❌ Error fetching student:', fetchError);
            throw new Error('فشل في العثور على بيانات الطالب: ' + fetchError.message);
          }

          if (!studentData) {
            console.error('❌ Student not found with email:', currentUser.email);
            throw new Error('لم يتم العثور على حساب الطالب');
          }
          studentId = studentData.id;
        }

        console.log('✅ Using student ID:', studentId);
        console.log('📝 Message text:', newMessage);

        const { data: insertedData, error: insertError } = await supabase
          .from('teacher_messages')
          .insert({
            sender_id: studentId,
            message_text: newMessage,
            student_id: studentId
          })
          .select();

        if (insertError) {
          console.error('❌ Insert error:', insertError);
          throw insertError;
        }

        console.log('✅ Message inserted successfully:', insertedData);
          
        // Reload messages to get the updated list
        fetchConversations();
        
        // Add message to local state for immediate display
        const newMessageObj = {
          id: Date.now().toString(),
          message_text: newMessage,
          sender_id: studentId,
          student_id: studentId,
          sent_at: new Date().toISOString(),
          isFromTeacher: false,
          isAi: false,
          time: new Date().toLocaleTimeString('ar-SA', { 
            hour: '2-digit', 
            minute: '2-digit' 
          })
        };
        setMessages(prevMessages => [...prevMessages, newMessageObj]);
      } else {
        // Admin sending message to student
        if (selectedConversation) {
          const { error } = await supabase
            .from('teacher_messages')
            .insert({
              sender_id: null, // Admin messages have null sender_id
              message_text: newMessage,
              student_id: selectedConversation.id
            });

          if (error) throw error;
          
          // Reload messages for this conversation
          await loadMessagesForConversation(selectedConversation.id);
          
          // Refresh conversations list to update last message
          fetchConversations();
        }
      }

      toast({
        title: "تم إرسال الرسالة",
        description: "تم إرسال رسالتك بنجاح",
      });
      
      setNewMessage("");
    } catch (error) {
      console.error('❌ Error sending message:', error);
      toast({
        title: "خطأ في الإرسال",
        description: error.message || "حاول مرة أخرى",
        variant: "destructive",
      });
    }
  };

  // Toggle between AI and Teacher mode
  const toggleAiMode = () => {
    setIsAiMode(!isAiMode);
    toast({
      title: isAiMode ? "تم التحويل للمدرس" : "تم التحويل للمساعد الذكي",
      description: isAiMode ? "يمكنك الآن التحدث مع الأستاذ محمد رمضان" : "يمكنك الآن التحدث مع المساعد الذكي",
    });
  };

  // Modified sendMessage to handle AI mode
  const handleSendMessage = async () => {
    if (isStudent && isAiMode) {
      // Send to AI if in AI mode
      await askAiAssistant();
    } else {
      // Send to teacher
      await sendMessage();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-secondary/20 relative overflow-hidden" dir="rtl">
      {/* Floating Particles Background */}
      <FloatingParticles />
      
      {isStudent ? <StudentHeader /> : <Header />}
      
      <div className="container mx-auto px-2 sm:px-3 md:px-4 lg:px-6 py-4 md:py-6 lg:py-8 relative z-10">
        {/* Header with Animation */}
        <motion.div 
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-4 md:mb-6 lg:mb-8"
        >
          <div className="relative overflow-hidden rounded-2xl md:rounded-3xl bg-primary p-4 md:p-6 lg:p-8 shadow-2xl">
            {/* Animated Background Pattern */}
            <div className="absolute inset-0 opacity-10">
              <div className="absolute inset-0" style={{
                backgroundImage: `radial-gradient(circle at 20px 20px, white 2px, transparent 0)`,
                backgroundSize: '40px 40px'
              }} />
            </div>

            <div className="relative z-10 flex items-center justify-between flex-wrap gap-3 md:gap-4">
              <div className="flex items-center gap-3 md:gap-4">
                <motion.div
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
                  className="p-2 md:p-3 lg:p-4 bg-white/20 backdrop-blur-sm rounded-xl md:rounded-2xl"
                >
                  <MessageSquare className="w-8 h-8 md:w-10 md:h-10 lg:w-12 lg:h-12 text-white" />
                </motion.div>
                <div>
                  <motion.h1 
                    className="text-xl md:text-2xl lg:text-4xl font-extrabold text-white mb-1 md:mb-2"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                  >
                    الرسائل
                  </motion.h1>
                  <motion.p 
                    className="text-white/90 text-xs md:text-sm lg:text-lg flex items-center gap-1 md:gap-2"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: 0.4 }}
                  >
                    <Sparkles className="h-4 w-4 md:h-5 md:w-5" />
                    <span className="hidden sm:inline">التواصل المباشر مع {isStudent ? 'الأستاذ' : 'الطلاب'}</span>
                    <span className="sm:hidden">{isStudent ? 'الأستاذ' : 'الطلاب'}</span>
                  </motion.p>
                </div>
              </div>
              
              {isStudent && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.5, delay: 0.5 }}
                  className="flex items-center gap-1.5 md:gap-2 bg-white/20 backdrop-blur-sm px-2 md:px-3 lg:px-4 py-1.5 md:py-2 rounded-full"
                >
                  <Bot className="h-4 w-4 md:h-5 md:w-5 text-white" />
                  <span className="text-white font-semibold text-xs md:text-sm">المساعد الذكي متاح</span>
                  <Badge className="bg-green-500 text-white text-[10px] md:text-xs">جديد</Badge>
                </motion.div>
              )}
            </div>
          </div>
        </motion.div>

        <div className={`grid grid-cols-1 ${isStudent ? '' : 'md:grid-cols-3 lg:grid-cols-3'} gap-3 md:gap-4 lg:gap-6`}>
          {/* Conversations List - Only for Admin */}
          {!isStudent && (
            <motion.div
              initial={{ opacity: 0, x: -50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.5 }}
              className="md:col-span-1"
            >
              <Card className="shadow-2xl border-primary/20 bg-gradient-to-br from-card/95 to-card backdrop-blur-xl hover:shadow-glow transition-all duration-500">
                <CardHeader className="bg-gradient-to-r from-primary/10 to-accent/10 border-b border-primary/20">
                  <CardTitle className="flex items-center gap-2">
                    <MessageCircle className="h-5 w-5 text-primary" />
                    المحادثات
                    <Badge className="mr-auto bg-primary">{conversations.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <AnimatePresence mode="popLayout">
                    {conversations.length > 0 ? (
                      <div className="space-y-2">
                        {conversations.map((conversation, index) => (
                          <motion.div
                            key={conversation.id}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            transition={{ duration: 0.3, delay: index * 0.05 }}
                            whileHover={{ scale: 1.02, x: 5 }}
                            className={`p-4 rounded-xl hover:bg-gradient-to-r hover:from-primary/10 hover:to-accent/10 cursor-pointer transition-all duration-300 border-2 ${
                              selectedConversation?.id === conversation.id 
                                ? 'bg-gradient-to-r from-primary/20 to-accent/20 border-primary shadow-lg' 
                                : 'border-transparent hover:border-primary/30'
                            }`}
                            onClick={() => {
                              setSelectedConversation(conversation);
                              loadMessagesForConversation(conversation.id);
                            }}
                          >
                            <div className="flex items-center gap-3">
                              <motion.div
                                whileHover={{ rotate: 360 }}
                                transition={{ duration: 0.5 }}
                              >
                                <Avatar className="border-2 border-primary/30">
                                  <AvatarFallback className="bg-gradient-to-br from-primary to-accent text-white">
                                    <User className="w-5 h-5" />
                                  </AvatarFallback>
                                </Avatar>
                              </motion.div>
                              <div className="flex-1">
                                <p className="font-bold text-foreground">{conversation.studentName}</p>
                                <p className="text-sm text-muted-foreground truncate">
                                  {conversation.lastMessage}
                                </p>
                              </div>
                              <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    ) : (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-center py-12 text-muted-foreground"
                      >
                        <motion.div
                          animate={{ y: [0, -10, 0] }}
                          transition={{ duration: 2, repeat: Infinity }}
                        >
                          <MessageCircle className="w-16 h-16 mx-auto mb-4 opacity-30" />
                        </motion.div>
                        <p className="text-lg font-semibold">لا توجد محادثات</p>
                        <p className="text-sm">انتظر رسائل من الطلاب</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Chat Area */}
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className={`${isStudent ? 'w-full' : 'md:col-span-2 lg:col-span-2'}`}
          >
            <Card className={`shadow-2xl border-primary/20 bg-gradient-to-br from-card/95 to-card backdrop-blur-xl h-[calc(100vh-200px)] sm:h-[calc(100vh-220px)] md:h-[calc(100vh-280px)] flex flex-col`}>
            <CardHeader className="bg-gradient-to-r from-primary/10 via-accent/10 to-primary/10 border-b border-primary/20 p-3 md:p-6">
              <CardTitle className="flex items-center gap-2 text-base md:text-lg">
                <MessageCircle className="h-5 w-5 md:h-6 md:w-6 text-primary" />
                <span className="truncate">
                  {isStudent 
                    ? 'المحادثة' 
                    : selectedConversation 
                      ? `محادثة مع ${selectedConversation.studentName}` 
                      : "اختر محادثة"
                  }
                </span>
                {isStudent && (
                  <Badge className="mr-auto bg-gradient-to-r from-green-500 to-emerald-500 text-white text-xs">
                    <Zap className="h-3 w-3 ml-1" />
                    متصل
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden flex flex-col p-0">
              {(selectedConversation || isStudent) ? (
                <div className="flex flex-col h-full">
                  {/* AI/Teacher Toggle Button */}
                  {isStudent && (
                    <motion.div 
                      initial={{ opacity: 0, y: -20 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mx-2 sm:mx-3 md:mx-4 mt-2 md:mt-4 mb-2"
                    >
                      {/* Display current mode */}
                      <div className="text-center mb-2 md:mb-3">
                        <p className={`text-sm md:text-lg font-bold ${
                          isAiMode 
                            ? 'text-purple-900 dark:text-purple-100' 
                            : 'text-primary'
                        } flex items-center justify-center gap-1 md:gap-2`}>
                          {isAiMode ? (
                            <>
                              <Bot className="w-4 h-4 md:w-5 md:h-5" />
                              <span>المساعد الذكي</span>
                              <Sparkles className="w-3 h-3 md:w-4 md:h-4" />
                            </>
                          ) : (
                            <>
                              <User className="w-4 h-4 md:w-5 md:h-5" />
                              <span>الأستاذ محمد رمضان</span>
                            </>
                          )}
                        </p>
                        <p className={`text-xs ${
                          isAiMode 
                            ? 'text-purple-600 dark:text-purple-400' 
                            : 'text-muted-foreground'
                        }`}>
                          {isAiMode ? 'الوضع الحالي: محادثة مع AI' : 'الوضع الحالي: محادثة مع الأستاذ'}
                        </p>
                      </div>

                      {/* Toggle button showing NEXT mode */}
                      <motion.button
                        onClick={toggleAiMode}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        className={`w-full p-3 md:p-4 rounded-xl md:rounded-2xl border-2 transition-all duration-300 ${
                          !isAiMode 
                            ? 'bg-gradient-to-r from-purple-500/20 via-pink-500/20 to-blue-500/20 border-purple-300 dark:border-purple-700' 
                            : 'bg-gradient-to-r from-primary/10 to-accent/10 border-primary/30'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 md:gap-3 flex-1 min-w-0">
                            <motion.div
                              animate={!isAiMode ? { rotate: [0, 360] } : {}}
                              transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                              className={`p-1.5 md:p-2 rounded-lg md:rounded-xl flex-shrink-0 ${
                                !isAiMode 
                                  ? 'bg-purple-500/20' 
                                  : 'bg-primary/20'
                              }`}
                            >
                              {!isAiMode ? (
                                <Bot className="w-5 h-5 md:w-6 md:h-6 text-purple-600 dark:text-purple-400" />
                              ) : (
                                <User className="w-5 h-5 md:w-6 md:h-6 text-primary" />
                              )}
                            </motion.div>
                            <div className="text-right flex-1 min-w-0">
                              <p className={`text-xs md:text-sm font-bold truncate ${
                                !isAiMode 
                                  ? 'text-purple-900 dark:text-purple-100' 
                                  : 'text-primary'
                              } flex items-center gap-1 md:gap-2`}>
                                <span className="truncate">{!isAiMode ? 'المساعد الذكي' : 'الأستاذ محمد رمضان'}</span>
                                {!isAiMode && <Sparkles className="h-3 w-3 md:h-4 md:w-4 flex-shrink-0" />}
                              </p>
                              <p className={`text-[10px] md:text-xs truncate ${
                                !isAiMode 
                                  ? 'text-purple-600 dark:text-purple-400' 
                                  : 'text-muted-foreground'
                              }`}>
                                {!isAiMode ? 'اضغط للتحويل للمساعد الذكي' : 'اضغط للتحويل للأستاذ محمد'}
                              </p>
                            </div>
                          </div>
                          <Badge className={`${
                            !isAiMode 
                              ? 'bg-gradient-to-r from-purple-500 to-pink-500' 
                              : 'bg-gradient-to-r from-primary to-accent'
                          } text-white border-0 text-xs flex-shrink-0`}>
                            {!isAiMode ? (
                              <>
                                <Sparkles className="w-3 h-3 ml-1" />
                                متاح
                              </>
                            ) : (
                              <>
                                <Zap className="w-3 h-3 ml-1" />
                                متصل
                              </>
                            )}
                          </Badge>
                        </div>
                      </motion.button>
                    </motion.div>
                  )}

                  {/* Messages Area */}
                  <div className="flex-1 overflow-y-auto p-3 md:p-4 lg:p-6 space-y-3 md:space-y-4 bg-gradient-to-b from-muted/20 to-transparent">
                    <AnimatePresence mode="popLayout">
                      {messages.map((message, index) => (
                        <motion.div
                          key={message.id}
                          initial={{ opacity: 0, y: 20, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          transition={{ duration: 0.3, delay: index * 0.02 }}
                          className={`flex ${
                            message.isAi ? 'justify-center' : 
                            message.isFromTeacher ? 'justify-end' : 'justify-start'
                          }`}
                        >
                          {message.isAi ? (
                            <motion.div 
                              whileHover={{ scale: 1.02 }}
                              className="max-w-[95%] sm:max-w-[90%] md:max-w-[85%] p-3 md:p-4 lg:p-5 rounded-xl md:rounded-2xl bg-gradient-to-br from-purple-500/20 via-pink-500/20 to-blue-500/20 backdrop-blur-sm border-2 border-purple-300/30 dark:border-purple-700/30 shadow-lg"
                            >
                              <div className="flex items-start gap-2 md:gap-3 mb-2 md:mb-3">
                                <motion.div
                                  animate={{ rotate: [0, 360] }}
                                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                                >
                                  <Bot className="w-5 h-5 md:w-6 md:h-6 text-purple-600 dark:text-purple-400 flex-shrink-0" />
                                </motion.div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs md:text-sm font-bold text-purple-900 dark:text-purple-100 mb-1 md:mb-2 flex items-center gap-1 md:gap-2">
                                    <span>المساعد الذكي</span>
                                    <Sparkles className="h-3 w-3 md:h-4 md:w-4" />
                                  </p>
                                  <p className="text-xs md:text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed break-words">{message.message_text}</p>
                                </div>
                              </div>
                              <p className="text-[10px] md:text-xs text-purple-600 dark:text-purple-400 flex items-center gap-1">
                                <Zap className="h-3 w-3" />
                                {message.time}
                              </p>
                            </motion.div>
                          ) : (
                            <motion.div
                              whileHover={{ scale: 1.02, y: -2 }}
                              className={`max-w-[85%] sm:max-w-[75%] md:max-w-[70%] p-3 md:p-4 rounded-xl md:rounded-2xl shadow-lg ${
                                message.isFromTeacher 
                                  ? 'bg-gradient-to-br from-primary to-accent text-white' 
                                  : 'bg-gradient-to-br from-card to-muted border-2 border-primary/20'
                              }`}
                            >
                              <p className="mb-1 md:mb-2 leading-relaxed text-xs md:text-sm break-words">{message.message_text}</p>
                              <p className={`text-[10px] md:text-xs flex items-center gap-1 ${message.isFromTeacher ? 'opacity-90' : 'text-muted-foreground'}`}>
                                <MessageCircle className="h-3 w-3" />
                                {message.time}
                              </p>
                            </motion.div>
                          )}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                    
                    {isAiLoading && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="flex justify-center"
                      >
                        <div className="bg-gradient-to-r from-purple-500/20 to-pink-500/20 backdrop-blur-sm p-5 rounded-2xl border-2 border-purple-300/30 dark:border-purple-700/30">
                          <div className="flex items-center gap-3">
                            <motion.div
                              animate={{ rotate: 360 }}
                              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                            >
                              <Bot className="w-6 h-6 text-purple-600 dark:text-purple-400" />
                            </motion.div>
                            <div className="flex gap-1">
                              {[0, 1, 2].map((i) => (
                                <motion.div
                                  key={i}
                                  className="w-2 h-2 bg-purple-600 dark:bg-purple-400 rounded-full"
                                  animate={{ y: [0, -10, 0] }}
                                  transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
                                />
                              ))}
                            </div>
                            <p className="text-sm text-purple-700 dark:text-purple-300 font-semibold">المساعد الذكي يفكر...</p>
                          </div>
                        </div>
                      </motion.div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Message Input */}
                  <div className="p-2 md:p-3 lg:p-4 border-t border-primary/20 bg-gradient-to-r from-card/50 to-muted/50 backdrop-blur-sm">
                    <div className="flex gap-2 md:gap-3">
                      <Textarea
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder={isStudent && isAiMode ? "اسأل المساعد الذكي..." : "اكتب رسالتك..."}
                        className="resize-none border-2 border-primary/30 focus:border-primary transition-all duration-300 rounded-lg md:rounded-xl text-sm md:text-base"
                        rows={2}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage();
                          }
                        }}
                      />
                      <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                        <Button 
                          onClick={handleSendMessage} 
                          className={`px-3 md:px-4 lg:px-6 transition-all duration-300 h-full ${
                            isStudent && isAiMode
                              ? 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600'
                              : 'bg-gradient-to-r from-primary to-accent hover:shadow-glow'
                          }`}
                          disabled={isAiLoading || !newMessage.trim()}
                        >
                          {isStudent && isAiMode ? (
                            <Bot className="w-4 h-4 md:w-5 md:h-5" />
                          ) : (
                            <Send className="w-4 h-4 md:w-5 md:h-5" />
                          )}
                        </Button>
                      </motion.div>
                    </div>
                    {isStudent && (
                      <motion.p 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-[10px] md:text-xs text-center text-muted-foreground mt-2 flex items-center justify-center gap-1"
                      >
                        <Sparkles className="w-3 h-3" />
                        <span className="hidden sm:inline">اضغط زر <Bot className="w-3 h-3 inline mx-1" /> للسؤال عن التاريخ والجغرافيا</span>
                        <span className="sm:hidden">استخدم المساعد الذكي للأسئلة</span>
                      </motion.p>
                    )}
                  </div>
                </div>
              ) : (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex items-center justify-center h-full text-muted-foreground"
                >
                  <div className="text-center">
                    <motion.div
                      animate={{ 
                        y: [0, -20, 0],
                        rotate: [0, 5, -5, 0]
                      }}
                      transition={{ duration: 3, repeat: Infinity }}
                    >
                      <MessageCircle className="w-24 h-24 mx-auto mb-6 opacity-30" />
                    </motion.div>
                    <p className="text-2xl font-bold mb-2">اختر محادثة لبدء التواصل</p>
                    <p className="text-sm">ستظهر الرسائل هنا</p>
                  </div>
                </motion.div>
              )}
            </CardContent>
          </Card>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export default Messages;