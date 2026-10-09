/**
 * Free WhatsApp Service - No API keys or registration needed!
 * Uses WhatsApp Web/Mobile deep links
 */

export interface WhatsAppMessage {
    to: string;
    body: string;
}

/**
 * Format Egyptian phone number from 010... to 2010... (without +)
 */
export function formatEgyptianPhone(phone: string): string {
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');

    // If starts with 0, replace with 20
    if (cleaned.startsWith('0')) {
        return '2' + cleaned;
    }

    // If starts with 20, keep it
    if (cleaned.startsWith('20')) {
        return cleaned;
    }

    // Otherwise, assume it's Egyptian and add 20
    return '20' + cleaned;
}

/**
 * Generate WhatsApp Web link
 * This creates a link that opens WhatsApp with pre-filled message
 * Works on both mobile and desktop
 */
export function generateWhatsAppLink(to: string, message: string): string {
    const formattedPhone = formatEgyptianPhone(to);
    const encodedMessage = encodeURIComponent(message);

    return `https://wa.me/${formattedPhone}?text=${encodedMessage}`;
}

/**
 * Send WhatsApp message by logging the link
 * In production, you can:
 * 1. Store the link in database for admin to click
 * 2. Display it in admin dashboard
 * 3. Use a browser automation tool to auto-open it
 */
export async function sendWhatsAppMessage(to: string, body: string): Promise<{
    success: boolean;
    whatsappLink?: string;
    error?: string;
}> {
    try {
        const whatsappLink = generateWhatsAppLink(to, body);

        console.log('\n📱 ═══════════════════════════════════════════════');
        console.log('📨 WhatsApp Message Ready (FREE METHOD)');
        console.log('═══════════════════════════════════════════════');
        console.log(`📞 To: ${to}`);
        console.log(`💬 Message: ${body.substring(0, 100)}...`);
        console.log(`🔗 Link: ${whatsappLink}`);
        console.log('═══════════════════════════════════════════════\n');

        // You can also save this link to database or send to admin
        // For now, we just return it

        return {
            success: true,
            whatsappLink: whatsappLink,
            error: undefined
        };
    } catch (error) {
        console.error('❌ Failed to generate WhatsApp link:', error);

        return {
            success: false,
            whatsappLink: undefined,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Send subscription approval notification to guardian
 * Returns a WhatsApp link that can be clicked to send the message
 */
export async function sendSubscriptionApprovalNotification(
    guardianPhone: string,
    studentName: string,
    amount: number,
    gradeName?: string,
    groupName?: string
): Promise<{ success: boolean; whatsappLink?: string; error?: string }> {
    const message =
        `✅ تم قبول طلب دفع الاشتراك\n\n` +
        `👤 اسم الطالب: ${studentName}\n` +
        `💰 المبلغ المدفوع: ${amount} جنيه\n` +
        `📚 الصف: ${gradeName || 'غير محدد'}\n` +
        `👥 المجموعة: ${groupName || 'غير محدد'}\n\n` +
        `شكراً لثقتكم بنا 🙏\n` +
        `Tabweb Academy`;

    return await sendWhatsAppMessage(guardianPhone, message);
}

console.log('✅ Free WhatsApp service initialized (using WhatsApp Web Links)');
