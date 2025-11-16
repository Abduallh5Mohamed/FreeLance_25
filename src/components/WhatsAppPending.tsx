import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink, Send, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

interface PendingWhatsApp {
    id: number;
    guardian_phone: string;
    student_name: string;
    amount: number;
    grade_name?: string;
    group_name?: string;
    whatsapp_link?: string;
    created_at: string;
}

export function WhatsAppPending() {
    const [pendingMessages, setPendingMessages] = useState<PendingWhatsApp[]>([]);
    const [loading, setLoading] = useState(true);

    // يمكنك تخزين روابط WhatsApp في localStorage أو database
    // هنا مثال بسيط باستخدام localStorage

    useEffect(() => {
        loadPendingMessages();
    }, []);

    const loadPendingMessages = () => {
        try {
            const stored = localStorage.getItem('pending_whatsapp_messages');
            if (stored) {
                setPendingMessages(JSON.parse(stored));
            }
        } catch (error) {
            console.error('Error loading pending messages:', error);
        } finally {
            setLoading(false);
        }
    };

    const openWhatsApp = (link: string, messageId: number) => {
        // فتح رابط WhatsApp في نافذة جديدة
        window.open(link, '_blank');

        // حذف الرسالة من القائمة بعد الإرسال
        setTimeout(() => {
            markAsSent(messageId);
        }, 1000);
    };

    const markAsSent = (messageId: number) => {
        const updated = pendingMessages.filter(msg => msg.id !== messageId);
        setPendingMessages(updated);
        localStorage.setItem('pending_whatsapp_messages', JSON.stringify(updated));
        toast.success('تم وضع علامة كـ "تم الإرسال"');
    };

    const generateWhatsAppLink = (phone: string, message: string) => {
        const cleanPhone = phone.replace(/\D/g, '');
        const formattedPhone = cleanPhone.startsWith('0') ? '2' + cleanPhone : cleanPhone;
        return `https://wa.me/${formattedPhone}?text=${encodeURIComponent(message)}`;
    };

    if (loading) {
        return <div className="p-4 text-center">جاري التحميل...</div>;
    }

    if (pendingMessages.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-green-500" />
                        رسائل WhatsApp المعلقة
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-center text-gray-500">
                        لا توجد رسائل WhatsApp معلقة حالياً
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Send className="h-5 w-5" />
                    رسائل WhatsApp المعلقة ({pendingMessages.length})
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="space-y-4">
                    {pendingMessages.map((msg) => {
                        const message =
                            `✅ تم قبول طلب دفع الاشتراك\n\n` +
                            `👤 اسم الطالب: ${msg.student_name}\n` +
                            `💰 المبلغ المدفوع: ${msg.amount} جنيه\n` +
                            `📚 الصف: ${msg.grade_name || 'غير محدد'}\n` +
                            `👥 المجموعة: ${msg.group_name || 'غير محدد'}\n\n` +
                            `شكراً لثقتكم بنا 🙏\n` +
                            `مركز القائد التعليمي`;

                        const link = msg.whatsapp_link || generateWhatsAppLink(msg.guardian_phone, message);

                        return (
                            <div
                                key={msg.id}
                                className="flex items-start justify-between p-4 border rounded-lg bg-gradient-to-r from-green-50 to-white"
                            >
                                <div className="flex-1">
                                    <h4 className="font-semibold text-lg">{msg.student_name}</h4>
                                    <p className="text-sm text-gray-600 mt-1">
                                        📱 رقم ولي الأمر: {msg.guardian_phone}
                                    </p>
                                    <p className="text-sm text-gray-600">
                                        💰 المبلغ: {msg.amount} جنيه
                                    </p>
                                    <p className="text-xs text-gray-400 mt-2">
                                        {new Date(msg.created_at).toLocaleString('ar-EG')}
                                    </p>
                                </div>

                                <div className="flex flex-col gap-2">
                                    <Button
                                        onClick={() => openWhatsApp(link, msg.id)}
                                        className="bg-green-600 hover:bg-green-700"
                                        size="sm"
                                    >
                                        <ExternalLink className="h-4 w-4 mr-2" />
                                        إرسال عبر WhatsApp
                                    </Button>

                                    <Button
                                        onClick={() => markAsSent(msg.id)}
                                        variant="outline"
                                        size="sm"
                                    >
                                        <CheckCircle2 className="h-4 w-4 mr-2" />
                                        تم الإرسال
                                    </Button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </CardContent>
        </Card>
    );
}
