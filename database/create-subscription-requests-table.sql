-- Create subscription_requests table for payment registration
-- جدول طلبات الاشتراك (دفع الاشتراك عن طريق صورة الإيصال)

CREATE TABLE IF NOT EXISTS `subscription_requests` (
  `id` VARCHAR(36) PRIMARY KEY,
  `student_name` VARCHAR(255) NOT NULL COMMENT 'اسم الطالب',
  `phone` VARCHAR(20) NOT NULL COMMENT 'رقم الهاتف',
  `grade_id` VARCHAR(36) NULL COMMENT 'معرف الصف الدراسي',
  `grade_name` VARCHAR(100) NULL COMMENT 'اسم الصف الدراسي',
  `group_id` VARCHAR(36) NULL COMMENT 'معرف المجموعة',
  `group_name` VARCHAR(100) NULL COMMENT 'اسم المجموعة',
  `amount` DECIMAL(10, 2) NOT NULL DEFAULT 0 COMMENT 'المبلغ المدفوع',
  `notes` TEXT NULL COMMENT 'ملاحظات إضافية',
  `receipt_image_url` LONGTEXT NULL COMMENT 'رابط صورة الإيصال (base64 encoded)',
  `status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending' COMMENT 'حالة الطلب',
  `rejection_reason` TEXT NULL COMMENT 'سبب الرفض',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'تاريخ الإنشاء',
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'تاريخ التحديث',
  `approved_at` TIMESTAMP NULL COMMENT 'تاريخ الموافقة',
  `approved_by` VARCHAR(36) NULL COMMENT 'معرف المستخدم الذي وافق',
  
  INDEX `idx_phone` (`phone`),
  INDEX `idx_status` (`status`),
  INDEX `idx_grade_id` (`grade_id`),
  INDEX `idx_group_id` (`group_id`),
  INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='طلبات الاشتراك والدفع';

-- Insert sample data (optional for testing)
-- INSERT INTO subscription_requests 
-- (id, student_name, phone, grade_name, group_name, amount, receipt_image_url, status)
-- VALUES 
-- (UUID(), 'محمد أحمد', '01234567890', 'الصف الثاني الثانوي', 'ست - ثلاثاء', 150, NULL, 'pending');
