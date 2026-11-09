"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNotification = createNotification;
exports.createBulkNotifications = createBulkNotifications;
exports.notifyExamGraded = notifyExamGraded;
exports.notifyAdminNewMessage = notifyAdminNewMessage;
exports.notifyStudentMessageResponse = notifyStudentMessageResponse;
exports.notifyPaymentConfirmed = notifyPaymentConfirmed;
exports.notifyAdminNewSubscription = notifyAdminNewSubscription;
exports.notifyExamPendingReview = notifyExamPendingReview;
exports.notifyAdminNewExamSubmission = notifyAdminNewExamSubmission;
const db_1 = require("../db");
const uuid_1 = require("uuid");
const NOTIFICATION_USER_TYPES = new Set(['admin', 'student', 'instructor']);
/**
 * Create a notification for a user
 */
async function createNotification(data) {
    if (!NOTIFICATION_USER_TYPES.has(data.user_type)) {
        console.error('Refused notification for an unsupported user type');
        return;
    }
    try {
        const id = (0, uuid_1.v4)();
        const sql = `
      INSERT INTO notifications (id, user_id, user_type, title, message, type, link)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
        await (0, db_1.query)(sql, [
            id,
            data.user_id,
            data.user_type,
            data.title,
            data.message,
            data.type,
            data.link || null
        ]);
    }
    catch (error) {
        console.error('Error creating notification:', error);
    }
}
/**
 * Create notifications for multiple users at once
 */
async function createBulkNotifications(notifications) {
    try {
        for (const notification of notifications) {
            await createNotification(notification);
        }
    }
    catch (error) {
        console.error('Error creating bulk notifications:', error);
    }
}
/**
 * Notify student about exam grade
 */
async function notifyExamGraded(studentId, examTitle, score, totalScore) {
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
async function notifyAdminNewMessage(adminId, studentName, messagePreview) {
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
async function notifyStudentMessageResponse(studentId, messagePreview) {
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
async function notifyPaymentConfirmed(studentId, amount, courseName) {
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
async function notifyAdminNewSubscription(adminId, studentName, courseName) {
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
async function notifyExamPendingReview(studentId, examTitle) {
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
async function notifyAdminNewExamSubmission(adminId, studentName, examTitle) {
    await createNotification({
        user_id: adminId,
        user_type: 'admin',
        title: '📝 امتحان جديد يحتاج تصحيح',
        message: `الطالب ${studentName} قام بحل امتحان "${examTitle}"`,
        type: 'exam_graded',
        link: '/manual-grading'
    });
}
