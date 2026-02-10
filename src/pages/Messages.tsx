import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Send,
  Image as ImageIcon,
  MoreVertical,
  Search,
  Phone,
  ArrowRight,
  CheckCheck,
  Check,
  Clock,
  Loader2,
  User as UserIcon
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import Header from '@/components/Header';
import { FloatingParticles } from '@/components/FloatingParticles';
import { io, Socket } from 'socket.io-client';

// Types
interface Message {
  id: number;
  sender_id: string;
  receiver_id: string;
  content: string;
  message_type: 'text' | 'image';
  created_at: string;
  is_read: boolean;
  is_delivered: boolean;
}

interface User {
  id: string;
  name: string;
  avatar?: string;
  phone?: string;
  role: string;
  is_online?: boolean;
  last_seen?: string;
  unread_count?: number;
}

export default function Messages() {
  const { toast } = useToast();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [searchQuery, setSearchQuery] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize Socket and User
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (userStr) {
      const user = JSON.parse(userStr);
      setCurrentUser(user);

      // Load conversations immediately
      fetchConversations();

      // Connect Socket
      const newSocket = io('/', {
        auth: { token: localStorage.getItem('authToken') },
        path: '/socket.io'
      });

      newSocket.on('connect', () => {
        console.log('✅ Socket connected');
        newSocket.emit('user:connect', user.id);
      });

      newSocket.on('disconnect', () => {
        console.log('❌ Socket disconnected');
      });

      newSocket.on('connect_error', (err: any) => {
        console.error('Socket connection error:', err);
      });

      newSocket.on('message:new', (msg: any) => {
        try {
          console.log('📩 New message received:', msg);
          if (msg && msg.content) {
            setMessages(prev => {
              // Avoid duplicates
              if (prev.some(m => m.id === msg.id)) return prev;
              return [...prev, {
                id: msg.id || Date.now(),
                sender_id: msg.sender_id || '',
                receiver_id: msg.receiver_id || '',
                content: msg.content || '',
                message_type: msg.message_type || 'text',
                created_at: msg.created_at || new Date().toISOString(),
                is_read: msg.is_read || false,
                is_delivered: msg.is_delivered || false
              }];
            });
          }
          // Refresh conversations list
          fetchConversations().catch(err => console.error('Error refreshing conversations:', err));
        } catch (error) {
          console.error('Error handling new message:', error);
        }
      });

      setSocket(newSocket);

      return () => {
        newSocket.disconnect();
      };
    }
  }, []);

  // Handle Resize for Mobile Check
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Fetch Conversations
  const fetchConversations = async () => {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/messages/conversations', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        // Map API response fields to User interface
        const mapped = data.map((c: any) => ({
          id: c.other_user_id || c.id,
          name: c.other_user_name || c.name || 'بدون اسم',
          role: c.other_user_role || c.role || '',
          phone: c.phone || '',
          avatar: c.avatar || '',
          is_online: c.is_online || false,
          last_seen: c.last_seen || c.last_message_time || '',
          unread_count: c.unread_count || 0
        }));
        setConversations(mapped);
      } else {
        console.error('Failed to fetch conversations');
      }
    } catch (error) {
      console.error('Error fetching conversations:', error);
    }
  };

  // Fetch Messages when user is selected
  useEffect(() => {
    if (selectedUser) {
      const fetchMessages = async () => {
        setIsLoading(true);
        try {
          const token = localStorage.getItem('authToken');
          const response = await fetch(`/api/messages/${selectedUser.id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (response.ok) {
            const data = await response.json();
            setMessages(data);
          }

          // Mark all messages from this user as read
          try {
            await fetch(`/api/messages/mark-all-read/${selectedUser.id}`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            // Refresh conversations to update unread counts
            fetchConversations();
          } catch (err) {
            console.error('Error marking messages as read:', err);
          }
        } catch (error) {
          console.error('Error fetching messages:', error);
        } finally {
          setIsLoading(false);
        }
      };

      fetchMessages();
    }
  }, [selectedUser]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    // Auto resize
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || !selectedUser || !currentUser) return;

    const tempId = Date.now();
    const newMessage: Message = {
      id: tempId,
      sender_id: currentUser.id,
      receiver_id: selectedUser.id,
      content: inputText,
      message_type: 'text',
      created_at: new Date().toISOString(),
      is_read: false,
      is_delivered: false
    };

    setMessages(prev => [...prev, newMessage]);
    setInputText('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      if (socket) {
        socket.emit('message:send', {
          receiverId: selectedUser.id,
          content: newMessage.content,
          type: 'text'
        });
      }

      const token = localStorage.getItem('authToken');
      await fetch('/api/messages/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          receiver_id: selectedUser.id,
          content: newMessage.content,
          message_type: 'text'
        })
      });

    } catch (error) {
      console.error('Error sending message:', error);
      toast({
        title: "خطأ",
        description: "فشل إرسال الرسالة",
        variant: "destructive"
      });
    }
  };

  // Handle back button on mobile
  const handleBackToList = () => {
    setSelectedUser(null);
    setMessages([]);
  };

  const filteredConversations = conversations.filter(user =>
    (user.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.phone && user.phone.includes(searchQuery))
  );

  // Determine what to show on mobile
  const showContactsList = !isMobile || (isMobile && !selectedUser);
  const showChatArea = !isMobile || (isMobile && !!selectedUser);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col" dir="rtl">
      {/* Navbar - Always visible at top */}
      <div className="sticky top-0 z-50 w-full">
        <Header />
      </div>

      <div className="flex-1 flex overflow-hidden relative" style={{ height: 'calc(100vh - 64px)' }}>
        <FloatingParticles />

        {/* Sidebar / Conversations List */}
        {showContactsList && (
          <div className={`
            ${isMobile ? 'w-full' : 'w-1/3 min-w-[320px] max-w-[400px] border-l'}
            bg-white dark:bg-slate-800 flex flex-col h-full
          `}>
            {/* Sidebar Header */}
            <div className="p-4 border-b bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm shrink-0">
              <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
                <span className="text-primary">الرسائل</span>
                {conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0) > 0 && (
                  <span className="text-sm font-normal text-white bg-red-500 px-2 py-0.5 rounded-full">
                    {conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0)}
                  </span>
                )}
              </h2>
              <div className="relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="بحث بالاسم أو رقم الهاتف..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pr-9"
                />
              </div>
            </div>

            {/* Conversations List */}
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {filteredConversations.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>لا توجد محادثات</p>
                    <p className="text-xs mt-1">ابحث عن طالب لبدء محادثة</p>
                  </div>
                ) : (
                  filteredConversations.map((user) => (
                    <button
                      key={user.id}
                      onClick={() => setSelectedUser(user)}
                      className={`
                        w-full p-3 rounded-lg flex items-center gap-3 transition-all duration-200 text-right
                        ${selectedUser?.id === user.id
                          ? 'bg-primary/10 hover:bg-primary/15 shadow-sm'
                          : 'hover:bg-slate-100 dark:hover:bg-slate-700/50'}
                      `}
                    >
                      <div className="relative shrink-0">
                        <Avatar>
                          <AvatarImage src={user.avatar} />
                          <AvatarFallback>{(user.name || '؟').substring(0, 2)}</AvatarFallback>
                        </Avatar>
                        {user.is_online && (
                          <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white dark:border-slate-800 rounded-full"></span>
                        )}
                      </div>
                      <div className="flex-1 overflow-hidden min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold truncate">{user.name || 'بدون اسم'}</span>
                          {user.last_seen && (
                            <span className="text-xs text-muted-foreground shrink-0 mr-2">
                              {new Date(user.last_seen).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <p className="text-sm text-muted-foreground truncate">
                            {user.phone || 'بدون رقم'}
                          </p>
                          {user.unread_count ? (
                            <span className="bg-primary text-primary-foreground text-xs px-2 py-0.5 rounded-full min-w-[20px] text-center shrink-0 mr-2">
                              {user.unread_count}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Chat Area */}
        {showChatArea && (
          <div className="flex-1 flex flex-col bg-slate-50/50 dark:bg-slate-900/50 h-full relative">
            {selectedUser ? (
              <>
                {/* Chat Header */}
                <div className="p-3 border-b bg-white dark:bg-slate-800 flex items-center gap-3 shadow-sm z-10 shrink-0">
                  {isMobile && (
                    <Button variant="ghost" size="icon" onClick={handleBackToList} className="shrink-0">
                      <ArrowRight className="h-5 w-5" />
                    </Button>
                  )}
                  <Avatar className="shrink-0">
                    <AvatarImage src={selectedUser.avatar} />
                    <AvatarFallback>{(selectedUser.name || '؟').substring(0, 2)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold truncate">{selectedUser.name || 'بدون اسم'}</h3>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {selectedUser.is_online ? (
                        <span className="text-green-600 flex items-center gap-1">
                          <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                          متصل الآن
                        </span>
                      ) : (
                        <span>آخر ظهور: {selectedUser.last_seen ? new Date(selectedUser.last_seen).toLocaleTimeString('ar-EG') : 'غير متاح'}</span>
                      )}
                      {selectedUser.phone && <span>| {selectedUser.phone}</span>}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" className="shrink-0">
                    <MoreVertical className="h-5 w-5" />
                  </Button>
                </div>

                {/* Messages List */}
                <div className="flex-1 overflow-y-auto p-4 bg-slate-100/50 dark:bg-slate-900/50">
                  <div className="space-y-4 max-w-3xl mx-auto pb-4">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-8 h-8 animate-spin text-primary" />
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="text-center py-12 opacity-50">
                        <div className="bg-slate-200 dark:bg-slate-800 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                          <UserIcon className="w-8 h-8" />
                        </div>
                        <p>ابدأ المحادثة مع {selectedUser.name || 'المستخدم'}</p>
                      </div>
                    ) : (
                      messages.map((msg) => {
                        const isMe = msg.sender_id === currentUser?.id;
                        return (
                          <div
                            key={msg.id}
                            className={`flex ${isMe ? 'justify-start' : 'justify-end'}`}
                          >
                            <div
                              className={`
                                          max-w-[80%] md:max-w-[60%] rounded-2xl px-4 py-2.5 shadow-sm relative group
                                          ${isMe
                                  ? 'bg-primary text-primary-foreground rounded-br-none'
                                  : 'bg-white dark:bg-slate-800 border rounded-bl-none'}
                                      `}
                            >
                              <p className="text-sm leading-relaxed whitespace-pre-wrap" dir="auto" style={{ textAlign: 'start', unicodeBidi: 'plaintext' }}>
                                {msg.content}
                              </p>
                              <div className={`flex items-center gap-1 text-[10px] mt-1 ${isMe ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                                <span>{new Date(msg.created_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
                                {isMe && (
                                  <span>
                                    {msg.is_read ? <CheckCheck className="w-3 h-3" /> : msg.is_delivered ? <CheckCheck className="w-3 h-3 text-white/50" /> : <Check className="w-3 h-3 text-white/50" />}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </div>

                {/* Input Area - Fixed at bottom, clearly visible */}
                <div className="p-3 md:p-4 bg-white dark:bg-slate-800 border-t shrink-0 z-20">
                  <div className="max-w-3xl mx-auto flex items-end gap-2">
                    <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground mb-1">
                      <ImageIcon className="h-5 w-5" />
                    </Button>
                    <div className="flex-1 bg-slate-100 dark:bg-slate-900 rounded-2xl border focus-within:ring-2 focus-within:ring-primary/20 transition-all">
                      <textarea
                        ref={textareaRef}
                        value={inputText}
                        onChange={handleTextareaChange}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSendMessage();
                          }
                        }}
                        placeholder="اكتب رسالتك هنا..."
                        className="w-full bg-transparent border-none focus:outline-none resize-none px-4 py-3 text-base leading-relaxed"
                        dir="auto"
                        style={{ minHeight: '48px', maxHeight: '150px', unicodeBidi: 'plaintext' as any }}
                        rows={1}
                      />
                    </div>
                    <Button
                      onClick={handleSendMessage}
                      disabled={!inputText.trim()}
                      className="shrink-0 rounded-full h-12 w-12 bg-yellow-400 hover:bg-yellow-500 text-black shadow-lg mb-1 transition-transform active:scale-95"
                    >
                      <Send className={`h-5 w-5 ${!inputText.trim() ? 'opacity-50' : ''}`} />
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="hidden md:flex flex-col items-center justify-center h-full text-muted-foreground opacity-50">
                <div className="bg-slate-100 dark:bg-slate-800 p-6 rounded-full mb-4">
                  <Send className="w-12 h-12 text-slate-400" />
                </div>
                <h3 className="text-xl font-semibold mb-2">اختر محادثة للبدء</h3>
                <p>تواصل مع الطلاب والمدرسين بسهولة</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
