import { useState, useEffect, useCallback } from 'react';
import { Bell, X, Check, CheckCheck } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatDistanceToNow } from 'date-fns';
import { ar } from 'date-fns/locale';
import { useNavigate } from 'react-router-dom';

// Get API base URL - same logic as api-http.ts
const getApiBaseUrl = (): string => {
    const envApiUrl = import.meta.env.VITE_API_URL;
    if (envApiUrl) return envApiUrl;

    const currentHost = window.location.hostname;
    if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
        return `http://${currentHost}:3001/api`;
    }
    return 'http://localhost:3001/api';
};

const API_BASE_URL = getApiBaseUrl();

interface Notification {
    id: string;
    user_id: string;
    user_type: 'admin' | 'student';
    title: string;
    message: string;
    type: 'message' | 'exam_graded' | 'payment' | 'subscription' | 'general';
    link?: string;
    is_read: boolean;
    created_at: string;
}

interface NotificationBellProps {
    userId: string;
    userType: 'admin' | 'student';
}

export const NotificationBell = ({ userId, userType }: NotificationBellProps) => {
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isOpen, setIsOpen] = useState(false);
    const navigate = useNavigate();

    // Fetch unread count
    const fetchUnreadCount = useCallback(async () => {
        if (!userId) {
            console.warn('NotificationBell: userId is empty');
            return;
        }
        try {
            const url = `${API_BASE_URL}/notifications/unread-count?user_id=${userId}&user_type=${userType}`;
            console.log('Fetching unread count from:', url);
            const response = await fetch(url);
            const data = await response.json();
            console.log('Unread count response:', data);
            setUnreadCount(data.count || 0);
        } catch (error) {
            console.error('Error fetching unread count:', error);
        }
    }, [userId, userType]);

    // Fetch notifications
    const fetchNotifications = useCallback(async () => {
        if (!userId) {
            console.warn('NotificationBell: userId is empty');
            return;
        }
        try {
            const url = `${API_BASE_URL}/notifications?user_id=${userId}&user_type=${userType}`;
            console.log('Fetching notifications from:', url);
            const response = await fetch(url);
            const data = await response.json();
            console.log('Notifications response:', data);
            setNotifications(data || []);
        } catch (error) {
            console.error('Error fetching notifications:', error);
        }
    }, [userId, userType]);

    // Mark notification as read
    const markAsRead = async (notificationId: string) => {
        try {
            await fetch(`${API_BASE_URL}/notifications/${notificationId}/read`, {
                method: 'PUT',
            });

            setNotifications(prev =>
                prev.map(n => (n.id === notificationId ? { ...n, is_read: true } : n))
            );
            fetchUnreadCount();
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    };

    // Mark all as read
    const markAllAsRead = async () => {
        try {
            await fetch(`${API_BASE_URL}/notifications/read-all`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ user_id: userId, user_type: userType }),
            });

            setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
            setUnreadCount(0);
        } catch (error) {
            console.error('Error marking all as read:', error);
        }
    };

    // Handle notification click
    const handleNotificationClick = (notification: Notification) => {
        if (!notification.is_read) {
            markAsRead(notification.id);
        }

        if (notification.link) {
            navigate(notification.link);
            setIsOpen(false);
        }
    };

    // Fetch on mount and set polling
    useEffect(() => {
        fetchUnreadCount();
        fetchNotifications();

        // Poll every 30 seconds
        const interval = setInterval(() => {
            fetchUnreadCount();
            if (isOpen) {
                fetchNotifications();
            }
        }, 30000);

        return () => clearInterval(interval);
    }, [userId, userType, fetchUnreadCount, fetchNotifications, isOpen]);

    // Fetch notifications when dropdown opens
    useEffect(() => {
        if (isOpen) {
            fetchNotifications();
        }
    }, [isOpen, fetchNotifications]);

    const getNotificationIcon = (type: string) => {
        switch (type) {
            case 'message':
                return '💬';
            case 'exam_graded':
                return '📝';
            case 'payment':
                return '💰';
            case 'subscription':
                return '📚';
            default:
                return '🔔';
        }
    };

    return (
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="relative text-white hover:text-white hover:bg-white/20 rounded-lg"
                    title="الإشعارات"
                >
                    <Bell className="h-5 w-5" />
                    {unreadCount > 0 && (
                        <Badge
                            variant="destructive"
                            className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
                        >
                            {unreadCount > 9 ? '9+' : unreadCount}
                        </Badge>
                    )}
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-80 md:w-96">
                <div className="flex items-center justify-between px-4 py-2 border-b">
                    <h3 className="font-semibold">الإشعارات</h3>
                    {unreadCount > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={markAllAsRead}
                            className="text-xs h-7"
                        >
                            <CheckCheck className="h-3 w-3 mr-1" />
                            تعليم الكل كمقروء
                        </Button>
                    )}
                </div>

                <ScrollArea className="h-96">
                    {notifications.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                            <Bell className="h-12 w-12 mb-2 opacity-20" />
                            <p>لا توجد إشعارات</p>
                        </div>
                    ) : (
                        <div className="divide-y">
                            {notifications.map((notification) => (
                                <div
                                    key={notification.id}
                                    className={`p-4 hover:bg-muted/50 cursor-pointer transition-colors ${!notification.is_read ? 'bg-blue-50/50' : ''
                                        }`}
                                    onClick={() => handleNotificationClick(notification)}
                                >
                                    <div className="flex items-start gap-3">
                                        <span className="text-2xl">{getNotificationIcon(notification.type)}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center justify-between gap-2 mb-1">
                                                <h4 className="font-medium text-sm">{notification.title}</h4>
                                                {!notification.is_read && (
                                                    <span className="h-2 w-2 bg-blue-500 rounded-full flex-shrink-0"></span>
                                                )}
                                            </div>
                                            <p className="text-sm text-muted-foreground line-clamp-2">
                                                {notification.message}
                                            </p>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                {formatDistanceToNow(new Date(notification.created_at), {
                                                    addSuffix: true,
                                                    locale: ar,
                                                })}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </ScrollArea>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
