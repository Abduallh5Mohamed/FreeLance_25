import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

let twilioClient: ReturnType<typeof twilio> | null = null;

// Initialize Twilio client only if credentials are provided
if (accountSid && authToken && accountSid !== 'your_twilio_account_sid_here') {
    try {
        twilioClient = twilio(accountSid, authToken);
        console.log('✅ Twilio WhatsApp service initialized');
    } catch (error) {
        console.error('❌ Failed to initialize Twilio:', error);
    }
} else {
    console.log('⚠️  Twilio credentials not configured. WhatsApp messages will not be sent.');
    console.log('   Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env file');
}

export interface WhatsAppMessage {
    to: string;
    body: string;
}

/**
 * Send WhatsApp message via Twilio
 * @param to - Phone number in international format (e.g., +201012345678)
 * @param body - Message content
 * @returns Success status and message SID or error
 */
export async function sendWhatsAppMessage(to: string, body: string): Promise<{
    success: boolean;
    messageSid?: string;
    error?: string;
}> {
    // If Twilio is not configured, return mock success
    if (!twilioClient) {
        console.log('📱 WhatsApp message (MOCK - Twilio not configured):');
        console.log(`   To: ${to}`);
        console.log(`   Message: ${body}`);
        console.log(`   URL: https://wa.me/${to.replace(/\D/g, '')}?text=${encodeURIComponent(body)}`);

        return {
            success: true,
            messageSid: 'MOCK_' + Date.now(),
            error: undefined
        };
    }

    try {
        // Ensure phone number starts with '+'
        const formattedPhone = to.startsWith('+') ? to : `+${to}`;

        const message = await twilioClient.messages.create({
            from: whatsappFrom,
            to: `whatsapp:${formattedPhone}`,
            body: body
        });

        console.log(`✅ WhatsApp message sent successfully! SID: ${message.sid}`);

        return {
            success: true,
            messageSid: message.sid,
            error: undefined
        };
    } catch (error) {
        console.error('❌ Failed to send WhatsApp message:', error);

        return {
            success: false,
            messageSid: undefined,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Format Egyptian phone number from 010... to +2010...
 */
export function formatEgyptianPhone(phone: string): string {
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');

    // If starts with 0, replace with +20
    if (cleaned.startsWith('0')) {
        return '+2' + cleaned;
    }

    // If starts with 20, add +
    if (cleaned.startsWith('20')) {
        return '+' + cleaned;
    }

    // Otherwise, assume it's Egyptian and add +20
    return '+20' + cleaned;
}

/**
 * Send subscription approval notification to guardian
 */
export async function sendSubscriptionApprovalNotification(
    guardianPhone: string,
    studentName: string,
    amount: number,
    gradeName?: string,
    groupName?: string
): Promise<{ success: boolean; error?: string }> {
    const formattedPhone = formatEgyptianPhone(guardianPhone);

    const message =
        `✅ *تم قبول طلب دفع الاشتراك*\n\n` +
        `👤 *اسم الطالب:* ${studentName}\n` +
        `💰 *المبلغ المدفوع:* ${amount} جنيه\n` +
        `📚 *الصف:* ${gradeName || 'غير محدد'}\n` +
        `👥 *المجموعة:* ${groupName || 'غير محدد'}\n\n` +
        `شكراً لثقتكم بنا 🙏\n` +
        `مركز القائد التعليمي`;

    return await sendWhatsAppMessage(formattedPhone, message);
}
