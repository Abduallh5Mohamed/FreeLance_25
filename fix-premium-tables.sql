-- Drop old tables
DROP TABLE IF EXISTS premium_lecture_access;
DROP TABLE IF EXISTS premium_lecture_payments;
DROP TABLE IF EXISTS premium_lectures;

-- جدول الحصص المدفوعة
CREATE TABLE IF NOT EXISTS premium_lectures (
    id VARCHAR(36) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    video_url VARCHAR(500) NOT NULL,
    thumbnail_url VARCHAR(500),
    duration_minutes INT DEFAULT 0,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0,
    grade_id VARCHAR(36),
    group_id VARCHAR(36),
    is_published BOOLEAN DEFAULT FALSE,
    created_by VARCHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL,
    FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE SET NULL
);

-- جدول طلبات الدفع للحصص المدفوعة
CREATE TABLE IF NOT EXISTS premium_lecture_payments (
    id VARCHAR(36) PRIMARY KEY,
    student_id VARCHAR(36) NOT NULL,
    premium_lecture_id VARCHAR(36) NOT NULL,
    receipt_image_url VARCHAR(500) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    notes TEXT,
    rejection_reason TEXT,
    reviewed_by VARCHAR(36),
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (premium_lecture_id) REFERENCES premium_lectures(id) ON DELETE CASCADE
);

-- جدول وصول الطلاب للحصص المدفوعة (للطلاب المعتمدين)
CREATE TABLE IF NOT EXISTS premium_lecture_access (
    id VARCHAR(36) PRIMARY KEY,
    student_id VARCHAR(36) NOT NULL,
    premium_lecture_id VARCHAR(36) NOT NULL,
    payment_id VARCHAR(36) NOT NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (premium_lecture_id) REFERENCES premium_lectures(id) ON DELETE CASCADE,
    FOREIGN KEY (payment_id) REFERENCES premium_lecture_payments(id) ON DELETE CASCADE,
    UNIQUE KEY unique_student_lecture (student_id, premium_lecture_id)
);

-- فهارس لتحسين الأداء
CREATE INDEX idx_premium_lectures_grade ON premium_lectures(grade_id);
CREATE INDEX idx_premium_lectures_group ON premium_lectures(group_id);
CREATE INDEX idx_premium_payments_student ON premium_lecture_payments(student_id);
CREATE INDEX idx_premium_payments_lecture ON premium_lecture_payments(premium_lecture_id);
CREATE INDEX idx_premium_payments_status ON premium_lecture_payments(status);
CREATE INDEX idx_premium_access_student ON premium_lecture_access(student_id);
