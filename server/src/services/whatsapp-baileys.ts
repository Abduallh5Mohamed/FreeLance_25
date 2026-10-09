/**
 * WhatsApp Baileys Service - Free Automatic Sending
 * No API keys needed - connects directly to WhatsApp like WhatsApp Web
 */

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';

let sock: WASocket | null = null;
let isConnected = false;
let isConnecting = false;

const logger = pino({ level: 'silent' }); // Silent to avoid too much logging

/**
 * Initialize WhatsApp connection
 */
export async function initializeWhatsApp() {
    if (isConnecting || isConnected) {
        console.log('⏳ WhatsApp is already connecting or connected');
        return;
    }

    isConnecting = true;

    try {
        // Store auth credentials in server/whatsapp_auth folder
        const authFolder = path.join(__dirname, '../../whatsapp_auth');
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        // Create the WhatsApp socket
        sock = makeWASocket({
            auth: state,
            logger,
            browser: Browsers.macOS('Chrome'),
            printQRInTerminal: false, // We'll handle QR manually
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Show QR code for first-time connection
            if (qr) {
                console.log('\n╔════════════════════════════════════════════════╗');
                console.log('║                                                ║');
                console.log('║   📱 امسح الـ QR Code لربط WhatsApp             ║');
                console.log('║                                                ║');
                console.log('╚════════════════════════════════════════════════╝\n');
                qrcode.generate(qr, { small: true });
                console.log('\n📲 افتح WhatsApp في موبايلك:');
                console.log('   1. اذهب إلى: الإعدادات > الأجهزة المرتبطة');
                console.log('   2. اضغط "ربط جهاز"');
                console.log('   3. امسح الـ QR Code أعلاه\n');
            }

            if (connection === 'close') {
                const shouldReconnect =
                    (lastDisconnect?.error as Boom)?.output?.statusCode !==
                    DisconnectReason.loggedOut;

                isConnected = false;
                isConnecting = false;

                console.log(
                    '❌ WhatsApp disconnected:',
                    lastDisconnect?.error,
                    '\nReconnecting:',
                    shouldReconnect
                );

                if (shouldReconnect) {
                    // Auto-reconnect after 5 seconds
                    setTimeout(() => {
                        initializeWhatsApp();
                    }, 5000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                isConnecting = false;
                console.log('\n✅ WhatsApp متصل بنجاح! يمكنك الآن إرسال الرسائل تلقائياً 🎉\n');
            }
        });

        // Save credentials when updated
        sock.ev.on('creds.update', saveCreds);
    } catch (error) {
        console.error('❌ Error initializing WhatsApp:', error);
        isConnecting = false;
        isConnected = false;
    }
}

/**
 * Format Egyptian phone number for WhatsApp
 * Converts 010... to 20... (without +)
 */
function formatPhoneNumber(phone: string): string {
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');

    // If starts with 0, replace with 20
    if (cleaned.startsWith('0')) {
        return '2' + cleaned + '@s.whatsapp.net';
    }

    // If starts with 20, keep it
    if (cleaned.startsWith('20')) {
        return cleaned + '@s.whatsapp.net';
    }

    // Otherwise, assume it's Egyptian and add 20
    return '20' + cleaned + '@s.whatsapp.net';
}

/**
 * Send WhatsApp message
 */
export async function sendWhatsAppMessage(
    to: string,
    message: string
): Promise<{
    success: boolean;
    messageId?: string;
    error?: string;
}> {
    // If not connected, return error with fallback link
    if (!isConnected || !sock) {
        const cleanPhone = to.replace(/\D/g, '');
        const formattedForLink = cleanPhone.startsWith('0') ? '2' + cleanPhone : cleanPhone;
        const fallbackLink = `https://wa.me/${formattedForLink}?text=${encodeURIComponent(message)}`;

        console.log('\n⚠️  WhatsApp not connected. Use this link to send manually:');
        console.log(`🔗 ${fallbackLink}\n`);

        return {
            success: false,
            error: 'WhatsApp not connected. Please scan QR code first.',
        };
    }

    try {
        const formattedNumber = formatPhoneNumber(to);

        console.log(`\n📤 Sending WhatsApp message to: ${to}`);
        console.log(`📱 Formatted number: ${formattedNumber}`);

        const result = await sock.sendMessage(formattedNumber, {
            text: message,
        });

        console.log(`✅ Message sent successfully! ID: ${result?.key?.id}\n`);

        return {
            success: true,
            messageId: result?.key?.id || undefined,
        };
    } catch (error) {
        console.error('❌ Error sending WhatsApp message:', error);

        // Return fallback link
        const cleanPhone = to.replace(/\D/g, '');
        const formattedForLink = cleanPhone.startsWith('0') ? '2' + cleanPhone : cleanPhone;
        const fallbackLink = `https://wa.me/${formattedForLink}?text=${encodeURIComponent(message)}`;

        console.log(`\n⚠️  Failed to send automatically. Use this link:
🔗 ${fallbackLink}\n`);

        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Send subscription approval notification
 */
export async function sendSubscriptionApprovalNotification(
    guardianPhone: string,
    studentName: string,
    amount: number,
    gradeName?: string,
    groupName?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const message =
        `✅ *تم قبول طلب دفع الاشتراك*\n\n` +
        `👤 *اسم الطالب:* ${studentName}\n` +
        `💰 *المبلغ المدفوع:* ${amount} جنيه\n` +
        `📚 *الصف:* ${gradeName || 'غير محدد'}\n` +
        `👥 *المجموعة:* ${groupName || 'غير محدد'}\n\n` +
        `شكراً لثقتكم بنا 🙏\n` +
        `Tabweb Academy`;

    return await sendWhatsAppMessage(guardianPhone, message);
}

/**
 * Check if WhatsApp is connected
 */
export function isWhatsAppConnected(): boolean {
    return isConnected;
}

/**
 * Get WhatsApp connection status
 */
export function getWhatsAppStatus(): {
    connected: boolean;
    connecting: boolean;
} {
    return {
        connected: isConnected,
        connecting: isConnecting,
    };
}

// Auto-initialize WhatsApp on module load
console.log('\n🚀 Starting WhatsApp Baileys service...');
console.log('📱 This will enable automatic WhatsApp message sending\n');

// Start connection in background
initializeWhatsApp().catch((error) => {
    console.error('Failed to start WhatsApp service:', error);
});
