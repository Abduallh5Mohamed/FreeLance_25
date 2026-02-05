import { useState, useEffect, useCallback } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

const API_URL = () => "/api";

interface Notification {
  id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
  sender_name?: string;
}

interface NotificationBellProps {
  userType: "student" | "teacher" | "admin";
}

// Request browser notification permission
const requestNotificationPermission = async () => {
  if (!("Notification" in window)) {
    console.log("This browser does not support notifications");
    return false;
  }

  if (Notification.permission === "granted") {
    return true;
  }

  if (Notification.permission !== "denied") {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  }

  return false;
};

// Show browser notification
const showBrowserNotification = (title: string, body: string, onClick?: () => void) => {
  if (Notification.permission === "granted") {
    const notification = new Notification(title, {
      body,
      icon: "/favicon.ico",
      badge: "/favicon.ico",
      tag: "message-notification",
      renotify: true,
      vibrate: [200, 100, 200],
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
      if (onClick) onClick();
    };

    // Auto close after 5 seconds
    setTimeout(() => notification.close(), 5000);
  }
};

export const NotificationBell = ({ userType }: NotificationBellProps) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const navigate = useNavigate();

  // Get user ID from localStorage
  const getUserId = useCallback(() => {
    try {
      const userStr = localStorage.getItem("currentUser");
      if (userStr) {
        const user = JSON.parse(userStr);
        return user.id;
      }
    } catch (e) {
      console.error("Error getting user ID:", e);
    }
    return null;
  }, []);

  // Request permission on mount
  useEffect(() => {
    const checkPermission = async () => {
      const granted = await requestNotificationPermission();
      setHasPermission(granted);
    };
    checkPermission();
  }, []);

  // Fetch notifications (using messages API for unread count)
  const fetchNotifications = useCallback(async () => {
    const userId = getUserId();
    if (!userId) {
      console.log("NotificationBell: userId is empty");
      return;
    }

    try {
      const token = localStorage.getItem("authToken");
      
      // Fetch unread count from messages API
      console.log(`Fetching unread count from: ${API_URL()}/messages/unread-total`);
      const countResponse = await fetch(
        `${API_URL()}/messages/unread-total`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      
      if (countResponse.ok) {
        const countData = await countResponse.json();
        console.log("Unread count response:", countData);
        const newCount = countData.count || 0;
        
        // Show browser notification if count increased
        if (newCount > unreadCount && unreadCount > 0) {
          showBrowserNotification(
            "رسالة جديدة 📩",
            `لديك ${newCount - unreadCount} رسالة جديدة`,
            () => {
              if (userType === "student") {
                navigate("/student-chat");
              } else {
                navigate("/messages");
              }
            }
          );
        }
        
        setUnreadCount(newCount);
      }

      // Fetch recent unread messages for list
      console.log(`Fetching recent unread from: ${API_URL()}/messages/recent-unread`);
      const response = await fetch(
        `${API_URL()}/messages/recent-unread`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json();
        console.log("Recent unread messages:", data);
        // Convert messages to notification format
        const messageNotifications = (Array.isArray(data) ? data : []).map((msg: any) => ({
          id: msg.id,
          title: `رسالة من ${msg.sender_name}`,
          message: msg.message_type === 'text' ? msg.content?.substring(0, 50) + (msg.content?.length > 50 ? '...' : '') : '📷 صورة',
          type: 'message',
          is_read: false,
          created_at: msg.created_at,
          sender_name: msg.sender_name,
        }));
        setNotifications(messageNotifications.slice(0, 10));
      }
    } catch (error) {
      console.error("Error fetching notifications:", error);
    }
  }, [getUserId, userType, unreadCount, navigate]);

  // Fetch on mount and every 30 seconds
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  // Mark notification as read
  const markAsRead = async (notificationId: string) => {
    try {
      const token = localStorage.getItem("authToken");
      await fetch(`${API_URL()}/notifications/${notificationId}/read`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, is_read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

  // Mark all as read
  const markAllAsRead = async () => {
    const userId = getUserId();
    if (!userId) return;

    try {
      const token = localStorage.getItem("authToken");
      await fetch(`${API_URL()}/notifications/mark-all-read?user_id=${userId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch (error) {
      console.error("Error marking all as read:", error);
    }
  };

  // Handle notification click
  const handleNotificationClick = (notification: Notification) => {
    markAsRead(notification.id);
    setIsOpen(false);
    
    // Navigate to messages
    if (userType === "student") {
      navigate("/student-chat");
    } else {
      navigate("/messages");
    }
  };

  // Request permission button click
  const handleRequestPermission = async () => {
    const granted = await requestNotificationPermission();
    setHasPermission(granted);
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "الآن";
    if (diffMins < 60) return `منذ ${diffMins} د`;
    if (diffHours < 24) return `منذ ${diffHours} س`;
    if (diffDays < 7) return `منذ ${diffDays} ي`;
    return date.toLocaleDateString("ar-EG");
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative p-2 text-white hover:bg-white/20 rounded-full"
          onClick={() => setIsOpen(true)}
        >
          <Bell className="w-5 h-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full px-1 animate-pulse">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="end"
        dir="rtl"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-cyan-500 to-teal-500 text-white rounded-t-lg">
          <h3 className="font-semibold text-sm">الإشعارات</h3>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-white/90 hover:text-white hover:bg-white/20 h-7 px-2"
                onClick={markAllAsRead}
              >
                قراءة الكل
              </Button>
            )}
          </div>
        </div>

        {/* Permission request banner */}
        {!hasPermission && Notification.permission !== "denied" && (
          <div className="px-4 py-2 bg-amber-50 border-b text-amber-800 text-xs">
            <div className="flex items-center justify-between">
              <span>فعّل الإشعارات للحصول على تنبيهات فورية</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs border-amber-400 text-amber-700 hover:bg-amber-100"
                onClick={handleRequestPermission}
              >
                تفعيل
              </Button>
            </div>
          </div>
        )}

        <ScrollArea className="max-h-[300px]">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Bell className="w-12 h-12 mb-2 opacity-30" />
              <p className="text-sm">لا توجد إشعارات</p>
            </div>
          ) : (
            <div className="divide-y">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={cn(
                    "px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors",
                    !notification.is_read && "bg-blue-50/50"
                  )}
                  onClick={() => handleNotificationClick(notification)}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "w-2 h-2 rounded-full mt-2 shrink-0",
                        notification.is_read ? "bg-gray-300" : "bg-blue-500"
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {notification.title || "رسالة جديدة"}
                      </p>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                        {notification.message}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {formatTime(notification.created_at)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="border-t px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-xs text-cyan-600 hover:text-cyan-700 hover:bg-cyan-50"
            onClick={() => {
              setIsOpen(false);
              if (userType === "student") {
                navigate("/student-chat");
              } else {
                navigate("/messages");
              }
            }}
          >
            عرض كل الرسائل
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default NotificationBell;
