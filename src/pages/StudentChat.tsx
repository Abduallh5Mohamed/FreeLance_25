import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Send,
  Image as ImageIcon,
  Edit2,
  Trash2,
  Check,
  CheckCheck,
  Clock,
  ArrowLeft,
  Search
} from 'lucide-react';
import axios from 'axios';

// Helper to get API URL
const getApiUrl = () => {
  const envApiUrl = import.meta.env.VITE_API_URL;
  if (envApiUrl) return envApiUrl;

  const currentHost = window.location.hostname;
  if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
    return `http://${currentHost}:3001/api`;
  }
  return 'http://localhost:3001/api';
};

// Helper to get Socket URL (base URL without /api)
const getSocketUrl = () => {
  const apiUrl = getApiUrl();
  return apiUrl.replace('/api', '');
};

const API_URL = getApiUrl();
const SOCKET_URL = getSocketUrl();

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
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageText, setMessageText] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Get auth token
  const getToken = () => localStorage.getItem('authToken');

  // Scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Initialize
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const token = getToken();

    if (!userStr) {
      navigate('/auth');
      return;
    }

    try {
      const userData = JSON.parse(userStr);
      setUser(userData);
      initializeSocket(userData);
      loadConversations();
      loadAvailableUsers(userData);

      // Auto-select AI Assistant
      setTimeout(() => {
        selectUser({
          id: 'ai-assistant',
          username: 'المساعد الذكي',
          phone: '',
          is_online: true,
          last_seen: null,
          role: 'ai'
        });
      }, 500);
    } catch (err) {
      navigate('/auth');
    }
  }, []);

  // Initialize Socket.IO
  const initializeSocket = (userData: any) => {
    const newSocket = io(SOCKET_URL);

    newSocket.on('connect', () => {
      newSocket.emit('user:connect', userData.id);
    });

    newSocket.on('message:new', (message: Message) => {
      if (message.sender_id !== userData.id &&
        selectedUser &&
        (message.sender_id === selectedUser.id || message.receiver_id === selectedUser.id)) {
        setMessages(prev => {
          const exists = prev.some(m => m.id === message.id);
          if (exists) return prev;
          return [...prev, message];
        });

        if (message.receiver_id === userData.id) {
          markMessageAsRead(message.id);
        }
      }

      loadConversations();
    });

    newSocket.on('message:sent', (message: Message) => {
      setMessages(prev => {
        const filtered = prev.filter(m => m.id < 1000000000000 || m.sender_id !== message.sender_id || m.content !== message.content);
        const exists = prev.some(m => m.id === message.id);
        if (exists) {
          return prev.map(m => m.id === message.id ? message : m);
        }
        return [...filtered, message];
      });
    });

    newSocket.on('message:read', (data: { messageId: number; readAt: Date }) => {
      setMessages(prev => prev.map(msg =>
        msg.id === data.messageId
          ? { ...msg, is_read: true, read_at: data.readAt.toString() }
          : msg
      ));
    });

    newSocket.on('message:edited', (data: any) => {
      setMessages(prev => prev.map(msg =>
        msg.id === data.messageId
          ? { ...msg, content: data.content, is_edited: true, edited_at: data.editedAt }
          : msg
      ));
    });

    newSocket.on('message:deleted', (data: { messageId: number }) => {
      setMessages(prev => prev.filter(msg => msg.id !== data.messageId));
    });

    newSocket.on('user:status', (data: { userId: string; isOnline: boolean; lastSeen?: Date }) => {
      setAvailableUsers(prev => prev.map(u =>
        u.id === data.userId
          ? { ...u, is_online: data.isOnline, last_seen: data.lastSeen?.toString() }
          : u
      ));

      if (selectedUser && selectedUser.id === data.userId) {
        setSelectedUser(prev => prev ? {
          ...prev,
          is_online: data.isOnline,
          last_seen: data.lastSeen?.toString()
        } : null);
      }
    });

    newSocket.on('typing:start', (data: { userId: string }) => {
      if (selectedUser && data.userId === selectedUser.id) {
        setIsTyping(true);
      }
    });

    newSocket.on('typing:stop', () => {
      setIsTyping(false);
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  };

  // Save AI messages to localStorage
  useEffect(() => {
    if (selectedUser?.id === 'ai-assistant' && messages.length > 0) {
      localStorage.setItem('ai-messages', JSON.stringify(messages));
    }
  }, [messages, selectedUser]);

  // Load conversations
  const loadConversations = async () => {
    try {
      const token = getToken();
      const res = await axios.get(`${API_URL}/messages/conversations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setConversations(res.data);
    } catch (error) {
      console.error('Error loading conversations:', error);
    }
  };

  // Load available users - Only Teacher for students
  const loadAvailableUsers = async (userData?: any) => {
    try {
      const token = getToken();
      const teacher = {
        id: '01024083057',
        username: 'الأستاذ محمد رمضان',
        role: 'teacher',
        phone: '01024083057',
        is_online: false,
        last_seen: null
      };

      try {
        const teacherRes = await axios.get(`${API_URL}/auth/search-by-phone/01024083057`, {
          headers: { Authorization: `Bearer ${token}` }
        });

        if (teacherRes.data) {
          teacher.id = teacherRes.data.id;
          teacher.username = teacherRes.data.name || 'الأستاذ محمد رمضان';
        }
      } catch (err) {
        console.error('⚠️ Could not load teacher data');
      }

      setAvailableUsers([teacher]);
    } catch (error) {
      console.error('Error loading users:', error);
    }
  };

  // Load messages with selected user
  const loadMessages = async (userId: string) => {
    // AI Assistant messages stored locally
    if (userId === 'ai-assistant') {
      const storedMessages = localStorage.getItem('ai-messages');
      if (storedMessages) {
        setMessages(JSON.parse(storedMessages));
      } else {
        const welcomeMessage: Message = {
          id: 1,
          sender_id: 'ai-assistant',
          receiver_id: user.id,
          content: 'السلام عليكم! أنا مساعدك الذكي المتخصص في مادة التاريخ. كيف يمكنني مساعدتك اليوم؟',
          message_type: 'text',
          is_edited: false,
          is_deleted: false,
          created_at: new Date().toISOString(),
          is_delivered: true,
          is_read: true
        };
        setMessages([welcomeMessage]);
      }
      return;
    }

    try {
      const token = getToken();
      const res = await axios.get(`${API_URL}/messages/${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessages(res.data);

      const unreadMessages = res.data.filter((msg: Message) =>
        msg.receiver_id === user.id && !msg.is_read
      );

      if (unreadMessages.length > 0) {
        try {
          await axios.put(`${API_URL}/messages/mark-all-read/${userId}`, {}, {
            headers: { Authorization: `Bearer ${token}` }
          });
        } catch (err) {
          console.error('Error marking messages as read:', err);
        }
      }
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  // Send message
  const sendMessage = async () => {
    if (!messageText.trim() || !selectedUser) return;

    // AI Assistant - Google Gemini API through Backend
    if (selectedUser.id === 'ai-assistant') {
      const userMessage: Message = {
        id: Date.now(),
        sender_id: user.id,
        receiver_id: 'ai-assistant',
        content: messageText,
        message_type: 'text',
        is_edited: false,
        is_deleted: false,
        created_at: new Date().toISOString(),
        is_delivered: true,
        is_read: true
      };

      setMessages(prev => [...prev, userMessage]);
      const currentMessage = messageText;
      setMessageText('');
      setIsTyping(true);

      // Call backend AI endpoint
      const apiUrl = getApiUrl();
      const authToken = localStorage.getItem('authToken');

      axios.post(`${apiUrl}/ai-chat/chat`, {
        message: currentMessage
      }, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      })
        .then(response => {
          const aiMessage: Message = {
            id: Date.now() + 1,
            sender_id: 'ai-assistant',
            receiver_id: user.id,
            content: response.data.response,
            message_type: 'text',
            is_edited: false,
            is_deleted: false,
            created_at: new Date().toISOString(),
            is_delivered: true,
            is_read: true
          };
          setMessages(prev => [...prev, aiMessage]);
          setIsTyping(false);
          console.log('✅ AI Response from:', response.data.model || 'AI');
        })
        .catch(error => {
          console.error('❌ AI Error:', error.response?.data || error.message);

          // Show error message to user
          const errorMessage: Message = {
            id: Date.now() + 1,
            sender_id: 'ai-assistant',
            receiver_id: user.id,
            content: '⚠️ عذراً، حدث خطأ في الاتصال بالمساعد الذكي.\n\nالرجاء المحاولة مرة أخرى أو التواصل مع الأستاذ.',
            message_type: 'text',
            is_edited: false,
            is_deleted: false,
            created_at: new Date().toISOString(),
            is_delivered: true,
            is_read: true
          };
          setMessages(prev => [...prev, errorMessage]);
          setIsTyping(false);
        });

      return;
    }

    if (!socket) return;

    if (editingMessageId) {
      socket.emit('message:edit', {
        messageId: editingMessageId,
        userId: user.id,
        content: messageText
      });
      setEditingMessageId(null);
    } else {
      const tempMessage: Message = {
        id: Date.now(),
        sender_id: user.id,
        receiver_id: selectedUser.id,
        content: messageText,
        message_type: 'text',
        is_edited: false,
        is_deleted: false,
        created_at: new Date().toISOString(),
        is_delivered: false,
        is_read: false
      };

      setMessages(prev => [...prev, tempMessage]);

      socket.emit('message:send', {
        senderId: user.id,
        receiverId: selectedUser.id,
        content: messageText,
        messageType: 'text'
      });
    }

    setMessageText('');
    if (socket && selectedUser) {
      socket.emit('typing:stop', { senderId: user.id, receiverId: selectedUser.id });
    }
  };

  // Send image
  const sendImage = async (file: File) => {
    if (!selectedUser) return;

    const formData = new FormData();
    formData.append('image', file);
    formData.append('receiver_id', selectedUser.id);

    try {
      const token = getToken();
      const res = await axios.post(`${API_URL}/messages/upload-image`, formData, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'multipart/form-data'
        }
      });

      setMessages(prev => [...prev, res.data]);
    } catch (error) {
      console.error('Error uploading image:', error);
    }
  };

  // Mark message as read
  const markMessageAsRead = async (messageId: number) => {
    if (!user) return;

    try {
      const token = getToken();
      await axios.put(`${API_URL}/messages/${messageId}/mark-read`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (socket) {
        socket.emit('message:read', { messageId, userId: user.id });
      }
    } catch (error) {
      console.error('Error marking message as read:', error);
    }
  };

  // Delete message
  const deleteMessage = (messageId: number) => {
    if (!socket || !user) return;
    socket.emit('message:delete', { messageId, userId: user.id });
  };

  // Start editing
  const startEditing = (message: Message) => {
    setEditingMessageId(message.id);
    setMessageText(message.content);
  };

  // Handle typing
  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageText(e.target.value);

    if (socket && selectedUser) {
      socket.emit('typing:start', { senderId: user.id, receiverId: selectedUser.id });

      setTimeout(() => {
        socket.emit('typing:stop', { senderId: user.id, receiverId: selectedUser.id });
      }, 2000);
    }
  };

  // Select user to chat
  const selectUser = (chatUser: User) => {
    setSelectedUser(chatUser);
    setMessages([]);
    loadMessages(chatUser.id);

    setConversations(prev => prev.map(conv =>
      conv.other_user_id === chatUser.id
        ? { ...conv, unread_count: 0 }
        : conv
    ));
  };

  // Format time
  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  };

  // Format date
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return 'اليوم';
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'أمس';
    } else {
      return date.toLocaleDateString('ar-EG');
    }
  };

  // Get message status icon
  const getStatusIcon = (message: Message) => {
    if (message.sender_id !== user?.id) return null;

    if (message.is_read) {
      return <CheckCheck className="h-4 w-4 text-blue-500" />;
    } else if (message.is_delivered) {
      return <CheckCheck className="h-4 w-4 text-gray-400" />;
    } else {
      return <Check className="h-4 w-4 text-gray-400" />;
    }
  };

  if (!user) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50" dir="rtl">
      {/* Sidebar - Conversations & Users */}
      <div className="w-80 bg-white border-l border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">الرسائل</h2>
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1">
          {/* Conversations */}
          {conversations.length > 0 && (
            <div className="p-2">
              <h3 className="text-sm font-semibold text-gray-500 px-2 mb-2">المحادثات</h3>
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors ${selectedUser?.id === conv.other_user_id ? 'bg-blue-50' : ''
                    }`}
                  onClick={() => selectUser({
                    id: conv.other_user_id,
                    username: conv.other_user_name,
                    role: conv.other_user_role,
                    is_online: conv.is_online,
                    last_seen: conv.last_seen
                  })}
                >
                  <div className="relative">
                    <Avatar>
                      <AvatarFallback>{conv.other_user_name[0]}</AvatarFallback>
                    </Avatar>
                    {conv.is_online && (
                      <div className="absolute bottom-0 left-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-sm truncate">{conv.other_user_name}</p>
                      <span className="text-xs text-gray-500">
                        {formatTime(conv.last_message_time)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 truncate">
                      {conv.last_message_type === 'image' ? '📷 صورة' : conv.last_message_content}
                    </p>
                  </div>
                  {conv.unread_count > 0 && (
                    <div className="bg-blue-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                      {conv.unread_count}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <Separator className="my-2" />

          {/* AI Assistant */}
          <div className="p-2 mb-2">
            <div
              className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors ${selectedUser?.id === 'ai-assistant' ? 'bg-blue-50' : ''
                }`}
              onClick={() => selectUser({
                id: 'ai-assistant',
                username: 'المساعد الذكي',
                phone: '',
                is_online: true,
                last_seen: null,
                role: 'ai'
              })}
            >
              <div className="relative">
                <Avatar className="bg-gradient-to-br from-blue-500 to-purple-500">
                  <AvatarFallback className="text-white">AI</AvatarFallback>
                </Avatar>
                <div className="absolute bottom-0 left-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
              </div>
              <div className="flex-1">
                <p className="font-medium text-sm">المساعد الذكي</p>
                <p className="text-xs text-gray-500">متاح دائماً لمساعدتك</p>
              </div>
            </div>
          </div>

          <Separator className="my-2" />

          {/* Teacher Only */}
          <div className="p-2">
            <h3 className="text-sm font-semibold text-gray-500 px-2 mb-2">المدرس</h3>
            {availableUsers.map(availUser => (
              <div
                key={availUser.id}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors ${selectedUser?.id === availUser.id ? 'bg-blue-50' : ''
                  }`}
                onClick={() => selectUser(availUser)}
              >
                <div className="relative">
                  <Avatar>
                    <AvatarFallback>{(availUser.username || availUser.name || 'U')[0]}</AvatarFallback>
                  </Avatar>
                  {availUser.is_online && (
                    <div className="absolute bottom-0 left-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
                  )}
                </div>
                <div className="flex-1">
                  <p className="font-medium text-sm">{availUser.username || availUser.name}</p>
                  <p className="text-xs text-gray-500">
                    {availUser.is_online ? (
                      <span className="text-green-600">متصل الآن</span>
                    ) : (
                      availUser.last_seen && `آخر ظهور ${formatDate(availUser.last_seen)}`
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col">
        {selectedUser ? (
          <>
            {/* Chat Header */}
            <div className="bg-white border-b border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Avatar>
                    <AvatarFallback>{(selectedUser.username || selectedUser.name || 'U')[0]}</AvatarFallback>
                  </Avatar>
                  {selectedUser.is_online && (
                    <div className="absolute bottom-0 left-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
                  )}
                </div>
                <div>
                  <h3 className="font-semibold">{selectedUser.username || selectedUser.name}</h3>
                  <p className="text-sm text-gray-500">
                    {selectedUser.is_online ? (
                      <span className="text-green-600">متصل الآن</span>
                    ) : (
                      selectedUser.last_seen && `آخر ظهور ${formatDate(selectedUser.last_seen)}`
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Messages */}
            <ScrollArea className="flex-1 p-4">
              {messages.map((message, index) => {
                const isOwn = message.sender_id === user.id;
                const showDate = index === 0 ||
                  formatDate(messages[index - 1].created_at) !== formatDate(message.created_at);

                return (
                  <div key={message.id}>
                    {showDate && (
                      <div className="flex justify-center my-4">
                        <span className="bg-gray-200 text-gray-600 text-xs px-3 py-1 rounded-full">
                          {formatDate(message.created_at)}
                        </span>
                      </div>
                    )}

                    <div className={`flex mb-4 ${isOwn ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[70%] ${isOwn ? 'order-1' : 'order-2'}`}>
                        <Card className={`p-3 ${isOwn ? 'bg-blue-500 text-white' : 'bg-white'}`}>
                          {message.message_type === 'image' && message.image_url && (
                            <img
                              src={`${SOCKET_URL}${message.image_url}`}
                              alt="صورة"
                              className="rounded-lg max-w-full mb-2"
                            />
                          )}
                          {message.message_type === 'text' && (
                            <p className="text-sm whitespace-pre-wrap break-words">
                              {message.content}
                            </p>
                          )}
                          <div className={`flex items-center gap-2 mt-2 text-xs ${isOwn ? 'text-blue-100' : 'text-gray-500'
                            }`}>
                            <span>{formatTime(message.created_at)}</span>
                            {message.is_edited && <span>(معدلة)</span>}
                            {getStatusIcon(message)}
                          </div>
                        </Card>

                        {isOwn && message.message_type === 'text' && (
                          <div className="flex gap-2 mt-1 justify-end">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => startEditing(message)}
                            >
                              <Edit2 className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-red-500"
                              onClick={() => deleteMessage(message.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
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
            </ScrollArea>

            {/* Input */}
            <div className="bg-white border-t border-gray-200 p-4">
              {editingMessageId && (
                <div className="bg-blue-50 p-2 rounded-lg mb-2 flex items-center justify-between">
                  <span className="text-sm text-blue-700">تعديل الرسالة</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingMessageId(null);
                      setMessageText('');
                    }}
                  >
                    إلغاء
                  </Button>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) sendImage(file);
                  }}
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon className="h-5 w-5" />
                </Button>
                <Input
                  value={messageText}
                  onChange={handleTyping}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="اكتب رسالتك..."
                  className="flex-1"
                />
                <Button onClick={sendMessage} disabled={!messageText.trim()}>
                  <Send className="h-5 w-5" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <Clock className="h-16 w-16 mx-auto mb-4 text-gray-300" />
              <p>اختر محادثة للبدء</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
