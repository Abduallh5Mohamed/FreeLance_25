import { query } from '../db';
import { v4 as uuidv4 } from 'uuid';

interface NotificationData {
    user_id: string;
    user_type: 'admin' | 'student';
    title: string;
    message: string;
    type: 'message' | 'exam_graded' | 'payment' | 'subscription' | 'general';
    link?: string;
}

/**
 * Create a notification for a user
 */
export async function createNotification(data: NotificationData): Promise<void> {
    try {
        const id = uuidv4();
        const sql = `
      INSERT INTO notifications (id, user_id, user_type, title, message, type, link)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

        await query(sql, [
            id,
            data.user_id,
            data.user_type,
            data.title,
            data.message,
            data.type,
            data.link || null
        ]);
    } catch (error) {
        console.error('Error creating notification:', error);
    }
}

/**
 * Create notifications for multiple users at once
 */
export async function createBulkNotifications(notifications: NotificationData[]): Promise<void> {
    try {
        for (const notification of notifications) {
            await createNotification(notification);
        }
    } catch (error) {
        console.error('Error creating bulk notifications:', error);
    }
}

/**
 * Notify student about exam grade
 */
export async function notifyExamGraded(
    studentId: string,
    examTitle: string,
    score: number,
    totalScore: number
): Promise<void> {
    await createNotification({
        user_id: studentId,
        user_type: 'student',
        title: '📝 تم تصحيح امتحانك',
        message: `تم تصحيح امتحان "${examTitle}". درجتك: ${score}/${totalScore}`,
        type: 'exam_graded',
        link: '/student-exams'
    });
}

/**
 * Notify admin about new message
 */
export async function notifyAdminNewMessage(
    adminId: string,
    studentName: string,
    messagePreview: string
): Promise<void> {
    await createNotification({
        user_id: adminId,
        user_type: 'admin',
        title: '💬 رسالة جديدة',
        message: `رسالة من ${studentName}: ${messagePreview.substring(0, 50)}...`,
        type: 'message',
        link: '/messages'
    });
}

/**
 * Notify student about new message response
 */
export async function notifyStudentMessageResponse(
    studentId: string,
    messagePreview: string
): Promise<void> {
    await createNotification({
        user_id: studentId,
        user_type: 'student',
        title: '💬 رد جديد على رسالتك',
        message: `${messagePreview.substring(0, 100)}...`,
        type: 'message',
        link: '/student-messages'
    });
}

/**
 * Notify student about payment confirmation
 */
export async function notifyPaymentConfirmed(
    studentId: string,
    amount: number,
    courseName: string
): Promise<void> {
    await createNotification({
        user_id: studentId,
        user_type: 'student',
        title: '💰 تم تأكيد الدفع',
        message: `تم تأكيد دفع ${amount} جنيه لكورس "${courseName}"`,
        type: 'payment',
        link: '/student-subscriptions'
    });
}

/**
 * Notify admin about new subscription request
 */
export async function notifyAdminNewSubscription(
    adminId: string,
    studentName: string,
    courseName: string
): Promise<void> {
    await createNotification({
        user_id: adminId,
        user_type: 'admin',
        title: '📚 طلب اشتراك جديد',
        message: `طلب اشتراك جديد من ${studentName} للكورس "${courseName}"`,
        type: 'subscription',
        link: '/subscriptions'
    });
}

/**
 * Notify student about exam pending review
 */
export async function notifyExamPendingReview(
    studentId: string,
    examTitle: string
): Promise<void> {
    await createNotification({
        user_id: studentId,
        user_type: 'student',
        title: '⏳ امتحانك قيد المراجعة',
        message: `امتحان "${examTitle}" قيد المراجعة من قبل الأستاذ`,
        type: 'exam_graded',
        link: '/student-exams'
    });
}

/**
 * Notify admin about new exam submission requiring manual grading
 */
export async function notifyAdminNewExamSubmission(
    adminId: string,
    studentName: string,
    examTitle: string
): Promise<void> {
    await createNotification({
        user_id: adminId,
        user_type: 'admin',
        title: '📝 امتحان جديد يحتاج تصحيح',
        message: `الطالب ${studentName} قام بحل امتحان "${examTitle}"`,
        type: 'exam_graded',
        link: '/manual-grading'
    });
}
