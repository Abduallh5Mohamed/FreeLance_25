import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MessageCircle, Send, User, Bot, Sparkles } from "lucide-react";
import Header from "@/components/Header";
import StudentHeader from "@/components/StudentHeader";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

const Messages = () => {
  const [messages, setMessages] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [newMessage, setNewMessage] = useState("");
  const [conversations, setConversations] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [isStudent, setIsStudent] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [showAiHelper, setShowAiHelper] = useState(false);
  
  const { toast } = useToast();

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

      // Check for admin user
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setCurrentUser({ email: user.email, type: 'admin' });
        setIsStudent(false);
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

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {isStudent ? <StudentHeader /> : <Header />}
      
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <MessageCircle className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">الرسائل</h1>
              <p className="text-muted-foreground">التواصل مع الطلاب</p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Conversations List */}
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle>المحادثات</CardTitle>
            </CardHeader>
            <CardContent>
              {conversations.length > 0 ? (
                <div className="space-y-2">
                  {conversations.map((conversation) => (
                    <div
                      key={conversation.id}
                      className={`p-3 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors ${
                        selectedConversation?.id === conversation.id ? 'bg-muted' : ''
                      }`}
                      onClick={() => {
                        setSelectedConversation(conversation);
                        loadMessagesForConversation(conversation.id);
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <Avatar>
                          <AvatarFallback>
                            <User className="w-4 h-4" />
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1">
                          <p className="font-medium">{conversation.studentName}</p>
                          <p className="text-sm text-muted-foreground truncate">
                            {conversation.lastMessage}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <MessageCircle className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>لا توجد محادثات</p>
                  <p className="text-sm">انتظر رسائل من الطلاب</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Chat Area */}
          <Card className="lg:col-span-2 shadow-soft">
            <CardHeader>
              <CardTitle>
                {selectedConversation ? `محادثة مع ${selectedConversation.studentName}` : "اختر محادثة"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {selectedConversation ? (
                <div className="space-y-4">
                  {/* AI Helper Badge */}
                  {isStudent && (
                    <div className="mb-3 flex items-center justify-between bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-950/20 dark:to-blue-950/20 p-3 rounded-lg border border-purple-200 dark:border-purple-800">
                      <div className="flex items-center gap-2">
                        <Bot className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                        <div>
                          <p className="text-sm font-medium text-purple-900 dark:text-purple-100">المساعد الذكي متاح</p>
                          <p className="text-xs text-purple-600 dark:text-purple-400">اسأل AI عن التاريخ والجغرافيا</p>
                        </div>
                      </div>
                      <Badge variant="secondary" className="bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300">
                        <Sparkles className="w-3 h-3 mr-1" />
                        جديد
                      </Badge>
                    </div>
                  )}

                  {/* Messages Area */}
                  <div className="h-96 overflow-y-auto border rounded-lg p-4 space-y-3">
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={`flex ${
                          message.isAi ? 'justify-center' : 
                          message.isFromTeacher ? 'justify-end' : 'justify-start'
                        }`}
                      >
                        {message.isAi ? (
                          <div className="max-w-[85%] p-4 rounded-lg bg-gradient-to-br from-purple-50 to-blue-50 dark:from-purple-950/30 dark:to-blue-950/30 border border-purple-200 dark:border-purple-800">
                            <div className="flex items-start gap-2 mb-2">
                              <Bot className="w-5 h-5 text-purple-600 dark:text-purple-400 mt-1 flex-shrink-0" />
                              <div className="flex-1">
                                <p className="text-sm font-medium text-purple-900 dark:text-purple-100 mb-1">المساعد الذكي</p>
                                <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{message.message_text}</p>
                              </div>
                            </div>
                            <p className="text-xs text-purple-600 dark:text-purple-400 mt-2">{message.time}</p>
                          </div>
                        ) : (
                          <div className={`max-w-[70%] p-3 rounded-lg ${
                            message.isFromTeacher 
                              ? 'bg-primary text-primary-foreground' 
                              : 'bg-muted'
                          }`}>
                            <p>{message.message_text}</p>
                            <p className="text-xs opacity-75 mt-1">{message.time}</p>
                          </div>
                        )}
                      </div>
                    ))}
                    {isAiLoading && (
                      <div className="flex justify-center">
                        <div className="bg-purple-50 dark:bg-purple-950/30 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
                          <div className="flex items-center gap-2">
                            <Bot className="w-5 h-5 text-purple-600 dark:text-purple-400 animate-pulse" />
                            <p className="text-sm text-purple-700 dark:text-purple-300">المساعد الذكي يفكر...</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Message Input */}
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <Textarea
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="اكتب رسالتك..."
                        className="resize-none"
                        rows={2}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                      />
                      <div className="flex flex-col gap-2">
                        <Button onClick={sendMessage} className="px-6" disabled={isAiLoading}>
                          <Send className="w-4 h-4" />
                        </Button>
                        {isStudent && (
                          <Button 
                            onClick={askAiAssistant} 
                            variant="outline"
                            className="px-6 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-950/20 dark:to-blue-950/20 border-purple-300 dark:border-purple-700 hover:from-purple-100 hover:to-blue-100"
                            disabled={isAiLoading || !newMessage.trim()}
                          >
                            <Bot className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {isStudent && (
                      <p className="text-xs text-muted-foreground text-center">
                        اضغط زر <Bot className="w-3 h-3 inline" /> للسؤال عن التاريخ والجغرافيا
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-16 text-muted-foreground">
                  <MessageCircle className="w-16 h-16 mx-auto mb-4 opacity-50" />
                  <p className="text-lg">اختر محادثة لبدء التواصل</p>
                  <p className="text-sm">ستظهر الرسائل هنا</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Messages;