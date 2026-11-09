"use strict";
/**
 * WhatsApp Baileys Service - Free Automatic Sending
 * No API keys needed - connects directly to WhatsApp like WhatsApp Web
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeWhatsApp = initializeWhatsApp;
exports.sendWhatsAppMessage = sendWhatsAppMessage;
exports.sendSubscriptionApprovalNotification = sendSubscriptionApprovalNotification;
exports.isWhatsAppConnected = isWhatsAppConnected;
exports.getWhatsAppStatus = getWhatsAppStatus;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const path_1 = __importDefault(require("path"));
let sock = null;
let isConnected = false;
let isConnecting = false;
const logger = (0, pino_1.default)({ level: 'silent' }); // Silent to avoid too much logging
/**
 * Initialize WhatsApp connection
 */
async function initializeWhatsApp() {
    if (isConnecting || isConnected) {
        console.log('⏳ WhatsApp is already connecting or connected');
        return;
    }
    isConnecting = true;
    try {
        // Store auth credentials in server/whatsapp_auth folder
        const authFolder = path_1.default.join(__dirname, '../../whatsapp_auth');
        const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(authFolder);
        // Create the WhatsApp socket
        sock = (0, baileys_1.default)({
            auth: state,
            logger,
            browser: baileys_1.Browsers.macOS('Chrome'),
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
                qrcode_terminal_1.default.generate(qr, { small: true });
                console.log('\n📲 افتح WhatsApp في موبايلك:');
                console.log('   1. اذهب إلى: الإعدادات > الأجهزة المرتبطة');
                console.log('   2. اضغط "ربط جهاز"');
                console.log('   3. امسح الـ QR Code أعلاه\n');
            }
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !==
                    baileys_1.DisconnectReason.loggedOut;
                isConnected = false;
                isConnecting = false;
                console.log('❌ WhatsApp disconnected:', lastDisconnect?.error, '\nReconnecting:', shouldReconnect);
                if (shouldReconnect) {
                    // Auto-reconnect after 5 seconds
                    setTimeout(() => {
                        initializeWhatsApp();
                    }, 5000);
                }
            }
            else if (connection === 'open') {
                isConnected = true;
                isConnecting = false;
                console.log('\n✅ WhatsApp متصل بنجاح! يمكنك الآن إرسال الرسائل تلقائياً 🎉\n');
            }
        });
        // Save credentials when updated
        sock.ev.on('creds.update', saveCreds);
    }
    catch (error) {
        console.error('❌ Error initializing WhatsApp:', error);
        isConnecting = false;
        isConnected = false;
    }
}
/**
 * Format Egyptian phone number for WhatsApp
 * Converts 010... to 20... (without +)
 */
function formatPhoneNumber(phone) {
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
async function sendWhatsAppMessage(to, message) {
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
    }
    catch (error) {
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
async function sendSubscriptionApprovalNotification(guardianPhone, studentName, amount, gradeName, groupName) {
    const message = `✅ *تم قبول طلب دفع الاشتراك*\n\n` +
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
function isWhatsAppConnected() {
    return isConnected;
}
/**
 * Get WhatsApp connection status
 */
function getWhatsAppStatus() {
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
