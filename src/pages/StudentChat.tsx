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
import { sendAiChatMessage, AUTH_SESSION_CHANGED_EVENT, verifyCurrentSession, getCurrentStudentEnrollment, authenticatedApiFetch, readAuthenticatedApiJson } from '@/lib/api';

// All chat HTTP uses the shared session-revocation boundary.
const chatRequest = async <T = any,>(path: string, init?: RequestInit): Promise<{ data: T }> => {
  const response = await authenticatedApiFetch(path, init);
  if (!response.ok) throw new Error('تعذر إتمام طلب المحادثة (' + response.status + ')');
  return { data: await readAuthenticatedApiJson(response) as T };
};

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

const AI_ASSISTANT_ID = 'ai-assistant';
const AI_HISTORY_KEY_PREFIX = 'ai-messages-';

const aiHistoryKey = (studentId: string) => AI_HISTORY_KEY_PREFIX + studentId;

const createWelcomeAiMessage = (studentId: string): Message => ({
  id: 1,
  sender_id: AI_ASSISTANT_ID,
  receiver_id: studentId,
  content: 'السلام عليكم! أنا مساعدك الذكي المتخصص في مادة التاريخ. كيف يمكنني مساعدتك اليوم؟',
  message_type: 'text',
  is_edited: false,
  is_deleted: false,
  created_at: new Date().toISOString(),
  is_delivered: true,
  is_read: true
});

const normalizeStoredAiMessage = (value: unknown, studentId: string): Message | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const senderId = record.sender_id;
  const content = record.content;
  const createdAt = record.created_at;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return null;
  if (typeof senderId !== 'string' || (senderId !== studentId && senderId !== AI_ASSISTANT_ID)) return null;
  if (typeof content !== 'string' || typeof createdAt !== 'string') return null;
  const messageType = record.message_type === 'image' ? 'image'
    : record.message_type === 'text' ? 'text' : null;
  if (!messageType) return null;
  const imageUrl = typeof record.image_url === 'string' ? record.image_url : undefined;
  if (messageType === 'image' && !imageUrl) return null;
  const receiverId = typeof record.receiver_id === 'string' && record.receiver_id
    ? record.receiver_id
    : senderId === AI_ASSISTANT_ID ? studentId : AI_ASSISTANT_ID;
  const participantsValid = (senderId === studentId && receiverId === AI_ASSISTANT_ID)
    || (senderId === AI_ASSISTANT_ID && receiverId === studentId);
  if (!participantsValid) return null;
  return {
    id,
    sender_id: senderId,
    receiver_id: receiverId,
    content,
    message_type: messageType,
    image_url: imageUrl,
    is_edited: record.is_edited === true,
    edited_at: typeof record.edited_at === 'string' ? record.edited_at : undefined,
    is_deleted: record.is_deleted === true,
    deleted_at: typeof record.deleted_at === 'string' ? record.deleted_at : undefined,
    created_at: createdAt,
    sender_name: typeof record.sender_name === 'string' ? record.sender_name : undefined,
    sender_role: typeof record.sender_role === 'string' ? record.sender_role : undefined,
    is_delivered: record.is_delivered !== false,
    is_read: record.is_read !== false
  };
};

const readStoredAiHistory = (raw: string | null, studentId: string): { messages: Message[]; corrupt: boolean } => {
  if (raw === null) return { messages: [], corrupt: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { messages: [], corrupt: true };
    const seen = new Set<number>();
    const messages: Message[] = [];
    let corrupt = false;
    for (const entry of parsed) {
      const message = normalizeStoredAiMessage(entry, studentId);
      if (!message || seen.has(message.id)) {
        corrupt = true;
        continue;
      }
      seen.add(message.id);
      messages.push(message);
    }
    return { messages, corrupt };
  } catch {
    return { messages: [], corrupt: true };
  }
};

const writeStoredAiHistory = (studentId: string, messages: Message[]): boolean => {
  try {
    localStorage.setItem(aiHistoryKey(studentId), JSON.stringify(messages));
    return true;
  } catch {
    return false;
  }
};

export default function StudentChat() {
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [academicContacts, setAcademicContacts] = useState<User[]>([]);
  const [contactsError, setContactsError] = useState<string | null>(null);
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

  const conversationDraftsRef = useRef(new Map<string, string>());
  const pendingSendRef = useRef<{ peer: string; content: string; editId: number | null; token: string | null } | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readReceiptQueueRef = useRef(new Set<number>());
  const aiTranscriptRef = useRef<Message[]>([]);
  const localMessageIdRef = useRef(-Date.now());
  const aiBusyRef = useRef(false);
  const imageBusyRef = useRef(false);
  const messageTextRef = useRef('');
  const currentUserIdRef = useRef<string | null>(null);
  const [sendPending, setSendPending] = useState(false);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const selectedUserRef = useRef<User | null>(null);
  const messageLoadRef = useRef(0);
  const socketRef = useRef<Socket | null>(null);
  const sessionTokenRef = useRef(localStorage.getItem('authToken'));

  const nextLocalMessageId = () => {
    const id = localMessageIdRef.current;
    localMessageIdRef.current -= 1;
    return id;
  };

  const setConversationDraft = (peer: string, value: string) => {
    if (value.length > 0) conversationDraftsRef.current.set(peer, value);
    else conversationDraftsRef.current.delete(peer);
  };

  const updateMessageText = (value: string) => {
    messageTextRef.current = value;
    setMessageText(value);
  };

  const rememberActiveDraft = () => {
    const peer = selectedUserRef.current?.id;
    if (peer && messageTextRef.current.length > 0) setConversationDraft(peer, messageTextRef.current);
  };

  const isSessionCurrent = () => mountedRef.current && !!sessionTokenRef.current
    && sessionTokenRef.current === localStorage.getItem('authToken');
  const isActiveMessage = (message: Message) => {
    const peer = selectedUserRef.current?.id;
    return !!peer && (String(message.sender_id) === peer || String(message.receiver_id) === peer);
  };

  const getToken = () => localStorage.getItem('authToken');

  const flushReadReceipts = () => {
    const activeSocket = socketRef.current;
    const userId = currentUserIdRef.current;
    if (!activeSocket?.connected || !userId || !isSessionCurrent()) return;
    for (const messageId of Array.from(readReceiptQueueRef.current)) {
      activeSocket.emit('message:read', { messageId, userId });
      readReceiptQueueRef.current.delete(messageId);
    }
  };

  const queueReadReceipts = (source: Message[]) => {
    const userId = currentUserIdRef.current;
    if (!userId) return;
    for (const message of source) {
      const messageId = Number(message?.id);
      if (message && Number.isSafeInteger(messageId) && messageId > 0
        && String(message.receiver_id) === userId && String(message.sender_id) !== userId
        && message.is_read !== true) {
        readReceiptQueueRef.current.add(messageId);
      }
    }
    flushReadReceipts();
  };

  const stopTyping = (peer: string | null) => {
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = null;
    const activeSocket = socketRef.current;
    const userId = currentUserIdRef.current;
    if (peer && peer !== AI_ASSISTANT_ID && activeSocket?.connected && userId && isSessionCurrent()) {
      activeSocket.emit('typing:stop', { senderId: userId, receiverId: peer });
    }
  };

  const completePendingSend = (peer: string | null, content: string, editId: number | null) => {
    const pending = pendingSendRef.current;
    if (!pending || pending.peer !== peer || pending.content !== content || pending.editId !== editId
      || pending.token !== localStorage.getItem('authToken')) return;
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = null;
    pendingSendRef.current = null;
    setSendPending(false);
    const draft = conversationDraftsRef.current.get(pending.peer);
    if (draft !== undefined && draft.trim() === pending.content) conversationDraftsRef.current.delete(pending.peer);
    if (selectedUserRef.current?.id === peer) {
      if (messageTextRef.current.trim() === pending.content) updateMessageText('');
      setEditingMessageId(current => current === editId ? null : current);
      setSendNotice(null);
    }
  };

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
    mountedRef.current = true;
    let disposed = false;
    const invalidateSession = () => {
      if (sessionTokenRef.current === localStorage.getItem('authToken')) return;
      const peer = selectedUserRef.current?.id;
      const activeSocket = socketRef.current;
      const activeUserId = currentUserIdRef.current;
      if (peer && peer !== AI_ASSISTANT_ID && activeSocket?.connected && activeUserId) {
        activeSocket.emit('typing:stop', { senderId: activeUserId, receiverId: peer });
      }
      mountedRef.current = false;
      messageLoadRef.current += 1;
      socketRef.current?.disconnect();
      socketRef.current = null;
      selectedUserRef.current = null;
      currentUserIdRef.current = null;
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
      sendTimerRef.current = null;
      typingStopTimerRef.current = null;
      pendingSendRef.current = null;
      readReceiptQueueRef.current.clear();
      aiTranscriptRef.current = [];
      messageTextRef.current = '';
      setUser(null); setSelectedUser(null); setMessages([]); setConversations([]);
      setAcademicContacts([]); setMessageText('');
      setSendPending(false); setSendNotice(null); setIsLoading(false);
      setEditingMessageId(null); setIsTyping(false);
      conversationDraftsRef.current.clear();
      navigate('/auth', { replace: true });
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === 'authToken') invalidateSession();
    };
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, invalidateSession);
    window.addEventListener('storage', onStorage);

    void (async () => {
      try {
        if (!getToken()) { navigate('/auth'); return; }
        const verification = await verifyCurrentSession();
        if (disposed || !isSessionCurrent()) return;
        if (verification.state === 'anonymous') { navigate('/auth'); return; }
        if (verification.state === 'changed') return;
        if (verification.state !== 'authenticated') {
          setContactsError('تعذر التحقق من الجلسة مؤقتًا؛ أعد تحميل الصفحة للمحاولة.'); return;
        }
        if (verification.user.role !== 'student') { navigate('/auth'); return; }
        const enrollment = await getCurrentStudentEnrollment();
        if (disposed || !isSessionCurrent()) return;
        if (!enrollment?.id || !enrollment.tenant_id) {
          setContactsError('اختر مساحة طالب نشطة قبل فتح الرسائل.'); return;
        }
        currentUserIdRef.current = verification.user.id;
        setUser(verification.user);
        void loadConversations();
        void loadAcademicContacts();
        initializeSocket(verification.user);
      } catch {
        if (!disposed && isSessionCurrent()) setContactsError('تعذر التحقق من الجلسة؛ أعد تحميل الصفحة.');
      }
    })();
    return () => {
      disposed = true;
      const peer = selectedUserRef.current?.id;
      const activeSocket = socketRef.current;
      const activeUserId = currentUserIdRef.current;
      if (peer && peer !== AI_ASSISTANT_ID && activeSocket?.connected && activeUserId) {
        activeSocket.emit('typing:stop', { senderId: activeUserId, receiverId: peer });
      }
      mountedRef.current = false;
      messageLoadRef.current += 1;
      socketRef.current?.disconnect();
      socketRef.current = null;
      selectedUserRef.current = null;
      currentUserIdRef.current = null;
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
      sendTimerRef.current = null;
      typingStopTimerRef.current = null;
      pendingSendRef.current = null;
      readReceiptQueueRef.current.clear();
      aiTranscriptRef.current = [];
      conversationDraftsRef.current.clear();
      messageTextRef.current = '';
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, invalidateSession);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Initialize Socket.IO
  const initializeSocket = (userData: any) => {
    const newSocket = io(window.location.origin, {
      auth: { token: localStorage.getItem('authToken') },
      path: '/socket.io',
      transports: ['websocket', 'polling']
    });

    socketRef.current = newSocket;
    newSocket.onAny(() => { if (!isSessionCurrent()) newSocket.disconnect(); });
    newSocket.on('connect', () => {
      if (!isSessionCurrent()) return;
      newSocket.emit('user:connect', userData.id);
      flushReadReceipts();
    });

    newSocket.on('message:new', (message: any) => {
      if (!isSessionCurrent()) return;
      try {
        if (message && message.id && isActiveMessage(message) && (message.content || message.image_url)) {
          const incoming: Message = {
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
          };
          setMessages(prev => {
            if (prev.some(m => m.id === incoming.id)) return prev;
            return [...prev, incoming];
          });
          queueReadReceipts([incoming]);
        }
        loadConversations();
      } catch (error) {
        console.error('Error handling new message:', error);
      }
    });

    newSocket.on('message:sent', (message: Message) => {
      if (!isSessionCurrent() || !message?.id) return;
      completePendingSend(message.receiver_id, message.content, null);
      if (!isActiveMessage(message)) return;
      setMessages(prev => {
        if (prev.some(m => m.id === message.id)) {
          return prev.map(m => m.id === message.id ? message : m);
        }
        return [...prev, message];
      });
    });

    newSocket.on('message:read', (data: { messageId: number; readAt?: Date | string }) => {
      if (!isSessionCurrent() || typeof data?.messageId !== 'number') return;
      const readAt = data.readAt ? String(data.readAt) : new Date().toISOString();
      setMessages(prev => prev.map(msg =>
        msg.id === data.messageId ? { ...msg, is_read: true, read_at: readAt } : msg
      ));
    });

    newSocket.on('message:edited', (data: any) => {
      if (!isSessionCurrent()) return;
      const pending = pendingSendRef.current;
      if (pending?.editId === data.messageId) completePendingSend(pending.peer, data.content, data.messageId);
      setMessages(prev => prev.map(msg =>
        msg.id === data.messageId ? { ...msg, content: data.content, is_edited: true, edited_at: data.editedAt } : msg
      ));
    });

    newSocket.on('message:error', () => {
      if (isSessionCurrent() && pendingSendRef.current) {
        setSendNotice('تعذر تأكيد الإرسال. المسودة محفوظة؛ راجع سجل المحادثة قبل إعادة المحاولة.');
      }
    });

    newSocket.on('message:deleted', (data: { messageId: number }) => {
      if (!isSessionCurrent()) return;
      setMessages(prev => prev.filter(msg => msg.id !== data.messageId));
    });

    newSocket.on('user:status', (data: { userId: string; isOnline: boolean; lastSeen?: Date }) => {
      if (!isSessionCurrent()) return;
      setAcademicContacts((previous) => previous.map((contact) =>
        contact.id === data.userId
          ? { ...contact, is_online: data.isOnline, last_seen: data.lastSeen?.toString() }
          : contact
      ));
      if (selectedUserRef.current?.id === data.userId) {
        setSelectedUser(prev => prev ? { ...prev, is_online: data.isOnline, last_seen: data.lastSeen?.toString() } : null);
      }
    });

    newSocket.on('typing:start', (data: { userId: string }) => {
      if (isSessionCurrent() && data.userId === selectedUserRef.current?.id) setIsTyping(true);
    });
    newSocket.on('typing:stop', (data: { userId: string }) => { if (isSessionCurrent() && data.userId === selectedUserRef.current?.id) setIsTyping(false); });
    newSocket.on('disconnect', () => {
      if (!isSessionCurrent()) return;
      console.log('🔌 Student socket disconnected');
      if (pendingSendRef.current) {
        setSendNotice('انقطع الاتصال. نتيجة الإرسال غير مؤكدة والمسودة محفوظة؛ راجع سجل المحادثة قبل إعادة الإرسال.');
      }
    });
    newSocket.on('connect_error', (err: any) => console.error('Socket error:', err.message));
  };

  const loadConversations = async () => {
    try {
      const token = getToken();
      const res = await chatRequest('/messages/conversations');
      if (!isSessionCurrent() || token !== getToken()) return;
      setConversations(Array.isArray(res.data) ? res.data : []);
    } catch (error) {
      if (isSessionCurrent()) setContactsError('تعذر تحميل المحادثات؛ أعد المحاولة.');
    }
  };

  const loadAcademicContacts = async () => {
    try {
      const token = getToken();
      const response = await chatRequest<User[]>('/messages/users/available');
      if (!isSessionCurrent() || token !== getToken()) return;
      setAcademicContacts(Array.isArray(response.data) ? response.data : []);
      setContactsError(null);
    } catch (error) {
      if (!isSessionCurrent()) return;
      setAcademicContacts([]);
      setContactsError('تعذر تحميل جهات التواصل المسموح بها. حاول مرة أخرى.');
    }
  };

  const loadMessages = async (userId: string) => {
    const sequence = ++messageLoadRef.current;
    const tokenAtStart = getToken();
    const ownsLoad = () => isSessionCurrent() && sequence === messageLoadRef.current
      && tokenAtStart === getToken() && selectedUserRef.current?.id === userId;
    if (userId === AI_ASSISTANT_ID) {
      const studentId = user?.id;
      if (!isSessionCurrent() || selectedUserRef.current?.id !== userId) return;
      if (!studentId) {
        setMessages([]);
        setIsLoading(false);
        return;
      }
      let raw: string | null = null;
      let readFailed = false;
      try {
        raw = localStorage.getItem(aiHistoryKey(studentId));
      } catch {
        readFailed = true;
      }
      const stored = readFailed
        ? { messages: [] as Message[], corrupt: true }
        : readStoredAiHistory(raw, studentId);
      const nextMessages = stored.messages.length > 0 ? stored.messages : [createWelcomeAiMessage(studentId)];
      aiTranscriptRef.current = nextMessages;
      setMessages(nextMessages);
      if (stored.corrupt) {
        setSendNotice('تعذر قراءة سجل المساعد المحلي بالكامل؛ عُرض ما أمكن قراءته. لن يُستبدل السجل حتى يؤكد الخادم ردًا جديدًا.');
      }
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const token = getToken();
      const res = await chatRequest('/messages/' + encodeURIComponent(userId));
      if (!ownsLoad()) return;
      if (!Array.isArray(res.data)) throw new Error('Invalid message list');
      setMessages(res.data);
      queueReadReceipts(res.data);
      try {
        await chatRequest('/messages/mark-all-read/' + encodeURIComponent(userId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        loadConversations();
      } catch (err) {
        console.error('Error marking messages as read:', err);
      }
    } catch (error) {
      if (ownsLoad()) setSendNotice('تعذر تحميل سجل المحادثة؛ القائمة الحالية ليست إثباتًا لعدم وجود رسائل.');
    } finally {
      if (ownsLoad()) setIsLoading(false);
    }
  };

  // Send message
  const sendMessage = async () => {
    if (!isSessionCurrent() || !messageText.trim() || !selectedUser || pendingSendRef.current || aiBusyRef.current) return;
    const studentId = user?.id || currentUserIdRef.current;
    if (!studentId) return;

    if (selectedUser.id === AI_ASSISTANT_ID) {
      aiBusyRef.current = true;
      const currentMessage = messageText.trim();
      const userMessageId = nextLocalMessageId();
      const userMessage: Message = {
        id: userMessageId, sender_id: studentId, receiver_id: AI_ASSISTANT_ID,
        content: currentMessage, message_type: 'text', is_edited: false, is_deleted: false,
        created_at: new Date().toISOString(), is_delivered: true, is_read: true
      };
      aiTranscriptRef.current = [...aiTranscriptRef.current, userMessage];
      setConversationDraft(AI_ASSISTANT_ID, currentMessage);
      setMessages(prev => [...prev, userMessage]);
      updateMessageText('');
      if (textareaRef.current) textareaRef.current.style.height = '48px';
      setIsTyping(true);

      sendAiChatMessage(currentMessage)
        .then(aiResponse => {
          if (typeof aiResponse !== 'string' || !aiResponse.trim()) throw new Error('No valid response from AI');
          if (!isSessionCurrent()) return;
          const reply: Message = {
            id: nextLocalMessageId(), sender_id: AI_ASSISTANT_ID, receiver_id: studentId,
            content: aiResponse, message_type: 'text',
            is_edited: false, is_deleted: false, created_at: new Date().toISOString(),
            is_delivered: true, is_read: true
          };
          const transcript = aiTranscriptRef.current.some(message => message.id === userMessageId)
            ? aiTranscriptRef.current
            : [...aiTranscriptRef.current, userMessage];
          const nextTranscript = transcript.some(message => message.id === reply.id)
            ? transcript
            : [...transcript, reply];
          aiTranscriptRef.current = nextTranscript;
          const persisted = writeStoredAiHistory(studentId, nextTranscript);
          const draft = conversationDraftsRef.current.get(AI_ASSISTANT_ID);
          if (draft !== undefined && draft.trim() === currentMessage) conversationDraftsRef.current.delete(AI_ASSISTANT_ID);
          if (selectedUserRef.current?.id === AI_ASSISTANT_ID) {
            setMessages(prev => {
              const withUser = prev.some(message => message.id === userMessageId) ? prev : [...prev, userMessage];
              return withUser.some(message => message.id === reply.id) ? withUser : [...withUser, reply];
            });
            setSendNotice(persisted ? null : 'تم تأكيد رد المساعد، لكن تعذر حفظ السجل محليًا؛ ستظهر المحادثة في هذه الجلسة فقط.');
            setIsTyping(false);
          }
        })
        .catch(() => {
          aiTranscriptRef.current = aiTranscriptRef.current.filter(message => message.id !== userMessageId);
          if (!isSessionCurrent() || selectedUserRef.current?.id !== AI_ASSISTANT_ID) return;
          setMessages(prev => prev.filter(message => message.id !== userMessageId));
          if (messageTextRef.current.length === 0) {
            setConversationDraft(AI_ASSISTANT_ID, currentMessage);
            updateMessageText(currentMessage);
          }
          setSendNotice('تعذر تأكيد رد المساعد. لم تُحفظ الرسالة غير المؤكدة في السجل؛ راجع المسودة قبل إعادة المحاولة، ولا إعادة إرسال تلقائية.');
          setIsTyping(false);
        }).finally(() => { aiBusyRef.current = false; });
      return;
    }

    const activeSocket = socketRef.current;
    if (!activeSocket?.connected) {
      setSendNotice('الاتصال غير متاح؛ لم يتم إرسال الرسالة والمسودة محفوظة.');
      return;
    }
    const pending = { peer: selectedUser.id, content: messageText.trim(), editId: editingMessageId,
      token: getToken() };
    pendingSendRef.current = pending; // synchronous latch before emit
    setConversationDraft(pending.peer, pending.content);
    setSendPending(true);
    setSendNotice('جارٍ انتظار تأكيد الحفظ من الخادم…');
    sendTimerRef.current = setTimeout(() => {
      if (isSessionCurrent() && pendingSendRef.current === pending) {
        setSendNotice('نتيجة الإرسال غير مؤكدة. المسودة محفوظة؛ راجع المحادثة قبل إعادة الإرسال.');
      }
    }, 15000);
    if (editingMessageId) {
      activeSocket.emit('message:edit', { messageId: editingMessageId, userId: studentId, content: pending.content });
    } else {
      activeSocket.emit('message:send', {
        senderId: studentId, receiverId: selectedUser.id, content: pending.content, messageType: 'text'
      });
    }
    // Neither an emit nor a timeout proves persistence. Keep the draft until
    // the existing server sent/edited event acknowledges this socket's write.
    stopTyping(selectedUser.id);
  };

  const releaseUnconfirmedSend = () => {
    const pending = pendingSendRef.current;
    if (!pending) return;
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = null;
    pendingSendRef.current = null;
    setSendPending(false);
    if (selectedUserRef.current?.id === pending.peer) {
      setSendNotice('أُنهيت حالة الانتظار دون إعادة إرسال. قد تكون الرسالة محفوظة على الخادم؛ راجع سجل المحادثة قبل الإرسال مرة أخرى.');
    }
  };

  const sendImage = async (file: File) => {
    if (!isSessionCurrent() || !selectedUser || selectedUser.id === 'ai-assistant' || imageBusyRef.current) return;
    imageBusyRef.current = true;
    const formData = new FormData();
    formData.append('image', file);
    formData.append('receiver_id', selectedUser.id);
    try {
      const token = getToken();
      const res = await chatRequest('/messages/upload-image', { method: 'POST', body: formData });
      if (!isSessionCurrent() || token !== getToken() || selectedUserRef.current?.id !== res.data.receiver_id) return;
      setMessages(prev => prev.some(message => message.id === res.data.id) ? prev : [...prev, res.data]);
    } catch (error) {
      if (isSessionCurrent()) setSendNotice('لم يتم تأكيد رفع الصورة؛ راجع المحادثة قبل المحاولة مرة أخرى.');
    } finally {
      imageBusyRef.current = false;
    }
  };

  const handleTyping = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    updateMessageText(value);
    const peer = selectedUserRef.current?.id;
    if (peer) setConversationDraft(peer, value);
    if (textareaRef.current) {
      textareaRef.current.style.height = '48px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
    const activeSocket = socketRef.current;
    const studentId = currentUserIdRef.current;
    if (activeSocket?.connected && peer && peer !== AI_ASSISTANT_ID && studentId && isSessionCurrent()) {
      const tokenAtStart = getToken();
      activeSocket.emit('typing:start', { senderId: studentId, receiverId: peer });
      if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = setTimeout(() => {
        typingStopTimerRef.current = null;
        if (isSessionCurrent() && getToken() === tokenAtStart
          && selectedUserRef.current?.id === peer && activeSocket.connected) {
          activeSocket.emit('typing:stop', { senderId: studentId, receiverId: peer });
        }
      }, 2000);
    }
  };

  const selectUser = (chatUser: User) => {
    if (!isSessionCurrent()) return;
    const previousPeer = selectedUserRef.current?.id;
    rememberActiveDraft();
    stopTyping(previousPeer);
    selectedUserRef.current = chatUser;
    setSendNotice(pendingSendRef.current ? 'هناك إرسال سابق غير مؤكد؛ راجع سجل المحادثة السابقة قبل أي إعادة إرسال.' : null);
    setIsTyping(false);
    setSelectedUser(chatUser);
    setMessages([]);
    setEditingMessageId(null);
    updateMessageText(conversationDraftsRef.current.get(chatUser.id) ?? '');
    loadMessages(chatUser.id);
  };

  const deleteMessage = (messageId: number) => {
    const activeSocket = socketRef.current;
    const studentId = currentUserIdRef.current;
    if (!activeSocket?.connected || !studentId || !isSessionCurrent()) return;
    activeSocket.emit('message:delete', { messageId, userId: studentId });
  };

  const startEditing = (message: Message) => {
    setEditingMessageId(message.id);
    updateMessageText(message.content);
  };

  const cancelEditing = () => {
    setEditingMessageId(null);
    const peer = selectedUserRef.current?.id;
    if (peer) setConversationDraft(peer, '');
    updateMessageText('');
  };

  const handleBackToList = () => {
    const previousPeer = selectedUserRef.current?.id;
    rememberActiveDraft();
    stopTyping(previousPeer);
    selectedUserRef.current = null;
    messageLoadRef.current += 1;
    setIsTyping(false);
    setIsLoading(false);
    setSendNotice(null);
    setEditingMessageId(null);
    updateMessageText('');
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

  const getContactUnread = (contactId: string) => {
    const conv = conversations.find(c => c.other_user_id === contactId);
    return conv?.unread_count || 0;
  };

  const showContactsList = !isMobile || (isMobile && !selectedUser);
  const showChatArea = !isMobile || (isMobile && !!selectedUser);

  if (!user && contactsError) {
    return <div dir="rtl" className="p-6"><p role="alert">{contactsError}</p><Button onClick={() => window.location.reload()}>إعادة تحميل الصفحة</Button></div>;
  }
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
              {/* Academic contacts allowed by the backend */}
              {academicContacts.length > 0 && (
                <div className="p-2">
                  <h3 className="text-xs font-bold text-orange-500 px-3 mb-2 flex items-center gap-1">
                    <GraduationCap className="w-3 h-3" />
                    المدرسون
                  </h3>
                  {academicContacts
                    .filter((contact) => (contact.name || contact.username || '').toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((contact) => (
                    <button
                      key={contact.id}
                      onClick={() => selectUser(contact)}
                      className={`
                        w-full p-3 rounded-xl flex items-center gap-3 transition-all duration-200 text-right mb-1
                        ${selectedUser?.id === contact.id
                          ? 'bg-orange-50 ring-2 ring-orange-200 shadow-sm'
                          : 'hover:bg-slate-50'}
                      `}
                    >
                      <div className="relative shrink-0">
                        <Avatar className="bg-gradient-to-br from-orange-400 to-amber-500">
                          <AvatarFallback className="text-white font-bold">
                            {(contact.name || contact.username || 'م').substring(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        {contact.is_online && (
                          <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full"></span>
                        )}
                      </div>
                      <div className="flex-1 overflow-hidden min-w-0">
                        <span className="font-semibold truncate text-sm block">{contact.name || contact.username || 'مدرس'}</span>
                        <p className="text-xs text-muted-foreground">
                          {contact.is_online ? 'متصل الآن' : contact.role === 'instructor' ? 'مدرس المنصة' : 'المدرس'}
                        </p>
                      </div>
                      {getContactUnread(contact.id) > 0 && (
                        <span className="bg-orange-500 text-white text-xs px-2 py-0.5 rounded-full min-w-[20px] text-center shrink-0">
                          {getContactUnread(contact.id)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {contactsError && (
                <div className="mx-3 my-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  <p>{contactsError}</p>
                  <button className="mt-2 font-semibold underline" onClick={loadAcademicContacts}>إعادة المحاولة</button>
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

                {sendNotice && <div className="px-4 py-2 text-sm">
                  <p role="status" aria-live="polite">{sendNotice}</p>
                  {sendPending && selectedUser && pendingSendRef.current?.peer === selectedUser.id && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      <Button
                        variant="outline" size="sm" onClick={() => void loadMessages(selectedUser.id)}
                      >مراجعة سجل المحادثة</Button>
                      <Button
                        variant="ghost" size="sm" onClick={releaseUnconfirmedSend}
                      >إنهاء الانتظار دون إعادة إرسال</Button>
                    </div>
                  )}
                </div>}
                {/* Input Area - Fixed at bottom */}
                <div className="p-3 md:p-4 bg-white border-t shrink-0">
                  {editingMessageId && (
                    <div className="bg-orange-50 p-2 rounded-lg mb-2 flex items-center justify-between">
                      <span className="text-sm text-orange-700">تعديل الرسالة</span>
                      <Button variant="ghost" size="sm" onClick={cancelEditing}>إلغاء</Button>
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
                      disabled={!messageText.trim() || sendPending}
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
