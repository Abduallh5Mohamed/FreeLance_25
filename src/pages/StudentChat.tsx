import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Send,
  Image as ImageIcon,
  Edit2,
  Trash2,
  Check,
  CheckCheck,
  ArrowRight,
  Search,
  MessageCircle,
  Loader2,
  Bot,
  GraduationCap
} from 'lucide-react';
import axios from 'axios';

const API_URL = '/api';

interface User {
  id: string;
  username?: string;
  name?: string;
  role: string;
  phone?: string;
  is_online?: boolean;
  last_seen?: string | null;
}

interface Message {
  id: number;
  sender_id: string;
  receiver_id: string;
  content: string;
  message_type: 'text' | 'image';
  image_url?: string;
  is_edited: boolean;
  edited_at?: string;
  is_deleted: boolean;
  deleted_at?: string;
  created_at: string;
  sender_name?: string;
  sender_role?: string;
  is_delivered?: boolean;
  delivered_at?: string;
  is_read?: boolean;
  read_at?: string;
}

interface Conversation {
  id: number;
  other_user_id: string;
  other_user_name: string;
  other_user_role: string;
  unread_count: number;
  last_message_content: string;
  last_message_type: string;
  last_message_time: string;
  is_online: boolean;
  last_seen: string;
}

export default function StudentChat() {
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [teacher, setTeacher] = useState<User | null>(null);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [searchQuery, setSearchQuery] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const getToken = () => localStorage.getItem('authToken');

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => { scrollToBottom(); }, [messages]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Initialize
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (!userStr) { navigate('/auth'); return; }

    try {
      const userData = JSON.parse(userStr);
      setUser(userData);
      loadConversations();
      loadTeacher();
      initializeSocket(userData);
    } catch { navigate('/auth'); }
  }, []);

  // Initialize Socket.IO
  const initializeSocket = (userData: any) => {
    const newSocket = io(window.location.origin, {
      auth: { token: localStorage.getItem('authToken') },
      path: '/socket.io'
    });

    newSocket.on('connect', () => {
      newSocket.emit('user:connect', userData.id);
    });

    newSocket.on('message:new', (message: any) => {
      try {
        if (message && message.content) {
          setMessages(prev => {
            if (prev.some(m => m.id === message.id)) return prev;
            return [...prev, {
              id: message.id || Date.now(),
              sender_id: message.sender_id || '',
              receiver_id: message.receiver_id || '',
              content: message.content || '',
              message_type: message.message_type || 'text',
              image_url: message.image_url,
              is_edited: message.is_edited || false,
              is_deleted: message.is_deleted || false,
              created_at: message.created_at || new Date().toISOString(),
              is_read: message.is_read || false,
              is_delivered: message.is_delivered || false
            }];
          });
        }
        loadConversations();
      } catch (error) {
        console.error('Error handling new message:', error);
      }
    });

    newSocket.on('message:sent', (message: Message) => {
      setMessages(prev => {
        const filtered = prev.filter(m => m.id < 1000000000000 || m.sender_id !== message.sender_id || m.content !== message.content);
        if (prev.some(m => m.id === message.id)) {
          return prev.map(m => m.id === message.id ? message : m);
        }
        return [...filtered, message];
      });
    });

    newSocket.on('message:read', (data: { messageId: number; readAt: Date }) => {
      setMessages(prev => prev.map(msg =>
        msg.id === data.messageId ? { ...msg, is_read: true, read_at: data.readAt.toString() } : msg
      ));
    });

    newSocket.on('message:edited', (data: any) => {
      setMessages(prev => prev.map(msg =>
        msg.id === data.messageId ? { ...msg, content: data.content, is_edited: true, edited_at: data.editedAt } : msg
      ));
    });

    newSocket.on('message:deleted', (data: { messageId: number }) => {
      setMessages(prev => prev.filter(msg => msg.id !== data.messageId));
    });

    newSocket.on('user:status', (data: { userId: string; isOnline: boolean; lastSeen?: Date }) => {
      if (teacher && teacher.id === data.userId) {
        setTeacher(prev => prev ? { ...prev, is_online: data.isOnline, last_seen: data.lastSeen?.toString() } : null);
      }
      if (selectedUser && selectedUser.id === data.userId) {
        setSelectedUser(prev => prev ? { ...prev, is_online: data.isOnline, last_seen: data.lastSeen?.toString() } : null);
      }
    });

    newSocket.on('typing:start', (data: { userId: string }) => {
      if (selectedUser && data.userId === selectedUser.id) setIsTyping(true);
    });
    newSocket.on('typing:stop', () => setIsTyping(false));
    newSocket.on('disconnect', () => console.log('🔌 Student socket disconnected'));
    newSocket.on('connect_error', (err: any) => console.error('Socket error:', err.message));

    setSocket(newSocket);
    return () => { newSocket.disconnect(); };
  };

  // Save AI messages to localStorage
  useEffect(() => {
    if (selectedUser?.id === 'ai-assistant' && messages.length > 0 && user?.id) {
      localStorage.setItem(`ai-messages-${user.id}`, JSON.stringify(messages));
    }
  }, [messages, selectedUser, user]);

  const loadConversations = async () => {
    try {
      const token = getToken();
      const res = await axios.get(`${API_URL}/messages/conversations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setConversations(res.data || []);
    } catch (error) {
      console.error('Error loading conversations:', error);
    }
  };

  const loadTeacher = async () => {
    try {
      const token = getToken();
      const teacherData: User = {
        id: '01024083057', username: 'الأستاذ محمد رمضان', name: 'الأستاذ محمد رمضان',
        role: 'teacher', phone: '01024083057', is_online: false, last_seen: null
      };
      try {
        const teacherRes = await axios.get(`${API_URL}/auth/search-by-phone/01024083057`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (teacherRes.data) {
          teacherData.id = teacherRes.data.id;
          teacherData.username = teacherRes.data.name || 'الأستاذ محمد رمضان';
          teacherData.name = teacherRes.data.name || 'الأستاذ محمد رمضان';
        }
      } catch { /* Use defaults */ }
      setTeacher(teacherData);
    } catch (error) {
      console.error('Error loading teacher:', error);
    }
  };

  const loadMessages = async (userId: string) => {
    if (userId === 'ai-assistant') {
      const storedMessages = localStorage.getItem(`ai-messages-${user?.id}`);
      if (storedMessages) {
        setMessages(JSON.parse(storedMessages));
      } else {
        setMessages([{
          id: 1, sender_id: 'ai-assistant', receiver_id: user?.id || 'unknown',
          content: 'السلام عليكم! أنا مساعدك الذكي المتخصص في مادة التاريخ. كيف يمكنني مساعدتك اليوم؟',
          message_type: 'text', is_edited: false, is_deleted: false,
          created_at: new Date().toISOString(), is_delivered: true, is_read: true
        }]);
      }
      return;
    }

    setIsLoading(true);
    try {
      const token = getToken();
      const res = await axios.get(`${API_URL}/messages/${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessages(res.data);
      // Mark all as read
      try {
        await axios.put(`${API_URL}/messages/mark-all-read/${userId}`, {}, {
          headers: { Authorization: `Bearer ${token}` }
        });
        loadConversations();
      } catch (err) {
        console.error('Error marking messages as read:', err);
      }
    } catch (error) {
      console.error('Error loading messages:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Send message
  const sendMessage = async () => {
    if (!messageText.trim() || !selectedUser) return;

    if (selectedUser.id === 'ai-assistant') {
      const userMessage: Message = {
        id: Date.now(), sender_id: user.id, receiver_id: 'ai-assistant',
        content: messageText, message_type: 'text', is_edited: false, is_deleted: false,
        created_at: new Date().toISOString(), is_delivered: true, is_read: true
      };
      setMessages(prev => [...prev, userMessage]);
      const currentMessage = messageText;
      setMessageText('');
      if (textareaRef.current) textareaRef.current.style.height = '48px';
      setIsTyping(true);

      const groqApiKey = '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';
      const systemPrompt = `أنت مساعد ذكي تعليمي متخصص حصراً في مساعدة طلاب المرحلة الثانوية المصريين في دراسة التاريخ.
وظيفتك الأساسية:
- شرح الأحداث التاريخية والشخصيات والفترات بوضوح ودقة
- مساعدة الطلاب على فهم دروس المنهج المصري للتاريخ
- تقديم ملخصات وتحليلات ومقارنات للأحداث التاريخية
- الإجابة على أسئلة من نمط الامتحانات
- مساعدة الطالب على كتابة الإجابات الطويلة
رد دائماً بالعربية فقط، وكن ودوداً وصبوراً - بدو كمعلم مختص وليس روبوت.`;

      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqApiKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: currentMessage }],
          temperature: 0.7, max_tokens: 1000,
        }),
      })
        .then(response => response.json())
        .then(data => {
          if (data.choices?.[0]?.message?.content) {
            setMessages(prev => [...prev, {
              id: Date.now() + 1, sender_id: 'ai-assistant', receiver_id: user.id,
              content: data.choices[0].message.content, message_type: 'text',
              is_edited: false, is_deleted: false, created_at: new Date().toISOString(),
              is_delivered: true, is_read: true
            }]);
          } else { throw new Error('No valid response from AI'); }
          setIsTyping(false);
        })
        .catch(() => {
          setMessages(prev => [...prev, {
            id: Date.now() + 1, sender_id: 'ai-assistant', receiver_id: user.id,
            content: '⚠️ عذراً، حدث خطأ في الاتصال بالمساعد الذكي.\n\nالرجاء المحاولة مرة أخرى أو التواصل مع الأستاذ. 📞',
            message_type: 'text', is_edited: false, is_deleted: false,
            created_at: new Date().toISOString(), is_delivered: true, is_read: true
          }]);
          setIsTyping(false);
        });
      return;
    }

    if (!socket) return;

    if (editingMessageId) {
      socket.emit('message:edit', { messageId: editingMessageId, userId: user.id, content: messageText });
      setEditingMessageId(null);
    } else {
      const tempMessage: Message = {
        id: Date.now(), sender_id: user.id, receiver_id: selectedUser.id,
        content: messageText, message_type: 'text', is_edited: false, is_deleted: false,
        created_at: new Date().toISOString(), is_delivered: false, is_read: false
      };
      setMessages(prev => [...prev, tempMessage]);
      socket.emit('message:send', {
        senderId: user.id, receiverId: selectedUser.id, content: messageText, messageType: 'text'
      });
    }
    setMessageText('');
    if (textareaRef.current) textareaRef.current.style.height = '48px';
    if (socket && selectedUser) {
      socket.emit('typing:stop', { senderId: user.id, receiverId: selectedUser.id });
    }
  };

  const sendImage = async (file: File) => {
    if (!selectedUser || selectedUser.id === 'ai-assistant') return;
    const formData = new FormData();
    formData.append('image', file);
    formData.append('receiver_id', selectedUser.id);
    try {
      const token = getToken();
      const res = await axios.post(`${API_URL}/messages/upload-image`, formData, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' }
      });
      setMessages(prev => [...prev, res.data]);
    } catch (error) {
      console.error('Error uploading image:', error);
    }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessageText(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = '48px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
    if (socket && selectedUser && selectedUser.id !== 'ai-assistant') {
      socket.emit('typing:start', { senderId: user.id, receiverId: selectedUser.id });
      setTimeout(() => { socket.emit('typing:stop', { senderId: user.id, receiverId: selectedUser.id }); }, 2000);
    }
  };

  const selectUser = (chatUser: User) => {
    setSelectedUser(chatUser);
    setMessages([]);
    setEditingMessageId(null);
    setMessageText('');
    loadMessages(chatUser.id);
  };

  const deleteMessage = (messageId: number) => {
    if (!socket || !user) return;
    socket.emit('message:delete', { messageId, userId: user.id });
  };

  const startEditing = (message: Message) => {
    setEditingMessageId(message.id);
    setMessageText(message.content);
  };

  const handleBackToList = () => {
    setSelectedUser(null);
    setMessages([]);
  };

  const formatTime = (dateString: string) => {
    try { return new Date(dateString).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const today = new Date();
      const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === today.toDateString()) return 'اليوم';
      if (date.toDateString() === yesterday.toDateString()) return 'أمس';
      return date.toLocaleDateString('ar-EG');
    } catch { return ''; }
  };

  const getTeacherUnread = () => {
    if (!teacher) return 0;
    const conv = conversations.find(c => c.other_user_id === teacher.id);
    return conv?.unread_count || 0;
  };

  const showContactsList = !isMobile || (isMobile && !selectedUser);
  const showChatArea = !isMobile || (isMobile && !!selectedUser);

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <Loader2 className="w-10 h-10 animate-spin text-orange-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col" dir="rtl">
      {/* Student Header Bar - Orange theme */}
      <div className="sticky top-0 z-50 bg-gradient-to-r from-orange-500 to-amber-500 shadow-lg">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-white/20 p-2 rounded-xl">
              <GraduationCap className="w-6 h-6 text-white" />
            </div>
            <div className="text-white">
              <h1 className="text-lg font-bold">الرسائل</h1>
              <p className="text-orange-100 text-xs">مرحباً، {user?.name || user?.username || 'طالب'}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(-1)}
            className="text-white hover:bg-white/20 rounded-xl"
          >
            <ArrowRight className="h-5 w-5 ml-1" />
            رجوع
          </Button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden" style={{ height: 'calc(100vh - 64px)' }}>

        {/* Sidebar / Contacts List */}
        {showContactsList && (
          <div className={`
            ${isMobile ? 'w-full' : 'w-1/3 min-w-[320px] max-w-[400px] border-l'}
            bg-white flex flex-col h-full
          `}>
            {/* Search */}
            <div className="p-4 border-b bg-white shrink-0">
              <div className="relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="بحث..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pr-9"
                />
              </div>
            </div>

            <ScrollArea className="flex-1">
              {/* Teacher - Pinned at top */}
              {teacher && (
                <div className="p-2">
                  <h3 className="text-xs font-bold text-orange-500 px-3 mb-2 flex items-center gap-1">
                    <GraduationCap className="w-3 h-3" />
                    المدرس
                  </h3>
                  <button
                    onClick={() => selectUser(teacher)}
                    className={`
                      w-full p-3 rounded-xl flex items-center gap-3 transition-all duration-200 text-right
                      ${selectedUser?.id === teacher.id
                        ? 'bg-orange-50 ring-2 ring-orange-200 shadow-sm'
                        : 'hover:bg-slate-50'}
                    `}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="bg-gradient-to-br from-orange-400 to-amber-500">
                        <AvatarFallback className="text-white font-bold">
                          {(teacher.name || teacher.username || 'م').substring(0, 2)}
                        </AvatarFallback>
                      </Avatar>
                      {teacher.is_online && (
                        <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
                      )}
                    </div>
                    <div className="flex-1 overflow-hidden min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-semibold truncate text-sm">{teacher.name || teacher.username || 'الأستاذ'}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {teacher.is_online ? (
                          <span className="text-green-600 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 bg-green-500 rounded-full"></span>
                            متصل الآن
                          </span>
                        ) : 'مدرس التاريخ'}
                      </p>
                    </div>
                    {getTeacherUnread() > 0 && (
                      <span className="bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full min-w-[20px] text-center shrink-0">
                        {getTeacherUnread()}
                      </span>
                    )}
                  </button>
                </div>
              )}

              {/* AI Assistant */}
              <div className="p-2 border-t">
                <h3 className="text-xs font-bold text-purple-500 px-3 mb-2 flex items-center gap-1">
                  <Bot className="w-3 h-3" />
                  المساعد الذكي
                </h3>
                <button
                  onClick={() => selectUser({
                    id: 'ai-assistant', username: 'المساعد الذكي', name: 'المساعد الذكي',
                    role: 'ai', is_online: true, last_seen: null
                  })}
                  className={`
                    w-full p-3 rounded-xl flex items-center gap-3 transition-all duration-200 text-right
                    ${selectedUser?.id === 'ai-assistant'
                      ? 'bg-purple-50 ring-2 ring-purple-200 shadow-sm'
                      : 'hover:bg-slate-50'}
                  `}
                >
                  <div className="relative shrink-0">
                    <Avatar className="bg-gradient-to-br from-violet-500 to-fuchsia-500">
                      <AvatarFallback className="text-white text-sm font-bold">AI</AvatarFallback>
                    </Avatar>
                    <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
                  </div>
                  <div className="flex-1 overflow-hidden min-w-0">
                    <span className="font-semibold truncate text-sm block">المساعد الذكي</span>
                    <p className="text-xs text-muted-foreground">متاح دائماً لمساعدتك 🤖</p>
                  </div>
                </button>
              </div>

              {/* Other Conversations */}
              {conversations.length > 0 && (
                <div className="p-2 border-t">
                  <h3 className="text-xs font-bold text-slate-400 px-3 mb-2">المحادثات</h3>
                  {conversations
                    .filter(c => (c.other_user_name || '').toLowerCase().includes(searchQuery.toLowerCase()))
                    .map(conv => (
                      <button
                        key={conv.id}
                        onClick={() => selectUser({
                          id: conv.other_user_id, username: conv.other_user_name, name: conv.other_user_name,
                          role: conv.other_user_role, is_online: conv.is_online, last_seen: conv.last_seen
                        })}
                        className={`
                        w-full p-3 rounded-xl flex items-center gap-3 transition-all duration-200 text-right mb-1
                        ${selectedUser?.id === conv.other_user_id
                            ? 'bg-orange-50 ring-2 ring-orange-200 shadow-sm'
                            : 'hover:bg-slate-50'}
                      `}
                      >
                        <div className="relative shrink-0">
                          <Avatar>
                            <AvatarFallback>{(conv.other_user_name || '؟').substring(0, 2)}</AvatarFallback>
                          </Avatar>
                          {conv.is_online && (
                            <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
                          )}
                        </div>
                        <div className="flex-1 overflow-hidden min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="font-semibold truncate text-sm">{conv.other_user_name || 'بدون اسم'}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0 mr-2">
                              {conv.last_message_time ? formatTime(conv.last_message_time) : ''}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground truncate">
                              {conv.last_message_type === 'image' ? '📷 صورة' : (conv.last_message_content || '')}
                            </p>
                            {conv.unread_count > 0 && (
                              <span className="bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full min-w-[20px] text-center shrink-0 mr-2">
                                {conv.unread_count}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                </div>
              )}
            </ScrollArea>
          </div>
        )}

        {/* Chat Area */}
        {showChatArea && (
          <div className="flex-1 flex flex-col bg-slate-50/50 h-full">
            {selectedUser ? (
              <>
                {/* Chat Header */}
                <div className="p-3 border-b bg-white flex items-center gap-3 shadow-sm shrink-0">
                  {isMobile && (
                    <Button variant="ghost" size="icon" onClick={handleBackToList} className="shrink-0">
                      <ArrowRight className="h-5 w-5" />
                    </Button>
                  )}
                  <Avatar className={`shrink-0 ${selectedUser.id === 'ai-assistant' ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500' : 'bg-gradient-to-br from-orange-400 to-amber-500'}`}>
                    <AvatarFallback className="text-white font-bold">
                      {selectedUser.id === 'ai-assistant' ? 'AI' : (selectedUser.name || selectedUser.username || '؟').substring(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold truncate">{selectedUser.name || selectedUser.username || 'بدون اسم'}</h3>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {selectedUser.is_online ? (
                        <span className="text-green-600 flex items-center gap-1">
                          <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                          متصل الآن
                        </span>
                      ) : selectedUser.id === 'ai-assistant' ? (
                        <span className="text-green-600">متاح دائماً</span>
                      ) : (
                        <span>آخر ظهور: {selectedUser.last_seen ? formatTime(selectedUser.last_seen) : 'غير متاح'}</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Messages List */}
                <div className="flex-1 overflow-y-auto p-4 bg-slate-100/50">
                  <div className="space-y-4 max-w-3xl mx-auto pb-4">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="text-center py-12 opacity-50">
                        <div className="bg-slate-200 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                          <MessageCircle className="w-8 h-8" />
                        </div>
                        <p>ابدأ المحادثة مع {selectedUser.name || selectedUser.username || 'المستخدم'}</p>
                      </div>
                    ) : (
                      messages.map((msg, index) => {
                        const isMe = msg.sender_id === user?.id;
                        const showDateLabel = index === 0 || formatDate(messages[index - 1].created_at) !== formatDate(msg.created_at);
                        return (
                          <div key={msg.id}>
                            {showDateLabel && (
                              <div className="flex justify-center my-4">
                                <span className="bg-gray-200 text-gray-600 text-xs px-3 py-1 rounded-full">
                                  {formatDate(msg.created_at)}
                                </span>
                              </div>
                            )}
                            <div className={`flex ${isMe ? 'justify-start' : 'justify-end'}`}>
                              <div className={`max-w-[80%] md:max-w-[60%] rounded-2xl px-4 py-2.5 shadow-sm relative group
                                ${isMe
                                  ? 'bg-orange-500 text-white rounded-br-none'
                                  : selectedUser.id === 'ai-assistant'
                                    ? 'bg-gradient-to-br from-violet-50 to-purple-50 border border-purple-200 rounded-bl-none'
                                    : 'bg-white border rounded-bl-none'
                                }`}
                              >
                                {msg.message_type === 'image' && msg.image_url && (
                                  <img src={`${window.location.origin}${msg.image_url}`} alt="صورة" className="rounded-lg max-w-full mb-2" />
                                )}
                                {msg.message_type === 'text' && (
                                  <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" dir="auto" style={{ textAlign: 'start', unicodeBidi: 'plaintext' }}>
                                    {msg.content}
                                  </p>
                                )}
                                <div className={`flex items-center gap-1 text-[10px] mt-1 ${isMe ? 'text-orange-200' : 'text-muted-foreground'}`}>
                                  <span>{formatTime(msg.created_at)}</span>
                                  {msg.is_edited && <span>(معدلة)</span>}
                                  {isMe && (
                                    <span>
                                      {msg.is_read ? <CheckCheck className="w-3 h-3" /> : msg.is_delivered ? <CheckCheck className="w-3 h-3 text-white/50" /> : <Check className="w-3 h-3 text-white/50" />}
                                    </span>
                                  )}
                                </div>
                                {isMe && msg.message_type === 'text' && selectedUser.id !== 'ai-assistant' && (
                                  <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                                    <button onClick={() => startEditing(msg)} className="p-1 rounded hover:bg-white/20">
                                      <Edit2 className="h-3 w-3" />
                                    </button>
                                    <button onClick={() => deleteMessage(msg.id)} className="p-1 rounded hover:bg-red-500/20">
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                    {isTyping && (
                      <div className="flex items-center gap-2 text-sm text-gray-500">
                        <div className="flex gap-1">
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                          <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                        </div>
                        <span>يكتب...</span>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </div>

                {/* Input Area - Fixed at bottom */}
                <div className="p-3 md:p-4 bg-white border-t shrink-0">
                  {editingMessageId && (
                    <div className="bg-orange-50 p-2 rounded-lg mb-2 flex items-center justify-between">
                      <span className="text-sm text-orange-700">تعديل الرسالة</span>
                      <Button variant="ghost" size="sm" onClick={() => { setEditingMessageId(null); setMessageText(''); }}>إلغاء</Button>
                    </div>
                  )}
                  <div className="max-w-3xl mx-auto flex items-end gap-2">
                    {selectedUser.id !== 'ai-assistant' && (
                      <>
                        <input type="file" ref={fileInputRef} className="hidden" accept="image/*"
                          onChange={(e) => { const file = e.target.files?.[0]; if (file) sendImage(file); }} />
                        <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground mb-1"
                          onClick={() => fileInputRef.current?.click()}>
                          <ImageIcon className="h-5 w-5" />
                        </Button>
                      </>
                    )}
                    <div className="flex-1 bg-slate-100 rounded-2xl border focus-within:ring-2 focus-within:ring-orange-200 transition-all">
                      <textarea
                        ref={textareaRef}
                        value={messageText}
                        onChange={handleTyping}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                        placeholder="اكتب رسالتك هنا..."
                        className="w-full bg-transparent border-none focus:outline-none resize-none px-4 py-3 text-base leading-relaxed"
                        dir="auto"
                        style={{ minHeight: '48px', maxHeight: '150px', unicodeBidi: 'plaintext' as any }}
                        rows={1}
                      />
                    </div>
                    <Button
                      onClick={sendMessage}
                      disabled={!messageText.trim()}
                      className="shrink-0 rounded-full h-12 w-12 bg-orange-500 hover:bg-orange-600 text-white shadow-lg mb-1 transition-transform active:scale-95"
                    >
                      <Send className={`h-5 w-5 ${!messageText.trim() ? 'opacity-50' : ''}`} />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="hidden md:flex flex-col items-center justify-center h-full text-muted-foreground opacity-50">
                <div className="bg-slate-100 p-6 rounded-full mb-4">
                  <MessageCircle className="w-12 h-12 text-orange-300" />
                </div>
                <h3 className="text-xl font-semibold mb-2">اختر محادثة للبدء</h3>
                <p>تواصل مع المدرس أو المساعد الذكي</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
